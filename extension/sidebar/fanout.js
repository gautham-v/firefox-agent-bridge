"use strict";

// Fan-out in the chat panel's steps card (docs/chat-panel.md). When the agent starts sub-agents
// (Task, called Agent in newer Claude Code), each one gets a row: the site it works in, its
// status, how many calls it made and what it is doing now, and the row opens to its own steps.
// Pure functions over the panel's step list; panel.js draws them. Loaded before panel.js, and by
// extension/test/fanout.test.js.

const FANOUT_AGENT_TOOLS = new Set(["Task", "Agent"]);

// A sub-agent the chat's own agent started. One a sub-agent starts counts as one of its calls.
const isAgentStep = (s) => FANOUT_AGENT_TOOLS.has(s.name) && !s.parent;

// A navigate step's summary ("Open pypi.org/project/requests") as a URL, or "".
function openedUrl(summary) {
  const m = /^Open ([\w.-]+\.[a-z]{2,}(?:\/\S*)?)$/i.exec(summary ?? "");
  return m ? `https://${m[1]}` : "";
}

// The card's rows, in the order the agent made its calls: {step} for the agent's own calls and
// {agent: {step, calls}} for each sub-agent, with every call made under it, at any depth, in
// `calls`. Null when no sub-agent ran, so the card stays a plain list.
function fanoutRows(steps) {
  if (!steps.some(isAgentStep)) return null;
  const byId = new Map(steps.map((s) => [s.id, s]));
  const topOf = (s) => {
    let r = s;
    for (let i = 0; r.parent != null && byId.has(r.parent) && i < 16; i++) r = byId.get(r.parent);
    return r;
  };
  const agents = new Map();
  const rows = [];
  for (const s of steps) {
    const top = topOf(s);
    if (top !== s && agents.has(top.id)) agents.get(top.id).calls.push(s);
    else if (isAgentStep(s)) {
      const a = { step: s, calls: [] };
      agents.set(s.id, a);
      rows.push({ agent: a });
    } else rows.push({ step: s });
  }
  return { rows, agents: [...agents.values()] };
}

// What a sub-agent's row shows. `tabs` maps tab ids to {url, title, favIconUrl} as last seen, so
// a row keeps its site after the sub-agent closes its tab.
function agentRow({ step, calls }, tabs) {
  const tabId = calls.findLast((c) => c.tabId != null)?.tabId;
  const tab = tabId != null ? tabs.get(tabId) ?? null : null;
  const tabUrl = /^https?:/.test(tab?.url ?? "") ? tab.url : "";
  const url = tabUrl || openedUrl(calls.findLast((c) => /navigate$/.test(c.name) && openedUrl(c.summary))?.summary);
  let status = "running";
  if (step.halted) status = "halted";
  else if (step.done) status = step.ok === false ? "failed" : "done";
  return {
    tab: tabUrl ? tab : null,
    url,
    status,
    calls: calls.length,
    current: status === "running" ? calls.findLast((c) => !c.done) ?? null : null,
    result: step.done ? step.result ?? "" : "",
  };
}

// "4 of 6 done"
function fanoutProgress(agents) {
  return { done: agents.filter((a) => a.step.done).length, total: agents.length };
}

if (typeof module !== "undefined") module.exports = { isAgentStep, openedUrl, fanoutRows, agentRow, fanoutProgress };
