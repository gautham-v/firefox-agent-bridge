"use strict";

// The user's side of the bridge: which clients may drive the browser, which sessions are
// paused, and a log of every call. No DOM or tab work here; background.js wires it to the
// browser, and extension/test/ runs it in node with a mocked storage.

const APPROVAL_TIMEOUT_MS = 45_000; // must stay under the MCP server's CALL_TIMEOUT_MS (90s)
const RECENT_MS = 3_000;
const LOG_SIZE = 500;
const ERROR_CHARS = 160;
const ALLOWED_KEY = "allowedClients";

const RESUME_HINT = "Ask the user to resume it from the Firefox Agent Bridge toolbar button, then retry.";

const BADGES = {
  approval: { text: "?", color: "#b45309" },
  acting: { text: "RUN", color: "#1d4ed8" },
  paused: { text: "||", color: "#4b5563" },
  idle: { text: "", color: null },
};

function pageOrigin(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.origin !== "null") return u.origin;
    return u.protocol === "about:" ? `about:${u.pathname}` : u.protocol;
  } catch {
    return null;
  }
}

const len = (v) => (v == null ? 0 : String(v).length);

// What the log may keep about a call's arguments: never typed text, form values, script source
// or file paths, only their sizes.
function summarizeArgs(tool, args) {
  const out = { action: null, tabId: typeof args.tabId === "number" ? args.tabId : null, detail: null };
  switch (tool) {
    case "computer":
      out.action = typeof args.action === "string" ? args.action : null;
      if (args.action === "type") out.detail = `${len(args.text)} chars typed`;
      else if (args.action === "key") out.detail = `${len(args.text)}-char key sequence`;
      break;
    case "navigate":
      if (args.url === "back" || args.url === "forward") out.action = args.url;
      else out.detail = `to ${pageOrigin(/^[a-z][a-z0-9+.-]*:/i.test(args.url ?? "") ? args.url : `https://${args.url}`) ?? "invalid URL"}`;
      break;
    case "form_input":
      out.detail = `${len(args.value)}-char value`;
      break;
    case "javascript_tool":
      out.detail = `${len(args.text)} chars of script`;
      break;
    case "find":
      out.detail = `${len(args.query)}-char query`;
      break;
    case "file_upload":
      out.detail = `${Array.isArray(args.paths) ? args.paths.length : 0} file(s)`;
      break;
  }
  return out;
}

// Error text as logged. Page errors can echo what was typed or evaluated, or the URL or file
// paths passed in, so those strings are cut out, and script errors keep only their type.
function logError(tool, args, message) {
  let msg = String(message ?? "");
  if (tool === "javascript_tool") return msg.match(/^\s*(?:Uncaught\s+)?(\w*Error)\b/)?.[1] ?? "page script failed";
  const paths = Array.isArray(args.paths) ? args.paths : [];
  for (const secret of [args.text, args.value, args.query, args.url, ...paths]) {
    if (secret == null || secret === "") continue;
    for (const form of [JSON.stringify(secret), String(secret)]) msg = msg.split(form).join("[redacted]");
  }
  return msg.length > ERROR_CHARS ? msg.slice(0, ERROR_CHARS - 1) + "…" : msg;
}

function createControl({
  storage,
  send,
  onChange = () => {},
  onPauseChange = () => {},
  now = Date.now,
  timers = { setTimeout, clearTimeout },
  approvalTimeoutMs = APPROVAL_TIMEOUT_MS,
} = {}) {
  const connected = new Map(); // client id -> { id, name, version, pid, cwd }
  const allowed = new Set(); // client names, persisted
  const denied = new Set(); // client names, until the browser restarts
  const paused = new Map(); // session -> "stopped" | "takeover"
  const sessions = new Map(); // session -> { client, clientId, firstAt, lastAt }
  const calls = new Map(); // call id -> call waiting for approval or running
  const log = [];
  let pauseNew = false; // after Stop, sessions not seen yet start out paused
  let lastFinishedAt = -Infinity;
  const lastBySession = new Map();

  const ready = Promise.resolve(storage?.get(ALLOWED_KEY))
    .then((got) => {
      for (const name of got?.[ALLOWED_KEY] ?? []) allowed.add(name);
    })
    .catch(() => {});

  const persist = () => Promise.resolve(storage?.set({ [ALLOWED_KEY]: [...allowed] })).catch(() => {});

  function clientFor(c) {
    const id = typeof c?.id === "number" ? c.id : null;
    if (id != null && connected.has(id)) return connected.get(id);
    const client = { id, name: typeof c?.name === "string" && c.name ? c.name : "unknown client", version: null, pid: null, cwd: null };
    if (id != null) connected.set(id, client);
    return client;
  }

  function clientEvent(msg) {
    const c = msg.client ?? {};
    if (msg.event === "connected" && typeof c.id === "number") {
      connected.set(c.id, {
        id: c.id,
        name: typeof c.name === "string" && c.name ? c.name : "unknown client",
        version: c.version ?? null,
        pid: c.pid ?? null,
        cwd: c.cwd ?? null,
      });
    } else if (msg.event === "disconnected") {
      connected.delete(c.id);
      for (const call of [...calls.values()]) {
        if (call.clientId === c.id && call.phase === "waiting") finish(call, "error", "The client disconnected before the user answered.", "client disconnected");
      }
    }
    onChange();
  }

  function decision(name) {
    if (allowed.has(name)) return "allowed";
    if (denied.has(name)) return "denied";
    return "ask";
  }

  function pausedMessage(session) {
    const why = paused.get(session) === "takeover" ? " (they switched to this session's tab and took over)" : "";
    return `The user paused this session in Firefox${why}, so nothing was done. Don't retry on your own. ${RESUME_HINT}`;
  }

  function deniedMessage(name) {
    return `The user denied "${name}" access to Firefox, so nothing was done. If that was a mistake, ask the user to allow it from the Firefox Agent Bridge toolbar button.`;
  }

  function reply(id, outcome, payload) {
    const result = outcome === "ok" ? { content: payload } : { content: [{ type: "text", text: String(payload) }], isError: true };
    send?.({ id, result });
  }

  // Answers a call exactly once; a result that arrives after Stop or a timeout is dropped.
  function finish(call, outcome, payload, note) {
    if (call.done) return false;
    call.done = true;
    calls.delete(call.id);
    if (call.timer) timers.clearTimeout(call.timer);
    reply(call.id, outcome, payload);
    const t = now();
    const entry = call.entry;
    entry.outcome = outcome;
    entry.ms = t - call.t0;
    if (outcome !== "ok") entry.error = note ?? logError(call.tool, call.args, payload);
    log.push(entry);
    if (log.length > LOG_SIZE) log.splice(0, log.length - LOG_SIZE);
    if (call.phase === "running") {
      lastFinishedAt = t;
      lastBySession.set(call.session, t);
    }
    onChange();
    return true;
  }

  async function handleCall(msg, run, tabOrigin = async () => null) {
    await ready;
    const args = msg.args ?? {};
    const client = clientFor(msg.client);
    const t0 = now();
    const summary = summarizeArgs(msg.tool, args);
    const call = {
      id: msg.id,
      session: msg.session,
      tool: msg.tool,
      args,
      clientId: client.id,
      clientName: client.name,
      t0,
      phase: "new",
      done: false,
      timer: null,
      run,
      tabOrigin,
      entry: {
        time: new Date(t0).toISOString(),
        session: msg.session,
        client: client.name,
        tool: msg.tool,
        action: summary.action,
        tabId: summary.tabId,
        origin: null,
        detail: summary.detail,
        outcome: null,
        error: null,
        ms: 0,
      },
    };
    if (!sessions.has(msg.session)) {
      sessions.set(msg.session, { client: client.name, clientId: client.id, firstAt: t0, lastAt: t0 });
      if (pauseNew) setPaused(msg.session, "stopped");
    } else {
      Object.assign(sessions.get(msg.session), { client: client.name, clientId: client.id, lastAt: t0 });
    }
    calls.set(call.id, call);

    if (paused.has(call.session)) return finish(call, "blocked-paused", pausedMessage(call.session), `session paused (${paused.get(call.session)})`);
    const d = decision(client.name);
    if (d === "denied") return finish(call, "blocked-not-allowed", deniedMessage(client.name), "client denied");
    if (d === "ask") {
      call.phase = "waiting";
      call.timer = timers.setTimeout(() => {
        finish(
          call,
          "blocked-not-allowed",
          `Firefox Agent Bridge asked the user whether to allow "${client.name}" and got no answer within ${approvalTimeoutMs / 1000}s, so nothing was done. Ask the user to click the Firefox Agent Bridge toolbar button, choose Allow, and then retry.`,
          "no answer to the approval prompt",
        );
      }, approvalTimeoutMs);
      onChange();
      return;
    }
    return proceed(call);
  }

  async function proceed(call) {
    if (call.done) return;
    if (call.timer) timers.clearTimeout(call.timer);
    call.timer = null;
    if (paused.has(call.session)) return finish(call, "blocked-paused", pausedMessage(call.session), `session paused (${paused.get(call.session)})`);
    call.phase = "running";
    onChange();
    const tabId = call.entry.tabId;
    if (tabId != null) call.entry.origin = pageOrigin(await Promise.resolve(call.tabOrigin(tabId)).catch(() => null));
    if (call.done) return;
    let outcome;
    let payload;
    try {
      payload = await call.run(call.session, call.tool, call.args);
      outcome = "ok";
    } catch (e) {
      payload = e?.message ?? String(e);
      outcome = "error";
    }
    if (!finish(call, outcome, payload)) return;
    if (tabId != null) {
      // Pages move (navigate, clicks); log where the tab ended up if it still exists.
      const after = pageOrigin(await Promise.resolve(call.tabOrigin(tabId)).catch(() => null));
      if (after) call.entry.origin = after;
    }
  }

  function setPaused(session, reason) {
    const was = paused.has(session);
    paused.set(session, reason);
    if (!was) onPauseChange(session, true);
  }

  function stopCallsFor(pred, message, note) {
    for (const call of [...calls.values()]) if (pred(call)) finish(call, "stopped", message, note);
  }

  const stoppedMessage = `The user stopped this call in Firefox. It may have partly run. The session is now paused. ${RESUME_HINT}`;

  function stopAll() {
    pauseNew = true;
    for (const session of sessions.keys()) if (!paused.has(session)) setPaused(session, "stopped");
    stopCallsFor(() => true, stoppedMessage, "stopped by the user");
    onChange();
  }

  function pauseSession(session, reason = "stopped") {
    if (!sessions.has(session)) return;
    if (paused.get(session) === reason) return;
    setPaused(session, reason);
    stopCallsFor((c) => c.session === session, stoppedMessage, reason === "takeover" ? "user took over" : "stopped by the user");
    onChange();
  }

  function resume(session) {
    if (paused.delete(session)) onPauseChange(session, false);
    onChange();
  }

  function resumeAll() {
    pauseNew = false;
    for (const session of [...paused.keys()]) resume(session);
    onChange();
  }

  function allow(name) {
    denied.delete(name);
    allowed.add(name);
    persist();
    for (const call of [...calls.values()]) if (call.phase === "waiting" && call.clientName === name) proceed(call);
    onChange();
  }

  function deny(name) {
    allowed.delete(name);
    denied.add(name);
    persist();
    for (const call of [...calls.values()]) {
      if (call.phase === "waiting" && call.clientName === name) finish(call, "blocked-not-allowed", deniedMessage(name));
    }
    onChange();
  }

  // Revoking also cuts the connections, so a running client has to reconnect and ask again.
  function revoke(name) {
    allowed.delete(name);
    persist();
    stopCallsFor((c) => c.clientName === name, `The user revoked "${name}"'s access to Firefox, so this call was stopped.`, "client revoked");
    for (const c of [...connected.values()]) {
      if (c.name !== name || c.id == null) continue;
      send?.({ type: "disconnect_client", clientId: c.id });
      connected.delete(c.id);
    }
    onChange();
  }

  function forget(name) {
    denied.delete(name);
    onChange();
  }

  // The native host went away: every connection went with it.
  function hostDisconnected() {
    connected.clear();
    for (const call of [...calls.values()]) finish(call, "error", "The native host disconnected.", "native host disconnected");
    onChange();
  }

  function clearLog() {
    log.length = 0;
    onChange();
  }

  function isActing(t = now()) {
    for (const c of calls.values()) if (c.phase === "running") return true;
    return t - lastFinishedAt < RECENT_MS;
  }

  function approvalsNeeded() {
    const byName = new Map();
    const add = (name, client) => {
      if (decision(name) !== "ask") return;
      const a = byName.get(name) ?? { name, clients: [], waiting: 0 };
      if (client && !a.clients.some((x) => x.id === client.id)) a.clients.push({ id: client.id, pid: client.pid, cwd: client.cwd, version: client.version });
      byName.set(name, a);
      return a;
    };
    for (const c of connected.values()) add(c.name, c);
    for (const call of calls.values()) {
      if (call.phase !== "waiting") continue;
      const a = add(call.clientName, connected.get(call.clientId));
      if (a) a.waiting++;
    }
    return [...byName.values()];
  }

  function badge(t = now()) {
    let state = "idle";
    if (approvalsNeeded().length) state = "approval";
    else if (isActing(t)) state = "acting";
    else if (paused.size || pauseNew) state = "paused";
    return { state, ...BADGES[state] };
  }

  function snapshot(t = now()) {
    const running = new Set([...calls.values()].filter((c) => c.phase === "running").map((c) => c.session));
    return {
      badge: badge(t),
      pauseNew,
      approvals: approvalsNeeded(),
      allowed: [...allowed].sort(),
      denied: [...denied].sort(),
      connected: [...connected.values()],
      sessions: [...sessions.entries()]
        .map(([id, s]) => ({
          id,
          client: s.client,
          lastAt: s.lastAt,
          paused: paused.get(id) ?? null,
          acting: running.has(id) || t - (lastBySession.get(id) ?? -Infinity) < RECENT_MS,
        }))
        .sort((a, b) => b.lastAt - a.lastAt),
      log: log.slice(),
    };
  }

  return {
    ready,
    RECENT_MS,
    clientEvent,
    handleCall,
    stopAll,
    pauseSession,
    resume,
    resumeAll,
    isPaused: (session) => paused.has(session),
    pausedReason: (session) => paused.get(session) ?? null,
    allow,
    deny,
    revoke,
    forget,
    hostDisconnected,
    clearLog,
    badge,
    snapshot,
  };
}

if (typeof module !== "undefined") module.exports = { createControl, summarizeArgs, logError, pageOrigin, APPROVAL_TIMEOUT_MS };
