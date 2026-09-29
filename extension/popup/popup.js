"use strict";

// Shows what control.js knows and sends the user's choices back. Client names and folders come
// from the connecting program, so they are only ever set as text, never as markup.

const port = browser.runtime.connect({ name: "popup" });
const $ = (id) => document.getElementById(id);
const send = (cmd, extra = {}) => port.postMessage({ cmd, ...extra });
const LOG_SHOWN = 100;

let state = null;
const expanded = new Set(); // session rows opened to show their client's details

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "onclick") node.addEventListener("click", v);
    else node[k] = v;
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

// Glyphs on a 16px grid, drawn from the agent cursor's shape.
const POINTER = "M3 1.2 L3 14.9 L7.1 11.2 L13.1 10.8 Z";
function glyph(kind) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  const add = (tag, attrs) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    svg.append(n);
  };
  const solid = kind === "acting";
  add("path", { d: POINTER, fill: solid ? "currentColor" : "none", stroke: "currentColor", "stroke-width": "1.4", "stroke-linejoin": "round" });
  if (kind === "paused") {
    add("rect", { x: "11.9", y: "12.4", width: "1.6", height: "3.4", rx: ".6", fill: "currentColor" });
    add("rect", { x: "14.3", y: "12.4", width: "1.6", height: "3.4", rx: ".6", fill: "currentColor" });
  }
  return svg;
}

const button = (label, onclick, cls = "b") =>
  el("button", {
    class: cls,
    textContent: label,
    onclick: (e) => {
      e.stopPropagation();
      onclick();
    },
  });

// State arrives after every call, so lists are updated in place: an item keeps its element and
// its unchanged buttons. Replacing a button between mousedown and mouseup would lose the click.
function morph(old, fresh) {
  if (old.isEqualNode(fresh)) return old;
  if (old.nodeType !== 1 || old.nodeName !== fresh.nodeName || old.nodeName === "BUTTON" || old.childNodes.length !== fresh.childNodes.length) {
    old.replaceWith(fresh);
    return fresh;
  }
  for (const a of [...old.attributes]) if (!fresh.hasAttribute(a.name)) old.removeAttribute(a.name);
  for (const a of fresh.attributes) if (old.getAttribute(a.name) !== a.value) old.setAttribute(a.name, a.value);
  // Copy the list first: morph moves replaced children out of fresh.
  const kids = [...fresh.childNodes];
  [...old.childNodes].forEach((child, i) => morph(child, kids[i]));
  return old;
}

function syncList(list, items, key, build) {
  const current = new Map([...list.children].map((node) => [node.dataset.key, node]));
  const next = items.map((item) => {
    const fresh = build(item);
    fresh.dataset.key = key(item);
    const old = current.get(fresh.dataset.key);
    return old ? morph(old, fresh) : fresh;
  });
  if (next.length !== list.children.length || next.some((node, i) => node !== list.children[i])) list.replaceChildren(...next);
}

const clock = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const shortClock = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).replace(/\s?[AP]M$/i, "");
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
// "https://example.com" reads as "example.com"; other origins as their scheme, e.g. "moz-extension".
const host = (origin) => (origin ? (/^https?:\/\//.test(origin) ? origin.replace(/^https?:\/\//, "") : origin.split(":")[0]) : null);
const callName = (e) => e.tool + (e.action ? `: ${e.action}` : "");

function header(s) {
  const actingSessions = s.sessions.filter((x) => x.acting && !x.paused);
  const pausedCount = s.sessions.filter((x) => x.paused).length;
  const last = s.log.at(-1);
  let title;
  let detail;
  if (s.status === "acting") {
    title = actingSessions.length === 1 ? `${actingSessions[0].label} is acting` : actingSessions.length > 1 ? `${actingSessions.length} agents are acting` : "An agent is acting";
    detail = last ? [callName(last), host(last.origin), Date.now() - last.time < 5000 ? "now" : shortClock(last.time)].filter(Boolean).join(" · ") : "";
  } else if (s.status === "paused") {
    title = "Paused";
    detail = pausedCount ? plural(pausedCount, "session") : "New sessions start paused";
  } else {
    title = "Idle";
    detail = last ? `Last call ${shortClock(last.time)}` : s.clients.length ? "Connected, no calls yet" : "No agent has connected yet";
  }
  $("status").textContent = title;
  $("detail").textContent = detail;
  $("detail").title = detail;
  const orb = $("orb");
  if (orb.dataset.kind !== s.status) {
    orb.dataset.kind = s.status;
    orb.className = `orb ${s.status}`;
    orb.replaceChildren(glyph(s.status));
  }
  // Stop stays where it is; once everything is paused it just can't be pressed again.
  const allStopped = s.pauseNew && s.sessions.every((x) => x.paused);
  $("stop").disabled = allStopped;
  $("stop").textContent = allStopped ? "Stopped" : "Stop";
  $("resume-all").hidden = !(s.pauseNew || pausedCount);
}

// One row per session, with the connection it came from. Connections that haven't made a call
// and blocked names without a session get rows of their own. A name stays blocked across
// reconnects, so a row is blocked by its client's name, not by its connection.
function sessionItems(s) {
  const blocked = new Set(s.blocked);
  const shown = new Set(); // blocked names that already have a row
  const used = new Set();
  const items = s.sessions.map((x) => {
    const client = s.clients.find((c) => c.id === x.clientId) ?? null;
    if (client) used.add(client.id);
    const isBlocked = blocked.has(x.client);
    if (isBlocked) shown.add(x.client);
    return { key: `s:${x.id}`, label: x.label, name: x.client, client: isBlocked ? null : client, session: x, blocked: isBlocked };
  });
  for (const c of s.clients) {
    if (used.has(c.id) || (c.blocked && shown.has(c.name))) continue;
    if (c.blocked) shown.add(c.name);
    items.push({ key: `c:${c.id ?? c.name}`, label: c.name, name: null, client: c.blocked ? null : c, session: null, blocked: c.blocked });
  }
  for (const name of blocked) if (!shown.has(name)) items.push({ key: `b:${name}`, label: name, name: null, client: null, session: null, blocked: true });
  return items;
}

function clientLine(c) {
  const parts = [c.name + (c.version ? ` ${c.version}` : "")];
  if (c.pid != null) parts.push(`pid ${c.pid}`);
  return parts.join(" · ");
}

function toggleRow(key) {
  if (!expanded.delete(key)) expanded.add(key);
  if (state) renderSessions(state);
}

function sessionRow(item) {
  const x = item.session;
  const kind = item.blocked ? "blocked" : x?.paused ? "paused" : x?.acting ? "acting" : "idle";
  const open = expanded.has(item.key);
  let right;
  if (item.blocked) right = button("Unblock", () => send("unblock", { name: item.name ?? item.label }), "link");
  else if (x?.paused) right = button("Resume", () => send("resume", { session: x.id }), "link");
  else right = el("span", { class: "r", textContent: x ? kind : "no calls yet" });

  const row = el(
    "div",
    {
      class: `row btn${item.blocked || (!item.client && !x?.paused) ? " dim" : ""}`,
      tabIndex: 0,
      role: "button",
      ariaExpanded: String(open),
      // Rows are reused across updates (see morph), so the handler looks the state up.
      onclick: () => toggleRow(item.key),
    },
    glyph(kind === "blocked" ? "idle" : kind),
    el("span", { class: "grow" }, el("span", { class: "name", textContent: item.label }), item.name ? el("span", { class: "muted", textContent: ` ${item.name}` }) : null),
    right,
  );

  let detail = null;
  if (open) {
    const c = item.client;
    const lines = c
      ? [clientLine(c), c.cwd, `connected ${clock(c.connectedAt)} · ${plural(c.calls, "call")}`]
      : [item.blocked ? "Disconnected until you unblock it or Firefox restarts." : "Not connected any more."];
    detail = el(
      "div",
      { class: "detail" },
      ...lines.filter(Boolean).map((t) => el("div", { class: "cap", textContent: t })),
      c?.id != null ? el("div", { class: "acts" }, button("Disconnect", () => send("disconnect", { clientId: c.id }))) : null,
    );
  }
  return el("li", {}, row, detail);
}

function renderSessions(s) {
  const items = sessionItems(s);
  $("sessions-empty").hidden = !!items.length;
  $("blocked-note").hidden = !s.blocked.length;
  syncList($("session-list"), items, (i) => i.key, sessionRow);
}

function filteredLog() {
  const f = $("filter").value;
  return (state?.log ?? []).filter((e) => !f || e.session === f);
}

const OUTCOME = { ok: null, stopped: "stopped", error: "error", "blocked-paused": "paused", "blocked-disconnected": "blocked" };
const duration = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);

function renderLog(s) {
  $("log-count").textContent = s.log.length ? String(s.log.length) : "";
  const filter = $("filter");
  const current = filter.value;
  const seen = new Map();
  for (const x of s.sessions) seen.set(x.id, x.label);
  for (const e of s.log) if (!seen.has(e.session)) seen.set(e.session, e.sessionLabel);
  // Rebuilt only when the sessions change, so an open dropdown isn't closed by every call.
  const options = [el("option", { value: "", textContent: "All sessions" }), ...[...seen].map(([id, label]) => el("option", { value: id, textContent: label }))];
  if (options.length !== filter.options.length || options.some((o, i) => !o.isEqualNode(filter.options[i]))) {
    filter.replaceChildren(...options);
    filter.value = seen.has(current) ? current : "";
  }

  if ($("activity").hidden) return;
  const entries = filteredLog().slice(-LOG_SHOWN).reverse();
  $("log-empty").hidden = !!entries.length;
  $("log").replaceChildren(
    ...entries.map((e) => {
      const detail = e.detail?.startsWith("to ") ? `to ${host(e.detail.slice(3))}` : e.detail;
      const what = [callName(e), host(e.origin), detail].filter(Boolean).join(" · ");
      const outcome = e.outcome in OUTCOME ? OUTCOME[e.outcome] : e.outcome;
      return el(
        "li",
        { title: [e.sessionLabel, e.client, e.tabId != null ? `tab ${e.tabId}` : null, clock(e.time), `${e.outcome} ${e.ms}ms`].filter(Boolean).join(" · ") },
        el("span", { class: "t", textContent: shortClock(e.time) }),
        el("span", { class: "what", textContent: what }),
        el("span", { class: `o ${e.outcome}`, textContent: outcome ?? duration(e.ms) }),
        e.error ? el("span", { class: "err", textContent: e.error }) : null,
      );
    }),
  );
}

function render(s) {
  state = s;
  header(s);
  renderSessions(s);
  renderLog(s);
}

port.onMessage.addListener((m) => {
  if (m.type === "state") render(m.state);
});

function setActivityOpen(open) {
  $("activity").hidden = !open;
  $("activity-toggle").setAttribute("aria-expanded", String(open));
  try {
    localStorage.setItem("activityOpen", open ? "1" : "");
  } catch {}
  if (state) renderLog(state);
}

$("stop").addEventListener("click", () => send("stop"));
$("resume-all").addEventListener("click", () => send("resumeAll"));
$("clear").addEventListener("click", () => send("clearLog"));
$("filter").addEventListener("change", () => state && renderLog(state));
$("activity-toggle").addEventListener("click", () => setActivityOpen($("activity").hidden));
$("session-list").addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target.matches(".row")) {
    e.preventDefault();
    e.target.click();
  }
});
try {
  if (localStorage.getItem("activityOpen")) setActivityOpen(true);
} catch {}

$("copy").addEventListener("click", async () => {
  const json = JSON.stringify(filteredLog(), null, 2);
  try {
    await navigator.clipboard.writeText(json);
  } catch {
    const area = el("textarea", { value: json });
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  $("copied").textContent = "Copied";
  setTimeout(() => ($("copied").textContent = ""), 1500);
});

// "Alt+Shift+X" reads as "⌥⇧X" on a Mac.
function formatShortcut(key) {
  if (!/Mac/.test(navigator.platform)) return key;
  const sym = { Alt: "⌥", Shift: "⇧", Ctrl: "⌘", Command: "⌘", MacCtrl: "⌃" };
  return key.split("+").map((k) => sym[k] ?? k).join("");
}

browser.commands.getAll().then((cmds) => {
  const key = cmds.find((c) => c.name === "stop-agents")?.shortcut;
  $("shortcut").textContent = key ? `${formatShortcut(key)} stops every agent` : "";
});
