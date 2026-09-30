#!/usr/bin/env node
// Summarizes eval/results/models/runs.jsonl into report.md and summary.json: per config and per
// task x config, n, pass rate, mean score, the median and IQR of every metric, cost per success,
// and Pareto flags (score vs cost, score vs time). Rows that failed for infrastructure reasons
// (no result from the CLI) are left out; timeouts count as score 0.
//
//   node eval/models-report.mjs [--in eval/results/models/runs.jsonl] [--prefix sonnet-rerun-]
//
// --prefix names the outputs <prefix>report.md and <prefix>summary.json, so a rerun into its own
// file doesn't overwrite the round's report.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EVAL = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const i = argv.indexOf("--in");
const IN = path.resolve(i >= 0 ? argv[i + 1] : path.join(EVAL, "results/models/runs.jsonl"));
const DIR = path.dirname(IN);
const p = argv.indexOf("--prefix");
const PREFIX = p >= 0 ? argv[p + 1] : "";

const rows = fs
  .readFileSync(IN, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .filter((r) => !r.infra_error && r.tag !== "smoke");

// ---- stats ---------------------------------------------------------------------------------

const q = (xs, p) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const pos = (s.length - 1) * p;
  const lo = Math.floor(pos);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (pos - lo);
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const dist = (xs) => ({ median: q(xs, 0.5), p25: q(xs, 0.25), p75: q(xs, 0.75), iqr: q(xs, 0.75) != null ? q(xs, 0.75) - q(xs, 0.25) : null, mean: mean(xs.filter(Number.isFinite)) });

const tok = (r) => r.tokens_all_models ?? r.usage ?? {};
const METRICS = {
  wall_s: (r) => r.wall_ms / 1000,
  first_tool_s: (r) => (r.first_tool_ms ?? NaN) / 1000,
  api_s: (r) => (r.duration_api_ms ?? NaN) / 1000,
  cost_usd: (r) => r.cost_usd ?? NaN,
  tool_calls: (r) => r.tool_calls,
  screenshots: (r) => r.screenshots,
  turns: (r) => r.turns ?? NaN,
  output_tokens: (r) => tok(r).output_tokens ?? NaN, // includes thinking
  input_tokens: (r) => tok(r).input_tokens ?? NaN,
  cache_read_tokens: (r) => tok(r).cache_read_input_tokens ?? NaN,
  cache_write_tokens: (r) => tok(r).cache_creation_input_tokens ?? NaN,
  total_input_tokens: (r) => (tok(r).input_tokens ?? 0) + (tok(r).cache_read_input_tokens ?? 0) + (tok(r).cache_creation_input_tokens ?? 0),
  thinking_blocks: (r) => r.thinking_blocks ?? NaN,
  tool_errors: (r) => r.tool_errors,
  repeated_calls: (r) => r.repeated_calls ?? NaN,
  retries_after_error: (r) => r.retries_after_error ?? NaN,
  tool_result_kchars: (r) => (r.tool_result_chars ?? 0) / 1000,
  load_other_eval: (r) => r.load?.other_eval?.mean ?? NaN,
  load_siblings: (r) => r.load?.siblings?.mean ?? NaN,
};

function summarizeGroup(rs) {
  const n = rs.length;
  const passes = rs.filter((r) => r.pass).length;
  const cost = rs.reduce((a, r) => a + (r.cost_usd ?? 0), 0);
  const out = {
    n,
    pass_rate: n ? passes / n : null,
    mean_score: mean(rs.map((r) => r.score)),
    timeouts: rs.filter((r) => r.timeout).length,
    total_cost_usd: cost,
    cost_per_success_usd: passes ? cost / passes : null,
    time_per_success_s: passes ? rs.reduce((a, r) => a + r.wall_ms / 1000, 0) / passes : null,
    tool_calls_by_tool: {},
    metrics: {},
  };
  for (const r of rs) for (const [k, v] of Object.entries(r.tool_calls_by_tool ?? {})) out.tool_calls_by_tool[k.replace("mcp__firefox__", "")] = (out.tool_calls_by_tool[k.replace("mcp__firefox__", "")] ?? 0) + v;
  for (const [k, f] of Object.entries(METRICS)) out.metrics[k] = dist(rs.map(f));
  return out;
}

const configs = [...new Set(rows.map((r) => r.config))].sort((a, b) => {
  const order = (c) => ["haiku", "sonnet", "opus", "fable"].findIndex((m) => c.includes(m)) * 10 + ["default", "low", "medium", "high"].indexOf(c.split("/")[1]);
  return order(a) - order(b);
});
const tasks = [...new Set(rows.map((r) => r.task))].sort();

const perConfig = {};
for (const c of configs) perConfig[c] = summarizeGroup(rows.filter((r) => r.config === c));
const perTaskConfig = {};
for (const t of tasks) {
  perTaskConfig[t] = {};
  for (const c of configs) {
    const rs = rows.filter((r) => r.task === t && r.config === c);
    if (rs.length) perTaskConfig[t][c] = summarizeGroup(rs);
  }
}

// Pareto: a config is on the frontier if no other config has a higher-or-equal mean score and a
// lower-or-equal cost (or time), with at least one strictly better.
function pareto(group, costKey) {
  const pts = Object.entries(group).map(([c, s]) => ({ c, score: s.mean_score, cost: s.metrics[costKey].median }));
  const flags = {};
  for (const p of pts) {
    flags[p.c] = !pts.some((o) => o.c !== p.c && o.score >= p.score && o.cost <= p.cost && (o.score > p.score || o.cost < p.cost));
  }
  return flags;
}
const flag = (group) => {
  const pc = pareto(group, "cost_usd");
  const pt = pareto(group, "wall_s");
  for (const c of Object.keys(group)) {
    group[c].pareto_score_cost = pc[c];
    group[c].pareto_score_time = pt[c];
  }
};
flag(perConfig);
for (const t of tasks) flag(perTaskConfig[t]);

// Effort steps within each model: what each step up bought and what it cost.
const effortSteps = [];
for (const m of [...new Set(configs.map((c) => c.split("/")[0]))]) {
  const levels = ["low", "medium", "high"].map((e) => `${m}/${e}`).filter((c) => perConfig[c]);
  for (let k = 1; k < levels.length; k++) {
    const a = perConfig[levels[k - 1]];
    const b = perConfig[levels[k]];
    const dScore = b.mean_score - a.mean_score;
    const dCost = b.metrics.cost_usd.median - a.metrics.cost_usd.median;
    effortSteps.push({
      model: m, from: levels[k - 1].split("/")[1], to: levels[k].split("/")[1],
      d_mean_score: dScore, d_pass_rate: b.pass_rate - a.pass_rate,
      d_median_cost_usd: dCost, d_median_wall_s: b.metrics.wall_s.median - a.metrics.wall_s.median,
      d_median_output_tokens: b.metrics.output_tokens.median - a.metrics.output_tokens.median,
      usd_per_score_point: dScore > 0 ? dCost / (dScore * 100) : null,
    });
  }
}

const summary = {
  generated_at: new Date().toISOString(),
  runs: rows.length,
  rounds: [...new Set(rows.map((r) => r.round))].sort(),
  configs, tasks,
  per_config: perConfig,
  per_task_config: perTaskConfig,
  effort_steps: effortSteps,
};
fs.writeFileSync(path.join(DIR, `${PREFIX}summary.json`), JSON.stringify(summary, null, 2) + "\n");

// ---- markdown ------------------------------------------------------------------------------

const f = (x, d = 2) => (x == null || !Number.isFinite(x) ? "–" : x.toFixed(d));
const pct = (x) => (x == null ? "–" : `${Math.round(x * 100)}%`);
const mi = (d, dig = 0) => (d?.median == null ? "–" : `${f(d.median, dig)} (${f(d.p25, dig)}–${f(d.p75, dig)})`);
const short = (c) => c.replace("claude-", "").replace("-20251001", "");

let md = `# Model x effort benchmark\n\n${rows.length} runs over ${tasks.length} tasks and ${configs.length} configs (rounds ${summary.rounds.join(", ")}). Generated ${summary.generated_at}.\n\n`;
md += `Cells show median (p25–p75). Score is the share of a task's sub-goals met (timeouts score 0); pass means every sub-goal. Cost is \`total_cost_usd\` from the CLI's result event (list-price equivalent). Output tokens include thinking. ★ = on the Pareto frontier.\n\n`;
md += `## Per config\n\n| config | n | pass | score | wall s | 1st tool s | tool calls | shots | turns | out tok | in tok (all) | cost $ | $/success | ★ score/cost | ★ score/time | timeouts | load (other eval) |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n`;
for (const c of configs) {
  const s = perConfig[c];
  const m = s.metrics;
  md += `| ${short(c)} | ${s.n} | ${pct(s.pass_rate)} | ${f(s.mean_score)} | ${mi(m.wall_s)} | ${mi(m.first_tool_s, 1)} | ${mi(m.tool_calls)} | ${mi(m.screenshots)} | ${mi(m.turns)} | ${mi(m.output_tokens)} | ${mi(m.total_input_tokens)} | ${mi(m.cost_usd, 3)} | ${f(s.cost_per_success_usd, 3)} | ${s.pareto_score_cost ? "★" : ""} | ${s.pareto_score_time ? "★" : ""} | ${s.timeouts} | ${f(m.load_other_eval.mean, 1)} |\n`;
}
md += `\n## Errors and retries per config\n\n| config | tool errors | repeated calls | retries after error | thinking blocks | tool result kchars |\n|---|---|---|---|---|---|\n`;
for (const c of configs) {
  const m = perConfig[c].metrics;
  md += `| ${short(c)} | ${mi(m.tool_errors)} | ${mi(m.repeated_calls)} | ${mi(m.retries_after_error)} | ${mi(m.thinking_blocks)} | ${mi(m.tool_result_kchars, 1)} |\n`;
}
md += `\n## Effort steps (within a model)\n\n| model | step | Δ score | Δ pass | Δ median cost $ | Δ median wall s | Δ median out tok | $ per score point |\n|---|---|---|---|---|---|---|---|\n`;
for (const e of effortSteps) {
  md += `| ${short(e.model)} | ${e.from}→${e.to} | ${f(e.d_mean_score)} | ${f(e.d_pass_rate * 100, 0)} pts | ${f(e.d_median_cost_usd, 3)} | ${f(e.d_median_wall_s, 0)} | ${f(e.d_median_output_tokens, 0)} | ${f(e.usd_per_score_point, 4)} |\n`;
}
md += `\n## Per task\n`;
for (const t of tasks) {
  md += `\n### ${t}\n\n| config | n | pass | score | wall s | tool calls | out tok | cost $ | $/success | ★ cost | ★ time |\n|---|---|---|---|---|---|---|---|---|---|---|\n`;
  for (const [c, s] of Object.entries(perTaskConfig[t])) {
    const m = s.metrics;
    md += `| ${short(c)} | ${s.n} | ${pct(s.pass_rate)} | ${f(s.mean_score)} | ${mi(m.wall_s)} | ${mi(m.tool_calls)} | ${mi(m.output_tokens)} | ${mi(m.cost_usd, 3)} | ${f(s.cost_per_success_usd, 3)} | ${s.pareto_score_cost ? "★" : ""} | ${s.pareto_score_time ? "★" : ""} |\n`;
  }
  // Which sub-goals fail most, across configs.
  const fails = {};
  for (const r of rows.filter((r) => r.task === t)) for (const [k, v] of Object.entries(r.fields ?? {})) fails[k] = (fails[k] ?? 0) + (v ? 0 : 1);
  const n = rows.filter((r) => r.task === t).length;
  md += `\nSub-goal miss rate: ${Object.entries(fails).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${pct(v / n)}`).join(", ")}\n`;
}
fs.writeFileSync(path.join(DIR, `${PREFIX}report.md`), md);
console.log(`wrote ${path.relative(process.cwd(), path.join(DIR, `${PREFIX}report.md`))} and ${PREFIX}summary.json (${rows.length} runs)`);
