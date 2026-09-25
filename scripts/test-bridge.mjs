#!/usr/bin/env node
// End-to-end test of the host and MCP server without Firefox: this script plays the extension
// on the host's native-messaging stdio and drives it with mcp/server.mjs, scripts/ffctl.mjs
// and raw socket clients. Everything runs with HOME set to a temp dir.
//   node scripts/test-bridge.mjs

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "fab-test-"));
const DIR = path.join(HOME, ".firefox-agent-bridge");
const SOCKET = path.join(DIR, "bridge.sock");
const env = { ...process.env, HOME };
const children = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(what, fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

// ---- fake extension ------------------------------------------------------------------------

const host = spawn(process.execPath, [path.join(ROOT, "host/host.mjs")], { env, stdio: ["pipe", "pipe", "inherit"] });
children.push(host);
let hostExit = null;
host.on("exit", (code) => (hostExit = code ?? "signal"));

const fromHost = [];
const seen = []; // every message, in arrival order
let pending = Buffer.alloc(0);
host.stdout.on("data", (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length >= 4) {
    const len = pending.readUInt32LE(0);
    if (pending.length < 4 + len) break;
    const msg = JSON.parse(pending.subarray(4, 4 + len).toString());
    fromHost.push(msg);
    seen.push(msg);
    pending = pending.subarray(4 + len);
  }
});

function toHost(msg) {
  const body = Buffer.from(typeof msg === "string" ? msg : JSON.stringify(msg));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  host.stdin.write(Buffer.concat([header, body]));
}

// Removes and returns the first message from the host that matches.
async function expectHost(what, pred) {
  return until(what, () => {
    const i = fromHost.findIndex(pred);
    return i >= 0 ? fromHost.splice(i, 1)[0] : null;
  });
}

const isConnected = (name) => (m) => m.type === "client" && m.event === "connected" && m.client.name === name;
const isDisconnected = (id) => (m) => m.type === "client" && m.event === "disconnected" && m.client.id === id;
const isCall = (tool) => (m) => m.type === "call" && m.tool === tool;
const textResult = (text) => ({ content: [{ type: "text", text }] });

// ---- MCP server over stdio -----------------------------------------------------------------

function startMcp() {
  const proc = spawn(process.execPath, [path.join(ROOT, "mcp/server.mjs")], { env, cwd: HOME, stdio: ["pipe", "pipe", "inherit"] });
  children.push(proc);
  const replies = new Map();
  let buf = "";
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      replies.set(msg.id, msg);
    }
  });
  let nextId = 1;
  const request = (method, params) => {
    const id = nextId++;
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return until(`MCP reply to ${method}`, () => replies.get(id), 10_000);
  };
  return { proc, request };
}

// ---- raw socket client ---------------------------------------------------------------------

function rawClient() {
  const socket = net.createConnection(SOCKET);
  children.push({ kill: () => socket.destroy() });
  const lines = [];
  let buf = "";
  let closed = false;
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      lines.push(JSON.parse(buf.slice(0, nl)));
      buf = buf.slice(nl + 1);
    }
  });
  socket.on("close", () => (closed = true));
  socket.on("error", () => {});
  return { socket, lines, isClosed: () => closed, ready: new Promise((r) => socket.once("connect", r)) };
}

// ---- tests ---------------------------------------------------------------------------------

const results = [];
async function test(name, fn) {
  await fn();
  results.push(name);
  console.log(`ok - ${name}`);
}

try {
  await until("host socket", () => fs.existsSync(SOCKET));
  toHost({ type: "hello", version: "test" });

  const mcp = startMcp();
  let mcpClientId;

  await test("MCP server sends hello with clientInfo; host emits connected", async () => {
    const init = await mcp.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.2.3" },
    });
    assert.equal(init.result.serverInfo.name, "firefox-agent-bridge");
    const pCall = mcp.request("tools/call", { name: "tabs_context_mcp", arguments: { createIfEmpty: true } });
    const ev = await expectHost("connected event", isConnected("test-client"));
    assert.equal(ev.client.version, "1.2.3");
    assert.equal(ev.client.pid, mcp.proc.pid);
    assert.equal(fs.realpathSync(ev.client.cwd), fs.realpathSync(HOME));
    assert.equal(typeof ev.client.id, "number");
    mcpClientId = ev.client.id;

    const call = await expectHost("tagged call", isCall("tabs_context_mcp"));
    assert.equal(call.id, `${mcpClientId}:1`);
    assert.deepEqual(call.client, { id: mcpClientId, name: "test-client" });
    assert.deepEqual(call.args, { createIfEmpty: true });
    assert.equal(typeof call.session, "string");
    assert.ok(seen.indexOf(ev) < seen.indexOf(call), "connected must arrive before the call");
    toHost({ id: call.id, result: textResult("tabs: none") });
    const reply = await pCall;
    assert.deepEqual(reply.result, textResult("tabs: none"));
  });

  await test("malformed socket line is logged and ignored; host keeps serving", async () => {
    const c = rawClient();
    await c.ready;
    c.socket.write("this is not json\n");
    c.socket.write("42\n");
    c.socket.write(JSON.stringify({ type: "hello", client: { name: "raw", version: "0" }, pid: 4242, cwd: "/raw" }) + "\n");
    c.socket.write(JSON.stringify({ id: 7, session: "s-raw", tool: "find", args: { query: "x" } }) + "\n");
    const ev = await expectHost("raw connected", isConnected("raw"));
    assert.deepEqual(ev.client, { id: ev.client.id, name: "raw", version: "0", pid: 4242, cwd: "/raw" });
    const call = await expectHost("raw call", isCall("find"));
    assert.equal(call.id, `${ev.client.id}:7`);
    toHost({ id: call.id, result: textResult("found") });
    await until("raw reply", () => c.lines.length);
    assert.deepEqual(c.lines[0], { id: 7, result: textResult("found") });
    assert.equal(hostExit, null);
    c.socket.end();
    await expectHost("raw disconnected", isDisconnected(ev.client.id));
  });

  await test("call before hello gets an 'unknown client' connected event first", async () => {
    const c = rawClient();
    await c.ready;
    c.socket.write(JSON.stringify({ id: 1, session: "s-anon", tool: "get_page_text", args: { tabId: 3 } }) + "\n");
    const ev = await expectHost("anon connected", isConnected("unknown client"));
    assert.equal(ev.client.version, null);
    assert.equal(ev.client.pid, null);
    const call = await expectHost("anon call", isCall("get_page_text"));
    assert.deepEqual(call.client, { id: ev.client.id, name: "unknown client" });
    c.socket.destroy();
    await expectHost("anon disconnected", isDisconnected(ev.client.id));
  });

  await test("socket that never says hello or calls produces no events", async () => {
    const c = rawClient();
    await c.ready;
    c.socket.destroy();
    await sleep(200);
    assert.equal(fromHost.filter((m) => m.type === "client").length, 0, JSON.stringify(fromHost));
  });

  await test("extension messages for closed/unknown clients and malformed frames don't crash the host", async () => {
    toHost({ id: "999:1", result: textResult("nobody") });
    toHost({ type: "disconnect_client", clientId: 999 });
    toHost("{not json");
    await sleep(200);
    assert.equal(hostExit, null);
  });

  await test("disconnect_client closes the socket; MCP server reconnects and says hello again", async () => {
    toHost({ type: "disconnect_client", clientId: mcpClientId });
    await expectHost("mcp disconnected", isDisconnected(mcpClientId));
    const pCall = mcp.request("tools/call", { name: "navigate", arguments: { url: "example.com" } });
    const ev = await expectHost("mcp reconnected", isConnected("test-client"));
    assert.notEqual(ev.client.id, mcpClientId);
    assert.equal(ev.client.pid, mcp.proc.pid);
    const call = await expectHost("mcp call after reconnect", isCall("navigate"));
    assert.deepEqual(call.client, { id: ev.client.id, name: "test-client" });
    toHost({ id: call.id, result: textResult("navigated") });
    assert.deepEqual((await pCall).result, textResult("navigated"));
    mcpClientId = ev.client.id;
  });

  await test("in-flight MCP call fails with a clear error when the user disconnects the client", async () => {
    const pCall = mcp.request("tools/call", { name: "get_page_text", arguments: { tabId: 1 } });
    await expectHost("in-flight call", isCall("get_page_text"));
    toHost({ type: "disconnect_client", clientId: mcpClientId });
    const reply = await pCall;
    assert.equal(reply.result.isError, true);
    assert.match(reply.result.content[0].text, /closed the connection/);
    await expectHost("mcp disconnected again", isDisconnected(mcpClientId));
  });

  await test("ffctl sends hello as 'ffctl', gets its reply, and disconnects", async () => {
    const proc = spawn(process.execPath, [path.join(ROOT, "scripts/ffctl.mjs"), "tabs_context_mcp", "{}", "sess-1"], {
      env,
      stdio: ["ignore", "pipe", "inherit"],
    });
    children.push(proc);
    let stdout = "";
    proc.stdout.on("data", (c) => (stdout += c));
    const exited = new Promise((r) => proc.on("exit", r));
    const ev = await expectHost("ffctl connected", isConnected("ffctl"));
    assert.equal(ev.client.pid, proc.pid);
    const call = await expectHost("ffctl call", isCall("tabs_context_mcp"));
    assert.deepEqual(call.client, { id: ev.client.id, name: "ffctl" });
    assert.equal(call.session, "sess-1");
    toHost({ id: call.id, result: textResult("hello from fake firefox") });
    assert.equal(await exited, 0);
    assert.match(stdout, /hello from fake firefox/);
    await expectHost("ffctl disconnected", isDisconnected(ev.client.id));
  });

  await test("host.log records connects with name, pid, cwd, and the malformed line", async () => {
    const logText = fs.readFileSync(path.join(DIR, "host.log"), "utf8");
    assert.match(logText, new RegExp(`connected: test-client 1\\.2\\.3 pid=${mcp.proc.pid} cwd=`));
    assert.match(logText, /connected: raw 0 pid=4242 cwd=\/raw/);
    assert.match(logText, /connected: ffctl pid=\d+ cwd=/);
    assert.match(logText, /disconnected: test-client/);
    assert.match(logText, /disconnected by the user in Firefox/);
    assert.match(logText, /malformed line \(\d+ chars\)/);
    assert.doesNotMatch(logText, /this is not json/);
    assert.match(logText, /malformed extension message/);
  });

  await test("no unexpected messages left from the host", async () => {
    assert.deepEqual(fromHost, []);
  });

  await test("host exits cleanly and removes the socket when the extension disconnects", async () => {
    host.stdin.end();
    await until("host exit", () => hostExit !== null);
    assert.equal(hostExit, 0);
    assert.equal(fs.existsSync(SOCKET), false);
  });

  console.log(`\n${results.length} passed`);
} catch (e) {
  console.error(`\nFAIL after ${results.length} passed:`, e.stack ?? e);
  try {
    console.error("--- host.log ---\n" + fs.readFileSync(path.join(DIR, "host.log"), "utf8"));
  } catch {}
  process.exitCode = 1;
} finally {
  for (const c of children) c.kill();
  fs.rmSync(HOME, { recursive: true, force: true });
}
