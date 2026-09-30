#!/usr/bin/env node
// MCP server (stdio) for any MCP client, such as Claude Code or Codex. Forwards tool calls to
// the Firefox extension through the native host's Unix socket. One process per agent session;
// the session id keeps each session in its own tab group.

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { randomUUID } from "node:crypto";

const DIR = path.join(os.homedir(), ".firefox-agent-bridge");
const SOCKET = path.join(DIR, "bridge.sock");
const SCREENSHOT_DIR = path.join(DIR, "screenshots");
const CALL_TIMEOUT_MS = 90_000;
// The chat panel pins its agent to the chat id so the agent's calls land in the chat's tab group.
const SESSION = process.env.FIREFOX_AGENT_BRIDGE_SESSION || randomUUID();
const VERSION = "0.1.0";

const tabId = (what = "Tab ID to act on") => ({
  type: "number",
  description: `${what}. Must be a tab in the agent's tab group. If omitted, the tab this session last used is taken (or its only tab).`,
});

const TOOLS = [
  {
    name: "tabs_context_mcp",
    description:
      "Get the tabs in the agent's tab group in Firefox. You must call this at least once before other browser tools so you know which tabs exist. Each new conversation should use its own tab (tabs_create_mcp) rather than reusing tabs, unless the user asks.",
    inputSchema: {
      type: "object",
      properties: {
        createIfEmpty: { type: "boolean", description: "Create the tab group with one empty tab if this session has none." },
      },
    },
  },
  {
    name: "tabs_create_mcp",
    description:
      "Open a new background tab in the agent's tab group. Tabs open without taking focus, so the user can keep working. Close tabs you create with tabs_close_mcp when done, unless the user wants them kept.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "tabs_close_mcp",
    description: "Close a tab in the agent's tab group.",
    inputSchema: { type: "object", properties: { tabId: { type: "integer", description: "The tab to close." } }, required: ["tabId"] },
  },
  {
    name: "navigate",
    description:
      'Navigate a tab to a URL, or "back"/"forward" in history, and wait for the page to load. If tabId is omitted for a URL, the first tab in this session\'s group is used (created if needed) and the tab list is appended. Reading several pages? Don\'t spend a call per step: put each page\'s navigate and its read (get_page_text, or javascript_tool) into one batch call.',
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: 'URL to open (https:// assumed if missing), or "back" / "forward".' },
        tabId: tabId("Tab to navigate. Required for back/forward"),
      },
      required: ["url"],
    },
  },
  {
    name: "computer",
    description:
      "Screenshots, clicks, typing and scrolling in a Firefox tab are all actions of this one tool; there are no separate screenshot or click tools. Input is trusted (isTrusted, user activation) and works while the tab is in the background, without moving the real cursor.\n* Take a screenshot to find coordinates before clicking by coordinate; clicking by ref from find/read_page is more reliable.\n* Click the center of elements, not their edges.\n* Do not click file inputs or upload buttons (native pickers can't be driven); use file_upload.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["left_click", "right_click", "type", "screenshot", "wait", "scroll", "key", "left_click_drag", "double_click", "triple_click", "zoom", "scroll_to", "hover"],
          description:
            "left_click/right_click/double_click/triple_click at coordinate or ref; type: type text into the focused element; screenshot: capture the tab; wait: pause (max 10s); scroll: scroll at coordinate (or viewport center); key: press keys (space-separated, combos like cmd+a); left_click_drag: drag from start_coordinate to coordinate; zoom: capture a region at higher resolution; scroll_to: scroll a ref into view; hover: move the pointer over a coordinate or ref.",
        },
        tabId: tabId(),
        coordinate: {
          type: "array", items: { type: "number" }, minItems: 2, maxItems: 2,
          description: "(x, y) in the frame of this tab's latest screenshot.",
        },
        start_coordinate: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2, description: "Drag start (x, y)." },
        ref: { type: "string", description: 'Element ref from read_page or find (e.g. "ref_12"). Alternative to coordinate for clicks and hover; required for scroll_to.' },
        text: { type: "string", description: 'Text to type (type), or keys to press (key), e.g. "Enter", "Backspace Backspace", "cmd+a".' },
        modifiers: { type: "string", description: 'Modifier keys held during a click, e.g. "cmd", "shift", "ctrl+shift".' },
        repeat: { type: "number", minimum: 1, maximum: 100, description: "Times to repeat the key sequence (key only)." },
        scroll_direction: { type: "string", enum: ["up", "down", "left", "right"] },
        scroll_amount: { type: "number", minimum: 1, maximum: 10, description: "Scroll ticks (about 100px each), default 3." },
        duration: { type: "number", minimum: 0, maximum: 10, description: "Seconds to wait (wait only)." },
        region: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4, description: "(x0, y0, x1, y1) in screenshot coordinates, for zoom." },
        scale: { type: "number", minimum: 0.1, maximum: 1, description: "Return the screenshot/zoom image at this fraction of full size to save tokens. Coordinates stay in the full-size frame." },
        save_to_disk: { type: "boolean", description: "Save the screenshot/zoom image to disk and return its path, for sharing with the user." },
      },
      required: ["action"],
    },
  },
  {
    name: "read_page",
    description:
      'Accessibility-style tree of the page with a ref for each element (use refs with computer, form_input, file_upload). Output is capped at max_chars (default 50000); use filter "interactive", a smaller depth, or ref_id to focus. Child frames (cross-origin ones and ones inside shadow roots too) are walked: a frame\'s tree sits under its iframe line, and its refs (ref_3@f12) work with every tool that takes a ref.',
    inputSchema: {
      type: "object",
      properties: {
        tabId: tabId(),
        filter: { type: "string", enum: ["interactive", "all"], description: '"interactive" for buttons, links and fields only; "all" (default) includes structure and text.' },
        depth: { type: "number", description: "Maximum tree depth (default 15)." },
        ref_id: { type: "string", description: "Read only this element's subtree." },
        max_chars: { type: "number", description: "Output cap (default 50000)." },
      },
    },
  },
  {
    name: "find",
    description:
      'Find elements by what they are or say (e.g. "Easy Apply button", "search box", "resume file input"). Matching is keyword-based over names, roles, labels and attributes, so use words that appear on the page. Returns the best 8 with refs and coordinates.',
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "What to look for." }, tabId: tabId() },
      required: ["query"],
    },
  },
  {
    name: "form_input",
    description:
      "Set a form field by ref: text inputs and textareas (fires input/change so React sees it), selects (by option value or text), checkboxes/radios (boolean), contenteditable. To fill several fields at once, pass fields: [{ref, value}, ...] instead of ref/value; they are set in order and it stops at the first failure. For custom widgets, use computer clicks.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: 'Element ref from read_page or find (e.g. "ref_3").' },
        value: { type: ["string", "boolean", "number"], description: "Value to set." },
        fields: {
          type: "array",
          description: "Several fields to set in one call, in order. Use instead of ref/value.",
          items: {
            type: "object",
            properties: { ref: { type: "string" }, value: { type: ["string", "boolean", "number"] } },
            required: ["ref", "value"],
          },
        },
        tabId: tabId(),
      },
    },
  },
  {
    name: "javascript_tool",
    description:
      "Run JavaScript against the page's window and DOM (page CSP does not block it). REPL semantics: the last expression's value is returned, and top-level await works. Write the expression, not `return`. To read several pages on the same site, fetch() them in one call and parse each with DOMParser instead of navigating to each one. Fetch the pages you would have navigated to, not the site's API.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "Must be 'javascript_exec'." },
        text: { type: "string", description: "Code to run." },
        tabId: tabId(),
      },
      required: ["action", "text"],
    },
  },
  {
    name: "file_upload",
    description:
      "Put local files on a file input (by ref from find/read_page) without opening a native picker. Never click upload buttons or file inputs. Combined size must be under 10 MB.",
    inputSchema: {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" }, description: "Absolute paths of files to upload." },
        ref: { type: "string", description: "Ref of the file input (or its label)." },
        tabId: tabId(),
      },
      required: ["paths", "ref"],
    },
  },
  {
    name: "get_page_text",
    description: "The page's visible text as plain text (title and URL first). Good for reading job lists, articles and descriptions.",
    inputSchema: { type: "object", properties: { tabId: tabId() } },
  },
  {
    name: "replay_steps",
    description:
      "Run a recorded replay.json (saved by Teach in the Firefox panel, next to a skill's SKILL.md) in a tab, without reasoning about each step. Each step's element is found by role and name (then its CSS selector and nearby text), acted on, and its expected result checked. It stops at the first step that doesn't match and returns the step number, what was expected, the recorded screenshot of that step and the page's interactive elements; finish the task from there with the other tools.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path of the replay.json." },
        inputs: {
          type: "object",
          additionalProperties: { type: "string" },
          description: 'Values for the replay\'s inputs by name, e.g. {"card_number": "1234"}, including secret ones (listed as "name:keychain" or "name:ask"). They are typed into the page and never logged.',
        },
        tabId: tabId("Tab to replay in. Omit to use the first tab in the agent's tab group (created if needed)"),
      },
      required: ["path"],
    },
  },
];

// devtools is opt-in: listed only with FIREFOX_BRIDGE_DEVTOOLS=1, since every tool definition is
// sent to the model on every turn. The hello tells Firefox to capture this session's tabs.
const DEVTOOLS = process.env.FIREFOX_BRIDGE_DEVTOOLS === "1";
if (DEVTOOLS) {
  TOOLS.push({
    name: "devtools",
    // Kept short: under 600 characters of JSON (host/test/mcp-devtools.test.mjs checks).
    description:
      "A tab's console messages or network requests, kept from page load on, across navigations. level is a minimum. onlyFailed: errors and 4xx/5xx. limit: newest N (50). clear: empty after reading.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["console", "network"] },
        tabId: { type: "number" },
        pattern: { type: "string", description: "Regex on text or URL." },
        level: { type: "string", enum: ["error", "warning", "info", "log"] },
        onlyFailed: { type: "boolean" },
        limit: { type: "number" },
        clear: { type: "boolean" },
      },
      required: ["kind"],
    },
  });
}

// ---- experiments ----------------------------------------------------------------------------
// Switches for A/B runs in the eval (eval/README.md, "Experiments"), so a change to what the model
// sees can be measured without restarting Firefox. FIREFOX_BRIDGE_EXPERIMENTS is a comma-separated
// list of flags. Unset, the server behaves as shipped. Flags that were measured and kept became the
// default; one flag turns that back off, for measuring against the old behavior:
//   waitForLoad: navigate waits for the load event and the text to settle, as before 2026-09-30,
//     instead of returning once the page is parsed.
const EXPERIMENT_FLAGS = ["waitForLoad"];
if (process.argv.includes("--list-experiments")) {
  console.log(EXPERIMENT_FLAGS.join("\n"));
  process.exit(0);
}
const EXPERIMENTS = new Set();
for (const item of (process.env.FIREFOX_BRIDGE_EXPERIMENTS ?? "").split(",")) {
  const name = item.trim();
  if (!name) continue;
  if (EXPERIMENT_FLAGS.includes(name)) EXPERIMENTS.add(name);
  else process.stderr.write(`firefox-agent-bridge: unknown experiment "${name}" ignored\n`);
}
const on = (flag) => EXPERIMENTS.has(flag);

const REPLAY_TIMEOUT_MS = 600_000;
const MAX_REPLAY_BYTES = 1_000_000;

// replay_steps reads the file here, where the path is meaningful, and sends Firefox the steps.
// Screenshot paths in it are relative to the file.
function loadReplay(args) {
  const file = String(args.path ?? "");
  if (!path.isAbsolute(file)) throw new Error("path must be the absolute path of a replay.json.");
  let replay;
  try {
    if (fs.statSync(file).size > MAX_REPLAY_BYTES) throw new Error("it is over 1 MB");
    replay = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`Couldn't read ${file}: ${e.message}`);
  }
  if (!Array.isArray(replay?.steps)) throw new Error(`${file} has no steps.`);
  for (const step of replay.steps) {
    if (typeof step?.shot === "string") step.shot = path.resolve(path.dirname(file), step.shot);
  }
  return { replay, inputs: args.inputs, tabId: args.tabId };
}
// Tools a batch may run: everything above except replay_steps (long-running, reads a file) and batch itself.
const BATCHABLE = TOOLS.map((t) => t.name).filter((n) => n !== "replay_steps");
const BATCH_MAX = 20;

TOOLS.push({
  name: "batch",
  description:
    "Run several browser actions in one call, one after another, to save round trips. Use it when you already know every step's arguments, e.g. navigate then get_page_text on the same tab, or several clicks/keys on refs you already have. Each action is {tool, args}, with the same args that tool takes (tabId included). Stops at the first failed action and says which one; results come back in order, one section per action. Only the last screenshot's image is returned. Don't batch a step whose arguments depend on an earlier step's result (such as refs from a page you haven't read yet).",
  inputSchema: {
    type: "object",
    properties: {
      actions: {
        type: "array",
        minItems: 1,
        maxItems: BATCH_MAX,
        description: `Actions to run in order (at most ${BATCH_MAX}).`,
        items: {
          type: "object",
          properties: {
            tool: { type: "string", enum: BATCHABLE, description: "Tool name, e.g. navigate, get_page_text, computer." },
            args: { type: "object", description: "That tool's arguments." },
          },
          required: ["tool", "args"],
        },
      },
    },
    required: ["actions"],
  },
});

// ---- bridge connection --------------------------------------------------------------------

let bridge = null;
let nextId = 1;
const inflight = new Map();
let clientInfo = { name: "unknown MCP client", version: null }; // from initialize's clientInfo

function connectBridge() {
  if (bridge) return bridge;
  const attempt = new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCKET);
    let buf = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      // Identifies this client to Firefox; sent first on every connection, reconnects included.
      socket.write(JSON.stringify({ type: "hello", client: clientInfo, pid: process.pid, cwd: process.cwd(), ...(DEVTOOLS ? { devtools: true } : {}) }) + "\n");
      resolve(socket);
    });
    socket.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        inflight.get(msg.id)?.resolve(msg.result);
        inflight.delete(msg.id);
      }
    });
    let failed = false;
    const fail = (err) => {
      if (failed) return;
      failed = true;
      if (bridge === attempt) bridge = null;
      for (const p of inflight.values()) p.reject(err);
      inflight.clear();
      reject(err);
    };
    socket.on("error", fail);
    socket.once("close", () => fail(new Error("Firefox closed the connection (the browser quit, or the user disconnected this client in the Firefox Agent Bridge popup).")));
  });
  bridge = attempt;
  return bridge;
}

async function callFirefox(tool, args, timeoutMs = tool === "replay_steps" ? REPLAY_TIMEOUT_MS : CALL_TIMEOUT_MS) {
  let socket;
  try {
    socket = await connectBridge();
  } catch {
    throw new Error(
      "Firefox isn't connected. Open Firefox Developer Edition (the extension connects on startup) and retry.",
    );
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      inflight.delete(id);
      reject(new Error(`Firefox did not answer ${tool} within ${timeoutMs / 1000}s.`));
    }, timeoutMs);
    inflight.set(id, {
      resolve: (r) => (clearTimeout(timer), resolve(r)),
      reject: (e) => (clearTimeout(timer), reject(e)),
    });
    socket.write(JSON.stringify({ id, session: SESSION, tool, args }) + "\n");
  });
}

function saveImages(result) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const saved = [];
  for (const item of result.content) {
    if (item.type !== "image") continue;
    const ext = item.mimeType === "image/png" ? "png" : "jpg";
    const file = path.join(SCREENSHOT_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`);
    fs.writeFileSync(file, Buffer.from(item.data, "base64"));
    saved.push(file);
  }
  if (saved.length) result.content.push({ type: "text", text: `Saved to ${saved.join(", ")}` });
  return result;
}

// ---- tool dispatch --------------------------------------------------------------------------

const errorResult = (message) => ({ content: [{ type: "text", text: message }], isError: true });

async function callOne(tool, args) {
  try {
    const result = await callFirefox(tool, args);
    return args.save_to_disk ? saveImages(result) : result;
  } catch (e) {
    return errorResult(e.message);
  }
}

// form_input with fields: one form_input per field, in order, stopping at the first failure.
async function formInput(args) {
  if (!Array.isArray(args.fields)) {
    if (args.ref === undefined || args.value === undefined) return errorResult("form_input needs ref and value, or fields: [{ref, value}, ...].");
    return callOne("form_input", args);
  }
  if (!args.fields.length) return errorResult("fields is empty.");
  const lines = [];
  for (const [i, f] of args.fields.entries()) {
    const r = await callOne("form_input", { tabId: args.tabId, ref: f?.ref, value: f?.value });
    const t = textOf(r);
    if (r.isError) {
      lines.push(`[${i + 1}/${args.fields.length}] ${f?.ref}: failed: ${t}`);
      if (i + 1 < args.fields.length) lines.push(`Stopped; the remaining ${args.fields.length - i - 1} field(s) were not set.`);
      return { content: [{ type: "text", text: lines.join("\n") }], isError: true };
    }
    lines.push(`[${i + 1}/${args.fields.length}] ${f.ref}: ${t}`);
  }
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

const textOf = (r) => (r?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");

// ---- the session's current tab -------------------------------------------------------------
// Models sometimes leave tabId out even when they have one. The server remembers the tab this
// session last used or was handed (navigate, tabs_create_mcp and tabs_context_mcp results) and
// fills it in, instead of failing and costing the model a turn.

let lastTab = null;
let knownTabs = null; // tab ids from the latest tab list, or null before one has been seen

// The tab list JSON that tabs_context_mcp returns, and that tabs_create_mcp and navigate append.
function tabListIn(text) {
  const m = /(^|\n)\{/.exec(text);
  if (!m) return null;
  try {
    const ids = JSON.parse(text.slice(m.index + m[1].length)).availableTabs?.map((t) => t.tabId);
    return Array.isArray(ids) && ids.every(Number.isInteger) ? ids : null;
  } catch {
    return null;
  }
}

function noteTabs(name, args, result) {
  if (result.isError) return;
  const text = textOf(result);
  const list = tabListIn(text);
  if (list) {
    knownTabs = list;
    if (!list.includes(lastTab)) lastTab = list.length === 1 ? list[0] : null;
  }
  if (name === "tabs_close_mcp") {
    if (knownTabs) knownTabs = knownTabs.filter((id) => id !== args.tabId);
    if (lastTab === args.tabId) lastTab = knownTabs?.length === 1 ? knownTabs[0] : null;
    return;
  }
  const made = /^(?:Created tab|Tab) (\d+)\b/.exec(text);
  if (made && (name === "tabs_create_mcp" || name === "navigate")) lastTab = Number(made[1]);
  else if (Number.isInteger(args.tabId)) lastTab = args.tabId;
}

// Fills in a missing tabId: the last tab used, else the session's only tab. Returns the id, or an
// error result when there is no single tab to pick.
async function resolveTab() {
  if (lastTab != null) return lastTab;
  if (knownTabs?.length !== 1) {
    const r = await callOne("tabs_context_mcp", {});
    if (r.isError) return r;
    noteTabs("tabs_context_mcp", {}, r);
  }
  if (lastTab != null) return lastTab;
  if (!knownTabs?.length) return errorResult("tabId is required: this session has no tabs yet. Call navigate with a url (it opens one) or tabs_create_mcp.");
  return errorResult(`tabId is required: this session has ${knownTabs.length} tabs (${knownTabs.join(", ")}). Pass the one to act on.`);
}

const NO_TAB = new Set(["tabs_context_mcp", "tabs_create_mcp"]);

async function runTool(name, args) {
  args = { ...args };
  if (typeof args.tabId === "string" && /^\s*\d+\s*$/.test(args.tabId)) args.tabId = Number(args.tabId);
  let filled = null;
  // navigate to a URL without a tab already picks the group's first tab (creating it if needed).
  const navigateNew = name === "navigate" && args.url !== "back" && args.url !== "forward";
  if (args.tabId == null && !NO_TAB.has(name) && name !== "tabs_close_mcp" && !(navigateNew && lastTab == null)) {
    const t = await resolveTab();
    if (typeof t !== "number") return t;
    args.tabId = filled = t;
  }
  // navigate returns once the page is parsed instead of after the load event and the text
  // settling (0.6s a page against 1.9s in the eval, with the same text read right after). A call
  // can still ask for wait: "load".
  if (name === "navigate" && args.wait == null && !on("waitForLoad")) args.wait = "interactive";
  const result = name === "form_input" ? await formInput(args) : await callOne(name, args);
  noteTabs(name, args, result);
  if (filled != null) result.content = [...(result.content ?? []), { type: "text", text: `(No tabId given; used tab ${filled}.)` }];
  return result;
}

// batch: runs actions in order, each with its own timeout, stops at the first error. Text from
// every action is kept; of the images, only the last one is returned.
async function batch(args) {
  const actions = args.actions;
  if (!Array.isArray(actions) || !actions.length) return errorResult("actions must be a non-empty array of {tool, args}.");
  if (actions.length > BATCH_MAX) return errorResult(`At most ${BATCH_MAX} actions per batch.`);
  const content = [];
  let failed = false;
  for (const [i, a] of actions.entries()) {
    const head = `[${i + 1}/${actions.length}] ${a?.tool}`;
    const r = !BATCHABLE.includes(a?.tool)
      ? errorResult(`Unknown or unbatchable tool ${a?.tool}.`)
      : await runTool(a.tool, a.args && typeof a.args === "object" ? a.args : {});
    content.push({ type: "text", text: `${head}${r.isError ? " failed" : ""}:` });
    for (const c of r.content ?? []) content.push(c);
    if (r.isError) {
      failed = true;
      if (i + 1 < actions.length) content.push({ type: "text", text: `Stopped at action ${i + 1}; the remaining ${actions.length - i - 1} action(s) did not run.` });
      break;
    }
  }
  const lastImage = content.findLastIndex((c) => c.type === "image");
  const out = content.map((c, i) => (c.type === "image" && i !== lastImage ? { type: "text", text: "(image omitted: a batch returns only its last image)" } : c));
  return failed ? { content: out, isError: true } : { content: out };
}

// ---- MCP stdio ----------------------------------------------------------------------------

const out = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

async function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize": {
      const info = params?.clientInfo;
      if (info && typeof info.name === "string" && info.name) {
        // The chat panel's agent is told apart from the same program run in a terminal, so
        // disconnecting one in Firefox doesn't block the other.
        const name = process.env.FIREFOX_AGENT_BRIDGE_SESSION ? `${info.name} (sidebar)` : info.name;
        clientInfo = { name, version: typeof info.version === "string" ? info.version : null };
      }
      return {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "firefox-agent-bridge", version: VERSION },
        instructions:
          "Browser tools for Firefox Developer Edition. Tabs live in the agent's own per-session tab group and run in the background; input is trusted and never moves the user's cursor. Each tool call is a round trip: use batch to run several known steps (e.g. navigate + get_page_text for each of several pages) in one call, and form_input's fields to fill a form at once.",
      };
    }
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call": {
      const { name, arguments: args = {} } = params;
      if (!TOOLS.some((t) => t.name === name)) throw Object.assign(new Error(`Unknown tool ${name}`), { code: -32602 });
      if (name === "replay_steps") {
        try {
          return await callFirefox(name, loadReplay(args));
        } catch (e) {
          return errorResult(e.message);
        }
      }
      return name === "batch" ? batch(args) : runTool(name, args);
    }
    case "ping":
      return {};
    default:
      if (id === undefined) return undefined; // notification
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("close", () => process.exit(0));
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return out({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
  try {
    const result = await handle(msg);
    if (msg.id !== undefined) out({ jsonrpc: "2.0", id: msg.id, result });
  } catch (e) {
    if (msg.id !== undefined) out({ jsonrpc: "2.0", id: msg.id, error: { code: e.code ?? -32603, message: e.message } });
  }
});
