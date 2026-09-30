#!/usr/bin/env node
// Compares experiment arms against "none" in a run.mjs --experiments results file, per task
// (the median of a task's runs), so one long task can't decide it. Also reads the traces to check
// each flag did what it is meant to.
//   node eval/arms-analysis.mjs [--in eval/results/browsers-arms.jsonl] [--out file]
// Writes markdown to --out (default: stdout).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { armOf } from "./lib/experiments.mjs";

const EVAL = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const IN = path.resolve(opt("in", path.join(EVAL, "results/browsers-arms.jsonl")));
const OUT = opt("out");
const BAND = 0.1; // a task's median "moved" when it changed by more than this

const rows = fs.readFileSync(IN, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const arms = [...new Set(rows.map(armOf))].sort((a, b) => (a === "none" ? -1 : b === "none" ? 1 : 0));
const tasks = [...new Set(rows.map((r) => r.task))];
const of = (arm, task) => rows.filter((r) => armOf(r) === arm && (!task || r.task === task));

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => (xs.length ? sum(xs) / xs.length : NaN);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};
const f = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : "–");
const k = (x) => (x >= 1000 ? `${(x / 1000).toFixed(1)}k` : String(Math.round(x)));

const tok = (r) => r.tokens_all_models ?? r.usage ?? {};
const inputTokens = (r) => (tok(r).input_tokens ?? 0) + (tok(r).cache_creation_input_tokens ?? 0) + (tok(r).cache_read_input_tokens ?? 0);
const outputTokens = (r) => tok(r).output_tokens ?? 0;
const traceOf = (r) => {
  const p = path.join(EVAL, r.trace_file.replace(/^results\//, "results/"));
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
// Tool calls with batch contents counted separately: a batch counts as its actions.
const actions = (r) => {
  const calls = traceOf(r);
  return calls.length - calls.filter((c) => c.short === "batch").length + sum(calls.filter((c) => c.short === "batch").map((c) => c.batch_actions ?? 0));
};
const notOffered = (r) =>
  sum(Object.entries(r.tool_calls_by_tool ?? {}).filter(([t]) => r.tools_available && !r.tools_available.includes(t) && t !== "Agent").map(([, n]) => n));

const metrics = {
  "wall s": (r) => r.wall_ms / 1000,
  "tool calls": (r) => r.tool_calls,
  "actions (batch contents counted)": actions,
  "screenshot/zoom actions": (r) => r.screenshot_actions ?? r.screenshots ?? 0,
  "input tokens (incl. cache)": inputTokens,
  "output tokens": outputTokens,
  "cost USD": (r) => r.cost_usd,
};

const out = [];
const P = (...s) => out.push(...s);

P("## Experiment arms against no flags (Firefox, 16 tasks x 2 runs each)", "");
P(`Source: \`${path.relative(path.join(EVAL, ".."), IN)}\`. ${rows.length} runs, ${arms.length} arms, ${tasks.length} tasks, arms interleaved within each task and run. Cost is list price from the result event.`, "");

// ---- per arm totals ----
P("### Per arm", "");
P(`| arm | pass | wall s median / mean | tool calls median / mean | actions mean | screenshot actions mean | input tokens median / mean | output tokens median / mean | cost median / mean | total cost | not-offered tool calls |`);
P(`| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`);
for (const a of arms) {
  const rs = of(a);
  const col = (m) => rs.map(metrics[m]);
  P(
    `| ${a} | ${rs.filter((r) => r.pass).length}/${rs.length} | ${f(median(col("wall s")))} / ${f(mean(col("wall s")))} | ${f(median(col("tool calls")), 0)} / ${f(mean(col("tool calls")))} | ${f(mean(col("actions (batch contents counted)")))} | ${f(mean(col("screenshot/zoom actions")), 2)} | ${k(median(col("input tokens (incl. cache)")))} / ${k(mean(col("input tokens (incl. cache)")))} | ${k(median(col("output tokens")))} / ${k(mean(col("output tokens")))} | ${f(median(col("cost USD")), 3)} / ${f(mean(col("cost USD")), 3)} | ${f(sum(col("cost USD")), 2)} | ${sum(rs.map(notOffered))} |`,
  );
}
P("");

// ---- per task medians, ratios, and consistency ----
const taskMed = (arm, task, m) => median(of(arm, task).map(metrics[m]));
// Exact two-sided sign test on tasks that moved.
const signP = (up, down) => {
  const n = up + down;
  if (!n) return 1;
  const lo = Math.min(up, down);
  let p = 0;
  for (let i = 0; i <= lo; i++) {
    let c = 1;
    for (let j = 0; j < i; j++) c = (c * (n - j)) / (j + 1);
    p += c;
  }
  return Math.min(1, (2 * p) / 2 ** n);
};

// Run-to-run noise: none's run 1 against none's run 2 on the same tasks, the same way.
const noise = (m) => {
  let up = 0, down = 0;
  for (const t of tasks) {
    const [a, b] = [1, 2].map((n) => rows.find((r) => armOf(r) === "none" && r.task === t && r.run === n));
    if (!a || !b) continue;
    const x = metrics[m](a), y = metrics[m](b);
    if (y > x * (1 + BAND)) up++;
    else if (y < x * (1 - BAND)) down++;
  }
  return { up, down, same: tasks.length - up - down };
};

P("### Each arm against none, by task", "");
P(`Ratios are arm / none. "Geomean" is the geometric mean of the per-task median ratios (each task counts once). "Up / down" counts tasks whose median moved by more than ${BAND * 100}% in that direction, out of ${tasks.length}; "p" is a two-sided sign test on those. With 2 runs a task's median is their mean, so single-run luck moves it a lot: the last row shows none's run 1 against none's run 2 the same way, which is the noise floor.`, "");
for (const m of Object.keys(metrics)) {
  P(`**${m}**`, "");
  P(`| arm | ratio of means | geomean of task ratios | tasks up / same / down | p |`);
  P(`| --- | --- | --- | --- | --- |`);
  for (const a of arms.slice(1)) {
    let up = 0, down = 0, same = 0;
    const lg = [];
    for (const t of tasks) {
      const x = taskMed("none", t, m), y = taskMed(a, t, m);
      if (!(x > 0)) { same++; continue; }
      lg.push(Math.log(Math.max(y, 1e-9) / x));
      if (y > x * (1 + BAND)) up++;
      else if (y < x * (1 - BAND)) down++;
      else same++;
    }
    const geo = lg.length && m !== "screenshot/zoom actions" ? Math.exp(mean(lg)) : NaN;
    const rm = mean(of(a).map(metrics[m])) / mean(of("none").map(metrics[m]));
    P(`| ${a} | ${f(rm, 2)} | ${f(geo, 2)} | ${up} / ${same} / ${down} | ${f(signP(up, down), 2)} |`);
  }
  const n = noise(m);
  P(`| (none run 2 vs run 1) | – | – | ${n.up} / ${n.same} / ${n.down} | ${f(signP(n.up, n.down), 2)} |`);
  P("");
}

// ---- did each flag do what it should ----
P("### Did each flag do what it should", "");
const calls = (a) => of(a).flatMap((r) => traceOf(r).map((c) => ({ ...c, run: r })));
const runsWith = (a, pred) => of(a).filter((r) => traceOf(r).some(pred)).length;

P("**batchHint** (batch calls, and how many actions they held)", "");
P(`| arm | runs using batch | batch calls | actions per batch | runs with 2+ same-turn calls that could have batched (find/read_page then form_input or computer in the next call) |`);
P(`| --- | --- | --- | --- | --- |`);
for (const a of ["none", "batchHint"]) {
  const bs = calls(a).filter((c) => c.short === "batch");
  const missed = of(a).filter((r) => {
    const cs = traceOf(r);
    return cs.some((c, i) => ["find", "read_page"].includes(c.short) && cs[i + 1] && ["form_input", "computer"].includes(cs[i + 1].short) && !(cs[i + 1].action === "screenshot"));
  }).length;
  P(`| ${a} | ${runsWith(a, (c) => c.short === "batch")} of ${of(a).length} | ${bs.length} | ${f(mean(bs.map((c) => c.batch_actions ?? 0)))} | ${missed} |`);
}
P("");
P("Per task, batch calls (none / batchHint), tasks where either used one:", "");
const bt = tasks
  .map((t) => [t, ...["none", "batchHint"].map((a) => of(a, t).reduce((n, r) => n + traceOf(r).filter((c) => c.short === "batch").length, 0))])
  .filter(([, x, y]) => x || y);
P(bt.map(([t, x, y]) => `${t} ${x}/${y}`).join(", ") || "none", "");

P("**fewerShots** (screenshot actions, including zooms and those inside batches)", "");
P(`| arm | screenshot/zoom actions total | runs with any | mean per run |`);
P(`| --- | --- | --- | --- |`);
for (const a of ["none", "fewerShots"]) {
  const rs = of(a);
  const sh = rs.map(metrics["screenshot/zoom actions"]);
  P(`| ${a} | ${sum(sh)} | ${sh.filter((x) => x > 0).length} of ${rs.length} | ${f(mean(sh), 2)} |`);
}
P("");
P("Per task, screenshot actions (none / fewerShots), tasks where either had one:", "");
const st = tasks
  .map((t) => [t, ...["none", "fewerShots"].map((a) => sum(of(a, t).map(metrics["screenshot/zoom actions"])))])
  .filter(([, x, y]) => x || y);
P(st.map(([t, x, y]) => `${t} ${x}/${y}`).join(", ") || "none", "");

P("**screenshotAlias** (calls to the `screenshot` tool; in the other arms it is not offered)", "");
P(`| arm | screenshot tool calls | errors | runs using it | \`computer\` screenshot actions |`);
P(`| --- | --- | --- | --- | --- |`);
for (const a of arms) {
  const cs = calls(a);
  const shot = cs.filter((c) => c.short === "screenshot");
  const viaComputer = cs.filter((c) => c.short === "computer" && c.action === "screenshot").length;
  P(`| ${a} | ${shot.length} | ${shot.filter((c) => c.is_error).length} | ${new Set(shot.map((c) => c.run.run_id)).size} | ${viaComputer} |`);
}
P("");

P("**pageTextCap** (`get_page_text` results at the 8000-character cap, and reads that used offset or max_chars)", "");
P(`| arm | get_page_text calls | result bytes median / max | calls with offset or max_chars | calls that hit the cap (bytes 7900-8300) |`);
P(`| --- | --- | --- | --- | --- |`);
for (const a of ["none", "pageTextCap"]) {
  const g = calls(a).filter((c) => c.short === "get_page_text");
  P(`| ${a} | ${g.length} | ${k(median(g.map((c) => c.text_bytes)))} / ${k(Math.max(...g.map((c) => c.text_bytes)))} | ${g.filter((c) => /offset|max_chars/.test(c.args)).length} | ${g.filter((c) => c.text_bytes >= 7900 && c.text_bytes <= 8300).length} |`);
}
P("");
P("Per task, get_page_text calls in the cap arm against none (tasks where the count differs):", "");
const pt = tasks
  .map((t) => [t, ...["none", "pageTextCap"].map((a) => sum(of(a, t).map((r) => traceOf(r).filter((c) => c.short === "get_page_text").length))), Math.max(0, ...of("none", t).flatMap((r) => traceOf(r).filter((c) => c.short === "get_page_text").map((c) => c.text_bytes)))])
  .filter(([, x, y]) => x !== y);
P(pt.map(([t, x, y, big]) => `${t} ${x} -> ${y} (largest text in none ${k(big)} bytes)`).join("; ") || "no differences", "");

P("**quietTabs** (navigate results that end with the session's tab list)", "");
P(`| arm | navigate calls | results with a tab list | navigate calls that opened a tab |`);
P(`| --- | --- | --- | --- |`);
for (const a of ["none", "quietTabs"]) {
  const n = calls(a).filter((c) => c.short === "navigate");
  P(`| ${a} | ${n.length} | ${n.filter((c) => /This session's tabs/.test(c.text_head ?? "")).length} | ${n.filter((c) => /opened a new tab|Created tab/.test(c.text_head ?? "")).length} |`);
}
P("");

P("**fastNavigate** (navigate time; get_page_text and find issued in the same message wait for it)", "");
P(`| arm | navigate ms median / mean | navigate calls | get_page_text ms median | results with the "returned once the page was parsed" note |`);
P(`| --- | --- | --- | --- | --- |`);
for (const a of ["none", "fastNavigate"]) {
  const cs = calls(a);
  const n = cs.filter((c) => c.short === "navigate");
  P(`| ${a} | ${f(median(n.map((c) => c.ms)), 0)} / ${f(mean(n.map((c) => c.ms)), 0)} | ${n.length} | ${f(median(cs.filter((c) => c.short === "get_page_text").map((c) => c.ms)), 0)} | ${n.filter((c) => /returned once the page was parsed/.test(c.text_head ?? "")).length} |`);
}
P("");

P("### Failures", "");
for (const r of rows.filter((r) => !r.pass)) P(`- ${r.run_id}: ${r.timeout ? "timeout" : "wrong answer"}`);
P("");

const text = out.join("\n");
if (OUT) fs.writeFileSync(OUT, text);
else console.log(text);
