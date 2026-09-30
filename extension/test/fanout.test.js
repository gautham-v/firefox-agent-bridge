"use strict";

// The steps card's fan-out rows (extension/sidebar/fanout.js): which calls belong to which
// sub-agent, and what each sub-agent's row says.
const test = require("node:test");
const assert = require("node:assert/strict");
const { isAgentStep, openedUrl, fanoutRows, agentRow, fanoutProgress } = require("../sidebar/fanout.js");

const step = (id, name, extra = {}) => ({ id, name, summary: "", tabId: null, parent: null, done: false, ok: true, result: "", ...extra });

test("without a sub-agent the card stays a plain list", () => {
  assert.equal(fanoutRows([step("a", "mcp__firefox__navigate"), step("b", "Bash")]), null);
  assert.equal(fanoutRows([]), null);
});

test("calls are grouped under the sub-agent that made them, in the agent's own order", () => {
  const steps = [
    step("ctx", "mcp__firefox__tabs_context_mcp", { done: true }),
    step("A", "Agent", { summary: "Read Uplift" }),
    step("B", "Task", { summary: "Read Jarvis" }),
    step("a1", "mcp__firefox__tabs_create_mcp", { parent: "A" }),
    step("b1", "mcp__firefox__tabs_create_mcp", { parent: "B" }),
    step("a2", "mcp__firefox__navigate", { parent: "A", tabId: 7 }),
    // A sub-agent's own sub-agent: its calls count as the outer one's.
    step("A2", "Agent", { parent: "A" }),
    step("a3", "mcp__firefox__find", { parent: "A2" }),
    // A call whose Task step was never seen stays in the list.
    step("x1", "mcp__firefox__find", { parent: "gone" }),
    step("mine", "TodoWrite"),
  ];
  const fan = fanoutRows(steps);
  assert.deepEqual(fan.rows.map((r) => r.step?.id ?? `agent:${r.agent.step.id}`), ["ctx", "agent:A", "agent:B", "x1", "mine"]);
  assert.deepEqual(fan.agents.map((a) => [a.step.id, a.calls.map((c) => c.id)]), [["A", ["a1", "a2", "A2", "a3"]], ["B", ["b1"]]]);
  assert.equal(isAgentStep(steps[6]), false, "a nested Task isn't a row of its own");
});

test("a row names the site from its tab, and keeps it after the tab is closed", () => {
  const a = { step: step("A", "Agent", { summary: "Read requests" }), calls: [step("a1", "mcp__firefox__tabs_create_mcp", { done: true }), step("a2", "mcp__firefox__navigate", { tabId: 7, summary: "Open pypi.org/project/requests/" }), step("a3", "mcp__firefox__tabs_close_mcp", { tabId: 7, done: true })] };
  const tabs = new Map([[7, { url: "https://pypi.org/project/requests/", title: "requests", favIconUrl: "https://pypi.org/favicon.ico" }]]);
  const row = agentRow(a, tabs);
  assert.equal(row.url, "https://pypi.org/project/requests/");
  assert.equal(row.tab.favIconUrl, "https://pypi.org/favicon.ico");
  assert.equal(row.status, "running");
  assert.equal(row.calls, 3);
  assert.equal(row.current.id, "a2");
  assert.equal(row.result, "");

  // A tab still on about:blank, or one never seen: the site comes from the navigate step.
  assert.equal(agentRow(a, new Map([[7, { url: "about:blank" }]])).url, "https://pypi.org/project/requests/");
  const fresh = agentRow(a, new Map());
  assert.equal(fresh.url, "https://pypi.org/project/requests/");
  assert.equal(fresh.tab, null);
});

test("a row's status and result follow its Task step", () => {
  const calls = [step("a1", "mcp__firefox__find", { done: true })];
  const done = agentRow({ step: step("A", "Agent", { done: true, result: "$599, 30 in, 15 yr" }), calls }, new Map());
  assert.deepEqual([done.status, done.current, done.result, done.url], ["done", null, "$599, 30 in, 15 yr", ""]);
  assert.equal(agentRow({ step: step("A", "Agent", { done: true, ok: false, result: "boom" }), calls }, new Map()).status, "failed");
  assert.equal(agentRow({ step: step("A", "Agent", { halted: true }), calls }, new Map()).status, "halted");
  assert.equal(agentRow({ step: step("A", "Agent"), calls: [] }, new Map()).current, null);
});

test("progress counts finished sub-agents", () => {
  const fan = fanoutRows([step("A", "Agent", { done: true }), step("B", "Agent"), step("C", "Agent", { done: true, ok: false })]);
  assert.deepEqual(fanoutProgress(fan.agents), { done: 2, total: 3 });
});

test("only a plain host and path in a navigate summary counts as a site", () => {
  assert.equal(openedUrl("Open pypi.org/project/httpx"), "https://pypi.org/project/httpx");
  assert.equal(openedUrl("Open www.npmjs.com"), "https://www.npmjs.com");
  assert.equal(openedUrl("Go back"), "");
  assert.equal(openedUrl("Open a page"), "");
  assert.equal(openedUrl("Open file:///etc/passwd"), "");
  assert.equal(openedUrl(undefined), "");
});
