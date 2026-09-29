// Reads the engines' own session files: titles and previews for the history list, terminal
// sessions that used the firefox tools, and transcripts converted to the chat's event shapes.
// Session files can be tens of MB, so everything here reads in bounded chunks.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { HIDDEN_TOOLS, clip, mimeFromName, stripContext, summarizeToolResult, summarizeToolUse, toolTab } from "./chat-format.mjs";

const HEAD_BYTES = 128 * 1024;
const NEEDLE = '"name":"mcp__firefox__';
const DAY_MS = 86_400_000;

// Claude Code names a project folder after its cwd with every non-alphanumeric character as "-".
export const encodeCwd = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

async function readRange(file, start, length) {
  const fh = await fs.promises.open(file, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fh.close();
  }
}

function parseLines(text, { dropFirst = false, dropLast = false } = {}) {
  const lines = text.split("\n");
  if (dropFirst) lines.shift();
  if (dropLast) lines.pop();
  const out = [];
  for (const l of lines) {
    if (!l.startsWith("{")) continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      // a line cut by the chunk boundary
    }
  }
  return out;
}

// What a user entry says, or null for tool results, meta entries and slash-command markup.
function userText(entry) {
  if (entry.type !== "user" || entry.isMeta || entry.isSidechain || entry.isCompactSummary) return null;
  const c = entry.message?.content;
  const text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b.type === "text").map((b) => b.text).join("\n") : "";
  const typed = stripContext(text).text.trim();
  if (!typed || typed.startsWith("<") || typed.startsWith("[Request interrupted")) return null;
  return typed;
}

// Title, cwd, model and first message from the ends of a Claude Code session file.
export async function claudeSessionMeta(file, size) {
  const head = parseLines(await readRange(file, 0, Math.min(size, HEAD_BYTES)), { dropLast: size > HEAD_BYTES });
  const tail = size > HEAD_BYTES ? parseLines(await readRange(file, size - HEAD_BYTES, HEAD_BYTES), { dropFirst: true }) : head;
  let custom = null;
  let ai = null;
  let model = null;
  for (const e of [...head, ...tail]) {
    if (e.type === "custom-title" && e.customTitle) custom = e.customTitle;
    else if (e.type === "ai-title" && e.aiTitle) ai = e.aiTitle;
    else if (e.type === "assistant" && e.message?.model && e.message.model !== "<synthetic>") model = e.message.model;
  }
  const firstUser = head.map(userText).find(Boolean) ?? null;
  const cwd = [...head, ...tail].find((e) => typeof e.cwd === "string")?.cwd ?? null;
  return { title: custom ?? ai ?? (firstUser ? clip(firstUser, 60) : null), cwd, model };
}

// The title Claude Code generated (or the user set with /rename) for a whole file, if it has one.
export async function claudeTitle(file) {
  const { size } = await fs.promises.stat(file);
  const tail = parseLines(await readRange(file, Math.max(0, size - HEAD_BYTES), Math.min(size, HEAD_BYTES)), { dropFirst: size > HEAD_BYTES });
  let ai = null;
  for (const e of tail) {
    if (e.type === "custom-title" && e.customTitle) return e.customTitle;
    if (e.type === "ai-title" && e.aiTitle) ai = e.aiTitle;
  }
  return ai;
}

// True if `file` has a firefox tool call after byte `start`.
async function hasFirefoxTools(file, start, size) {
  const fh = await fs.promises.open(file, "r");
  try {
    const buf = Buffer.alloc(1 << 20);
    const overlap = NEEDLE.length - 1;
    let pos = Math.max(0, start - overlap);
    let carry = "";
    while (pos < size) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (!bytesRead) break;
      pos += bytesRead;
      const text = carry + buf.subarray(0, bytesRead).toString("latin1");
      if (text.includes(NEEDLE)) return true;
      carry = text.slice(-overlap);
    }
    return false;
  } finally {
    await fh.close();
  }
}

// Claude Code sessions outside the chat's own project folder that called mcp__firefox__ tools in
// the last `days`, newest first. Which files qualify is cached (by size), so a file is only read
// again for what was appended since; sessions that never used the tools cost one scan, ever.
export async function scanTerminalSessions({ projectsDir, skipDirs = [], cacheFile, days = 14, cap = 30, now = Date.now() }) {
  let dirs;
  try {
    dirs = await fs.promises.readdir(projectsDir);
  } catch {
    return [];
  }
  const candidates = [];
  for (const dir of dirs) {
    if (skipDirs.includes(dir)) continue;
    let names;
    try {
      names = await fs.promises.readdir(path.join(projectsDir, dir));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const file = path.join(projectsDir, dir, name);
      try {
        const st = await fs.promises.stat(file);
        if (st.isFile() && now - st.mtimeMs <= days * DAY_MS) candidates.push({ file, id: name.slice(0, -6), mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        // deleted while listing
      }
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  let cache = {};
  try {
    cache = JSON.parse(await fs.promises.readFile(cacheFile, "utf8"));
  } catch {
    // first scan
  }
  const next = {};
  const hits = [];
  for (const c of candidates) {
    if (hits.length >= cap) break; // newer files come first; the rest wait for a later call
    const known = cache[c.file];
    let used = known?.used ?? false;
    if (!used && known?.size !== c.size) {
      try {
        used = await hasFirefoxTools(c.file, known?.size ?? 0, c.size);
      } catch {
        used = false;
      }
    }
    next[c.file] = { size: c.size, used };
    if (used) hits.push(c);
  }
  // Lines for files still inside the window but not reached this time stay cached.
  for (const c of candidates) if (!(c.file in next) && cache[c.file]) next[c.file] = cache[c.file];
  try {
    await fs.promises.writeFile(cacheFile, JSON.stringify(next));
  } catch {
    // the cache is only an optimization
  }
  return hits;
}

// ---- transcripts --------------------------------------------------------------------------------

async function* jsonLines(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.startsWith("{")) continue;
    try {
      yield JSON.parse(line);
    } catch {
      // torn line at the end of a file being written
    }
  }
}

const cap = (s, n = 20_000) => (s.length > n ? `${s.slice(0, n)}…` : s);

// A Claude Code session file as chat items (the same shapes as chat events). Tool results are
// reduced to summaries, and only the most recent `maxItems` are kept.
export async function claudeTranscript(file, maxItems = 1500) {
  const items = [];
  const names = new Map(); // tool_use id -> tool name, for result summaries
  for await (const e of jsonLines(file)) {
    if (e.isSidechain) continue;
    if (e.type === "system" && e.subtype === "turn_duration") {
      items.push({ kind: "result", ok: true, durationMs: e.durationMs ?? null, numTurns: null, error: null });
    } else if (e.type === "user") {
      const c = e.message?.content;
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b.type === "tool_result" && names.has(b.tool_use_id)) items.push({ kind: "tool_end", toolUseId: b.tool_use_id, ok: !b.is_error, summary: summarizeToolResult(names.get(b.tool_use_id) ?? "", b.content, b.is_error) });
        }
      }
      const text = userText(e);
      if (text === null) continue;
      const attachments = Array.isArray(c) ? c.filter((b) => b.type === "image").map((b) => ({ name: "image", mime: b.source?.media_type ?? "image/png" })) : [];
      const raw = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b.type === "text").map((b) => b.text).join("\n") : "";
      for (const name of stripContext(raw).files) attachments.push({ name, mime: mimeFromName(name) });
      items.push({ kind: "user", text: cap(text), attachments });
    } else if (e.type === "assistant" && !e.isApiErrorMessage) {
      for (const b of Array.isArray(e.message?.content) ? e.message.content : []) {
        if (b.type === "text" && b.text?.trim()) items.push({ kind: "text", messageId: e.uuid, text: cap(b.text) });
        else if (b.type === "tool_use" && !HIDDEN_TOOLS.has(b.name)) {
          names.set(b.id, b.name);
          items.push({ kind: "tool_start", toolUseId: b.id, name: b.name, summary: summarizeToolUse(b.name, b.input), ...toolTab(b.name, b.input) });
        }
      }
    }
  }
  return items.slice(-maxItems);
}

// Codex rollouts record every item twice (raw model input and structured events); the structured
// item_completed events are the ones that map cleanly.
export async function codexTranscript(file, maxItems = 1500) {
  const items = [];
  for await (const e of jsonLines(file)) {
    const p = e.payload;
    if (e.type !== "event_msg" || !p) continue;
    if (p.type === "task_complete") {
      items.push({ kind: "result", ok: true, durationMs: p.duration_ms ?? null, numTurns: 1, error: null });
      continue;
    }
    const it = p.type === "item_completed" ? p.item : null;
    if (!it) continue;
    const text = (it.content ?? []).map((c) => c.text ?? "").join("");
    if (it.type === "UserMessage") {
      const typed = stripContext(text);
      items.push({ kind: "user", text: cap(typed.text), attachments: typed.files.map((name) => ({ name, mime: mimeFromName(name) })) });
    } else if (it.type === "AgentMessage") {
      if (text.trim()) items.push({ kind: "text", messageId: it.id, text: cap(text) });
    } else if (it.type === "McpToolCall") {
      const name = `mcp__${it.server}__${it.tool}`;
      const ok = it.status === "completed" && !it.error;
      items.push({ kind: "tool_start", toolUseId: it.id, name, summary: summarizeToolUse(name, it.arguments), ...toolTab(name, it.arguments) });
      items.push({ kind: "tool_end", toolUseId: it.id, ok, summary: ok ? "" : clip(it.error?.message ?? it.error ?? "Failed", 120) });
    }
  }
  return items.slice(-maxItems);
}

// Splits items into transcript messages that stay under Firefox's 1 MB native-message limit.
export function chunkItems(items, limit = 600_000) {
  const chunks = [];
  let cur = [];
  let size = 0;
  for (const item of items) {
    const n = Buffer.byteLength(JSON.stringify(item)); // bytes, not UTF-16 units: CJK is 3 per unit
    if (cur.length && size + n > limit) {
      chunks.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(item);
    size += n;
  }
  chunks.push(cur);
  return chunks;
}

// Codex keeps rollouts under sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl.
export async function findCodexRollout(codexHome, threadId) {
  const root = path.join(codexHome, "sessions");
  const sub = async (dir) => {
    try {
      return (await fs.promises.readdir(dir)).sort().reverse();
    } catch {
      return [];
    }
  };
  for (const y of await sub(root)) {
    for (const m of await sub(path.join(root, y))) {
      for (const d of await sub(path.join(root, y, m))) {
        const dir = path.join(root, y, m, d);
        const hit = (await sub(dir)).find((f) => f.endsWith(`-${threadId}.jsonl`));
        if (hit) return path.join(dir, hit);
      }
    }
  }
  return null;
}
