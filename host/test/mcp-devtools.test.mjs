// The devtools tool is opt-in: mcp/server.mjs lists it (and tells Firefox, in its hello, to
// capture the session's tabs) only with FIREFOX_BRIDGE_DEVTOOLS=1. Without it, tools/list must
// stay exactly what it was before the tool existed: fixtures/tools-list.json. Regenerate that
// file only when a tool is changed on purpose.
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
const FIXTURE = path.join(ROOT, "host/test/fixtures/tools-list.json");

// A server with FIREFOX_BRIDGE_DEVTOOLS set to `flag` (or unset), against a fake bridge socket
// that records the hello and each call, and answers calls with reply(tool, args).
async function start(flag, reply = () => ({ content: [{ type: "text", text: "ok" }] })) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fab-devtools-"));
  fs.mkdirSync(path.join(home, ".firefox-agent-bridge"), { mode: 0o700 });
  const hellos = [];
  const calls = [];
  const bridge = net.createServer((socket) => {
    let buf = "";
    socket.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const msg = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (msg.type === "hello") hellos.push(msg);
        if (!msg.tool) continue;
        calls.push({ tool: msg.tool, args: msg.args });
        socket.write(`${JSON.stringify({ id: msg.id, result: reply(msg.tool, msg.args) })}\n`);
      }
    });
  });
  await new Promise((r) => bridge.listen(path.join(home, ".firefox-agent-bridge/bridge.sock"), r));
  const env = { ...process.env, HOME: home, FIREFOX_AGENT_BRIDGE_SESSION: "" };
  delete env.FIREFOX_BRIDGE_DEVTOOLS;
  if (flag != null) env.FIREFOX_BRIDGE_DEVTOOLS = flag;
  const server = spawn(process.execPath, [path.join(ROOT, "mcp/server.mjs")], { env, stdio: ["pipe", "pipe", "inherit"] });
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
    hellos,
    calls,
    rpc,
    stop: () => {
      server.kill();
      bridge.close();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

for (const flag of [undefined, "0", "true"]) {
  test(`with FIREFOX_BRIDGE_DEVTOOLS${flag === undefined ? " unset" : `=${flag}`}, tools/list is byte-identical to before devtools, and the hello doesn't ask for capture`, async () => {
    const s = await start(flag);
    try {
      const { result } = await s.rpc("tools/list", {});
      assert.equal(JSON.stringify(result), fs.readFileSync(FIXTURE, "utf8"));
      await s.rpc("tools/call", { name: "tabs_context_mcp", arguments: {} });
      assert.equal(s.hellos.length, 1);
      assert.ok(!("devtools" in s.hellos[0]), JSON.stringify(s.hellos[0]));
      const r = (await s.rpc("tools/call", { name: "devtools", arguments: { kind: "console" } })).error;
      assert.match(r.message, /Unknown tool devtools/);
    } finally {
      s.stop();
    }
  });
}

test("with FIREFOX_BRIDGE_DEVTOOLS=1, devtools is listed, batchable and small, and the hello asks for capture", async () => {
  const s = await start("1", (tool) => ({ content: [{ type: "text", text: tool === "tabs_context_mcp" ? JSON.stringify({ availableTabs: [{ tabId: 7, title: "t", url: "https://x/" }] }) : "Tab 7 console: 0 messages." }] }));
  try {
    const { tools } = (await s.rpc("tools/list", {})).result;
    const def = tools.find((t) => t.name === "devtools");
    assert.ok(def);
    assert.deepEqual(def.inputSchema.required, ["kind"]);
    const size = JSON.stringify(def).length;
    assert.ok(size < 600, `devtools definition is ${size} chars`);
    const batch = tools.find((t) => t.name === "batch");
    assert.ok(batch.inputSchema.properties.actions.items.properties.tool.enum.includes("devtools"));
    // Everything else is as before.
    const before = JSON.parse(fs.readFileSync(FIXTURE, "utf8")).tools;
    assert.deepEqual(tools.filter((t) => t.name !== "devtools" && t.name !== "batch"), before.filter((t) => t.name !== "batch"));

    // A missing tabId is filled in like any other tool's.
    const r = (await s.rpc("tools/call", { name: "devtools", arguments: { kind: "network", onlyFailed: true } })).result;
    assert.equal(s.hellos[0].devtools, true);
    assert.deepEqual(s.calls.at(-1), { tool: "devtools", args: { kind: "network", onlyFailed: true, tabId: 7 } });
    assert.match(r.content.at(-1).text, /used tab 7/);
  } finally {
    s.stop();
  }
});
