"use strict";

// The opt-in devtools tool (README, "Tools"): console messages and network requests of session
// tabs, kept per tab from when the tab joins a watched session, across navigations, until it
// closes. The buffers, URL scrubbing and the plain-text answer live here, free of browser APIs,
// so extension/test/ runs them in node. background.js feeds them from webRequest and from the
// experiment's onConsole, which the ClaudePage actor fills (experiment/actor-child.sys.mjs).

const DEVTOOLS_KEEP = 200; // entries kept per kind per tab
const DEVTOOLS_LIMIT = 50; // entries returned when no limit is given
const KEPT_CHARS = 1000; // a console message as kept, so pattern sees more than is shown
const SHOWN_CHARS = 300;
const SOURCE_CHARS = 120;
// Pending requests that never finished (a tab closed mid-load) are forgotten past this many.
const MAX_PENDING = 500;

// Least to most severe; a level filter keeps that level and the ones after it.
const LEVELS = ["debug", "log", "info", "warning", "error"];
const API_LEVELS = { warn: "warning", error: "error", assert: "error", exception: "error", info: "info", debug: "debug", trace: "debug" };

const consoleLevel = (raw) => (LEVELS.includes(raw) ? raw : API_LEVELS[raw] ?? "log");

const REQUEST_TYPES = { main_frame: "document", sub_frame: "iframe", xmlhttprequest: "xhr", stylesheet: "css", imageset: "image", web_manifest: "manifest" };

// Query and fragment parameters whose values are cut out of URLs, by name: a word of the name
// (split at punctuation and camelCase) in WORDS, or the whole name in WHOLE. "code" alone is
// OAuth's authorization code; "zip_code" is left alone.
const SECRET_WORDS = new Set(["password", "passwd", "pass", "pwd", "secret", "token", "auth", "authorization", "apikey", "key", "sig", "signature", "session", "sessionid", "jwt", "otp", "credential", "credentials"]);
const SECRET_WHOLE = new Set(["code", "sid", "ticket"]);
const REDACTED = "[redacted]";

function secretParam(name) {
  let key = name;
  try {
    key = decodeURIComponent(name.replace(/\+/g, " "));
  } catch {
    // keep it as it is
  }
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return SECRET_WHOLE.has(words.join("_")) || words.some((w) => SECRET_WORDS.has(w));
}

const scrubParams = (params) =>
  params
    .split("&")
    .map((p) => {
      const eq = p.indexOf("=");
      return eq > 0 && eq < p.length - 1 && secretParam(p.slice(0, eq)) ? `${p.slice(0, eq + 1)}${REDACTED}` : p;
    })
    .join("&");

// Tokens that are secret wherever they show up: JWTs and Authorization header values.
function scrubTokens(text) {
  return text.replace(/\beyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]{6,}/g, "[redacted: jwt]").replace(/\b(Bearer|Basic)\s+[\w\-.~+/]{12,}=*/gi, `$1 ${REDACTED}`);
}

// A URL with user:password@ dropped and secret-looking query and fragment values cut out. A
// fragment without "=" is an anchor, kept as is.
function redactUrl(url) {
  let out = String(url ?? "").replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#@\s]*@/i, "$1");
  const hash = out.indexOf("#");
  let fragment = "";
  if (hash >= 0) {
    fragment = out.slice(hash + 1);
    out = out.slice(0, hash);
    fragment = `#${fragment.includes("=") ? scrubParams(fragment) : fragment}`;
  }
  const q = out.indexOf("?");
  if (q >= 0) out = `${out.slice(0, q + 1)}${scrubParams(out.slice(q + 1))}`;
  return scrubTokens(out + fragment);
}

// Console text with the URLs in it redacted like request URLs, and tokens cut out.
const redactText = (text) => scrubTokens(String(text ?? "").replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]+/gi, (u) => redactUrl(u)));

const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// Where a message came from: the script's URL without its query (cache-busters), and its line.
function sourceOf(file, line) {
  if (!file) return "";
  const where = redactUrl(String(file).replace(/[?#].*$/, ""));
  return cut(where, SOURCE_CHARS) + (line > 0 ? `:${line}` : "");
}

const pad = (n, w = 2) => String(n).padStart(w, "0");
function clock(ms) {
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` : "--:--:--.---";
}

function bytes(n) {
  if (!(n > 0)) return null;
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}kB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function createDevtools({ keep = DEVTOOLS_KEEP } = {}) {
  const tabs = new Map(); // tab id -> { console: {entries, dropped}, network: {entries, dropped} }
  const pending = new Map(); // webRequest requestId -> its entry, until it finishes

  function bufferOf(tabId, kind) {
    let t = tabs.get(tabId);
    if (!t) tabs.set(tabId, (t = { console: { entries: [], dropped: 0 }, network: { entries: [], dropped: 0 } }));
    return t[kind];
  }

  function add(tabId, kind, entry) {
    const b = bufferOf(tabId, kind);
    b.entries.push(entry);
    if (b.entries.length > keep) b.dropped += b.entries.splice(0, b.entries.length - keep).length;
    return entry;
  }

  // A batch from one frame: { entries: [{level, text, source, line, time}], dropped }, where
  // dropped counts messages the frame had no room to send.
  function consoleBatch(tabId, batch) {
    const b = bufferOf(tabId, "console");
    if (batch?.dropped > 0) b.dropped += batch.dropped;
    for (const e of Array.isArray(batch?.entries) ? batch.entries : []) {
      const entry = {
        time: Number(e?.time) || Date.now(),
        level: consoleLevel(e?.level),
        text: cut(redactText(e?.text), KEPT_CHARS),
        source: sourceOf(e?.source, Number(e?.line)),
      };
      // An error can reach both the frame's listener and the parent's (if Firefox doesn't mark
      // it as forwarded); the same message at the same moment is kept once.
      const same = (o) => o.time === entry.time && o.level === entry.level && o.text === entry.text && o.source === entry.source;
      if (!b.entries.slice(-20).some(same)) add(tabId, "console", entry);
    }
  }

  // webRequest events. A redirect ends the entry with its 3xx status; Firefox then starts the
  // request again under the same id with the new URL.
  function requestStarted(d) {
    if (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value);
    const entry = add(d.tabId, "network", {
      time: d.timeStamp,
      method: d.method,
      url: redactUrl(d.url),
      type: REQUEST_TYPES[d.type] ?? d.type,
      status: null,
      size: null,
      ms: null,
      error: null,
    });
    pending.set(d.requestId, entry);
  }

  function requestEnded(d, how) {
    const entry = pending.get(d.requestId);
    if (!entry) return;
    pending.delete(d.requestId);
    entry.ms = Math.max(0, Math.round(d.timeStamp - entry.time));
    if (how === "failed") {
      entry.error = String(d.error ?? "failed");
      return;
    }
    entry.status = d.statusCode ?? null;
    if (d.fromCache) entry.size = "cache";
    else entry.size = bytes(d.responseSize) ?? null;
    if (how === "redirect" && d.redirectUrl) entry.error = `→ ${redactUrl(d.redirectUrl)}`;
  }

  function forget(tabId) {
    tabs.delete(tabId);
  }

  function compile(pattern) {
    if (pattern == null || pattern === "") return null;
    try {
      return new RegExp(String(pattern), "i");
    } catch (e) {
      throw new Error(`pattern isn't a valid regular expression: ${e.message}`);
    }
  }

  const consoleLine = (e) => `${clock(e.time)} ${e.level} ${cut(e.text, SHOWN_CHARS)}${e.source ? ` (${e.source})` : ""}`;

  function networkLine(e) {
    const status = e.error && e.status == null ? "failed" : e.status ?? "pending";
    const parts = [clock(e.time), e.method, status, e.type, e.size ?? "-", e.ms == null ? "-" : `${e.ms}ms`, cut(e.url, SHOWN_CHARS)];
    return parts.join(" ") + (e.error ? ` ${e.error}` : "");
  }

  const failed = (e) => !!(e.error && !e.error.startsWith("→")) || e.status >= 400;

  // The tool's answer: a header saying what was left out, then one line per entry, newest last.
  function read(tabId, args = {}) {
    const kind = args.kind;
    if (kind !== "console" && kind !== "network") throw new Error('kind must be "console" or "network".');
    const re = compile(args.pattern);
    let min = 0;
    if (kind === "console" && args.level != null) {
      min = LEVELS.indexOf(consoleLevel(String(args.level).toLowerCase()));
    }
    const limit = Math.max(1, Math.min(keep, Math.floor(Number(args.limit)) || DEVTOOLS_LIMIT));
    const b = tabs.get(tabId)?.[kind] ?? { entries: [], dropped: 0 };
    const match =
      kind === "console"
        ? (e) => LEVELS.indexOf(e.level) >= min && (!re || re.test(e.text))
        : (e) => (!args.onlyFailed || failed(e)) && (!re || re.test(e.url));
    const hits = b.entries.filter(match);
    const shown = hits.slice(-limit);
    const noun = kind === "console" ? "message" : "request";
    const filters = [
      kind === "console" && min > 0 ? `level ${LEVELS[min]}+` : null,
      kind === "network" && args.onlyFailed ? "failed only" : null,
      re ? `pattern /${re.source}/i` : null,
    ].filter(Boolean);
    const notes = [];
    if (hits.length > shown.length) notes.push(`the newest ${shown.length} of ${hits.length} that match`);
    if (b.entries.length > hits.length) notes.push(`${b.entries.length - hits.length} of ${b.entries.length} kept didn't match ${filters.join(", ")}`);
    if (b.dropped) notes.push(`${b.dropped} older dropped (the last ${keep} are kept)`);
    const count = `${shown.length} ${noun}${shown.length === 1 ? "" : "s"}`;
    const head = `Tab ${tabId} ${kind}: ${count}${notes.length ? `; ${notes.join("; ")}` : ""}.${shown.length ? " Newest last." : ""}`;
    if (args.clear) {
      b.entries = [];
      b.dropped = 0;
    }
    const lines = shown.map(kind === "console" ? consoleLine : networkLine);
    return [head + (args.clear ? " Cleared." : ""), ...lines].join("\n");
  }

  return { consoleBatch, requestStarted, requestEnded, forget, read, has: (tabId) => tabs.has(tabId) };
}

if (typeof module !== "undefined") module.exports = { createDevtools, redactUrl, redactText, consoleLevel, sourceOf };
