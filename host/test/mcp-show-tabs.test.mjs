// FIREFOX_BRIDGE_SHOW_TABS=1 (demo-only, eval/demo): mcp/server.mjs says so in its hello and the
// host passes it on to the extension with the client's connected event. tools/list stays
// byte-identical to fixtures/tools-list.json with it set or not, and without it the hello and
// the connected event are what they were.
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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(path.dirname(HERE));
const FIXTURE = path.join(ROOT, "host/test/fixtures/tools-list.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(what, fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(15);
  }
}

// mcp/server.mjs with FIREFOX_BRIDGE_SHOW_TABS set to `flag` (or unset), against a fake bridge
// socket; answers tools/list and the hello it sent on its first call, and the call's args.
async function serverWith(flag) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fab-show-"));
  fs.mkdirSync(path.join(home, ".firefox-agent-bridge"), { mode: 0o700 });
  const seen = [];
  const bridge = net.createServer((socket) => {
    let buf = "";
    socket.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const msg = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        seen.push(msg);
        if (msg.tool) socket.write(`${JSON.stringify({ id: msg.id, result: { content: [{ type: "text", text: "ok" }] } })}\n`);
      }
    });
  });
  await new Promise((r) => bridge.listen(path.join(home, ".firefox-agent-bridge/bridge.sock"), r));
  const env = { ...process.env, HOME: home, FIREFOX_AGENT_BRIDGE_SESSION: "" };
  delete env.FIREFOX_BRIDGE_SHOW_TABS;
  delete env.FIREFOX_BRIDGE_DEVTOOLS;
  if (flag != null) env.FIREFOX_BRIDGE_SHOW_TABS = flag;
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
  try {
    await rpc("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "t", version: "1" } });
    const list = JSON.stringify((await rpc("tools/list", {})).result);
    await rpc("tools/call", { name: "tabs_create_mcp", arguments: {} });
    return { list, hello: seen.find((m) => m.type === "hello"), call: seen.find((m) => m.tool) };
  } finally {
    server.kill();
    bridge.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

for (const flag of [undefined, "0", "1"]) {
  test(`mcp server with FIREFOX_BRIDGE_SHOW_TABS${flag === undefined ? " unset" : `=${flag}`}: tools/list and the call are unchanged; the hello asks only with 1`, async () => {
    const { list, hello, call } = await serverWith(flag);
    assert.equal(list, fs.readFileSync(FIXTURE, "utf8"));
    assert.deepEqual(call.args, {});
    if (flag === "1") assert.equal(hello.showTabs, true);
    else assert.ok(!("showTabs" in hello), JSON.stringify(hello));
  });
}

test("host: showTabs in a client's hello reaches the extension with its connected event, and only then", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fab-show-host-"));
  const host = spawn(process.execPath, [path.join(ROOT, "host/host.mjs")], {
    env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: "", CODEX_HOME: "", CLAUDE_BIN: path.join(HERE, "fake-claude.mjs"), CODEX_BIN: "/nonexistent/codex", SHELL: "/bin/false" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const got = [];
  let pending = Buffer.alloc(0);
  host.stdout.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32LE(0)) {
      const len = pending.readUInt32LE(0);
      got.push(JSON.parse(pending.subarray(4, 4 + len).toString()));
      pending = pending.subarray(4 + len);
    }
  });
  const toHost = (msg) => {
    const body = Buffer.from(JSON.stringify(msg));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    host.stdin.write(Buffer.concat([header, body]));
  };
  const sockets = [];
  try {
    toHost({ type: "hello", version: "test" });
    const sock = path.join(home, ".firefox-agent-bridge/bridge.sock");
    await until("the bridge socket", () => fs.existsSync(sock));
    const hello = async (extra) => {
      const s = net.createConnection(sock);
      sockets.push(s);
      await new Promise((r) => s.once("connect", r));
      s.write(`${JSON.stringify({ type: "hello", client: { name: "claude-code", version: "2" }, pid: 1, cwd: "/", ...extra })}\n`);
    };
    await hello({ showTabs: true });
    const shown = await until("the first client", () => got.find((m) => m.type === "client" && m.event === "connected"));
    assert.equal(shown.client.showTabs, true);
    await hello({});
    const plain = await until("the second client", () => got.filter((m) => m.type === "client" && m.event === "connected")[1]);
    assert.ok(!("showTabs" in plain.client), JSON.stringify(plain.client));
  } finally {
    for (const s of sockets) s.destroy();
    host.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
