// mcp/server.mjs's server-side tools, against a fake bridge socket:
//  - batch runs {tool, args} actions in order, stops at the first error, keeps only the last image
//  - form_input with fields sets each field with its own form_input call
//   node --test host/test/*.test.mjs

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

// The fake Firefox: answers each call from `reply(tool, args)`, and records the calls.
let reply = () => ({ content: [{ type: "text", text: "ok" }] });
const calls = [];
let home, bridge, server, rl;
const pending = new Map();
let nextId = 1;

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "fab-batch-"));
  fs.mkdirSync(path.join(home, ".firefox-agent-bridge"), { mode: 0o700 });
  bridge = net.createServer((socket) => {
    let buf = "";
    socket.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const msg = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (!msg.tool) continue;
        calls.push({ tool: msg.tool, args: msg.args });
        const r = reply(msg.tool, msg.args);
        if (r !== null) socket.write(`${JSON.stringify({ id: msg.id, result: r })}\n`);
      }
    });
  });
  await new Promise((r) => bridge.listen(path.join(home, ".firefox-agent-bridge/bridge.sock"), r));
  server = spawn(process.execPath, [path.join(ROOT, "mcp/server.mjs")], { env: { ...process.env, HOME: home, FIREFOX_AGENT_BRIDGE_SESSION: "" }, stdio: ["pipe", "pipe", "inherit"] });
  rl = readline.createInterface({ input: server.stdout });
  rl.on("line", (l) => {
    const m = JSON.parse(l);
    pending.get(m.id)?.(m);
    pending.delete(m.id);
  });
  await rpc("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "test", version: "1" } });
});

after(() => {
  server.kill();
  bridge.close();
  fs.rmSync(home, { recursive: true, force: true });
});

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

async function call(name, args) {
  calls.length = 0;
  return (await rpc("tools/call", { name, arguments: args })).result;
}
const texts = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

test("tools/list offers batch, and form_input takes fields without ref/value", async () => {
  const { tools } = (await rpc("tools/list", {})).result;
  const b = tools.find((t) => t.name === "batch");
  assert.ok(b);
  assert.ok(!b.inputSchema.properties.actions.items.properties.tool.enum.includes("batch"));
  const fi = tools.find((t) => t.name === "form_input");
  assert.equal(fi.inputSchema.required, undefined);
  assert.ok(fi.inputSchema.properties.fields);
  assert.match(tools.find((t) => t.name === "javascript_tool").description, /DOMParser/);
});

test("batch runs actions in order and returns each one's text", async () => {
  reply = (tool, args) => ({ content: [{ type: "text", text: `${tool} ${args.url ?? ""}`.trim() }] });
  const r = await call("batch", { actions: [
    { tool: "navigate", args: { tabId: 1, url: "a.example" } },
    { tool: "get_page_text", args: { tabId: 1 } },
  ] });
  assert.equal(r.isError, undefined);
  assert.deepEqual(calls.map((c) => c.tool), ["navigate", "get_page_text"]);
  assert.equal(calls[0].args.url, "a.example");
  const t = texts(r);
  assert.match(t, /\[1\/2\] navigate:\nnavigate a\.example/);
  assert.match(t, /\[2\/2\] get_page_text:\nget_page_text/);
});

test("batch stops at the first error and says what did not run", async () => {
  reply = (tool) => (tool === "find" ? { content: [{ type: "text", text: "No tab 9" }], isError: true } : { content: [{ type: "text", text: "ok" }] });
  const r = await call("batch", { actions: [
    { tool: "navigate", args: { tabId: 1, url: "x" } },
    { tool: "find", args: { tabId: 9, query: "q" } },
    { tool: "get_page_text", args: { tabId: 1 } },
  ] });
  assert.equal(r.isError, true);
  assert.deepEqual(calls.map((c) => c.tool), ["navigate", "find"]);
  assert.match(texts(r), /\[2\/3\] find failed:\nNo tab 9/);
  assert.match(texts(r), /remaining 1 action\(s\) did not run/);
});

test("batch keeps only the last image", async () => {
  let n = 0;
  reply = () => ({ content: [{ type: "image", data: `img${++n}`, mimeType: "image/jpeg" }] });
  const r = await call("batch", { actions: [
    { tool: "computer", args: { tabId: 1, action: "screenshot" } },
    { tool: "computer", args: { tabId: 1, action: "screenshot" } },
  ] });
  const imgs = r.content.filter((c) => c.type === "image");
  assert.equal(imgs.length, 1);
  assert.equal(imgs[0].data, "img2");
  assert.match(texts(r), /image omitted/);
});

test("batch rejects nested batches and unknown tools without calling Firefox", async () => {
  const r = await call("batch", { actions: [{ tool: "batch", args: { actions: [] } }] });
  assert.equal(r.isError, true);
  assert.equal(calls.length, 0);
  const e = await call("batch", { actions: [] });
  assert.equal(e.isError, true);
});

test("form_input fields: one form_input per field, stopping at the first failure", async () => {
  reply = (tool, args) => (args.ref === "ref_bad" ? { content: [{ type: "text", text: "No element ref_bad" }], isError: true } : { content: [{ type: "text", text: `Set ${args.ref}` }] });
  const ok = await call("form_input", { tabId: 3, fields: [{ ref: "ref_1", value: "a" }, { ref: "ref_2", value: true }] });
  assert.equal(ok.isError, undefined);
  assert.deepEqual(calls.map((c) => c.args), [{ tabId: 3, ref: "ref_1", value: "a" }, { tabId: 3, ref: "ref_2", value: true }]);
  assert.match(texts(ok), /\[2\/2\] ref_2: Set ref_2/);
  const bad = await call("form_input", { tabId: 3, fields: [{ ref: "ref_bad", value: "a" }, { ref: "ref_2", value: "b" }] });
  assert.equal(bad.isError, true);
  assert.equal(calls.length, 1);
  assert.match(texts(bad), /ref_bad: failed: No element ref_bad/);
});

test("form_input with ref/value is still a single passthrough call", async () => {
  reply = () => ({ content: [{ type: "text", text: "Set" }] });
  const r = await call("form_input", { tabId: 3, ref: "ref_1", value: "x" });
  assert.equal(texts(r), "Set");
  assert.deepEqual(calls, [{ tool: "form_input", args: { tabId: 3, ref: "ref_1", value: "x" } }]);
  const e = await call("form_input", { tabId: 3 });
  assert.equal(e.isError, true);
  assert.equal(calls.length, 0);
});

test("form_input fields work inside a batch", async () => {
  reply = (tool, args) => ({ content: [{ type: "text", text: `${tool} ${args.ref ?? ""}` }] });
  const r = await call("batch", { actions: [
    { tool: "form_input", args: { tabId: 1, fields: [{ ref: "ref_1", value: "a" }, { ref: "ref_2", value: "b" }] } },
    { tool: "computer", args: { tabId: 1, action: "left_click", ref: "ref_9" } },
  ] });
  assert.equal(r.isError, undefined);
  assert.deepEqual(calls.map((c) => c.tool), ["form_input", "form_input", "computer"]);
});
