#!/usr/bin/env node
// MCP server for Claude Code (stdio). Forwards tool calls to the Firefox extension through the
// native host's Unix socket. One process per Claude Code session; the session id keeps each
// session in its own tab group.

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { randomUUID } from "node:crypto";

const DIR = path.join(os.homedir(), ".claude-firefox");
const SOCKET = path.join(DIR, "bridge.sock");
const SCREENSHOT_DIR = path.join(DIR, "screenshots");
const CALL_TIMEOUT_MS = 90_000;
const SESSION = randomUUID();
const VERSION = "0.1.0";

const tabId = (what = "Tab ID to act on") => ({
  type: "number",
  description: `${what}. Must be a tab in this session's Claude tab group. Use tabs_context_mcp first if you don't have a valid tab ID.`,
});

const TOOLS = [
  {
    name: "tabs_context_mcp",
    description:
      "Get the tabs in this session's Claude tab group in Firefox. You must call this at least once before other browser tools so you know which tabs exist. Each new conversation should use its own tab (tabs_create_mcp) rather than reusing tabs, unless the user asks.",
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
      "Open a new background tab in this session's Claude tab group. Tabs open without taking focus, so the user can keep working. Close tabs you create with tabs_close_mcp when done, unless the user wants them kept.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "tabs_close_mcp",
    description: "Close a tab in this session's Claude tab group.",
    inputSchema: { type: "object", properties: { tabId: { type: "integer", description: "The tab to close." } }, required: ["tabId"] },
  },
  {
    name: "navigate",
    description:
      'Navigate a tab to a URL, or "back"/"forward" in history, and wait for the page to load. If tabId is omitted for a URL, the first tab in this session\'s group is used (created if needed) and the tab list is appended.',
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
      "Mouse, keyboard and screenshots for a Firefox tab. Input is trusted (isTrusted, user activation) and works while the tab is in the background, without moving the real cursor.\n* Take a screenshot to find coordinates before clicking by coordinate; clicking by ref from find/read_page is more reliable.\n* Click the center of elements, not their edges.\n* Do not click file inputs or upload buttons (native pickers can't be driven); use file_upload.",
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
      required: ["action", "tabId"],
    },
  },
  {
    name: "read_page",
    description:
      'Accessibility-style tree of the page with a ref for each element (use refs with computer, form_input, file_upload). Output is capped at max_chars (default 50000); use filter "interactive", a smaller depth, or ref_id to focus. Only the top frame is walked; use javascript_tool for same-origin iframes.',
    inputSchema: {
      type: "object",
      properties: {
        tabId: tabId(),
        filter: { type: "string", enum: ["interactive", "all"], description: '"interactive" for buttons, links and fields only; "all" (default) includes structure and text.' },
        depth: { type: "number", description: "Maximum tree depth (default 15)." },
        ref_id: { type: "string", description: "Read only this element's subtree." },
        max_chars: { type: "number", description: "Output cap (default 50000)." },
      },
      required: ["tabId"],
    },
  },
  {
    name: "find",
    description:
      'Find elements by what they are or say (e.g. "Easy Apply button", "search box", "resume file input"). Matching is keyword-based over names, roles, labels and attributes, so use words that appear on the page. Returns up to 20 matches with refs and coordinates.',
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "What to look for." }, tabId: tabId() },
      required: ["query", "tabId"],
    },
  },
  {
    name: "form_input",
    description:
      "Set a form field by ref: text inputs and textareas (fires input/change so React sees it), selects (by option value or text), checkboxes/radios (boolean), contenteditable. For custom widgets, use computer clicks.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: 'Element ref from read_page or find (e.g. "ref_3").' },
        value: { type: ["string", "boolean", "number"], description: "Value to set." },
        tabId: tabId(),
      },
      required: ["ref", "value", "tabId"],
    },
  },
  {
    name: "javascript_tool",
    description:
      "Run JavaScript against the page's window and DOM (page CSP does not block it). REPL semantics: the last expression's value is returned, and top-level await works. Write the expression, not `return`.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "Must be 'javascript_exec'." },
        text: { type: "string", description: "Code to run." },
        tabId: tabId(),
      },
      required: ["action", "text", "tabId"],
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
      required: ["paths", "ref", "tabId"],
    },
  },
  {
    name: "get_page_text",
    description: "The page's visible text as plain text (title and URL first). Good for reading job lists, articles and descriptions.",
    inputSchema: { type: "object", properties: { tabId: tabId() }, required: ["tabId"] },
  },
];

// ---- bridge connection --------------------------------------------------------------------

let bridge = null;
let nextId = 1;
const inflight = new Map();

function connectBridge() {
  if (bridge) return bridge;
  bridge = new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCKET);
    let buf = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => resolve(socket));
    socket.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const msg = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        inflight.get(msg.id)?.resolve(msg.result);
        inflight.delete(msg.id);
      }
    });
    const fail = (err) => {
      bridge = null;
      for (const p of inflight.values()) p.reject(err);
      inflight.clear();
      reject(err);
    };
    socket.once("error", fail);
    socket.once("close", () => fail(new Error("Firefox closed the connection.")));
  });
  return bridge;
}

async function callFirefox(tool, args) {
  let socket;
  try {
    socket = await connectBridge();
  } catch {
    throw new Error(
      "Firefox isn't connected. Open Firefox Developer Edition (the Claude for Firefox extension connects on startup) and retry.",
    );
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      inflight.delete(id);
      reject(new Error(`Firefox did not answer ${tool} within ${CALL_TIMEOUT_MS / 1000}s.`));
    }, CALL_TIMEOUT_MS);
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

// ---- MCP stdio ----------------------------------------------------------------------------

const out = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

async function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      return {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "claude-firefox", version: VERSION },
        instructions:
          "Browser tools for Firefox Developer Edition. Tabs live in a per-session 'Claude' tab group and run in the background; input is trusted and never moves the user's cursor.",
      };
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call": {
      const { name, arguments: args = {} } = params;
      if (!TOOLS.some((t) => t.name === name)) throw Object.assign(new Error(`Unknown tool ${name}`), { code: -32602 });
      try {
        const result = await callFirefox(name, args);
        return args.save_to_disk ? saveImages(result) : result;
      } catch (e) {
        return { content: [{ type: "text", text: e.message }], isError: true };
      }
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
