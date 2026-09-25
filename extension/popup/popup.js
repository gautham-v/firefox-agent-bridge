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
  [...old.childNodes].forEach((child, i) => morph(child, fresh.childNodes[i]));
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

function statusText(s) {
  const pausedCount = s.sessions.filter((x) => x.paused).length;
  switch (s.badge.state) {
    case "acting":
      return "An agent is acting in Firefox.";
    case "paused":
      return pausedCount ? `Paused: ${pausedCount} session${pausedCount === 1 ? "" : "s"}.` : "Paused. New sessions start paused.";
    default:
      return s.clients.length || s.sessions.length ? "Idle." : "Idle. No agent has connected yet.";
  }
}

function clientLine(c) {
  const parts = [];
  if (c.version) parts.push(`version ${c.version}`);
  if (c.pid != null) parts.push(`pid ${c.pid}`);
  if (c.cwd) parts.push(c.cwd);
  return parts.join(" · ") || "no process details";
}

const clock = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function renderSessions(s) {
  $("sessions-section").hidden = !s.sessions.length;
  syncList(
    $("session-list"),
    s.sessions,
    (x) => x.id,
    (x) => {
      const stateText = x.paused ? "paused" : x.acting ? "acting" : "idle";
      const cls = x.paused ? "paused" : x.acting ? "acting" : "";
      return el(
        "li",
        { class: "item" },
        el("span", { class: "grow" }, el("strong", { textContent: x.label }), el("span", { class: "muted", textContent: ` · ${x.client}` })),
        el("span", { class: `state ${cls}`, textContent: stateText }),
        x.paused ? button("Resume", () => send("resume", { session: x.id })) : null,
      );
    },
  );
}

function renderClients(s) {
  $("clients-empty").hidden = !!s.clients.length;
  syncList(
    $("client-list"),
    s.clients,
    (c) => String(c.id ?? c.name),
    (c) =>
      el(
        "li",
        { class: "client" },
        el(
          "div",
          { class: "item" },
          el("span", { class: "grow" }, el("strong", { textContent: c.name }), el("span", { class: "muted small", textContent: c.blocked ? " (self-reported, blocked)" : " (self-reported)" })),
          c.id != null ? button("Disconnect", () => send("disconnect", { clientId: c.id })) : null,
        ),
        el("div", { class: "mono muted", textContent: clientLine(c) }),
        el("div", { class: "small muted", textContent: `connected ${clock(c.connectedAt)} · ${c.calls} call${c.calls === 1 ? "" : "s"}` }),
      ),
  );
  $("blocked-block").hidden = !s.blocked.length;
  syncList(
    $("blocked-list"),
    s.blocked,
    (name) => name,
    (name) => el("li", { class: "item" }, el("span", { class: "grow", textContent: name }), button("Unblock", () => send("unblock", { name }))),
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
  // Rebuilt only when the sessions change, so an open dropdown isn't closed by every call.
  const options = [el("option", { value: "", textContent: "All sessions" }), ...[...seen].map(([id, label]) => el("option", { value: id, textContent: label }))];
  if (options.length !== filter.options.length || options.some((o, i) => !o.isEqualNode(filter.options[i]))) {
    filter.replaceChildren(...options);
    filter.value = seen.has(current) ? current : "";
  }

  const entries = filteredLog().slice(-LOG_SHOWN).reverse();
  $("log-empty").hidden = !!entries.length;
  $("log").replaceChildren(
    ...entries.map((e) => {
      const time = clock(e.time);
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
