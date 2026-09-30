#!/usr/bin/env node
// Compares experiment arms (models.mjs --experiments) with the "none" arm, per effort and over
// all, and reads each run's stream to check that a flag did what it should.
//
//   node eval/models-arms-report.mjs [--in eval/results/models-hard/arms/runs.jsonl] [--prefix arms-]
//
// Writes <prefix>report.md, <prefix>summary.json and <prefix>derived.jsonl (per-run numbers read
// from the streams) next to the input. The streams (results/.../streams/) aren't committed, so
// derived.jsonl is what keeps the stream-only numbers.
//
// Ratios are of medians (arm / none). "Consistency" counts the (task, effort) cells where the
// cell median moved more than 5% (or, for score, at all) each way; a cell has 2 runs, so its
// median is their mean. The sign test is two-sided on the cells that moved.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { armOf } from "./lib/experiments.mjs";

const EVAL = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(EVAL);
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const IN = path.resolve(opt("in", path.join(EVAL, "results/models-hard/arms/runs.jsonl")));
const DIR = path.dirname(IN);
const PREFIX = opt("prefix", "arms-");

const rows = fs.readFileSync(IN, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => !r.infra_error && r.tag !== "smoke");

// ---- per-run numbers from the stream --------------------------------------------------------

const BATCH_HINT = "The next clicks, typing and form_input on these refs can go in one batch call";
const shortName = (n) => String(n ?? "").replace(/^mcp__firefox__/, "");
const textOf = (b) => (Array.isArray(b.content) ? b.content.map((c) => c.text ?? "").join("\n") : String(b.content ?? ""));

function fromStream(file) {
  const d = { stream: false, offered: null, actions: null, batch_calls: 0, batch_actions: 0, nonexistent: 0, nonexistent_inner: 0, nonexistent_names: {}, screenshot_tool_calls: 0, screenshot_tool_inner: 0,
    hint_results: 0, find_read_results: 0, navigate_calls: 0, navigate_with_tablist: 0, navigate_parsed_note: 0, navigate_still_loading: 0, navigate_kchars: 0,
    nav_ms: [], gpt_calls: 0, gpt_capped: 0, gpt_offset_calls: 0, gpt_kchars: 0, tool_kchars: 0, msgs_with_multiple_calls: 0 };
  const p = path.resolve(ROOT, file ?? "");
  if (!file || !fs.existsSync(p)) return d;
  d.stream = true;
  const names = new Map(); // tool_use id -> short name
  const useAt = new Map(); // tool_use id -> [message id, timestamp]
  let actions = 0;
  const navResults = [];
  const perMsg = new Map();
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type === "system" && e.subtype === "init") d.offered = e.tools ?? null;
    else if (e.type === "assistant") {
      if (e.parent_tool_use_id) continue;
      for (const b of e.message?.content ?? []) {
        if (b.type !== "tool_use") continue;
        const name = shortName(b.name);
        names.set(b.id, name);
        useAt.set(b.id, [e.message.id, Date.parse(e.timestamp), !perMsg.has(e.message.id)]);
        perMsg.set(e.message.id, (perMsg.get(e.message.id) ?? 0) + 1);
        const known = d.offered?.includes(b.name);
        if (d.offered && !known) {
          d.nonexistent++;
          d.nonexistent_names[name] = (d.nonexistent_names[name] ?? 0) + 1;
        }
        if (name === "screenshot" && known) d.screenshot_tool_calls++;
        if (name === "batch") {
          d.batch_calls++;
          const inner = b.input?.actions ?? [];
          d.batch_actions += inner.length;
          actions += inner.length;
          for (const a of inner) {
            const n = shortName(a.tool ?? a.name);
            if (n === "screenshot") d.screenshot_tool_inner++;
            if (n === "screenshot" && !d.offered?.includes("mcp__firefox__screenshot")) d.nonexistent_inner++;
          }
        } else actions++;
        if (name === "get_page_text") {
          d.gpt_calls++;
          if (b.input?.offset != null) d.gpt_offset_calls++;
        }
        if (name === "navigate") d.navigate_calls++;
      }
    } else if (e.type === "user") {
      for (const b of Array.isArray(e.message?.content) ? e.message.content : []) {
        if (b.type !== "tool_result") continue;
        const name = names.get(b.tool_use_id);
        const t = textOf(b);
        d.tool_kchars += t.length / 1000;
        if (name === "navigate" && useAt.has(b.tool_use_id)) navResults.push([b.tool_use_id, Date.parse(e.timestamp)]);
        if ((name === "find" || name === "read_page") && !b.is_error) {
          d.find_read_results++;
          if (t.includes(BATCH_HINT)) d.hint_results++;
        }
        if (name === "navigate") {
          d.navigate_kchars += t.length / 1000;
          if (t.includes("This session's tabs:")) d.navigate_with_tablist++;
          if (t.includes("returned once the page was parsed")) d.navigate_parsed_note++;
          if (t.includes("still loading after")) d.navigate_still_loading++;
        }
        if (name === "get_page_text") {
          d.gpt_kchars += t.length / 1000;
          if (/more chars; call get_page_text with offset/.test(t)) d.gpt_capped++;
        }
      }
    }
  }
  // Navigates that are the first call in their message: tool_use to tool_result time.
  for (const [id, end] of navResults) {
    const [, start, first] = useAt.get(id);
    if (first && Number.isFinite(end - start)) d.nav_ms.push(end - start);
  }
  d.actions = actions;
  d.msgs_with_multiple_calls = [...perMsg.values()].filter((n) => n > 1).length;
  return d;
}

const tok = (r) => r.tokens_all_models ?? r.usage ?? {};
for (const r of rows) {
  r.arm = armOf(r);
  r.d = fromStream(r.stream_file);
  r.in_tok = (tok(r).input_tokens ?? 0) + (tok(r).cache_read_input_tokens ?? 0) + (tok(r).cache_creation_input_tokens ?? 0);
  r.out_tok = tok(r).output_tokens ?? 0;
}

// ---- stats ---------------------------------------------------------------------------------

const q = (xs, p = 0.5) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  const pos = (s.length - 1) * p;
  const lo = Math.floor(pos);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (pos - lo);
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const sum = (xs) => xs.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
const f = (x, d = 2) => (x == null || !Number.isFinite(x) ? "–" : x.toFixed(d));
const x = (v) => (v == null || !Number.isFinite(v) ? "–" : `×${v.toFixed(2)}`);
const pct = (v) => (v == null ? "–" : `${Math.round(v * 100)}%`);

const ARMS = [...new Set(rows.map((r) => r.arm))].sort((a, b) => (a === "none" ? -1 : b === "none" ? 1 : 0));
const EFFORTS = [...new Set(rows.map((r) => r.effort))].sort((a, b) => ["low", "medium", "high"].indexOf(a) - ["low", "medium", "high"].indexOf(b));
const TASKS = [...new Set(rows.map((r) => r.task))].sort();
const REF = ARMS[0];

const METRICS = {
  score: (r) => r.score,
  wall_s: (r) => r.wall_ms / 1000,
  calls: (r) => r.tool_calls,
  actions: (r) => r.d.actions ?? NaN,
  shots: (r) => r.screenshot_actions ?? r.screenshots,
  in_tok: (r) => r.in_tok,
  out_tok: (r) => r.out_tok,
  cost: (r) => r.cost_usd ?? NaN,
  errors: (r) => r.tool_errors,
};

function summarize(rs) {
  const s = { n: rs.length, passes: rs.filter((r) => r.pass).length, timeouts: rs.filter((r) => r.timeout).length, total_cost: sum(rs.map((r) => r.cost_usd)) };
  s.pass_rate = rs.length ? s.passes / rs.length : null;
  for (const [k, fn] of Object.entries(METRICS)) {
    const v = rs.map(fn);
    s[k] = { median: q(v), mean: mean(v.filter(Number.isFinite)) };
  }
  s.nonexistent_per_run = rs.length ? sum(rs.map((r) => r.d.nonexistent)) / rs.length : null;
  s.batch_share = sum(rs.map((r) => r.tool_calls)) ? sum(rs.map((r) => r.d.batch_calls)) / sum(rs.map((r) => r.tool_calls)) : null;
  s.batch_per_run = rs.length ? sum(rs.map((r) => r.d.batch_calls)) / rs.length : null;
  return s;
}

const cellMedian = (rs, fn) => q(rs.map(fn));

// Cells where the arm's (task, effort) median moved from none's: lower, higher, flat.
function consistency(arm, efforts, fn, { exact = false } = {}) {
  let down = 0, up = 0, flat = 0;
  for (const e of efforts)
    for (const t of TASKS) {
      const a = cellMedian(rows.filter((r) => r.arm === arm && r.effort === e && r.task === t), fn);
      const b = cellMedian(rows.filter((r) => r.arm === REF && r.effort === e && r.task === t), fn);
      if (a == null || b == null) continue;
      const ratio = b === 0 ? (a === 0 ? 1 : Infinity) : a / b;
      const tol = exact ? 1e-9 : 0.05;
      if (Math.abs(ratio - 1) <= tol) flat++;
      else if (ratio < 1) down++;
      else up++;
    }
  return { down, up, flat };
}
// Two-sided sign test on the cells that moved.
function signP(a, b) {
  const n = a + b;
  if (!n) return 1;
  const k = Math.min(a, b);
  let p = 0;
  const C = (n, k) => { let r = 1; for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i; return r; };
  for (let i = 0; i <= k; i++) p += C(n, i);
  return Math.min(1, (2 * p) / 2 ** n);
}
// Geometric mean over (task, effort) cells of arm cell median / none cell median (cells where
// either is 0 are left out), so a few long tasks don't set the ratio.
function geo(arm, efforts, fn) {
  const logs = [];
  for (const e of efforts)
    for (const t of TASKS) {
      const a = cellMedian(rows.filter((r) => r.arm === arm && r.effort === e && r.task === t), fn);
      const b = cellMedian(rows.filter((r) => r.arm === REF && r.effort === e && r.task === t), fn);
      if (a > 0 && b > 0) logs.push(Math.log(a / b));
    }
  return logs.length ? Math.exp(mean(logs)) : null;
}
const cons = (c) => `${c.down}↓ ${c.up}↑ ${c.flat}=`;

const summary = { generated_at: new Date().toISOString(), runs: rows.length, arms: ARMS, reference: REF, efforts: EFFORTS, per: {} };
for (const scope of [...EFFORTS, "all"]) {
  const efforts = scope === "all" ? EFFORTS : [scope];
  summary.per[scope] = {};
  for (const arm of ARMS) {
    const rs = rows.filter((r) => r.arm === arm && efforts.includes(r.effort));
    if (!rs.length) continue;
    const s = summarize(rs);
    if (arm !== REF) {
      const ref = summary.per[scope][REF];
      const r = (k) => (ref[k].median ? s[k].median / ref[k].median : null);
      const rm = (k) => (ref[k].mean ? s[k].mean / ref[k].mean : null);
      s.vs = { d_score: s.score.mean - ref.score.mean, d_pass: s.passes - ref.passes, wall: r("wall_s"), wall_mean: rm("wall_s"), calls: r("calls"), actions: r("actions"), shots: r("shots"), in_tok: r("in_tok"), out_tok: r("out_tok"), cost: r("cost"), cost_mean: rm("cost") };
      s.geo = Object.fromEntries(["wall_s", "cost", "calls", "actions", "shots", "in_tok", "out_tok"].map((k) => [k, geo(arm, efforts, METRICS[k])]));
      s.consistency = {};
      for (const [k, fn] of Object.entries({ wall_s: METRICS.wall_s, cost: METRICS.cost, calls: METRICS.calls, actions: METRICS.actions, shots: METRICS.shots })) s.consistency[k] = consistency(arm, efforts, fn);
      s.consistency.score = consistency(arm, efforts, (row) => row.score, { exact: true });
      for (const k of Object.keys(s.consistency)) s.consistency[k].p = signP(s.consistency[k].down, s.consistency[k].up);
    }
    summary.per[scope][arm] = s;
  }
}
fs.writeFileSync(path.join(DIR, `${PREFIX}summary.json`), JSON.stringify(summary, null, 2) + "\n");
fs.writeFileSync(path.join(DIR, `${PREFIX}derived.jsonl`), rows.map((r) => JSON.stringify({ task: r.task, config: r.config, round: r.round, arm: r.arm, score: r.score, pass: r.pass, wall_s: +(r.wall_ms / 1000).toFixed(1), calls: r.tool_calls, cost_usd: r.cost_usd, in_tok: r.in_tok, out_tok: r.out_tok, ...r.d, offered: undefined })).join("\n") + "\n");

// ---- markdown ------------------------------------------------------------------------------

const cell = (v, d = 0) => (v?.median == null ? "–" : f(v.median, d));
let md = `# Experiment arms, hard tier: Sonnet 5.5 at low and high effort\n\n${rows.length} runs, ${ARMS.length} arms (${ARMS.join(", ")}), ${EFFORTS.join(" and ")} effort, ${TASKS.length} tasks, rounds ${[...new Set(rows.map((r) => r.round))].join(", ")}. Total list-price spend $${f(sum(rows.map((r) => r.cost_usd)), 2)}. Generated ${summary.generated_at}.\n\n`;
md += `Ratios are of medians, arm over \`${REF}\`. Actions count the steps inside \`batch\` calls (the batch call itself doesn't count). Shots are screenshots and zooms, inside batches too. Input tokens include cache reads and writes. Cost is the CLI's list-price \`total_cost_usd\`.\n`;
for (const scope of [...EFFORTS, "all"]) {
  md += `\n## ${scope === "all" ? "Both efforts" : `Effort ${scope}`}\n\n| arm | n | pass | score | wall s (med / mean) | ×wall | calls | ×calls | actions | ×actions | shots | ×shots | in tok | ×in | out tok | ×out | cost $ (med / mean) | ×cost | bad-tool calls/run | tool errors |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n`;
  for (const [arm, s] of Object.entries(summary.per[scope])) {
    const v = s.vs ?? {};
    const ref = arm === REF;
    md += `| ${arm} | ${s.n} | ${s.passes} (${pct(s.pass_rate)}) | ${f(s.score.mean, 3)}${ref ? "" : ` (${v.d_score >= 0 ? "+" : ""}${f(v.d_score, 3)})`} | ${f(s.wall_s.median, 0)} / ${f(s.wall_s.mean, 0)} | ${ref ? "" : x(v.wall)} | ${cell(s.calls)} | ${ref ? "" : x(v.calls)} | ${cell(s.actions)} | ${ref ? "" : x(v.actions)} | ${cell(s.shots, 1)} | ${ref ? "" : x(v.shots)} | ${f(s.in_tok.median / 1000, 0)}k | ${ref ? "" : x(v.in_tok)} | ${f(s.out_tok.median / 1000, 1)}k | ${ref ? "" : x(v.out_tok)} | ${f(s.cost.median, 3)} / ${f(s.cost.mean, 3)} | ${ref ? "" : x(v.cost)} | ${f(s.nonexistent_per_run, 2)} | ${f(s.errors.mean, 1)} |\n`;
  }
  md += `\nGeometric mean of the per-cell ratios (each task x effort cell's median over \`${REF}\`'s), which a few long tasks can't dominate:\n\n| arm | wall | cost | calls | actions | shots | in tok | out tok |\n|---|---|---|---|---|---|---|---|\n`;
  for (const [arm, s] of Object.entries(summary.per[scope])) if (arm !== REF) md += `| ${arm} | ${["wall_s", "cost", "calls", "actions", "shots", "in_tok", "out_tok"].map((k) => x(s.geo[k])).join(" | ")} |\n`;
  md += `\nTask consistency against \`${REF}\` (cells = task${scope === "all" ? " x effort" : ""}; "↓" = the arm's cell median is lower by more than 5%, score: lower at all; sign-test p on the cells that moved):\n\n| arm | wall | cost | calls | actions | shots | score |\n|---|---|---|---|---|---|---|\n`;
  for (const [arm, s] of Object.entries(summary.per[scope])) {
    if (arm === REF) continue;
    const c = s.consistency;
    md += `| ${arm} | ${cons(c.wall_s)} (p=${f(c.wall_s.p, 2)}) | ${cons(c.cost)} (p=${f(c.cost.p, 2)}) | ${cons(c.calls)} (p=${f(c.calls.p, 2)}) | ${cons(c.actions)} (p=${f(c.actions.p, 2)}) | ${cons(c.shots)} (p=${f(c.shots.p, 2)}) | ${cons(c.score)} |\n`;
  }
}

md += `\n## Did each flag do what it should (read from the streams)\n\nPer arm, over all efforts. "Bad-tool calls" are calls to tools the run wasn't offered.\n\n| arm | runs | batch calls/run | batch share of calls | steps per batch | calls that share a message with another | find/read_page results with the batch hint | navigate results with a tab list | navigate results ending "parsed" | navigate "still loading" | navigate ms (first call of a message), median (n) | get_page_text calls/run | capped results | calls with offset | get_page_text kchars/run | screenshot-tool calls/run | bad-tool calls/run (names) |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n`;
for (const arm of ARMS) {
  const rs = rows.filter((r) => r.arm === arm && r.d.stream);
  if (!rs.length) continue;
  const S = (k) => sum(rs.map((r) => r.d[k]));
  const names = {};
  for (const r of rs) for (const [k, v] of Object.entries(r.d.nonexistent_names)) names[k] = (names[k] ?? 0) + v;
  const n = rs.length;
  md += `| ${arm} | ${n} | ${f(S("batch_calls") / n)} | ${pct(S("batch_calls") / sum(rs.map((r) => r.tool_calls)))} | ${f(S("batch_calls") ? S("batch_actions") / S("batch_calls") : null, 1)} | ${f(S("msgs_with_multiple_calls") / n)} | ${S("hint_results")} of ${S("find_read_results")} | ${S("navigate_with_tablist")} of ${S("navigate_calls")} | ${S("navigate_parsed_note")} | ${S("navigate_still_loading")} | ${f(q(rs.flatMap((r) => r.d.nav_ms)), 0)} (${rs.flatMap((r) => r.d.nav_ms).length}) | ${f(S("gpt_calls") / n)} | ${S("gpt_capped")} | ${S("gpt_offset_calls")} | ${f(S("gpt_kchars") / n, 1)} | ${f((S("screenshot_tool_calls") + S("screenshot_tool_inner")) / n)} | ${f(S("nonexistent") / n)} (${Object.entries(names).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}) |\n`;
}

md += `\n## Per task: median wall s / calls / cost $ (both efforts pooled, 4 runs per cell) and passes\n\n| task | ${ARMS.join(" | ")} |\n|---|${ARMS.map(() => "---").join("|")}|\n`;
for (const t of TASKS) {
  md += `| ${t} | ${ARMS.map((arm) => {
    const rs = rows.filter((r) => r.arm === arm && r.task === t);
    return rs.length ? `${f(q(rs.map(METRICS.wall_s)), 0)}s / ${f(q(rs.map(METRICS.calls)), 0)} / ${f(q(rs.map(METRICS.cost)), 2)} (${rs.filter((r) => r.pass).length}/${rs.length})` : "–";
  }).join(" | ")} |\n`;
}
md += `\n## Failed runs\n\n| arm | effort | task | round | score | wall s | note |\n|---|---|---|---|---|---|---|\n`;
for (const r of rows.filter((r) => !r.pass).sort((a, b) => ARMS.indexOf(a.arm) - ARMS.indexOf(b.arm)))
  md += `| ${r.arm} | ${r.effort} | ${r.task} | ${r.round} | ${f(r.score, 2)} | ${f(r.wall_ms / 1000, 0)} | ${r.timeout ? "timeout" : Object.entries(r.fields ?? {}).filter(([, v]) => !v).map(([k]) => k).join(", ")} |\n`;
fs.writeFileSync(path.join(DIR, `${PREFIX}report.md`), md);
console.log(`wrote ${path.relative(process.cwd(), path.join(DIR, `${PREFIX}report.md`))} (${rows.length} runs, $${f(sum(rows.map((r) => r.cost_usd)), 2)})`);
