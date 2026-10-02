"use strict";

// Loads control.js, devtools.js and background.js the way the manifest does (one global scope)
// against a mocked `browser`, then drives them through the native port, tab events, the Stop
// command and the popup port.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

const event = () => {
  const listeners = [];
  return {
    addListener: (f) => listeners.push(f),
    removeListener: (f) => listeners.includes(f) && listeners.splice(listeners.indexOf(f), 1),
    fire: (...a) => Promise.all(listeners.map((f) => f(...a))),
    listeners,
  };
};

// noIcons: the experiment can't find the label element, so setGroupState answers false (or throws,
// with iconsThrow), and states go in the title.
function mockBrowser({ store = {}, groups: initialGroups = [], noIcons = false, iconsThrow = false } = {}) {
  const tabs = new Map([[1, { id: 1, windowId: 10, groupId: -1, active: true, url: "https://user.example/", status: "complete", title: "user", width: 800 }]]);
  const groups = new Map(initialGroups.map((g) => [g.id, { ...g }]));
  let nextTab = 2;
  let nextGroup = 100;
  const icons = new Map();
  const native = { sent: [], onMessage: event(), onDisconnect: event() };
  const action = { toggles: 0, popups: [] };
  const b = {
    native,
    action,
    store,
    tabsMap: tabs,
    groups,
    runtime: {
      connectNative: () => ({ onMessage: native.onMessage, onDisconnect: native.onDisconnect, postMessage: (m) => native.sent.push(m) }),
      getManifest: () => ({ version: "0.1.0" }),
      getURL: (p) => `moz-extension://x/${p}`,
      onConnect: event(),
    },
    storage: { local: { get: async (k) => ({ [k]: store[k] }), set: async (o) => Object.assign(store, o), remove: async (k) => delete store[k] } },
    omnibox: { onInputStarted: event(), onInputChanged: event(), onInputEntered: event(), setDefaultSuggestion: (d) => (action.defaultSuggestion = d) },
    notifications: {
      shown: [],
      cleared: [],
      create(id, o) {
        this.shown.push({ id, ...o });
      },
      clear(id) {
        this.cleared.push(id);
      },
      onClicked: event(),
    },
    windows: {
      update: async (id, o) => (action.focused = { id, ...o }),
      getLastFocused: async () => ({ id: 10, incognito: false }),
      create: async (o) => {
        action.popups.push(o);
        return { id: 11 };
      },
    },
    sidebarAction: {
      toggle: () => action.toggles++,
      open: async () => action.toggles++,
      setIcon: async ({ path }) => {
        action.sideIcon = path;
      },
    },
    tabs: {
      onActivated: event(),
      onCreated: event(),
      onUpdated: event(),
      onRemoved: event(),
      onAttached: event(),
      onDetached: event(),
      query: async (q = {}) =>
        [...tabs.values()]
          .filter((t) => (q.active == null || t.active === q.active) && (q.windowId == null || t.windowId === q.windowId) && (q.groupId == null || t.groupId === q.groupId))
          .map((t) => ({ ...t, index: t.id })),
      get: async (id) => {
        if (!tabs.has(id)) throw new Error("no tab");
        return { ...tabs.get(id) };
      },
      create: async ({ url, windowId, active = true }) => {
        const t = { id: nextTab++, windowId, groupId: -1, active: false, url, status: "complete", title: "" };
        tabs.set(t.id, t);
        if (active) b.select(t.id);
        return { ...t };
      },
      update: async (id, props) => {
        if (props.active) b.select(id);
        return Object.assign(tabs.get(id), props);
      },
      group: async ({ tabIds, groupId, createProperties }) => {
        const gid = groupId ?? nextGroup++;
        if (!groups.has(gid)) groups.set(gid, { id: gid, windowId: createProperties?.windowId, title: "" });
        for (const id of tabIds) tabs.get(id).groupId = gid;
        return gid;
      },
      remove: async (id) => tabs.delete(id),
      captureTab: async (id, opts) => `data:image/jpeg;base64,${Buffer.from(`shot of ${id} at ${opts.scale}`).toString("base64")}`,
      ungroup: async (id) => {
        const gid = tabs.get(id).groupId;
        tabs.get(id).groupId = -1;
        if (![...tabs.values()].some((t) => t.groupId === gid)) groups.delete(gid);
      },
    },
    tabGroups: {
      get: async (id) => {
        if (!groups.has(id)) throw new Error("no group");
        return { ...groups.get(id) };
      },
      update: async (id, props) => Object.assign(groups.get(id), props),
      query: async () => [...groups.values()],
      onMoved: event(),
    },
    // group id -> the state icon showing in its label
    icons,
    // tab id -> whether Teach is recording it
    recorded: new Map(),
    webRequest: { onBeforeRequest: event(), onBeforeRedirect: event(), onCompleted: event(), onErrorOccurred: event() },
    claudePage: {
      // the tab ids whose console the experiment was last told to capture
      devtoolsWatch: async (tabIds, redact) => {
        b.consoleWatched = tabIds;
        b.consoleRules = redact;
        return tabIds.length;
      },
      onConsole: event(),
      onPick: event(),
      record: async (tabId, on, redact) => {
        b.recorded.set(tabId, on);
        if (on) b.recordRules = redact;
      },
      onRecord: event(),
      setActive: async () => {},
      call: async (tabId, op) => (op === "textSize" ? 10 : "done"),
      broadcast: async () => [],
      setGroupState: async (groupId, state) => {
        if (iconsThrow) throw new Error("not a function");
        if (noIcons || !groups.has(groupId)) return false;
        if (state == null) icons.delete(groupId);
        else icons.set(groupId, state);
        return true;
      },
    },
    browserAction: {
      onClicked: event(),
      setIcon: ({ path }) => (action.icon = path),
      setTitle: ({ title }) => (action.title = title),
      setBadgeText: ({ text }) => (action.badge = text),
      setBadgeBackgroundColor: () => {},
    },
    commands: { onCommand: event() },
    // One active tab per window, as in Firefox; tabs.create defaults to active like the real API.
    select(id) {
      const t = tabs.get(id);
      for (const o of tabs.values()) if (o.windowId === t.windowId) o.active = false;
      t.active = true;
    },
  };
  return b;
}

// Objects made inside the vm context have another Object prototype, which deepEqual notices.
const plain = (x) => JSON.parse(JSON.stringify(x));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function load(opts) {
  const browser = mockBrowser(opts);
  const matchMedia = () => ({ matches: !!opts?.dark, addEventListener: () => {} });
  const ctx = vm.createContext({ browser, console, setTimeout, clearTimeout, URL, Date, Promise, matchMedia, crypto: webcrypto, atob });
  for (const f of ["control.js", "devtools.js", "background.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, "..", f), "utf8"), ctx, { filename: f });
  await wait(20);
  const replies = () => browser.native.sent.filter((m) => m.result);
  let n = 0;
  const callTool = async (tool, args = {}, session = "s1", client = { id: 1, name: "Claude Code" }, ms = 2000) => {
    const id = `${client.id}:${++n}`;
    await browser.native.onMessage.fire({ type: "call", id, session, tool, args, client });
    for (let i = 0; i < ms / 10 && !replies().some((r) => r.id === id); i++) await wait(10);
    return replies().find((r) => r.id === id);
  };
  const popup = () => {
    const msgs = [];
    const p = { name: "popup", onMessage: event(), onDisconnect: event(), postMessage: (m) => msgs.push(m), msgs };
    browser.runtime.onConnect.fire(p);
    p.send = (m) => p.onMessage.fire(m);
    p.last = () => msgs.at(-1).state;
    return p;
  };
  // A chat panel on the "sidebar" port. Messages it received are in msgs; of(type) picks them.
  const panel = async (windowId = 10, chatId) => {
    const msgs = [];
    const p = { name: "sidebar", onMessage: event(), onDisconnect: event(), postMessage: (m) => msgs.push(structuredClone(m)), msgs };
    browser.runtime.onConnect.fire(p);
    p.send = async (cmd, extra = {}) => {
      await p.onMessage.fire({ cmd, ...extra });
      await wait(20);
    };
    p.of = (type) => msgs.filter((m) => m.type === type);
    p.close = () => p.onDisconnect.fire();
    await p.send("hello", { windowId, ...(chatId ? { chatId } : {}) });
    p.chatId = p.of("state")[0].chatId;
    return p;
  };
  const host = (msg) => browser.native.onMessage.fire(msg);
  const sentToHost = (type) => plain(browser.native.sent.filter((m) => m.type === type));
  return { browser, callTool, replies, popup, panel, host, sentToHost, ctx };
}

test("calls run without any prompt; group is named after the client", async () => {
  const { browser, callTool, popup } = await load();
  assert.equal(JSON.stringify(browser.native.sent[0]), JSON.stringify({ type: "hello", version: "0.1.0" }));
  await browser.native.onMessage.fire({ type: "client", event: "connected", client: { id: 1, name: "claude-code", version: "2", pid: 9, cwd: "/p" } });
  const ui = popup();
  const r = await callTool("tabs_create_mcp", {}, "s1", { id: 1, name: "claude-code" });
  assert.match(r.result.content[0].text, /Created tab 2 in the Claude tab group/);
  assert.equal(browser.groups.get(100).title, "Claude");
  await wait(80);
  assert.equal(browser.action.icon, "icons/toolbar-acting-light.svg");
  const state = ui.last();
  assert.equal(state.log.at(-1).outcome, "ok");
  assert.equal(state.log.at(-1).client, "claude-code");
  assert.equal(state.sessions[0].label, "Claude");
  assert.equal(state.clients[0].calls, 1);
  assert.equal(state.approvals, undefined);
  assert.equal(state.sessions[0].clientId, 1);
});

test("toolbar icon follows the state and the dark color scheme", async () => {
  const { browser, callTool } = await load({ dark: true });
  assert.equal(browser.action.icon, "icons/toolbar-idle-dark.svg");
  await callTool("tabs_context_mcp");
  await wait(80);
  assert.equal(browser.action.icon, "icons/toolbar-acting-dark.svg");
  assert.equal(browser.action.sideIcon, "icons/sidebar-working-dark.svg");
  assert.match(browser.action.title, /acting/);
  await wait(3100);
  assert.equal(browser.action.icon, "icons/toolbar-idle-dark.svg");
  assert.equal(browser.action.sideIcon, "icons/sidebar-idle-dark.svg");
});

test("labels per client: Codex, ffctl, first word, numbered repeats", async () => {
  const env = await load();
  const label = env.ctx.clientLabel;
  assert.equal(label("Claude Code"), "Claude");
  assert.equal(label("codex-mcp-client"), "Codex");
  assert.equal(label("ffctl"), "ffctl");
  assert.equal(label("my-agent"), "My");
  assert.equal(label("supercalifragilisticexpialidocious"), "Supercalifragili");
  assert.equal(label(""), "Agent");
  await env.callTool("tabs_create_mcp", {}, "s1", { id: 1, name: "codex-mcp-client" });
  await env.callTool("tabs_create_mcp", {}, "s2", { id: 2, name: "codex-mcp-client" });
  const r = await env.callTool("tabs_create_mcp", {}, "s3", { id: 3, name: "goose" });
  assert.match(r.result.content[0].text, /in the Goose tab group/);
  assert.deepEqual([...env.browser.groups.values()].map((g) => g.title), ["Codex", "Codex 2", "Goose"]);
  assert.deepEqual([...env.browser.groups.values()].map((g) => g.color), ["grey", "grey", "grey"], "every agent group is grey");
  assert.equal(JSON.stringify(env.browser.store.groupLabels), JSON.stringify(["Claude", "Codex", "Goose"]));
  const wrong = await env.callTool("tabs_close_mcp", { tabId: 2 }, "s3", { id: 3, name: "goose" });
  assert.match(wrong.result.content[0].text, /not in this session's tab group \("Goose"\)/);
  // Numbers count only groups that still exist: with the first Codex group gone, the next is "Codex".
  const first = [...env.browser.groups.values()].find((g) => g.title === "Codex");
  env.browser.groups.delete(first.id);
  await env.callTool("tabs_create_mcp", {}, "s4", { id: 4, name: "codex-mcp-client" });
  assert.deepEqual([...env.browser.groups.values()].map((g) => g.title), ["Codex 2", "Goose", "Codex"]);
});

test("on restart, groups with any remembered label become '<label>' with the earlier icon'", async () => {
  const groups = [
    { id: 1, title: "Claude" },
    { id: 2, title: "Codex 2 (paused)" },
    { id: 3, title: "Goose" },
    { id: 4, title: "Shopping" },
    { id: 5, title: "Claude (earlier)" },
  ];
  const { browser } = await load({ store: { groupLabels: ["Claude", "Codex", "Goose"], allowedClients: ["x"] }, groups });
  assert.deepEqual(
    [...browser.groups.values()].map((g) => [g.title, g.color]),
    [
      ["Claude", "grey"],
      ["Codex", "grey"],
      ["Goose", "grey"],
      ["Shopping", undefined],
      ["Claude", "grey"],
    ],
  );
  assert.deepEqual([...browser.icons], [[1, "earlier"], [2, "earlier"], [3, "earlier"], [5, "earlier"]]);
  assert.equal(browser.store.allowedClients, undefined, "old consent storage is dropped");
});

test("switching to a session tab does not pause it", async () => {
  const env = await load();
  await env.callTool("tabs_create_mcp");
  await env.browser.tabs.onActivated.fire({ tabId: 2, previousTabId: 1, windowId: 10 });
  await wait(20);
  assert.equal(env.browser.groups.get(100).title, "Claude");
  assert.equal((await env.callTool("tabs_context_mcp")).result.isError, undefined);
  assert.equal(env.popup().last().sessions[0].paused, false);
});

test("a tab the session page opens is handed back, and focus goes back to the user", async () => {
  const env = await load();
  await env.callTool("tabs_create_mcp");
  // Page in tab 2 opens tab 3; Firefox makes it active.
  const t3 = { id: 3, windowId: 10, groupId: -1, active: true, openerTabId: 2, url: "https://x.example/", status: "complete", title: "x" };
  env.browser.tabsMap.set(3, t3);
  await env.browser.tabs.onCreated.fire({ ...t3 });
  await env.browser.tabs.onActivated.fire({ tabId: 3, previousTabId: 1, windowId: 10 });
  await wait(20);
  assert.equal(env.browser.tabsMap.get(3).groupId, 100);
  assert.equal(env.browser.tabsMap.get(1).active, true, "focus handed back to the user's tab");
  assert.equal(env.popup().last().sessions[0].paused, false);
});

test("Stop command answers the in-flight call, pauses, and resume all clears it", async () => {
  const env = await load();
  await env.callTool("tabs_create_mcp");
  let release;
  env.browser.claudePage.call = (tabId, op) => (op === "click" ? new Promise((r) => (release = r)) : Promise.resolve(10));
  const pending = env.callTool("computer", { action: "left_click", tabId: 2, coordinate: [5, 5] });
  await wait(30);
  await env.browser.commands.onCommand.fire("stop-agents");
  const r = await pending;
  assert.match(r.result.content[0].text, /stopped this call/);
  release("clicked");
  await wait(700);
  assert.equal(env.replies().filter((x) => x.id === r.id).length, 1, "late result dropped");
  assert.equal(env.browser.groups.get(100).title, "Claude", "the state is an icon, not text");
  assert.equal(env.browser.icons.get(100), "paused");
  assert.equal(env.browser.action.icon, "icons/toolbar-paused-light.svg");
  const blocked = await env.callTool("tabs_context_mcp", {}, "s2");
  assert.match(blocked.result.content[0].text, /paused this session/);
  env.popup().send({ cmd: "resumeAll" });
  await wait(150);
  assert.equal(env.browser.groups.get(100).title, "Claude");
  assert.notEqual(env.browser.icons.get(100), "paused");
  assert.equal((await env.callTool("tabs_context_mcp", {}, "s2")).result.isError, undefined);
});

test("Disconnect sends disconnect_client, blocks the name, Unblock lets it back", async () => {
  const env = await load();
  await env.browser.native.onMessage.fire({ type: "client", event: "connected", client: { id: 4, name: "Claude Code", pid: 1, cwd: "/" } });
  const ui = env.popup();
  ui.send({ cmd: "disconnect", clientId: 4 });
  assert.equal(JSON.stringify(env.browser.native.sent.at(-1)), JSON.stringify({ type: "disconnect_client", clientId: 4 }));
  await env.browser.native.onMessage.fire({ type: "client", event: "connected", client: { id: 5, name: "Claude Code", pid: 1, cwd: "/" } });
  const r = await env.callTool("tabs_context_mcp", {}, "s1", { id: 5, name: "Claude Code" });
  assert.match(r.result.content[0].text, /disconnected this client/);
  assert.equal(env.browser.groups.size, 0, "nothing ran");
  await wait(80);
  assert.equal(JSON.stringify(ui.last().blocked), JSON.stringify(["Claude Code"]));
  ui.send({ cmd: "unblock", name: "Claude Code" });
  assert.equal((await env.callTool("tabs_context_mcp", {}, "s1", { id: 5, name: "Claude Code" })).result.isError, undefined);
});

// ---------------------------------------------------------------------------------------------
// Chat panel

test("toolbar click toggles the sidebar synchronously; the manifest has a sidebar and no popup", async () => {
  const { browser } = await load();
  const done = browser.browserAction.onClicked.fire({});
  assert.equal(browser.action.toggles, 1, "toggle runs in the click's own call stack");
  await done;
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));
  assert.equal(manifest.browser_action.default_popup, undefined);
  assert.equal(manifest.sidebar_action.default_panel, "sidebar/panel.html");
  assert.equal(manifest.sidebar_action.open_at_install, false);
  assert.equal(browser.action.icon, "icons/toolbar-idle-light.svg", "toolbar icons unchanged");
});

test("hello gives a new chat, and the same chat on the next hello from that window", async () => {
  const env = await load();
  const a = await env.panel();
  const state = a.of("state")[0];
  assert.match(state.chatId, /^[0-9a-f-]{36}$/);
  assert.equal(state.windowId, 10);
  assert.deepEqual(state.events, []);
  assert.deepEqual(state.group, { chatId: state.chatId, label: null, color: null, tabs: [] });
  assert.equal(state.activeTab.tabId, 1);
  assert.equal(state.paused, false);
  const b = await env.panel();
  assert.equal(b.of("state")[0].chatId, state.chatId);
  await b.send("chat.new");
  assert.equal(b.of("state")[1].chatId, state.chatId, "an untouched chat is reused");
  await env.host({ type: "chat.event", chatId: state.chatId, event: { kind: "user", text: "hi", attachments: [] } });
  await b.send("chat.new");
  assert.notEqual(b.of("state")[2].chatId, state.chatId);
  assert.equal((await env.panel()).chatId, b.of("state")[2].chatId, "the window's current chat moved");
});

test("first chat.send groups the viewed tab in place and the chat's MCP calls find it", async () => {
  const env = await load();
  const a = await env.panel();
  await a.send("chat.send", { chatId: a.chatId, engine: "claude", model: "haiku", effort: "low", text: "hi", attachments: [] });
  const sent = env.sentToHost("chat.send");
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    type: "chat.send",
    chatId: a.chatId,
    engine: "claude",
    model: "haiku",
    effort: "low",
    text: "hi",
    attachments: [],
    skill: null,
    context: { tabs: [{ tabId: 1, title: "user", url: "https://user.example/", current: true }] },
    resume: false,
  });
  assert.equal(env.browser.tabsMap.size, 1, "no extra about:blank tab");
  assert.equal(env.browser.tabsMap.get(1).groupId, 100);
  assert.deepEqual([env.browser.groups.get(100).title, env.browser.groups.get(100).color], ["Claude", "grey"]);
  assert.equal(env.browser.tabsMap.get(1).autoDiscardable, undefined, "the user's tab isn't marked");

  const ctx = JSON.parse((await env.callTool("tabs_context_mcp", { createIfEmpty: true }, a.chatId, { id: 9, name: "claude" })).result.content[0].text);
  assert.equal(ctx.tabGroup, "Claude");
  assert.deepEqual(ctx.availableTabs, [{ tabId: 1, title: "user", url: "https://user.example/", userIsViewing: true }]);
  assert.equal(env.browser.tabsMap.size, 1);
  assert.equal((await env.callTool("get_page_text", { tabId: 1 }, a.chatId, { id: 9, name: "claude" })).result.isError, undefined);

  // A second message reuses the group; a second chat and Codex get their own labels.
  await a.send("chat.send", { engine: "claude", text: "again" });
  assert.equal(env.browser.groups.size, 1);
  assert.equal(env.sentToHost("chat.send")[1].context.tabs.length, 1);
  assert.equal(env.sentToHost("chat.send")[1].resume, false);
  const b = await env.panel(12);
  env.browser.tabsMap.set(7, { id: 7, windowId: 12, groupId: -1, active: true, url: "https://b.example/", status: "complete", title: "b" });
  await b.send("chat.send", { engine: "codex", text: "hello" });
  assert.equal(env.browser.tabsMap.get(7).groupId, 101);
  assert.equal(env.browser.groups.get(101).title, "Codex");
});

test("a viewed tab that is already in another session's group isn't taken; the chat gets a blank tab", async () => {
  const env = await load();
  await env.callTool("tabs_create_mcp", {}, "mcp1", { id: 1, name: "claude-code" });
  env.browser.tabsMap.get(1).active = false;
  env.browser.tabsMap.get(2).active = true;
  const a = await env.panel();
  await a.send("chat.send", { engine: "claude", text: "hi" });
  assert.equal(env.browser.tabsMap.get(2).groupId, 100, "still the MCP session's");
  assert.equal(env.browser.groups.size, 2);
  assert.equal(env.browser.groups.get(101).title, "Claude 2");

  // The blank tab opens in the panel's window, not wherever the last focused window is.
  const b = await env.panel(12);
  env.browser.tabsMap.set(8, { id: 8, windowId: 12, groupId: 100, active: true, url: "https://c.example/", status: "complete", title: "c" });
  await b.send("chat.send", { engine: "claude", text: "hi" });
  const blank = [...env.browser.tabsMap.values()].find((t) => t.groupId === 102);
  assert.equal(blank?.windowId, 12);
});

test("chat messages relay both ways; replies go to the panel that asked", async () => {
  const env = await load();
  const a = await env.panel();
  const b = await env.panel();
  const other = await env.panel(12);
  await a.send("chat.interrupt");
  await a.send("chat.permission", { requestId: "p1", decision: "allow_always" });
  assert.deepEqual(env.sentToHost("chat.interrupt"), [{ type: "chat.interrupt", chatId: a.chatId }]);
  assert.deepEqual(env.sentToHost("chat.permission"), [{ type: "chat.permission", chatId: a.chatId, requestId: "p1", decision: "allow_always" }]);

  await a.send("chat.history", { requestId: "h" });
  await b.send("chat.capabilities", { requestId: "h", engine: "codex" });
  const [hist, caps] = [env.sentToHost("chat.history")[0], env.sentToHost("chat.capabilities")[0]];
  assert.notEqual(hist.requestId, caps.requestId, "host request ids are the background's own");
  assert.equal(caps.engine, "codex");
  await env.host({ type: "chat.history", requestId: hist.requestId, chats: [{ id: "c1", title: "t" }] });
  await env.host({ type: "chat.capabilities", requestId: caps.requestId, engine: "codex", available: true, models: [] });
  assert.deepEqual(a.of("chat.history"), [{ type: "chat.history", requestId: "h", chats: [{ id: "c1", title: "t" }] }]);
  assert.equal(b.of("chat.history").length, 0);
  assert.equal(a.of("chat.capabilities").length, 0);
  assert.equal(b.of("chat.capabilities")[0].requestId, "h");
  assert.equal(other.of("chat.history").length + other.of("chat.capabilities").length, 0);

  // Events go to every panel showing the chat.
  const ev = { kind: "status", status: "running" };
  await env.host({ type: "chat.event", chatId: a.chatId, event: ev });
  assert.deepEqual(a.of("chat.event"), [{ type: "chat.event", chatId: a.chatId, event: ev }]);
  assert.equal(b.of("chat.event").length, 1);
  assert.equal(other.of("chat.event").length, 0);
});

test("opening a chat from history loads its transcript in chunks, then resumes it on send", async () => {
  const env = await load();
  const a = await env.panel();
  await a.send("chat.open", { chatId: "old-chat", source: "terminal", path: "/p/old.jsonl" });
  assert.equal(a.of("state")[1].chatId, "old-chat");
  const load_ = env.sentToHost("chat.load")[0];
  assert.deepEqual({ ...load_, requestId: 0 }, { type: "chat.load", requestId: 0, chatId: "old-chat", source: "terminal", path: "/p/old.jsonl" });
  await env.host({ type: "chat.transcript", requestId: load_.requestId, chatId: "old-chat", items: [{ kind: "user", text: "q" }], done: false });
  await env.host({ type: "chat.transcript", requestId: load_.requestId, chatId: "old-chat", items: [{ kind: "text", messageId: "m", text: "a" }], done: true });
  assert.equal(a.of("chat.transcript").length, 2);
  await env.host({ type: "chat.transcript", requestId: load_.requestId, chatId: "old-chat", items: [], done: true });
  assert.equal(a.of("chat.transcript").length, 2, "late chunks after done are dropped");
  assert.equal((await env.panel()).of("state")[0].events.length, 2, "transcript is replayed to a reopened panel");
  await a.send("chat.send", { chatId: "old-chat", engine: "claude", text: "more" });
  assert.equal(env.sentToHost("chat.send")[0].resume, true);
  await a.send("chat.send", { chatId: "old-chat", engine: "claude", text: "more" });
  assert.equal(env.sentToHost("chat.send")[1].resume, false);
});

test("a reopened panel gets the chat back, with streamed text folded together", async () => {
  const env = await load();
  const a = await env.panel();
  const send = (event) => env.host({ type: "chat.event", chatId: a.chatId, event });
  await send({ kind: "user", text: "hi", attachments: [] });
  await send({ kind: "text_delta", messageId: "m1", text: "Hel" });
  await send({ kind: "text_delta", messageId: "m1", text: "lo" });
  await send({ kind: "text_delta", messageId: "m2", text: "par" });
  await a.send("chat.send", { engine: "claude", model: "m", effort: "high", text: "x" });
  await a.close();
  const b = await env.panel();
  let state = b.of("state")[0];
  assert.equal(state.chatId, a.chatId);
  assert.deepEqual(state.events.map((e) => [e.kind, e.text]), [["user", "hi"], ["text_delta", "Hello"], ["text_delta", "par"]]);
  assert.deepEqual([state.engine, state.model, state.effort], ["claude", "m", "high"]);
  // The finished text block replaces its deltas.
  await send({ kind: "text", messageId: "m2", text: "partial done" });
  await b.send("hello", { windowId: 10 });
  state = b.of("state")[1];
  assert.deepEqual(state.events.map((e) => [e.kind, e.text]), [["user", "hi"], ["text_delta", "Hello"], ["text", "partial done"]]);
  assert.equal(a.of("chat.event").length, 4, "closed panel got nothing after it left");
  assert.equal(state.group.tabs.length, 1);
});

test("group changes are pushed: titles, drag in and out, closes, the active tab", async () => {
  const env = await load();
  const a = await env.panel();
  await a.send("chat.send", { engine: "claude", text: "hi" });
  await wait(150);
  const groups = () => a.of("group");
  const before = groups().length;
  assert.equal(groups().at(-1).label, "Claude");
  assert.deepEqual(groups().at(-1).tabs.map((t) => [t.tabId, t.active]), [[1, true]]);

  env.browser.tabsMap.get(1).title = "renamed";
  await env.browser.tabs.onUpdated.fire(1, { title: "renamed" }, { ...env.browser.tabsMap.get(1) });
  await wait(150);
  assert.equal(groups().length, before + 1);
  assert.equal(groups().at(-1).tabs[0].title, "renamed");
  assert.equal(groups().at(-1).chatId, a.chatId);
  assert.equal(a.of("activeTab").at(-1).tab.title, "renamed", "the viewed tab changed too");

  // Unrelated tab changes and status-only updates push nothing.
  env.browser.tabsMap.set(5, { id: 5, windowId: 10, groupId: -1, active: false, url: "https://other.example/", status: "complete", title: "other" });
  await env.browser.tabs.onUpdated.fire(5, { title: "x" }, { ...env.browser.tabsMap.get(5) });
  await env.browser.tabs.onUpdated.fire(1, { status: "loading" }, { ...env.browser.tabsMap.get(1) });
  await wait(150);
  assert.equal(groups().length, before + 1);

  await a.send("group.add", { tabId: 5 });
  await wait(150);
  assert.deepEqual(groups().at(-1).tabs.map((t) => t.tabId), [1, 5]);
  assert.equal(env.browser.tabsMap.get(5).groupId, 100);
  assert.deepEqual(groups().at(-1).tabs.map((t) => t.active), [true, false]);

  // The user drags it out themselves.
  env.browser.tabsMap.get(5).groupId = -1;
  await env.browser.tabs.onUpdated.fire(5, { groupId: -1 }, { ...env.browser.tabsMap.get(5) });
  await wait(150);
  assert.deepEqual(groups().at(-1).tabs.map((t) => t.tabId), [1]);
  await a.send("group.add", { tabId: 5 });
  await a.send("group.remove", { tabId: 5 });
  await wait(150);
  assert.equal(env.browser.tabsMap.get(5).groupId, -1);
  assert.deepEqual(groups().at(-1).tabs.map((t) => t.tabId), [1]);
  await a.send("group.remove", { tabId: 1 });
  await wait(150);
  assert.deepEqual(groups().at(-1).tabs, [], "removing the last tab ends the group");

  // Closing a group tab, and switching tabs.
  const b = await env.panel(12);
  env.browser.tabsMap.set(8, { id: 8, windowId: 12, groupId: -1, active: true, url: "https://b.example/", status: "complete", title: "b" });
  await b.send("chat.send", { engine: "claude", text: "hi" });
  await b.send("group.add", { tabId: 8 });
  env.browser.tabsMap.delete(8);
  await env.browser.tabs.onRemoved.fire(8, { windowId: 12 });
  await wait(150);
  assert.deepEqual(b.of("group").at(-1).tabs, []);
  env.browser.tabsMap.set(9, { id: 9, windowId: 12, groupId: -1, active: true, url: "https://nine.example/", status: "complete", title: "nine" });
  await env.browser.tabs.onActivated.fire({ tabId: 9, windowId: 12 });
  assert.equal(b.of("activeTab").at(-1).tab.tabId, 9);
  assert.equal(a.of("activeTab").filter((m) => m.tab?.tabId === 9).length, 0, "other windows' panels aren't told");
});

test("sub-agents opening tabs at once all land in the chat's group, and a new session gets one group", async () => {
  const env = await load();
  const a = await env.panel();
  await a.send("chat.send", { engine: "claude", text: "compare" });
  const claude = { id: 9, name: "claude" };
  const made = await Promise.all([1, 2, 3, 4, 5].map(() => env.callTool("tabs_create_mcp", {}, a.chatId, claude)));
  assert.ok(made.every((r) => !r.result.isError));
  assert.equal(env.browser.groups.size, 1);
  assert.deepEqual([...env.browser.tabsMap.values()].map((t) => t.groupId), [100, 100, 100, 100, 100, 100]);
  await Promise.all([2, 3, 4, 5, 6].map((tabId) => env.callTool("tabs_close_mcp", { tabId }, a.chatId, claude)));
  assert.deepEqual([...env.browser.tabsMap.keys()], [1], "each sub-agent closes its own tab");

  // A session with no group yet: parallel creates must not each start a group of their own.
  await Promise.all([1, 2, 3].map(() => env.callTool("tabs_create_mcp", {}, "fresh", { id: 2, name: "claude-code" })));
  const fresh = [...env.browser.tabsMap.values()].filter((t) => t.id !== 1);
  assert.equal(fresh.length, 3);
  assert.equal(new Set(fresh.map((t) => t.groupId)).size, 1);
  assert.equal(env.browser.groups.size, 2);
});

test("pausing or resuming the chat's session is pushed to its panels", async () => {
  const env = await load();
  const a = await env.panel();
  const b = await env.panel();
  await a.send("chat.send", { engine: "claude", text: "hi" });
  await env.callTool("tabs_context_mcp", {}, a.chatId, { id: 9, name: "claude" });
  await a.send("stopAll");
  assert.deepEqual(a.of("paused"), [{ type: "paused", paused: true }]);
  assert.equal(b.of("paused").length, 1);
  await wait(150);
  assert.equal(env.browser.icons.get(100), "paused");
  assert.equal((await env.panel()).of("state")[0].paused, true);
  assert.match((await env.callTool("tabs_context_mcp", {}, a.chatId, { id: 9, name: "claude" })).result.content[0].text, /paused this session/);
  await a.send("resume");
  assert.deepEqual(a.of("paused").at(-1), { type: "paused", paused: false });
  await wait(150);
  assert.notEqual(env.browser.icons.get(100), "paused");
  assert.equal(env.browser.groups.get(100).title, "Claude");
  // The Stop shortcut and the popup pause a chat too.
  await env.browser.commands.onCommand.fire("stop-agents");
  assert.equal(a.of("paused").at(-1).paused, true);
  env.popup().send({ cmd: "resumeAll" });
  await wait(20);
  assert.equal(a.of("paused").at(-1).paused, false);
});

test("pop out opens the panel in a popup window for this chat", async () => {
  const env = await load();
  const a = await env.panel();
  await a.send("popout");
  assert.deepEqual(plain(env.browser.action.popups), [
    { url: `moz-extension://x/sidebar/panel.html?window=10&chat=${a.chatId}`, type: "popup", width: 400, height: 680 },
  ]);
  const popped = await env.panel(10, a.chatId);
  assert.equal(popped.chatId, a.chatId);
  await env.host({ type: "chat.event", chatId: a.chatId, event: { kind: "status", status: "idle" } });
  assert.equal(popped.of("chat.event").length + a.of("chat.event").length, 2, "both panels show the chat");
});

test("without the native host: sends fail visibly, requests get empty answers, a crash ends the run", async () => {
  const env = await load();
  const a = await env.panel();
  await env.host({ type: "chat.event", chatId: a.chatId, event: { kind: "status", status: "running" } });
  const port = env.browser.native;
  await port.onDisconnect.fire();
  assert.deepEqual(a.of("chat.event").slice(-2).map((m) => [m.event.kind, m.event.code ?? m.event.status]), [["error", "crashed"], ["status", "exited"]]);
  await a.send("chat.capabilities", { requestId: "c", engine: "claude" });
  assert.equal(a.of("chat.capabilities")[0].available, false);
  assert.equal(a.of("chat.capabilities")[0].requestId, "c");
  await a.send("chat.history", { requestId: "h" });
  assert.deepEqual(a.of("chat.history")[0].chats, []);
  await a.send("chat.send", { engine: "claude", text: "hi" });
  assert.equal(a.of("chat.event").at(-1).event.code, "spawn");
  assert.equal(env.browser.groups.size, 0, "nothing bound while the host is down");
});

test("the user's own tab that a chat adopted is where focus returns when a page opens a tab", async () => {
  const env = await load();
  const a = await env.panel();
  await a.send("chat.send", { engine: "claude", text: "hi" });
  // The user looks at another tab, then back at the chat's tab.
  env.browser.tabsMap.set(5, { id: 5, windowId: 10, groupId: -1, active: false, url: "https://other.example/", status: "complete", title: "o" });
  await env.browser.tabs.onActivated.fire({ tabId: 5, previousTabId: 1, windowId: 10 });
  env.browser.tabsMap.get(5).active = false;
  env.browser.tabsMap.get(1).active = true;
  await env.browser.tabs.onActivated.fire({ tabId: 1, previousTabId: 5, windowId: 10 });
  const t3 = { id: 3, windowId: 10, groupId: -1, active: true, openerTabId: 1, url: "https://x.example/", status: "complete", title: "x" };
  env.browser.tabsMap.set(3, t3);
  env.browser.tabsMap.get(1).active = false;
  await env.browser.tabs.onCreated.fire({ ...t3 });
  await wait(20);
  assert.equal(env.browser.tabsMap.get(3).groupId, 100);
  assert.equal(env.browser.tabsMap.get(1).active, true, "back to the chat's tab, not the older tab 5");
});

test("Stop all agents (panel, shortcut, popup) also interrupts the turns the panel is running", async () => {
  const env = await load();
  const a = await env.panel();
  const idle = await env.panel(12);
  await a.send("chat.send", { engine: "claude", text: "hi" });
  await env.host({ type: "chat.event", chatId: a.chatId, event: { kind: "status", status: "running" } });
  await env.host({ type: "chat.event", chatId: idle.chatId, event: { kind: "status", status: "idle" } });
  await a.send("stopAll");
  assert.deepEqual(env.sentToHost("chat.interrupt"), [{ type: "chat.interrupt", chatId: a.chatId }], "only the running chat");
  await env.browser.commands.onCommand.fire("stop-agents");
  env.popup().send({ cmd: "stop" });
  await wait(20);
  assert.equal(env.sentToHost("chat.interrupt").length, 3);
  // Once the turn is over there is nothing left to interrupt.
  await env.host({ type: "chat.event", chatId: a.chatId, event: { kind: "status", status: "idle" } });
  await a.send("stopAll");
  assert.equal(env.sentToHost("chat.interrupt").length, 3);
});

test("the panel's Resume undoes Stop all agents completely: the toolbar and the next chat aren't left paused", async () => {
  const env = await load();
  const a = await env.panel();
  await a.send("chat.send", { engine: "claude", text: "hi" });
  await env.callTool("tabs_context_mcp", {}, a.chatId, { id: 9, name: "claude" });
  await a.send("stopAll");
  await wait(120);
  assert.equal(env.browser.action.icon, "icons/toolbar-paused-light.svg");
  await a.send("resume");
  await wait(120);
  assert.notEqual(env.browser.action.icon, "icons/toolbar-paused-light.svg", "no lingering pause-new flag");
  await a.send("chat.new");
  const fresh = a.of("state").at(-1).chatId;
  assert.notEqual(fresh, a.chatId);
  await a.send("chat.send", { chatId: fresh, engine: "claude", text: "again" });
  const reply = await env.callTool("tabs_context_mcp", {}, fresh, { id: 9, name: "claude" });
  assert.doesNotMatch(reply.result.content[0].text, /paused this session/);
});

test("a permission request nobody can see puts a badge on the toolbar button", async () => {
  const env = await load();
  const a = await env.panel();
  const perm = { kind: "permission", requestId: "p1", tool: "Bash", summary: "touch x", always: true };
  await env.host({ type: "chat.event", chatId: a.chatId, event: perm });
  await wait(120);
  assert.equal(env.browser.action.badge ?? "", "", "the open panel shows it");
  a.close();
  await wait(120);
  assert.equal(env.browser.action.badge, "!");
  assert.match(env.browser.action.title, /waiting for your approval/);
  // Reopening the panel shows the card, so the badge goes.
  const b = await env.panel(10, a.chatId);
  await wait(120);
  assert.equal(env.browser.action.badge, "");
  b.close();
  await wait(120);
  assert.equal(env.browser.action.badge, "!");
  // Answering it (from a panel) or the turn ending clears it too.
  const c = await env.panel(10, a.chatId);
  await c.send("chat.permission", { requestId: "p1", decision: "deny" });
  c.close();
  await wait(120);
  assert.equal(env.browser.action.badge, "");
  await env.host({ type: "chat.event", chatId: a.chatId, event: { ...perm, requestId: "p2" } });
  await wait(120);
  assert.equal(env.browser.action.badge, "!");
  await env.host({ type: "chat.event", chatId: a.chatId, event: { kind: "status", status: "idle" } });
  await wait(120);
  assert.equal(env.browser.action.badge, "");
});

test("opening a chat from history continues on its own engine and model; terminal sessions are Claude's", async () => {
  const env = await load();
  const a = await env.panel();
  await a.send("chat.open", { chatId: "codex-chat", source: "panel", path: null, engine: "codex", model: "gpt-5.5" });
  const state = a.of("state").at(-1);
  assert.deepEqual([state.chatId, state.engine, state.model], ["codex-chat", "codex", "gpt-5.5"]);
  await a.send("chat.send", { chatId: "codex-chat", text: "more", engine: "codex", model: "gpt-5.5", effort: "" });
  assert.equal(env.sentToHost("chat.send")[0].engine, "codex");
  await a.send("chat.open", { chatId: "term-1", source: "terminal", path: "/p/t.jsonl", engine: "codex", model: "gpt-5.5" });
  assert.deepEqual([a.of("state").at(-1).engine, a.of("state").at(-1).model], ["claude", null]);
  // A chat id that isn't a plain id goes nowhere.
  const before = env.sentToHost("chat.load").length;
  await a.send("chat.open", { chatId: "../../etc/x", source: "panel" });
  await a.send("chat.open", { chatId: "__proto__", source: "panel" });
  assert.equal(env.sentToHost("chat.load").length, before);
  const b = await env.panel(10, "../../etc/x");
  assert.equal(b.chatId, "term-1", "a hello with a bad chat id gets the window's current chat instead");
});

test("the host being down is flagged in the offline answers, and panels are told when it comes back", async () => {
  const env = await load();
  const a = await env.panel();
  await env.browser.native.onDisconnect.fire();
  await a.send("chat.capabilities", { requestId: "c", engine: "claude" });
  assert.equal(a.of("chat.capabilities").at(-1).hostDown, true);
  await wait(2200); // the reconnect timer
  assert.equal(a.of("hostUp").length, 1);
});

// ---------------------------------------------------------------------------------------------
// Tab group state icons

const chatEvent = (env, chatId, event) => env.host({ type: "chat.event", chatId, event });
const clientEvent = (env, event, client) => env.browser.native.onMessage.fire({ type: "client", event, client });

test("a terminal session's group shows idle, working, paused and disconnected", async () => {
  const env = await load();
  const { browser } = env;
  await clientEvent(env, "connected", { id: 1, name: "claude-code", pid: 9, cwd: "/p" });
  await env.callTool("tabs_create_mcp", {}, "s1", { id: 1, name: "claude-code" });
  await wait(120);
  assert.equal(browser.icons.get(100), "working", "a call in the last few seconds");
  assert.equal(browser.groups.get(100).title, "Claude");
  await wait(3100);
  assert.equal(browser.icons.get(100), "idle", "connected and nothing running");

  // Stop wins over what the session was doing.
  await env.callTool("tabs_context_mcp", {}, "s1", { id: 1, name: "claude-code" });
  await browser.commands.onCommand.fire("stop-agents");
  await wait(120);
  assert.equal(browser.icons.get(100), "paused");
  env.popup().send({ cmd: "resumeAll" });
  await wait(120);
  assert.equal(browser.icons.get(100), "working");

  // The MCP client exiting leaves a group with nobody behind it, even mid-"working".
  await clientEvent(env, "disconnected", { id: 1 });
  await wait(120);
  assert.equal(browser.icons.get(100), "disconnected");
  await clientEvent(env, "connected", { id: 1, name: "claude-code", pid: 9, cwd: "/p" });
  await wait(120);
  assert.notEqual(browser.icons.get(100), "disconnected");
});

test("a client the user disconnected shows as disconnected, not working", async () => {
  const env = await load();
  await clientEvent(env, "connected", { id: 4, name: "Claude Code", pid: 1, cwd: "/" });
  await env.callTool("tabs_create_mcp", {}, "s1", { id: 4, name: "Claude Code" });
  env.popup().send({ cmd: "disconnect", clientId: 4 });
  await wait(150);
  assert.equal(env.browser.icons.get(100), "disconnected");
});

test("a chat's group shows needs-you, working, done and idle, and stays connected without a client", async () => {
  const env = await load();
  const a = await env.panel();
  await a.send("chat.send", { engine: "claude", text: "hi" });
  const { icons, tabsMap } = env.browser;
  await chatEvent(env, a.chatId, { kind: "status", status: "running" });
  await env.callTool("tabs_context_mcp", {}, a.chatId, { id: 9, name: "claude-code (sidebar)" });
  await wait(120);
  assert.equal(icons.get(100), "working");
  // The process idled out and its MCP client left; the chat is still there.
  await clientEvent(env, "disconnected", { id: 9 });
  await chatEvent(env, a.chatId, { kind: "permission", requestId: "r1", tool: "Bash", summary: "rm x" });
  await wait(120);
  assert.equal(icons.get(100), "needs");
  await chatEvent(env, a.chatId, { kind: "tool_start", toolUseId: "t", name: "Bash", summary: "x" });
  await chatEvent(env, a.chatId, { kind: "result", ok: true });
  await wait(3300);
  assert.equal(icons.get(100), "idle", "the panel was showing the chat when the turn finished");

  // With the panel closed, the next turn finishes unseen.
  a.close();
  await wait(20);
  await chatEvent(env, a.chatId, { kind: "status", status: "running" });
  await chatEvent(env, a.chatId, { kind: "result", ok: true });
  await wait(150);
  assert.equal(icons.get(100), "done");
  // Showing the chat in a panel is looking at it.
  const b = await env.panel(10, a.chatId);
  await wait(150);
  assert.equal(icons.get(100), "idle");
  b.close();
  await wait(20);

  // As is switching to a tab in its group, but not a tab Firefox opened for a page.
  await chatEvent(env, a.chatId, { kind: "result", ok: true });
  await wait(150);
  assert.equal(icons.get(100), "done");
  tabsMap.set(6, { id: 6, windowId: 10, groupId: 100, active: true, url: "https://x.example/", status: "complete", title: "x" });
  await env.browser.tabs.onActivated.fire({ tabId: 6, windowId: 10 });
  await wait(150);
  assert.equal(icons.get(100), "idle");

  // A new turn clears it, and a turn the user interrupted isn't news.
  await chatEvent(env, a.chatId, { kind: "result", ok: true });
  await wait(150);
  assert.equal(icons.get(100), "done");
  await chatEvent(env, a.chatId, { kind: "status", status: "running" });
  await wait(150);
  assert.equal(icons.get(100), "idle");
  await chatEvent(env, a.chatId, { kind: "result", ok: false, error: "Interrupted" });
  await wait(150);
  assert.equal(icons.get(100), "idle");
});

test("an old transcript's results don't mark a chat done", async () => {
  const env = await load();
  const a = await env.panel();
  await a.send("chat.open", { chatId: "old-chat", source: "panel", engine: "claude" });
  const ask = env.sentToHost("chat.load")[0];
  await env.host({ type: "chat.transcript", requestId: ask.requestId, chatId: "old-chat", items: [{ kind: "user", text: "q" }, { kind: "result", ok: true }], done: true });
  a.close();
  await wait(150);
  const b = await env.panel(10, a.chatId);
  await b.send("chat.send", { engine: "claude", text: "hi" });
  await wait(150);
  assert.notEqual(env.browser.icons.get(100), "done");
});

test("without the icon, the state goes in the title as a glyph, and comes out again", async () => {
  const env = await load({ noIcons: true });
  const { browser } = env;
  const title = () => browser.groups.get(100).title;
  await clientEvent(env, "connected", { id: 1, name: "claude-code", pid: 9, cwd: "/p" });
  await env.callTool("tabs_create_mcp", {}, "s1", { id: 1, name: "claude-code" });
  await wait(120);
  assert.equal(title(), "● Claude");
  await browser.commands.onCommand.fire("stop-agents");
  await wait(120);
  assert.equal(title(), "○ Claude");
  await clientEvent(env, "disconnected", { id: 1 });
  await wait(120);
  assert.equal(title(), "⊖ Claude");

  // The experiment starts finding the label again: the glyph goes, the icon comes.
  browser.claudePage.setGroupState = async (id, state) => (browser.icons.set(id, state), true);
  env.popup().send({ cmd: "resumeAll" });
  await wait(150);
  assert.equal(title(), "Claude");
  assert.equal(browser.icons.get(100), "disconnected");
});

test("chat states in the fallback: needs-you and done glyphs, idle has none", async () => {
  const env = await load({ iconsThrow: true });
  const a = await env.panel();
  await a.send("chat.send", { engine: "codex", text: "hi" });
  const title = () => env.browser.groups.get(100).title;
  await wait(150);
  assert.equal(title(), "Codex", "idle has no glyph");
  await chatEvent(env, a.chatId, { kind: "permission", requestId: "r1", tool: "Bash", summary: "x" });
  await wait(150);
  assert.equal(title(), "◉ Codex");
  a.close();
  await chatEvent(env, a.chatId, { kind: "result", ok: true });
  await wait(150);
  assert.equal(title(), "✓ Codex");
  assert.equal([...env.browser.groups.values()][0].color, "grey");
});

test("restart finds groups titled with glyphs or the old suffixes, and shows them as earlier", async () => {
  const groups = () => [
    { id: 1, title: "◌ Claude" },
    { id: 2, title: "○ Codex 2" },
    { id: 3, title: "✓ Goose" },
    { id: 4, title: "Codex (paused)" },
    { id: 5, title: "Goose 3 (earlier)" },
    { id: 6, title: "● Shopping" },
    { id: 7, title: "◌ Unknown" },
    { id: 8, title: "Claude ○" },
  ];
  const store = () => ({ groupLabels: ["Claude", "Codex", "Goose"] });
  const drawn = await load({ store: store(), groups: groups() });
  assert.deepEqual(
    [...drawn.browser.groups.values()].map((g) => [g.title, g.color]),
    [["Claude", "grey"], ["Codex", "grey"], ["Goose", "grey"], ["Codex", "grey"], ["Goose", "grey"], ["● Shopping", undefined], ["◌ Unknown", undefined], ["Claude ○", undefined]],
  );
  assert.deepEqual([...drawn.browser.icons.keys()], [1, 2, 3, 4, 5]);

  const fallback = await load({ store: store(), groups: groups(), noIcons: true });
  assert.deepEqual(
    [...fallback.browser.groups.values()].map((g) => g.title),
    ["◌ Claude", "◌ Codex", "◌ Goose", "◌ Codex", "◌ Goose", "● Shopping", "◌ Unknown", "Claude ○"],
  );
});

test("earlier groups keep their icon while the session's own groups change around them", async () => {
  const env = await load({ store: { groupLabels: ["Claude"] }, groups: [{ id: 50, title: "Claude" }] });
  await env.callTool("tabs_create_mcp");
  await wait(150);
  assert.equal(env.browser.icons.get(50), "earlier");
  assert.equal(env.browser.icons.get(100), "working");
  assert.equal(env.browser.groups.get(100).title, "Claude", "a live group isn't taken for an orphan");
  // A group moved to another window is a new element there; its icon is drawn again.
  env.browser.icons.delete(50);
  await env.browser.tabGroups.onMoved.fire({ id: 50 });
  await wait(150);
  assert.equal(env.browser.icons.get(50), "earlier");
});

// Types into the address bar like Firefox: input starts, changes, then the chosen suggestion is entered.
async function omniType(env, text) {
  const { omnibox } = env.browser;
  await omnibox.onInputStarted.fire();
  let got = null;
  await omnibox.onInputChanged.fire(text, (s) => (got = s));
  await wait(20);
  return got;
}

test("c <task> starts a chat on the current tab and shows it in the sidebar", async () => {
  const env = await load({ store: { chatPrefs: { engine: "codex", codex: { model: "gpt-x", effort: "high" } } } });
  const { browser } = env;
  const hist = [1, 2, 3].map((n) => ({ id: `h${n}`, title: `Chat ${n}`, updatedAt: Date.now() - n * 86400000, engine: "claude", model: null, source: "panel", path: null }));
  const typing = omniType(env, "find flights");
  await wait(10);
  const rid = env.sentToHost("chat.history")[0].requestId;
  await env.host({ type: "chat.history", requestId: rid, chats: hist });
  const suggestions = plain(await typing);
  assert.match(browser.action.defaultSuggestion.description, /find flights .* Start a Codex task/);
  assert.equal(suggestions.length, 2, "two recent chats");
  assert.match(suggestions[0].description, /Resume .Chat 1. .* Yesterday/);

  const p = await env.panel();
  const entering = browser.omnibox.onInputEntered.fire("find flights", "currentTab");
  assert.equal(browser.action.toggles, 1, "the sidebar opens in the handler's own call stack");
  await entering;
  await wait(50);
  const send = env.sentToHost("chat.send")[0];
  assert.deepEqual([send.engine, send.model, send.effort, send.text], ["codex", "gpt-x", "high", "find flights"]);
  assert.equal([...browser.groups.values()][0].title, "Codex");
  assert.equal(browser.tabsMap.get(1).groupId, 100, "the tab being viewed joins the chat's group");
  assert.deepEqual(send.context.tabs.map((t) => t.tabId), [1]);
  assert.equal(p.of("state").at(-1).chatId, send.chatId, "the panel switches to the new chat");
});

test("c <task> on a tab in a chat's group continues that chat", async () => {
  const env = await load();
  const a = await env.panel();
  await a.send("chat.send", { engine: "claude", text: "hi" });
  await wait(50);
  await env.browser.omnibox.onInputEntered.fire("and then?", "currentTab");
  await wait(50);
  const sends = env.sentToHost("chat.send");
  assert.deepEqual(sends.map((m) => [m.chatId, m.text]), [[a.chatId, "hi"], [a.chatId, "and then?"]]);
  assert.equal(env.browser.groups.size, 1);
});

test("a tab Teach is recording isn't taken by a chat; the chat gets a blank tab", async () => {
  const env = await load();
  const a = await env.panel();
  await a.send("teach.start");
  await env.browser.omnibox.onInputEntered.fire("summarize", "currentTab");
  await wait(50);
  assert.equal(env.browser.tabsMap.get(1).groupId, -1, "the recorded tab stays the user's");
  assert.equal(env.sentToHost("chat.send")[0].context.tabs.length, 1);
  assert.notEqual(env.sentToHost("chat.send")[0].context.tabs[0].tabId, 1);
});

test("an omnibox task that finishes unseen notifies once and the click shows its group", async () => {
  const env = await load();
  const { browser } = env;
  await browser.omnibox.onInputEntered.fire("book it", "currentTab");
  await wait(50);
  const chatId = env.sentToHost("chat.send")[0].chatId;
  browser.tabsMap.get(1).active = false; // the user moved to another tab
  await chatEvent(env, chatId, { kind: "status", status: "running" });
  await chatEvent(env, chatId, { kind: "text", messageId: "m", text: "## JetBlue 916, Fri 7:05 am\nMore detail." });
  await chatEvent(env, chatId, { kind: "result", ok: true });
  await wait(50);
  assert.deepEqual(plain(browser.notifications.shown.map(({ id, title, message }) => ({ id, title, message }))), [{ id: `omni-${chatId}`, title: "Claude finished", message: "JetBlue 916, Fri 7:05 am" }]);
  await browser.notifications.onClicked.fire(`omni-${chatId}`);
  await wait(20);
  assert.equal(browser.tabsMap.get(1).active, true);
  assert.deepEqual(browser.notifications.cleared, [`omni-${chatId}`]);
});

test("no notification for sidebar chats, or when the user is on the group's tab", async () => {
  const env = await load();
  const a = await env.panel();
  await a.send("chat.send", { engine: "claude", text: "hi" });
  a.close();
  await wait(20);
  await chatEvent(env, a.chatId, { kind: "result", ok: true });
  await wait(50);
  await env.browser.omnibox.onInputEntered.fire("task", "currentTab");
  await wait(50);
  const chatId = env.sentToHost("chat.send").at(-1).chatId;
  await chatEvent(env, chatId, { kind: "result", ok: true });
  await wait(50);
  assert.equal(env.browser.notifications.shown.length, 0);
});

test("choosing a recent chat opens the sidebar on it", async () => {
  const env = await load();
  const typing = omniType(env, "");
  await wait(10);
  await env.host({ type: "chat.history", requestId: env.sentToHost("chat.history")[0].requestId, chats: [{ id: "h1", title: "Denver trip", updatedAt: Date.now(), engine: "claude", source: "panel", path: null }] });
  const [resume] = plain(await typing);
  assert.match(resume.description, /Denver trip.* Today/);
  const opening = env.browser.omnibox.onInputEntered.fire(resume.content, "currentTab");
  assert.equal(env.browser.action.toggles, 1, "the sidebar opens in the handler's own call stack, before anything is awaited");
  const p = await env.panel();
  await opening;
  await wait(300);
  assert.equal(p.of("state").at(-1).chatId, "h1");
});

// ---- Open chats and the panel's keys

test("panels are told the open chats, with each one's state, title and tabs", async () => {
  const env = await load();
  const a = await env.panel();
  assert.deepEqual(a.of("chats")[0].chats, [], "an untouched chat isn't open yet");
  await a.send("chat.send", { engine: "claude", text: "find   flights" });
  await chatEvent(env, a.chatId, { kind: "user", text: "find   flights" });
  await chatEvent(env, a.chatId, { kind: "status", status: "running" });
  await wait(200);
  const [c] = a.of("chats").at(-1).chats;
  assert.deepEqual([c.id, c.title, c.state, c.tabs.map((t) => t.tabId)], [a.chatId, "find flights", "working", [1]]);
  await chatEvent(env, a.chatId, { kind: "title", title: "Flights to Denver" });
  await chatEvent(env, a.chatId, { kind: "permission", requestId: "p1", tool: "Bash" });
  await wait(200);
  assert.deepEqual([a.of("chats").at(-1).chats[0].title, a.of("chats").at(-1).chats[0].state], ["Flights to Denver", "needs"]);
});

test("closing a chat ends its turn, frees its tabs and moves the panel to the next chat", async () => {
  const env = await load();
  const a = await env.panel();
  const first = a.chatId;
  await a.send("chat.send", { engine: "claude", text: "one" });
  await chatEvent(env, first, { kind: "user", text: "one" });
  await a.send("chat.new");
  const second = a.of("state").at(-1).chatId;
  await a.send("chat.send", { engine: "claude", text: "two" });
  await chatEvent(env, second, { kind: "user", text: "two" });
  await chatEvent(env, second, { kind: "status", status: "running" });
  await a.send("chat.close", { chatId: second });
  await wait(200);
  assert.deepEqual(env.sentToHost("chat.interrupt").map((m) => m.chatId), [second]);
  assert.equal(a.of("state").at(-1).chatId, first);
  assert.deepEqual(a.of("chats").at(-1).chats.map((c) => c.id), [first]);
  assert.equal([...env.browser.tabsMap.values()].filter((t) => t.groupId !== -1 && t.groupId !== env.browser.tabsMap.get(1).groupId).length, 0, "the closed chat's tabs left their group");
  // What its engine says afterwards doesn't bring it back.
  await chatEvent(env, second, { kind: "result", ok: false, error: "Interrupted" });
  await wait(200);
  assert.deepEqual(a.of("chats").at(-1).chats.map((c) => c.id), [first]);
});

test("a panel key opens the sidebar and reaches its panel; focus goes through the experiment", async () => {
  const env = await load();
  const a = await env.panel();
  const focused = [];
  env.browser.claudePage.focusPanel = async (...args) => focused.push(args);
  const pressed = env.browser.commands.onCommand.fire("session-2");
  assert.equal(env.browser.action.toggles, 1, "opened in the command's own call stack");
  await pressed;
  await wait(50);
  assert.deepEqual(a.of("key"), [{ type: "key", name: "session-2" }]);
  await a.send("focus", { panel: false });
  assert.deepEqual(focused, [[10, false]]);
  await a.send("focus", { panel: true, opened: true });
  assert.equal(focused.length, 1, "a sidebar restored at startup doesn't take focus");
  await env.browser.commands.onCommand.fire("unknown");
  assert.equal(env.browser.action.toggles, 1);
});

// ---- Redaction

// A session tab whose page answers viewport, and every frame's answer to "capture" from frames.
async function captureEnv(frames) {
  const env = await load();
  await env.callTool("tabs_create_mcp");
  const calls = [];
  const broadcasts = [];
  env.browser.claudePage.call = async (tabId, op, args) => {
    calls.push({ op, args: plain(args) });
    if (op === "viewport") return { width: 1000, height: 800, dpr: 2, scrollX: 0, scrollY: 0, title: "Checkout", url: "https://checkout.acme-supply.com/" };
    return op === "textSize" ? 10 : "done";
  };
  env.browser.claudePage.broadcast = async (tabId, op, args) => {
    broadcasts.push({ op, args: plain(args) });
    return args.on ? frames : frames.map(() => ({ masked: 0 }));
  };
  env.browser.tabs.captureTab = async () => {
    env.captured = (env.captured ?? 0) + 1;
    return "data:image/jpeg;base64,AAAA";
  };
  return { ...env, calls, broadcasts };
}

test("a screenshot is taken with masked fields covered in every frame, and says how many on which site", async () => {
  const env = await captureEnv([
    { masked: 1, site: "acme-supply.com", top: true },
    { masked: 2, site: "stripe.com", top: false },
    null,
  ]);
  const r = await env.callTool("computer", { action: "screenshot", tabId: 2 });
  const content = r.result.content;
  assert.equal(content[0].type, "image");
  assert.match(content[1].text, /^Screenshot of tab 2/);
  assert.deepEqual(plain(content[2]), { type: "text", text: "3 fields masked on acme-supply.com" });
  assert.deepEqual(env.broadcasts.map((b) => [b.op, b.args.on]), [["capture", true], ["capture", false]], "bars drawn before, taken away after");
  assert.deepEqual(env.broadcasts[0].args.redact.always, ["password", "cc-*", "one-time-code", "new-password", "current-password"]);

  const zoom = await env.callTool("computer", { action: "zoom", tabId: 2, region: [0, 0, 100, 100] });
  assert.equal(zoom.result.content.at(-1).text, "3 fields masked on acme-supply.com");
});

test("nothing masked adds no line; a frame that couldn't cover its fields stops the screenshot", async () => {
  const clean = await captureEnv([{ masked: 0, site: "example.com", top: true }]);
  const r = await clean.callTool("computer", { action: "screenshot", tabId: 2 });
  assert.equal(r.result.content.length, 2);

  const env = await captureEnv([{ masked: 1, site: "acme-supply.com", top: true }, { error: "Actor destroyed" }]);
  const bad = await env.callTool("computer", { action: "screenshot", tabId: 2 });
  assert.equal(bad.result.isError, true);
  assert.match(bad.result.content[0].text, /Could not cover sensitive fields before the screenshot \(Actor destroyed\)/);
  assert.equal(env.captured, undefined, "nothing was captured");
  assert.equal(env.broadcasts.at(-1).args.on, false, "the frames that did draw bars took them away");
});

test("captures of one tab never overlap, so one's cleanup can't uncover another's capture", async () => {
  const env = await captureEnv([{ masked: 1, site: "acme-supply.com", top: true }]);
  const log = [];
  env.browser.claudePage.broadcast = async (tabId, op, args) => {
    log.push(args.on ? "on" : "off");
    await wait(5);
    return [{ masked: 1, site: "acme-supply.com", top: true }];
  };
  env.browser.tabs.captureTab = async () => {
    log.push("capture");
    await wait(20);
    return "data:image/jpeg;base64,AAAA";
  };
  const shots = await Promise.all([
    env.callTool("computer", { action: "screenshot", tabId: 2 }),
    env.callTool("computer", { action: "zoom", tabId: 2, region: [0, 0, 10, 10] }),
  ]);
  for (const s of shots) assert.equal(s.result.content.at(-1).text, "1 field masked on acme-supply.com");
  assert.deepEqual(log, ["on", "capture", "off", "on", "capture", "off"]);
  // A failed capture doesn't hold up the next one.
  env.browser.tabs.captureTab = async () => {
    throw new Error("gone");
  };
  assert.equal((await env.callTool("computer", { action: "screenshot", tabId: 2 })).result.isError, true);
  env.browser.tabs.captureTab = async () => "data:image/jpeg;base64,AAAA";
  assert.equal((await env.callTool("computer", { action: "screenshot", tabId: 2 })).result.content[0].type, "image");
});

test("the host's rules go to every page op, and a masked result gets its own line", async () => {
  const env = await captureEnv([]);
  const rules = { always: ["password"], sites: { "chase.com": [".account-number"] } };
  await env.host({ type: "redact", rules });
  env.browser.claudePage.call = async (tabId, op, args) => {
    env.calls.push({ op, args: plain(args) });
    if (op === "viewport") return { width: 1000, height: 800, dpr: 1, scrollX: 0, scrollY: 0 };
    return { text: "Title: Accounts\n\ntext [redacted: account-number, filled]", masked: { count: 1, site: "chase.com" } };
  };
  const r = await env.callTool("get_page_text", { tabId: 2 });
  assert.deepEqual(env.calls.find((c) => c.op === "text").args.redact, rules);
  assert.deepEqual(plain(r.result.content), [
    { type: "text", text: "Title: Accounts\n\ntext [redacted: account-number, filled]" },
    { type: "text", text: "1 field masked on chase.com" },
  ]);
  // find runs in every frame at once; each answers its matches and what it masked.
  env.browser.claudePage.broadcast = async (tabId, op, args) => {
    env.calls.push({ op, args: plain(args) });
    return [{ matches: [{ score: 3, line: 'textbox "Account" [ref_1] value=[redacted: account-number, filled]' }], rest: [], masked: { count: 1, site: "chase.com" } }];
  };
  for (const tool of ["read_page", "find", "form_input", "javascript_tool"]) {
    const out = await env.callTool(tool, { tabId: 2, ref: "ref_1", value: "x", query: "q", text: "1" });
    assert.equal(out.result.content.at(-1).text, "1 field masked on chase.com", tool);
  }
  assert.deepEqual(env.calls.findLast((c) => c.op === "find").args.redact, rules, "find's broadcast carries the rules too");
  // A malformed rules message leaves the rules as they were.
  await env.host({ type: "redact", rules: { always: "password" } });
  await env.callTool("get_page_text", { tabId: 2 });
  assert.deepEqual(env.calls.findLast((c) => c.op === "text").args.redact, rules);
});

test("an open panel arms the tab its window is showing for point and ask; closing it disarms", async () => {
  const env = await load();
  const armed = [];
  env.browser.claudePage.setPointTabs = async (ids) => armed.push([...ids]);
  const a = await env.panel();
  await wait(100);
  assert.deepEqual(armed.at(-1), [1]);
  // Another tab comes forward. Pages that aren't web pages aren't armed.
  env.browser.tabsMap.get(1).active = false;
  env.browser.tabsMap.set(5, { id: 5, windowId: 10, groupId: -1, active: true, url: "about:preferences", status: "complete", title: "Settings" });
  await env.browser.tabs.onActivated.fire({ tabId: 5, windowId: 10 });
  await wait(100);
  assert.deepEqual(armed.at(-1), []);
  env.browser.tabsMap.get(5).url = "https://five.example/";
  await env.browser.tabs.onUpdated.fire(5, { url: "https://five.example/" }, { ...env.browser.tabsMap.get(5) });
  await wait(100);
  assert.deepEqual(armed.at(-1), [5]);
  // Alt let go in the panel arms again, which takes a leftover outline down.
  const before = armed.length;
  await a.send("point.clear");
  await wait(100);
  assert.equal(armed.length, before + 1);
  a.close();
  await wait(100);
  assert.deepEqual(armed.at(-1), []);
});

test("an Alt+click becomes an attachment: a crop of the element, and its ref in the message's context", async () => {
  const env = await load();
  const calls = [];
  env.browser.claudePage.call = async (tabId, op, args) => {
    calls.push(plain([tabId, op, args]));
    if (op === "pickInfo") return { name: "Weekly signups", text: "Nov Jan Mar" };
    return op === "viewport" ? { width: 1000, height: 800, dpr: 2, scrollX: 0, scrollY: 300, screenX: 100, screenY: 50 } : "done";
  };
  const captures = [];
  env.browser.tabs.captureTab = async (tabId, opts) => {
    captures.push([tabId, plain(opts)]);
    return "data:image/png;base64,AAAA";
  };
  const broadcasts = [];
  env.browser.claudePage.broadcast = async (tabId, op, args) => {
    broadcasts.push([tabId, op, args.on]);
    return [{ masked: 0, site: "user.example", top: true }];
  };
  const a = await env.panel();
  // An element in a child frame whose viewport is 20px right of and 40px below the tab's.
  const pick = { ref: "ref_3@f12", role: "figure", name: "Weekly signups", text: "Nov Jan Mar", rect: { x: 10, y: 20, width: 200, height: 100 }, frame: { x: 120, y: 90 }, url: "https://user.example/", title: "user" };
  await env.browser.claudePage.onPick.fire(1, pick);
  await wait(50);
  assert.deepEqual(captures, [[1, { format: "png", scale: 2, rect: { x: 30, y: 360, width: 200, height: 100 } }]]);
  const element = { tabId: 1, ref: "ref_3@f12", role: "figure", name: "Weekly signups", text: "Nov Jan Mar" };
  assert.deepEqual(a.of("pick"), [{ type: "pick", chatId: a.chatId, element: { ...element, image: "data:image/png;base64,AAAA" } }]);
  assert.equal(env.browser.tabsMap.get(1).groupId, 100, "the tab starts the chat's group");
  assert.deepEqual(calls.map(([, op]) => op), ["pickInfo", "viewport", "pointAdded"]);
  assert.deepEqual(calls[0][2], { ref: "ref_3@f12", redact: { always: ["password", "cc-*", "one-time-code", "new-password", "current-password"], sites: {} } }, "name and text are read again with the redaction rules");
  assert.deepEqual(broadcasts, [[1, "capture", true], [1, "capture", false]], "the crop is taken with the cursor hidden and masked fields covered");
  assert.equal(calls.at(-1)[2].ref, "ref_3@f12", "the outline comes back in the element's frame");

  await a.send("chat.send", { engine: "claude", text: "why did this drop?", elements: [a.of("pick")[0].element, { tabId: 1, ref: "javascript:x" }] });
  assert.deepEqual(env.sentToHost("chat.send")[0].context.elements, [element]);

  // What the page said the element holds never goes out; only what the redacted read says.
  env.browser.claudePage.call = async (tabId, op) => {
    if (op === "pickInfo") return { name: "Card number", text: "[redacted: cc-number, filled]" };
    return op === "viewport" ? { width: 1000, height: 800, dpr: 2, scrollX: 0, scrollY: 0, screenX: 0, screenY: 0 } : "done";
  };
  await env.browser.claudePage.onPick.fire(1, { ...pick, ref: "ref_4", role: "textbox", name: "Card number", text: "4111 1111 1111 1111" });
  await wait(50);
  assert.equal(a.of("pick").at(-1).element.text, "[redacted: cc-number, filled]");
  // If the redacted read fails, the name and text are left out.
  env.browser.claudePage.call = async (tabId, op) => {
    if (op === "pickInfo") throw new Error("ref_5 is gone");
    return op === "viewport" ? { width: 1000, height: 800, dpr: 2, scrollX: 0, scrollY: 0, screenX: 0, screenY: 0 } : "done";
  };
  await env.browser.claudePage.onPick.fire(1, { ...pick, ref: "ref_5", name: "Secret", text: "4111 1111 1111 1111" });
  await wait(50);
  assert.deepEqual([a.of("pick").at(-1).element.name, a.of("pick").at(-1).element.text], ["", ""]);
  const picks = a.of("pick").length;

  // A window without a panel, and a ref that isn't one, go nowhere.
  env.browser.tabsMap.set(7, { id: 7, windowId: 12, groupId: -1, active: true, url: "https://seven.example/", status: "complete", title: "seven" });
  await env.browser.claudePage.onPick.fire(7, pick);
  await env.browser.claudePage.onPick.fire(1, { ...pick, ref: "<b>" });
  await wait(50);
  assert.equal(a.of("pick").length, picks);
  assert.equal(captures.length, 3);
});

test("a pick in a child frame is cropped where the frame measures to sit, not where the frame says it is on screen", async () => {
  const env = await load();
  env.browser.claudePage.call = async (tabId, op) => {
    if (op === "pickInfo") return { name: "Choose a pet:", text: "" };
    return op === "viewport" ? { width: 1000, height: 800, dpr: 2, scrollX: 0, scrollY: 300, screenX: 100, screenY: 50 } : "done";
  };
  const asked = [];
  env.browser.claudePage.frameOffset = async (tabId, frameId) => (asked.push([tabId, frameId]), { x: 826, y: 357, scale: 0.5 });
  const captures = [];
  env.browser.tabs.captureTab = async (tabId, opts) => {
    captures.push([tabId, plain(opts)]);
    return "data:image/png;base64,AAAA";
  };
  env.browser.claudePage.broadcast = async () => [{ masked: 0, site: "user.example", top: true }];
  await env.panel();
  // The frame's own place on screen (8, 46) is what an out-of-process frame reported on MDN.
  const pick = { ref: "ref_1@f12", role: "combobox", name: "Choose a pet:", text: "", rect: { x: 10, y: 20, width: 200, height: 100 }, frame: { x: 8, y: 46 }, url: "https://live.mdnplay.dev/", title: "" };
  await env.browser.claudePage.onPick.fire(1, pick);
  await wait(50);
  assert.deepEqual(asked, [[1, 12]]);
  assert.deepEqual(captures, [[1, { format: "png", scale: 2, rect: { x: 831, y: 667, width: 100, height: 50 } }]]);
});

test("an element link outlines the element in its tab, only in the chat's group; a click brings the tab forward", async () => {
  const env = await load();
  const calls = [];
  env.browser.claudePage.call = async (tabId, op, args) => {
    if (op !== "mark") return op === "textSize" ? 10 : "done";
    const { redact, ...rest } = args;
    calls.push(plain([tabId, rest]));
    if (args.ref === "ref_9") throw new Error("ref_9 is gone");
    return true;
  };
  const a = await env.panel();
  await a.send("chat.send", { engine: "claude", text: "hi" });
  env.browser.tabsMap.set(5, { id: 5, windowId: 10, groupId: 100, active: false, url: "https://five.example/", status: "complete", title: "five" });
  await a.send("mark", { tabId: 5, ref: "ref_2", label: "Mar 4 annotation" });
  await a.send("mark", { tabId: 5, ref: "ref_2", clear: true });
  assert.deepEqual(calls, [
    [5, { ref: "ref_2", label: "Mar 4 annotation", reveal: false, clear: false }],
    [5, { ref: "ref_2", label: "", reveal: false, clear: true }],
  ]);
  assert.equal(env.browser.tabsMap.get(5).active, false, "pointing doesn't switch tabs");
  await a.send("mark", { tabId: 5, ref: "ref_2", label: "Mar 4 annotation", reveal: true });
  assert.equal(env.browser.tabsMap.get(5).active, true);
  assert.equal(calls.at(-1)[1].reveal, true);

  env.browser.tabsMap.set(6, { id: 6, windowId: 10, groupId: -1, active: false, url: "https://six.example/", status: "complete", title: "six" });
  await a.send("mark", { tabId: 6, ref: "ref_2", reveal: true });
  await a.send("mark", { tabId: 5, ref: "ref_9", reveal: true });
  await a.send("mark", { tabId: 5, ref: "ref_9" });
  await a.send("mark", { tabId: 5, ref: "javascript:alert(1)", reveal: true });
  assert.deepEqual(a.of("markFailed").map((m) => m.error), ["That tab isn't in this chat's group.", "That element isn't on the page any more."]);
  assert.equal(calls.filter(([tabId]) => tabId === 6).length, 0);
});

test("the agent cam's frame comes with where masked fields are, in every frame, without drawing on the page", async () => {
  const env = await load();
  const rules = { always: ["password"], sites: {} };
  await env.host({ type: "redact", rules });
  const captures = [];
  env.browser.tabs.captureTab = async (tabId, opts) => {
    captures.push([tabId, plain(opts)]);
    return "data:image/jpeg;base64,AAAA";
  };
  // The top frame is 1000x500 at (100, 50) on screen; a card iframe's viewport sits at (400, 250)
  // in it. The password field scrolls 10px up between the two looks.
  const looks = [];
  let scrolled = 0;
  env.browser.claudePage.broadcast = async (tabId, op, args) => {
    looks.push([tabId, op, plain(args)]);
    const y = 100 - scrolled;
    scrolled += 10;
    return [
      { rects: [{ x: 100, y, width: 200, height: 20, label: "password · filled" }], screenX: 100, screenY: 50, width: 1000, height: 500, top: true },
      { rects: [{ x: 0, y: 0, width: 100, height: 25, label: "card number · empty" }], screenX: 500, screenY: 300, width: 300, height: 100, top: false },
      null,
    ];
  };
  const a = await env.panel();
  await a.send("chat.send", { engine: "claude", text: "hi" });
  await a.send("cam.frame", { tabId: 1, scale: 0.25, requestId: "cam1" });
  assert.deepEqual(captures, [[1, { format: "jpeg", quality: 60, scale: 0.25 }]]);
  assert.deepEqual(looks.map(([tabId, op, args]) => [tabId, op, args.redact]), [
    [1, "maskRects", rules],
    [1, "maskRects", rules],
  ], "fields are found before and after the capture; nothing is drawn on the page");
  const [got] = a.of("cam.frame");
  assert.equal(got.requestId, "cam1");
  assert.equal(got.shot, "data:image/jpeg;base64,AAAA");
  const round = (m) => ({ ...m, x: +m.x.toFixed(6), y: +m.y.toFixed(6), width: +m.width.toFixed(6), height: +m.height.toFixed(6) });
  assert.deepEqual(got.masks.map(round), [
    { x: 0.1, y: 0.18, width: 0.2, height: 0.06, label: "password · filled" },
    { x: 0.4, y: 0.5, width: 0.1, height: 0.05, label: "card number · empty" },
  ], "a field that moved is covered over both places; a child frame's boxes land where it is");

  assert.ok(looks.every(([, , args]) => args.frameOffsets === true), "each frame is sent where it sits");

  // Frames that placed their boxes in the top viewport themselves (`placed`): no screen math,
  // whatever the frames' own places on screen say.
  env.browser.claudePage.broadcast = async () => [
    { rects: [{ x: 100, y: 90, width: 200, height: 20, label: "password · filled" }], placed: true, width: 1000, height: 500, top: true },
    { rects: [{ x: 826, y: 357, width: 100, height: 25, label: "card number · empty" }], placed: true, screenX: 8, screenY: 46, width: 300, height: 100, top: false },
  ];
  await a.send("cam.frame", { tabId: 1, requestId: "cam1b" });
  assert.deepEqual(a.of("cam.frame").at(-1).masks.map(round), [
    { x: 0.1, y: 0.18, width: 0.2, height: 0.04, label: "password · filled" },
    { x: 0.826, y: 0.714, width: 0.1, height: 0.05, label: "card number · empty" },
  ]);

  // A frame that couldn't look: the frame still comes, marked as not safe to keep.
  env.browser.claudePage.broadcast = async () => [{ rects: [], screenX: 0, screenY: 0, width: 1000, height: 500, top: true }, { error: "Actor destroyed" }];
  await a.send("cam.frame", { tabId: 1, requestId: "cam2" });
  assert.equal(a.of("cam.frame")[2].shot, "data:image/jpeg;base64,AAAA");
  assert.equal(a.of("cam.frame")[2].masks, null);
  // Nothing masked is an empty list, not null.
  env.browser.claudePage.broadcast = async () => [{ rects: [], screenX: 0, screenY: 0, width: 1000, height: 500, top: true }];
  await a.send("cam.frame", { tabId: 1, requestId: "cam3" });
  assert.deepEqual(a.of("cam.frame")[3].masks, []);

  // Only tabs in the chat's group.
  env.browser.tabsMap.set(6, { id: 6, windowId: 10, groupId: -1, active: false, url: "https://six.example/", status: "complete", title: "six" });
  await a.send("cam.frame", { tabId: 6, requestId: "cam4" });
  assert.deepEqual(plain(a.of("cam.frame")[4]), { type: "cam.frame", requestId: "cam4", error: "That tab isn't in this chat's group." });
  assert.equal(captures.length, 4);
});

// ---- Teach

test("Teach records the viewed tab: numbered steps with a shot, one step per field, no secrets", async () => {
  const env = await load();
  const a = await env.panel();
  await a.send("teach.start");
  const state = a.of("state").at(-1);
  assert.equal(state.chatId, a.chatId, "an untouched chat is used as it is");
  assert.equal(state.teach.site, "user.example");
  assert.equal(state.teach.start, "https://user.example/");
  assert.equal(env.browser.recorded.get(1), true);
  assert.deepEqual(plain(env.browser.recordRules.always), ["password", "cc-*", "one-time-code", "new-password", "current-password"], "fields the redaction rules mask are recorded like secret ones");
  assert.equal(env.browser.tabsMap.get(1).groupId, -1, "the user's tab isn't grouped");

  const record = (step) => env.browser.claudePage.onRecord.fire(1, step);
  await record({ action: "click", target: { role: "link", name: "Log in", css: "#login", near: "Welcome" }, url: "https://user.example/" });
  await record({ action: "type", target: { role: "textbox", name: "Library card" }, field: "f1", value: "12" });
  await record({ action: "type", target: { role: "textbox", name: "Library card" }, field: "f1", value: "1234" });
  await record({ action: "type", target: { role: "textbox", name: "PIN" }, field: "f2", secret: "keychain", value: "leaked" });
  await record({ action: "select", target: { role: "combobox", name: "Expiry month" }, secret: "ask", value: "08" });
  await record({ action: "bogus" });
  await env.browser.claudePage.onRecord.fire(99, { action: "click", target: { role: "button", name: "elsewhere" } });
  await wait(30);
  const steps = a.of("teach.step");
  const last = new Map(steps.map((m) => [m.step.n, m.step]));
  assert.deepEqual([...last.keys()], [1, 2, 3, 4]);
  assert.equal(last.get(2).value, "1234");
  assert.equal(last.get(3).secret, "keychain");
  assert.equal(last.get(3).value, undefined, "a secret field's value is never kept");
  assert.deepEqual([last.get(4).secret, last.get(4).value], ["ask", undefined], "nor a masked select's");
  const shot = steps.find((m) => m.shot && m.step.n === 1).shot;
  assert.match(Buffer.from(shot.split(",")[1], "base64").toString(), /shot of 1 at 0.5/, "400px wide from an 800px tab");

  // An Alt+click in the recorded tab attaches nothing and doesn't group the user's tab.
  await env.browser.claudePage.onPick.fire(1, { ref: "ref_1", role: "button", name: "x", text: "", rect: { x: 0, y: 0, width: 10, height: 10 }, frame: { x: 0, y: 0 } });
  await wait(50);
  assert.equal(a.of("pick").length, 0);
  assert.equal(env.browser.tabsMap.get(1).groupId, -1);

  // A load that follows a click is the click's; one long after is its own step.
  env.browser.tabsMap.get(1).status = "loading";
  await env.browser.tabs.onUpdated.fire(1, { url: "https://user.example/account" }, { ...env.browser.tabsMap.get(1) });
  await wait(3400);
  await env.browser.tabs.onUpdated.fire(1, { url: "https://user.example/typed" }, { ...env.browser.tabsMap.get(1) });
  await wait(350);
  const navs = a.of("teach.step").filter((m) => m.step.action === "navigate");
  assert.deepEqual([...new Set(navs.map((m) => m.step.url))], ["https://user.example/typed"]);

  // Stop and draft: the panel that asked gets its request id back, and recording ends.
  const b = await env.panel(10, a.chatId);
  await a.send("teach.stop", { requestId: "r1", draft: true });
  await wait(750);
  const done = a.of("teach").at(-1);
  assert.equal(done.requestId, "r1");
  assert.equal(done.recording.stopped, true);
  assert.equal(done.recording.drafted, true);
  assert.equal(done.recording.steps.length, 5);
  assert.equal(b.of("teach").at(-1).requestId, undefined, "only the asking panel drafts");
  assert.equal(env.browser.recorded.get(1), false);
  await record({ action: "click", target: { role: "button", name: "late" } });
  await wait(30);
  assert.equal(a.of("teach.step").filter((m) => m.step.n === 6).length, 0);
});

test("Teach starts a fresh chat when this one is in use, and refuses agent and non-web tabs", async () => {
  const env = await load();
  const a = await env.panel();
  await env.host({ type: "chat.event", chatId: a.chatId, event: { kind: "status", status: "idle" } });
  await a.send("teach.start");
  const state = a.of("state").at(-1);
  assert.notEqual(state.chatId, a.chatId);
  assert.ok(state.teach);

  // New chat ends a recording that was never drafted.
  await a.send("chat.new");
  assert.equal(env.browser.recorded.get(1), false);
  assert.equal(a.of("state").at(-1).teach, null);

  env.browser.tabsMap.get(1).url = "about:preferences";
  await a.send("teach.start");
  assert.match(a.of("teach").at(-1).error, /Open the page/);
  await env.callTool("tabs_create_mcp");
  env.browser.tabsMap.get(1).active = false;
  Object.assign(env.browser.tabsMap.get(2), { active: true, url: "https://agent.example/" });
  await a.send("teach.start");
  assert.match(a.of("teach").at(-1).error, /agent's tab group/);
});

test("Teach turns don't adopt the viewed tab; saving sends the draft, recording and shots to the host", async () => {
  const env = await load();
  const a = await env.panel();
  await a.send("teach.start");
  const chatId = a.of("state").at(-1).chatId;
  await env.browser.claudePage.onRecord.fire(1, { action: "click", target: { role: "button", name: "Renew all" } });
  await wait(30);
  await a.send("teach.stop", { requestId: "r", draft: true });
  await wait(750);
  const rec = a.of("teach").at(-1).recording;

  await a.send("chat.send", { chatId, engine: "claude", text: "Teach: ...", attachments: [], teach: true });
  assert.equal(env.browser.tabsMap.get(1).groupId, -1);
  assert.deepEqual(env.sentToHost("chat.send")[0].context, { tabs: [] });

  const draft = { name: "renew-books", steps: [{ from: 1, expect: { text: "Renewed" } }] };
  await a.send("teach.save", { requestId: "s1", mode: "skill", draft, recording: rec, replay: false });
  const [save] = env.sentToHost("teach.save");
  assert.equal(save.chatId, chatId);
  assert.equal(save.engine, "claude");
  assert.equal(save.mode, "skill");
  assert.equal(save.replay, false);
  assert.equal(save.replace, false);
  assert.deepEqual(save.draft, draft);
  assert.match(Buffer.from(save.shots[1], "base64").toString(), /shot of 1/);
  await env.host({ type: "teach.saved", requestId: save.requestId, ok: true, dir: "/h/.claude/skills/renew-books" });
  assert.deepEqual(a.of("teach.saved"), [{ type: "teach.saved", requestId: "s1", ok: true, dir: "/h/.claude/skills/renew-books" }]);

  await a.send("teach.discard");
  assert.equal(a.of("teach").at(-1).recording, null);
});

test("teach.save without the host gets a failed answer", async () => {
  const env = await load();
  const a = await env.panel();
  await env.browser.native.onDisconnect.fire();
  await a.send("teach.save", { requestId: "s", mode: "try", draft: { name: "x" }, recording: { id: "r", steps: [] } });
  const reply = a.of("teach.saved")[0];
  assert.equal(reply.ok, false);
  assert.match(reply.error, /not connected/);
});

// A page for replay_steps: `locate` finds the names listed in `present`, and the page text is `text`.
function replayPage(env, { present = [], text = "" } = {}) {
  const ops = [];
  env.browser.claudePage.call = async (tabId, op, args) => {
    ops.push([op, args]);
    if (op === "textSize") return 10;
    if (op === "viewport") return { width: 1000, height: 800, dpr: 2, scrollX: 0, scrollY: 0, title: "t", url: "u" };
    if (op === "locate") return present.includes(args.target.name) ? { ref: `ref_${present.indexOf(args.target.name) + 1}`, how: "role and name" } : { missing: true };
    if (op === "contains") return text.includes(args.text);
    if (op === "readPage") return 'link "Home" [ref_9]';
    return "done";
  };
  return ops;
}

const REPLAY = {
  site: "user.example",
  start: "https://user.example/",
  inputs: ["card", "pin:keychain"],
  steps: [
    { click: { role: "link", name: "Log in" } },
    { type: { role: "textbox", name: "Card" }, text: "{card}" },
    { type: { role: "textbox", name: "PIN", frame: [{ index: 0, url: "https://login.example/" }] }, text: "{pin}", shot: "/skills/x/steps/3.jpg" },
    { key: "Enter" },
    { click: { role: "button", name: "Renew all" }, expect: { text: "Renewed" } },
  ],
};

test("replay_steps runs every step by ref, types inputs, checks expect, and never logs the values", async () => {
  const env = await load();
  await env.callTool("tabs_create_mcp");
  env.browser.tabsMap.get(2).url = "https://user.example/home";
  const ops = replayPage(env, { present: ["Log in", "Card", "PIN", "Renew all"], text: "3 items Renewed" });
  const r = await env.callTool("replay_steps", { tabId: 2, replay: REPLAY, inputs: { card: "1234", pin: "s3cret" } });
  assert.equal(r.result.isError, undefined, r.result.content[0].text);
  assert.match(r.result.content[0].text, /^Replayed all 5 steps; 1 check\(s\) passed/);
  // Every op also carries the redaction rules; that is covered in the redaction tests.
  const acts = ops.filter(([op]) => ["click", "fill", "key"].includes(op)).map(([op, { redact, ...args }]) => [op, args]);
  assert.deepEqual(plain(acts), [
    ["click", { ref: "ref_1" }],
    ["fill", { ref: "ref_2", text: "1234" }],
    ["fill", { ref: "ref_3", frame: [{ index: 0, url: "https://login.example/" }], text: "s3cret" }],
    ["key", { keys: "Enter" }],
    ["click", { ref: "ref_4" }],
  ]);
  assert.equal(env.browser.tabsMap.get(2).url, "https://user.example/home", "already on the site: not sent back to the start");
  const entry = env.popup().last().log.at(-1);
  assert.equal(entry.tool, "replay_steps");
  assert.equal(entry.detail, "5 step(s), 2 input(s)");
  assert.doesNotMatch(JSON.stringify(env.popup().last()), /s3cret|1234/);
});

test("replay_steps stops at the first mismatch with the step, what was expected, its shot and the page", async () => {
  const env = await load();
  await env.callTool("tabs_create_mcp");
  replayPage(env, { present: ["Log in", "Card"] });
  const missing = await env.callTool("replay_steps", { tabId: 2, replay: REPLAY, inputs: { card: "1234" } });
  assert.match(missing.result.content[0].text, /^Replay stopped at step 3 of 5: type into textbox "PIN"\.\nExpected: a value for the input "pin"/);
  assert.equal(env.browser.tabsMap.get(2).url, "https://user.example/", "an empty tab is sent to the recording's start");

  const gone = await env.callTool("replay_steps", { tabId: 2, replay: REPLAY, inputs: { card: "1234", pin: "x" } }, "s1", undefined, 12_000);
  const out = gone.result.content[0].text;
  assert.equal(gone.result.isError, undefined, "a mismatch is an answer, not an error");
  assert.match(out, /^Replay stopped at step 3 of 5/);
  assert.match(out, /Found: nothing like it on the page after 6s\./);
  assert.match(out, /Screenshot of this step when it was recorded: \/skills\/x\/steps\/3\.jpg/);
  assert.match(out, /Steps 1-2 ran\./);
  assert.match(out, /Page \(interactive elements\):\nlink "Home" \[ref_9\]/);
});

// ---------------------------------------------------------------------------------------------
// Firefox's window occluded (on another macOS Space): the page can answer a 0x0 viewport, and
// pages stop getting animation frames unless the window is kept rendering.

const pngOf = (width, height) => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(b);
  b.write("IHDR", 12);
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return `data:image/png;base64,${b.toString("base64")}`;
};

// SOI, a JFIF header, a quantization table, then the start of frame, as Firefox's encoder writes them.
const jpegOf = (width, height) => {
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0, 0, 16]), Buffer.from("JFIF\0"), Buffer.alloc(9)]);
  const dqt = Buffer.concat([Buffer.from([0xff, 0xdb, 0, 67]), Buffer.alloc(65)]);
  const sof = Buffer.from([0xff, 0xc0, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255, 3, ...Buffer.alloc(9)]);
  return `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8]), app0, dqt, sof]).toString("base64")}`;
};

test("a capture's pixel size is read from its PNG or JPEG header", async () => {
  const { ctx } = await load();
  assert.deepEqual(plain(ctx.imageSize(pngOf(1422, 809))), { width: 1422, height: 809 });
  assert.deepEqual(plain(ctx.imageSize(jpegOf(1568, 892))), { width: 1568, height: 892 });
  assert.equal(ctx.imageSize("data:image/jpeg;base64,AAAA"), null);
  assert.equal(ctx.imageSize("not a data url"), null);
  assert.equal(ctx.imageSize(pngOf(0, 0)), null);
});

// A session tab (id 2) whose page answers `viewport` as given, at `zoom`, whose captures are as
// Firefox makes them: `real` CSS pixels times the scale asked for times the zoom.
async function occludedEnv({ viewport, real, zoom = 1, tabSize }) {
  const env = await load();
  await env.callTool("tabs_create_mcp");
  Object.assign(env.browser.tabsMap.get(2), tabSize ?? {});
  const calls = [];
  const scales = [];
  env.browser.claudePage.call = async (tabId, op, args) => {
    calls.push([op, plain(args)]);
    if (op === "viewport") return { ...viewport, dpr: 2 * zoom, scrollX: 0, scrollY: 0, title: "Board", url: "https://app.example/" };
    return op === "textSize" ? 10 : "done";
  };
  env.browser.tabs.getZoom = async () => zoom;
  env.browser.tabs.captureTab = async (tabId, { scale }) => {
    scales.push(scale);
    return jpegOf(Math.round(real.width * scale * zoom), Math.round(real.height * scale * zoom));
  };
  return { ...env, calls, scales };
}

const fit = (w, h) => Math.min(1, 1568 / Math.max(w, h), Math.sqrt(1_150_000 / (w * h)));

test("a page answering a 0x0 viewport gets the tab's size, and clicks map through it", async () => {
  const env = await occludedEnv({ viewport: { width: 0, height: 0 }, real: { width: 1422, height: 809 }, tabSize: { width: 1422, height: 809 } });
  const r = await env.callTool("computer", { action: "screenshot", tabId: 2 });
  assert.equal(r.result.content[0].type, "image");
  const s = fit(1422, 809);
  assert.match(r.result.content[1].text, /^Screenshot of tab 2 \(1422x809\)\./);
  assert.deepEqual(env.scales, [s], "one capture, at the size the tab says");

  const half = await env.callTool("computer", { action: "screenshot", tabId: 2, scale: 0.5 });
  assert.match(half.result.content[1].text, /coordinates still use the full 1422x809 frame/);

  await env.callTool("computer", { action: "left_click", tabId: 2, coordinate: [711, 400] });
  const click = env.calls.find(([op]) => op === "click")[1];
  assert.ok(Math.abs(click.x - 711 / s) < 1e-9 && Math.abs(click.y - 400 / s) < 1e-9);
});

test("with no size known anywhere, the screenshot measures its own capture, zoom divided out", async () => {
  const env = await occludedEnv({ viewport: { width: 0, height: 0 }, real: { width: 2000, height: 1250 }, zoom: 1.5 });
  const r = await env.callTool("computer", { action: "screenshot", tabId: 2 });
  const s = fit(2000, 1250);
  assert.deepEqual(env.scales, [1 / 1.5, s / 1.5], "measured at one pixel per CSS pixel, then taken at the fitted size");
  assert.match(r.result.content[1].text, new RegExp(`^Screenshot of tab 2 \\(${Math.round(2000 * s)}x${Math.round(1250 * s)}\\)\\.`));
  assert.doesNotMatch(r.result.content[1].text, /\b0x0\b/);

  await env.callTool("computer", { action: "left_click", tabId: 2, coordinate: [100, 100] });
  const click = env.calls.find(([op]) => op === "click")[1];
  assert.ok(Math.abs(click.x - 100 / s) < 1e-9, "screenshot pixels map to CSS pixels at any zoom");
});

test("a zoomed tab is captured with the zoom divided out, so the image matches the frame it reports", async () => {
  const env = await occludedEnv({ viewport: { width: 1000, height: 800 }, real: { width: 1000, height: 800 }, zoom: 2 });
  const r = await env.callTool("computer", { action: "screenshot", tabId: 2 });
  assert.deepEqual(env.scales, [0.5]);
  assert.match(r.result.content[1].text, /^Screenshot of tab 2 \(1000x800\)\./);
  await env.callTool("computer", { action: "zoom", tabId: 2, region: [0, 0, 100, 100] });
  assert.equal(env.scales.at(-1), (2 * 2 * 2) / 2, "zoom's scale is divided by the tab's zoom too");
});

test("a stale viewport from the page loses to the size of the image it gave", async () => {
  const env = await occludedEnv({ viewport: { width: 800, height: 600 }, real: { width: 1422, height: 809 } });
  const r = await env.callTool("computer", { action: "screenshot", tabId: 2 });
  assert.match(r.result.content[1].text, /^Screenshot of tab 2 \(1422x809\)\./);
});

test("windows holding a live session's tabs are kept rendering, and let go when the session is gone", async () => {
  const env = await load();
  const kept = [];
  env.browser.claudePage.keepRendering = async (tabIds) => kept.push(plain(tabIds));
  await clientEvent(env, "connected", { id: 1, name: "claude-code", pid: 9, cwd: "/p" });
  await env.callTool("tabs_create_mcp", {}, "s1", { id: 1, name: "claude-code" });
  await env.callTool("tabs_create_mcp", {}, "s1", { id: 1, name: "claude-code" });
  await wait(120);
  assert.deepEqual(kept.at(-1), [2, 3], "the session's tabs, not the user's tab 1");
  await clientEvent(env, "disconnected", { id: 1 });
  await wait(120);
  assert.deepEqual(kept.at(-1), [], "a disconnected session keeps nothing rendering");
});

// ---- Child frames

// A session tab (id 2) whose frames answer read_page and find as given: pages maps a frame id
// (0 for the top frame) to its readPage answer, finds lists each frame's find answer.
async function framesEnv({ pages = {}, finds = [] } = {}) {
  const env = await load();
  await env.callTool("tabs_create_mcp");
  const calls = [];
  env.browser.claudePage.call = async (tabId, op, args) => {
    calls.push({ op, args: plain(args) });
    if (op === "viewport") return { width: 1000, height: 800, dpr: 1, scrollX: 0, scrollY: 0, screenX: 100, screenY: 50, title: "t", url: "https://mdn.example/" };
    if (op === "readPage") {
      const got = pages[args.frameId ?? 0];
      if (got instanceof Error) throw got;
      return got;
    }
    return op === "textSize" ? 10 : "done";
  };
  env.browser.claudePage.broadcast = async (tabId, op, args) => {
    calls.push({ op, args: plain(args), broadcast: true });
    return finds;
  };
  return { ...env, calls };
}

test("read_page puts each child frame's tree under its iframe's line, nested frames too", async () => {
  const env = await framesEnv({
    pages: {
      0: { text: 'Page: MDN\nURL: https://mdn.example/\n\nmain\n  heading "Select" [ref_1]\n  iframe [ref_2] src="https://play.example/" frame=f12\n  link "Next" [ref_3]', frames: [12], masked: null },
      12: { text: 'combobox "Flavor" [ref_1@f12] selected="Chocolate" options=3\niframe [ref_2@f12] frame=f13', frames: [13], masked: { count: 1, site: "play.example" } },
      13: { text: 'button "Go" [ref_1@f13]', frames: [] },
    },
  });
  const r = await env.callTool("read_page", { tabId: 2, filter: "interactive" });
  assert.equal(
    r.result.content[0].text,
    'Page: MDN\nURL: https://mdn.example/\n\nmain\n  heading "Select" [ref_1]\n  iframe [ref_2] src="https://play.example/" frame=f12\n    combobox "Flavor" [ref_1@f12] selected="Chocolate" options=3\n    iframe [ref_2@f12] frame=f13\n      button "Go" [ref_1@f13]\n  link "Next" [ref_3]',
  );
  assert.equal(r.result.content[1].text, "1 field masked on play.example", "what a frame masked is counted");
  const inner = env.calls.filter((c) => c.op === "readPage" && c.args.frameId);
  assert.deepEqual(inner.map((c) => [c.args.frameId, c.args.inner, c.args.filter]), [[12, true, "interactive"], [13, true, "interactive"]]);
});

test("read_page only reads frames the page reported, says when one couldn't be read, and keeps to max_chars", async () => {
  const env = await framesEnv({
    pages: {
      0: { text: 'text "iframe [ref_9] frame=f99"\niframe [ref_2] frame=f12\niframe [ref_3] frame=f14', frames: [12, 14], masked: null },
      12: new Error("frame went away"),
      14: { text: Array.from({ length: 50 }, (_, i) => `button "B${i}" [ref_${i}@f14]`).join("\n"), frames: [] },
    },
  });
  const r = await env.callTool("read_page", { tabId: 2, max_chars: 400 });
  const out = r.result.content[0].text;
  assert.ok(!env.calls.some((c) => c.args.frameId === 99), "a frame line the page wrote itself isn't read");
  assert.match(out, /iframe \[ref_2\] frame=f12\n {2}\(couldn't read this frame: frame went away\)/);
  assert.match(out, /button "B0" \[ref_0@f14\]/);
  assert.doesNotMatch(out, /B49/);
  assert.match(out, /\[Truncated at 400 characters/);
  assert.ok(out.split("\n\n[Truncated")[0].length <= 400, "the tree stays within max_chars");
});

test("read_page without child frames answers what the page did", async () => {
  const env = await framesEnv({ pages: { 0: "Page: x\n\nbutton [ref_1]" } });
  const r = await env.callTool("read_page", { tabId: 2 });
  assert.deepEqual(plain(r.result.content), [{ type: "text", text: "Page: x\n\nbutton [ref_1]" }]);
});

test("find runs in every frame with the top frame's viewport and merges matches by score", async () => {
  const env = await framesEnv({
    finds: [
      { matches: [{ score: 5, line: 'text "Ice cream select example" [ref_4] at (300, 200)' }], rest: [], masked: null },
      { matches: [{ score: 9, line: 'combobox "Choose a flavor" [ref_1@f12] at (320, 540) (in frame play.example)' }, { score: 1, line: 'text "x" [ref_2@f12]' }], rest: [], masked: { count: 1, site: "play.example" } },
      null,
      { error: "no document" },
    ],
  });
  const r = await env.callTool("find", { tabId: 2, query: "ice cream select" });
  const find = env.calls.find((c) => c.op === "find");
  assert.ok(find.broadcast);
  assert.deepEqual(find.args.origin, { x: 100, y: 50, width: 1000, height: 800 });
  assert.equal(
    r.result.content[0].text,
    'Found 2 for "ice cream select" (screenshot coordinates; if off-screen, computer left_click its ref):\ncombobox "Choose a flavor" [ref_1@f12] at (320, 540) (in frame play.example)\ntext "Ice cream select example" [ref_4] at (300, 200)',
  );
  assert.equal(r.result.content[1].text, "1 field masked on play.example");
});

// A find answer of `count` links, best first, from one frame.
const findFrame = (count, { name = (i) => `Link ${i}`, rest = [] } = {}) => ({
  matches: Array.from({ length: count }, (_, i) => ({ score: 20 - i, line: `link "${name(i)}" [ref_${i + 1}] at (10, ${i * 20})` })),
  rest,
  masked: null,
});

test("find shows the best 8 and says how many close matches it left out, its frames' too", async () => {
  const env = await framesEnv({ finds: [findFrame(8, { rest: [11, 11, 3] }), { ...findFrame(2), matches: [{ score: 19.5, line: 'button "Go" [ref_1@f12]' }, { score: 2, line: 'text "far" [ref_2@f12]' }] }] });
  const out = (await env.callTool("find", { tabId: 2, query: "link" })).result.content[0].text;
  const lines = out.split("\n");
  assert.equal(lines.length, 1 + 8 + 1);
  assert.match(lines[0], /^Found 8 for "link"/);
  assert.ok(lines.includes('button "Go" [ref_1@f12]'), "the other frame's close match ranks with the rest");
  assert.ok(!out.includes("far"), "matches far behind the best are dropped");
  assert.ok(!out.includes("ref_8]"), "the eighth link of the first frame is pushed out by the other frame's");
  // Behind the 8 shown: link 8 pushed out, and the first frame's own two left-out matches above the floor of 10.
  assert.equal(lines.at(-1), "(+3 more, refine the query)");
});

test("find shows a line once, and keeps the elements with a role the query names", async () => {
  // uitestingplayground.com/textinput: find "button" matched a label and list items that say
  // "button" above the button itself, whose name had changed to "Renamed".
  const prose = Array.from({ length: 9 }, (_, i) => ({ score: 7, line: `listitem "Press the button ${i}" [ref_${i + 10}]` }));
  const env = await framesEnv({
    finds: [
      {
        matches: [{ score: 7, line: 'heading "Text Input" [ref_1] at (50, 60)' }, { score: 7, line: 'heading "Text Input" [ref_1] at (50, 60)' }, ...prose, { score: 4, line: 'button "Renamed" [ref_3] at (90, 200)', roleHit: true }],
        rest: [],
        masked: null,
      },
    ],
  });
  const lines = (await env.callTool("find", { tabId: 2, query: "button" })).result.content[0].text.split("\n");
  assert.equal(lines.filter((l) => l.startsWith('heading "Text Input"')).length, 1);
  assert.equal(lines[8], 'button "Renamed" [ref_3] at (90, 200)', "the button takes the last of the 8 places");
  assert.match(lines[0], /^Found 8 for "button"/);
  assert.equal(lines.at(-1), "(+3 more, refine the query)");

  // A shown match with the role already: nothing is pushed out for the others.
  const hit = await framesEnv({ finds: [{ matches: [{ score: 9, line: 'button "Go" [ref_1]', roleHit: true }, { score: 8, line: 'text "go on" [ref_2]' }, { score: 2, line: 'button "Back" [ref_3]', roleHit: true }], rest: [], masked: null }] });
  const out = (await hit.callTool("find", { tabId: 2, query: "go button" })).result.content[0].text;
  assert.ok(!out.includes("Back"));
});

test("find clips long names and hrefs but not refs or coordinates", async () => {
  const long = "Walnut Writing Desk with Two Drawers, Solid Hardwood, Natural FinishFree shipping · In stock · Ships in 2 days";
  const href = "https://shop.example.com/furniture/results/?keywords=writing+desk&origin=SearchResults&itemId=4439342156";
  const env = await framesEnv({
    finds: [{ matches: [{ score: 9, line: `link ${JSON.stringify(long)} [ref_7@f3] href=${JSON.stringify(href)} at (154, 310)` }, { score: 8, line: `text ${JSON.stringify('say "hi" ' + "x".repeat(80))} [ref_8]` }], rest: [], masked: null }],
  });
  const out = (await env.callTool("find", { tabId: 2, query: "apply" })).result.content[0].text.split("\n");
  assert.equal(out[1], `link "${long.slice(0, 49)}…" [ref_7@f3] href="https://shop.example.com/furniture/results/?…" at (154, 310)`);
  assert.equal(out[2], `text ${JSON.stringify(('say "hi" ' + "x".repeat(80)).slice(0, 49) + "…")} [ref_8]`);
  const short = await framesEnv({ finds: [{ matches: [{ score: 9, line: 'link "Home" [ref_1] href="/" at (1, 2)' }, { score: 9, line: "div [ref_2] at (3, 4)" }], rest: [], masked: null }] });
  assert.deepEqual((await short.callTool("find", { tabId: 2, query: "x" })).result.content[0].text.split("\n").slice(1), ['link "Home" [ref_1] href="/" at (1, 2)', "div [ref_2] at (3, 4)"]);
});

// Real find answers from earlier sessions (extension/test/fixtures/find-recorded.json), as the
// actor would now answer them: the same lines, best first, 8 at most with the score of each left
// out behind (every line counts as close, which is the most it could keep), each line once.
test("find answers recorded from real pages come out at a fraction of the size, refs and coordinates intact", async (t) => {
  const recorded = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "find-recorded.json"), "utf8"));
  let before = 0;
  let after = 0;
  for (const { query, recorded: old } of recorded) {
    const lines = old.split("\n").slice(1).filter((l) => !l.startsWith("[")).map((l) => l.replace(" (off-screen; click by ref, or scroll_to first)", " (off-screen)"));
    const env = await framesEnv({ finds: [{ matches: lines.slice(0, 8).map((line, i) => ({ score: 100 - i, line })), rest: lines.slice(8).map((_, i) => 92 - i), masked: null }] });
    const out = (await env.callTool("find", { tabId: 2, query })).result.content[0].text;
    const got = out.split("\n");
    // A line recorded twice (the "discography" answer has its heading twice) is shown once.
    const shown = [...new Set(lines.slice(0, 8))];
    assert.equal(got.length - 1 - (lines.length > 8 ? 1 : 0), shown.length, query);
    shown.forEach((l, i) => {
      assert.equal(got[1 + i].match(/\[ref_\d+(@f\d+)?\]/)?.[0], l.match(/\[ref_\d+(@f\d+)?\]/)?.[0], `${query}: ref ${i}`);
      assert.equal(got[1 + i].match(/at \(-?\d+, -?\d+\)|\(off-screen\)|\(not rendered\)/)?.[0], l.match(/at \(-?\d+, -?\d+\)|\(off-screen\)|\(not rendered\)/)?.[0], `${query}: place ${i}`);
    });
    if (lines.length > 8) assert.equal(got.at(-1), `(+${lines.length - 8} more, refine the query)`);
    before += Buffer.byteLength(old);
    after += Buffer.byteLength(out);
    t.diagnostic(`${String(Buffer.byteLength(old)).padStart(5)} -> ${String(Buffer.byteLength(out)).padStart(4)}  ${query}`);
  }
  t.diagnostic(`total ${before} -> ${after} bytes (${Math.round((100 * after) / before)}%)`);
  assert.ok(after < before * 0.5, "less than half the bytes");
});

test("find with no match anywhere says so, and a top frame that failed is an error", async () => {
  const none = await framesEnv({ finds: [{ matches: [], rest: [], masked: null }, { matches: [], rest: [], masked: null }] });
  const r = await none.callTool("find", { tabId: 2, query: "nothing" });
  assert.equal(r.result.content[0].text, 'No elements matched "nothing". Try read_page with filter "interactive".');
  const failed = await framesEnv({ finds: [{ error: "No document in this frame." }] });
  const e = await failed.callTool("find", { tabId: 2, query: "x" });
  assert.equal(e.result.isError, true);
  assert.match(e.result.content[0].text, /No document in this frame/);
});

// scroll_to: `frameAt` lists where the frame's viewport sits in the top frame's viewport on each
// measure after the scroll (the page around a cross-process frame scrolls after the frame
// answers); the top viewport is 1000x800. The frames' own places on screen (screenX/Y) are
// wrong on purpose: out of process they were (MDN's live example read about (8, 46)).
async function scrollEnv(answer, frameAt = []) {
  const env = await framesEnv();
  const calls = [];
  env.browser.claudePage.call = async (tabId, op, args) => {
    calls.push({ op, args: plain(args) });
    if (op === "scrollTo") return answer;
    if (op === "viewport" && args.frameId != null) return { width: 698, height: 71, screenX: 8, screenY: 46 };
    if (op === "viewport") return { width: 1000, height: 800, dpr: 1, scrollX: 0, scrollY: 0, screenX: 100, screenY: 50 };
    return "done";
  };
  env.browser.claudePage.frameOffset = async (tabId, frameId) => {
    calls.push({ op: "frameOffset", args: { frameId } });
    const at = frameAt.length > 1 ? frameAt.shift() : frameAt[0];
    return at ? { scale: 1, ...at } : null;
  };
  return { ...env, calls };
}

test("scroll_to on a top-frame ref answers the center as the page gave it", async () => {
  const env = await scrollEnv({ x: 50.4, y: 20.6, frame: null });
  const r = await env.callTool("computer", { action: "scroll_to", tabId: 2, ref: "ref_3" });
  assert.equal(r.result.content[0].text, "Scrolled ref_3 into view; its center is now at (50, 21)");
  assert.equal(env.calls.find((c) => c.op === "scrollTo").args.ref, "ref_3");
  assert.ok(!env.calls.some((c) => c.args.frameId != null), "no frame is measured");
});

test("scroll_to on a frame ref answers the center in screenshot coordinates, once the frame holds still", async () => {
  // MDN: the frame answered (227, 10) in its own viewport while it still sat at (363, 650); the
  // page then scrolled it to (363, 393).
  const env = await scrollEnv({ x: 227, y: 10, frame: { host: "live.mdnplay.dev", screenX: 8, screenY: 46 } }, [
    { x: 363, y: 650 },
    { x: 363, y: 550 },
    { x: 363, y: 393 },
    { x: 363, y: 393 },
  ]);
  const r = await env.callTool("computer", { action: "scroll_to", tabId: 2, ref: "ref_1@f12" });
  assert.equal(r.result.content[0].text, "Scrolled ref_1@f12 into view; its center is now at (590, 403) (in frame live.mdnplay.dev)");
  const reads = env.calls.filter((c) => c.op === "frameOffset");
  assert.deepEqual(reads.map((c) => c.args.frameId), [12, 12, 12, 12], "measured again until two measures agree");
});

test("scroll_to on a frame ref places the center by the frame's scale too (a zoomed iframe)", async () => {
  const env = await scrollEnv({ x: 100, y: 20, frame: { host: "live.mdnplay.dev" } }, [{ x: 300, y: 200, scale: 2 }]);
  const r = await env.callTool("computer", { action: "scroll_to", tabId: 2, ref: "ref_1@f12" });
  assert.equal(r.result.content[0].text, "Scrolled ref_1@f12 into view; its center is now at (500, 240) (in frame live.mdnplay.dev)");
});

test("scroll_to on a frame ref that ends up outside the page's viewport says so", async () => {
  const env = await scrollEnv({ x: 227, y: 10, frame: { host: "live.mdnplay.dev" } }, [{ x: 363, y: 1950 }]);
  const r = await env.callTool("computer", { action: "scroll_to", tabId: 2, ref: "ref_1@f12" });
  assert.equal(r.result.content[0].text, "Scrolled ref_1@f12 into view; its center is now at (590, 1960) (in frame live.mdnplay.dev), outside the page's viewport; take a screenshot to see where it is");
});

test("scroll_to on a frame ref whose frame can't be measured gives no coordinates", async () => {
  const env = await scrollEnv({ x: 227, y: 10, frame: { host: "live.mdnplay.dev" } }, []);
  const r = await env.callTool("computer", { action: "scroll_to", tabId: 2, ref: "ref_1@f12" });
  assert.equal(r.result.content[0].text, "Scrolled ref_1@f12 into view (in frame live.mdnplay.dev); couldn't tell where its frame is on the page, take a screenshot to see where it is");
});

test("read_page on a frame ref tells the frame where it sits in the top viewport; on a top ref it doesn't", async () => {
  const env = await framesEnv({ pages: { 0: "Frame: x\n\nbutton [ref_1@f12]" } });
  const asked = [];
  env.browser.claudePage.frameOffset = async (tabId, frameId) => (asked.push([tabId, frameId]), { x: 826, y: 357, scale: 1 });
  await env.callTool("read_page", { tabId: 2, ref_id: "ref_1@f12" });
  assert.deepEqual(asked, [[2, 12]]);
  assert.deepEqual(env.calls.find((c) => c.op === "readPage").args.offset, { x: 826, y: 357, scale: 1 });
  env.calls.length = 0;
  await env.callTool("read_page", { tabId: 2, ref_id: "ref_4" });
  assert.equal(env.calls.find((c) => c.op === "readPage").args.offset, undefined);
  assert.equal(asked.length, 1, "a top ref measures no frame");
});

test("find asks api.js to send each frame where it sits in the top viewport", async () => {
  const env = await framesEnv({ finds: [{ matches: [{ score: 5, line: 'combobox "Choose a pet:" [ref_1@f12] at (905, 404) (in frame live.mdnplay.dev)' }], rest: [] }] });
  const r = await env.callTool("find", { tabId: 2, query: "pet" });
  assert.match(r.result.content[0].text, /at \(905, 404\)/);
  const sent = env.calls.find((c) => c.op === "find" && c.broadcast).args;
  assert.equal(sent.frameOffsets, true);
});

// A model that never called tabs_create_mcp believes it opened no tab, and leaves it open.
const CREATED = (id) => `Created tab ${id} for this session; close it with tabs_close_mcp when done.`;

test("tabs_context_mcp says when createIfEmpty opened the session's first tab, before the tab list", async () => {
  const env = await load();
  const first = (await env.callTool("tabs_context_mcp", { createIfEmpty: true })).result.content[0].text;
  const [note, ...json] = first.split("\n");
  assert.equal(note, CREATED(2));
  assert.deepEqual(JSON.parse(json.join("\n")).availableTabs.map((t) => t.tabId), [2]);
  const again = (await env.callTool("tabs_context_mcp", { createIfEmpty: true })).result.content[0].text;
  assert.doesNotMatch(again, /Created tab/, "no tab opened, no note");
  assert.equal(JSON.parse(again).availableTabs.length, 1);
  const other = (await env.callTool("tabs_context_mcp", {}, "s2")).result.content[0].text;
  assert.deepEqual(JSON.parse(other).availableTabs, [], "without createIfEmpty nothing is opened");
});

test("navigate without a tabId says when it opened the session's first tab", async () => {
  const env = await load();
  const first = (await env.callTool("navigate", { url: "a.example" })).result.content[0].text;
  assert.match(first, /^Tab 2: https:\/\/a\.example/);
  assert.ok(first.includes(`\n${CREATED(2)}\n\nThis session's tabs:\n{`), first);
  const again = (await env.callTool("navigate", { url: "b.example" })).result.content[0].text;
  assert.match(again, /^Tab 2: https:\/\/b\.example/);
  assert.doesNotMatch(again, /Created tab/);
  assert.match(again, /This session's tabs:/, "the tab list is still appended");
});

// ---- navigate wait "interactive"

// A session tab (id 2) that goes to `status` when navigated. `doc(ms)` is what its top frame's
// readyState op answers `ms` after the navigation started (-1 before it): a document, null, or
// an Error to throw.
async function navEnv(doc, { status = "loading" } = {}) {
  const env = await load();
  await env.callTool("tabs_create_mcp");
  const ops = [];
  let navAt = null;
  env.browser.tabs.update = async (id, props) => {
    navAt = Date.now();
    return Object.assign(env.browser.tabsMap.get(id), props, { status, title: "tab title" });
  };
  env.browser.claudePage.call = async (tabId, op) => {
    ops.push(op);
    if (op === "textSize") return 10;
    if (op !== "readyState") return "done";
    const d = doc(navAt == null ? -1 : Date.now() - navAt);
    if (d instanceof Error) throw d;
    return d;
  };
  const nav = async (args) => {
    const t0 = Date.now();
    const r = await env.callTool("navigate", { tabId: 2, url: "https://b.example/", ...args }, "s1", undefined, 4000);
    return { text: r.result.content[0].text, isError: r.result.isError, took: Date.now() - t0 };
  };
  return { ...env, ops, nav };
}

const OLD = { id: 1, state: "complete", title: "Old page" };
// The old page stays until 150ms, nothing answers while the new one commits, and the new one is
// parsed at 250ms.
const loads = (ms) => (ms < 150 ? OLD : ms < 200 ? null : ms < 250 ? { id: 2, state: "loading", title: "" } : { id: 2, state: "interactive", title: "New page" });

test("navigate without wait is unchanged: it waits for the load and the text to settle", async () => {
  const env = await navEnv(loads, { status: "complete" });
  const { text, took } = await env.nav({});
  assert.equal(text, "Tab 2: https://b.example/\nTitle: tab title");
  assert.ok(!env.ops.includes("readyState"), "the page isn't asked for its readyState");
  assert.ok(env.ops.filter((op) => op === "textSize").length >= 3);
  assert.ok(took >= 1200, `took ${took}ms`);
});

test('navigate wait "interactive" answers once the new page is parsed and quiet, with its URL and title', async () => {
  const env = await navEnv(loads);
  const { text, took } = await env.nav({ wait: "interactive" });
  assert.equal(text, "Tab 2: https://b.example/\nTitle: New page\n(returned once the page was parsed; it is still loading. Read it as usual; if something is missing, read again.)");
  assert.ok(took >= 250 + 300 && took < 900, `took ${took}ms`);
  assert.ok(!env.ops.includes("textSize"), "the text isn't waited on");
});

test('navigate wait "interactive" on a page that has loaded by then adds no note', async () => {
  const env = await navEnv((ms) => (ms < 100 ? OLD : { id: 2, state: "complete", title: "Done" }), { status: "complete" });
  const { text } = await env.nav({ wait: "interactive" });
  assert.equal(text, "Tab 2: https://b.example/\nTitle: Done");
});

test('navigate wait "interactive" follows a redirect that commits in the quiet period', async () => {
  const env = await navEnv((ms) => (ms < 300 ? loads(ms) : { id: 3, state: "interactive", title: "Signed in" }));
  const { text, took } = await env.nav({ wait: "interactive" });
  assert.match(text, /^Tab 2: https:\/\/b\.example\/\nTitle: Signed in\n/);
  assert.ok(took >= 300 + 300, `took ${took}ms`);
});

test('navigate wait "interactive" doesn\'t take the page it is leaving for the new one', async () => {
  // The old page is still there, parsed, while the tab loads the next one.
  const env = await navEnv((ms) => (ms < 700 ? OLD : { id: 2, state: "interactive", title: "Slow server" }));
  const { text, took } = await env.nav({ wait: "interactive" });
  assert.match(text, /\nTitle: Slow server\n/);
  assert.ok(took >= 700 + 300, `took ${took}ms`);
});

test('navigate wait "interactive" to the same document (a #hash) ends once the tab says complete', async () => {
  const env = await navEnv(() => OLD, { status: "complete" });
  const { text, took } = await env.nav({ wait: "interactive", url: "https://b.example/#part" });
  assert.equal(text, "Tab 2: https://b.example/#part\nTitle: Old page");
  assert.ok(took >= 250 + 300 && took < 900, `took ${took}ms`);
});

test('navigate wait "interactive" with an actor from before the restart waits for the full load', async () => {
  const env = await navEnv(() => new Error("Unknown op readyState"), { status: "complete" });
  const { text, took } = await env.nav({ wait: "interactive" });
  assert.equal(text, "Tab 2: https://b.example/\nTitle: tab title");
  assert.ok(env.ops.filter((op) => op === "textSize").length >= 3);
  assert.ok(took >= 1200, `took ${took}ms`);
});

test("navigate rejects a wait it doesn't know", async () => {
  const env = await navEnv(loads);
  const { text, isError } = await env.nav({ wait: "networkidle" });
  assert.equal(isError, true);
  assert.match(text, /wait must be "load" or "interactive"/);
});

test("key and type answer where the keys went, with a masked line when the field is masked", async () => {
  const env = await framesEnv();
  env.browser.claudePage.call = async (tabId, op) => {
    if (op === "key") return 'Pressed Down → combobox "Flavor" = "Sardine" in frame play.example';
    if (op === "type") return { text: 'Typed 4 character(s) → textbox "Card" [redacted: cc-number, filled]', masked: { count: 1, site: "shop.example" } };
    return "done";
  };
  const k = await env.callTool("computer", { action: "key", tabId: 2, text: "Down" });
  assert.deepEqual(plain(k.result.content), [{ type: "text", text: 'Pressed Down → combobox "Flavor" = "Sardine" in frame play.example' }]);
  const t = await env.callTool("computer", { action: "type", tabId: 2, text: "4111" });
  assert.equal(t.result.content.at(-1).text, "1 field masked on shop.example");
});

// ---- Click latency

// A session tab (id 2); its page answers a click with `answer`, and `onClick` runs as it does.
async function clickEnv({ answer = 'Clicked button "Go"', onClick } = {}) {
  const env = await load();
  await env.callTool("tabs_create_mcp");
  const calls = [];
  env.browser.claudePage.call = async (tabId, op, args) => {
    calls.push({ op, args: plain(args) });
    if (op === "viewport") return { width: 1000, height: 800, dpr: 1, scrollX: 0, scrollY: 0 };
    if (op === "click") {
      onClick?.();
      return answer;
    }
    return op === "textSize" ? 10 : "done";
  };
  // The page in tab 2 opens tab 3: the tab exists (tabs.query lists it) after `made` ms, as a
  // tab window.open made does before the click answers, and onCreated sees it after `seen`.
  const openAfter = (seen, made = seen) => {
    const t3 = { id: 3, windowId: 10, groupId: -1, active: false, openerTabId: 2, url: "https://x.example/new", status: "complete", title: "New" };
    const make = () => env.browser.tabsMap.set(3, t3);
    if (made <= 0) make();
    else setTimeout(make, made);
    setTimeout(() => env.browser.tabs.onCreated.fire({ ...t3 }), seen);
  };
  return { ...env, calls, openAfter };
}

test("a click that opens no tab answers at once, so keys right after it aren't held up", async () => {
  const env = await clickEnv();
  const t0 = Date.now();
  const r = await env.callTool("computer", { action: "left_click", tabId: 2, coordinate: [10, 10] });
  await env.callTool("computer", { action: "key", tabId: 2, text: "Tab" });
  const took = Date.now() - t0;
  assert.equal(r.result.content[0].text, 'Clicked button "Go"');
  assert.ok(took < 95, `click and key took ${took}ms`);
});

test("a click whose page opened a tab (window.open) waits for onCreated and names it", async () => {
  const env = await clickEnv({ onClick: () => env.openAfter(40, 0) });
  const r = await env.callTool("computer", { action: "left_click", tabId: 2, coordinate: [10, 10] }, "s1", undefined, 4000);
  assert.match(r.result.content[0].text, /^Clicked button "Go"\nThe click opened a new tab in this session's group: tab 3: https:\/\/x\.example\/new \(New\)$/);
});

test("a tab the page opens after the click answered isn't waited for, but still joins the group", async () => {
  const env = await clickEnv({ onClick: () => env.openAfter(40) });
  const t0 = Date.now();
  const r = await env.callTool("computer", { action: "left_click", tabId: 2, coordinate: [10, 10] });
  assert.ok(Date.now() - t0 < 95, `took ${Date.now() - t0}ms`);
  assert.equal(r.result.content[0].text, 'Clicked button "Go"');
  await wait(100);
  assert.equal(env.browser.tabsMap.get(3).groupId, env.browser.tabsMap.get(2).groupId);
});

test("a tab the page opened before the click doesn't make the click wait", async () => {
  const env = await clickEnv();
  env.browser.tabsMap.set(3, { id: 3, windowId: 10, groupId: -1, active: false, openerTabId: 2, url: "https://x.example/old", status: "complete", title: "Old" });
  const t0 = Date.now();
  const r = await env.callTool("computer", { action: "left_click", tabId: 2, coordinate: [10, 10] });
  assert.ok(Date.now() - t0 < 95, `took ${Date.now() - t0}ms`);
  assert.equal(r.result.content[0].text, 'Clicked button "Go"');
});

test("a click on a link that targets a new tab waits longer for it", async () => {
  const env = await clickEnv({ answer: { text: 'Clicked link "Open"', opens: true }, onClick: () => env.openAfter(300) });
  const r = await env.callTool("computer", { action: "left_click", tabId: 2, coordinate: [10, 10] }, "s1", undefined, 4000);
  assert.equal(r.result.content.length, 1, "no masked line for a result that masked nothing");
  assert.match(r.result.content[0].text, /^Clicked link "Open"\nThe click opened a new tab in this session's group: tab 3/);
});

test("the cursor animates only in the tab the user is looking at", async () => {
  const env = await clickEnv();
  await env.callTool("computer", { action: "left_click", tabId: 2, coordinate: [10, 10] });
  await env.callTool("computer", { action: "hover", tabId: 2, coordinate: [10, 10] });
  await env.callTool("computer", { action: "left_click_drag", tabId: 2, start_coordinate: [1, 1], coordinate: [10, 10] });
  assert.deepEqual(env.calls.filter((c) => ["click", "hover", "drag"].includes(c.op)).map((c) => [c.op, c.args.animate]), [["click", false], ["hover", false], ["drag", false]]);
  env.browser.tabsMap.get(2).active = true;
  await env.callTool("computer", { action: "left_click", tabId: 2, coordinate: [10, 10] });
  assert.equal(env.calls.findLast((c) => c.op === "click").args.animate, true);
});

// ---- devtools ---------------------------------------------------------------------------------

test("devtools: only tabs of sessions whose MCP server lists the tool are captured, across navigations, until the tab closes", async () => {
  const { browser, callTool, host } = await load();
  const plainClient = { id: 1, name: "claude-code" };
  const devClient = { id: 2, name: "claude-code" };
  await host({ type: "client", event: "connected", client: plainClient });
  await host({ type: "client", event: "connected", client: { ...devClient, devtools: true } });
  const created = async (session, client) => Number((await callTool("tabs_create_mcp", {}, session, client)).result.content[0].text.match(/Created tab (\d+)/)[1]);
  const listening = () => browser.webRequest.onBeforeRequest.listeners.length;

  // Without the tool, nothing is watched or listened to.
  const plainTab = await created("plain", plainClient);
  await wait(80);
  assert.equal(browser.consoleWatched, undefined);
  assert.equal(listening(), 0);

  const tab = await created("dev", devClient);
  assert.deepEqual(plain(browser.consoleWatched), [tab], "watched before tabs_create_mcp answers");
  assert.deepEqual(plain(browser.consoleRules.always), ["password", "cc-*", "one-time-code", "new-password", "current-password"]);
  assert.equal(listening(), 1);

  // Requests and console messages from the watched tab are kept; the user's tab and the other
  // session's tab are ignored.
  const request = (tabId, requestId, url, statusCode = 200) => {
    browser.webRequest.onBeforeRequest.fire({ requestId, tabId, url, method: "GET", type: "xmlhttprequest", timeStamp: 1000 });
    browser.webRequest.onCompleted.fire({ requestId, tabId, statusCode, responseSize: 2048, timeStamp: 1050 });
  };
  request(tab, "r1", "https://a.example/api?token=abc", 500);
  request(1, "r2", "https://user.example/private");
  request(plainTab, "r3", "https://b.example/");
  browser.tabsMap.get(tab).url = "https://a.example/next";
  request(tab, "r4", "https://a.example/next");
  await browser.claudePage.onConsole.fire(tab, { entries: [{ level: "error", text: "Uncaught Error: boom", source: "https://a.example/app.js", line: 3, time: 1000 }], dropped: 0 });
  await browser.claudePage.onConsole.fire(1, { entries: [{ level: "log", text: "the user's tab", time: 1000 }], dropped: 0 });

  const net = (await callTool("devtools", { kind: "network", tabId: tab }, "dev", devClient)).result.content[0].text.split("\n");
  assert.equal(net[0], `Tab ${tab} network: 2 requests. Newest last.`);
  assert.match(net[1], /GET 500 xhr 2\.0kB 50ms https:\/\/a\.example\/api\?token=\[redacted\]$/);
  assert.match(net[2], /GET 200 xhr 2\.0kB 50ms https:\/\/a\.example\/next$/);
  const failed = (await callTool("devtools", { kind: "network", tabId: tab, onlyFailed: true }, "dev", devClient)).result.content[0].text;
  assert.match(failed, /^Tab \d+ network: 1 request; 1 of 2 kept didn't match failed only\./);
  const con = (await callTool("devtools", { kind: "console", tabId: tab, clear: true }, "dev", devClient)).result.content[0].text.split("\n");
  assert.equal(con.length, 2);
  assert.match(con[1], / error Uncaught Error: boom \(https:\/\/a\.example\/app\.js:3\)$/);
  assert.equal((await callTool("devtools", { kind: "console", tabId: tab }, "dev", devClient)).result.content[0].text, `Tab ${tab} console: 0 messages.`);

  // The other session can't read its tab: the tool is off for it. Nor can it read this session's.
  const off = (await callTool("devtools", { kind: "console", tabId: plainTab }, "plain", plainClient)).result;
  assert.equal(off.isError, true);
  assert.match(off.content[0].text, /devtools tool is off for this session/);
  assert.match((await callTool("devtools", { kind: "console", tabId: tab }, "plain", plainClient)).result.content[0].text, /not in this session's tab group/);

  // Closing the tab drops its buffers and stops capture; with no tabs left, the listeners go.
  await callTool("tabs_close_mcp", { tabId: tab }, "dev", devClient);
  await browser.tabs.onRemoved.fire(tab);
  await wait(120);
  assert.deepEqual(plain(browser.consoleWatched), []);
  assert.equal(listening(), 0);
});

test("devtools: a tab the session already had is watched before its first call, and a disconnect stops capture", async () => {
  const { browser, callTool, host } = await load();
  const devClient = { id: 2, name: "claude-code" };
  await host({ type: "client", event: "connected", client: { ...devClient, devtools: true } });
  // The session's group exists before its devtools client calls (a chat's adopted tab).
  const tab = Number((await callTool("tabs_create_mcp", {}, "dev", { id: 3, name: "claude-code" })).result.content[0].text.match(/Created tab (\d+)/)[1]);
  assert.equal(browser.consoleWatched, undefined);
  await callTool("get_page_text", { tabId: tab }, "dev", devClient);
  assert.deepEqual(plain(browser.consoleWatched), [tab]);
  await host({ type: "client", event: "disconnected", client: { id: 2 } });
  await wait(20);
  assert.deepEqual(plain(browser.consoleWatched), []);
  assert.equal(browser.webRequest.onBeforeRequest.listeners.length, 0);
});

// ---- show tabs (demo-only) ----------------------------------------------------------------------

test("show tabs: a session whose MCP server asks opens its tabs in front and keeps the one it acts on selected", async () => {
  const { browser, callTool, host } = await load();
  const plainClient = { id: 1, name: "claude-code" };
  const showClient = { id: 2, name: "claude-code" };
  await host({ type: "client", event: "connected", client: plainClient });
  await host({ type: "client", event: "connected", client: { ...showClient, showTabs: true } });
  const active = () => [...browser.tabsMap.values()].filter((t) => t.active).map((t) => t.id);
  const createdIn = (r) => Number(r.result.content[0].text.match(/Created tab (\d+)/)[1]);

  // Everyone else: background tabs, the user's tab stays selected, no window is raised.
  const bg = createdIn(await callTool("tabs_create_mcp", {}, "plain", plainClient));
  await callTool("navigate", { url: "https://a.example/", tabId: bg }, "plain", plainClient);
  assert.deepEqual(active(), [1]);
  assert.equal(browser.action.focused, undefined);

  // tabs_create_mcp: active in the focused window, and the window is raised.
  const shown = createdIn(await callTool("tabs_create_mcp", {}, "show", showClient));
  assert.deepEqual(active(), [shown]);
  assert.deepEqual(plain(browser.action.focused), { id: 10, focused: true });

  // The user (or anything else) selects another tab; the next call in the tab brings it back.
  await browser.tabs.update(1, { active: true });
  await browser.tabs.onActivated.fire({ tabId: 1, previousTabId: shown, windowId: 10 });
  await callTool("navigate", { url: "https://b.example/", tabId: shown }, "show", showClient);
  assert.deepEqual(active(), [shown]);

  // A tab its page opens stays in front instead of handing focus back.
  const t = { id: 50, windowId: 10, groupId: -1, active: false, openerTabId: shown, url: "https://c.example/", status: "complete", title: "c" };
  browser.tabsMap.set(50, t);
  browser.select(50);
  await browser.tabs.onCreated.fire({ ...t, active: true });
  await browser.tabs.onActivated.fire({ tabId: 50, previousTabId: shown, windowId: 10 });
  await wait(20);
  assert.deepEqual(active(), [50]);
  assert.equal(browser.tabsMap.get(50).groupId, browser.tabsMap.get(shown).groupId);
});

test("show tabs: navigate without a tab and tabs_context_mcp createIfEmpty open the first tab in front; a disconnect ends it", async () => {
  const { browser, callTool, host } = await load();
  const showClient = { id: 2, name: "claude-code" };
  await host({ type: "client", event: "connected", client: { ...showClient, showTabs: true } });
  const active = () => [...browser.tabsMap.values()].filter((t) => t.active).map((t) => t.id);

  const nav = (await callTool("navigate", { url: "https://a.example/" }, "s-nav", showClient)).result.content[0].text;
  const navTab = Number(nav.match(/^Tab (\d+)/)[1]);
  assert.deepEqual(active(), [navTab]);

  const ctx = (await callTool("tabs_context_mcp", { createIfEmpty: true }, "s-ctx", showClient)).result.content[0].text;
  const ctxTab = Number(ctx.match(/Created tab (\d+)/)[1]);
  assert.deepEqual(active(), [ctxTab]);

  // Once its client is gone the session is an ordinary one again: new tabs open in the background.
  await host({ type: "client", event: "disconnected", client: { id: 2 } });
  await browser.tabs.update(1, { active: true });
  await callTool("tabs_create_mcp", {}, "s-ctx", { id: 3, name: "claude-code" });
  assert.deepEqual(active(), [1]);
});
