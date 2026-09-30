#!/usr/bin/env node
// Re-applies the current checkers to recorded runs (answer + inspected state + the agent's tool
// calls, rebuilt from the raw stream) and rewrites score, pass and fields in place. Use it after a
// checker fix, so every row is graded by the same rule. Timeouts stay at 0. A row with no answer
// takes the last JSON from an earlier message of the run, as models.mjs now does (answerOf).
//
//   node eval/models-rescore.mjs --in eval/results/models-hard/runs.jsonl [--dry-run]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { answerOf } from "./lib/check.mjs";

const EVAL = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(EVAL);
const argv = process.argv.slice(2);
const i = argv.indexOf("--in");
const IN = path.resolve(i >= 0 ? argv[i + 1] : path.join(EVAL, "results/models-hard/runs.jsonl"));
const { TASKS, score } = await import(IN.includes("models-hard") ? "./models-tasks-hard.mjs" : "./models-tasks.mjs");

// The run's top-level assistant events and final result text, from its raw stream.
function stream(r) {
  const file = r.stream_file && path.join(ROOT, r.stream_file);
  if (!file || !fs.existsSync(file)) return null;
  const events = [];
  let finalText = null;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.includes('"assistant"') && !line.includes('"result"')) continue;
    try {
      const e = JSON.parse(line);
      if (e.type === "result" && typeof e.result === "string") finalText = e.result;
      if (e.type === "assistant" && !e.parent_tool_use_id) events.push(e);
    } catch {}
  }
  return { events, finalText };
}
const trace = (events) => events.flatMap((e) => (e.message?.content ?? []).filter((b) => b.type === "tool_use").map((b) => ({ name: b.name, input: b.input })));

const lines = fs.readFileSync(IN, "utf8").split("\n").filter(Boolean);
let changed = 0;
const out = lines.map((l) => {
  const r = JSON.parse(l);
  const task = TASKS.find((t) => t.id === r.task);
  if (!task || r.infra_error) return l;
  const st = stream(r);
  if (st == null) {
    console.warn(`no stream for ${r.task} ${r.config} r${r.round}; kept`);
    return l;
  }
  let { answer, answer_source: source = r.answer ? "final" : null } = r;
  if (!answer) ({ answer, answerSource: source } = answerOf(st.finalText, st.events));
  const fields = task.check(answer, r.state, trace(st.events));
  let { score: sc, pass } = score(fields);
  if (r.timeout) [sc, pass] = [0, false];
  if (sc !== r.score) {
    changed++;
    console.log(`${r.task} ${r.config} r${r.round}: ${r.score} -> ${sc}`);
  }
  return JSON.stringify({ ...r, answer, answer_source: source, fields, score: sc, pass });
});
if (!argv.includes("--dry-run")) fs.writeFileSync(IN, out.join("\n") + "\n");
console.log(`${changed} of ${lines.length} rows changed${argv.includes("--dry-run") ? " (dry run)" : ""}`);
