"use strict";

// The chat panel (docs/chat-panel.md). One page for three hosts: Firefox's sidebar, the popup
// window behind "Pop out", and an ordinary tab at panel.html?window=<id>, which is how tests
// drive it. It draws what background.js relays and sends the user's choices back. Everything
// that came from the agent, the host or a page is set as text or built as DOM nodes, never
// parsed as markup.

const params = new URLSearchParams(location.search);
const themeParam = params.get("theme");
if (themeParam === "light" || themeParam === "dark") document.documentElement.dataset.theme = themeParam;

const $ = (id) => document.getElementById(id);

const ENGINES = {
  claude: { name: "Claude Code", short: "Claude", flag: "--claude-code", bin: "claude" },
  codex: { name: "Codex", short: "Codex", flag: "--codex", bin: "codex" },
};
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const TOAST_MS = 4000;
const FRESH_MS = 30_000;
const EFFORT_LABELS = { low: "Low", medium: "Med", high: "High", xhigh: "XHigh", max: "Max" };
const GROUP_COLORS = {
  blue: "#3b82f6",
  cyan: "#1fb5cc",
  green: "#2fa863",
  orange: "#ef8a1f",
  pink: "#e0568c",
  purple: "#7542e5",
  red: "#e5484d",
  yellow: "#d9a800",
  grey: "#8f8f9d",
};

// ---------------------------------------------------------------------------------------------
// DOM helpers and icons

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (k === "style" || k === "role" || k.startsWith("aria-") || k.startsWith("data-")) node.setAttribute(k, v);
    else node[k] = v;
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c);
  return node;
}

// 16px grid, drawn like the agent cursor: round joins, 1.4 strokes.
const ICON_PATHS = {
  pointer: '<path d="M3 1.2 L3 14.9 L7.1 11.2 L13.1 10.8 Z"/>',
  history: '<path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9"/><path d="M2.5 2.5v2.2h2.2"/><path d="M8 5v3l2 1.3"/>',
  compose: '<path d="M7.5 2.5H4A1.5 1.5 0 0 0 2.5 4v8A1.5 1.5 0 0 0 4 13.5h8a1.5 1.5 0 0 0 1.5-1.5V8.5"/><path d="M11.5 2.2l2.3 2.3L8.3 10H6V7.7z"/>',
  more: '<g fill="currentColor" stroke="none"><circle cx="3.5" cy="8" r=".9"/><circle cx="8" cy="8" r=".9"/><circle cx="12.5" cy="8" r=".9"/></g>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  clip: '<path d="M13 7.5l-5 5a3 3 0 0 1-4.2-4.2l5.3-5.3a2 2 0 0 1 2.8 2.8L6.6 11a1 1 0 0 1-1.4-1.4L10 4.8"/>',
  chevr: '<path d="M6 3.5L10.5 8 6 12.5"/>',
  chevd: '<path d="M4 6l4 4 4-4"/>',
  send: '<path d="M8 13V3M4 7l4-4 4 4"/>',
  stop: '<rect x="3.5" y="3.5" width="9" height="9" rx="1.6"/>',
  x: '<path d="M4 4l8 8M12 4l-8 8"/>',
  check: '<path d="M3.5 8.5l3 3 6-7"/>',
  pause: '<path d="M6 4v8M10 4v8"/>',
  skills: '<path d="M8 2v3M8 11v3M2 8h3M11 8h3M4.2 4.2l1.9 1.9M9.9 9.9l1.9 1.9M11.8 4.2L9.9 6.1M6.1 9.9l-1.9 1.9"/>',
  conn: '<rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="9" y="9" width="4.5" height="4.5" rx="1"/><path d="M7 4.75h2.5a1.5 1.5 0 0 1 1.5 1.5V9"/>',
  plug: '<path d="M3 5.5h2.8a1.6 1.6 0 1 1 3.2 0H12v2.8a1.6 1.6 0 1 1 0 3.2V13.5H3z"/>',
  tab: '<rect x="2" y="3.5" width="12" height="9" rx="1.5"/><path d="M2 6.5h12"/>',
  popout: '<path d="M9 2.5h4.5V7M13.5 2.5L8 8M11 9.5V13a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5V5.5A.5.5 0 0 1 3 5h3.5"/>',
  copy: '<rect x="5" y="5" width="8.5" height="8.5" rx="1.5"/><path d="M11 5V3.5a1 1 0 0 0-1-1H3.5a1 1 0 0 0-1 1V10a1 1 0 0 0 1 1H5"/>',
  search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5l3 3"/>',
  warn: '<path d="M8 2.5l6 10.5H2z"/><path d="M8 6.5v3M8 11.4v.1"/>',
  unplug: '<path d="M5 11l-2.5 2.5M11 5l2.5-2.5M6.5 6.5l3 3M4.5 8.5l3 3 1.5-1.5-3-3zM11.5 7.5l-3-3L7 6l3 3z"/>',
  back: '<path d="M13 8H3M7 4L3 8l4 4"/>',
  list: '<path d="M3 4.5h10M3 8h10M3 11.5h10"/>',
  lock: '<rect x="4" y="7" width="8" height="6.5" rx="1.2"/><path d="M5.8 7V5.3a2.2 2.2 0 0 1 4.4 0V7"/>',
  file: '<path d="M4 2.5h5l3 3v8H4z"/><path d="M9 2.5v3h3"/>',
};
const SVG_NS = "http://www.w3.org/2000/svg";
const iconCache = new Map();
function icon(name, cls = "") {
  let proto = iconCache.get(name);
  if (!proto) {
    const doc = new DOMParser().parseFromString(`<svg xmlns="${SVG_NS}" viewBox="0 0 16 16" class="ico" aria-hidden="true">${ICON_PATHS[name]}</svg>`, "image/svg+xml");
    proto = document.importNode(doc.documentElement, true);
    iconCache.set(name, proto);
  }
  const svg = proto.cloneNode(true);
  if (cls) svg.classList.add(...cls.split(" "));
  return svg;
}

// replaceChildren that skips null and flattens arrays, like el() does.
const fill = (node, ...kids) => node.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));

function hydrateIcons(root) {
  for (const n of root.querySelectorAll("[data-i]")) n.replaceChildren(icon(n.dataset.i));
}

// ---------------------------------------------------------------------------------------------
// Small formatters

const shortText = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const clock = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
const secs = (ms) => (ms >= 60000 ? `${Math.floor(ms / 60000)}m ${Math.round(ms / 1000) % 60}s` : `${Math.max(1, Math.round(ms / 1000))}s`);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const asMs = (t) => (typeof t === "number" ? (t < 1e12 ? t * 1000 : t) : Date.parse(t));

function hostOf(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.hostname.replace(/^www\./, "") : "";
  } catch {
    return "";
  }
}

// "github.com" reads as "Github", "docs.python.org" as "Python".
function siteName(url) {
  const labels = hostOf(url).split(".").filter(Boolean);
  if (!labels.length) return "";
  let i = labels.length > 1 ? labels.length - 2 : 0;
  if (labels.length > 2 && labels.at(-1).length === 2 && labels.at(-2).length <= 3) i = labels.length - 3;
  return labels[i][0].toUpperCase() + labels[i].slice(1);
}

function whenLabel(t) {
  const ms = asMs(t);
  if (!Number.isFinite(ms)) return "";
  const ago = Date.now() - ms;
  const d = new Date(ms);
  const now = new Date(Date.now());
  if (ago < 60_000) return "Now";
  if (ago < 3_600_000) return `${Math.floor(ago / 60_000)}m`;
  if (d.toDateString() === now.toDateString()) return `${Math.floor(ago / 3_600_000)}h`;
  if (new Date(now - 86_400_000).toDateString() === d.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}

// "Alt+Shift+X" reads as "⌥⇧X" on a Mac.
function formatShortcut(key) {
  if (!/Mac/.test(navigator.platform)) return key;
  const sym = { Alt: "⌥", Shift: "⇧", Ctrl: "⌘", Command: "⌘", MacCtrl: "⌃" };
  return key.split("+").map((k) => sym[k] ?? k).join("");
}

// ---------------------------------------------------------------------------------------------
// Minimal markdown, built as DOM nodes. Paragraphs, headings, lists, quotes, code, tables, bold,
// italic, inline code and http(s)/mailto links. It is fed half-finished text while streaming, so
// an unclosed fence or emphasis just renders as it stands.

const SAFE_URL = /^(https?:|mailto:)/i;
const INLINE = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\*\*(\S(?:[\s\S]*?\S)?)\*\*|__(\S(?:[\s\S]*?\S)?)__|\[([^\]\n]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>]+)|\*(\S(?:[^*\n]*?\S)?)\*|(?<![\w])_(\S(?:[^_\n]*?\S)?)_(?![\w])/g;

function linkNode(url, kids) {
  return SAFE_URL.test(url) ? el("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, kids) : el("span", {}, kids);
}

function inline(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[2] != null) out.push(el("code", { text: m[2].replace(/^ (.*) $/, "$1") }));
    else if (m[3] != null || m[4] != null) out.push(el("strong", {}, inline(m[3] ?? m[4])));
    else if (m[5] != null) out.push(linkNode(m[6], inline(m[5])));
    else if (m[7] != null) {
      // A sentence's closing punctuation isn't part of the address.
      let url = m[7];
      let trail = /[.,;:!?'"*_]+$/.exec(url)?.[0] ?? "";
      url = url.slice(0, url.length - trail.length);
      while (url.endsWith(")") && url.split(")").length > url.split("(").length) {
        url = url.slice(0, -1);
        trail = `)${trail}`;
      }
      out.push(linkNode(url, [url]));
      if (trail) out.push(trail);
    } else out.push(el("em", {}, inline(m[8] ?? m[9])));
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const cells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

function listNode(items) {
  const ordered = /^\d/.test(items[0].marker);
  const list = el(ordered ? "ol" : "ul");
  if (ordered && parseInt(items[0].marker, 10) !== 1) list.start = parseInt(items[0].marker, 10);
  for (const item of items) list.append(el("li", {}, inline(item.text), item.kids.length ? listNode(item.kids) : null));
  return list;
}

// Reads the list starting at lines[i]; returns the node and the next unread line. Nesting comes
// from indentation; a blank line doesn't end a list that goes on afterwards.
function parseList(lines, i) {
  const top = { indent: -1, kids: [] };
  const stack = [top];
  let last = null;
  while (i < lines.length) {
    const m = LIST_ITEM.exec(lines[i]);
    if (m) {
      const item = { indent: m[1].replace(/\t/g, "    ").length, marker: m[2], text: m[3], kids: [] };
      while (stack.at(-1).indent >= item.indent) stack.pop();
      stack.at(-1).kids.push(item);
      stack.push(item);
      last = item;
      i++;
    } else if (!lines[i].trim()) {
      let j = i;
      while (j < lines.length && !lines[j].trim()) j++;
      if (j < lines.length && LIST_ITEM.test(lines[j])) i = j;
      else break;
    } else if (last && /^\s+\S/.test(lines[i])) {
      last.text += ` ${lines[i].trim()}`;
      i++;
    } else break;
  }
  return { node: listNode(top.kids), next: i };
}

function markdown(src) {
  const root = el("div");
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const para = [];
  const flush = () => {
    if (!para.length) return;
    root.append(el("p", {}, para.flatMap((l, k) => (k ? [el("br"), ...inline(l)] : inline(l)))));
    para.length = 0;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let m;
    if ((m = /^\s*(`{3,}|~{3,})/.exec(line))) {
      flush();
      const fence = m[1];
      const body = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${fence[0]}{${fence.length},}\\s*$`).test(lines[i])) body.push(lines[i++]);
      i++;
      root.append(el("pre", {}, el("code", { text: body.join("\n") })));
    } else if (!line.trim()) {
      flush();
      i++;
    } else if ((m = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line))) {
      flush();
      root.append(el("h4", {}, inline(m[1])));
      i++;
    } else if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      root.append(el("hr"));
      i++;
    } else if (/^\s{0,3}>/.test(line)) {
      flush();
      const body = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) body.push(lines[i++].replace(/^\s{0,3}>\s?/, ""));
      root.append(el("blockquote", {}, ...markdown(body.join("\n")).childNodes));
    } else if (LIST_ITEM.test(line)) {
      flush();
      const { node, next } = parseList(lines, i);
      root.append(node);
      i = next;
    } else if (line.includes("|") && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      flush();
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
      root.append(
        el(
          "table",
          {},
          el("thead", {}, el("tr", {}, head.map((c) => el("th", {}, inline(c))))),
          el("tbody", {}, rows.map((r) => el("tr", {}, head.map((_, k) => el("td", {}, inline(r[k] ?? "")))))),
        ),
      );
    } else {
      para.push(line.trim());
      i++;
    }
  }
  flush();
  return root;
}

// ---------------------------------------------------------------------------------------------
// Tool calls as steps: "mcp__firefox__navigate" reads as "Navigated" and its short summary.

const FIREFOX_VERBS = {
  tabs_context_mcp: ["Checking tabs", "Checked tabs"],
  tabs_create_mcp: ["Opening a tab", "Opened a tab"],
  tabs_close_mcp: ["Closing a tab", "Closed a tab"],
  navigate: ["Navigating", "Navigated"],
  read_page: ["Reading page", "Read page"],
  find: ["Searching page", "Searched page"],
  form_input: ["Filling in", "Filled in"],
  javascript_tool: ["Running script", "Ran script"],
  file_upload: ["Uploading file", "Uploaded file"],
  get_page_text: ["Reading text", "Read page text"],
};
const COMPUTER_VERBS = {
  click: ["Clicking", "Clicked"],
  left_click: ["Clicking", "Clicked"],
  right_click: ["Right-clicking", "Right-clicked"],
  double_click: ["Double-clicking", "Double-clicked"],
  triple_click: ["Triple-clicking", "Triple-clicked"],
  "right-click": ["Right-clicking", "Right-clicked"],
  "double-click": ["Double-clicking", "Double-clicked"],
  "triple-click": ["Triple-clicking", "Triple-clicked"],
  take: ["Taking", "Took"], // "Take a screenshot"
  press: ["Pressing", "Pressed"], // "Press keys"
  left_click_drag: ["Dragging", "Dragged"],
  screenshot: ["Taking screenshot", "Took screenshot"],
  type: ["Typing", "Typed"],
  key: ["Pressing", "Pressed"],
  scroll: ["Scrolling", "Scrolled"],
  scroll_to: ["Scrolling", "Scrolled"],
  hover: ["Hovering", "Hovered"],
  mouse_move: ["Hovering", "Hovered"],
  wait: ["Waiting", "Waited"],
  zoom: ["Zooming", "Zoomed"],
};
const BUILTIN_VERBS = {
  Read: ["Reading", "Read"],
  Glob: ["Searching files", "Searched files"],
  Grep: ["Searching files", "Searched files"],
  WebSearch: ["Searching the web", "Searched the web"],
  WebFetch: ["Fetching", "Fetched"],
  Skill: ["Loading skill", "Loaded skill"],
  TodoWrite: ["Planning", "Updated plan"],
  Bash: ["Running", "Ran"],
  Edit: ["Editing", "Edited"],
  Write: ["Writing", "Wrote"],
};

const humanize = (name) => {
  const h = name.replace(/^mcp__/, "").replace(/__/g, " ").replace(/_/g, " ").trim();
  return h ? h[0].toUpperCase() + h.slice(1) : "tool";
};
const isFirefoxTool = (name) => name.startsWith("mcp__firefox__");

function describeTool(name, summary = "") {
  const short = name.replace(/^mcp__firefox__/, "");
  let words = isFirefoxTool(name) ? FIREFOX_VERBS[short] : BUILTIN_VERBS[name];
  let detail = summary;
  if (short === "computer" && isFirefoxTool(name)) {
    const m = /^([a-z_-]+)\b\s*(.*)$/i.exec(summary);
    words = (m && COMPUTER_VERBS[m[1].toLowerCase()]) || ["Interacting", "Interacted"];
    if (m && COMPUTER_VERBS[m[1].toLowerCase()]) detail = m[2];
  }
  if (!words) words = [`Using ${humanize(name)}`, `Used ${humanize(name)}`];
  return { ing: words[0], ed: words[1], detail };
}

// ---------------------------------------------------------------------------------------------
// State

const S = {
  windowId: null,
  popout: false,
  chatId: null,
  engine: "claude",
  model: "",
  effort: "",
  status: "idle",
  title: "",
  turns: [],
  error: null,
  loading: false,
  paused: false,
  group: null, // {chatId, label, color, tabs}; no tabs until the chat is bound
  activeTab: null,
  caps: {}, // engine -> the last chat.capabilities reply
  history: null,
  historyQuery: "",
  prefs: {}, // remembered choices: {engine, claude: {model, effort}, codex: {...}}
  stopped: {}, // chat id -> true after the user stopped it, until it is sent to again
  attachments: [],
  unechoed: null, // what was just sent, kept until the host echoes it
  resumeNext: false,
  stick: true,
  shortcut: "",
  fresh: new Map(), // tab id -> when it joined the group
  ui: { menu: null, sheet: null, tray: false },
  windowTabs: [],
  pendingAdd: null, // a tab to add once the chat's group exists
};

let port = null;
let requestCount = 0;
let historyRequest = null;
let transcriptRequest = null;
let pendingTitle = null;
let loadTimer = 0;

const post = (cmd, extra = {}) => {
  try {
    port?.postMessage({ cmd, ...extra });
  } catch {
    // the background page is reloading; connect() reconnects
  }
};

const engine = () => ENGINES[S.engine] ?? ENGINES.claude;
const isRunning = () => S.status === "starting" || S.status === "running";
const isBound = () => !!S.group?.tabs?.length;
const lastTurn = () => S.turns.at(-1);
// The turn the agent is working on: the first that isn't over. A message sent meanwhile is a
// later turn in the queue and waits for its own events.
const activeTurn = () => S.turns.find((t) => !t.done) ?? null;
const pendingPermission = () => activeTurn()?.blocks.find((b) => b.type === "perm" && !b.decision);
const engineDown = (e = S.engine) => S.caps[e]?.available === false || S.error?.code === "not_found";

function newTurn() {
  return { user: null, blocks: [], steps: [], t0: null, t1: null, done: false, ok: true, durationMs: null, error: null, open: false, queued: false, el: null, dirty: true };
}

function openTurn(now) {
  const t = activeTurn();
  if (t) {
    if (t.queued) Object.assign(t, { queued: false, t0: now });
    return t;
  }
  const n = newTurn();
  n.t0 = now;
  S.turns.push(n);
  return n;
}

const resolvePerms = (t) => {
  for (const b of t.blocks) if (b.type === "perm" && !b.decision) b.decision = "resolved";
};

// A turn ends with its result, or when the process goes away without one. Whatever was still
// running is marked as halted.
function closeTurn(t, now, ev = null) {
  if (!t || t.done) return;
  t.done = true;
  t.t1 = now;
  t.dirty = true;
  resolvePerms(t);
  if (ev) {
    t.ok = ev.ok !== false;
    t.durationMs = ev.durationMs ?? null;
    t.error = t.ok ? null : ev.error || "The task didn't finish.";
  }
  for (const s of t.steps) if (!s.done) s.halted = true;
}

// Applies one chat event or transcript item. `replay` is set for history that isn't live, which
// has no timing of its own.
function applyEvent(ev, replay = false) {
  const now = replay ? null : Date.now();
  switch (ev.kind) {
    case "status": {
      S.status = ev.status;
      if (ev.status === "idle" || ev.status === "exited") for (const t of S.turns) closeTurn(t, now);
      break;
    }
    case "user": {
      // Sent while the agent is busy, a message queues behind the running turn; it must not end
      // that turn. Loaded history has no running turn to protect.
      if (replay) closeTurn(lastTurn(), now);
      const t = newTurn();
      t.user = { text: ev.text ?? "", attachments: ev.attachments ?? [] };
      t.queued = S.turns.some((x) => !x.done);
      t.t0 = t.queued ? null : now;
      S.turns.push(t);
      S.error = null;
      finishSend();
      break;
    }
    case "text_delta":
    case "text": {
      const t = openTurn(now);
      let b = t.blocks.findLast((x) => x.type === "text" && x.id === ev.messageId && !x.final);
      if (!b) {
        b = { type: "text", id: ev.messageId, text: "", final: false };
        t.blocks.push(b);
      }
      if (ev.kind === "text") {
        b.text = ev.text ?? "";
        b.final = true;
      } else b.text += ev.text ?? "";
      resolvePerms(t);
      t.dirty = true;
      break;
    }
    case "tool_start": {
      const t = openTurn(now);
      t.steps.push({ id: ev.toolUseId, name: ev.name ?? "", summary: ev.summary ?? "", tabId: Number.isInteger(ev.tabId) ? ev.tabId : null, done: false, ok: true, start: now, end: null, result: "" });
      if (!t.blocks.some((b) => b.type === "steps")) t.blocks.push({ type: "steps" });
      resolvePerms(t);
      t.dirty = true;
      break;
    }
    case "tool_end": {
      const t = openTurn(now);
      let s = t.steps.find((x) => x.id === ev.toolUseId);
      if (!s) {
        s = { id: ev.toolUseId, name: "", summary: "", start: null };
        t.steps.push(s);
        if (!t.blocks.some((b) => b.type === "steps")) t.blocks.push({ type: "steps" });
      }
      Object.assign(s, { done: true, ok: ev.ok !== false, end: now, result: ev.summary ?? "" });
      t.dirty = true;
      break;
    }
    case "permission": {
      const t = openTurn(now);
      t.blocks.push({ type: "perm", requestId: ev.requestId, tool: ev.tool ?? "", summary: ev.summary ?? "", always: ev.always !== false, decision: null });
      t.dirty = true;
      break;
    }
    case "result": {
      // A queued turn that hasn't started can't be what this is the result of.
      const t = activeTurn();
      if (t && !t.queued) closeTurn(t, now, ev);
      break;
    }
    case "error": {
      // Nothing more comes of this turn; a status event may follow, but not always.
      S.error = ev;
      closeTurn(activeTurn(), now);
      if (!activeTurn()) S.status = "idle";
      restoreUnechoed();
      break;
    }
    case "title":
      S.title = ev.title ?? "";
      break;
  }
}

// What the user sent shows up when the host echoes it. If an error comes first, nothing was
// sent, so the text goes back into the box.
function finishSend() {
  const u = S.unechoed;
  S.unechoed = null;
  for (const a of u?.attachments ?? []) if (a.url) URL.revokeObjectURL(a.url);
}

function restoreUnechoed() {
  const u = S.unechoed;
  if (!u) return;
  S.unechoed = null;
  if (!$("input").value) $("input").value = u.text;
  S.attachments = [...u.attachments, ...S.attachments];
  autosize();
  renderAtts();
  syncSend();
}

function resetChat() {
  for (const t of S.turns) t.el = null;
  S.turns = [];
  S.status = "idle";
  S.title = "";
  S.error = null;
  S.stick = true;
  S.ui.tray = false;
  S.fresh.clear();
}

function applyPrefs(name) {
  const p = S.prefs[name] ?? {};
  S.model = p.model ?? "";
  S.effort = p.effort ?? "";
}

// ---------------------------------------------------------------------------------------------
// Messages from the background page

function onMessage(m) {
  switch (m.type) {
    case "state": return onState(m.state ?? m);
    case "chat.event":
      if (m.chatId !== S.chatId) return;
      applyEvent(m.event);
      return render("head", "title", "body", "notices", "dock");
    case "chat.transcript": return onTranscript(m);
    case "chat.history":
      if (m.requestId !== historyRequest) return;
      S.history = m.chats ?? [];
      return fillHistory();
    case "chat.capabilities":
      if (!m.engine) return;
      S.caps[m.engine] = m;
      if (S.ui.menu) renderMenu();
      return render("body", "notices", "dock");
    case "group": return onGroup(m);
    case "hostUp":
      for (const name of Object.keys(ENGINES)) requestCaps(name);
      return;
    case "activeTab":
      S.activeTab = m.tab ?? null;
      return render("body", "dock");
    case "paused":
      S.paused = !!m.paused;
      for (const t of S.turns) t.dirty = true;
      return render("head", "title", "body", "notices");
  }
}

function onState(s) {
  const switched = s.chatId !== S.chatId;
  S.windowId = s.windowId ?? S.windowId;
  S.chatId = s.chatId;
  resetChat();
  transcriptRequest = null;
  for (const ev of s.events ?? []) applyEvent(ev.event ?? ev, true);
  if (!S.title && pendingTitle?.chatId === s.chatId) S.title = pendingTitle.title;
  S.group = s.group ?? null;
  S.activeTab = s.activeTab ?? null;
  S.paused = !!s.paused;
  if (s.engine) S.engine = s.engine;
  applyPrefs(S.engine);
  if (s.model != null) S.model = s.model;
  if (s.effort != null) S.effort = s.effort;
  // A chat opened from history is loaded by the host after this state; wait for its transcript.
  S.loading = S.loading && !S.turns.length;
  if (switched) {
    closeMenu(false);
    closeSheet();
  }
  render();
}

function onTranscript(m) {
  if (m.chatId !== S.chatId) return;
  if (m.requestId !== transcriptRequest) {
    // First chunk of a load.
    transcriptRequest = m.requestId;
    const title = S.title;
    resetChat();
    S.title = title || pendingTitle?.title || "";
  }
  for (const item of m.items ?? []) applyEvent(item, true);
  S.loading = !m.done;
  if (m.done) clearTimeout(loadTimer);
  render("head", "title", "body", "dock");
}

function onGroup(m) {
  if (m.chatId != null && m.chatId !== S.chatId) return;
  if (!m.tabs) return;
  const tabs = m.tabs;
  const before = S.group?.tabs ?? [];
  const joined = before.length ? tabs.filter((t) => !before.some((b) => b.tabId === t.tabId)) : [];
  S.group = { chatId: m.chatId, label: m.label, color: m.color, tabs };
  if (S.pendingAdd != null && tabs.length) {
    post("group.add", { tabId: S.pendingAdd });
    S.pendingAdd = null;
  }
  // Tabs the agent opens itself don't need announcing; the ones the user drags in do.
  if (isRunning()) joined.length = 0;
  for (const t of joined) S.fresh.set(t.tabId, Date.now());
  if (joined.length) {
    S.ui.tray = true;
    const name = joined.length === 1 ? siteName(joined[0].url) || joined[0].title || "A tab" : `${joined.length} tabs`;
    toast(`${name} joined the ${m.label ?? engine().short} group`);
    setTimeout(() => render("tray", "dock"), FRESH_MS + 100);
  }
  const t = activeTurn();
  if (t) t.dirty = true;
  render("body", "tray", "dock");
}

// ---------------------------------------------------------------------------------------------
// Rendering. Parts are drawn once per frame, so a burst of streamed text is one draw. A timer
// backs up the frame callback, which a panel in a background tab (a test's) never gets.

let queued = false;
const dirty = new Set();
function render(...parts) {
  if (!parts.length) parts = ["head", "title", "body", "notices", "tray", "dock"];
  for (const p of parts) dirty.add(p);
  if (queued) return;
  queued = true;
  requestAnimationFrame(flush);
  setTimeout(flush, 50);
}
function flush() {
  if (!queued) return;
  queued = false;
  const parts = [...dirty];
  dirty.clear();
  const draw = { head: renderHead, title: renderTitle, body: renderBody, notices: renderNotices, tray: renderTray, dock: renderDock };
  for (const p of ["head", "title", "body", "notices", "tray", "dock"]) if (parts.includes(p)) draw[p]();
}

function renderHead() {
  $("history-btn").classList.toggle("on", S.ui.sheet === "history");
  $("more-btn").classList.toggle("on", S.ui.menu?.id === "more" || S.ui.sheet === "agents");
}

function chatTitle() {
  if (S.title) return S.title;
  const first = S.turns.find((t) => t.user)?.user.text;
  return first ? shortText(first.replace(/\s+/g, " "), 60) : "New chat";
}

function renderTitle() {
  const chat = S.turns.length > 0 || S.loading;
  $("title").parentElement.classList.toggle("chat", chat);
  let live = null;
  if (S.paused) live = el("span", { class: "live p" }, icon("pause"), "Paused");
  else if (pendingPermission()) live = el("span", { class: "live p" }, "Needs approval");
  else if (isRunning()) live = el("span", { class: "live" }, icon("pointer"), "Working");
  const t = chat ? chatTitle() : "New chat";
  fill($("title"), el("span", { class: chat ? "t" : "t new", text: t, title: t }), live);
}

// ---- Conversation

function activeSite() {
  const g = S.group?.tabs;
  const tab = g?.find((t) => t.active) ?? g?.[0] ?? S.activeTab;
  return { tab, name: tab ? siteName(tab.url) : "" };
}

// Where a turn's agent is working: the tab of its latest step that names one, if that tab is in
// the group, otherwise the tab the user is viewing.
function workSite(t) {
  const id = [...t.steps].reverse().find((s) => s.tabId != null)?.tabId;
  const tab = id != null ? S.group?.tabs?.find((x) => x.tabId === id) : null;
  return tab ? { tab, name: siteName(tab.url) } : activeSite();
}

function fav(tab, cls = "") {
  const letter = (siteName(tab?.url) || tab?.title || "?")[0].toUpperCase();
  const n = el("span", { class: `fav ${cls}`, text: letter });
  if (tab?.favIconUrl && /^(https?:|data:image)/.test(tab.favIconUrl)) {
    const img = el("img", { src: tab.favIconUrl, alt: "" });
    img.addEventListener("error", () => img.remove());
    n.append(img);
  }
  return n;
}

function userBubble(u) {
  const files = u.attachments.map((a) => el("span", {}, icon(a.mime?.startsWith("image/") ? "file" : "clip"), el("b", { text: a.name ?? "file", title: a.name })));
  return el("div", { class: "um" }, u.text, files.length ? el("div", { class: "files" }, files) : null);
}

const PAUSED_RESULT = /^The user (stopped|paused) /;

function stepRow(t, s, current) {
  const words = describeTool(s.name, s.summary);
  // A call the user stopped or paused fails with a message saying so; it shows as stopped, not failed.
  const halted = s.halted || (current && S.paused) || (s.done && !s.ok && PAUSED_RESULT.test(s.result));
  let cls = "step";
  let mark = "check";
  let verb = words.ed;
  let detail = s.done && !s.ok && s.result ? s.result : words.detail;
  if (current && !halted) {
    cls += " cur";
    mark = "pointer";
    verb = words.ing;
  } else if (halted) {
    cls += " halt";
    mark = "pause";
    verb = "Stopped before";
    detail = `${words.ing.toLowerCase()}${words.detail ? ` ${words.detail}` : ""}`;
  } else if (!s.ok) {
    cls += " bad";
    mark = "x";
    verb = `${words.ed} failed`;
    if (!s.result) detail = words.detail;
  }
  const at = current && !halted && s.start && t.t0 ? "live" : s.end && t.t0 ? clock(s.end - t.t0) : "";
  const tm = el("span", { class: "tm", text: at === "live" ? clock(Date.now() - t.t0) : at });
  if (at === "live") tm.dataset.live = String(t.t0);
  return el("div", { class: cls, title: [words.detail, s.result].filter(Boolean).join(" — ") }, icon(mark), el("span", { class: "w", text: verb }), el("span", { class: "d", text: detail }), tm);
}

function stepsBlock(t) {
  const running = !t.done;
  const cur = running ? t.steps.findLast((s) => !s.done) : null;
  const usedFirefox = t.steps.some((s) => isFirefoxTool(s.name));
  const kids = [];
  if (t.done) {
    const dur = t.durationMs ?? (t.t1 && t.t0 ? t.t1 - t.t0 : null);
    const label = [usedFirefox ? "Used Firefox" : "Used tools", plural(t.steps.length, "step"), dur ? secs(dur) : null].filter(Boolean).join(" · ");
    kids.push(
      el(
        "button",
        {
          class: "used",
          "aria-expanded": String(t.open),
          onclick: () => {
            t.open = !t.open;
            t.dirty = true;
            render("body");
          },
        },
        icon("check"),
        el("span", { text: label }),
        icon("chevr"),
      ),
    );
    if (!t.open) return kids;
  }
  const site = workSite(t);
  const { name } = site;
  const head = el(
    "div",
    { class: "sh" },
    fav(site.tab),
    el("span", { class: "st", text: usedFirefox ? `${running ? "Using" : "Used"} Firefox${name ? ` in ${name}` : ""}` : running ? "Working" : "Steps" }),
    el("span", { class: "n", text: S.paused && running ? "Paused" : plural(t.steps.length, "step") }),
  );
  kids.push(el("div", { class: `steps${t.done ? " open" : ""}` }, head, el("div", { class: "list" }, t.steps.map((s) => stepRow(t, s, s === cur)))));
  return kids;
}

const prettyTool = (name) => (isFirefoxTool(name) ? `Firefox ${name.slice(13).replace(/_(mcp|tool)$/, "").replace(/_/g, " ")}` : humanize(name));

function permBlock(b) {
  if (b.decision === "resolved") return null;
  if (b.decision) {
    const allowed = b.decision !== "deny";
    return el("div", { class: "note" }, icon(allowed ? "check" : "x"), `${allowed ? (b.decision === "allow_always" ? "Always allowed" : "Allowed") : "Denied"}: ${prettyTool(b.tool)}`);
  }
  const answer = (decision) => () => {
    b.decision = decision;
    for (const t of S.turns) t.dirty = true;
    post("chat.permission", { chatId: S.chatId, requestId: b.requestId, decision });
    render("head", "title", "body");
  };
  return el(
    "div",
    { class: "perm", role: "group", "aria-label": "Permission request" },
    icon("lock"),
    el("b", { text: `${engine().short} wants to use ${prettyTool(b.tool)}` }),
    b.summary ? el("div", { class: "d" }, el("code", { text: b.summary })) : null,
    el(
      "div",
      { class: "bs" },
      el("button", { class: "b solid", text: "Allow once", onclick: answer("allow") }),
      b.always === false ? null : el("button", { class: "b", text: "Always allow in this chat", onclick: answer("allow_always") }),
      el("button", { class: "b", text: "Deny", onclick: answer("deny") }),
    ),
  );
}

function copyButton(text) {
  const btn = el("button", { class: "ib", "aria-label": "Copy", title: "Copy" }, icon("copy"));
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = el("textarea", { value: text });
      document.body.append(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    btn.replaceChildren(icon("check"));
    setTimeout(() => btn.replaceChildren(icon("copy")), 1500);
  });
  return btn;
}

function renderTurn(t) {
  const node = el("div", { class: "turn" });
  if (t.user) node.append(userBubble(t.user));
  for (const b of t.blocks) {
    if (b.type === "text") {
      if (b.text.trim()) node.append(el("div", { class: "am" }, ...markdown(b.text).childNodes));
    } else if (b.type === "steps") node.append(...stepsBlock(t));
    else if (b.type === "perm") node.append(permBlock(b) ?? "");
  }
  if (t.done && !t.ok && t.error) {
    const stopped = S.stopped[S.chatId] || /interrupt|abort|cancel/i.test(t.error);
    node.append(el("div", { class: "note" }, icon(stopped ? "pause" : "warn"), stopped ? "You stopped this task." : t.error));
  }
  const answer = t.blocks.filter((b) => b.type === "text" && b.text.trim()).map((b) => b.text.trim()).join("\n\n");
  if (t.done && answer) node.append(el("div", { class: "acts" }, copyButton(answer)));
  return node;
}

function renderBody() {
  const has = S.turns.length > 0 || S.loading;
  $("scroll").hidden = !has;
  $("empty").hidden = has;
  if (!has) return renderEmpty();
  const msgs = $("msgs");
  const kids = S.turns.map((t) => {
    if (!t.el || t.dirty) {
      const fresh = renderTurn(t);
      t.el?.replaceWith(fresh);
      t.el = fresh;
      t.dirty = false;
    }
    return t.el;
  });
  if (S.loading && !S.turns.length) kids.push(el("div", { class: "loading", text: "Loading…" }));
  if (kids.length !== msgs.children.length || kids.some((k, i) => k !== msgs.children[i])) msgs.replaceChildren(...kids);
  const live = activeTurn();
  if (live?.el) for (const list of live.el.querySelectorAll(".steps .list")) list.scrollTop = list.scrollHeight;
  if (S.stick) $("scroll").scrollTop = $("scroll").scrollHeight;
}

function renderEmpty() {
  const box = $("empty");
  const e = engine();
  if (engineDown()) {
    const other = ENGINES[S.engine === "claude" ? "codex" : "claude"];
    const otherKey = S.engine === "claude" ? "codex" : "claude";
    const caps = S.caps[S.engine];
    box.className = "empty offline";
    box.replaceChildren(
      el("div", { class: "glyph" }, icon("unplug")),
      el("h3", { text: caps?.hostDown ? "The bridge host isn't running" : `Can't reach ${e.name}` }),
      caps?.hostDown
        ? el("p", {}, "Firefox couldn't start it. Restart Firefox, or run ", el("code", { text: "scripts/install.sh" }), " again, then try again.")
        : caps?.error
          ? el("p", { text: `${caps.error} Then try again.` })
          : el("p", {}, `The bridge is running, but the host can't find ${e.bin}. Run `, el("code", { text: `scripts/install.sh ${e.flag}` }), ", then try again."),
      el(
        "div",
        { class: "bs" },
        el("button", { class: "b solid", text: "Try again", onclick: tryAgain }),
        S.caps[otherKey]?.available ? el("button", { class: "b", text: `Use ${other.name}`, onclick: () => setEngine(otherKey) }) : null,
      ),
    );
    return;
  }
  const { name } = activeSite();
  const suggestions = [
    ["file", "Summarize this page", "Summarize this page"],
    ["pointer", name ? `Pull out the key details from ${name}` : "Pull out the key details", name ? `Pull out the key details from ${name}` : "Pull out the key details from this page"],
    ["search", `Find something${name ? ` on ${name}` : ""}…`, "Find "],
  ];
  box.className = "empty";
  box.replaceChildren(
    el("div", { class: "glyph" }, icon("pointer")),
    el("h3", { text: `What should ${e.short} do${name ? ` in ${name}` : ""}?` }),
    el(
      "div",
      { class: "sugg" },
      suggestions.map(([ic, label, text]) =>
        el(
          "button",
          {
            onclick: () => {
              setInput(text);
              $("input").focus();
            },
          },
          icon(ic),
          el("span", { text: label }),
        ),
      ),
    ),
  );
}

// ---- Banners

// "3:00 PM", or "Oct 3, 1:16 PM" when it isn't today.
function limitReset(e) {
  const ms = e.resetsAt != null ? asMs(e.resetsAt) : NaN;
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

function banner(iconName, title, detail, ...buttons) {
  return el("div", { class: "banner", role: "status" }, icon(iconName), el("b", { text: title }), el("div", { class: "d" }, detail), buttons.filter(Boolean).length ? el("div", { class: "bs" }, buttons) : null);
}

const dismiss = () => el("button", { class: "b", text: "Dismiss", onclick: () => { S.error = null; render("notices", "body", "dock"); } });

function renderNotices() {
  const out = [];
  if (S.paused && (S.turns.length || isBound())) {
    const cur = activeTurn()?.steps.findLast((s) => !s.done);
    const words = cur && describeTool(cur.name, cur.summary);
    out.push(
      banner(
        "pause",
        `You stopped ${engine().short}`,
        cur ? `Paused before it ${words.ed.toLowerCase()}${words.detail ? ` ${words.detail}` : ""}. It won't touch the page until you resume.` : "It won't touch the page until you resume.",
        el("button", { class: "b solid", text: "Resume", onclick: () => post("resume") }),
        el("button", { class: "b", text: "End task", onclick: endTask }),
      ),
    );
  }
  const e = S.error;
  const other = S.engine === "claude" ? "codex" : "claude";
  if (e?.code === "limit") {
    const at = limitReset(e);
    out.push(
      banner(
        "warn",
        "You're out of messages for now",
        at ? `Your ${engine().short} plan resets ${at.includes(",") ? "on" : "at"} ${at}.` : e.message || `Your ${engine().short} plan has hit its limit.`,
        S.caps[other]?.available !== false ? el("button", { class: "b", text: `Use ${ENGINES[other].name}`, onclick: () => setEngine(other) }) : null,
        dismiss(),
      ),
    );
  } else if (e?.code === "auth") {
    out.push(banner("lock", `Sign in to ${engine().name}`, e.message || `Run ${engine().bin} in a terminal and sign in, then send again.`, dismiss()));
  } else if (e?.code === "spawn" || e?.code === "crashed") {
    out.push(banner("warn", e.code === "spawn" ? `Couldn't start ${engine().name}` : `${engine().name} stopped`, e.message || "", dismiss()));
  } else if (engineDown() && S.turns.length) {
    const hostDown = S.caps[S.engine]?.hostDown;
    out.push(banner("unplug", hostDown ? "The bridge host isn't running" : `Can't reach ${engine().name}`, hostDown ? "Restart Firefox, or run scripts/install.sh again." : S.caps[S.engine]?.error || `The host can't find ${engine().bin}. Run scripts/install.sh ${engine().flag}, then try again.`, el("button", { class: "b solid", text: "Try again", onclick: tryAgain })));
  }
  $("notices").replaceChildren(...out);
}

// ---- Tab tray

function renderTray() {
  const tray = $("tray");
  const tabs = S.group?.tabs ?? [];
  tray.hidden = !(S.ui.tray && tabs.length);
  if (tray.hidden) return;
  const now = Date.now();
  tray.style.setProperty("--grp", GROUP_COLORS[S.group.color] ?? "var(--p-ink3)");
  fill(
    tray,
    el("div", { class: "th" }, el("span", { class: "gdot" }), el("span", {}, el("b", { text: S.group.label ?? engine().short }), ` group · ${engine().short} can see these`)),
    tabs.map((t) => {
      const fresh = now - (S.fresh.get(t.tabId) ?? 0) < FRESH_MS;
      return el(
        "div",
        { class: `trow${fresh ? " fresh" : ""}`, title: t.url },
        fav(t),
        el("span", { class: "n", text: t.title || t.url || "Tab" }),
        t.active ? el("span", { class: "r", text: "Current" }) : fresh ? el("span", { class: "r", text: "Just added" }) : null,
        t.active ? null : el("button", { class: "x", "aria-label": "Remove from group", title: "Remove from group", onclick: () => post("group.remove", { tabId: t.tabId }) }, icon("x")),
      );
    }),
    el("button", { class: "trow add", onclick: (e) => openMenu("addtab", e.currentTarget) }, icon("plus"), el("span", { class: "n", text: "Add another tab" })),
  );
}

// ---- Composer

function contextTab() {
  const tabs = S.group?.tabs ?? [];
  if (tabs.length > 1) return { label: `${tabs.length} tabs`, tab: tabs.find((t) => t.active) ?? tabs[0], many: true };
  const tab = tabs[0] ?? S.activeTab;
  return { label: tab ? siteName(tab.url) || tab.title || "Tab" : "", tab, many: false };
}

// The model in use: the one picked, or the engine's default while none is.
function currentModel() {
  const models = S.caps[S.engine]?.models ?? [];
  return models.find((x) => x.id === S.model) ?? (S.model ? null : models.find((x) => x.default)) ?? null;
}

// "claude-haiku-4-5-20251001" reads as "Haiku 4.5" until the model list arrives.
function prettyModelId(id) {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)(?:-\d{8})?$/.exec(id);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : id;
}

function modelLabel() {
  return currentModel()?.label ?? (S.model ? prettyModelId(S.model) : "Default");
}

// A model's own efforts narrow the engine's (Haiku has none).
function effortsFor() {
  const c = S.caps[S.engine];
  return (currentModel()?.efforts ?? c?.efforts ?? []).map((e) => (typeof e === "string" ? e : e.id));
}
const effortLabel = (id) => EFFORT_LABELS[id] ?? (id ? id[0].toUpperCase() + id.slice(1) : "");

function placeholder() {
  if (S.paused) return `Tell ${engine().short} what to do instead…`;
  if (isRunning()) return "Add to the task…";
  if (!S.turns.length) {
    const { name } = activeSite();
    return `Ask ${engine().short} to do something${name ? ` in ${name}` : ""}…`;
  }
  return "Reply…";
}

function renderDock() {
  const down = engineDown() && !S.turns.length;
  $("composer").classList.toggle("dis", down);
  $("input").disabled = down;
  $("input").placeholder = placeholder();
  const c = contextTab();
  const ctx = $("ctx");
  ctx.hidden = !c.tab;
  ctx.className = `ctx${c.many ? " tabs" : ""}${[...S.fresh.values()].some((t) => Date.now() - t < FRESH_MS) ? " on" : ""}`;
  ctx.setAttribute("aria-expanded", String(S.ui.tray));
  ctx.replaceChildren(fav(c.tab), el("span", { text: c.label }));
  ctx.title = c.many ? "Tabs in the group" : c.tab?.title ?? "";
  const mb = $("model-btn");
  mb.className = `model${S.ui.menu?.id === "model" ? " on" : ""}`;
  const shownEffort = effortsFor().includes(S.effort) ? S.effort : "";
  fill(mb, el("span", { class: "m", text: modelLabel() }), shownEffort ? el("span", { class: "e", text: effortLabel(shownEffort) }) : null, icon("chevd"));
  $("plus-btn").classList.toggle("on", S.ui.menu?.id === "plus" || S.ui.menu?.id === "addtab");
  $("foot").textContent = down ? `Nothing runs until ${engine().name} is reachable.` : `Runs ${engine().name} on your plan. It can make mistakes.`;
  syncSend();
}

const hasDraft = () => !!$("input").value.trim() || S.attachments.length > 0;

function syncSend() {
  const btn = $("send");
  const stop = isRunning() && !hasDraft();
  const kind = stop ? "stop" : "send";
  if (btn.dataset.kind !== kind) {
    btn.dataset.kind = kind;
    btn.replaceChildren(icon(kind));
    btn.setAttribute("aria-label", stop ? "Stop" : "Send");
    btn.title = stop ? "Stop" : "Send";
  }
  const off = !stop && (!hasDraft() || engineDown() || !S.chatId);
  btn.className = `send${stop ? " stop" : ""}${off ? " off" : ""}`;
  btn.disabled = off;
}

function autosize() {
  const ta = $("input");
  ta.style.height = "auto";
  ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
}

function setInput(text) {
  const ta = $("input");
  ta.value = text;
  autosize();
  syncSend();
  ta.setSelectionRange(text.length, text.length);
}

function renderAtts() {
  const box = $("atts");
  box.hidden = !S.attachments.length;
  box.replaceChildren(
    ...S.attachments.map((a) =>
      el(
        "span",
        { class: "att", title: a.name },
        a.url ? el("img", { src: a.url, alt: "" }) : el("span", { class: "thumb" }, icon("file")),
        el("span", { class: "n", text: a.name }),
        el(
          "button",
          {
            class: "x",
            "aria-label": `Remove ${a.name}`,
            onclick: () => {
              if (a.url) URL.revokeObjectURL(a.url);
              S.attachments = S.attachments.filter((x) => x !== a);
              renderAtts();
              syncSend();
            },
          },
          icon("x"),
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------------------------
// Actions

function send() {
  const text = $("input").value.trim();
  if ((!text && !S.attachments.length) || engineDown() || !S.chatId) return;
  const attachments = S.attachments;
  // Typing after a pause is the way to carry on, and the new turn's Firefox calls would be refused if still paused.
  if (S.paused) {
    post("resume");
    S.paused = false;
  }
  post("chat.send", {
    chatId: S.chatId,
    engine: S.engine,
    model: S.model,
    effort: effortsFor().includes(S.effort) ? S.effort : "",
    text,
    attachments: attachments.map(({ name, mime, data }) => ({ name, mime, data })),
    resume: S.resumeNext,
  });
  S.resumeNext = false;
  S.unechoed = { text, attachments };
  S.attachments = [];
  if (S.stopped[S.chatId]) {
    delete S.stopped[S.chatId];
    saveStopped();
  }
  S.error = null;
  S.status = "starting";
  S.stick = true;
  S.ui.tray = false;
  $("input").value = "";
  autosize();
  renderAtts();
  render();
}

function stop() {
  post("chat.interrupt", { chatId: S.chatId });
  S.stopped[S.chatId] = true;
  saveStopped();
  S.status = "idle";
  render("head", "title", "body", "dock");
}

// Ends the paused task: stops the turn, then lets the session run again for the next message.
function endTask() {
  post("chat.interrupt", { chatId: S.chatId });
  post("resume");
  S.stopped[S.chatId] = true;
  saveStopped();
  S.status = "idle";
  render();
}

function newChat() {
  closeMenu(false);
  closeSheet();
  post("chat.new");
}

function setEngine(name) {
  if (!ENGINES[name] || name === S.engine) return;
  S.engine = name;
  applyPrefs(name);
  S.error = S.error?.code === "not_found" ? null : S.error;
  savePrefs();
  if (!S.caps[name]) requestCaps(name);
  render();
  if (S.ui.menu) renderMenu();
}

function tryAgain() {
  S.error = S.error?.code === "not_found" ? null : S.error;
  for (const name of Object.keys(ENGINES)) requestCaps(name);
  render();
}

function requestCaps(name) {
  post("chat.capabilities", { requestId: `caps${++requestCount}`, engine: name });
}

function openChat(c) {
  closeSheet();
  if (c.id === S.chatId) return;
  S.resumeNext = true;
  S.loading = true;
  pendingTitle = { chatId: c.id, title: c.title ?? "" };
  clearTimeout(loadTimer);
  loadTimer = setTimeout(() => {
    S.loading = false;
    render();
  }, 8000);
  post("chat.open", { chatId: c.id, source: c.source, path: c.path, engine: c.engine, model: c.model });
}

function openLink(url) {
  const opts = { url };
  if (S.windowId != null) opts.windowId = S.windowId;
  (browser.tabs?.create(opts) ?? Promise.reject()).catch(() => window.open(url, "_blank", "noopener"));
}

function toast(text) {
  const main = $("main");
  main.querySelector(".toast")?.remove();
  const node = el("div", { class: "toast", role: "status" }, icon("check"), el("span", { text }));
  main.append(node);
  setTimeout(() => node.remove(), TOAST_MS);
}

async function addFiles(files) {
  for (const { file, name } of files) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      toast(`${name} is over ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`);
      continue;
    }
    const data = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    }).catch(() => null);
    if (data == null) continue;
    const mime = file.type || "application/octet-stream";
    S.attachments.push({ name, mime, data, url: mime.startsWith("image/") ? URL.createObjectURL(file) : null });
  }
  renderAtts();
  syncSend();
}

// ---------------------------------------------------------------------------------------------
// Menus. One menu at a time, drawn over a scrim so a click anywhere else closes it.

function mi(iconName, label, { right, onclick, sel, disabled, sub, check } = {}) {
  return el(
    "button",
    { class: `mi${sel ? " sel" : ""}${sub ? " two" : ""}`, role: "menuitem", disabled, onclick },
    check ? icon("check", "ck") : iconName ? icon(iconName) : null,
    el("span", { class: "l" }, label, sub ? el("span", { class: "sub", text: sub }) : null),
    right ? el("span", { class: "r" }, right) : null,
  );
}

const sep = () => el("div", { class: "msep" });
const caption = (t) => el("div", { class: "mcap", text: t });
const backRow = (title) =>
  el("button", { class: "mi", onclick: () => { S.ui.menu.view = "root"; renderMenu(); } }, icon("back"), el("span", { class: "l", text: title }));
const note = (t) => el("div", { class: "empty-note", text: t });

function openMenu(id, anchor, extra = {}) {
  if (S.ui.menu?.id === id && !extra.keep) return closeMenu();
  S.ui.menu = { id, view: "root", anchor, ...extra };
  if (id === "plus" || id === "model") {
    if (!S.caps[S.engine]) requestCaps(S.engine);
    for (const name of Object.keys(ENGINES)) if (!S.caps[name]) requestCaps(name);
  }
  if (id === "addtab") loadWindowTabs();
  renderMenu();
  render("head", "dock");
}

function closeMenu(refocus = true) {
  const m = S.ui.menu;
  if (!m) return;
  S.ui.menu = null;
  $("layer-menu").replaceChildren();
  if (refocus && m.anchor?.isConnected) m.anchor.focus();
  render("head", "dock");
}

// Before the first message there is no group, and group.add would start one around the picked
// tab instead of the viewed one. So the viewed tab goes in first and the picked tab follows once
// the group exists.
function addTab(tabId) {
  if (isBound() || !S.activeTab) return post("group.add", { tabId });
  S.pendingAdd = tabId;
  post("group.add", { tabId: S.activeTab.tabId });
}

async function loadWindowTabs() {
  try {
    const tabs = await browser.tabs.query(S.windowId != null ? { windowId: S.windowId } : { currentWindow: true });
    // Before the first message the viewed tab is what the chat will bind to, so it isn't offered.
    const inGroup = new Set([...(S.group?.tabs ?? []).map((t) => t.tabId), ...(isBound() || !S.activeTab ? [] : [S.activeTab.tabId])]);
    S.windowTabs = tabs.filter((t) => !inGroup.has(t.id) && !(t.url ?? "").startsWith(location.origin));
  } catch {
    S.windowTabs = [];
  }
  if (S.ui.menu?.id === "addtab" || S.ui.menu?.view === "tabs") renderMenu();
}

function tabRows() {
  if (!S.windowTabs.length) return [note("No other tabs in this window.")];
  return S.windowTabs.map((t) =>
    el(
      "button",
      {
        class: "mi",
        title: t.url,
        onclick: () => {
          addTab(t.id);
          closeMenu();
        },
      },
      fav({ url: t.url, title: t.title, favIconUrl: t.favIconUrl }),
      el("span", { class: "l", text: t.title || t.url }),
      el("span", { class: "r t", text: hostOf(t.url) }),
    ),
  );
}

function plusMenu() {
  const c = S.caps[S.engine];
  const view = S.ui.menu.view;
  if (view === "skills") {
    const skills = c?.skills ?? [];
    return [
      backRow("Skills"),
      sep(),
      ...(skills.length
        ? skills.map((s) =>
            mi(null, s.name, {
              sub: s.description ? shortText(s.description, 90) : null,
              onclick: () => {
                closeMenu(false);
                insertAtCaret(`/${s.name} `);
              },
            }),
          )
        : [note(c ? "No skills found." : "Loading…")]),
    ];
  }
  if (view === "connectors") {
    const list = c?.connectors ?? [];
    return [
      backRow("Connectors"),
      sep(),
      ...(list.length
        ? list.map((x) => el("div", { class: "mi" }, el("span", { class: `dotc ${connected(x) ? "ok" : "bad"}` }), el("span", { class: "l", text: x.name }), el("span", { class: "r", text: x.status ?? "" })))
        : [note(c ? "No connectors." : "Loading…")]),
    ];
  }
  if (view === "plugins") {
    const list = c?.plugins ?? [];
    return [backRow("Plugins"), sep(), ...(list.length ? list.map((x) => el("div", { class: "mi" }, icon("plug"), el("span", { class: "l", text: x.name }))) : [note(c ? "No plugins." : "Loading…")])];
  }
  if (view === "tabs") return [backRow("Add another tab"), sep(), ...tabRows()];
  const bad = (c?.connectors ?? []).filter((x) => !connected(x)).length;
  const go = (v) => () => {
    S.ui.menu.view = v;
    if (v === "tabs") loadWindowTabs();
    renderMenu();
  };
  return [
    mi("clip", "Add files or photos", { onclick: () => { closeMenu(false); $("file").click(); } }),
    mi("tab", "Add another tab", { right: icon("chevr"), onclick: go("tabs") }),
    sep(),
    mi("skills", "Skills", { right: icon("chevr"), onclick: go("skills") }),
    mi("conn", "Connectors", { right: [bad ? el("span", { class: "warn-n", text: String(bad), style: "color:var(--warn)" }) : null, icon("chevr")], onclick: go("connectors") }),
    mi("plug", "Plugins", { right: icon("chevr"), onclick: go("plugins") }),
  ];
}

const connected = (x) => /^(connected|ok|ready|enabled|authenticated)$/i.test(x.status ?? "");

function modelMenu() {
  const c = S.caps[S.engine];
  const models = c?.models ?? [];
  const efforts = effortsFor();
  const rows = [caption("Runs with")];
  for (const [name, e] of Object.entries(ENGINES)) {
    const cap = S.caps[name];
    rows.push(
      mi(null, e.name, {
        check: true,
        sel: name === S.engine,
        disabled: cap?.available === false,
        right: cap?.available === false ? "Not found" : cap?.version ?? "",
        onclick: () => setEngine(name),
      }),
    );
  }
  rows.push(sep(), caption("Model"));
  // Without a model marked as the engine's default, "Default" leaves the choice to the engine.
  const list = models.some((m) => m.default || m.id === "") ? models : [{ id: "", label: "Default" }, ...models];
  const cur = currentModel();
  if (c || models.length) {
    for (const m of list) rows.push(mi(null, m.label ?? m.id, { check: true, sel: cur ? m === cur : m.id === S.model, onclick: () => { S.model = m.default ? "" : m.id; savePrefs(); closeMenu(); } }));
  } else rows.push(note("Loading…"));
  if (efforts.length) {
    rows.push(
      sep(),
      caption("Effort"),
      el(
        "div",
        { class: "eff", role: "group", "aria-label": "Effort" },
        efforts.map((id) =>
          el("button", {
            "aria-pressed": String(id === S.effort),
            text: effortLabel(id),
            title: id,
            onclick: () => {
              S.effort = id === S.effort ? "" : id;
              savePrefs();
              renderMenu();
              render("dock");
            },
          }),
        ),
      ),
    );
  }
  return rows;
}

function moreMenu() {
  return [
    mi("list", "Agents and activity", { onclick: () => { closeMenu(false); openSheet("agents"); } }),
    mi("stop", "Stop all agents", { right: S.shortcut, onclick: () => { closeMenu(false); post("stopAll"); } }),
    S.popout ? null : sep(),
    S.popout ? null : mi("popout", "Pop out", { onclick: () => { closeMenu(false); post("popout"); } }),
  ];
}

function renderMenu() {
  const m = S.ui.menu;
  const host = $("layer-menu");
  if (!m) return host.replaceChildren();
  const rows = m.id === "plus" ? plusMenu() : m.id === "model" ? modelMenu() : m.id === "addtab" ? [caption("Add another tab"), ...tabRows()] : moreMenu();
  const menu = el("div", { class: "menu", role: "menu", tabIndex: -1 }, rows);
  const scrim = el("div", { class: "scrim", onmousedown: () => closeMenu(false) });
  host.replaceChildren(scrim, menu);
  // Place it against its button, above for the composer's menus and below for the header's.
  const pr = $("app").getBoundingClientRect();
  const ar = (m.anchor.isConnected ? m.anchor : $("composer")).getBoundingClientRect();
  const width = Math.min(m.id === "more" ? 236 : 260, pr.width - 16);
  menu.style.width = `${width}px`;
  const above = m.id !== "more";
  if (above) {
    menu.style.bottom = `${pr.bottom - ar.top + 6}px`;
    menu.style.maxHeight = `${Math.max(120, ar.top - pr.top - 12)}px`;
  } else {
    menu.style.top = `${ar.bottom - pr.top + 4}px`;
    menu.style.maxHeight = `${Math.max(120, pr.bottom - ar.bottom - 12)}px`;
  }
  const toRight = m.id === "more" || m.id === "model";
  const left = toRight ? ar.right - pr.left - width : ar.left - pr.left;
  menu.style.left = `${Math.min(Math.max(8, left), pr.width - width - 8)}px`;
  menu.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [...menu.querySelectorAll("button:not(:disabled)")];
    const at = items.indexOf(document.activeElement); // -1 while the menu itself has focus
    const down = e.key === "ArrowDown";
    items[at < 0 ? (down ? 0 : items.length - 1) : (at + (down ? 1 : -1) + items.length) % items.length]?.focus();
  });
  menu.focus({ preventScroll: true });
}

function insertAtCaret(text) {
  const ta = $("input");
  const at = ta.selectionStart ?? ta.value.length;
  ta.setRangeText(text, at, ta.selectionEnd ?? at, "end");
  autosize();
  syncSend();
  ta.focus();
}

// ---------------------------------------------------------------------------------------------
// Sheets: recent tasks, and the popup's agents and activity view.

function closeSheet() {
  if (!S.ui.sheet) return;
  S.ui.sheet = null;
  $("layer-sheet").replaceChildren();
  render("head");
}

function openSheet(name) {
  closeMenu(false);
  if (S.ui.sheet === name) return closeSheet();
  S.ui.sheet = name;
  const host = $("layer-sheet");
  if (name === "agents") {
    const q = new URLSearchParams({ embedded: "1" });
    if (themeParam) q.set("theme", themeParam);
    host.replaceChildren(
      el(
        "div",
        { class: "sheet" },
        el("div", { class: "sh" }, el("button", { class: "ib", "aria-label": "Back", title: "Back", onclick: closeSheet }, icon("back")), "Agents and activity"),
        el("iframe", { class: "frame", src: `../popup/popup.html?${q}`, title: "Agents and activity" }),
      ),
    );
  } else {
    S.historyQuery = "";
    S.history = null;
    historyRequest = `hist${++requestCount}`;
    post("chat.history", { requestId: historyRequest });
    const input = el("input", { type: "text", placeholder: "Search tasks", "aria-label": "Search tasks", spellcheck: 0 });
    input.addEventListener("input", () => {
      S.historyQuery = input.value;
      fillHistory();
    });
    host.replaceChildren(el("div", { class: "sheet" }, el("div", { class: "srch" }, icon("search"), input), el("div", { class: "hscroll", id: "hscroll" })));
    fillHistory();
    input.focus();
  }
  render("head");
}

const shortCwd = (p) => (p ?? "").replace(/^\/(Users|home)\/[^/]+/, "~");

function historyRow(c) {
  const eng = ENGINES[c.engine]?.name ?? c.engine ?? "";
  const stopped = S.stopped[c.id];
  let meta;
  if (c.running) meta = "Working";
  else if (c.source === "terminal") meta = [eng, shortCwd(c.cwd)].filter(Boolean).join(" · ");
  else meta = stopped ? "Stopped by you" : [eng, c.model].filter(Boolean).join(" · ");
  return el(
    "button",
    { class: `hrow${c.id === S.chatId ? " sel" : ""}`, onclick: () => openChat(c), title: c.title },
    el("span", { class: `dotc${c.running ? " on" : stopped ? " ring" : ""}` }),
    el("span", { class: "t", text: c.title || "Untitled" }),
    el("span", { class: "when", text: c.running ? "Now" : whenLabel(c.updatedAt) }),
    el("span", { class: "m", text: meta }),
  );
}

function fillHistory() {
  const box = $("hscroll");
  if (!box || S.ui.sheet !== "history") return;
  if (S.history == null) return box.replaceChildren(el("div", { class: "hnote", text: "Loading…" }));
  const q = S.historyQuery.trim().toLowerCase();
  const chats = S.history.filter((c) => !q || `${c.title ?? ""} ${c.cwd ?? ""} ${ENGINES[c.engine]?.name ?? ""}`.toLowerCase().includes(q));
  const sections = [
    ["In Firefox", chats.filter((c) => c.source !== "terminal")],
    ["From your terminal", chats.filter((c) => c.source === "terminal")],
  ].filter(([, list]) => list.length);
  if (!sections.length) return box.replaceChildren(el("div", { class: "hnote", text: q ? "No matching tasks." : "No tasks yet." }));
  box.replaceChildren(el("div", { class: "hlist" }, sections.flatMap(([title, list]) => [el("div", { class: "hcap", text: title }), ...list.map(historyRow)])));
}

// ---------------------------------------------------------------------------------------------
// Storage

async function loadStored() {
  try {
    const got = await browser.storage.local.get(["chatPrefs", "stoppedChats"]);
    S.prefs = got.chatPrefs ?? {};
    S.stopped = got.stoppedChats ?? {};
    if (S.prefs.engine && ENGINES[S.prefs.engine]) S.engine = S.prefs.engine;
    applyPrefs(S.engine);
  } catch {
    // storage unavailable: defaults
  }
}

function savePrefs() {
  S.prefs = { ...S.prefs, engine: S.engine, [S.engine]: { model: S.model, effort: S.effort } };
  browser.storage.local.set({ chatPrefs: S.prefs }).catch(() => {});
}

function saveStopped() {
  const ids = Object.keys(S.stopped);
  for (const id of ids.slice(0, Math.max(0, ids.length - 200))) delete S.stopped[id];
  browser.storage.local.set({ stoppedChats: S.stopped }).catch(() => {});
}

// ---------------------------------------------------------------------------------------------
// Wiring

function wire() {
  hydrateIcons(document);
  const layer = $("layer");
  layer.append(el("div", { id: "layer-sheet" }), el("div", { id: "layer-menu" }));

  $("history-btn").addEventListener("click", () => openSheet("history"));
  $("new-btn").addEventListener("click", newChat);
  $("more-btn").addEventListener("click", (e) => openMenu("more", e.currentTarget));
  $("plus-btn").addEventListener("click", (e) => openMenu("plus", e.currentTarget));
  $("model-btn").addEventListener("click", (e) => openMenu("model", e.currentTarget));
  $("ctx").addEventListener("click", () => {
    if (!isBound()) return;
    S.ui.tray = !S.ui.tray;
    render("tray", "dock");
  });
  $("send").addEventListener("click", () => (isRunning() && !hasDraft() ? stop() : send()));

  const input = $("input");
  input.addEventListener("input", () => {
    autosize();
    syncSend();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    if (hasDraft()) send();
  });
  input.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (!files.length) return;
    e.preventDefault();
    let n = 0;
    addFiles(files.map((file) => ({ file, name: file.name && file.name !== "image.png" ? file.name : `pasted-${++n}.${(file.type.split("/")[1] || "bin").replace(/\+.*/, "")}` })));
  });
  $("file").addEventListener("change", (e) => {
    addFiles([...e.target.files].map((file) => ({ file, name: file.name })));
    e.target.value = "";
  });

  const app = $("app");
  const composer = $("composer");
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes("Files");
  app.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    composer.classList.add("drop");
  });
  app.addEventListener("dragleave", (e) => {
    if (!e.relatedTarget || !app.contains(e.relatedTarget)) composer.classList.remove("drop");
  });
  app.addEventListener("drop", (e) => {
    composer.classList.remove("drop");
    if (!hasFiles(e)) return;
    e.preventDefault();
    addFiles([...e.dataTransfer.files].map((file) => ({ file, name: file.name })));
  });

  // A click in the page or another window never reaches the scrim.
  window.addEventListener("blur", () => closeMenu(false));

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (S.ui.menu) closeMenu();
    else if (S.ui.sheet) closeSheet();
  });

  // Stay at the bottom while text streams in, unless the user scrolled up to read.
  const scroll = $("scroll");
  scroll.addEventListener("scroll", () => {
    S.stick = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 48;
  });
  new ResizeObserver(() => {
    if (S.stick) scroll.scrollTop = scroll.scrollHeight;
  }).observe($("msgs"));
  $("msgs").addEventListener("click", (e) => {
    const a = e.target.closest("a[href]");
    if (!a) return;
    e.preventDefault();
    openLink(a.href);
  });

  // The running step's clock.
  setInterval(() => {
    for (const n of document.querySelectorAll(".tm[data-live]")) n.textContent = clock(Date.now() - Number(n.dataset.live));
  }, 1000);
}

function connect() {
  port = browser.runtime.connect({ name: "sidebar" });
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => {
    port = null;
    setTimeout(connect, 1000);
  });
  const hello = { windowId: S.windowId ?? undefined, chatId: S.chatId ?? params.get("chat") ?? undefined };
  post("hello", hello);
}

// ---------------------------------------------------------------------------------------------
// Theme. The panel is the same surface as Firefox's sidebar, so it takes the theme's sidebar
// colors (or its toolbar's) when the theme sets them, and panel.css's neutrals otherwise.

function cssColor(c) {
  if (Array.isArray(c)) return `rgb(${c.slice(0, 3).join(", ")})`;
  return typeof c === "string" && c.trim() ? c : null;
}

function isDarkColor(c) {
  const probe = el("span", { style: `color: ${c}` });
  document.body.append(probe);
  const [r, g, b] = (getComputedStyle(probe).color.match(/[\d.]+/g) ?? []).map(Number);
  probe.remove();
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
}

async function applyTheme() {
  if (themeParam) return;
  let colors = null;
  try {
    colors = (await browser.theme.getCurrent(S.windowId ?? undefined))?.colors;
  } catch {
    // no theme API here (a test harness): keep the neutrals
  }
  const root = document.documentElement;
  const bg = cssColor(colors?.sidebar) ?? cssColor(colors?.toolbar);
  const ink = cssColor(colors?.sidebar_text) ?? cssColor(colors?.toolbar_text);
  if (!bg) {
    root.style.removeProperty("--p-bg");
    root.style.removeProperty("--p-ink");
    delete root.dataset.theme;
    return;
  }
  root.style.setProperty("--p-bg", bg);
  if (ink) root.style.setProperty("--p-ink", ink);
  else root.style.removeProperty("--p-ink");
  root.dataset.theme = isDarkColor(bg) ? "dark" : "light";
}

async function main() {
  wire();
  render();
  await loadStored();
  const q = Number(params.get("window"));
  if (Number.isInteger(q) && q > 0) S.windowId = q;
  try {
    const win = await browser.windows.getCurrent();
    S.popout = win.type === "popup";
    if (S.windowId == null) S.windowId = win.id;
  } catch {
    // no window API here (a test harness): the background picks the window
  }
  await applyTheme();
  browser.theme?.onUpdated.addListener(() => applyTheme());
  connect();
  $("input").focus();
  for (const name of Object.keys(ENGINES)) requestCaps(name);
  browser.commands
    ?.getAll()
    .then((cmds) => {
      const key = cmds.find((c) => c.name === "stop-agents")?.shortcut;
      S.shortcut = formatShortcut(key || "Alt+Shift+X");
      render("notices");
    })
    .catch(() => {});
  render();
}

main();
