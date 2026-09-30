"use strict";

// Receives tool calls from MCP clients (via the native host) and runs them against tabs in
// the calling session's tab group, named after its client ("Claude", "Codex", ...). Page work
// goes through browser.claudePage, the privileged experiment API in experiment/. The sidebar
// chat panel (docs/chat-panel.md) is served from the last section: it binds each chat to a tab
// group here, so the chat's own MCP calls (session = chat id) find it like any other session.

const NATIVE_HOST = "firefox_agent_bridge";
// Every agent group is grey, so the strip stays monochrome and the purple pointer in a group's
// label only shows while an agent is working.
const GROUP_COLOR = "grey";
const SCREENSHOT_MAX_EDGE = 1568;
const SCREENSHOT_MAX_PIXELS = 1_150_000;
const LOAD_TIMEOUT_MS = 30_000;
const SETTLE_TIMEOUT_MS = 5_000;

// session id -> { groupId, base, label, color }
const sessions = new Map();
// tab id -> CSS pixels per screenshot pixel, from the tab's last screenshot
const frameRatio = new Map();

let port = null;

function connect() {
  port = browser.runtime.connectNative(NATIVE_HOST);
  port.onMessage.addListener(onRequest);
  port.onDisconnect.addListener(() => {
    port = null;
    control.hostDisconnected();
    chatHostDisconnected();
    setTimeout(connect, 2000);
  });
  port.postMessage({ type: "hello", version: browser.runtime.getManifest().version });
  // Panels that asked for capabilities while the host was down have a stale "not connected".
  for (const panel of panels) post(panel, { type: "hostUp" });
}

// Pause state, blocked clients and the activity log live in control.js; every call passes
// through it before runTool.
const control = createControl({
  send: (msg) => port?.postMessage(msg),
  onChange: scheduleRefresh,
  onPauseChange: (session, isPaused) => deliver(session, { type: "paused", paused: isPaused }),
});

function onRequest(msg) {
  if (msg.type?.startsWith("chat.")) return chatFromHost(msg);
  if (msg.type === "client") return control.clientEvent(msg);
  if (msg.type !== "call") return;
  control.handleCall(msg, runTool, async (tabId) => (await browser.tabs.get(tabId)).url);
}

const text = (t) => ({ type: "text", text: t });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------
// Session tab groups

async function sessionGroupId(session) {
  const s = sessions.get(session);
  if (s?.groupId == null) return null;
  try {
    await browser.tabGroups.get(s.groupId);
    return s.groupId;
  } catch {
    s.groupId = null;
    return null;
  }
}

async function sessionTabs(session) {
  const groupId = await sessionGroupId(session);
  if (groupId == null) return [];
  return (await browser.tabs.query({})).filter((t) => t.groupId === groupId);
}

async function targetWindowId() {
  try {
    const win = await browser.windows.getLastFocused({ windowTypes: ["normal"] });
    if (win && !win.incognito) return win.id;
  } catch {
    // no normal window
  }
  const win = await browser.windows.create({ focused: false });
  return win.id;
}

// Tab group title for a client: a few known agents by name, otherwise the first word of the
// self-reported name.
function clientLabel(name) {
  const n = String(name ?? "").trim();
  const lower = n.toLowerCase();
  if (lower.includes("claude")) return "Claude";
  if (lower.includes("codex")) return "Codex";
  if (lower.includes("ffctl")) return "ffctl";
  const word = n.split(/[\s\-_./:@]+/).find(Boolean) ?? "";
  return (word.charAt(0).toUpperCase() + word.slice(1)).slice(0, 16) || "Agent";
}

// Every label this extension has titled a group with, kept across restarts so
// closeOrphanGroups can find its own groups whatever client made them. "Claude" covers groups
// from versions that always used it.
const LABELS_KEY = "groupLabels";
const knownLabels = new Set(["Claude"]);
const labelsLoaded = browser.storage.local
  .get(LABELS_KEY)
  .then((got) => {
    for (const l of got?.[LABELS_KEY] ?? []) knownLabels.add(l);
  })
  .catch(() => {});

async function rememberLabel(label) {
  await labelsLoaded;
  if (knownLabels.has(label)) return;
  knownLabels.add(label);
  await browser.storage.local.set({ [LABELS_KEY]: [...knownLabels] }).catch(() => {});
}

// Numbered only against groups that still exist, so a new chat after the last one's group was
// closed is "Claude" again, not "Claude 3".
async function newSessionEntry(client) {
  const base = clientLabel(client);
  const live = await sessionGroupIds();
  const taken = new Set([...sessions.values()].filter((s) => s.base === base && live.has(s.groupId)).map((s) => s.label));
  let label = base;
  for (let n = 2; taken.has(label); n++) label = `${base} ${n}`;
  return { base, label, color: GROUP_COLOR };
}

// Puts a tab in a new group for the session, titled and colored from its entry.
async function startGroup(session, client, tabId, windowId) {
  const groupId = await browser.tabs.group({ tabIds: [tabId], createProperties: { windowId } });
  const s = sessions.get(session) ?? (await newSessionEntry(client));
  s.groupId = groupId;
  sessions.set(session, s);
  await rememberLabel(s.base);
  await browser.tabGroups.update(groupId, { color: s.color });
  await paintGroup(groupId, s.label, sessionState(session));
  return s;
}

// ---------------------------------------------------------------------------------------------
// Tab group state. The state is drawn as an icon inside the group's label by the experiment
// (experiment/group-state.css). If it can't be (Firefox changed the label's DOM, or the
// experiment is missing), a glyph goes in front of the title instead.

const STATE_GLYPHS = { idle: "", working: "● ", needs: "◉ ", paused: "○ ", done: "✓ ", disconnected: "⊖ ", earlier: "◌ " };
const GLYPH_PREFIX = /^[●◉○✓⊖◌] /;
// Before icons, state was a suffix on the title.
const LEGACY_SUFFIX = / \((?:paused|earlier)\)$/;

// group id -> { state, label, title, drawn } as last written, so a group that hasn't changed costs nothing
const painted = new Map();
// Groups left by a previous run, group id -> the label they were titled with
const earlierGroups = new Map();

// What a session's group shows: no live client, stopped by the user, a chat waiting on a
// permission prompt, a call in the last few seconds, a finished chat turn nobody has looked at,
// or none of those. Chat sessions count as connected while the chat exists, even after its
// claude process idled out and its MCP client left.
function sessionState(session) {
  const info = control.sessionInfo(session);
  const chat = chats.get(session);
  if (!chat && !info.connected) return "disconnected";
  if (info.paused) return "paused";
  if (chat?.awaiting) return "needs";
  if (info.acting) return "working";
  if (chat?.finished) return "done";
  return "idle";
}

async function paintGroup(groupId, label, state) {
  const last = painted.get(groupId);
  // A group showing glyphs asks the experiment again each time, in case the label has turned up.
  if (last?.drawn && last.state === state && last.label === label) return;
  let drawn = false;
  try {
    drawn = await browser.claudePage.setGroupState(groupId, state);
  } catch {
    // the experiment is out of date or missing
  }
  const title = (drawn ? "" : STATE_GLYPHS[state]) + label;
  if (title !== last?.title) await browser.tabGroups.update(groupId, { title });
  painted.set(groupId, { state, label, title, drawn });
}

let syncing = false;
let syncAgain = false;

// Brings every group's icon up to date. Called from refresh(), which is already debounced.
async function syncGroups() {
  if (syncing) {
    syncAgain = true;
    return;
  }
  syncing = true;
  try {
    do {
      syncAgain = false;
      const seen = new Set();
      for (const [session, s] of sessions) {
        const groupId = await sessionGroupId(session);
        if (groupId == null) continue;
        seen.add(groupId);
        await paintGroup(groupId, s.label, sessionState(session)).catch(() => {});
      }
      for (const [groupId, label] of earlierGroups) {
        if (!(await browser.tabGroups.get(groupId).catch(() => null))) {
          earlierGroups.delete(groupId);
          continue;
        }
        seen.add(groupId);
        await paintGroup(groupId, label, "earlier").catch(() => {});
      }
      for (const id of painted.keys()) if (!seen.has(id)) painted.delete(id);
    } while (syncAgain);
  } finally {
    syncing = false;
  }
}

// A group moved to another window is a new element there, without its icon.
browser.tabGroups.onMoved?.addListener((group) => {
  painted.delete(group.id);
  scheduleRefresh();
});

async function createSessionTab(session, client, url = "about:blank", preferWindowId = null) {
  let groupId = await sessionGroupId(session);
  const windowId = groupId != null ? (await browser.tabGroups.get(groupId)).windowId : preferWindowId ?? (await targetWindowId());
  const tab = await browser.tabs.create({ url, active: false, windowId });
  if (groupId != null) await browser.tabs.group({ tabIds: [tab.id], groupId });
  else await startGroup(session, client, tab.id, windowId);
  try {
    await browser.tabs.update(tab.id, { autoDiscardable: false });
  } catch {
    // not supported on this version
  }
  await keepActive(tab.id);
  scheduleGroupPush(session);
  return tab;
}

// Background tabs are normally "hidden": no rendering, no IntersectionObserver callbacks, so
// lazy lists (LinkedIn's job list) and detail panes never fill in. Session tabs are kept
// active, as if selected, without being shown. Re-asserted on every call because switching
// away from a tab the user selected resets it.
async function keepActive(tabId) {
  try {
    await browser.claudePage.setActive(tabId, true);
  } catch {
    // tab closing or not ready; the next call retries
  }
}

async function requireTab(session, tabId) {
  if (typeof tabId !== "number") throw new Error("tabId is required. Call tabs_context_mcp to get this session's tab ids.");
  let tab;
  try {
    tab = await browser.tabs.get(tabId);
  } catch {
    throw new Error(`Tab ${tabId} no longer exists. Call tabs_context_mcp for current tab ids.`);
  }
  const groupId = await sessionGroupId(session);
  if (groupId == null || tab.groupId !== groupId) {
    const label = sessions.get(session)?.label;
    throw new Error(`Tab ${tabId} is not in this session's tab group${label ? ` ("${label}")` : ""}. Use tabs_create_mcp for a new tab, or drag the tab into the group.`);
  }
  await keepActive(tabId);
  return tab;
}

async function tabContext(session, createIfEmpty, client) {
  let tabs = await sessionTabs(session);
  if (!tabs.length && createIfEmpty) {
    await createSessionTab(session, client);
    tabs = await sessionTabs(session);
  }
  const s = sessions.get(session);
  return {
    availableTabs: tabs.map((t) => ({ tabId: t.id, title: t.title, url: t.url, ...(t.active ? { userIsViewing: true } : {}) })),
    tabGroup: tabs.length ? s?.label : null,
  };
}

// Waits for the load event, then for the page's text to stop growing (up to 5s), since
// single-page apps render most of their content after load.
async function waitForLoad(tabId) {
  const deadline = Date.now() + LOAD_TIMEOUT_MS;
  await sleep(250);
  while (Date.now() < deadline) {
    const tab = await browser.tabs.get(tabId);
    if (tab.status === "complete") break;
    await sleep(200);
  }
  const settleBy = Math.min(deadline, Date.now() + SETTLE_TIMEOUT_MS);
  let last = -1;
  let stable = 0;
  while (Date.now() < settleBy && stable < 2) {
    let size = -1;
    try {
      size = await browser.claudePage.call(tabId, "textSize", {});
    } catch {
      // mid-navigation; keep polling
    }
    stable = size >= 0 && size === last ? stable + 1 : 0;
    last = size;
    await sleep(400);
  }
  return browser.tabs.get(tabId);
}

// ---------------------------------------------------------------------------------------------
// Screenshots. The image is scaled so its long edge and pixel count stay inside what the model
// sees without resizing; coordinates the agent reads off it are mapped back to CSS pixels here.

function fitScale(width, height) {
  return Math.min(1, SCREENSHOT_MAX_EDGE / Math.max(width, height), Math.sqrt(SCREENSHOT_MAX_PIXELS / (width * height)));
}

function imageContent(dataUrl) {
  const [head, data] = dataUrl.split(",", 2);
  const mimeType = head.match(/^data:([^;]+)/)?.[1] ?? "image/jpeg";
  return { type: "image", data, mimeType };
}

// The on-page cursor is for the person watching; screenshots show the page without it.
async function withoutCursor(tabId, capture) {
  await browser.claudePage.call(tabId, "cursorVisible", { visible: false }).catch(() => {});
  try {
    return await capture();
  } finally {
    await browser.claudePage.call(tabId, "cursorVisible", { visible: true }).catch(() => {});
  }
}

async function screenshot(tabId, scale = 1) {
  const vp = await browser.claudePage.call(tabId, "viewport", {});
  const s = fitScale(vp.width, vp.height);
  frameRatio.set(tabId, 1 / s);
  const dataUrl = await withoutCursor(tabId, () => browser.tabs.captureTab(tabId, { format: "jpeg", quality: 80, scale: s * scale }));
  const w = Math.round(vp.width * s);
  const h = Math.round(vp.height * s);
  const note = scale < 1 ? ` Image returned at ${Math.round(scale * 100)}% size; coordinates still use the full ${w}x${h} frame.` : "";
  return [imageContent(dataUrl), text(`Screenshot of tab ${tabId} (${w}x${h}).${note}\n${vp.title}\n${vp.url}`)];
}

async function zoom(tabId, region, scale = 1) {
  if (!Array.isArray(region) || region.length !== 4) throw new Error("region must be [x0, y0, x1, y1].");
  const vp = await browser.claudePage.call(tabId, "viewport", {});
  const ratio = await ratioFor(tabId);
  const [x0, y0, x1, y1] = region.map((v) => v * ratio);
  const width = Math.max(1, x1 - x0);
  const height = Math.max(1, y1 - y0);
  const s = Math.min(vp.dpr * 2, SCREENSHOT_MAX_EDGE / Math.max(width, height)) * scale;
  const dataUrl = await withoutCursor(tabId, () =>
    browser.tabs.captureTab(tabId, {
      format: "jpeg",
      quality: 90,
      scale: s,
      rect: { x: x0 + vp.scrollX, y: y0 + vp.scrollY, width, height },
    }),
  );
  return [imageContent(dataUrl), text(`Zoomed region [${region.join(", ")}] of tab ${tabId}.`)];
}

// CSS pixels per screenshot pixel. Before the first screenshot, it is the ratio a screenshot
// would have, so coordinates from find match a screenshot taken later.
async function ratioFor(tabId) {
  if (!frameRatio.has(tabId)) {
    const vp = await browser.claudePage.call(tabId, "viewport", {});
    frameRatio.set(tabId, 1 / fitScale(vp.width, vp.height));
  }
  return frameRatio.get(tabId);
}

async function toCss(tabId, coordinate) {
  if (!coordinate) return {};
  const ratio = await ratioFor(tabId);
  return { x: coordinate[0] * ratio, y: coordinate[1] * ratio };
}

const frameScale = async (tabId) => 1 / (await ratioFor(tabId));

// ---------------------------------------------------------------------------------------------
// Tabs opened by a session tab (target=_blank, window.open), reported back after clicks

const openedBy = new Map(); // opener tab id -> [{ tabId, at }]

async function openedTabsNote(tabId, since) {
  await sleep(500);
  const fresh = (openedBy.get(tabId) ?? []).filter((o) => o.at >= since);
  if (!fresh.length) return "";
  const notes = [];
  for (const { tabId: id } of fresh) {
    // window.open starts at about:blank before the real URL commits
    for (let i = 0; i < 25; i++) {
      const t = await browser.tabs.get(id).catch(() => null);
      if (!t || t.url !== "about:blank") break;
      await sleep(200);
    }
    const tab = await waitForLoad(id).catch(() => null);
    if (tab) notes.push(`tab ${id}: ${tab.url} (${tab.title})`);
  }
  return notes.length ? `\nThe click opened a new tab in this session's group: ${notes.join("; ")}` : "";
}

// ---------------------------------------------------------------------------------------------
// Tools

const page = (tabId, op, args) => browser.claudePage.call(tabId, op, args);

async function computer(session, args) {
  const { action, tabId } = args;
  await requireTab(session, tabId);
  const needsTarget = () => {
    if (!args.coordinate && !args.ref) throw new Error(`${action} needs a coordinate or ref.`);
  };
  switch (action) {
    case "screenshot":
      return screenshot(tabId, args.scale ?? 1);
    case "zoom":
      return zoom(tabId, args.region, args.scale ?? 1);
    case "left_click":
    case "right_click":
    case "double_click":
    case "triple_click": {
      needsTarget();
      const clickCount = { double_click: 2, triple_click: 3 }[action] ?? 1;
      const button = action === "right_click" ? 2 : 0;
      const since = Date.now();
      const result = await page(tabId, "click", { ...(await toCss(tabId, args.coordinate)), ref: args.ref, button, clickCount, modifiers: args.modifiers });
      return [text(result + (await openedTabsNote(tabId, since)))];
    }
    case "hover":
      needsTarget();
      return [text(await page(tabId, "hover", { ...(await toCss(tabId, args.coordinate)), ref: args.ref }))];
    case "left_click_drag": {
      if (!args.start_coordinate || !args.coordinate) throw new Error("left_click_drag needs start_coordinate and coordinate.");
      const start = await toCss(tabId, args.start_coordinate);
      const end = await toCss(tabId, args.coordinate);
      return [text(await page(tabId, "drag", { x0: start.x, y0: start.y, x: end.x, y: end.y }))];
    }
    case "type":
      if (typeof args.text !== "string") throw new Error("type needs text.");
      return [text(await page(tabId, "type", { text: args.text }))];
    case "key":
      if (!args.text) throw new Error("key needs text, e.g. \"Enter\" or \"cmd+a\".");
      return [text(await page(tabId, "key", { keys: args.text, repeat: args.repeat ?? 1 }))];
    case "scroll":
      return [text(await page(tabId, "scroll", { ...(await toCss(tabId, args.coordinate)), direction: args.scroll_direction ?? "down", amount: args.scroll_amount ?? 3 }))];
    case "scroll_to":
      if (!args.ref) throw new Error("scroll_to needs a ref.");
      return [text(await page(tabId, "scrollTo", { ref: args.ref, frameScale: await frameScale(tabId) }))];
    case "wait": {
      const seconds = Math.min(Math.max(args.duration ?? 1, 0), 10);
      await sleep(seconds * 1000);
      return [text(`Waited ${seconds}s`)];
    }
    default:
      throw new Error(`Unknown computer action "${action}".`);
  }
}

async function runTool(session, tool, args, client) {
  switch (tool) {
    case "tabs_context_mcp":
      return [text(JSON.stringify(await tabContext(session, args.createIfEmpty, client), null, 2))];

    case "tabs_create_mcp": {
      const tab = await createSessionTab(session, client);
      return [text(`Created tab ${tab.id} in the ${sessions.get(session).label} tab group.\n` + JSON.stringify(await tabContext(session), null, 2))];
    }

    case "tabs_close_mcp": {
      await requireTab(session, args.tabId);
      await browser.tabs.remove(args.tabId);
      frameRatio.delete(args.tabId);
      return [text(`Closed tab ${args.tabId}.`)];
    }

    case "navigate": {
      let { tabId, url } = args;
      let context = null;
      if (tabId == null) {
        if (url === "back" || url === "forward") throw new Error("tabId is required for back/forward.");
        context = await tabContext(session, true, client);
        tabId = context.availableTabs[0].tabId;
      }
      await requireTab(session, tabId);
      if (url === "back") await browser.tabs.goBack(tabId);
      else if (url === "forward") await browser.tabs.goForward(tabId);
      else {
        if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = `https://${url}`;
        await browser.tabs.update(tabId, { url });
      }
      const tab = await waitForLoad(tabId);
      let out = `Tab ${tabId}: ${tab.url}\nTitle: ${tab.title}${tab.status !== "complete" ? "\n(still loading after 30s)" : ""}`;
      if (context) out += `\n\nThis session's tabs:\n${JSON.stringify(await tabContext(session), null, 2)}`;
      return [text(out)];
    }

    case "computer":
      return computer(session, args);

    case "read_page":
      await requireTab(session, args.tabId);
      return [text(await page(args.tabId, "readPage", { filter: args.filter, depth: args.depth, maxChars: args.max_chars, refId: args.ref_id, frameScale: await frameScale(args.tabId) }))];

    case "find":
      await requireTab(session, args.tabId);
      return [text(await page(args.tabId, "find", { query: args.query, frameScale: await frameScale(args.tabId) }))];

    case "get_page_text":
      await requireTab(session, args.tabId);
      return [text(await page(args.tabId, "text", {}))];

    case "form_input":
      await requireTab(session, args.tabId);
      return [text(await page(args.tabId, "formInput", { ref: args.ref, value: args.value }))];

    case "javascript_tool":
      await requireTab(session, args.tabId);
      return [text(await page(args.tabId, "evaluate", { code: args.text }))];

    case "file_upload":
      await requireTab(session, args.tabId);
      return [text(await browser.claudePage.upload(args.tabId, args.ref, args.paths ?? []))];

    default:
      throw new Error(`Unknown tool ${tool}`);
  }
}

// Pages in session tabs open new tabs (target=_blank links, window.open). Those join the
// opener's group, and if Firefox brought one to the front, focus goes back to the tab the user
// was on, so a run never takes over the window.
const userTabByWindow = new Map(); // window id -> the last tab the user had active

async function sessionGroupIds() {
  const ids = new Set();
  for (const session of sessions.keys()) {
    const id = await sessionGroupId(session);
    if (id != null) ids.add(id);
  }
  return ids;
}

async function isSessionTab(tab, groups) {
  if (groups.has(tab.groupId)) return true;
  if (tab.openerTabId == null) return false;
  const opener = await browser.tabs.get(tab.openerTabId).catch(() => null);
  return !!opener && groups.has(opener.groupId);
}

// Tabs a session page just opened; if Firefox activates one of these, focus is handed back.
const justOpened = new Set();

async function restoreUserTab(windowId, tabId) {
  const back = userTabByWindow.get(windowId);
  if (back == null || back === tabId) return;
  await browser.tabs.update(back, { active: true }).catch(() => {});
}

// Looking at a session tab doesn't pause anything; only Stop does.
browser.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  if (justOpened.has(tabId)) return restoreUserTab(windowId, tabId);
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (!tab) return;
  // Activated before onCreated ran for it: same case as above. Ungrouped tabs have groupId -1.
  if (!(tab.groupId >= 0) && recentlyOpened(tab) && (await isSessionTab(tab, await sessionGroupIds()))) return restoreUserTab(windowId, tabId);
  // Any other activation is the user's, including a chat's own tab: they are looking at it, so
  // it is the tab to go back to.
  userTabByWindow.set(windowId, tabId);
});

// Tabs a session page opened a moment ago get activated by Firefox, not by the user.
const createdAt = new Map(); // tab id -> time onCreated saw it
function recentlyOpened(tab) {
  return tab.openerTabId != null && Date.now() - (createdAt.get(tab.id) ?? 0) < 3000;
}

browser.tabs.onCreated.addListener(async (tab) => {
  if (tab.openerTabId == null) return;
  createdAt.set(tab.id, Date.now());
  setTimeout(() => createdAt.delete(tab.id), 3000);
  const opener = await browser.tabs.get(tab.openerTabId).catch(() => null);
  if (!opener || !(await sessionGroupIds()).has(opener.groupId)) return;
  const list = openedBy.get(tab.openerTabId) ?? [];
  list.push({ tabId: tab.id, at: Date.now() });
  openedBy.set(tab.openerTabId, list.slice(-10));
  justOpened.add(tab.id);
  setTimeout(() => justOpened.delete(tab.id), 3000);
  await browser.tabs.group({ tabIds: [tab.id], groupId: opener.groupId }).catch(() => {});
  await keepActive(tab.id);
  const current = await browser.tabs.get(tab.id).catch(() => null);
  if (current?.active) await restoreUserTab(tab.windowId, tab.id);
});

// Sessions don't survive a browser restart, so session tab groups brought back by session
// restore belong to no one. They often hold work left for the user (a staged form), so they
// are kept, shown as "earlier" and greyed out; the user closes them when done.
// A group is ours if its title is a known label, optionally numbered, with a state glyph in
// front or a " (paused)" / " (earlier)" suffix (what earlier versions wrote).
function orphanBase(title) {
  const base = String(title ?? "")
    .replace(GLYPH_PREFIX, "")
    .replace(LEGACY_SUFFIX, "")
    .replace(/ \d+$/, "");
  return knownLabels.has(base) ? base : null;
}

async function closeOrphanGroups() {
  await labelsLoaded;
  const live = await sessionGroupIds();
  for (const g of await browser.tabGroups.query({})) {
    const base = orphanBase(g.title);
    if (!base || live.has(g.id)) continue;
    earlierGroups.set(g.id, base);
    await browser.tabGroups.update(g.id, { color: GROUP_COLOR });
    await paintGroup(g.id, base, "earlier");
  }
}

// Per-client consent was replaced by Disconnect/Unblock; drop what older versions stored.
browser.storage.local.remove("allowedClients").catch(() => {});

closeOrphanGroups().catch(() => {});

// ---------------------------------------------------------------------------------------------
// Toolbar button, Stop shortcut and popup

const popupPorts = new Set();
let refreshQueued = false;
let statusTimer = null;
let shownIcon = null;
let shownSideIcon = null;
let shownTitle = null;
const darkScheme = matchMedia("(prefers-color-scheme: dark)");
darkScheme.addEventListener("change", scheduleRefresh);

function scheduleRefresh() {
  if (refreshQueued) return;
  refreshQueued = true;
  setTimeout(refresh, 50);
}

function sessionLabel(id) {
  return sessions.get(id)?.label ?? `session ${String(id).slice(0, 8)}`;
}

function popupState() {
  const state = control.snapshot();
  for (const s of state.sessions) s.label = sessionLabel(s.id);
  for (const e of state.log) e.sessionLabel = sessionLabel(e.session);
  return state;
}

function refresh() {
  refreshQueued = false;
  syncGroups().catch(() => {});
  const status = control.status();
  const titles = {
    acting: "Firefox Agent Bridge: an agent is acting in Firefox",
    paused: "Firefox Agent Bridge: paused",
    idle: "Firefox Agent Bridge",
  };
  // The state is drawn into the icon: an outline pointer when idle, the agent cursor's purple
  // while acting, and pause bars when stopped. Extension icons can't use context-fill, so each
  // comes in a light and a dark variant, picked by the color scheme (which follows the toolbar).
  const icon = `icons/toolbar-${status}-${darkScheme.matches ? "dark" : "light"}.svg`;
  if (icon !== shownIcon) {
    shownIcon = icon;
    browser.browserAction.setIcon({ path: icon });
  }
  // The sidebar's launcher icon is the same pointer as an outline, solid purple only while an
  // agent is acting. sidebar_action has no theme_icons, so it too is picked by color scheme.
  const sideIcon = `icons/sidebar-${status === "acting" ? "working" : "idle"}-${darkScheme.matches ? "dark" : "light"}.svg`;
  if (sideIcon !== shownSideIcon) {
    shownSideIcon = sideIcon;
    browser.sidebarAction.setIcon({ path: sideIcon }).catch(() => {});
  }
  // A permission request nobody can see (the sidebar is closed, or shows another chat) would
  // otherwise stall the task silently, so the button says so.
  const approval = unseenApproval();
  const title = approval ? "Firefox Agent Bridge: the agent is waiting for your approval" : titles[status];
  if (title !== shownTitle) {
    shownTitle = title;
    browser.browserAction.setTitle({ title });
    browser.browserAction.setBadgeText({ text: approval ? "!" : "" });
    if (approval) browser.browserAction.setBadgeBackgroundColor?.({ color: "#e5484d" });
  }
  // "Acting" lasts a few seconds past the last call; look again once it would lapse.
  clearTimeout(statusTimer);
  if (status === "acting") statusTimer = setTimeout(scheduleRefresh, control.RECENT_MS);
  if (popupPorts.size) {
    const state = popupState();
    for (const p of popupPorts) p.postMessage({ type: "state", state });
  }
}

const popupCommands = {
  stop: () => stopAllAgents(),
  resumeAll: () => control.resumeAll(),
  resume: (m) => control.resume(m.session),
  disconnect: (m) => control.disconnect(m.clientId),
  unblock: (m) => control.unblock(m.name),
  clearLog: () => control.clearLog(),
};

browser.runtime.onConnect.addListener((p) => {
  if (p.name !== "popup") return;
  popupPorts.add(p);
  p.onDisconnect.addListener(() => popupPorts.delete(p));
  p.onMessage.addListener((m) => popupCommands[m?.cmd]?.(m));
  p.postMessage({ type: "state", state: popupState() });
});

browser.commands.onCommand.addListener((name) => {
  if (name === "stop-agents") stopAllAgents();
});

// ---------------------------------------------------------------------------------------------
// Chat panel. Panels connect on the "sidebar" port; see docs/chat-panel.md for the protocol.
// Panel messages carry `cmd`, messages to the panel carry `type`.

const EVENT_CAP = 1000;
const ENGINE_NAMES = { claude: "Claude", codex: "Codex" };
const HOST_DOWN = "The native host is not connected.";

// chat id -> { id, windowId, events, engine, model, effort, status, awaiting, finished, resume, queue, tabIds, groupTimer }
const chats = new Map();
const validChatId = (id) => typeof id === "string" && /^[\w-]{1,64}$/.test(id) && !["__proto__", "constructor", "prototype"].includes(id);
const windowChat = new Map(); // window id -> the chat its panel last showed
const panels = new Set(); // { port, windowId, chatId, ready }
const asked = new Map(); // request id we sent the host -> { panel, requestId, type, engine, chatId }
let requestCount = 0;

function chatFor(id, windowId = null) {
  let chat = chats.get(id);
  if (!chat) {
    chat = { id, windowId, events: [], engine: null, model: null, effort: null, status: "idle", awaiting: false, finished: false, resume: false, queue: Promise.resolve(), tabIds: new Set(), groupTimer: null };
    chats.set(id, chat);
  }
  return chat;
}

const post = (panel, msg) => {
  try {
    panel.port.postMessage(msg);
  } catch {
    // panel went away; its disconnect handler cleans up
  }
};

// Sends to every panel showing the chat. Chat events wait for a panel's state message so they
// aren't shown twice (once in its replay, once live).
function deliver(chatId, msg) {
  const live = msg.type === "chat.event" || msg.type === "chat.transcript";
  for (const panel of panels) if (panel.chatId === chatId && (panel.ready || !live)) post(panel, msg);
}

// Keeps what a reopened panel needs to redraw the chat. Streamed text is stored as one delta per
// message, and dropped once the finished text block arrives.
function record(chat, ev) {
  const evs = chat.events;
  const last = evs.at(-1);
  if (ev.kind === "text_delta" && last?.kind === "text_delta" && last.messageId === ev.messageId) {
    last.text += ev.text;
    return;
  }
  if (ev.kind === "text") while (evs.at(-1)?.kind === "text_delta" && evs.at(-1).messageId === ev.messageId) evs.pop();
  if (ev.kind === "status") chat.status = ev.status;
  trackApproval(chat, ev);
  evs.push({ ...ev });
  if (evs.length > EVENT_CAP) evs.splice(0, evs.length - EVENT_CAP);
}

// Whether the chat is stopped on a permission request. Anything the agent does after one means
// it was answered (or the turn is over), as the panel also assumes.
function trackApproval(chat, ev) {
  const was = chat.awaiting;
  if (ev.kind === "permission") chat.awaiting = true;
  else if (["tool_start", "tool_end", "text", "result", "error"].includes(ev.kind) || (ev.kind === "status" && (ev.status === "idle" || ev.status === "exited"))) chat.awaiting = false;
  if (chat.awaiting !== was) scheduleRefresh();
}

const chatShown = (chat) => [...panels].some((p) => p.chatId === chat.id);

// A chat waiting for approval that no open panel is showing.
function unseenApproval() {
  for (const chat of chats.values()) if (chat.awaiting && !chatShown(chat)) return true;
  return false;
}

// Whether a turn finished that the user hasn't looked at: no panel showed the chat when it
// ended, and since then they haven't shown it or activated a tab in its group (both clear
// it), nor started another turn. A turn the user interrupted isn't news. Live events only:
// transcripts loaded from history replay old results.
function trackFinished(chat, ev) {
  const was = chat.finished;
  if (ev.kind === "result") chat.finished = !chatShown(chat) && !(ev.ok === false && ev.error === "Interrupted");
  else if (ev.kind === "status" && (ev.status === "starting" || ev.status === "running")) chat.finished = false;
  if (chat.finished !== was) scheduleRefresh();
}

function markSeen(chat) {
  if (!chat.finished) return;
  chat.finished = false;
  scheduleRefresh();
}

// Stop all agents also ends the turns the panel is running: pausing Firefox alone would leave
// the agent free to run shell commands or fetch pages until it finished.
function stopAllAgents() {
  control.stopAll();
  for (const chat of chats.values()) if (chat.status === "starting" || chat.status === "running") port?.postMessage({ type: "chat.interrupt", chatId: chat.id });
}

function emit(chat, event) {
  record(chat, event);
  deliver(chat.id, { type: "chat.event", chatId: chat.id, event });
}

// The host is gone: what it was running died with it, and pending requests get empty answers.
function chatHostDisconnected() {
  for (const chat of chats.values()) {
    if (chat.status !== "starting" && chat.status !== "running") continue;
    emit(chat, { kind: "error", code: "crashed", message: "The native host disconnected." });
    emit(chat, { kind: "status", status: "exited" });
  }
  for (const [rid, a] of asked) answer(rid, offlineReply({ ...a, requestId: rid }));
}

function offlineReply({ type, requestId, engine, chatId }) {
  if (type === "chat.history") return { type, requestId, chats: [] };
  if (type === "chat.load") return { type: "chat.transcript", requestId, chatId, items: [], done: true };
  return { type, requestId, engine, available: false, hostDown: true, version: null, error: HOST_DOWN, skills: [], plugins: [], connectors: [], models: [], efforts: [] };
}

// Sends the host a request whose reply goes back to one panel, under the panel's own request id.
function ask(panel, msg) {
  const rid = `b${++requestCount}`;
  const a = { panel, requestId: msg.requestId, type: msg.type, engine: msg.engine, chatId: msg.chatId };
  asked.set(rid, a);
  if (port) port.postMessage({ ...msg, requestId: rid });
  else answer(rid, offlineReply({ ...a, requestId: rid }));
}

// Like ask, for background's own use: resolves with the host's reply, or an empty one after a few seconds.
function askHost(msg) {
  if (!port) return Promise.resolve(offlineReply(msg));
  return new Promise((resolve) => {
    const rid = `b${++requestCount}`;
    asked.set(rid, { reply: resolve });
    port.postMessage({ ...msg, requestId: rid });
    setTimeout(() => asked.delete(rid) && resolve(offlineReply(msg)), 5000);
  });
}

function answer(rid, msg) {
  const a = asked.get(rid);
  if (!a) return;
  if (a.reply) {
    asked.delete(rid);
    return a.reply(msg);
  }
  const { chatId } = msg;
  if (msg.type !== "chat.transcript" || msg.done) asked.delete(rid);
  if (msg.type === "chat.transcript") {
    const chat = chats.get(chatId ?? a.chatId);
    for (const item of msg.items ?? []) if (chat) record(chat, item);
  }
  if (panels.has(a.panel)) post(a.panel, { ...msg, requestId: a.requestId ?? msg.requestId });
}

function chatFromHost(msg) {
  if (msg.type === "chat.event") {
    const chat = chatFor(msg.chatId);
    record(chat, msg.event);
    trackFinished(chat, msg.event);
    if (chat.finished && chat.omni && msg.event.kind === "result") notifyFinished(chat, msg.event);
    deliver(chat.id, msg);
  } else if (msg.requestId != null) {
    answer(msg.requestId, msg);
  }
}

// ---- Binding a chat to a tab group

const byIndex = (a, b) => a.index - b.index;
const tabInfo = (t) => ({ tabId: t.id, title: t.title, url: t.url, favIconUrl: t.favIconUrl, active: !!t.active });

async function groupTabs(chat) {
  const tabs = (await sessionTabs(chat.id)).sort(byIndex);
  chat.tabIds = new Set(tabs.map((t) => t.id));
  return tabs;
}

// Not-yet-bound chats have an empty group, so panels can treat every state the same way.
async function groupInfo(chat) {
  const tabs = await groupTabs(chat);
  const s = sessions.get(chat.id);
  return { chatId: chat.id, label: s?.label ?? null, color: s?.color ?? null, tabs: tabs.map(tabInfo) };
}

async function activeTabInfo(windowId) {
  const [tab] = await browser.tabs.query({ active: true, windowId }).catch(() => []);
  return tab ? tabInfo(tab) : null;
}

// The tab the user is viewing joins a new group for the chat, in place: it is the user's own
// tab, so it is not touched beyond joining (no extra blank tab, no discard pinning). If that tab
// can't be taken (pinned, or in another session's group), the chat starts with a blank tab like
// an MCP client would.
async function bindChat(chat) {
  if ((await sessionGroupId(chat.id)) != null) return;
  const client = ENGINE_NAMES[chat.engine] ?? "Claude";
  const [tab] = chat.windowId != null ? await browser.tabs.query({ active: true, windowId: chat.windowId }) : [];
  if (tab && !(await sessionGroupIds()).has(tab.groupId)) {
    try {
      await startGroup(chat.id, client, tab.id, tab.windowId);
      return;
    } catch {
      // fall back below
    }
  }
  await createSessionTab(chat.id, client, "about:blank", chat.windowId);
}

function scheduleGroupPush(chatId) {
  const chat = chats.get(chatId);
  if (!chat || chat.groupTimer) return;
  chat.groupTimer = setTimeout(async () => {
    chat.groupTimer = null;
    if (![...panels].some((p) => p.chatId === chat.id)) return;
    deliver(chat.id, { type: "group", ...(await groupInfo(chat).catch(() => null)) });
  }, 100);
}

// A tab changed: refresh the chats whose group holds it, or now does.
function tabTouched(tabId, groupId) {
  for (const chat of chats.values()) {
    if (chat.tabIds.has(tabId) || (groupId >= 0 && groupId === sessions.get(chat.id)?.groupId)) scheduleGroupPush(chat.id);
  }
}

async function pushActiveTab(windowId) {
  const targets = [...panels].filter((p) => p.windowId === windowId);
  if (!targets.length) return;
  const tab = await activeTabInfo(windowId);
  for (const panel of targets) post(panel, { type: "activeTab", tab });
}

browser.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (!("groupId" in change || "title" in change || "url" in change || "favIconUrl" in change)) return;
  tabTouched(tabId, tab.groupId);
  if (tab.active && !("groupId" in change)) pushActiveTab(tab.windowId);
});
browser.tabs.onRemoved.addListener((tabId) => tabTouched(tabId, -1));
browser.tabs.onAttached.addListener((tabId) => tabTouched(tabId, -1));
browser.tabs.onDetached.addListener((tabId) => tabTouched(tabId, -1));
browser.tabs.onActivated.addListener(({ windowId }) => pushActiveTab(windowId));

// The user switching to a tab in a chat's group counts as looking at what it did. Tabs Firefox
// activated for a page's new tab don't.
browser.tabs.onActivated.addListener(async ({ tabId }) => {
  if (justOpened.has(tabId)) return;
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (!(tab?.groupId >= 0)) return;
  for (const chat of chats.values()) if (sessions.get(chat.id)?.groupId === tab.groupId) markSeen(chat);
});

// ---- Panels

async function sendState(panel) {
  panel.ready = false;
  const chat = chats.get(panel.chatId);
  const [group, activeTab] = await Promise.all([groupInfo(chat), activeTabInfo(panel.windowId)]);
  // A switch while we looked things up sends its own state.
  if (!panels.has(panel) || panel.chatId !== chat.id) return;
  post(panel, {
    type: "state",
    windowId: panel.windowId,
    chatId: chat.id,
    events: chat.events.slice(),
    group,
    activeTab,
    paused: control.isPaused(chat.id),
    engine: chat.engine,
    model: chat.model,
    effort: chat.effort,
  });
  panel.ready = true;
}

function showChat(panel, chat) {
  panel.chatId = chat.id;
  windowChat.set(panel.windowId, chat.id);
  markSeen(chat);
  scheduleRefresh();
  return sendState(panel);
}

// A new chat starts from the previous chat's engine, model and effort.
function newChat(windowId, from) {
  const chat = chatFor(crypto.randomUUID(), windowId);
  if (from) Object.assign(chat, { engine: from.engine, model: from.model, effort: from.effort });
  return chat;
}

async function lastNormalWindowId() {
  try {
    return (await browser.windows.getLastFocused({ windowTypes: ["normal"] })).id;
  } catch {
    return null;
  }
}

// Runs one chat.send at a time per chat so two quick messages don't bind twice.
async function sendToHost(chat, m) {
  if (!port) return emit(chat, { kind: "error", code: "spawn", message: HOST_DOWN });
  await bindChat(chat).catch(() => {});
  const tabs = (await groupTabs(chat).catch(() => [])).map((t) => ({ tabId: t.id, title: t.title, url: t.url, current: !!t.active }));
  const resume = chat.resume;
  chat.resume = false;
  port?.postMessage({
    type: "chat.send",
    chatId: chat.id,
    engine: chat.engine,
    model: chat.model,
    effort: chat.effort,
    text: m.text,
    attachments: m.attachments ?? [],
    context: { tabs },
    resume,
  });
  scheduleGroupPush(chat.id);
}

const panelCommands = {
  async hello(panel, m) {
    panel.windowId = m.windowId ?? (await lastNormalWindowId());
    const id = validChatId(m.chatId) ? m.chatId : windowChat.get(panel.windowId);
    return showChat(panel, id ? chatFor(id, panel.windowId) : newChat(panel.windowId));
  },

  "chat.new"(panel) {
    const old = chats.get(panel.chatId);
    // Already looking at an untouched chat.
    if (old && !old.events.length && !sessions.has(old.id)) return sendState(panel);
    return showChat(panel, newChat(panel.windowId, old));
  },

  // From history. A chat this session doesn't know yet has its transcript loaded and, when next
  // sent to, resumed by the host.
  async "chat.open"(panel, m) {
    if (!validChatId(m.chatId)) return;
    const known = chats.has(m.chatId);
    const chat = chatFor(m.chatId, panel.windowId);
    if (known) return showChat(panel, chat);
    chat.resume = true;
    // It continues on the engine and model it was started with, not whatever the panel last used.
    // Terminal sessions are Claude Code's, and their own model may no longer exist.
    if (m.source === "terminal") chat.engine = "claude";
    else if (ENGINE_NAMES[m.engine]) Object.assign(chat, { engine: m.engine, model: typeof m.model === "string" ? m.model : null });
    await showChat(panel, chat);
    if (!port) return emit(chat, { kind: "error", code: "spawn", message: HOST_DOWN });
    ask(panel, { type: "chat.load", chatId: chat.id, source: m.source ?? "panel", path: m.path });
  },

  "chat.send"(panel, m) {
    const chat = chatFor(m.chatId ?? panel.chatId, panel.windowId);
    if (sessions.get(chat.id)?.groupId == null) chat.windowId = panel.windowId;
    for (const k of ["engine", "model", "effort"]) if (m[k] != null) chat[k] = m[k];
    chat.queue = chat.queue.then(() => sendToHost(chat, m)).catch(() => {});
  },

  "chat.interrupt": (panel, m) => port?.postMessage({ type: "chat.interrupt", chatId: m.chatId ?? panel.chatId }),
  "chat.permission"(panel, m) {
    const chat = chats.get(m.chatId ?? panel.chatId);
    if (chat?.awaiting) {
      chat.awaiting = false;
      scheduleRefresh();
    }
    port?.postMessage({ type: "chat.permission", chatId: chat?.id ?? panel.chatId, requestId: m.requestId, decision: m.decision });
  },
  "chat.history": (panel, m) => ask(panel, { type: "chat.history", requestId: m.requestId }),
  "chat.capabilities": (panel, m) => ask(panel, { type: "chat.capabilities", requestId: m.requestId, engine: m.engine }),

  // A tab dragged in the panel or picked from it. With no group yet, it starts one.
  async "group.add"(panel, m) {
    const chat = chats.get(panel.chatId);
    if (typeof m.tabId !== "number") return;
    const groupId = await sessionGroupId(chat.id);
    if (groupId != null) await browser.tabs.group({ tabIds: [m.tabId], groupId });
    else await startGroup(chat.id, ENGINE_NAMES[chat.engine] ?? "Claude", m.tabId, (await browser.tabs.get(m.tabId)).windowId);
    scheduleGroupPush(chat.id);
  },

  async "group.remove"(panel, m) {
    const chat = chats.get(panel.chatId);
    const groupId = await sessionGroupId(chat.id);
    const tab = await browser.tabs.get(m.tabId).catch(() => null);
    if (groupId == null || tab?.groupId !== groupId) return;
    await browser.tabs.ungroup(tab.id);
    scheduleGroupPush(chat.id);
  },

  // Stop all agents paused every session and any new one, so resuming from the panel undoes all
  // of it; resuming only this chat would leave the toolbar paused and pause the next chat.
  resume: () => control.resumeAll(),
  stopAll: () => stopAllAgents(),

  popout: (panel) =>
    browser.windows.create({
      url: browser.runtime.getURL(`sidebar/panel.html?window=${panel.windowId}&chat=${panel.chatId}`),
      type: "popup",
      width: 400,
      height: 680,
    }),
};

browser.runtime.onConnect.addListener((p) => {
  if (p.name !== "sidebar") return;
  const panel = { port: p, windowId: null, chatId: null, ready: false };
  panels.add(panel);
  p.onDisconnect.addListener(() => {
    panels.delete(panel);
    for (const [rid, a] of asked) if (a.panel === panel) asked.delete(rid);
    scheduleRefresh();
  });
  p.onMessage.addListener((m) => {
    const name = m?.cmd ?? m?.type;
    // Everything but hello needs a chat, which hello sets up.
    if (name !== "hello" && panel.chatId == null) return;
    Promise.resolve(panelCommands[name]?.(panel, m)).catch(() => {});
  });
});

// ---- Ask from the address bar
// "c <task>" starts a chat in a new group without opening the sidebar or leaving the tab. It is
// the panel's own start path (chatFor, bindChat, sendToHost) with the engine, model and effort the
// panel last saved. Its group label shows Working and Done like any chat's; when a turn finishes
// unseen, one system notification says so and takes the user to the group.

const OMNI_PAGE = "⁣page⁣"; // suggestion contents; the default suggestion's is the typed text
const OMNI_RESUME = "⁣resume⁣";
let omniHistory = Promise.resolve([]);

async function chatPrefs() {
  const p = (await browser.storage.local.get("chatPrefs").catch(() => ({})))?.chatPrefs ?? {};
  const engine = ENGINE_NAMES[p.engine] ? p.engine : "claude";
  return { engine, model: p[engine]?.model || null, effort: p[engine]?.effort || null };
}

function whenLabel(ms, now = Date.now()) {
  const days = Math.round((new Date(now).setHours(0, 0, 0, 0) - new Date(ms).setHours(0, 0, 0, 0)) / 86400000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Suggestion descriptions are plain text, so the action follows the task after a dash.
function omniSuggestions(text, history) {
  const out = [];
  if (text) out.push({ content: OMNI_PAGE + text, description: `${text} — Ask about this page` });
  for (const c of history.slice(0, 2)) {
    const info = { id: c.id, engine: c.engine, model: c.model, source: c.source, path: c.path };
    out.push({ content: OMNI_RESUME + JSON.stringify(info), description: `Resume “${c.title}” — ${whenLabel(c.updatedAt)}` });
  }
  return out;
}

async function startOmniTask(text, withPage) {
  const task = text.trim();
  if (!task) return;
  const chat = chatFor(crypto.randomUUID(), await lastNormalWindowId());
  Object.assign(chat, await chatPrefs());
  chat.omni = true;
  // With the page, the tab being viewed joins in place (bindChat). Otherwise the group starts with
  // a blank tab, which has to exist before the send so bindChat doesn't take the viewed tab.
  if (!withPage) await createSessionTab(chat.id, ENGINE_NAMES[chat.engine], "about:blank", chat.windowId).catch(() => {});
  chat.queue = chat.queue.then(() => sendToHost(chat, { text: task })).catch(() => {});
}

// Opens a past chat in the sidebar of the window the user is in. The address bar's input handler
// counts as a user action, so the sidebar may open from it.
async function resumeOmniChat(info) {
  if (!validChatId(info?.id)) return;
  const windowId = await lastNormalWindowId();
  const shown = () => [...panels].find((p) => p.windowId === windowId && p.ready);
  if (!shown()) {
    await browser.sidebarAction.open().catch(() => {});
    for (let i = 0; i < 30 && !shown(); i++) await new Promise((r) => setTimeout(r, 100));
  }
  const panel = shown();
  if (panel) await panelCommands["chat.open"](panel, { chatId: info.id, source: info.source, path: info.path, engine: info.engine, model: info.model });
  else windowChat.set(windowId, info.id);
}

// The first line of the last thing the agent said, without markdown marks.
function replyHeadline(chat) {
  const last = chat.events.findLast((e) => e.kind === "text" || e.kind === "text_delta");
  const line = String(last?.text ?? "").split("\n").map((l) => l.replace(/^[\s#>*-]+|[*_`]/g, "").trim()).find(Boolean) ?? "";
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

// Only when the user isn't on the group's tab: the label icon covers the rest.
async function notifyFinished(chat, ev) {
  const groupId = sessions.get(chat.id)?.groupId;
  const [tab] = chat.windowId != null ? await browser.tabs.query({ active: true, windowId: chat.windowId }).catch(() => []) : [];
  if (groupId == null || tab?.groupId === groupId) return;
  const ok = ev.ok !== false;
  browser.notifications?.create(`omni-${chat.id}`, {
    type: "basic",
    iconUrl: browser.runtime.getURL("icons/icon.svg"),
    title: `${sessions.get(chat.id).label} ${ok ? "finished" : "stopped"}`,
    message: (ok ? replyHeadline(chat) : ev.error) || "Open the group to see the result.",
  });
}

async function showChatGroup(chat) {
  const groupId = sessions.get(chat.id)?.groupId;
  const [tab] = groupId == null ? [] : await browser.tabs.query({ groupId }).catch(() => []);
  if (!tab) return;
  await browser.tabs.update(tab.id, { active: true });
  await browser.windows.update(tab.windowId, { focused: true }).catch(() => {});
}

if (browser.omnibox) {
  browser.omnibox.onInputStarted.addListener(() => {
    omniHistory = askHost({ type: "chat.history" }).then((m) => m.chats ?? []).catch(() => []);
  });
  browser.omnibox.onInputChanged.addListener(async (text, suggest) => {
    const t = text.trim();
    const name = ENGINE_NAMES[(await chatPrefs()).engine];
    browser.omnibox.setDefaultSuggestion({ description: t ? `${t} — Start a ${name} task` : `Start a ${name} task` });
    suggest(omniSuggestions(t, await omniHistory));
  });
  browser.omnibox.onInputEntered.addListener((text) => {
    if (text.startsWith(OMNI_RESUME)) resumeOmniChat(JSON.parse(text.slice(OMNI_RESUME.length))).catch(() => {});
    else if (text.startsWith(OMNI_PAGE)) startOmniTask(text.slice(OMNI_PAGE.length), true).catch(() => {});
    else startOmniTask(text, false).catch(() => {});
  });
}

browser.notifications?.onClicked.addListener((id) => {
  if (!id.startsWith("omni-")) return;
  browser.notifications.clear(id);
  const chat = chats.get(id.slice(5));
  if (chat) showChatGroup(chat);
});

// The toolbar button opens and closes the sidebar. toggle() must run in the click's own call
// stack (Firefox only lets user actions open a sidebar), so nothing may be awaited before it.
browser.browserAction.onClicked.addListener(() => {
  browser.sidebarAction.toggle();
});

browser.tabs.query({ active: true }).then((tabs) => {
  for (const t of tabs) userTabByWindow.set(t.windowId, t.id);
});

refresh();
connect();
