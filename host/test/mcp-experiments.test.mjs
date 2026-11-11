// FIREFOX_BRIDGE_EXPERIMENTS switches single changes to what the model sees in mcp/server.mjs, for
// A/B runs in the eval. The one flag left, waitForLoad, turns off a kept change (navigate's
// "interactive" wait) so a run can measure against the old behavior. tools/list matches the
// fixture with or without it; results are checked against a fake bridge socket.
//   node --test host/test/*.test.mjs

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const SERVER = path.join(ROOT, "mcp/server.mjs");
const FIXTURE = path.join(ROOT, "host/test/fixtures/tools-list.json");

const ok = (text = "ok") => ({ content: [{ type: "text", text }] });
const texts = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

// A server with FIREFOX_BRIDGE_EXPERIMENTS set to `flags` (or unset), against a fake bridge that
// answers each call with reply(tool, args) and records it.
async function start(flags, reply = () => ok()) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fab-exp-"));
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
  const env = { ...process.env, HOME: home, FIREFOX_AGENT_BRIDGE_SESSION: "" };
  delete env.FIREFOX_BRIDGE_DEVTOOLS;
  delete env.FIREFOX_BRIDGE_EXPERIMENTS;
  if (flags != null) env.FIREFOX_BRIDGE_EXPERIMENTS = flags;
  const server = spawn(process.execPath, [SERVER], { env, stdio: ["pipe", "pipe", "ignore"] });
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
  await rpc("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "t", version: "1" } });
  return {
    calls,
    rpc,
    tools: async () => (await rpc("tools/list", {})).result.tools,
    call: async (name, args) => {
      calls.length = 0;
      const m = await rpc("tools/call", { name, arguments: args });
      return m.result ?? m.error;
    },
    stop: () => {
      server.kill();
      bridge.close();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

async function withServer(flags, reply, fn) {
  const s = await start(flags, reply);
  try {
    await fn(s);
  } finally {
    s.stop();
  }
}

const byName = (tools, name) => tools.find((t) => t.name === name);

test("--list-experiments prints every flag", () => {
  const out = execFileSync(process.execPath, [SERVER, "--list-experiments"], { encoding: "utf8" });
  assert.deepEqual(out.trim().split("\n"), ["waitForLoad", "navigateBare", "tabsFirst", "plainType"]);
});

// waitForLoad only changes what navigate asks Firefox for; the flags measured and dropped on
// 2026-09-30 are unknown now and change nothing.
for (const flags of [undefined, "", "notAFlag", "waitForLoad", "batchHint,fewerShots,screenshotAlias,quietTabs,pageTextCap,fastNavigate"]) {
  test(`with FIREFOX_BRIDGE_EXPERIMENTS ${flags === undefined ? "unset" : JSON.stringify(flags)}, tools/list is byte-identical to the fixture`, async () => {
    await withServer(flags, undefined, async (s) => {
      const { result } = await s.rpc("tools/list", {});
      assert.equal(JSON.stringify(result), fs.readFileSync(FIXTURE, "utf8"));
    });
  });
}

test("dropped flags leave results alone: no screenshot tool, no batch hint, no page text cap", async () => {
  const full = `Title: T\nURL: https://a/\n\n${"abcdefghij".repeat(1000)}`;
  const reply = (tool) => ok(tool === "find" ? 'Found 1 for "x":\nbutton "Go" [ref_3] at (10, 20)' : tool === "get_page_text" ? full : "ok");
  await withServer("batchHint,screenshotAlias,pageTextCap", reply, async (s) => {
    assert.match((await s.call("screenshot", {})).message, /Unknown tool screenshot/);
    assert.equal(texts(await s.call("find", { query: "x", tabId: 1 })), 'Found 1 for "x":\nbutton "Go" [ref_3] at (10, 20)');
    assert.equal(texts(await s.call("get_page_text", { tabId: 1 })), full);
  });
});

test("navigate passes wait: interactive to Firefox unless the call set wait", async () => {
  const reply = (tool, args) => ok(`Tab ${args.tabId ?? 3}: https://a/\nTitle: A`);
  await withServer(undefined, reply, async (s) => {
    await s.call("navigate", { url: "a", tabId: 3 });
    assert.deepEqual(s.calls[0].args, { url: "a", tabId: 3, wait: "interactive" });
    await s.call("batch", { actions: [{ tool: "navigate", args: { url: "back", tabId: 3 } }] });
    assert.deepEqual(s.calls[0].args, { url: "back", tabId: 3, wait: "interactive" });
    await s.call("navigate", { url: "a", tabId: 3, wait: "load" });
    assert.equal(s.calls[0].args.wait, "load");
    await s.call("get_page_text", { tabId: 3 });
    assert.equal(s.calls[0].args.wait, undefined);
  });
});

test("waitForLoad: navigate goes to Firefox as it did before, with no wait", async () => {
  const reply = (tool, args) => ok(`Tab ${args.tabId ?? 3}: https://a/\nTitle: A`);
  await withServer("waitForLoad", reply, async (s) => {
    await s.call("navigate", { url: "a", tabId: 3 });
    assert.deepEqual(s.calls[0].args, { url: "a", tabId: 3 });
    await s.call("batch", { actions: [{ tool: "navigate", args: { url: "back", tabId: 3 } }] });
    assert.deepEqual(s.calls[0].args, { url: "back", tabId: 3 });
    await s.call("navigate", { url: "a", tabId: 3, wait: "interactive" });
    assert.equal(s.calls[0].args.wait, "interactive", "a call can still ask for it");
  });
});

test("navigate carries the page's text unless another batch action follows it; navigateBare turns that off", async () => {
  const page = `Title: A\nURL: https://a/\n\n${"word ".repeat(2000)}`;
  const reply = (tool, args) => ok(tool === "get_page_text" ? page : `Tab ${args.tabId ?? 3}: https://a/\nTitle: A`);
  await withServer(undefined, reply, async (s) => {
    const t = texts(await s.call("navigate", { url: "a", tabId: 3 }));
    assert.deepEqual(s.calls.map((c) => c.tool), ["navigate", "get_page_text"]);
    assert.match(t, /^Tab 3: https:\/\/a\/\nTitle: A\nPage text:\nword word/);
    assert.ok(!t.includes("URL: https://a/"), "the text's own title and URL lines are dropped");
    assert.match(t, /\(cut at 6000 of \d+ characters; get_page_text returns all of it\)$/);
    await s.call("batch", { actions: [{ tool: "navigate", args: { url: "a", tabId: 3 } }, { tool: "find", args: { query: "x", tabId: 3 } }] });
    assert.deepEqual(s.calls.map((c) => c.tool), ["navigate", "find"]);
    await s.call("batch", { actions: [{ tool: "find", args: { query: "x", tabId: 3 } }, { tool: "navigate", args: { url: "a", tabId: 3 } }] });
    assert.deepEqual(s.calls.map((c) => c.tool), ["find", "navigate", "get_page_text"]);
    assert.match(byName(await s.tools(), "navigate").description, /don't call get_page_text after it/);
  });
  await withServer("navigateBare", reply, async (s) => {
    assert.equal(texts(await s.call("navigate", { url: "a", tabId: 3 })), "Tab 3: https://a/\nTitle: A");
    assert.deepEqual(s.calls.map((c) => c.tool), ["navigate"]);
    assert.match(byName(await s.tools(), "navigate").description, /into one batch call/);
  });
});

test("type with a ref clicks the field first and with submit presses Enter after; plainType turns that off", async () => {
  const reply = (tool, args) => ok(args.action === "left_click" ? "Clicked textbox" : args.action === "key" ? "Pressed Enter" : "Typed 3 character(s)");
  await withServer(undefined, reply, async (s) => {
    const t = texts(await s.call("computer", { action: "type", text: "abc", ref: "ref_4", submit: true, tabId: 3 }));
    assert.deepEqual(s.calls.map((c) => c.args), [
      { tabId: 3, action: "left_click", ref: "ref_4" },
      { tabId: 3, action: "type", text: "abc" },
      { tabId: 3, action: "key", text: "Enter" },
    ]);
    assert.equal(t, "Clicked textbox\nTyped 3 character(s)\nPressed Enter");
    await s.call("computer", { action: "type", text: "abc", tabId: 3 });
    assert.deepEqual(s.calls.map((c) => c.args), [{ action: "type", text: "abc", tabId: 3 }]);
    assert.ok(byName(await s.tools(), "computer").inputSchema.properties.submit);
  });
  await withServer("plainType", reply, async (s) => {
    await s.call("computer", { action: "type", text: "abc", ref: "ref_4", submit: true, tabId: 3 });
    assert.equal(s.calls.length, 1);
    assert.equal(byName(await s.tools(), "computer").inputSchema.properties.submit, undefined);
  });
});

test("tabs_context_mcp isn't asked for before other tools; tabsFirst asks for it as before", async () => {
  await withServer(undefined, undefined, async (s) => {
    const tools = await s.tools();
    assert.match(byName(tools, "tabs_context_mcp").description, /Not needed to get started/);
    assert.match(byName(tools, "tabs_create_mcp").description, /The first tab needs no call/);
  });
  await withServer("tabsFirst", undefined, async (s) => {
    const tools = await s.tools();
    assert.match(byName(tools, "tabs_context_mcp").description, /You must call this at least once/);
    assert.match(byName(tools, "tabs_create_mcp").description, /Each new conversation should use its own tab|Open a new background tab/);
  });
});
