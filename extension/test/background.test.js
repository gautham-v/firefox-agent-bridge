"use strict";

// Loads control.js and background.js the way the manifest does (two scripts, one global scope)
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
  return { addListener: (f) => listeners.push(f), fire: (...a) => Promise.all(listeners.map((f) => f(...a))), listeners };
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
    windows: {
      getLastFocused: async () => ({ id: 10, incognito: false }),
      create: async (o) => {
        action.popups.push(o);
        return { id: 11 };
      },
    },
    sidebarAction: {
      toggle: () => action.toggles++,
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
          .filter((t) => (q.active == null || t.active === q.active) && (q.windowId == null || t.windowId === q.windowId))
          .map((t) => ({ ...t, index: t.id })),
      get: async (id) => {
        if (!tabs.has(id)) throw new Error("no tab");
        return { ...tabs.get(id) };
      },
      create: async ({ url, windowId }) => {
        const t = { id: nextTab++, windowId, groupId: -1, active: false, url, status: "complete", title: "" };
        tabs.set(t.id, t);
        return { ...t };
      },
      update: async (id, props) => Object.assign(tabs.get(id), props),
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
    claudePage: {
      record: async (tabId, on) => b.recorded.set(tabId, on),
      onRecord: event(),
      setActive: async () => {},
      call: async (tabId, op) => (op === "textSize" ? 10 : "done"),
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
  };
  return b;
}

// Objects made inside the vm context have another Object prototype, which deepEqual notices.
const plain = (x) => JSON.parse(JSON.stringify(x));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function load(opts) {
  const browser = mockBrowser(opts);
  const matchMedia = () => ({ matches: !!opts?.dark, addEventListener: () => {} });
  const ctx = vm.createContext({ browser, console, setTimeout, clearTimeout, URL, Date, Promise, matchMedia, crypto: webcrypto });
  for (const f of ["control.js", "background.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, "..", f), "utf8"), ctx, { filename: f });
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
  assert.equal(env.browser.tabsMap.get(1).groupId, -1, "the user's tab isn't grouped");

  const record = (step) => env.browser.claudePage.onRecord.fire(1, step);
  await record({ action: "click", target: { role: "link", name: "Log in", css: "#login", near: "Welcome" }, url: "https://user.example/" });
  await record({ action: "type", target: { role: "textbox", name: "Library card" }, field: "f1", value: "12" });
  await record({ action: "type", target: { role: "textbox", name: "Library card" }, field: "f1", value: "1234" });
  await record({ action: "type", target: { role: "textbox", name: "PIN" }, field: "f2", secret: "keychain", value: "leaked" });
  await record({ action: "bogus" });
  await env.browser.claudePage.onRecord.fire(99, { action: "click", target: { role: "button", name: "elsewhere" } });
  await wait(30);
  const steps = a.of("teach.step");
  const last = new Map(steps.map((m) => [m.step.n, m.step]));
  assert.deepEqual([...last.keys()], [1, 2, 3]);
  assert.equal(last.get(2).value, "1234");
  assert.equal(last.get(3).secret, "keychain");
  assert.equal(last.get(3).value, undefined, "a secret field's value is never kept");
  const shot = steps.find((m) => m.shot && m.step.n === 1).shot;
  assert.match(Buffer.from(shot.split(",")[1], "base64").toString(), /shot of 1 at 0.5/, "400px wide from an 800px tab");

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
  assert.equal(done.recording.steps.length, 4);
  assert.equal(b.of("teach").at(-1).requestId, undefined, "only the asking panel drafts");
  assert.equal(env.browser.recorded.get(1), false);
  await record({ action: "click", target: { role: "button", name: "late" } });
  await wait(30);
  assert.equal(a.of("teach.step").filter((m) => m.step.n === 5).length, 0);
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
  const acts = ops.filter(([op]) => ["click", "fill", "key"].includes(op));
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
