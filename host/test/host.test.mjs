// The host and MCP server halves of the chat wiring, with HOME set to a temp dir:
//  - mcp/server.mjs takes its bridge session id from FIREFOX_AGENT_BRIDGE_SESSION
//  - host.mjs hands `chat.*` native messages to chat.mjs and still bridges everything else
//   node --test host/test/*.test.mjs

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(path.dirname(HERE));
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

// Runs mcp/server.mjs against a fake bridge socket and returns the session id of its first call.
let lastHello = null; // what the last server run announced about its client

async function sessionOfFirstCall(env) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fab-mcp-"));
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
        if (msg.type === "hello") lastHello = msg;
        if (msg.tool) {
          calls.push(msg);
          socket.write(`${JSON.stringify({ id: msg.id, result: { content: [{ type: "text", text: "ok" }] } })}\n`);
        }
      }
    });
  });
  await new Promise((r) => bridge.listen(path.join(home, ".firefox-agent-bridge/bridge.sock"), r));
  const server = spawn(process.execPath, [path.join(ROOT, "mcp/server.mjs")], { env: { ...process.env, HOME: home, FIREFOX_AGENT_BRIDGE_SESSION: "", ...env }, stdio: ["pipe", "pipe", "inherit"] });
  try {
    const rpc = (id, method, params) => server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    rpc(1, "initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "test", version: "1" } });
    rpc(2, "tools/call", { name: "tabs_context_mcp", arguments: {} });
    await until("the call to reach the bridge", () => calls.length);
    return calls[0].session;
  } finally {
    server.kill();
    bridge.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("mcp server: FIREFOX_AGENT_BRIDGE_SESSION becomes the bridge session id", async () => {
  assert.equal(await sessionOfFirstCall({ FIREFOX_AGENT_BRIDGE_SESSION: "chat-1234" }), "chat-1234");
});

test("mcp server: a chat panel's agent announces itself apart from the same program in a terminal", async () => {
  await sessionOfFirstCall({ FIREFOX_AGENT_BRIDGE_SESSION: "chat-1234" });
  assert.equal(lastHello.client.name, "test (sidebar)");
  await sessionOfFirstCall({});
  assert.equal(lastHello.client.name, "test");
});

test("mcp server: without it, each server process gets its own random session", async () => {
  const a = await sessionOfFirstCall({});
  const b = await sessionOfFirstCall({});
  assert.match(a, /^[0-9a-f-]{36}$/);
  assert.notEqual(a, b);
});

test("host: chat messages reach chat.mjs and its replies come back over native messaging", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fab-host-"));
  const host = spawn(process.execPath, [path.join(ROOT, "host/host.mjs")], {
    env: { ...process.env, HOME: home, CLAUDE_BIN: path.join(HERE, "fake-claude.mjs"), CODEX_BIN: "/nonexistent/codex", SHELL: "/bin/false" },
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
  try {
    toHost({ type: "hello", version: "test" });
    toHost({ type: "chat.capabilities", requestId: "c1", engine: "claude" });
    const caps = await until("capabilities", () => got.find((m) => m.type === "chat.capabilities"));
    assert.equal(caps.requestId, "c1");
    assert.equal(caps.available, true);
    assert.equal(caps.models[0].id, "claude-opus-5-5");

    const chatId = "00000000-0000-4000-8000-0000000000aa";
    toHost({ type: "chat.send", chatId, engine: "claude", model: "claude-opus-5-5", effort: "high", text: "hi", attachments: [], context: { tabs: [] } });
    await until("the turn's result", () => got.some((m) => m.type === "chat.event" && m.chatId === chatId && m.event.kind === "result"));
    assert.ok(got.some((m) => m.type === "chat.event" && m.event.kind === "text" && m.event.text.startsWith("Hello from the fake")));

    // The existing bridge still works alongside: an MCP-side call reaches the extension side.
    const sock = net.createConnection(path.join(home, ".firefox-agent-bridge/bridge.sock"));
    await new Promise((r) => sock.once("connect", r));
    sock.write(`${JSON.stringify({ id: 1, session: "s", tool: "tabs_context_mcp", args: {} })}\n`);
    const call = await until("the call", () => got.find((m) => m.type === "call"));
    assert.equal(call.tool, "tabs_context_mcp");
    // A request too big for one native message is refused, not sent: Firefox would drop the
    // connection, and this process would exit with it.
    sock.write(`${JSON.stringify({ id: 2, session: "s", tool: "computer", args: { action: "type", text: "x".repeat(1_100_000) } })}\n`);
    const replies = [];
    sock.setEncoding("utf8");
    sock.on("data", (d) => replies.push(...d.split("\n").filter(Boolean).map((l) => JSON.parse(l))));
    const refused = await until("the refusal", () => replies.find((r) => r.id === 2));
    assert.equal(refused.result.isError, true);
    assert.match(refused.result.content[0].text, /too large/);
    assert.equal(got.filter((m) => m.type === "call").length, 1, "the oversize call never reached Firefox");
    sock.write(`${JSON.stringify({ id: 3, session: "s", tool: "tabs_context_mcp", args: {} })}\n`);
    await until("the next call", () => got.filter((m) => m.type === "call").length === 2);
    assert.equal(host.exitCode, null, "the host is still up");
    sock.destroy();
  } finally {
    host.stdin.end();
    await new Promise((r) => (host.exitCode !== null ? r() : host.once("exit", r)));
    fs.rmSync(home, { recursive: true, force: true });
  }
});
