#!/usr/bin/env node
// Writes charts.json next to a models runs.jsonl, in the schema of eval/results/models/charts.json
// (round 1, written by hand): meta, score_vs_cost, score_vs_time, effort_curves,
// heatmap_task_config_mean_score, tool_use_per_config, token_breakdown_per_config,
// cost_per_successful_task. Frontier notes are generated; meta.notes can be extended with --note.
//
//   node eval/models-charts.mjs --in eval/results/models-hard/runs.jsonl [--note "..."]...

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EVAL = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(EVAL);
const argv = process.argv.slice(2);
const i = argv.indexOf("--in");
const IN = path.resolve(i >= 0 ? argv[i + 1] : path.join(EVAL, "results/models-hard/runs.jsonl"));
const notes = argv.flatMap((a, k) => (a === "--note" ? [argv[k + 1]] : []));

const rows = fs.readFileSync(IN, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => !r.infra_error && r.tag !== "smoke");
const short = (c) => c.replace("claude-", "").replace("-20251001", "");
const MODEL_ORDER = ["haiku", "sonnet", "opus", "fable"];
const EFFORT_ORDER = ["default", "low", "medium", "high"];
const order = (c) => MODEL_ORDER.findIndex((m) => c.includes(m)) * 10 + EFFORT_ORDER.indexOf(c.split("/")[1]);
const configs = [...new Set(rows.map((r) => short(r.config)))].sort((a, b) => order(a) - order(b));
const taskOrder = [...new Set(rows.map((r) => r.task))];
let tasks = taskOrder;
try {
  const mod = await import(IN.includes("models-hard") ? "./models-tasks-hard.mjs" : "./models-tasks.mjs");
  tasks = mod.TASKS.map((t) => t.id).filter((t) => taskOrder.includes(t));
} catch {}

const q = (xs, p) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  const pos = (s.length - 1) * p;
  const lo = Math.floor(pos);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (pos - lo);
};
const med = (xs) => q(xs, 0.5);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const r2 = (x, d = 2) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);
const geo = (xs) => Math.exp(mean(xs.map(Math.log)));
const of = (c, t) => rows.filter((r) => short(r.config) === c && (!t || r.task === t));
const tok = (r) => r.tokens_all_models ?? r.usage ?? {};

// Index: geometric mean over tasks of (cell median / all-config median for that task).
const index = (metric) =>
  Object.fromEntries(
    configs.map((c) => {
      const ratios = tasks
        .map((t) => {
          const cell = med(of(c, t).map(metric));
          const all = med(rows.filter((r) => r.task === t).map(metric));
          return cell && all ? cell / all : null;
        })
        .filter((x) => x);
      return [c, ratios.length ? r2(geo(ratios)) : null];
    }),
  );
const costIdx = index((r) => r.cost_usd);
const timeIdx = index((r) => r.wall_ms / 1000);

const per = Object.fromEntries(
  configs.map((c) => {
    const rs = of(c);
    const [model, effort] = c.split("/");
    return [c, {
      config: c, model, effort,
      mean_score: r2(mean(rs.map((r) => r.score)), 3), pass_rate: r2(rs.filter((r) => r.pass).length / rs.length, 3),
      cost_mean_usd: r2(mean(rs.map((r) => r.cost_usd ?? 0)), 4), cost_median_usd: r2(med(rs.map((r) => r.cost_usd)), 4), cost_index: costIdx[c],
      wall_median_s: r2(med(rs.map((r) => r.wall_ms / 1000)), 1), wall_mean_s: r2(mean(rs.map((r) => r.wall_ms / 1000)), 1), time_index: timeIdx[c],
    }];
  }),
);

const frontier = (x) => configs.filter((c) => !configs.some((o) => o !== c && per[o].mean_score >= per[c].mean_score && per[o][x] <= per[c][x] && (per[o].mean_score > per[c].mean_score || per[o][x] < per[c][x])));
const fCost = frontier("cost_mean_usd");
const fTime = frontier("wall_median_s");
const fTimeIdx = frontier("time_index");
const describe = (f, x, unit) => f.map((c) => `${c} (score ${per[c].mean_score}, ${unit(per[c][x])})`).join(", ");

// Unknown-tool errors from the raw streams (the rows keep only samples).
function unknownToolErrors(r) {
  const file = r.stream_file && path.join(ROOT, r.stream_file);
  if (!file || !fs.existsSync(file)) return (r.error_samples ?? []).filter((e) => /No such tool available/.test(e)).length;
  let n = 0;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.includes("No such tool available")) continue;
    try {
      const e = JSON.parse(line);
      for (const b of e.message?.content ?? []) if (b.type === "tool_result" && b.is_error && JSON.stringify(b.content).includes("No such tool available")) n++;
    } catch {}
  }
  return n;
}

const models = [...new Set(configs.map((c) => c.split("/")[0]))].filter((m) => !m.startsWith("haiku"));
const efforts = ["low", "medium", "high"];
const curve = (c) => {
  const rs = of(c);
  return {
    mean_score: per[c].mean_score, wall_median_s: per[c].wall_median_s, time_index: per[c].time_index,
    output_tokens_median: med(rs.map((r) => tok(r).output_tokens)),
    total_tokens_mean: Math.round(mean(rs.map((r) => (tok(r).input_tokens ?? 0) + (tok(r).cache_read_input_tokens ?? 0) + (tok(r).cache_creation_input_tokens ?? 0) + (tok(r).output_tokens ?? 0)))),
    cost_mean_usd: per[c].cost_mean_usd, cost_index: per[c].cost_index, tool_calls_median: med(rs.map((r) => r.tool_calls)),
  };
};
const haiku = configs.find((c) => c.startsWith("haiku"));

const charts = {
  meta: {
    source: path.relative(ROOT, IN),
    runs: rows.length,
    configs,
    tasks,
    runs_per_cell: Math.round(rows.length / (configs.length * tasks.length)),
    notes: [
      "cost is total_cost_usd from the CLI result event (list-price equivalent; subscription)",
      `time_index / cost_index = geometric mean over the ${tasks.length} tasks of (cell median / all-config task median); 1.0 = typical`,
      ...notes,
    ],
  },
  score_vs_cost: {
    x: "cost_mean_usd", y: "mean_score",
    points: configs.map((c) => (({ config, model, effort, mean_score, pass_rate, cost_mean_usd, cost_median_usd, cost_index }) => ({ config, model, effort, mean_score, pass_rate, cost_mean_usd, cost_median_usd, cost_index }))(per[c])),
    frontier: fCost,
    frontier_note: `Pareto frontier (higher mean score, lower mean cost): ${describe(fCost, "cost_mean_usd", (v) => `$${v}`)}.`,
  },
  score_vs_time: {
    x: "wall_median_s", y: "mean_score",
    points: configs.map((c) => (({ config, model, effort, mean_score, pass_rate, wall_median_s, wall_mean_s, time_index }) => ({ config, model, effort, mean_score, pass_rate, wall_median_s, wall_mean_s, time_index }))(per[c])),
    frontier: fTime,
    frontier_by_time_index: fTimeIdx,
    frontier_note: `By pooled median wall time: ${describe(fTime, "wall_median_s", (v) => `${v}s`)}. By task-normalized time index: ${describe(fTimeIdx, "time_index", (v) => `index ${v}`)}.`,
  },
  effort_curves: {
    efforts,
    models: Object.fromEntries(models.map((m) => {
      const cs = efforts.map((e) => `${m}/${e}`).filter((c) => per[c]);
      const cv = cs.map(curve);
      return [m, Object.fromEntries(Object.keys(cv[0] ?? {}).map((k) => [k, cv.map((x) => x[k])]))];
    })),
    haiku_default_reference: haiku ? curve(haiku) : null,
  },
  heatmap_task_config_mean_score: {
    rows: tasks, cols: configs,
    values: tasks.map((t) => configs.map((c) => r2(mean(of(c, t).map((r) => r.score)), 3))),
    pass_counts: tasks.map((t) => configs.map((c) => of(c, t).filter((r) => r.pass).length)),
  },
  tool_use_per_config: {
    configs,
    tool_calls_median: configs.map((c) => med(of(c).map((r) => r.tool_calls))),
    screenshots_median: configs.map((c) => med(of(c).map((r) => r.screenshots))),
    tool_calls_mean: configs.map((c) => r2(mean(of(c).map((r) => r.tool_calls)), 1)),
    screenshots_mean: configs.map((c) => r2(mean(of(c).map((r) => r.screenshots)), 1)),
    tool_errors_total: configs.map((c) => of(c).reduce((a, r) => a + (r.tool_errors ?? 0), 0)),
    unknown_tool_name_errors: configs.map((c) => of(c).reduce((a, r) => a + unknownToolErrors(r), 0)),
    repeated_calls_total: configs.map((c) => of(c).reduce((a, r) => a + (r.repeated_calls ?? 0), 0)),
    retries_after_error_total: configs.map((c) => of(c).reduce((a, r) => a + (r.retries_after_error ?? 0), 0)),
  },
  token_breakdown_per_config: {
    configs,
    unit: "tokens per run (mean)",
    input_uncached: configs.map((c) => Math.round(mean(of(c).map((r) => tok(r).input_tokens ?? 0)))),
    cache_write: configs.map((c) => Math.round(mean(of(c).map((r) => tok(r).cache_creation_input_tokens ?? 0)))),
    cache_read: configs.map((c) => Math.round(mean(of(c).map((r) => tok(r).cache_read_input_tokens ?? 0)))),
    output_incl_thinking: configs.map((c) => Math.round(mean(of(c).map((r) => tok(r).output_tokens ?? 0)))),
    median: {
      input_uncached: configs.map((c) => med(of(c).map((r) => tok(r).input_tokens ?? 0))),
      cache_write: configs.map((c) => med(of(c).map((r) => tok(r).cache_creation_input_tokens ?? 0))),
      cache_read: configs.map((c) => med(of(c).map((r) => tok(r).cache_read_input_tokens ?? 0))),
      output_incl_thinking: configs.map((c) => med(of(c).map((r) => tok(r).output_tokens ?? 0))),
    },
  },
  cost_per_successful_task: {
    configs,
    usd: configs.map((c) => {
      const p = of(c).filter((r) => r.pass).length;
      return p ? r2(of(c).reduce((a, r) => a + (r.cost_usd ?? 0), 0) / p, 4) : null;
    }),
    passes: configs.map((c) => of(c).filter((r) => r.pass).length),
    runs: configs.map((c) => of(c).length),
    total_cost_usd: configs.map((c) => r2(of(c).reduce((a, r) => a + (r.cost_usd ?? 0), 0), 3)),
    definition: `sum of cost over all ${Math.round(rows.length / configs.length)} runs / number of passing runs`,
  },
};

const out = path.join(path.dirname(IN), "charts.json");
fs.writeFileSync(out, JSON.stringify(charts, null, 1) + "\n");
console.log(`wrote ${path.relative(process.cwd(), out)} (${rows.length} runs, ${configs.length} configs, ${tasks.length} tasks)`);
