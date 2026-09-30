// Turns engine output into the short, safe strings the chat panel shows: tool summaries that
// never carry typed text, form values or script source, and error classification. Shared by the
// live stream (chat.mjs) and transcript loading (chat-history.mjs).

import path from "node:path";

// Plumbing the user has no reason to see as a step (the model loads deferred tool schemas with it).
export const HIDDEN_TOOLS = new Set(["ToolSearch"]);

export const clip = (s, n = 80) => {
  s = String(s ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

// Host and path only: query strings and fragments often carry tokens.
function urlLabel(url) {
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`);
    return u.protocol.startsWith("http") ? `${u.host}${u.pathname === "/" ? "" : u.pathname}` : `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return "a page";
  }
}

const COMPUTER = {
  left_click: "Click",
  right_click: "Right-click",
  double_click: "Double-click",
  triple_click: "Triple-click",
  screenshot: "Take a screenshot",
  scroll: "Scroll",
  scroll_to: "Scroll into view",
  zoom: "Zoom into a region",
  hover: "Hover",
  left_click_drag: "Drag",
  key: "Press keys",
};

function summarizeFirefox(tool, a) {
  switch (tool) {
    case "navigate":
      return a.url === "back" || a.url === "forward" ? `Go ${a.url}` : `Open ${clip(urlLabel(a.url), 60)}`;
    case "computer":
      if (a.action === "type") return `Type ${String(a.text ?? "").length} characters`;
      if (a.action === "wait") return `Wait ${Number(a.duration) || 0}s`;
      return COMPUTER[a.action] ?? "Use the page";
    case "find":
      return `Find "${clip(a.query, 50)}"`;
    case "form_input":
      return "Fill in a form field";
    case "javascript_tool":
      return "Run a script on the page";
    case "file_upload":
      return `Upload ${Array.isArray(a.paths) ? a.paths.length : 1} file(s)`;
    case "get_page_text":
      return "Read the page text";
    case "read_page":
      return "Read the page";
    case "tabs_context_mcp":
      return "List tabs";
    case "tabs_create_mcp":
      return "Open a new tab";
    case "tabs_close_mcp":
      return "Close a tab";
    case "replay_steps":
      // A skill's folder names it; input values are never shown.
      return `Replay ${clip(path.basename(path.dirname(String(a.path ?? ""))) || "steps", 50)}`;
    default:
      return tool;
  }
}

// The tab a Firefox tool call acts in, as a field to spread into tool_start, so the panel can say
// where the agent is working. Only the number is passed on.
export function toolTab(name, input) {
  const id = input?.tabId;
  return String(name).startsWith("mcp__firefox__") && Number.isSafeInteger(id) && id >= 0 ? { tabId: id } : {};
}

const MASKED_LINE = /^\d{1,5} fields? masked on [\w.-]{1,253}$/;

// What redaction masked in a Firefox tool's result ("3 fields masked on acme-supply.com"), as a
// field to spread into tool_end. The extension puts that line in a content part of its own, so
// only a whole part counts: a page can't write one into its own text.
export function toolMasked(name, content) {
  if (!String(name).startsWith("mcp__firefox__") || !Array.isArray(content)) return {};
  const part = content.findLast((p) => p?.type === "text" && MASKED_LINE.test(p.text ?? ""));
  return part ? { masked: part.text } : {};
}

export function summarizeToolUse(name, input) {
  const a = input && typeof input === "object" ? input : {};
  const fx = /^mcp__firefox__(.+)$/.exec(name);
  if (fx) return summarizeFirefox(fx[1], a);
  switch (name) {
    case "Bash":
      return clip(a.description || a.command, 80);
    case "Read":
      return `Read ${path.basename(String(a.file_path ?? ""))}`;
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return `${name === "Write" ? "Write" : "Edit"} ${path.basename(String(a.file_path ?? a.notebook_path ?? ""))}`;
    case "Glob":
      return `Find files ${clip(a.pattern, 50)}`;
    case "Grep":
      return `Search files for ${clip(a.pattern, 50)}`;
    case "WebSearch":
      return `Search the web for ${clip(a.query, 60)}`;
    case "WebFetch":
      return `Fetch ${clip(urlLabel(a.url), 60)}`;
    case "Skill":
      return `Use the ${clip(a.skill ?? a.name, 40)} skill`;
    case "TodoWrite":
      return "Update the to-do list";
    case "Task":
    case "Agent":
      return clip(a.description || "Run a sub-agent", 80);
    default:
      return clip(name.replace(/^mcp__/, "").replace(/__/g, " "), 60);
  }
}

const CARD_COMMAND_CHARS = 2000;
const CARD_TARGET_CHARS = 400;
const CARD_INPUT_CHARS = 1000;

// What the panel's permission card says the agent wants to do, and whether that is all of it.
// The user is deciding on this text, so nothing is silently cut: a Bash command is shown as it
// is (whitespace and all), a file or URL by its full name, and any other tool (a connector's, say)
// by its inputs. `complete` is false when the card had to clip something.
export function summarizePermission(tool, input) {
  const a = input && typeof input === "object" ? input : {};
  const fit = (text, max) => ({ summary: text.length > max ? `${text.slice(0, max - 1)}…` : text, complete: text.length <= max });
  if (tool === "Bash") return fit(String(a.command ?? "").trim(), CARD_COMMAND_CHARS);
  const target = a.file_path ?? a.notebook_path ?? a.url;
  if (typeof target === "string" && target) return fit(target, CARD_TARGET_CHARS);
  const keys = Object.keys(a);
  if (!keys.length) return { summary: summarizeToolUse(tool, a), complete: true };
  const lines = keys.map((k) => `${k}: ${typeof a[k] === "string" ? a[k] : JSON.stringify(a[k])}`);
  return fit(lines.join("\n"), CARD_INPUT_CHARS);
}

// Result summaries: only errors carry text (the bridge already cuts typed values out of its error
// messages). Page content, script output and screenshots never leave the host.
export function summarizeToolResult(name, content, isError) {
  const parts = Array.isArray(content) ? content : typeof content === "string" ? [{ type: "text", text: content }] : [];
  const text = parts.filter((p) => p?.type === "text").map((p) => p.text).join("\n");
  const first = text.split("\n").find((l) => l.trim()) ?? "";
  if (isError) return clip(first || "Failed", 120);
  if (parts.some((p) => p?.type === "image")) return /^mcp__firefox__computer$/.test(name) ? "Screenshot captured" : "Image";
  if (/^mcp__firefox__(navigate|tabs_|replay_steps)/.test(name)) return clip(first, 100);
  if (name === "Bash") return clip(first, 100);
  return "";
}

const LIMIT = /hit your (?:\w+ )?limit|usage limit|limit reached|rate.?limit|out of (?:extra )?usage|spend limit|too many requests|quota|(?:error|status)[: ]+429/i;
const AUTH = /not logged in|please run \/login|\/login|log ?in|sign in|authenticat|unauthorized|invalid (?:api|x-api) ?key|oauth|token (?:has )?expired|(?:error|status)[: ]+401/i;

// Maps an error string (a result, an API error message or stderr) to the contract's error codes.
// `hint` is Claude Code's own error tag on the assistant message when there is one.
export function classifyError(text, hint) {
  if (hint === "rate_limit" || hint === "billing_error") return "limit";
  if (hint === "authentication_failed") return "auth";
  if (LIMIT.test(text)) return "limit";
  if (AUTH.test(text)) return "auth";
  return null;
}

// When a usage limit lifts, in epoch ms, from the wording the CLIs use: Claude Code's older
// "limit reached|<epoch seconds>" and Codex's "try again at Oct 3rd, 2026 1:16 PM" (local time).
export function parseResetTime(text) {
  const epoch = /limit reached\|(\d{9,11})/.exec(text);
  if (epoch) return Number(epoch[1]) * 1000;
  const m = /try again at ([A-Z][a-z]{2} \d{1,2})(?:st|nd|rd|th)?,? (\d{4}) (\d{1,2}:\d{2} [AP]M)/.exec(text);
  const t = m ? Date.parse(`${m[1]}, ${m[2]} ${m[3]}`) : NaN;
  return Number.isFinite(t) ? t : null;
}

// ---- the context block the panel prepends to what the user typed --------------------------------

export const CONTEXT_OPEN = "<panel-context>";
export const CONTEXT_CLOSE = "</panel-context>";

// Picked elements' lines start with "tab ", like the tabs', so stripContext never reads them as files.
export function contextBlock(tabs, files, elements = []) {
  const lines = [];
  if (tabs.length) {
    lines.push("Tabs in your Firefox tab group (call tabs_context_mcp for live state):");
    for (const t of tabs.slice(0, 30)) lines.push(`- tab ${t.tabId}: "${clip(t.title, 100)}" ${clip(t.url, 200)}${t.current ? " (the tab the user is viewing)" : ""}`);
  }
  if (elements.length) {
    lines.push("Elements the user pointed at with Alt+click (a screenshot of each is attached; use the ref with computer, read_page ref_id, find or form_input in that tab):");
    for (const e of elements.slice(0, 10)) {
      const text = clip(e.text, 1000);
      lines.push(`- tab ${e.tabId}, ${clip(e.ref, 40)}: ${clip(e.role, 40) || "element"}${e.name ? ` "${clip(e.name, 150)}"` : ""}${text ? `, text: "${text}"` : ""}`);
    }
  }
  if (files.length) {
    lines.push("Files the user attached, saved on disk (read them by path):");
    for (const f of files) lines.push(`- ${f.name}: ${f.path}`);
  }
  return lines.length ? `${CONTEXT_OPEN}\n${lines.join("\n")}\n${CONTEXT_CLOSE}\n\n` : "";
}

// Splits a stored user message back into what the user typed and the files it referenced.
export function stripContext(text) {
  const m = new RegExp(`^${CONTEXT_OPEN}\\n([\\s\\S]*?)\\n${CONTEXT_CLOSE}\\n\\n?`).exec(text);
  if (!m) return { text, files: [] };
  const files = [...m[1].matchAll(/^- (.+?): (\/.+)$/gm)].filter((f) => !f[1].startsWith("tab ")).map((f) => f[1]);
  return { text: text.slice(m[0].length), files };
}

const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf", txt: "text/plain", md: "text/markdown", json: "application/json", csv: "text/csv" };
export const mimeFromName = (name) => MIME[String(name).split(".").pop().toLowerCase()] ?? "application/octet-stream";

// ---- skills the user runs from the panel ---------------------------------------------------------

// A skill name as Claude Code and Codex spell them (`plugin:skill` for a plugin's); anything else is dropped.
export const skillName = (v) => (typeof v === "string" && /^[\w][\w.:-]{0,79}$/.test(v) ? v : null);

// The sites a skill says it is for: `sites: linkedin.com, greenhouse.io` (or a `[a, b]` list) in its frontmatter.
export function skillSites(md) {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(md).slice(0, 4000))?.[1] ?? "";
  const line = /^sites:[ \t]*(.*)$/m.exec(front)?.[1] ?? "";
  return line
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, "").toLowerCase())
    .filter((s) => /^[\w.*-]+$/.test(s))
    .slice(0, 10);
}

// Claude Code runs a message that starts with /name as that user-invoked skill, with the rest as
// its arguments. Codex has no slash skills, so it is told to read the skill's file.
export function skillPrompt(engine, skill, typed, context) {
  if (engine === "codex") return `${context}${CODEX_SKILL_LINE(skill)}\n\n${typed}`;
  return `/${skill}${typed ? ` ${typed}` : ""}${context ? `\n\n${context.trimEnd()}` : ""}`;
}

const CODEX_SKILL_LINE = (skill) => `Use the ${skill} skill for this request: read ~/.codex/skills/${skill}/SKILL.md and follow it.`;

// Splits a stored Codex user message that carries the line above.
export function stripCodexSkill(text) {
  const m = /^Use the ([\w.:-]+) skill for this request: read ~\/\.codex\/skills\/[^\n]*and follow it\.\n\n/.exec(text);
  return m ? { skill: m[1], text: text.slice(m[0].length) } : { skill: null, text };
}

// A stored Claude Code entry for a skill the user ran: `<command-name>/name</command-name>` and
// `<command-args>` (which holds the typed text and then the panel's context block).
export function stripClaudeSkill(text) {
  const name = /<command-name>\/([^<\n]+)<\/command-name>/.exec(text)?.[1];
  if (!name) return null;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1] ?? "";
  const at = args.indexOf(`\n\n${CONTEXT_OPEN}`);
  const typed = at >= 0 ? args.slice(0, at) : args.startsWith(CONTEXT_OPEN) ? "" : args;
  const files = (at >= 0 ? stripContext(args.slice(at + 2)) : stripContext(args)).files;
  return { skill: name, text: typed.trim(), files };
}
