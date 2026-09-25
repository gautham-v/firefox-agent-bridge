"use strict";

// Loads control.js and background.js the way the manifest does (two scripts, one global scope)
// against a mocked `browser`, then drives them through the native port, tab events, the Stop
// command and the popup port.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const event = () => {
  const listeners = [];
  return { addListener: (f) => listeners.push(f), fire: (...a) => Promise.all(listeners.map((f) => f(...a))), listeners };
};

function mockBrowser() {
  const tabs = new Map([[1, { id: 1, windowId: 10, groupId: -1, active: true, url: "https://user.example/", status: "complete", title: "user" }]]);
  const groups = new Map();
  let nextTab = 2;
  let nextGroup = 100;
  const native = { sent: [], onMessage: event(), onDisconnect: event() };
  const badge = {};
  const store = {};
  const b = {
    native,
    badge,
    tabsMap: tabs,
    groups,
    runtime: {
      connectNative: () => ({ onMessage: native.onMessage, onDisconnect: native.onDisconnect, postMessage: (m) => native.sent.push(m) }),
      getManifest: () => ({ version: "0.1.0" }),
      onConnect: event(),
    },
    storage: { local: { get: async (k) => ({ [k]: store[k] }), set: async (o) => Object.assign(store, o) } },
    windows: { getLastFocused: async () => ({ id: 10, incognito: false }), create: async () => ({ id: 11 }) },
    tabs: {
      onActivated: event(),
      onCreated: event(),
      query: async () => [...tabs.values()].map((t) => ({ ...t })),
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
    },
    tabGroups: {
      get: async (id) => {
        if (!groups.has(id)) throw new Error("no group");
        return { ...groups.get(id) };
      },
      update: async (id, props) => Object.assign(groups.get(id), props),
      query: async () => [...groups.values()],
    },
    claudePage: { setActive: async () => {}, call: async (tabId, op) => (op === "textSize" ? 10 : "done") },
    browserAction: {
      setBadgeText: ({ text }) => (badge.text = text),
      setBadgeBackgroundColor: ({ color }) => (badge.color = color),
      setBadgeTextColor: () => {},
      setTitle: ({ title }) => (badge.title = title),
    },
    commands: { onCommand: event() },
  };
  return b;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function load() {
  const browser = mockBrowser();
  const ctx = vm.createContext({ browser, console, setTimeout, clearTimeout, URL, Date, Promise });
  for (const f of ["control.js", "background.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, "..", f), "utf8"), ctx, { filename: f });
  await wait(20);
  const replies = () => browser.native.sent.filter((m) => m.result);
  let n = 0;
  const callTool = async (tool, args = {}, session = "s1", client = { id: 1, name: "Claude Code" }) => {
    const id = `${client.id}:${++n}`;
    await browser.native.onMessage.fire({ type: "call", id, session, tool, args, client });
    for (let i = 0; i < 200 && !replies().some((r) => r.id === id); i++) await wait(10);
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
  return { browser, callTool, replies, popup };
}

test("first call asks, popup Allow runs it, tool behavior unchanged", async () => {
  const { browser, callTool, popup } = await load();
  assert.equal(JSON.stringify(browser.native.sent[0]), JSON.stringify({ type: "hello", version: "0.1.0" }));
  await browser.native.onMessage.fire({ type: "client", event: "connected", client: { id: 1, name: "Claude Code", version: "2", pid: 9, cwd: "/p" } });
  await wait(80);
  assert.equal(browser.badge.text, "?");
  const ui = popup();
  assert.equal(ui.last().approvals[0].name, "Claude Code");
  const pending = callTool("tabs_create_mcp");
  await wait(30);
  ui.send({ cmd: "allow", name: "Claude Code" });
  const r = await pending;
  assert.match(r.result.content[0].text, /Created tab 2 in the Claude tab group/);
  assert.equal(browser.groups.get(100).title, "Claude");
  await wait(80);
  assert.equal(browser.badge.text, "RUN");
  assert.equal(ui.last().log.at(-1).outcome, "ok");
  assert.equal(ui.last().sessions[0].label, "Claude");
});

test("switching to a session tab pauses it; resume restores the title", async () => {
  const env = await loadAllowed();
  await env.callTool("tabs_create_mcp");
  const sessionTab = 2;

  // Firefox activating a tab after the active one closed (no previousTabId) is not a takeover.
  await env.browser.tabs.onActivated.fire({ tabId: sessionTab, windowId: 10 });
  assert.equal((await env.callTool("tabs_context_mcp")).result.isError, undefined);

  // The user clicks the session tab.
  await env.browser.tabs.onActivated.fire({ tabId: sessionTab, previousTabId: 1, windowId: 10 });
  await wait(20);
  assert.equal(env.browser.groups.get(100).title, "Claude (paused)");
  const r = await env.callTool("tabs_context_mcp");
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /took over.*toolbar button/);
  const ui = env.popup();
  assert.equal(ui.last().sessions[0].paused, "takeover");
  ui.send({ cmd: "resume", session: "s1" });
  await wait(20);
  assert.equal(env.browser.groups.get(100).title, "Claude");
  assert.equal((await env.callTool("tabs_context_mcp")).result.isError, undefined);
});

async function loadAllowed() {
  const env = await load();
  env.popup().send({ cmd: "allow", name: "Claude Code" });
  await wait(10);
  return env;
}

test("a tab the session page opens is handed back, not treated as a takeover", async () => {
  const env = await loadAllowed();
  await env.callTool("tabs_create_mcp");
  // Page in tab 2 opens tab 3; Firefox makes it active.
  const t3 = { id: 3, windowId: 10, groupId: -1, active: true, openerTabId: 2, url: "https://x.example/", status: "complete", title: "x" };
  env.browser.tabsMap.set(3, t3);
  await env.browser.tabs.onCreated.fire({ ...t3 });
  await env.browser.tabs.onActivated.fire({ tabId: 3, previousTabId: 1, windowId: 10 });
  await wait(20);
  assert.equal(env.browser.tabsMap.get(3).groupId, 100);
  assert.equal(env.browser.tabsMap.get(1).active, true, "focus handed back to the user's tab");
  assert.equal(env.popup().last().sessions[0].paused, null);
});

test("focus the extension hands back is not a takeover, even onto a tab since dragged into the group", async () => {
  const env = await loadAllowed();
  await env.callTool("tabs_create_mcp");
  // The user drags their tab 1 into the session group, then a session page opens tab 3.
  env.browser.tabsMap.get(1).groupId = 100;
  const t3 = { id: 3, windowId: 10, groupId: -1, active: true, openerTabId: 2, url: "https://x.example/", status: "complete", title: "x" };
  env.browser.tabsMap.set(3, t3);
  await env.browser.tabs.onCreated.fire({ ...t3 });
  // Firefox reports the activation the extension just made.
  await env.browser.tabs.onActivated.fire({ tabId: 1, previousTabId: 3, windowId: 10 });
  await wait(20);
  assert.equal(env.browser.tabsMap.get(1).active, true);
  assert.equal(env.popup().last().sessions[0].paused, null);
});

test("Stop command answers the in-flight call, pauses, and resume all clears it", async () => {
  const env = await loadAllowed();
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
  assert.equal(env.browser.groups.get(100).title, "Claude (paused)");
  await wait(3100);
  assert.equal(env.browser.badge.text, "||");
  const blocked = await env.callTool("tabs_context_mcp", {}, "s2");
  assert.match(blocked.result.content[0].text, /paused this session/);
  env.popup().send({ cmd: "resumeAll" });
  await wait(20);
  assert.equal(env.browser.groups.get(100).title, "Claude");
  assert.equal((await env.callTool("tabs_context_mcp", {}, "s2")).result.isError, undefined);
});

test("Revoke sends disconnect_client to the host", async () => {
  const env = await loadAllowed();
  await env.browser.native.onMessage.fire({ type: "client", event: "connected", client: { id: 4, name: "Claude Code", pid: 1, cwd: "/" } });
  env.popup().send({ cmd: "revoke", name: "Claude Code" });
  assert.equal(JSON.stringify(env.browser.native.sent.at(-1)), JSON.stringify({ type: "disconnect_client", clientId: 4 }));
});
