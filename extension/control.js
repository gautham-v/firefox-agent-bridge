"use strict";

// The user's side of the bridge: which clients are connected or blocked, which sessions are
// paused, and a log of every call. No DOM or tab work here; background.js wires it to the
// browser, and extension/test/ runs it in node.

const RECENT_MS = 3_000;
const LOG_SIZE = 500;
const ERROR_CHARS = 160;

const RESUME_HINT = "Ask the user to resume it from the Firefox Agent Bridge toolbar button, then retry.";

const BADGES = {
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

function createControl({ send, onChange = () => {}, onPauseChange = () => {}, now = Date.now } = {}) {
  const connected = new Map(); // client id -> { id, name, version, pid, cwd, connectedAt, calls }
  // Names the user disconnected, until they unblock them or Firefox restarts. Blocking by name
  // is what makes Disconnect stick: the MCP server reconnects on its next call.
  const blocked = new Set();
  const paused = new Set(); // sessions paused by Stop
  const sessions = new Map(); // session -> { client, clientId, firstAt, lastAt }
  const calls = new Map(); // call id -> running call
  const log = [];
  let pauseNew = false; // after Stop, sessions not seen yet start out paused
  const lastBySession = new Map();

  const nameOf = (c) => (typeof c?.name === "string" && c.name ? c.name : "unknown client");

  function clientFor(c) {
    const id = typeof c?.id === "number" ? c.id : null;
    if (id != null && connected.has(id)) return connected.get(id);
    const client = { id, name: nameOf(c), version: null, pid: null, cwd: null, connectedAt: now(), calls: 0 };
    if (id != null) connected.set(id, client);
    return client;
  }

  function clientEvent(msg) {
    const c = msg.client ?? {};
    if (msg.event === "connected" && typeof c.id === "number") {
      connected.set(c.id, {
        id: c.id,
        name: nameOf(c),
        version: c.version ?? null,
        pid: c.pid ?? null,
        cwd: c.cwd ?? null,
        connectedAt: now(),
        calls: connected.get(c.id)?.calls ?? 0,
      });
    } else if (msg.event === "disconnected") {
      connected.delete(c.id);
    }
    onChange();
  }

  function pausedMessage() {
    return `The user paused this session in Firefox, so nothing was done. Don't retry on your own. ${RESUME_HINT}`;
  }

  function blockedMessage(name) {
    return `The user disconnected this client ("${name}") in Firefox, so nothing was done. Calls from it are refused until the user clicks Unblock in the Firefox Agent Bridge toolbar popup or restarts Firefox. Don't retry on your own; ask the user.`;
  }

  function reply(id, outcome, payload) {
    const result = outcome === "ok" ? { content: payload } : { content: [{ type: "text", text: String(payload) }], isError: true };
    send?.({ id, result });
  }

  // Answers a call exactly once; a result that arrives after Stop or a disconnect is dropped.
  function finish(call, outcome, payload, note) {
    if (call.done) return false;
    call.done = true;
    calls.delete(call.id);
    reply(call.id, outcome, payload);
    const t = now();
    const entry = call.entry;
    entry.outcome = outcome;
    entry.ms = t - call.t0;
    if (outcome !== "ok") entry.error = note ?? logError(call.tool, call.args, payload);
    log.push(entry);
    if (log.length > LOG_SIZE) log.splice(0, log.length - LOG_SIZE);
    if (call.running) lastBySession.set(call.session, t);
    onChange();
    return true;
  }

  async function handleCall(msg, run, tabOrigin = async () => null) {
    const args = msg.args ?? {};
    const client = clientFor(msg.client);
    client.calls++;
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
      running: false,
      done: false,
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
      if (pauseNew) setPaused(msg.session);
    } else {
      Object.assign(sessions.get(msg.session), { client: client.name, clientId: client.id, lastAt: t0 });
    }
    calls.set(call.id, call);

    if (blocked.has(client.name)) return finish(call, "blocked-disconnected", blockedMessage(client.name), "client disconnected by the user");
    if (paused.has(call.session)) return finish(call, "blocked-paused", pausedMessage(), "session paused");
    call.running = true;
    onChange();
    const tabId = call.entry.tabId;
    if (tabId != null) call.entry.origin = pageOrigin(await Promise.resolve(tabOrigin(tabId)).catch(() => null));
    if (call.done) return;
    let outcome;
    let payload;
    try {
      payload = await run(call.session, call.tool, call.args, client.name);
      outcome = "ok";
    } catch (e) {
      payload = e?.message ?? String(e);
      outcome = "error";
    }
    if (!finish(call, outcome, payload)) return;
    if (tabId != null) {
      // Pages move (navigate, clicks); log where the tab ended up if it still exists.
      const after = pageOrigin(await Promise.resolve(tabOrigin(tabId)).catch(() => null));
      if (after) call.entry.origin = after;
    }
  }

  function setPaused(session) {
    if (paused.has(session)) return;
    paused.add(session);
    onPauseChange(session, true);
  }

  function stopCallsFor(pred, message, note) {
    for (const call of [...calls.values()]) if (pred(call)) finish(call, "stopped", message, note);
  }

  const stoppedMessage = `The user stopped this call in Firefox. It may have partly run. The session is now paused. ${RESUME_HINT}`;

  function stopAll() {
    pauseNew = true;
    for (const session of sessions.keys()) setPaused(session);
    stopCallsFor(() => true, stoppedMessage, "stopped by the user");
    onChange();
  }

  function resume(session) {
    if (paused.delete(session)) onPauseChange(session, false);
    onChange();
  }

  function resumeAll() {
    pauseNew = false;
    for (const session of [...paused]) resume(session);
    onChange();
  }

  // Cuts one connection and refuses its name until unblock(), so the reconnect that follows
  // the client's next call fails fast too.
  function disconnect(clientId) {
    const c = connected.get(clientId);
    if (!c) return;
    blocked.add(c.name);
    stopCallsFor((call) => call.clientName === c.name, blockedMessage(c.name), "client disconnected by the user");
    send?.({ type: "disconnect_client", clientId });
    connected.delete(clientId);
    onChange();
  }

  function unblock(name) {
    blocked.delete(name);
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

  // Sessions paused by Stop don't count as recently acting, so the badge shows the pause at once.
  function isActing(t = now()) {
    for (const c of calls.values()) if (c.running) return true;
    for (const [session, last] of lastBySession) if (!paused.has(session) && t - last < RECENT_MS) return true;
    return false;
  }

  function badge(t = now()) {
    let state = "idle";
    if (isActing(t)) state = "acting";
    else if (paused.size || pauseNew) state = "paused";
    return { state, ...BADGES[state] };
  }

  function snapshot(t = now()) {
    const running = new Set([...calls.values()].filter((c) => c.running).map((c) => c.session));
    return {
      badge: badge(t),
      pauseNew,
      clients: [...connected.values()].map((c) => ({ ...c, blocked: blocked.has(c.name) })).sort((a, b) => a.connectedAt - b.connectedAt),
      blocked: [...blocked].sort(),
      sessions: [...sessions.entries()]
        .map(([id, s]) => ({
          id,
          client: s.client,
          lastAt: s.lastAt,
          paused: paused.has(id),
          acting: running.has(id) || t - (lastBySession.get(id) ?? -Infinity) < RECENT_MS,
        }))
        .sort((a, b) => b.lastAt - a.lastAt),
      log: log.slice(),
    };
  }

  return {
    RECENT_MS,
    clientEvent,
    handleCall,
    stopAll,
    resume,
    resumeAll,
    isPaused: (session) => paused.has(session),
    disconnect,
    unblock,
    hostDisconnected,
    clearLog,
    badge,
    snapshot,
  };
}

if (typeof module !== "undefined") module.exports = { createControl, summarizeArgs, logError, pageOrigin };
