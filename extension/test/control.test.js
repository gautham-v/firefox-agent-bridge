"use strict";

// node --test extension/test/*.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { createControl, summarizeArgs, logError, pageOrigin } = require("../control.js");

function fakeClock() {
  let t = 1_000_000;
  return { now: () => t, advance: (ms) => (t += ms) };
}

function setup(opts = {}) {
  const sent = [];
  const pauses = [];
  const clock = fakeClock();
  const control = createControl({
    send: (m) => sent.push(m),
    onPauseChange: (s, p) => pauses.push([s, p]),
    now: clock.now,
    ...opts,
  });
  const replies = () => sent.filter((m) => m.result);
  return { control, sent, replies, pauses, clock };
}

const call = (id, session = "s1", client = { id: 1, name: "Claude Code" }, tool = "tabs_context_mcp", args = {}) => ({ type: "call", id: `1:${id}`, session, tool, args, client });
const tick = () => new Promise((r) => setImmediate(r));
const ok = async () => [{ type: "text", text: "ok" }];

test("any client runs immediately and is logged with its name", async () => {
  const { control, replies } = setup();
  let gotClient;
  await control.handleCall(call(1, "s1", { id: 7, name: "codex-mcp-client" }), async (session, tool, args, client) => ((gotClient = client), []));
  assert.equal(replies().length, 1);
  assert.equal(replies()[0].result.isError, undefined);
  assert.equal(gotClient, "codex-mcp-client");
  const [e] = control.snapshot().log;
  assert.equal(e.outcome, "ok");
  assert.equal(e.client, "codex-mcp-client");
  assert.equal(control.badge().state, "acting");
});

test("acting badge lapses after ~3s, idle has no badge", async () => {
  const { control, clock } = setup();
  assert.deepEqual(control.badge(), { state: "idle", text: "", color: null });
  await control.handleCall(call(1), ok);
  clock.advance(2900);
  assert.equal(control.badge().state, "acting");
  clock.advance(200);
  assert.equal(control.badge().state, "idle");
});

test("connected clients are listed with details, connect time and call count", async () => {
  const { control, clock } = setup();
  control.clientEvent({ type: "client", event: "connected", client: { id: 1, name: "Claude Code", version: "2.0", pid: 42, cwd: "/w" } });
  const at = clock.now();
  clock.advance(10);
  await control.handleCall(call(1), ok);
  await control.handleCall(call(2), ok);
  assert.deepEqual(control.snapshot().clients, [{ id: 1, name: "Claude Code", version: "2.0", pid: 42, cwd: "/w", connectedAt: at, calls: 2, blocked: false }]);
  control.clientEvent({ type: "client", event: "disconnected", client: { id: 1 } });
  assert.equal(control.snapshot().clients.length, 0);
});

test("call before hello uses the name the host gave it; no client info falls back", async () => {
  const { control } = setup();
  await control.handleCall({ id: "7:1", session: "s", tool: "find", args: {} }, ok);
  assert.equal(control.snapshot().log[0].client, "unknown client");
});

test("Disconnect cuts that connection and blocks the name until Unblock", async () => {
  const { control, sent, replies } = setup();
  control.clientEvent({ type: "client", event: "connected", client: { id: 1, name: "Claude Code", pid: 1, cwd: "/" } });
  control.clientEvent({ type: "client", event: "connected", client: { id: 3, name: "ffctl", pid: 3, cwd: "/" } });
  let finishRun;
  const p = control.handleCall(call(1), () => new Promise((r) => (finishRun = r)));
  await tick();
  control.disconnect(1);
  assert.deepEqual(sent.filter((m) => m.type === "disconnect_client"), [{ type: "disconnect_client", clientId: 1 }]);
  assert.match(replies()[0].result.content[0].text, /disconnected this client \("Claude Code"\) in Firefox/);
  finishRun([]);
  await p;
  assert.equal(replies().length, 1, "late result dropped");
  assert.deepEqual(control.snapshot().blocked, ["Claude Code"]);
  assert.deepEqual(control.snapshot().clients.map((c) => c.id), [3]);

  // The MCP server reconnects under the same name: its calls fail fast.
  control.clientEvent({ type: "client", event: "connected", client: { id: 2, name: "Claude Code", pid: 1, cwd: "/" } });
  assert.equal(control.snapshot().clients.find((c) => c.id === 2).blocked, true);
  let ran = false;
  await control.handleCall(call(2, "s1", { id: 2, name: "Claude Code" }), async () => ((ran = true), []));
  assert.equal(ran, false);
  assert.match(replies()[1].result.content[0].text, /disconnected this client.*Unblock/);
  assert.equal(control.snapshot().log.at(-1).outcome, "blocked-disconnected");
  assert.equal(control.snapshot().log.at(-1).client, "Claude Code");

  // Other clients are unaffected.
  await control.handleCall(call(3, "s2", { id: 3, name: "ffctl" }), ok);
  assert.equal(replies()[2].result.isError, undefined);

  control.unblock("Claude Code");
  await control.handleCall(call(4, "s1", { id: 2, name: "Claude Code" }), ok);
  assert.equal(replies()[3].result.isError, undefined);
  assert.deepEqual(control.snapshot().blocked, []);
});

test("Stop answers in-flight calls now and drops late results", async () => {
  const { control, replies, pauses } = setup();
  let finishRun;
  const p = control.handleCall(call(1), () => new Promise((r) => (finishRun = r)));
  await tick();
  assert.equal(control.badge().state, "acting");
  control.stopAll();
  assert.equal(replies().length, 1);
  assert.match(replies()[0].result.content[0].text, /stopped this call/);
  finishRun([{ type: "text", text: "late" }]);
  await p;
  assert.equal(replies().length, 1, "late result dropped");
  assert.deepEqual(pauses, [["s1", true]]);
  assert.equal(control.snapshot().log[0].outcome, "stopped");
  assert.equal(control.badge().state, "paused", "no lingering acting badge after Stop");
});

test("while paused, calls fail fast; new sessions start paused; resume per session and all", async () => {
  const { control, replies, clock, pauses } = setup();
  await control.handleCall(call(1, "a"), ok);
  await control.handleCall(call(2, "b"), ok);
  control.stopAll();
  clock.advance(5000);
  assert.equal(control.badge().state, "paused");
  let ran = 0;
  const run = async () => (ran++, []);
  await control.handleCall(call(3, "a"), run);
  await control.handleCall(call(4, "c"), run);
  assert.equal(ran, 0);
  const texts = replies().slice(-2).map((r) => r.result.content[0].text);
  for (const t of texts) assert.match(t, /paused this session.*toolbar button/);
  assert.equal(control.snapshot().sessions.find((s) => s.id === "a").paused, true);
  control.resume("a");
  await control.handleCall(call(5, "a"), run);
  assert.equal(ran, 1);
  await control.handleCall(call(6, "b"), run);
  assert.equal(ran, 1);
  control.resumeAll();
  await control.handleCall(call(7, "b"), run);
  await control.handleCall(call(8, "d"), run);
  assert.equal(ran, 3);
  assert.deepEqual(control.snapshot().log.filter((e) => e.outcome === "blocked-paused").length, 3);
  assert.deepEqual(pauses.filter(([, p]) => p).map(([s]) => s).sort(), ["a", "b", "c"]);
});

test("log never keeps typed text, form values, script source or URLs", async () => {
  const secret = "hunter2-secret";
  const { control } = setup();
  const origins = { 5: "https://bank.example/account?token=abc" };
  const fail = async () => {
    throw new Error(`No option matching ${JSON.stringify(secret)}. Options: a, b`);
  };
  await control.handleCall(call(1, "s", undefined, "computer", { action: "type", tabId: 5, text: secret }), ok, async (id) => origins[id]);
  await control.handleCall(call(2, "s", undefined, "form_input", { tabId: 5, ref: "r1", value: secret }), fail, async (id) => origins[id]);
  await control.handleCall(call(3, "s", undefined, "javascript_tool", { tabId: 5, text: `const x="${secret}"; boom()` }), async () => {
    throw new Error(`ReferenceError: boom is not defined; ${secret}`);
  });
  await control.handleCall(call(4, "s", undefined, "navigate", { url: `bank.example/login?u=${secret}` }), ok);
  await control.handleCall(call(5, "s", undefined, "file_upload", { tabId: 5, ref: "f", paths: [`/Users/me/${secret}.pdf`] }), ok);
  await tick();
  const log = control.snapshot().log;
  const json = JSON.stringify(log);
  assert.ok(!json.includes(secret), json);
  assert.ok(!json.includes("token=abc"));
  assert.equal(log[0].action, "type");
  assert.equal(log[0].detail, `${secret.length} chars typed`);
  assert.equal(log[0].origin, "https://bank.example");
  assert.equal(log[1].outcome, "error");
  assert.match(log[1].error, /\[redacted\]/);
  assert.equal(log[2].error, "ReferenceError");
  assert.equal(log[3].detail, "to https://bank.example");
  assert.equal(log[4].detail, "1 file(s)");
});

test("errors that echo a URL or file path are redacted", async () => {
  const secret = "hunter2-secret";
  const { control } = setup();
  const url = `https://bank.example/login?u=${secret}`;
  const path = `/Users/me/${secret}.pdf`;
  await control.handleCall(call(1, "s", undefined, "navigate", { url }), async () => {
    throw new Error(`Illegal URL: ${url}`);
  });
  await control.handleCall(call(2, "s", undefined, "file_upload", { tabId: 5, ref: "f", paths: [path] }), async () => {
    throw new Error(`File not found: ${path}`);
  });
  const json = JSON.stringify(control.snapshot().log);
  assert.ok(!json.includes(secret), json);
  assert.match(json, /Illegal URL: \[redacted\]/);
});

test("log is a ring buffer of 500", async () => {
  const { control } = setup();
  for (let i = 0; i < 510; i++) await control.handleCall(call(i), ok);
  const log = control.snapshot().log;
  assert.equal(log.length, 500);
  control.clearLog();
  assert.equal(control.snapshot().log.length, 0);
});

test("host disconnect fails running calls", async () => {
  const { control, replies } = setup();
  control.clientEvent({ type: "client", event: "connected", client: { id: 1, name: "x" } });
  control.handleCall(call(1), () => new Promise(() => {}));
  await tick();
  control.hostDisconnected();
  assert.equal(replies().length, 1);
  assert.equal(control.snapshot().clients.length, 0);
  assert.match(replies()[0].result.content[0].text, /native host disconnected/);
});

test("helpers", () => {
  assert.equal(pageOrigin("about:blank"), "about:blank");
  assert.equal(pageOrigin("data:text/html,<b>x</b>"), "data:");
  assert.equal(pageOrigin("https://a.b:8080/x?y"), "https://a.b:8080");
  assert.equal(pageOrigin(undefined), null);
  assert.equal(summarizeArgs("computer", { action: "key", text: "cmd+a", tabId: 1 }).detail, "5-char key sequence");
  assert.equal(logError("find", {}, "x".repeat(500)).length, 160);
});
