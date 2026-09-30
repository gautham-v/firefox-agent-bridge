// FIREFOX_BRIDGE_EXPERIMENTS switches single changes to what the model sees in mcp/server.mjs, for
// A/B runs in the eval. Unset (or empty), tools/list and every result must be what they were
// before the switches existed; each flag is checked on and off against a fake bridge socket.
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
const tabList = (...ids) => JSON.stringify({ availableTabs: ids.map((id) => ({ tabId: id, title: "t", url: "https://x/" })), tabGroup: ids.length ? "g" : null }, null, 2);
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
  assert.deepEqual(out.trim().split("\n"), ["batchHint", "fewerShots", "screenshotAlias", "quietTabs", "pageTextCap", "fastNavigate"]);
});

for (const flags of [undefined, "", "notAFlag"]) {
  test(`with FIREFOX_BRIDGE_EXPERIMENTS ${flags === undefined ? "unset" : JSON.stringify(flags)}, tools/list is byte-identical to the fixture`, async () => {
    await withServer(flags, undefined, async (s) => {
      const { result } = await s.rpc("tools/list", {});
      assert.equal(JSON.stringify(result), fs.readFileSync(FIXTURE, "utf8"));
    });
  });
}

// Each flag changes only its own tools: every other tool's definition matches the fixture.
const FIXTURE_TOOLS = JSON.parse(fs.readFileSync(FIXTURE, "utf8")).tools;
const CHANGES = {
  batchHint: ["computer", "batch"],
  fewerShots: ["computer"],
  screenshotAlias: ["computer", "screenshot", "batch"],
  quietTabs: ["navigate"],
  pageTextCap: ["get_page_text"],
  fastNavigate: [],
};
for (const [flag, changed] of Object.entries(CHANGES)) {
  test(`${flag} changes only ${changed.join(" and ") || "results"} in tools/list`, async () => {
    await withServer(flag, undefined, async (s) => {
      const tools = await s.tools();
      for (const t of FIXTURE_TOOLS) {
        if (changed.includes(t.name)) assert.notDeepEqual(byName(tools, t.name), t, t.name);
        else assert.deepEqual(byName(tools, t.name), t, t.name);
      }
      assert.equal(tools.length, FIXTURE_TOOLS.length + (flag === "screenshotAlias" ? 1 : 0));
    });
  });
}

test("batchHint: find and read_page results with refs get a short batch hint, not inside a batch", async () => {
  const reply = (tool) => ok(tool === "find" ? 'Found 1 for "x":\nbutton "Go" [ref_3] at (10, 20)' : tool === "read_page" ? 'button "Go" [ref_3]' : "No elements matched");
  await withServer(undefined, reply, async (s) => {
    assert.doesNotMatch(texts(await s.call("find", { query: "x", tabId: 1 })), /batch/);
  });
  await withServer("batchHint", reply, async (s) => {
    for (const name of ["find", "read_page"]) {
      const r = await s.call(name, { query: "x", tabId: 1 });
      const hint = r.content.at(-1).text;
      assert.match(hint, /one batch call/);
      assert.ok(hint.length < 120, hint);
    }
    const b = await s.call("batch", { actions: [{ tool: "find", args: { query: "x", tabId: 1 } }] });
    assert.doesNotMatch(texts(b), /one batch call/);
    const d = byName(await s.tools(), "batch").description;
    assert.match(d, /whenever you know the next two or more steps/);
  });
});

test("batchHint: a find with no refs gets no hint", async () => {
  await withServer("batchHint", () => ok('No elements matched "x".'), async (s) => {
    assert.doesNotMatch(texts(await s.call("find", { query: "x", tabId: 1 })), /batch/);
  });
});

test("fewerShots: computer's description says results already report what changed", async () => {
  await withServer("fewerShots", undefined, async (s) => {
    const d = byName(await s.tools(), "computer").description;
    assert.match(d, /already say what changed/);
    assert.match(d, /appearance matters/);
  });
});

test("screenshotAlias: screenshot runs computer's screenshot action, also in a batch", async () => {
  const reply = (tool, args) => ok(`${tool} ${args.action} on ${args.tabId} scale ${args.scale}`);
  await withServer(undefined, reply, async (s) => {
    const r = await s.call("screenshot", {});
    assert.match(r.message, /Unknown tool screenshot/);
  });
  await withServer("screenshotAlias", reply, async (s) => {
    const def = byName(await s.tools(), "screenshot");
    assert.deepEqual(Object.keys(def.inputSchema.properties), ["tabId", "scale"]);
    await s.call("screenshot", { tabId: 4, scale: 0.5 });
    assert.deepEqual(s.calls, [{ tool: "computer", args: { action: "screenshot", tabId: 4, scale: 0.5 } }]);
    // Empty input, as models send it: the tab this session last used is filled in.
    const r = await s.call("screenshot", {});
    assert.deepEqual(s.calls, [{ tool: "computer", args: { action: "screenshot", tabId: 4 } }]);
    assert.match(texts(r), /used tab 4/);
    await s.call("batch", { actions: [{ tool: "screenshot", args: {} }] });
    assert.deepEqual(s.calls.map((c) => c.args.action), ["screenshot"]);
  });
});

test("quietTabs: navigate leaves out a tab list the model has already seen; a changed one is shown", async () => {
  let tabs = [5];
  const note = (id) => `Created tab ${id} for this session; close it with tabs_close_mcp when done.`;
  const reply = (tool, args) => {
    if (tool === "tabs_context_mcp") return ok(tabList(...tabs));
    if (tool === "tabs_create_mcp") return ok(`Created tab 6 in the g tab group.\n${tabList(...tabs)}`);
    if (tool === "navigate") return ok(`Tab ${tabs[0]}: https://a/\nTitle: A${args.first ? `\n${note(tabs[0])}` : ""}\n\nThis session's tabs:\n${tabList(...tabs)}`);
    return ok(`${tool} on ${args.tabId}`);
  };
  await withServer(undefined, reply, async (s) => {
    await s.call("navigate", { url: "a" });
    assert.match(texts(await s.call("navigate", { url: "a" })), /This session's tabs/);
  });
  await withServer("quietTabs", reply, async (s) => {
    const first = texts(await s.call("navigate", { url: "a", first: true }));
    assert.match(first, /Created tab 5/);
    assert.match(first, /This session's tabs/);
    const again = texts(await s.call("navigate", { url: "a", tabId: 5, first: true }));
    assert.equal(again, `Tab 5: https://a/\nTitle: A\n${note(5)}`, "the created-tab note stays");
    // The server still knows the tab: a call without tabId goes to it.
    await s.call("get_page_text", {});
    assert.deepEqual(s.calls.map((c) => c.args.tabId), [5]);
    tabs = [5, 6];
    await s.call("tabs_create_mcp", {});
    assert.doesNotMatch(texts(await s.call("navigate", { url: "a" })), /This session's tabs/, "tabs_create_mcp showed [5, 6]");
    tabs = [5];
    await s.call("tabs_close_mcp", { tabId: 6 });
    assert.match(texts(await s.call("navigate", { url: "a" })), /This session's tabs/, "the list changed since it was last shown");
    assert.match(texts(await s.call("tabs_context_mcp", {})), /availableTabs/, "tabs_context_mcp always shows it");
  });
});

test("pageTextCap: get_page_text returns at most N chars and says how to read on", async () => {
  const full = `Title: T\nURL: https://a/\n\n${"abcdefghij".repeat(1000)}`; // 10,026 chars
  const reply = (tool) => (tool === "get_page_text" ? { content: [{ type: "text", text: full }, { type: "text", text: "1 field masked on a" }] } : ok());
  await withServer(undefined, reply, async (s) => {
    assert.equal((await s.call("get_page_text", { tabId: 1 })).content[0].text, full);
  });
  await withServer("pageTextCap", reply, async (s) => {
    const def = byName(await s.tools(), "get_page_text");
    assert.deepEqual(Object.keys(def.inputSchema.properties), ["tabId", "offset", "max_chars"]);
    let r = await s.call("get_page_text", { tabId: 1 });
    assert.equal(r.content[0].text, `${full.slice(0, 8000)}\n(${full.length - 8000} more chars; call get_page_text with offset 8000 to read on.)`);
    assert.equal(r.content[1].text, "1 field masked on a", "other parts are kept");
    assert.deepEqual(s.calls[0].args, { tabId: 1 }, "offset and max_chars stay in the server");
    r = await s.call("get_page_text", { tabId: 1, offset: 8000 });
    assert.equal(r.content[0].text, full.slice(8000));
    r = await s.call("get_page_text", { tabId: 1, offset: 100, max_chars: 50 });
    assert.equal(r.content[0].text, `${full.slice(100, 150)}\n(${full.length - 150} more chars; call get_page_text with offset 150 to read on.)`);
    r = await s.call("get_page_text", { tabId: 1, offset: 20000 });
    assert.equal(r.content[0].text, `(offset 20000 is past the end: the text has ${full.length} chars.)`);
  });
  await withServer("pageTextCap=4000", reply, async (s) => {
    const r = await s.call("get_page_text", { tabId: 1 });
    assert.match(r.content[0].text, /offset 4000 to read on/);
  });
});

test("fastNavigate: navigate passes wait: interactive to Firefox unless the call set wait", async () => {
  const reply = (tool, args) => ok(`Tab ${args.tabId ?? 3}: https://a/\nTitle: A`);
  await withServer(undefined, reply, async (s) => {
    await s.call("navigate", { url: "a", tabId: 3 });
    assert.deepEqual(s.calls[0].args, { url: "a", tabId: 3 });
  });
  await withServer("fastNavigate", reply, async (s) => {
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

test("flags combine", async () => {
  await withServer(" batchHint , fewerShots,screenshotAlias", undefined, async (s) => {
    const tools = await s.tools();
    const d = byName(tools, "computer").description;
    assert.match(d, /already say what changed/);
    assert.match(d, /one batch call/);
    assert.ok(byName(tools, "screenshot"));
  });
});
