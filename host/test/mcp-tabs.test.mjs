// mcp/server.mjs fills in a missing tabId from the tab the session last used or was handed, and
// turns a numeric-string tabId into a number. Each test gets a fresh server (the memory is per
// process) against a fake bridge socket.
//   node --test host/test/*.test.mjs

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

const ok = (text = "ok") => ({ content: [{ type: "text", text }] });
const tabList = (...ids) => JSON.stringify({ availableTabs: ids.map((id) => ({ tabId: id, title: "t", url: "https://x/" })), tabGroup: ids.length ? "g" : null }, null, 2);
const texts = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

// reply(tool, args) answers each Firefox call; calls records them.
async function start(reply) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fab-tabs-"));
  fs.mkdirSync(path.join(home, ".firefox-agent-bridge"), { mode: 0o700 });
  const calls = [];
  const bridge = net.createServer((socket) => {
    let buf = "";
    socket.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const msg = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (!msg.tool) continue;
        calls.push({ tool: msg.tool, args: msg.args });
        socket.write(`${JSON.stringify({ id: msg.id, result: reply(msg.tool, msg.args) })}\n`);
      }
    });
  });
  await new Promise((r) => bridge.listen(path.join(home, ".firefox-agent-bridge/bridge.sock"), r));
  const server = spawn(process.execPath, [path.join(ROOT, "mcp/server.mjs")], { env: { ...process.env, HOME: home, FIREFOX_AGENT_BRIDGE_SESSION: "" }, stdio: ["pipe", "pipe", "inherit"] });
  const pending = new Map();
  let nextId = 1;
  readline.createInterface({ input: server.stdout }).on("line", (l) => {
    const m = JSON.parse(l);
    pending.get(m.id)?.(m);
    pending.delete(m.id);
  });
  const rpc = (method, params) => {
    const id = nextId++;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  };
  await rpc("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "test", version: "1" } });
  return {
    calls,
    rpc,
    call: async (name, args) => {
      calls.length = 0;
      return (await rpc("tools/call", { name, arguments: args })).result;
    },
    stop: () => {
      server.kill();
      bridge.close();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

test("only tabs_close_mcp still requires tabId in the schemas", async () => {
  const s = await start(() => ok());
  try {
    const { tools } = (await s.rpc("tools/list", {})).result;
    const needTab = tools.filter((t) => t.inputSchema.required?.includes("tabId")).map((t) => t.name);
    assert.deepEqual(needTab, ["tabs_close_mcp"]);
  } finally {
    s.stop();
  }
});

test("a call without tabId uses the tab navigate reported", async () => {
  const s = await start((tool, args) =>
    tool === "navigate" ? ok(`Tab 42: https://a.example/\nTitle: A\n\nThis session's tabs:\n${tabList(42)}`) : ok(`${tool} on ${args.tabId}`));
  try {
    await s.call("navigate", { url: "a.example" });
    assert.equal(s.calls[0].args.tabId, undefined); // navigate itself still lets Firefox pick the tab
    const r = await s.call("javascript_tool", { action: "javascript_exec", text: "1" });
    assert.equal(r.isError, undefined);
    assert.deepEqual(s.calls.map((c) => [c.tool, c.args.tabId]), [["javascript_tool", 42]]);
    assert.match(texts(r), /javascript_tool on 42\n\(No tabId given; used tab 42\.\)/);
  } finally {
    s.stop();
  }
});

test("the last tab used wins, and tabs_create_mcp's new tab becomes the current one", async () => {
  const s = await start((tool, args) =>
    tool === "tabs_create_mcp" ? ok(`Created tab 8 in the g tab group.\n${tabList(7, 8)}`) : ok(`${tool} on ${args.tabId}`));
  try {
    await s.call("get_page_text", { tabId: 7 });
    await s.call("computer", { action: "screenshot" });
    assert.equal(s.calls[0].args.tabId, 7);
    await s.call("tabs_create_mcp", {});
    await s.call("find", { query: "x" });
    assert.equal(s.calls[0].args.tabId, 8);
    await s.call("read_page", { tabId: 7 });
    await s.call("form_input", { fields: [{ ref: "ref_1", value: "a" }] });
    assert.deepEqual(s.calls.map((c) => [c.tool, c.args.tabId]), [["form_input", 7]]);
  } finally {
    s.stop();
  }
});

test("with nothing remembered, the session's only tab is used; several tabs still need a tabId", async () => {
  let tabs = [5];
  const s = await start((tool, args) => (tool === "tabs_context_mcp" ? ok(tabList(...tabs)) : ok(`${tool} on ${args.tabId}`)));
  try {
    const r = await s.call("get_page_text", {});
    assert.deepEqual(s.calls.map((c) => [c.tool, c.args.tabId]), [["tabs_context_mcp", undefined], ["get_page_text", 5]]);
    assert.equal(r.isError, undefined);
  } finally {
    s.stop();
  }
  tabs = [5, 6];
  const t = await start((tool, args) => (tool === "tabs_context_mcp" ? ok(tabList(...tabs)) : ok(`${tool} on ${args.tabId}`)));
  try {
    const r = await t.call("get_page_text", {});
    assert.equal(r.isError, true);
    assert.match(texts(r), /2 tabs \(5, 6\)/);
    assert.deepEqual(t.calls.map((c) => c.tool), ["tabs_context_mcp"]);
  } finally {
    t.stop();
  }
  tabs = [];
  const u = await start((tool) => (tool === "tabs_context_mcp" ? ok(tabList()) : ok()));
  try {
    const r = await u.call("computer", { action: "screenshot" });
    assert.equal(r.isError, true);
    assert.match(texts(r), /no tabs yet/);
  } finally {
    u.stop();
  }
});

test("a numeric-string tabId becomes a number; closing the current tab forgets it", async () => {
  const s = await start((tool, args) => (tool === "tabs_context_mcp" ? ok(tabList(3, 4)) : ok(`${tool} on ${args.tabId}`)));
  try {
    await s.call("tabs_context_mcp", {});
    await s.call("get_page_text", { tabId: "4" });
    assert.equal(s.calls[0].args.tabId, 4);
    await s.call("tabs_close_mcp", { tabId: "4" });
    assert.equal(s.calls[0].args.tabId, 4);
    // 4 is gone and 3 is the only tab left, so it becomes the current tab.
    await s.call("get_page_text", {});
    assert.deepEqual(s.calls.map((c) => [c.tool, c.args.tabId]), [["get_page_text", 3]]);
  } finally {
    s.stop();
  }
});

test("tabs_close_mcp without a tabId is not filled in", async () => {
  const s = await start((tool, args) => ok(`${tool} on ${args.tabId}`));
  try {
    await s.call("get_page_text", { tabId: 9 });
    await s.call("tabs_close_mcp", {});
    assert.equal(s.calls[0].args.tabId, undefined);
  } finally {
    s.stop();
  }
});

test("batch actions without tabId use the tab an earlier action navigated", async () => {
  const s = await start((tool, args) =>
    tool === "navigate" ? ok(`Tab 11: https://b/\nTitle: B\n\nThis session's tabs:\n${tabList(11)}`) : ok(`${tool} on ${args.tabId}`));
  try {
    const r = await s.call("batch", { actions: [{ tool: "navigate", args: { url: "b" } }, { tool: "get_page_text", args: {} }] });
    assert.equal(r.isError, undefined);
    assert.deepEqual(s.calls.map((c) => [c.tool, c.args.tabId]), [["navigate", undefined], ["get_page_text", 11]]);
  } finally {
    s.stop();
  }
});
