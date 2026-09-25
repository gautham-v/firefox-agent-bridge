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

function mockBrowser({ store = {}, groups: initialGroups = [] } = {}) {
  const tabs = new Map([[1, { id: 1, windowId: 10, groupId: -1, active: true, url: "https://user.example/", status: "complete", title: "user" }]]);
  const groups = new Map(initialGroups.map((g) => [g.id, { ...g }]));
  let nextTab = 2;
  let nextGroup = 100;
  const native = { sent: [], onMessage: event(), onDisconnect: event() };
  const badge = {};
  const b = {
    native,
    badge,
    store,
    tabsMap: tabs,
    groups,
    runtime: {
      connectNative: () => ({ onMessage: native.onMessage, onDisconnect: native.onDisconnect, postMessage: (m) => native.sent.push(m) }),
      getManifest: () => ({ version: "0.1.0" }),
      onConnect: event(),
    },
    storage: { local: { get: async (k) => ({ [k]: store[k] }), set: async (o) => Object.assign(store, o), remove: async (k) => delete store[k] } },
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

async function load(opts) {
  const browser = mockBrowser(opts);
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
  return { browser, callTool, replies, popup, ctx };
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
  assert.equal(browser.badge.text, "RUN");
  const state = ui.last();
  assert.equal(state.log.at(-1).outcome, "ok");
  assert.equal(state.log.at(-1).client, "claude-code");
  assert.equal(state.sessions[0].label, "Claude");
  assert.equal(state.clients[0].calls, 1);
  assert.equal(state.approvals, undefined);
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
  assert.equal(JSON.stringify(env.browser.store.groupLabels), JSON.stringify(["Claude", "Codex", "Goose"]));
  const wrong = await env.callTool("tabs_close_mcp", { tabId: 2 }, "s3", { id: 3, name: "goose" });
  assert.match(wrong.result.content[0].text, /not in this session's tab group \("Goose"\)/);
});

test("on restart, groups with any remembered label become '<label> (earlier)'", async () => {
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
      ["Claude (earlier)", "grey"],
      ["Codex (earlier)", "grey"],
      ["Goose (earlier)", "grey"],
      ["Shopping", undefined],
      ["Claude (earlier)", undefined],
    ],
  );
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
  assert.equal(env.browser.groups.get(100).title, "Claude (paused)");
  assert.equal(env.browser.badge.text, "||");
  const blocked = await env.callTool("tabs_context_mcp", {}, "s2");
  assert.match(blocked.result.content[0].text, /paused this session/);
  env.popup().send({ cmd: "resumeAll" });
  await wait(20);
  assert.equal(env.browser.groups.get(100).title, "Claude");
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
