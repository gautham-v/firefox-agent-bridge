"use strict";

// node --test extension/test/*.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { createControl, summarizeArgs, logError, pageOrigin } = require("../control.js");

function fakeTimers() {
  let t = 1_000_000;
  let next = 1;
  const pending = new Map();
  return {
    now: () => t,
    timers: {
      setTimeout: (fn, ms) => (pending.set(next, { fn, at: t + ms }), next++),
      clearTimeout: (id) => pending.delete(id),
    },
    advance(ms) {
      t += ms;
      for (const [id, p] of [...pending]) if (p.at <= t) (pending.delete(id), p.fn());
    },
  };
}

function setup({ allowed = [], ...opts } = {}) {
  const store = { allowedClients: allowed };
  const storage = { get: async (k) => ({ [k]: store[k] }), set: async (o) => Object.assign(store, o) };
  const sent = [];
  const pauses = [];
  const clock = fakeTimers();
  const control = createControl({
    storage,
    send: (m) => sent.push(m),
    onPauseChange: (s, p) => pauses.push([s, p]),
    now: clock.now,
    timers: clock.timers,
    ...opts,
  });
  const replies = () => sent.filter((m) => m.result);
  return { control, sent, replies, store, pauses, clock };
}

const call = (id, session = "s1", client = { id: 1, name: "Claude Code" }, tool = "tabs_context_mcp", args = {}) => ({ type: "call", id: `1:${id}`, session, tool, args, client });
const tick = () => new Promise((r) => setImmediate(r));
const ok = async () => [{ type: "text", text: "ok" }];

test("allowed client runs and is logged", async () => {
  const { control, replies } = setup({ allowed: ["Claude Code"] });
  await control.handleCall(call(1), ok);
  assert.deepEqual(replies(), [{ id: "1:1", result: { content: [{ type: "text", text: "ok" }] } }]);
  const [e] = control.snapshot().log;
  assert.equal(e.outcome, "ok");
  assert.equal(e.client, "Claude Code");
  assert.equal(control.badge().state, "acting");
});

test("acting badge lapses after ~3s, idle has no badge", async () => {
  const { control, clock } = setup({ allowed: ["Claude Code"] });
  assert.deepEqual(control.badge(), { state: "idle", text: "", color: null });
  await control.handleCall(call(1), ok);
  clock.advance(2900);
  assert.equal(control.badge().state, "acting");
  clock.advance(200);
  assert.equal(control.badge().state, "idle");
});

test("unknown client waits for approval, then runs on Allow", async () => {
  const { control, replies, store } = setup();
  control.clientEvent({ type: "client", event: "connected", client: { id: 1, name: "Claude Code", version: "2.0", pid: 42, cwd: "/w" } });
  assert.equal(control.badge().state, "approval");
  let ran = false;
  await control.handleCall(call(1), async () => ((ran = true), []));
  assert.equal(ran, false);
  assert.equal(replies().length, 0);
  const [a] = control.snapshot().approvals;
  assert.equal(a.name, "Claude Code");
  assert.equal(a.waiting, 1);
  assert.deepEqual(a.clients[0], { id: 1, pid: 42, cwd: "/w", version: "2.0" });
  control.allow("Claude Code");
  await tick();
  assert.equal(ran, true);
  assert.equal(replies().length, 1);
  assert.deepEqual(store.allowedClients, ["Claude Code"]);
  assert.equal(control.snapshot().approvals.length, 0);
});

test("approval times out after 45s with a clear message", async () => {
  const { control, replies, clock } = setup();
  await control.handleCall(call(1), ok);
  clock.advance(44_999);
  assert.equal(replies().length, 0);
  clock.advance(1);
  const [r] = replies();
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /no answer within 45s/);
  assert.equal(control.snapshot().log[0].outcome, "blocked-not-allowed");
  // Late Allow after a timeout does not run the call again.
  control.allow("Claude Code");
  await tick();
  assert.equal(replies().length, 1);
});

test("Deny fails waiting and later calls", async () => {
  const { control, replies } = setup();
  await control.handleCall(call(1), ok);
  control.deny("Claude Code");
  await control.handleCall(call(2), ok);
  assert.equal(replies().length, 2);
  for (const r of replies()) assert.match(r.result.content[0].text, /denied "Claude Code"/);
  assert.deepEqual(control.snapshot().log.map((e) => e.outcome), ["blocked-not-allowed", "blocked-not-allowed"]);
  control.forget("Claude Code");
  assert.equal(control.snapshot().denied.length, 0);
});

test("call before hello uses the name the host gave it; no client info falls back", async () => {
  const { control } = setup();
  await control.handleCall({ id: "7:1", session: "s", tool: "find", args: {} }, ok);
  assert.equal(control.snapshot().approvals[0].name, "unknown client");
});

test("Stop answers in-flight calls now and drops late results", async () => {
  const { control, replies, pauses } = setup({ allowed: ["Claude Code"] });
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
});

test("while paused, calls fail fast; new sessions start paused; resume per session and all", async () => {
  const { control, replies, clock } = setup({ allowed: ["Claude Code"] });
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
});

test("takeover pauses one session only and says why", async () => {
  const { control, replies } = setup({ allowed: ["Claude Code"] });
  await control.handleCall(call(1, "a"), ok);
  await control.handleCall(call(2, "b"), ok);
  control.pauseSession("a", "takeover");
  await control.handleCall(call(3, "a"), ok);
  await control.handleCall(call(4, "b"), ok);
  const [ra, rb] = replies().slice(-2);
  assert.match(ra.result.content[0].text, /took over/);
  assert.equal(rb.result.isError, undefined);
  assert.equal(control.snapshot().sessions.find((s) => s.id === "a").paused, "takeover");
});

test("pause during a waiting approval stops the call, and Allow later does not run it", async () => {
  const { control, replies } = setup();
  let ran = false;
  await control.handleCall(call(1), async () => ((ran = true), []));
  control.stopAll();
  assert.equal(replies().length, 1);
  control.allow("Claude Code");
  await tick();
  assert.equal(ran, false);
});

test("Revoke removes the name and disconnects its clients", async () => {
  const { control, sent, store } = setup({ allowed: ["Claude Code", "ffctl"] });
  await control.ready;
  control.clientEvent({ type: "client", event: "connected", client: { id: 1, name: "Claude Code", pid: 1, cwd: "/" } });
  control.clientEvent({ type: "client", event: "connected", client: { id: 2, name: "Claude Code", pid: 2, cwd: "/" } });
  control.clientEvent({ type: "client", event: "connected", client: { id: 3, name: "ffctl", pid: 3, cwd: "/" } });
  control.revoke("Claude Code");
  assert.deepEqual(sent.filter((m) => m.type === "disconnect_client").map((m) => m.clientId), [1, 2]);
  await tick();
  assert.deepEqual(store.allowedClients, ["ffctl"]);
  assert.deepEqual(control.snapshot().allowed, ["ffctl"]);
});

test("client disconnect fails its waiting calls", async () => {
  const { control, replies } = setup();
  control.clientEvent({ type: "client", event: "connected", client: { id: 1, name: "x" } });
  await control.handleCall(call(1, "s", { id: 1, name: "x" }), ok);
  control.clientEvent({ type: "client", event: "disconnected", client: { id: 1 } });
  assert.equal(replies().length, 1);
  assert.equal(control.snapshot().approvals.length, 0);
});

test("log never keeps typed text, form values, script source or URLs", async () => {
  const secret = "hunter2-secret";
  const { control } = setup({ allowed: ["Claude Code"] });
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
  const { control } = setup({ allowed: ["Claude Code"] });
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
  const { control } = setup({ allowed: ["Claude Code"] });
  for (let i = 0; i < 510; i++) await control.handleCall(call(i), ok);
  const log = control.snapshot().log;
  assert.equal(log.length, 500);
  control.clearLog();
  assert.equal(control.snapshot().log.length, 0);
});

test("host disconnect fails pending calls", async () => {
  const { control, replies } = setup();
  await control.handleCall(call(1), ok);
  control.hostDisconnected();
  assert.equal(replies().length, 1);
  assert.equal(control.snapshot().connected.length, 0);
});

test("helpers", () => {
  assert.equal(pageOrigin("about:blank"), "about:blank");
  assert.equal(pageOrigin("data:text/html,<b>x</b>"), "data:");
  assert.equal(pageOrigin("https://a.b:8080/x?y"), "https://a.b:8080");
  assert.equal(pageOrigin(undefined), null);
  assert.equal(summarizeArgs("computer", { action: "key", text: "cmd+a", tabId: 1 }).detail, "5-char key sequence");
  assert.equal(logError("find", {}, "x".repeat(500)).length, 160);
});
