#!/usr/bin/env node
// Writes eval/results/report.md from runs.jsonl and the probe files: per arm vs baseline on that
// arm's tasks (success rate, median and spread of wall time, tool calls, tokens), then the probe
// summaries. Numbers only.
//
//   node eval/report.mjs [--runs eval/results/runs.jsonl] [--out eval/results/report.md]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TASKS } from "./tasks.mjs";

const EVAL = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const RUNS = opt("runs", path.join(EVAL, "results/runs.jsonl"));
const OUT = opt("out", path.join(EVAL, "results/report.md"));
const STRIP = opt("strip", path.join(EVAL, "results/probe-strip.json"));
const A11Y = opt("a11y", path.join(EVAL, "results/probe-a11y.json"));
const PLANNED_RUNS = Number(opt("planned-runs", 3));

const rows = fs.existsSync(RUNS)
  ? fs.readFileSync(RUNS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : [];

// ---- stats ---------------------------------------------------------------------------------

const sorted = (xs) => xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
function quantile(xs, q) {
  const s = sorted(xs);
  if (!s.length) return NaN;
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo);
}
const median = (xs) => quantile(xs, 0.5);
const fmt = (x, d = 0) => (Number.isFinite(x) ? x.toFixed(d) : "–");
const k = (x) => (Number.isFinite(x) ? (x >= 10_000 ? `${(x / 1000).toFixed(0)}k` : x >= 1000 ? `${(x / 1000).toFixed(1)}k` : x.toFixed(0)) : "–");
// "median [min–max]"
const spread = (xs, f = (v) => fmt(v)) => {
  const s = sorted(xs);
  return s.length ? `${f(median(s))} [${f(s[0])}–${f(s[s.length - 1])}]` : "–";
};
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(0)}% (${a}/${b})` : "–");
const ratio = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && b ? (a / b).toFixed(2) : "–");

// Tokens across all models (sub-agents included); falls back to the main session's usage.
const tok = (r) => r.tokens_all_models ?? r.usage ?? {};
const inputTokens = (r) => {
  const t = tok(r);
  return (t.input_tokens ?? 0) + (t.cache_creation_input_tokens ?? 0) + (t.cache_read_input_tokens ?? 0);
};
const outputTokens = (r) => tok(r).output_tokens ?? NaN;
const uncachedTokens = (r) => {
  const t = tok(r);
  return (t.input_tokens ?? 0) + (t.cache_creation_input_tokens ?? 0);
};

const METRICS = [
  ["wall time (s)", (r) => r.wall_ms / 1000, (v) => fmt(v, 1)],
  ["tool calls", (r) => r.tool_calls, (v) => fmt(v)],
  ["screenshots", (r) => r.screenshots, (v) => fmt(v)],
  ["turns", (r) => r.turns, (v) => fmt(v)],
  ["input tokens (incl. cache)", inputTokens, k],
  ["uncached input tokens", uncachedTokens, k],
  ["output tokens", outputTokens, k],
  ["tool result chars", (r) => r.tool_result_chars, k],
  ["cost (USD)", (r) => r.cost_usd, (v) => fmt(v, 3)],
];

function armTable(arm, taskIds) {
  const lines = [];
  const base = rows.filter((r) => r.arm === "baseline" && taskIds.includes(r.task));
  const test = rows.filter((r) => r.arm === arm && taskIds.includes(r.task));
  lines.push(`| metric | baseline | ${arm} | ${arm} / baseline (medians) |`, "| --- | --- | --- | --- |");
  lines.push(`| runs | ${base.length} | ${test.length} | |`);
  lines.push(`| success | ${pct(base.filter((r) => r.pass).length, base.length)} | ${pct(test.filter((r) => r.pass).length, test.length)} | |`);
  for (const [name, fn, f] of METRICS) {
    const b = base.map(fn);
    const t = test.map(fn);
    lines.push(`| ${name} | ${spread(b, f)} | ${spread(t, f)} | ${ratio(median(t), median(b))} |`);
  }
  lines.push("", "Per task (median [min–max]; success):", "");
  lines.push(`| task | arm | runs | success | wall s | tool calls | input tok | output tok | tool result chars |`, "| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const id of taskIds) {
    for (const a of ["baseline", arm]) {
      const rs = rows.filter((r) => r.task === id && r.arm === a);
      lines.push(
        `| ${id} | ${a} | ${rs.length} | ${pct(rs.filter((r) => r.pass).length, rs.length)} | ${spread(rs.map((r) => r.wall_ms / 1000), (v) => fmt(v, 1))} | ${spread(rs.map((r) => r.tool_calls))} | ${spread(rs.map(inputTokens), k)} | ${spread(rs.map(outputTokens), k)} | ${spread(rs.map((r) => r.tool_result_chars), k)} |`,
      );
    }
  }
  return lines.join("\n");
}

function toolMix(arm, taskIds) {
  const rs = rows.filter((r) => r.arm === arm && taskIds.includes(r.task));
  const totals = {};
  for (const r of rs) for (const [t, n] of Object.entries(r.tool_calls_by_tool ?? {})) totals[t] = (totals[t] ?? 0) + n;
  const list = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  return list.length ? list.map(([t, n]) => `${t.replace("mcp__firefox__", "")} ${n}`).join(", ") : "–";
}

// ---- report --------------------------------------------------------------------------------

const out = [];
out.push("# Eval report", "", `Generated ${new Date().toISOString()} from \`${path.relative(EVAL, RUNS)}\` (${rows.length} runs).`, "");
out.push("Tokens are summed over every model in a run (sub-agents included). \"Input tokens (incl. cache)\" is input + cache writes + cache reads. Spread is [min–max]. Tool result chars is the text the tools returned into the context.", "");

// Matrix progress.
const cells = [];
for (const t of TASKS) for (const arm of ["baseline", ...t.arms]) cells.push({ task: t.id, arm });
out.push("## Matrix", "", "| task | kind | arm | runs | pass | errors |", "| --- | --- | --- | --- | --- | --- |");
for (const c of cells) {
  const rs = rows.filter((r) => r.task === c.task && r.arm === c.arm);
  const t = TASKS.find((x) => x.id === c.task);
  const errs = rs.flatMap((r) => r.errors ?? []).filter(Boolean);
  out.push(`| ${c.task} | ${t.kind} | ${c.arm} | ${rs.length}/${PLANNED_RUNS} | ${rs.filter((r) => r.pass).length} | ${errs.length ? [...new Set(errs.map((e) => e.slice(0, 40)))].join("; ") : ""} |`);
}
out.push("");

for (const arm of ["strip", "data", "fanout"]) {
  const taskIds = TASKS.filter((t) => t.arms.includes(arm)).map((t) => t.id);
  out.push(`## ${arm} vs baseline`, "", `Tasks: ${taskIds.join(", ")}`, "", armTable(arm, taskIds), "");
  out.push(`Tool calls by tool, baseline: ${toolMix("baseline", taskIds)}`, "", `Tool calls by tool, ${arm}: ${toolMix(arm, taskIds)}`, "");
  if (arm === "fanout") {
    const rs = rows.filter((r) => r.arm === arm);
    out.push(`Sub-agent tool calls per run: ${spread(rs.map((r) => r.subagent_tool_calls))}`, "");
  }
}

out.push("## Baseline, all tasks", "", "| task | runs | success | wall s | tool calls | screenshots | input tok | output tok |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
for (const t of TASKS) {
  const rs = rows.filter((r) => r.task === t.id && r.arm === "baseline");
  out.push(`| ${t.id} | ${rs.length} | ${pct(rs.filter((r) => r.pass).length, rs.length)} | ${spread(rs.map((r) => r.wall_ms / 1000), (v) => fmt(v, 1))} | ${spread(rs.map((r) => r.tool_calls))} | ${spread(rs.map((r) => r.screenshots))} | ${spread(rs.map(inputTokens), k)} | ${spread(rs.map(outputTokens), k)} |`);
}
out.push("");

// Failed fields, to see what went wrong.
const failed = rows.filter((r) => !r.pass);
if (failed.length) {
  out.push("## Failed runs", "", "| task | arm | run | failed fields | errors |", "| --- | --- | --- | --- | --- |");
  for (const r of failed) {
    const bad = Object.entries(r.fields ?? {}).filter(([, ok]) => !ok).map(([f]) => f);
    out.push(`| ${r.task} | ${r.arm} | ${r.run} | ${bad.join(", ") || "–"} | ${(r.errors ?? []).join("; ").slice(0, 120)} |`);
  }
  out.push("");
}
const keyDrift = rows.filter((r) => r.key_source === "live" && r.pass_static_key === false && r.pass);
if (keyDrift.length) out.push(`Runs that pass the live key but not the static key (the site changed since 2026-09-29): ${keyDrift.length}`, "");

// ---- strip probe ---------------------------------------------------------------------------

if (fs.existsSync(STRIP)) {
  const d = JSON.parse(fs.readFileSync(STRIP, "utf8"));
  const rs = Object.values(d.rows).filter((r) => !r.error);
  const errs = Object.values(d.rows).filter((r) => r.error);
  out.push("## Strip probe (get_page_text vs reader view)", "");
  out.push(`${rs.length} URLs measured, ${errs.length} errors. Tokens = chars / 4. Reader = Readability.js (the library behind Firefox Reader View) injected into the page; arm = the snippet the strip arm's agents run (Readability via import, DOM fallback under strict CSP). Paragraph recall = share of the page's visible paragraphs of 120+ chars (inside article/main when present) whose first 100 chars appear in the text; number recall = share of multi-digit numbers from those paragraphs that appear.`, "");
  const allFacts = (col) => rs.flatMap((r) => r[col].facts ?? []);
  out.push("| | page_text | reader | arm |", "| --- | --- | --- | --- |");
  out.push(`| tokens, median [min–max] | ${spread(rs.map((r) => r.page_text.tokens), k)} | ${spread(rs.map((r) => r.reader.tokens), k)} | ${spread(rs.map((r) => r.arm.tokens), k)} |`);
  out.push(`| tokens / page_text, median [min–max] | 1 | ${spread(rs.map((r) => r.reader.token_ratio), (v) => fmt(v, 2))} | ${spread(rs.map((r) => r.arm.token_ratio), (v) => fmt(v, 2))} |`);
  out.push(`| URLs at ≤ 0.67 of page_text tokens | | ${pct(rs.filter((r) => r.reader.token_ratio <= 0.67).length, rs.length)} | ${pct(rs.filter((r) => r.arm.token_ratio <= 0.67).length, rs.length)} |`);
  out.push(`| paragraph recall, median [min–max] | ${spread(rs.map((r) => r.page_text.para_recall), (v) => fmt(v, 2))} | ${spread(rs.map((r) => r.reader.para_recall), (v) => fmt(v, 2))} | ${spread(rs.map((r) => r.arm.para_recall), (v) => fmt(v, 2))} |`);
  out.push(`| URLs with paragraph recall < 0.9 | ${rs.filter((r) => r.page_text.para_recall < 0.9).length} | ${rs.filter((r) => r.reader.para_recall < 0.9).length} | ${rs.filter((r) => r.arm.para_recall < 0.9).length} |`);
  out.push(`| number recall, median [min–max] | ${spread(rs.map((r) => r.page_text.num_recall), (v) => fmt(v, 2))} | ${spread(rs.map((r) => r.reader.num_recall), (v) => fmt(v, 2))} | ${spread(rs.map((r) => r.arm.num_recall), (v) => fmt(v, 2))} |`);
  out.push(`| answer-key facts found | ${pct(allFacts("page_text").filter(Boolean).length, allFacts("page_text").length)} | ${pct(allFacts("reader").filter(Boolean).length, allFacts("reader").length)} | ${pct(allFacts("arm").filter(Boolean).length, allFacts("arm").length)} |`);
  out.push(`| arm used Readability / fallback / error | | | ${rs.filter((r) => r.arm.via === "readability").length} / ${rs.filter((r) => r.arm.via === "fallback").length} / ${rs.filter((r) => r.arm.via === "error").length} |`);
  out.push("", "| URL | page_text tok | reader tok | ratio | reader para | reader num | arm via | arm tok | arm para | consent words |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const r of rs) {
    out.push(`| ${r.url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 60)} | ${k(r.page_text.tokens)} | ${k(r.reader.tokens)} | ${fmt(r.reader.token_ratio, 2)} | ${fmt(r.reader.para_recall, 2)} | ${fmt(r.reader.num_recall, 2)} | ${r.arm.via} | ${k(r.arm.tokens)} | ${fmt(r.arm.para_recall, 2)} | ${r.reference.consent_words ? "yes" : ""} |`);
  }
  for (const r of errs) out.push(`| ${r.url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 60)} | error: ${r.error.slice(0, 80)} | | | | | | | | |`);
  out.push("");
}

// ---- a11y probe ----------------------------------------------------------------------------

if (fs.existsSync(A11Y)) {
  const d = JSON.parse(fs.readFileSync(A11Y, "utf8"));
  const rs = Object.values(d.rows).filter((r) => !r.error);
  const errs = Object.values(d.rows).filter((r) => r.error);
  out.push("## Accessibility probe (JS inventory vs read_page)", "");
  out.push(`${rs.length} pages measured, ${errs.length} errors. Inventory = visible links, buttons, inputs, selects, textareas, role=<interactive>, contenteditable, tabindex≥0 and onclick elements in the top document, open shadow roots and same-origin frames (closed shadow roots are invisible to page script; read_page sees them). Cross-origin frames are counted with their size; the larger visible ones (≤4 per page) were opened on their own URL and inventoried, as an estimate of what's inside. read_page = filter "interactive". Empty name = entry without a quoted name; bare tag = entry shown as a tag (div, span...) because it has onclick/tabindex/contenteditable but no role. Heuristic name (inventory) = name only from title/placeholder or from text of an element whose role doesn't take its name from content.`, "");
  const sum = (f) => rs.reduce((s, r) => s + (f(r) ?? 0), 0);
  out.push("| | total over pages |", "| --- | --- |");
  out.push(`| inventory elements (top document) | ${sum((r) => r.inventory.top_document)} |`);
  out.push(`| inventory elements in same-origin frames | ${sum((r) => r.inventory.same_origin_frame_elements)} |`);
  out.push(`| read_page entries | ${sum((r) => r.read_page.entries)} |`);
  out.push(`| read_page entries with empty name | ${sum((r) => r.read_page.empty_name)} (${fmt((100 * sum((r) => r.read_page.empty_name)) / sum((r) => r.read_page.entries), 1)}%) |`);
  out.push(`| read_page bare-tag entries | ${sum((r) => r.read_page.generic_tag)} |`);
  out.push(`| inventory names: proper / heuristic / empty | ${sum((r) => r.inventory.names.proper)} / ${sum((r) => r.inventory.names.heuristic)} / ${sum((r) => r.inventory.names.empty)} |`);
  out.push(`| cross-origin frames (visible) | ${sum((r) => r.cross_origin_frames.count)} (${sum((r) => r.cross_origin_frames.visible)}) |`);
  out.push(`| interactive elements inside opened cross-origin frames | ${sum((r) => r.cross_origin_frames.interactive_inside_opened)} |`);
  out.push(`| pages where read_page hit the default 50k cap | ${rs.filter((r) => r.read_page.truncated_at_default_cap).length} |`);
  out.push(`| missed estimate (top-doc gap + same-origin frames + inside cross-origin frames) | ${sum((r) => r.gap.missed_estimate)} |`);
  out.push("", "By page type:", "", "| type | pages | inventory | read_page | empty names | xo frames visible | inside xo frames | same-origin frame els | missed est. |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const tag of [...new Set(rs.map((r) => r.tag))]) {
    const g = rs.filter((r) => r.tag === tag);
    const s = (f) => g.reduce((a, r) => a + (f(r) ?? 0), 0);
    out.push(`| ${tag} | ${g.length} | ${s((r) => r.inventory.total)} | ${s((r) => r.read_page.entries)} | ${s((r) => r.read_page.empty_name)} | ${s((r) => r.cross_origin_frames.visible)} | ${s((r) => r.cross_origin_frames.interactive_inside_opened)} | ${s((r) => r.inventory.same_origin_frame_elements)} | ${s((r) => r.gap.missed_estimate)} |`);
  }
  out.push("", "Output sizes (read_page):", "", `- interactive, uncapped: ${spread(rs.map((r) => r.read_page.tokens_interactive_uncapped), k)} tokens per page`, `- all (default cap): ${spread(rs.map((r) => r.read_page.tokens_all_default), k)} tokens per page`, "");
  out.push("| page | type | inventory (frames) | read_page | empty | bare | xo frames (vis) | xo hosts | inside | read_page int. tok | read_page all tok |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const r of rs) {
    out.push(`| ${r.url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 50)} | ${r.tag} | ${r.inventory.total} (${r.inventory.same_origin_frame_elements}) | ${r.read_page.entries} | ${r.read_page.empty_name} | ${r.read_page.generic_tag} | ${r.cross_origin_frames.count} (${r.cross_origin_frames.visible}) | ${r.cross_origin_frames.hosts.slice(0, 3).join(" ")} | ${r.cross_origin_frames.interactive_inside_opened} | ${k(r.read_page.tokens_interactive_uncapped)} | ${k(r.read_page.tokens_all_default)} |`);
  }
  for (const r of errs) out.push(`| ${r.url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 50)} | ${r.tag} | error: ${r.error.slice(0, 80)} | | | | | | | | |`);
  out.push("");
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, out.join("\n"));
console.log(`wrote ${path.relative(process.cwd(), OUT)} (${rows.length} runs)`);
