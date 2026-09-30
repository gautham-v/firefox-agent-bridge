// The chat panel's engine side (see docs/chat-panel.md). Firefox's sidebar sends `chat.*`
// messages through host.mjs; this module runs Claude Code or Codex for each chat, turns their
// output into the panel's events, and answers permission prompts, history and capability queries.
//
//   const chat = createChat({ send, log });
//   chat.handle(msg)   // true if msg was a chat.* message
//   chat.shutdown()    // kill every engine process

import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HIDDEN_TOOLS, classifyError, clip, contextBlock, parseResetTime, summarizePermission, summarizeToolResult, summarizeToolUse, toolTab } from "./chat-format.mjs";
import { chunkItems, claudeSessionMeta, claudeTitle, claudeTranscript, codexTranscript, encodeCwd, findCodexRollout, scanTerminalSessions } from "./chat-history.mjs";

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const CLAUDE_MODELS = [
  { id: "claude-opus-5-5", label: "Opus 5.5", default: true },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
  { id: "claude-fable-5-1", label: "Fable 5.1" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", efforts: [] }, // Haiku has no effort setting
];
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const DEFAULT_EFFORT = "high";

// Never asked about: the firefox tools (the point of the panel) and two built-ins that touch
// nothing. Reads outside the chat folder, web fetches and searches go through the panel's card
// like they do in a terminal, since a page the agent reads could try to steer them.
const ALLOWED_TOOLS = ["mcp__firefox", "Skill", "TodoWrite"];

const SYSTEM_PROMPT =
  "You are running in the Firefox sidebar chat of the Firefox Agent Bridge, on the user's own computer. " +
  "The user's tabs for this chat are in your Firefox tab group: call tabs_context_mcp to see them, and work in those tabs " +
  "rather than opening new ones unless the task needs one. A message may begin with a <panel-context> block listing the " +
  "current tabs and attached files; the user did not type it. Prefer find and get_page_text over reading a whole page, " +
  "and if a large result is saved to a file, open it with the Read tool, not shell commands, which need the user's approval. " +
  "Keep answers short.";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i; // Claude Code's session ids
const MODEL_ID = /^[A-Za-z0-9][\w.:\-[\]]{0,80}$/; // never a flag
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_INLINE_IMAGE = 3_500_000; // bytes; the API's cap is 5 MB of base64
const MAX_TEXT_EVENT = 200_000; // chars, so an event stays well under Firefox's 1 MB message limit
const CAPS_TTL_MS = 60_000;
const CAPS_FAILED_TTL_MS = 2_000; // an engine that isn't available is checked again soon: the user is fixing it
const MAX_EVENT_BYTES = 700_000; // Firefox drops the native connection at 1 MiB per message
const CODEX_EFFORTS = EFFORTS.slice(0, 4);
const UNSAFE_IDS = new Set(["__proto__", "constructor", "prototype"]);
const validId = (id) => typeof id === "string" && /^[\w-]{1,64}$/.test(id) && !UNSAFE_IDS.has(id);
const claudeModel = (c) => (c.model?.startsWith("claude") ? c.model : CLAUDE_MODELS[0].id); // a Codex model from an engine switch isn't Claude's
const claudeEffort = (c) => c.effort || DEFAULT_EFFORT;

const coded = (code, message) => Object.assign(new Error(message), { code });
const isExec = (p) => {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};
const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

export function createChat({ send, log = () => {}, home = os.homedir(), env = process.env, idleMs = 10 * 60_000, mcpServer } = {}) {
  const dirs = {
    base: path.join(home, ".firefox-agent-bridge"),
    chat: path.join(home, ".firefox-agent-bridge", "chat"),
    claude: env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"),
    codex: env.CODEX_HOME || path.join(home, ".codex"),
  };
  dirs.uploads = path.join(dirs.chat, "uploads");
  dirs.projects = path.join(dirs.claude, "projects");
  const registryFile = path.join(dirs.chat, "chats.json");

  // Claude Code names project folders after the real path of the cwd.
  let chatDirReal = null;
  function ensureChatDir() {
    if (chatDirReal) return;
    fs.mkdirSync(dirs.chat, { recursive: true, mode: 0o700 });
    fs.chmodSync(dirs.chat, 0o700);
    chatDirReal = fs.realpathSync(dirs.chat);
  }

  // ---- binaries -----------------------------------------------------------------------------

  const bins = new Map();

  function loginShellLookup(name) {
    return new Promise((resolve) => {
      const shell = env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh");
      const child = execFile(shell, ["-ilc", `command -v ${name}`], { timeout: 5000, env }, (err, stdout) => {
        if (err) return resolve(null);
        const line = String(stdout).split("\n").map((l) => l.trim()).findLast((l) => l.startsWith("/"));
        resolve(line && isExec(line) ? line : null);
      });
      child.stdin?.end();
    });
  }

  // CLAUDE_BIN / CODEX_BIN, then the usual install spots, then whatever a login shell resolves.
  async function findBin(name) {
    const known = bins.get(name);
    if (known && isExec(known)) return known;
    const envVar = name === "claude" ? "CLAUDE_BIN" : "CODEX_BIN";
    const candidates = [
      env[envVar],
      path.join(home, ".local/bin", name),
      path.join(dirs.claude, "local", name),
      path.join(dirs.claude, "local/node_modules/.bin", name),
      path.join("/opt/homebrew/bin", name),
      path.join("/usr/local/bin", name),
      path.join(home, ".bun/bin", name),
      path.join(home, ".npm-global/bin", name),
    ].filter(Boolean);
    let found = candidates.find(isExec) ?? null;
    if (!found) found = await loginShellLookup(name);
    if (found) bins.set(name, found);
    return found;
  }

  // Firefox starts the host with a minimal PATH, and the engines shell out to node, git and friends.
  function childEnv(bin, extra = {}) {
    const dirsOnPath = [
      bin && path.dirname(bin),
      path.dirname(process.execPath),
      path.join(home, ".local/bin"),
      path.join(dirs.claude, "local"),
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      "/usr/local/bin",
      ...(env.PATH ?? "").split(path.delimiter),
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ].filter(Boolean);
    return { ...env, HOME: home, PATH: [...new Set(dirsOnPath)].join(path.delimiter), ...extra };
  }

  function run(bin, args, { timeout = 10_000 } = {}) {
    return new Promise((resolve) => {
      const child = execFile(bin, args, { timeout, env: childEnv(bin), maxBuffer: 8 << 20 }, (err, stdout, stderr) => resolve({ ok: !err, code: err?.code ?? 0, stdout: String(stdout), stderr: String(stderr) }));
      child.stdin?.end();
    });
  }

  // How the firefox MCP server is launched for a chat. Passing it explicitly (a --mcp-config
  // entry replaces a same-named user-scope server) means chats work without install.sh having
  // registered it with this engine, and always run this checkout's server.
  const firefoxServer = (chatId) => {
    const s = mcpServer ?? { command: process.execPath, args: [path.join(REPO, "mcp/server.mjs")] };
    return { ...s, env: { ...s.env, FIREFOX_AGENT_BRIDGE_SESSION: chatId } };
  };

  // ---- chat registry ------------------------------------------------------------------------
  // chatId -> { engine, model, effort, title, threadId (Codex), cwd, updatedAt }. Claude Code's
  // session id is the chat id; Codex picks its own thread id, so that one has to be remembered.

  let registry = null;
  function reg() {
    if (registry) return registry;
    try {
      registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
    } catch {
      registry = {};
    }
    return registry;
  }
  function saveRegistry() {
    try {
      ensureChatDir();
      fs.writeFileSync(`${registryFile}.tmp`, JSON.stringify(reg()));
      fs.renameSync(`${registryFile}.tmp`, registryFile);
    } catch (e) {
      log(`chat: could not save the chat registry: ${e.message}`);
    }
  }

  // ---- chats --------------------------------------------------------------------------------

  const chats = new Map();

  function getChat(id) {
    let c = chats.get(id);
    if (c) return c;
    const saved = (Object.hasOwn(reg(), id) && reg()[id]) || {};
    c = {
      id,
      engine: saved.engine ?? "claude",
      model: saved.model ?? null,
      effort: saved.effort ?? null,
      title: saved.title ?? null,
      threadId: saved.threadId ?? null,
      proc: null,
      turns: 0, // user messages sent that haven't produced a result yet
      chain: Promise.resolve(), // serializes sends
      always: [], // "always allow in this chat" rules
      idleTimer: null,
    };
    chats.set(id, c);
    return c;
  }

  // An event's text is cut to fit if it would still be too big for one native message.
  function fit(event) {
    let bytes = Buffer.byteLength(JSON.stringify(event));
    for (let i = 0; i < 4 && bytes > MAX_EVENT_BYTES && typeof event.text === "string"; i++) {
      event = { ...event, text: `${event.text.slice(0, Math.floor((event.text.length * MAX_EVENT_BYTES) / bytes) - 100)}…` };
      bytes = Buffer.byteLength(JSON.stringify(event));
    }
    return event;
  }

  const emit = (chatId, event) => send({ type: "chat.event", chatId, event: fit(event) });

  function saveChat(c, fields = {}) {
    const r = (reg()[c.id] ??= {});
    Object.assign(r, { engine: c.engine, model: c.model, effort: c.effort, title: c.title, threadId: c.threadId, updatedAt: Date.now() }, fields);
    saveRegistry();
  }

  function setTitle(c, title) {
    if (!title || title === c.title) return;
    c.title = title;
    saveChat(c);
    emit(c.id, { kind: "title", title });
  }

  function emitText(c, messageId, kind, text, extra = {}) {
    const event = { kind, ...(messageId == null ? {} : { messageId }), text: text.length > MAX_TEXT_EVENT ? `${text.slice(0, MAX_TEXT_EVENT)}…` : text, ...extra };
    emit(c.id, event);
  }

  // A turn that ended without the engine's own result: report the error, then close the turn so
  // the panel stops showing it as running.
  function failTurn(c, code, message, resetsAt = null) {
    emit(c.id, { kind: "error", code, message, resetsAt });
    endTurn(c, { ok: false, error: message });
  }

  function endTurn(c, { ok, durationMs = null, numTurns = null, error = null, remaining = null }) {
    emit(c.id, { kind: "result", ok, durationMs, numTurns, error });
    c.turnError = false;
    c.turns = remaining ?? Math.max(0, c.turns - 1);
    if (c.turns === 0) {
      emit(c.id, { kind: "status", status: "idle" });
      armIdle(c);
    }
  }

  function armIdle(c) {
    clearTimeout(c.idleTimer);
    if (!c.proc || c.engine !== "claude") return; // Codex runs one process per turn
    c.idleTimer = setTimeout(() => {
      if (c.turns === 0) stopProc(c).catch(() => {});
    }, idleMs);
    c.idleTimer.unref?.();
  }

  // Ends an engine process on purpose (idle, restart, close); its exit isn't an error. With
  // `keep`, turns beyond that many are abandoned and reported as interrupted.
  // The process is detached from the chat at once (its late output is ignored), so a message
  // sent while it winds down starts a fresh one; `c.stopping` is what that one waits for.
  function stopProc(c, { keep = null } = {}) {
    const p = c.proc;
    clearTimeout(c.idleTimer);
    if (!p) return c.stopping ?? Promise.resolve();
    p.expected = true;
    c.proc = null;
    if (keep !== null && c.turns > keep) endTurn(c, { ok: false, error: "Interrupted", remaining: keep });
    const stopping = new Promise((resolve) => {
      const done = () => resolve();
      p.child.once("close", done);
      p.child.stdin?.end();
      const t = setTimeout(() => p.child.kill("SIGTERM"), 1500);
      const k = setTimeout(() => p.child.kill("SIGKILL"), 4000);
      p.child.once("close", () => (clearTimeout(t), clearTimeout(k)));
      if (p.child.exitCode !== null || p.child.signalCode !== null) done();
    });
    c.stopping = stopping;
    stopping.then(() => {
      if (c.stopping === stopping) c.stopping = null;
    });
    return stopping;
  }

  // ---- attachments --------------------------------------------------------------------------

  const safeName = (n) => path.basename(String(n || "file")).replace(/[^\w.\- ]+/g, "_").slice(0, 100) || "file";

  function prepare(c, msg) {
    const files = []; // saved to disk, referenced by path
    const images = []; // inline blocks (Claude) or files passed with -i (Codex)
    for (const a of Array.isArray(msg.attachments) ? msg.attachments : []) {
      if (!a || typeof a.data !== "string") continue;
      const data = a.data.replace(/^data:[^,]*,/, "");
      const bytes = Buffer.from(data, "base64");
      const mime = String(a.mime || "");
      if (c.engine === "claude" && IMAGE_MIMES.has(mime) && bytes.length <= MAX_INLINE_IMAGE) {
        images.push({ mime, data });
        continue;
      }
      const dir = path.join(dirs.uploads, c.id);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, `${Date.now().toString(36)}-${safeName(a.name)}`);
      fs.writeFileSync(file, bytes, { mode: 0o600 });
      if (c.engine === "codex" && IMAGE_MIMES.has(mime)) images.push({ mime, file });
      else files.push({ name: safeName(a.name), path: file });
    }
    const tabs = Array.isArray(msg.context?.tabs) ? msg.context.tabs : [];
    return { text: contextBlock(tabs, files) + String(msg.text ?? ""), images };
  }

  // ---- Claude Code --------------------------------------------------------------------------

  // Where Claude Code keeps this session, if it has one: the chat folder first, then (for chats
  // reopened from terminal history) any project folder.
  async function findClaudeSession(id, deep) {
    if (!validId(id)) return null; // it becomes part of a file name
    ensureChatDir();
    const own = path.join(dirs.projects, encodeCwd(chatDirReal), `${id}.jsonl`);
    if (fs.existsSync(own)) return { file: own, cwd: chatDirReal };
    if (!deep) return null;
    let names = [];
    try {
      names = await fs.promises.readdir(dirs.projects);
    } catch {
      return null;
    }
    for (const dir of names) {
      const file = path.join(dirs.projects, dir, `${id}.jsonl`);
      if (!fs.existsSync(file)) continue;
      const meta = await claudeSessionMeta(file, fs.statSync(file).size).catch(() => ({}));
      return { file, cwd: meta.cwd ?? null };
    }
    return null;
  }

  const writeJson = (p, obj) => {
    if (p.child.stdin?.writable) p.child.stdin.write(`${JSON.stringify(obj)}\n`);
  };

  async function startClaude(c, resume) {
    if (!UUID.test(c.id)) throw coded("spawn", "Claude chats need a UUID as their chat id.");
    const bin = await findBin("claude");
    if (!bin) throw coded("not_found", "Claude Code wasn't found. Install it, or set CLAUDE_BIN in the host launcher.");
    ensureChatDir();
    const session = await findClaudeSession(c.id, resume || reg()[c.id]);
    const cwd = session?.cwd && isDir(session.cwd) ? session.cwd : chatDirReal;
    const model = claudeModel(c);
    const effort = claudeEffort(c);
    const modelInfo = CLAUDE_MODELS.find((m) => m.id === model);
    const args = [
      "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      session ? "--resume" : "--session-id", c.id,
      "--model", model,
      ...(modelInfo?.efforts?.length === 0 ? [] : ["--effort", effort]),
      "--permission-mode", "default", // the user's own default may be bypassPermissions
      "--permission-prompt-tool", "stdio",
      "--allowedTools", ALLOWED_TOOLS.join(","),
      "--mcp-config", JSON.stringify({ mcpServers: { firefox: firefoxServer(c.id) } }),
      "--append-system-prompt", SYSTEM_PROMPT,
    ];
    emit(c.id, { kind: "status", status: "starting" });
    const child = spawn(bin, args, { cwd, env: childEnv(bin, { FIREFOX_AGENT_BRIDGE_SESSION: c.id, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" }), stdio: ["pipe", "pipe", "pipe"] }); // a page-steered agent shouldn't get to write memory that persists
    const p = { child, key: `${model}|${effort}`, stderr: "", expected: false, pending: new Map(), tools: new Map(), texts: new Map(), stream: null, resetsAt: null };
    child.stdin.on("error", () => {});
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    }).catch((e) => {
      throw coded(e.code === "ENOENT" ? "not_found" : "spawn", `Couldn't start Claude Code: ${e.message}`);
    });
    c.proc = p;
    child.stderr.on("data", (d) => (p.stderr = (p.stderr + d).slice(-4000)));
    let buf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.startsWith("{")) continue;
        let j;
        try {
          j = JSON.parse(line);
        } catch {
          continue;
        }
        try {
          onClaude(c, p, j);
        } catch (e) {
          log(`chat ${c.id}: handling a ${j.type} event failed: ${e.stack ?? e.message}`);
        }
      }
    });
    child.on("error", (e) => log(`chat ${c.id}: claude process error: ${e.message}`));
    child.on("close", (code, signal) => onClaudeExit(c, p, code, signal));
    log(`chat ${c.id}: started claude (${session ? "resume" : "new"}, ${model}, ${effort}) in ${cwd}`);
    return p;
  }

  async function sendClaude(c, msg, prep) {
    const key = `${claudeModel(c)}|${claudeEffort(c)}`;
    if (c.proc && c.proc.key !== key) await stopProc(c, { keep: 1 }); // the message being sent stays
    await c.stopping; // a process that is still shutting down owns the session file until it is gone
    const p = c.proc ?? (await startClaude(c, msg.resume === true));
    clearTimeout(c.idleTimer);
    const content = [
      ...prep.images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.mime, data: i.data } })),
      { type: "text", text: prep.text || "(no text)" },
    ];
    writeJson(p, { type: "user", message: { role: "user", content } });
    emit(c.id, { kind: "status", status: "running" });
  }

  function onClaude(c, p, j) {
    if (c.proc !== p) return;
    // Sub-agent chatter stays out of the panel; only the top-level agent's work is shown.
    if (j.parent_tool_use_id && (j.type === "assistant" || j.type === "user" || j.type === "stream_event")) return;
    switch (j.type) {
      case "stream_event":
        return onClaudeStream(c, p, j.event);
      case "assistant":
        return onClaudeAssistant(c, p, j);
      case "user":
        return onClaudeUser(c, p, j);
      case "control_request":
        return onClaudeRequest(c, p, j);
      case "control_cancel_request":
        return void p.pending.delete(j.request_id);
      case "rate_limit_event":
        if (j.rate_limit_info?.status === "rejected" && j.rate_limit_info.resetsAt) p.resetsAt = j.rate_limit_info.resetsAt * 1000;
        return;
      case "result":
        return onClaudeResult(c, p, j);
      default:
    }
  }

  function onClaudeStream(c, p, ev) {
    if (ev.type === "message_start") p.stream = { id: ev.message?.id, ordinal: -1, byIndex: new Map() };
    else if (ev.type === "content_block_start" && ev.content_block?.type === "text" && p.stream) p.stream.byIndex.set(ev.index, ++p.stream.ordinal);
    else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && p.stream?.byIndex.has(ev.index)) {
      emitText(c, `${p.stream.id}:${p.stream.byIndex.get(ev.index)}`, "text_delta", ev.delta.text ?? "");
    }
  }

  function onClaudeAssistant(c, p, j) {
    const blocks = Array.isArray(j.message?.content) ? j.message.content : [];
    if (j.error || j.isApiErrorMessage) {
      // API failures arrive as an assistant message whose text is the error.
      const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      p.apiError = text;
      const code = classifyError(text, j.error);
      if (code && !c.turnError) {
        c.turnError = true;
        emit(c.id, { kind: "error", code, message: clip(text, 300), resetsAt: code === "limit" ? (p.resetsAt ?? parseResetTime(text)) : null });
      }
      return;
    }
    for (const b of blocks) {
      if (b.type === "text" && b.text?.trim()) {
        const n = p.texts.get(j.message.id) ?? 0;
        p.texts.set(j.message.id, n + 1);
        emitText(c, `${j.message.id}:${n}`, "text", b.text);
      } else if (b.type === "tool_use" && !p.tools.has(b.id) && !HIDDEN_TOOLS.has(b.name)) {
        p.tools.set(b.id, b.name);
        emit(c.id, { kind: "tool_start", toolUseId: b.id, name: b.name, summary: summarizeToolUse(b.name, b.input), ...toolTab(b.name, b.input) });
      }
    }
  }

  function onClaudeUser(c, p, j) {
    for (const b of Array.isArray(j.message?.content) ? j.message.content : []) {
      if (b.type === "tool_result" && p.tools.has(b.tool_use_id)) emit(c.id, { kind: "tool_end", toolUseId: b.tool_use_id, ok: !b.is_error, summary: summarizeToolResult(p.tools.get(b.tool_use_id) ?? "", b.content, b.is_error) });
    }
  }

  // "Always allow" is remembered per chat, and never wider than what was approved. Bash gets the
  // rules Claude Code suggested (an exact command or a `prefix:*`) or else the exact command;
  // file tools get the exact path (Claude Code suggests no rule for them); other tools get the
  // rule Claude Code suggested, which for connector tools is the whole tool. No rule means the
  // card offers Allow once only.
  const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
  const fileArg = (input) => (typeof input?.file_path === "string" ? input.file_path : typeof input?.notebook_path === "string" ? input.notebook_path : null);

  function ruleFor(req) {
    const tool = req.tool_name;
    const input = req.input ?? {};
    const suggested = (req.permission_suggestions ?? [])
      .filter((s) => s.type === "addRules")
      .flatMap((s) => s.rules ?? [])
      .filter((r) => r?.toolName === tool);
    if (tool === "Bash") {
      const rules = suggested.filter((r) => typeof r.ruleContent === "string" && r.ruleContent).map((r) => ({ tool, content: r.ruleContent }));
      if (rules.length) return rules;
      return typeof input.command === "string" && input.command ? [{ tool, content: input.command }] : null;
    }
    if (FILE_TOOLS.has(tool)) {
      const file = fileArg(input);
      return file ? [{ tool, content: path.resolve(chatDirReal ?? "/", file) }] : null;
    }
    return suggested.length ? suggested.map((r) => ({ tool, content: typeof r.ruleContent === "string" ? r.ruleContent : null })) : null;
  }

  // A `prefix:*` rule must not cover a chained or substituted command, or a longer word.
  const SHELL_SYNTAX = /[;&|`<>\n\r]|\$\(/;

  function matchesRule(req, rule) {
    if (rule.tool !== req.tool_name) return false;
    const input = req.input ?? {};
    if (rule.tool === "Bash") {
      const cmd = String(input.command ?? "");
      if (cmd === rule.content) return true;
      if (!rule.content?.endsWith(":*") || SHELL_SYNTAX.test(cmd)) return false;
      const prefix = rule.content.slice(0, -2);
      return cmd === prefix || cmd.startsWith(`${prefix} `);
    }
    if (rule.content == null) return true;
    const file = fileArg(input) ?? (typeof input.path === "string" ? input.path : null);
    if (file != null) {
      const at = path.resolve(chatDirReal ?? "/", file);
      // Claude Code writes absolute path rules as `//abs/path`, with `/**` for a folder.
      const want = rule.content.startsWith("//") ? rule.content.slice(1) : rule.content;
      return want.endsWith("/**") ? at.startsWith(want.slice(0, -2)) : at === want;
    }
    if (typeof input.url === "string") {
      if (rule.content.startsWith("domain:")) {
        try {
          return new URL(input.url).hostname === rule.content.slice(7);
        } catch {
          return false;
        }
      }
      return input.url === rule.content;
    }
    return false;
  }

  const answer = (p, requestId, response) => writeJson(p, { type: "control_response", response: { subtype: "success", request_id: requestId, response } });

  function onClaudeRequest(c, p, j) {
    const req = j.request;
    if (req?.subtype !== "can_use_tool") {
      // Nothing else Claude Code asks of its host applies here; failing fast beats hanging it.
      return writeJson(p, { type: "control_response", response: { subtype: "error", request_id: j.request_id, error: `Unsupported request: ${req?.subtype}` } });
    }
    const deny = (message) => answer(p, j.request_id, { behavior: "deny", message, toolUseID: req.tool_use_id });
    if (req.tool_name === "AskUserQuestion") return deny("The chat panel can't show structured questions. Ask the user in a normal message instead.");
    if (c.always.some((r) => matchesRule(req, r))) return answer(p, j.request_id, { behavior: "allow", updatedInput: req.input, toolUseID: req.tool_use_id });
    const { summary, complete } = summarizePermission(req.tool_name, req.input);
    // The card has to show what would run; a command too long for it isn't something to approve blind.
    if (!complete && req.tool_name === "Bash") return deny("This command is too long to review in the Firefox panel, so it was not run. Ask for a shorter command, or split it up.");
    p.pending.set(j.request_id, req);
    emit(c.id, { kind: "permission", requestId: j.request_id, tool: req.tool_name, summary, always: complete && ruleFor(req) != null });
  }

  function decide(msg) {
    const c = chats.get(msg.chatId);
    const p = c?.proc;
    const req = p?.pending.get(msg.requestId);
    if (!req) return;
    p.pending.delete(msg.requestId);
    if (msg.decision === "deny") return answer(p, msg.requestId, { behavior: "deny", message: "The user denied this in the Firefox panel.", toolUseID: req.tool_use_id });
    if (msg.decision === "allow_always" && summarizePermission(req.tool_name, req.input).complete) c.always.push(...(ruleFor(req) ?? []));
    answer(p, msg.requestId, { behavior: "allow", updatedInput: req.input, toolUseID: req.tool_use_id });
  }

  function onClaudeResult(c, p, j) {
    p.texts.clear();
    p.tools.clear();
    p.stream = null;
    clearTimeout(p.interruptTimer);
    const interrupted = j.terminal_reason === "aborted_streaming" || p.interrupted;
    p.interrupted = false;
    let error = null;
    if (j.is_error) {
      const text = interrupted ? "Interrupted" : String(j.result || p.apiError || (j.errors ?? []).join("; ") || "The turn failed");
      error = clip(text, 300);
      const code = interrupted ? null : classifyError(text, null);
      if (code && !c.turnError) emit(c.id, { kind: "error", code, message: error, resetsAt: code === "limit" ? (p.resetsAt ?? parseResetTime(text)) : null });
    }
    p.apiError = null;
    p.resetsAt = null;
    endTurn(c, { ok: !j.is_error, durationMs: j.duration_ms ?? null, numTurns: j.num_turns ?? null, error, remaining: Number.isInteger(j.queued_turn_count) ? j.queued_turn_count : null });
    afterTurn(c);
  }

  // Once a turn is done: keep the registry current and pick up Claude Code's generated title.
  async function afterTurn(c) {
    saveChat(c);
    try {
      const session = await findClaudeSession(c.id, true);
      if (session) setTitle(c, await claudeTitle(session.file));
    } catch {
      // the title is a nicety
    }
  }

  function onClaudeExit(c, p, code, signal) {
    clearTimeout(p.interruptTimer);
    if (c.proc === p) c.proc = null;
    log(`chat ${c.id}: claude exited code=${code} signal=${signal}`);
    if (c.proc) return; // replaced by a newer process; its events own the chat now
    if (!p.expected && c.turns > 0) {
      if (p.interrupted) {
        endTurn(c, { ok: false, error: "Interrupted", remaining: 0 });
      } else {
        const why = clip(p.stderr.trim().split("\n").filter(Boolean).at(-1) ?? "", 300);
        const errCode = classifyError(p.stderr, null) ?? "crashed";
        emit(c.id, { kind: "error", code: errCode, message: why || `Claude Code exited unexpectedly (${signal ?? `code ${code}`}).`, resetsAt: errCode === "limit" ? p.resetsAt : null });
        endTurn(c, { ok: false, error: why || "Claude Code exited", remaining: 0 });
      }
    }
    emit(c.id, { kind: "status", status: "exited" });
  }

  function interruptClaude(c) {
    const p = c.proc;
    if (!p) return;
    p.interrupted = true;
    for (const [id, req] of p.pending) answer(p, id, { behavior: "deny", message: "The user stopped this turn.", interrupt: true, toolUseID: req.tool_use_id });
    p.pending.clear();
    writeJson(p, { type: "control_request", request_id: `interrupt-${Date.now()}`, request: { subtype: "interrupt" } });
    // If Claude Code doesn't wind the turn down, the panel's Stop still has to work.
    clearTimeout(p.interruptTimer);
    p.interruptTimer = setTimeout(() => {
      if (c.proc === p && c.turns > 0) p.child.kill("SIGKILL");
    }, 8000);
    p.interruptTimer.unref?.();
  }

  // ---- Codex --------------------------------------------------------------------------------

  const tomlString = (s) => JSON.stringify(String(s));

  function codexArgs(c, prep) {
    const s = firefoxServer(c.id);
    const server = `{command=${tomlString(s.command)},args=[${s.args.map(tomlString).join(",")}],env={${Object.entries(s.env).map(([k, v]) => `${k}=${tomlString(v)}`).join(",")}},default_tools_approval_mode="approve",tool_timeout_sec=120}`;
    const model = c.model && !c.model.startsWith("claude") ? c.model : null;
    const effort = CODEX_EFFORTS.includes(c.effort) ? c.effort : null; // Claude's "max" isn't one of Codex's
    return [
      "exec", ...(c.threadId ? ["resume", c.threadId] : []),
      "--json", "--skip-git-repo-check",
      // Approvals can't be asked in exec mode, so the agent gets a read-only sandbox and the
      // pre-approved firefox tools (MCP servers run outside the sandbox).
      "-c", 'approval_policy="never"', "-c", 'sandbox_mode="read-only"',
      "-c", `developer_instructions=${tomlString(SYSTEM_PROMPT)}`,
      "-c", `mcp_servers.firefox=${server}`,
      ...(model ? ["-m", model] : []),
      ...(effort ? ["-c", `model_reasoning_effort=${tomlString(effort)}`] : []),
      // `--image=<file>` takes exactly one value; a bare `-i` swallows the arguments after it,
      // including the `-` below.
      ...prep.images.map((i) => `--image=${i.file}`),
      "-", // the prompt comes on stdin
    ];
  }

  async function sendCodex(c, prep) {
    const bin = await findBin("codex");
    if (!bin) throw coded("not_found", "Codex wasn't found. Install it, or set CODEX_BIN in the host launcher.");
    ensureChatDir();
    emit(c.id, { kind: "status", status: "starting" });
    const child = spawn(bin, codexArgs(c, prep), { cwd: chatDirReal, env: childEnv(bin, { FIREFOX_AGENT_BRIDGE_SESSION: c.id }), stdio: ["pipe", "pipe", "pipe"] });
    const p = { child, stderr: "", expected: false, tools: new Set(), started: Date.now(), done: false, lastError: null };
    child.stdin.on("error", () => {});
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    }).catch((e) => {
      throw coded(e.code === "ENOENT" ? "not_found" : "spawn", `Couldn't start Codex: ${e.message}`);
    });
    c.proc = p;
    child.stdin.end(prep.text || "(no text)");
    emit(c.id, { kind: "status", status: "running" });
    child.stderr.on("data", (d) => (p.stderr = (p.stderr + d).slice(-4000)));
    let buf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.startsWith("{")) continue;
        try {
          onCodex(c, p, JSON.parse(line));
        } catch (e) {
          log(`chat ${c.id}: handling a codex event failed: ${e.stack ?? e.message}`);
        }
      }
    });
    log(`chat ${c.id}: started codex (${c.threadId ? "resume" : "new"})`);
    // One process per turn: the turn is over when it exits.
    await new Promise((resolve) => child.on("close", (code, signal) => (onCodexExit(c, p, code, signal), resolve())));
  }

  function onCodex(c, p, j) {
    switch (j.type) {
      case "thread.started":
        c.threadId = j.thread_id;
        saveChat(c);
        break;
      case "item.started":
      case "item.completed":
        onCodexItem(c, p, j.item, j.type === "item.completed");
        break;
      case "turn.completed":
        p.done = true;
        endTurn(c, { ok: true, durationMs: Date.now() - p.started, numTurns: 1 });
        saveChat(c);
        break;
      case "turn.failed":
        p.done = true;
        failCodex(c, j.error?.message ?? p.lastError ?? "The turn failed");
        break;
      case "error":
        p.lastError = j.message;
        break;
      default:
    }
  }

  function failCodex(c, text) {
    const code = classifyError(text, null) ?? "crashed";
    failTurn(c, code, clip(text, 300), code === "limit" ? parseResetTime(text) : null);
  }

  function onCodexItem(c, p, it, completed) {
    if (!it) return;
    if (it.type === "agent_message") {
      if (completed && it.text?.trim()) emitText(c, it.id, "text", it.text);
      return;
    }
    let name;
    let input = {};
    if (it.type === "mcp_tool_call") {
      name = `mcp__${it.server}__${it.tool}`;
      input = it.arguments;
    } else if (it.type === "command_execution") {
      name = "Bash";
      input = { command: it.command };
    } else if (it.type === "web_search") {
      name = "WebSearch";
      input = { query: it.query };
    } else if (it.type === "file_change") {
      name = "Edit";
      input = { file_path: it.changes?.[0]?.path };
    } else return;
    if (!p.tools.has(it.id)) {
      p.tools.add(it.id);
      emit(c.id, { kind: "tool_start", toolUseId: it.id, name, summary: summarizeToolUse(name, input), ...toolTab(name, input) });
    }
    if (!completed) return;
    const ok = it.status !== "failed" && !it.error && (it.exit_code == null || it.exit_code === 0);
    const text = it.result?.content?.filter((b) => b.type === "text").map((b) => b.text).join("\n") ?? "";
    const summary = ok ? summarizeToolResult(name, it.result?.content?.some((b) => b.type === "image") ? [{ type: "image" }] : text, false) : clip(it.error?.message ?? it.error ?? "Failed", 120);
    emit(c.id, { kind: "tool_end", toolUseId: it.id, ok, summary });
  }

  function onCodexExit(c, p, code, signal) {
    if (c.proc === p) c.proc = null;
    log(`chat ${c.id}: codex exited code=${code} signal=${signal}`);
    if (!p.done) {
      if (p.interrupted) endTurn(c, { ok: false, error: "Interrupted" });
      else if (!p.expected) failCodex(c, p.lastError || p.stderr.trim().split("\n").filter(Boolean).at(-1) || `Codex exited unexpectedly (${signal ?? `code ${code}`}).`);
    }
  }

  // ---- chat.* messages ----------------------------------------------------------------------

  function onSend(msg) {
    if (!validId(msg.chatId)) return log("chat.send: bad chatId");
    const c = getChat(msg.chatId);
    const engine = msg.engine === "codex" ? "codex" : "claude";
    c.engine = engine;
    // An empty or unusable string resets to the engine's default; a missing field leaves it be.
    if (typeof msg.model === "string") c.model = MODEL_ID.test(msg.model) ? msg.model : null;
    if (typeof msg.effort === "string") c.effort = EFFORTS.includes(msg.effort) ? msg.effort : null;
    const text = String(msg.text ?? "");
    const attachments = (Array.isArray(msg.attachments) ? msg.attachments : []).map((a) => ({ name: clip(a?.name ?? "file", 200), mime: clip(a?.mime ?? "", 100) }));
    emitText(c, null, "user", text, { attachments });
    // A Teach recording sent to draft a skill from is titled for what it makes.
    if (!c.title && text.trim()) setTitle(c, text.includes("<teach-recording ") ? "New skill" : clip(text, 60));
    c.turns++;
    c.turnError = false;
    // Sends run one at a time so a spawn in progress isn't raced by the next message.
    c.chain = c.chain
      .then(async () => {
        try {
          if (engine === "codex") await stopProc(c, { keep: 1 }); // switching over from a Claude process; its turn ends here
          const prep = prepare(c, msg);
          if (engine === "claude") await sendClaude(c, msg, prep);
          else await sendCodex(c, prep);
          saveChat(c);
        } catch (e) {
          log(`chat ${c.id}: send failed: ${e.message}`);
          failTurn(c, e.code ?? "spawn", e.message);
        }
      })
      .catch((e) => log(`chat ${c.id}: ${e.stack ?? e.message}`));
  }

  function onInterrupt(msg) {
    const c = chats.get(msg.chatId);
    if (!c?.proc || c.turns === 0) return;
    if (c.engine === "codex") {
      c.proc.interrupted = true;
      c.proc.child.kill("SIGTERM");
    } else interruptClaude(c);
  }

  async function onClose(msg) {
    const c = chats.get(msg.chatId);
    if (!c) return;
    await stopProc(c, { keep: 0 });
  }

  // ---- history ------------------------------------------------------------------------------

  async function history() {
    ensureChatDir();
    const out = [];
    const seen = new Set();
    const running = (id) => (chats.get(id)?.turns ?? 0) > 0;
    for (const [id, r] of Object.entries(reg())) {
      let file = null;
      let meta = {};
      try {
        if (r.engine === "codex") file = r.threadId ? (r.rollout ??= await findCodexRollout(dirs.codex, r.threadId)) : null;
        else file = (await findClaudeSession(id, true))?.file ?? null;
        if (file && r.engine !== "codex") meta = await claudeSessionMeta(file, fs.statSync(file).size);
      } catch {
        // an unreadable session just loses its preview
      }
      if (!file && !running(id)) continue;
      seen.add(id);
      out.push({ id, title: r.title ?? meta.title ?? "New chat", updatedAt: Math.max(r.updatedAt ?? 0, file ? fs.statSync(file).mtimeMs : 0), engine: r.engine ?? "claude", model: r.model ?? meta.model ?? null, source: "panel", cwd: r.cwd ?? meta.cwd ?? chatDirReal, path: file, running: running(id) });
    }
    // Chats whose registry line was lost still have their session files.
    const ownDir = path.join(dirs.projects, encodeCwd(chatDirReal));
    for (const name of await fs.promises.readdir(ownDir).catch(() => [])) {
      const id = name.replace(/\.jsonl$/, "");
      if (!name.endsWith(".jsonl") || seen.has(id)) continue;
      const file = path.join(ownDir, name);
      const st = fs.statSync(file);
      const meta = await claudeSessionMeta(file, st.size).catch(() => ({}));
      seen.add(id);
      out.push({ id, title: meta.title ?? "Untitled", updatedAt: st.mtimeMs, engine: "claude", model: meta.model ?? null, source: "panel", cwd: chatDirReal, path: file, running: running(id) });
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt).length = Math.min(out.length, 100);
    const terminal = await scanTerminalSessions({ projectsDir: dirs.projects, skipDirs: [encodeCwd(chatDirReal)], cacheFile: path.join(dirs.chat, "history-cache.json") });
    for (const t of terminal) {
      if (seen.has(t.id)) continue;
      const meta = await claudeSessionMeta(t.file, t.size).catch(() => ({}));
      out.push({ id: t.id, title: meta.title ?? "Untitled", updatedAt: t.mtimeMs, engine: "claude", model: meta.model ?? null, source: "terminal", cwd: meta.cwd, path: t.file, running: false });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async function load(msg) {
    const { requestId, chatId } = msg;
    let file = null;
    let engine = "claude";
    if (msg.source === "terminal") {
      // Only session files under Claude Code's projects folder.
      const p = path.resolve(String(msg.path ?? ""));
      if (p.startsWith(dirs.projects + path.sep) && p.endsWith(".jsonl") && fs.existsSync(p)) file = p;
    } else {
      const r = validId(chatId) && Object.hasOwn(reg(), chatId) ? reg()[chatId] : null;
      engine = r?.engine ?? "claude";
      if (engine === "codex") file = r?.threadId ? (r.rollout ??= await findCodexRollout(dirs.codex, r.threadId)) : null;
      else file = (await findClaudeSession(chatId, true))?.file ?? null;
    }
    let items = [];
    if (file) {
      try {
        items = engine === "codex" ? await codexTranscript(file) : await claudeTranscript(file);
      } catch (e) {
        log(`chat.load ${chatId}: ${e.message}`);
      }
    }
    const chunks = chunkItems(items);
    chunks.forEach((part, i) => send({ type: "chat.transcript", requestId, chatId, items: part, done: i === chunks.length - 1 }));
  }

  // ---- capabilities -------------------------------------------------------------------------

  const capsCache = new Map(); // engine -> { at, promise }

  const versionOf = (text) => /\d+\.\d+\.\d+/.exec(text)?.[0] ?? null;

  // Runs Claude Code with no prompt and asks it, over the control protocol, for what it has
  // loaded. `initialize` and `mcp_status` answer without a model call.
  function probeClaude(bin) {
    return new Promise((resolve) => {
      ensureChatDir();
      const child = spawn(bin, ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--permission-mode", "default"], { cwd: chatDirReal, env: childEnv(bin), stdio: ["pipe", "pipe", "ignore"] });
      const out = { commands: [], servers: [] };
      let buf = "";
      let polls = 0;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        child.stdin.end();
        child.kill("SIGTERM");
        resolve(out);
      };
      const timer = setTimeout(finish, 20_000);
      const ask = (id) => child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: id, request: { subtype: id === "init" ? "initialize" : "mcp_status" } })}\n`);
      child.stdin.on("error", () => {});
      child.on("error", finish);
      child.on("close", finish);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          let j;
          try {
            j = JSON.parse(line);
          } catch {
            continue;
          }
          const r = j.type === "control_response" ? j.response : null;
          if (r?.request_id === "init") {
            if (r.subtype === "success") {
              out.commands = r.response?.commands ?? [];
              out.account = r.response?.account ?? null;
            }
            ask("mcp");
          } else if (r?.request_id === "mcp") {
            out.servers = r.response?.mcpServers ?? [];
            // Connectors connect in the background, and the first answer can be an empty list
            // before claude.ai's connectors are even added; give the slow ones a few seconds.
            if ((!out.servers.length || out.servers.some((s) => s.status === "pending")) && ++polls < 8) setTimeout(() => ask("mcp"), 1000);
            else finish();
          }
        }
      });
      ask("init");
    });
  }

  async function claudeCapabilities() {
    const caps = { engine: "claude", available: false, version: null, error: null, skills: [], plugins: [], connectors: [], models: CLAUDE_MODELS.map((m) => ({ ...m })), efforts: EFFORTS };
    const bin = await findBin("claude");
    if (!bin) return { ...caps, error: "Claude Code wasn't found. Install it, or set CLAUDE_BIN in the host launcher." };
    const [version, auth, plugins, probe] = await Promise.all([run(bin, ["--version"]), run(bin, ["auth", "status"]), run(bin, ["plugin", "list", "--json"]), probeClaude(bin)]);
    caps.version = versionOf(version.stdout);
    let loggedIn = true;
    try {
      loggedIn = JSON.parse(auth.stdout).loggedIn !== false;
    } catch {
      loggedIn = auth.ok;
    }
    caps.available = loggedIn;
    if (!loggedIn) caps.error = "Not signed in to Claude Code. Run `claude auth login` in a terminal.";
    caps.skills = probe.commands.filter((c) => !c.builtin).map((c) => ({ name: c.name, description: clip(c.description, 200) }));
    try {
      caps.plugins = JSON.parse(plugins.stdout).filter((p) => p.enabled).map((p) => ({ name: String(p.id).split("@")[0] }));
    } catch {
      // no plugin list
    }
    caps.connectors = probe.servers.filter((s) => s.name !== "firefox").map((s) => ({ name: s.name.replace(/^claude\.ai /, ""), status: s.status }));
    return caps;
  }

  async function codexCapabilities() {
    const caps = { engine: "codex", available: false, version: null, error: null, skills: [], plugins: [], connectors: [], models: [], efforts: EFFORTS.slice(0, 4) };
    const bin = await findBin("codex");
    if (!bin) return { ...caps, error: "Codex wasn't found. Install it, or set CODEX_BIN in the host launcher." };
    const [version, login, models, mcp] = await Promise.all([run(bin, ["--version"]), run(bin, ["login", "status"]), run(bin, ["debug", "models"]), run(bin, ["mcp", "list", "--json"])]);
    caps.version = versionOf(version.stdout);
    caps.available = login.ok;
    if (!login.ok) caps.error = "Not signed in to Codex. Run `codex login` in a terminal.";
    try {
      const list = JSON.parse(models.stdout).models.filter((m) => m.visibility === "list");
      caps.models = list.map((m) => ({ id: m.slug, label: m.display_name, efforts: (m.supported_reasoning_levels ?? []).map((l) => l.effort).filter((e) => EFFORTS.includes(e)) }));
      caps.efforts = EFFORTS.filter((e) => caps.models.some((m) => m.efforts.includes(e)));
      // Codex's own configured model is what a chat gets when the panel doesn't pick one.
      let configured = null;
      try {
        configured = /^model\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(path.join(dirs.codex, "config.toml"), "utf8"))?.[1];
      } catch {
        // no config
      }
      const def = caps.models.find((m) => m.id === configured) ?? caps.models[0];
      if (def) def.default = true;
    } catch {
      // no model catalog: the panel falls back to Codex's configured model
    }
    try {
      caps.connectors = JSON.parse(mcp.stdout).filter((s) => s.name !== "firefox").map((s) => ({ name: s.name, status: s.enabled ? "enabled" : "disabled" }));
    } catch {
      // none
    }
    try {
      for (const d of fs.readdirSync(path.join(dirs.codex, "skills"))) {
        const md = path.join(dirs.codex, "skills", d, "SKILL.md");
        if (!fs.existsSync(md)) continue;
        const description = /^description:\s*(.+)$/m.exec(fs.readFileSync(md, "utf8").slice(0, 4000))?.[1] ?? "";
        caps.skills.push({ name: d, description: clip(description, 200) });
      }
    } catch {
      // no skills folder
    }
    return caps;
  }

  function capabilities(engine) {
    const hit = capsCache.get(engine);
    if (hit && Date.now() - hit.at < hit.ttl) return hit.promise;
    const promise = (engine === "codex" ? codexCapabilities() : claudeCapabilities()).catch((e) => ({ engine, available: false, version: null, error: `Couldn't check ${engine}: ${e.message}`, skills: [], plugins: [], connectors: [], models: [], efforts: [] }));
    const entry = { at: Date.now(), ttl: CAPS_TTL_MS, promise };
    // "Try again" on the not-connected screen has to re-check, so an unavailable engine's
    // answer is only reused for a moment (a burst of panels asking at once).
    promise.then((caps) => {
      if (caps.available) return;
      entry.at = Date.now();
      entry.ttl = CAPS_FAILED_TTL_MS;
    });
    capsCache.set(engine, entry);
    return promise;
  }

  // ---- dispatch -----------------------------------------------------------------------------

  const guarded = (what, fn) => async (msg) => {
    try {
      await fn(msg);
    } catch (e) {
      log(`${what} failed: ${e.stack ?? e.message}`);
    }
  };

  const handlers = {
    "chat.send": guarded("chat.send", onSend),
    "chat.interrupt": guarded("chat.interrupt", onInterrupt),
    "chat.permission": guarded("chat.permission", decide),
    "chat.close": guarded("chat.close", onClose),
    "chat.history": guarded("chat.history", async (msg) => send({ type: "chat.history", requestId: msg.requestId, chats: await history() })),
    "chat.load": guarded("chat.load", load),
    "chat.capabilities": guarded("chat.capabilities", async (msg) => {
      const engine = msg.engine === "codex" ? "codex" : "claude";
      send({ type: "chat.capabilities", requestId: msg.requestId, ...(await capabilities(engine)) });
    }),
  };

  return {
    handle(msg) {
      if (typeof msg?.type !== "string" || !msg.type.startsWith("chat.")) return false;
      const h = handlers[msg.type];
      if (h) h(msg);
      else log(`ignoring unknown ${msg.type}`);
      return true;
    },
    shutdown() {
      for (const c of chats.values()) {
        clearTimeout(c.idleTimer);
        if (c.proc) {
          c.proc.expected = true;
          c.proc.child.kill("SIGTERM");
        }
      }
    },
  };
}
