"use strict";

// Receives tool calls from Claude Code (via the native host) and runs them against tabs in
// the calling session's "Claude" tab group. Page work goes through browser.claudePage, the
// privileged experiment API in experiment/.

const NATIVE_HOST = "firefox_agent_bridge";
const GROUP_COLORS = ["orange", "blue", "purple", "cyan", "green", "pink", "yellow", "red"];
const SCREENSHOT_MAX_EDGE = 1568;
const SCREENSHOT_MAX_PIXELS = 1_150_000;
const LOAD_TIMEOUT_MS = 30_000;
const SETTLE_TIMEOUT_MS = 5_000;

// session id -> { groupId, label, color }
const sessions = new Map();
// tab id -> CSS pixels per screenshot pixel, from the tab's last screenshot
const frameRatio = new Map();

let port = null;

function connect() {
  port = browser.runtime.connectNative(NATIVE_HOST);
  port.onMessage.addListener(onRequest);
  port.onDisconnect.addListener(() => {
    port = null;
    setTimeout(connect, 2000);
  });
  port.postMessage({ type: "hello", version: browser.runtime.getManifest().version });
}

async function onRequest(msg) {
  if (msg.type !== "call") return;
  let reply;
  try {
    const content = await runTool(msg.session, msg.tool, msg.args ?? {});
    reply = { id: msg.id, result: { content } };
  } catch (e) {
    reply = { id: msg.id, result: { content: [text(e?.message ?? String(e))], isError: true } };
  }
  port?.postMessage(reply);
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

async function createSessionTab(session, url = "about:blank") {
  let groupId = await sessionGroupId(session);
  const windowId = groupId != null ? (await browser.tabGroups.get(groupId)).windowId : await targetWindowId();
  const tab = await browser.tabs.create({ url, active: false, windowId });
  if (groupId != null) {
    await browser.tabs.group({ tabIds: [tab.id], groupId });
  } else {
    groupId = await browser.tabs.group({ tabIds: [tab.id], createProperties: { windowId } });
    const n = sessions.size + 1;
    const s = sessions.get(session) ?? { label: n === 1 ? "Claude" : `Claude ${n}`, color: GROUP_COLORS[(n - 1) % GROUP_COLORS.length] };
    s.groupId = groupId;
    sessions.set(session, s);
    await browser.tabGroups.update(groupId, { title: s.label, color: s.color });
  }
  try {
    await browser.tabs.update(tab.id, { autoDiscardable: false });
  } catch {
    // not supported on this version
  }
  await keepActive(tab.id);
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
    throw new Error(`Tab ${tabId} is not in this session's Claude tab group. Use tabs_create_mcp for a new tab, or drag the tab into the group.`);
  }
  await keepActive(tabId);
  return tab;
}

async function tabContext(session, createIfEmpty) {
  let tabs = await sessionTabs(session);
  if (!tabs.length && createIfEmpty) {
    await createSessionTab(session);
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
// sees without resizing; coordinates Claude reads off it are mapped back to CSS pixels here.

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

async function runTool(session, tool, args) {
  switch (tool) {
    case "tabs_context_mcp":
      return [text(JSON.stringify(await tabContext(session, args.createIfEmpty), null, 2))];

    case "tabs_create_mcp": {
      const tab = await createSessionTab(session);
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
        context = await tabContext(session, true);
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
  if (back != null && back !== tabId) await browser.tabs.update(back, { active: true }).catch(() => {});
}

browser.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  if (justOpened.has(tabId)) return restoreUserTab(windowId, tabId);
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (!tab) return;
  if (await isSessionTab(tab, await sessionGroupIds())) {
    // Activated before onCreated ran for it: same case as above.
    if (tab.openerTabId != null && Date.now() - (tab.lastAccessed ?? 0) < 3000 && !tab.groupId) return restoreUserTab(windowId, tabId);
    return;
  }
  userTabByWindow.set(windowId, tabId);
});

browser.tabs.onCreated.addListener(async (tab) => {
  if (tab.openerTabId == null) return;
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

// Sessions don't survive a browser restart, so Claude tab groups brought back by session
// restore belong to no one. They often hold work left for him (a staged form on the Needs you
// list), so they are kept, renamed and greyed out; he closes them when done.
async function closeOrphanGroups() {
  for (const g of await browser.tabGroups.query({})) {
    if (/^Claude( \d+)?$/.test(g.title ?? "")) await browser.tabGroups.update(g.id, { title: "Claude (earlier)", color: "grey" });
  }
}

closeOrphanGroups().catch(() => {});

browser.tabs.query({ active: true }).then((tabs) => {
  for (const t of tabs) userTabByWindow.set(t.windowId, t.id);
});

connect();
