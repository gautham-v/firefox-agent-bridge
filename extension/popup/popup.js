"use strict";

// Shows what control.js knows and sends the user's choices back. Client names and folders come
// from the connecting program, so they are only ever set as text, never as markup.

const port = browser.runtime.connect({ name: "popup" });
const $ = (id) => document.getElementById(id);
const send = (cmd, extra = {}) => port.postMessage({ cmd, ...extra });
const LOG_SHOWN = 100;

let state = null;

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

const button = (label, onclick, cls = "small") => el("button", { class: cls, textContent: label, onclick });

function statusText(s) {
  const pausedCount = s.sessions.filter((x) => x.paused).length;
  switch (s.badge.state) {
    case "approval":
      return "A client is waiting for your approval.";
    case "acting":
      return "An agent is acting in Firefox.";
    case "paused":
      return pausedCount ? `Paused: ${pausedCount} session${pausedCount === 1 ? "" : "s"}.` : "Paused. New sessions start paused.";
    default:
      return s.allowed.length || s.sessions.length ? "Idle." : "Idle. No agent has connected yet.";
  }
}

function clientLine(c) {
  const parts = [];
  if (c.pid != null) parts.push(`pid ${c.pid}`);
  if (c.version) parts.push(`version ${c.version}`);
  if (c.cwd) parts.push(c.cwd);
  return parts.join(" · ") || "no process details";
}

function renderApprovals(s) {
  $("approvals").hidden = !s.approvals.length;
  $("approval-list").replaceChildren(
    ...s.approvals.map((a) =>
      el(
        "li",
        { class: "approval" },
        el("div", {}, "Allow ", el("strong", { textContent: a.name }), " to control Firefox?"),
        ...a.clients.map((c) => el("div", { class: "mono muted", textContent: clientLine(c) })),
        a.waiting ? el("div", { class: "small muted", textContent: `${a.waiting} call${a.waiting === 1 ? "" : "s"} waiting (each gives up after 45s)` }) : null,
        el("div", { class: "buttons" }, button("Allow", () => send("allow", { name: a.name }), "primary"), button("Deny", () => send("deny", { name: a.name }), "")),
      ),
    ),
  );
}

function renderSessions(s) {
  $("sessions-section").hidden = !s.sessions.length;
  $("session-list").replaceChildren(
    ...s.sessions.map((x) => {
      const stateText = x.paused ? (x.paused === "takeover" ? "paused, you took over" : "paused") : x.acting ? "acting" : "idle";
      const cls = x.paused ? "paused" : x.acting ? "acting" : "";
      return el(
        "li",
        { class: "item" },
        el("span", { class: "grow" }, el("strong", { textContent: x.label }), el("span", { class: "muted", textContent: ` · ${x.client}` })),
        el("span", { class: `state ${cls}`, textContent: stateText }),
        x.paused ? button("Resume", () => send("resume", { session: x.id })) : null,
      );
    }),
  );
}

function renderClients(s) {
  $("allowed-empty").hidden = !!s.allowed.length;
  $("allowed-list").replaceChildren(
    ...s.allowed.map((name) => {
      const live = s.connected.filter((c) => c.name === name).length;
      return el(
        "li",
        { class: "item" },
        el("span", { class: "grow" }, el("strong", { textContent: name }), live ? el("span", { class: "muted", textContent: ` · ${live} connected` }) : null),
        button("Revoke", () => send("revoke", { name })),
      );
    }),
  );
  $("denied-block").hidden = !s.denied.length;
  $("denied-list").replaceChildren(
    ...s.denied.map((name) => el("li", { class: "item" }, el("span", { class: "grow", textContent: name }), button("Forget", () => send("forget", { name })))),
  );
}

function filteredLog() {
  const f = $("filter").value;
  return (state?.log ?? []).filter((e) => !f || e.session === f);
}

function renderLog(s) {
  const filter = $("filter");
  const current = filter.value;
  const seen = new Map();
  for (const x of s.sessions) seen.set(x.id, x.label);
  for (const e of s.log) if (!seen.has(e.session)) seen.set(e.session, e.sessionLabel);
  filter.replaceChildren(el("option", { value: "", textContent: "All sessions" }), ...[...seen].map(([id, label]) => el("option", { value: id, textContent: label })));
  filter.value = seen.has(current) ? current : "";

  const entries = filteredLog().slice(-LOG_SHOWN).reverse();
  $("log-empty").hidden = !!entries.length;
  $("log").replaceChildren(
    ...entries.map((e) => {
      const time = new Date(e.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      const what = [e.tool + (e.action ? `: ${e.action}` : ""), e.tabId != null ? `tab ${e.tabId}` : null, e.origin, e.detail].filter(Boolean).join(" · ");
      return el(
        "li",
        { title: `${e.sessionLabel} · ${e.client}` },
        el("span", { class: "muted", textContent: time }),
        el("span", { class: "what", textContent: what }),
        el("span", { class: `outcome-${e.outcome}`, textContent: `${e.outcome} ${e.ms}ms` }),
        e.error ? el("span", { class: "err", textContent: e.error }) : null,
      );
    }),
  );
}

function render(s) {
  state = s;
  $("status").textContent = statusText(s);
  const anyPaused = s.pauseNew || s.sessions.some((x) => x.paused);
  $("resume-all").hidden = !anyPaused;
  renderApprovals(s);
  renderSessions(s);
  renderClients(s);
  renderLog(s);
}

port.onMessage.addListener((m) => {
  if (m.type === "state") render(m.state);
});

$("stop").addEventListener("click", () => send("stop"));
$("resume-all").addEventListener("click", () => send("resumeAll"));
$("clear").addEventListener("click", () => send("clearLog"));
$("filter").addEventListener("change", () => state && renderLog(state));

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
  $("copied").textContent = "Copied.";
  setTimeout(() => ($("copied").textContent = ""), 1500);
});

browser.commands.getAll().then((cmds) => {
  const key = cmds.find((c) => c.name === "stop-agents")?.shortcut;
  $("shortcut").textContent = key ? `${key} stops every session from anywhere in Firefox.` : "";
});
