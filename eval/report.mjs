#!/usr/bin/env node
// Writes eval/results/report.md from runs.jsonl and the probe files: per arm vs baseline on that
// arm's tasks (success rate, median and spread of wall time, tool calls, tokens), then the probe
// summaries, then Firefox vs Claude in Chrome on the baseline arm (from browsers.jsonl). Numbers
// only.
//
//   node eval/report.mjs [--runs eval/results/runs.jsonl] [--compare eval/results/browsers.jsonl]
//                        [--after eval/results/browsers-after.jsonl] [--devtools eval/results/browsers-devtools.jsonl]
//                        [--after2 eval/results/browsers-after-2.jsonl]
//                        [--out eval/results/report.md]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { shortTool } from "./lib/trace.mjs";
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
const COMPARE = opt("compare", path.join(EVAL, "results/browsers.jsonl"));

const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const browserOf = (r) => r.browser ?? "firefox";
const allRows = readJsonl(RUNS);
// The arm sections are about the Firefox tools; Chrome rows only feed the browser comparison.
const rows = allRows.filter((r) => browserOf(r) === "firefox");
// Browser comparison: the dedicated file when it exists (both browsers run in the same chunks),
// plus any Chrome rows in the runs file with their Firefox counterparts.
const compareRows = fs.existsSync(COMPARE) ? readJsonl(COMPARE) : allRows.some((r) => browserOf(r) === "chrome") ? allRows : [];

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
// The speed-idea matrix; the general tasks (no arms) are only in the browser comparison.
for (const t of TASKS.filter((x) => x.arms.length)) for (const arm of ["baseline", ...t.arms]) cells.push({ task: t.id, arm });
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
for (const t of TASKS.filter((x) => x.arms.length)) {
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

// ---- browser comparison --------------------------------------------------------------------

function browserSection(rs) {
  const lines = [];
  const B = ["firefox", "chrome"];
  const base = rs.filter((r) => r.arm === "baseline");
  const tasksBoth = TASKS.map((t) => t.id).filter((id) => B.every((b) => base.some((r) => r.task === id && browserOf(r) === b)));
  const of = (b, ids = tasksBoth) => base.filter((r) => browserOf(r) === b && ids.includes(r.task));
  const shots = (r) => r.screenshot_actions ?? r.screenshots;
  const images = (r) => r.images_returned ?? r.tool_result_images;
  const kb = (r) => Object.values(r.tool_stats_by_tool ?? {}).reduce((s, x) => s + x.result_bytes, 0) / 1024;
  const M = [
    ["wall time (s)", (r) => r.wall_ms / 1000, (v) => fmt(v, 1)],
    ["tool calls", (r) => r.tool_calls, (v) => fmt(v)],
    ["screenshot/zoom actions", shots, (v) => fmt(v)],
    ["images returned to the model", images, (v) => fmt(v)],
    ["turns", (r) => r.turns, (v) => fmt(v)],
    ["input tokens (incl. cache)", inputTokens, k],
    ["uncached input tokens", uncachedTokens, k],
    ["output tokens", outputTokens, k],
    ["tool result KB (text + images)", kb, (v) => fmt(v, 1)],
    ["cost (USD)", (r) => r.cost_usd, (v) => fmt(v, 3)],
  ];
  lines.push("## Browser comparison: Firefox tools vs Claude in Chrome (baseline arm)", "");
  lines.push(
    `Source: \`${path.relative(EVAL, fs.existsSync(COMPARE) ? COMPARE : RUNS)}\`. Same tasks, model and prompt (the prompt names "the Firefox browser tools" or "the Chrome browser tools"); Firefox runs get only the mcp__firefox__* tools, Chrome runs only mcp__claude-in-chrome__* (\`claude -p --chrome\` with an empty strict MCP config). Tools are compared by name without the server prefix. Tasks in the tables: those with runs in both browsers (${tasksBoth.length}).`,
    "",
    "**Known confounds.** Claude in Chrome's `find` calls a model server-side to match elements; those tokens and that cost don't appear in these counts, so Chrome's token and cost numbers are a lower bound whenever it uses `find` (its time is included in wall time and in `find`'s per-call time). Claude in Chrome also offers tools the Firefox server doesn't have (browser_batch, gif_creator, console/network readers, shortcuts, resize_window, upload_image, browser selection), and its `scroll` returns a screenshot, so compare \"images returned\" as well as screenshot actions. Chrome needs its window visible for screenshots; Firefox tabs run in the background.",
    "",
  );
  if (!tasksBoth.length) return [...lines, "No task has baseline runs in both browsers yet.", ""].join("\n");
  lines.push("### Overall", "", "| metric | firefox | chrome | chrome / firefox (medians) |", "| --- | --- | --- | --- |");
  const f = of("firefox");
  const c = of("chrome");
  lines.push(`| runs | ${f.length} | ${c.length} | |`);
  lines.push(`| success | ${pct(f.filter((r) => r.pass).length, f.length)} | ${pct(c.filter((r) => r.pass).length, c.length)} | |`);
  for (const [name, fn, fm] of M) lines.push(`| ${name} | ${spread(f.map(fn), fm)} | ${spread(c.map(fn), fm)} | ${ratio(median(c.map(fn)), median(f.map(fn)))} |`);
  lines.push("", "Median [min–max] per run.", "");

  lines.push("### Per task", "", "| task | browser | runs | success | wall s | tool calls | shots | images | input tok | output tok | tool result KB |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const id of tasksBoth)
    for (const b of B) {
      const x = of(b, [id]);
      lines.push(`| ${id} | ${b} | ${x.length} | ${pct(x.filter((r) => r.pass).length, x.length)} | ${spread(x.map((r) => r.wall_ms / 1000), (v) => fmt(v, 1))} | ${spread(x.map((r) => r.tool_calls))} | ${spread(x.map(shots))} | ${spread(x.map(images))} | ${spread(x.map(inputTokens), k)} | ${spread(x.map(outputTokens), k)} | ${spread(x.map(kb), (v) => fmt(v, 1))} |`);
    }
  lines.push("");

  // By tool: totals over runs, divided by the number of runs of that browser.
  const byTool = (x) => {
    const out = {};
    for (const r of x) {
      const stats = r.tool_stats_by_tool;
      if (stats) for (const [t, s] of Object.entries(stats)) {
        const o = (out[t] ??= { calls: 0, bytes: 0, images: 0, ms: 0, errors: 0 });
        o.calls += s.calls;
        o.bytes += s.result_bytes;
        o.images += s.images;
        o.ms += s.ms;
        o.errors += s.errors;
      }
      else for (const [t, n] of Object.entries(r.tool_calls_by_tool ?? {})) (out[shortTool(t)] ??= { calls: 0, bytes: NaN, images: NaN, ms: NaN, errors: NaN }).calls += n;
    }
    return out;
  };
  const tf = byTool(f);
  const tc = byTool(c);
  const tools = [...new Set([...Object.keys(tf), ...Object.keys(tc)])].sort((a, b) => ((tc[b]?.calls ?? 0) + (tf[b]?.calls ?? 0)) - ((tc[a]?.calls ?? 0) + (tf[a]?.calls ?? 0)));
  const per = (o, key, n) => (o ? o[key] / n : 0);
  lines.push("### By tool (all tasks above)", "", "Calls, KB and images are per run (total / runs of that browser); ms is the mean per call, from the tool_use event to its tool_result on the stream.", "");
  lines.push("| tool | ff calls | chrome calls | ff KB | chrome KB | ff images | chrome images | ff ms/call | chrome ms/call | ff errors | chrome errors |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const t of tools) {
    const a = tf[t];
    const b = tc[t];
    lines.push(`| ${t} | ${fmt(per(a, "calls", f.length), 1)} | ${fmt(per(b, "calls", c.length), 1)} | ${fmt(per(a, "bytes", f.length) / 1024, 1)} | ${fmt(per(b, "bytes", c.length) / 1024, 1)} | ${fmt(per(a, "images", f.length), 1)} | ${fmt(per(b, "images", c.length), 1)} | ${a?.calls ? fmt(a.ms / a.calls) : "–"} | ${b?.calls ? fmt(b.ms / b.calls) : "–"} | ${a ? fmt(a.errors) : "–"} | ${b ? fmt(b.errors) : "–"} |`);
  }
  lines.push("");

  lines.push("### Tool mix per task", "", "| task | firefox (calls over all runs) | chrome (calls over all runs) |", "| --- | --- | --- |");
  const mix = (x) => {
    const o = byTool(x);
    return Object.entries(o).sort((p, q) => q[1].calls - p[1].calls).map(([t, v]) => `${t} ${v.calls}`).join(", ") || "–";
  };
  for (const id of tasksBoth) lines.push(`| ${id} | ${mix(of("firefox", [id]))} | ${mix(of("chrome", [id]))} |`);
  lines.push("");

  const failedB = base.filter((r) => !r.pass && tasksBoth.includes(r.task));
  if (failedB.length) {
    lines.push("### Failed runs", "", "| task | browser | run | failed fields | errors | trace |", "| --- | --- | --- | --- | --- | --- |");
    for (const r of failedB) {
      const bad = Object.entries(r.fields ?? {}).filter(([, ok]) => !ok).map(([x]) => x);
      lines.push(`| ${r.task} | ${browserOf(r)} | ${r.run} | ${bad.join(", ") || "–"} | ${(r.errors ?? []).join("; ").slice(0, 120)} | ${r.trace_file ?? ""} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

if (compareRows.length) out.push(browserSection(compareRows));

// ---- re-measure after restart, and devtools on vs off ---------------------------------------

const traceOf = (r) => {
  const f = r.trace_file && path.join(EVAL, r.trace_file);
  return f && fs.existsSync(f) ? readJsonl(f) : [];
};
const kbOf = (r) => Object.values(r.tool_stats_by_tool ?? {}).reduce((s, x) => s + x.result_bytes, 0) / 1024;
const RUN_METRICS = [
  ["wall time (s)", (r) => r.wall_ms / 1000, (v) => fmt(v, 1)],
  ["tool calls", (r) => r.tool_calls, (v) => fmt(v)],
  ["screenshot/zoom actions", (r) => r.screenshot_actions ?? r.screenshots, (v) => fmt(v)],
  ["turns", (r) => r.turns, (v) => fmt(v)],
  ["input tokens (incl. cache)", inputTokens, k],
  ["uncached input tokens", uncachedTokens, k],
  ["output tokens", outputTokens, k],
  ["tool result KB (text + images)", kbOf, (v) => fmt(v, 1)],
  ["cost (USD)", (r) => r.cost_usd, (v) => fmt(v, 3)],
];
const sum = (xs) => xs.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);

// Columns: [label, rows]. Overall medians, then per task "wall s / calls / input tok", then the
// per-call facts the restart was meant to move.
function compareSets(cols, { ratioOf, taskIds }) {
  const lines = [];
  lines.push(`| metric | ${cols.map(([l]) => l).join(" | ")} | ${ratioOf ? `${cols[ratioOf[0]][0]} / ${cols[ratioOf[1]][0]} (medians)` : ""} |`, `| --- | ${cols.map(() => "---").join(" | ")} | --- |`);
  lines.push(`| runs | ${cols.map(([, rs]) => rs.length).join(" | ")} | |`);
  lines.push(`| success | ${cols.map(([, rs]) => pct(rs.filter((r) => r.pass).length, rs.length)).join(" | ")} | |`);
  for (const [name, fn, f] of RUN_METRICS) {
    const r = ratioOf ? ratio(median(cols[ratioOf[0]][1].map(fn)), median(cols[ratioOf[1]][1].map(fn))) : "";
    lines.push(`| ${name} | ${cols.map(([, rs]) => spread(rs.map(fn), f)).join(" | ")} | ${r} |`);
  }
  lines.push(`| total wall time, all runs (min) | ${cols.map(([, rs]) => fmt(sum(rs.map((r) => r.wall_ms)) / 60000, 1)).join(" | ")} | |`);
  lines.push(`| total tool calls, all runs | ${cols.map(([, rs]) => sum(rs.map((r) => r.tool_calls))).join(" | ")} | |`);
  lines.push(`| total cost, all runs (USD) | ${cols.map(([, rs]) => fmt(sum(rs.map((r) => r.cost_usd)), 2)).join(" | ")} | |`);
  lines.push("", "Median [min–max] per run.", "");
  lines.push("Per task: median wall s / tool calls / input tokens, and success.", "");
  lines.push(`| task | ${cols.map(([l]) => l).join(" | ")} |`, `| --- | ${cols.map(() => "---").join(" | ")} |`);
  for (const id of taskIds) {
    const cell = (rs) => {
      const x = rs.filter((r) => r.task === id);
      return x.length ? `${fmt(median(x.map((r) => r.wall_ms / 1000)), 1)}s / ${fmt(median(x.map((r) => r.tool_calls)))} / ${k(median(x.map(inputTokens)))} (${x.filter((r) => r.pass).length}/${x.length})` : "–";
    };
    lines.push(`| ${id} | ${cols.map(([, rs]) => cell(rs)).join(" | ")} |`);
  }
  lines.push("");
  return lines.join("\n");
}

// Facts from the per-call traces: click time, find size, pres-shell errors, tools not offered.
function callFacts(cols) {
  const lines = [];
  const facts = cols.map(([l, rs]) => {
    const calls = rs.flatMap(traceOf);
    const clicks = calls.filter((c) => c.short === "computer" && c.action === "left_click").map((c) => c.ms);
    const finds = calls.filter((c) => c.short === "find").map((c) => c.text_bytes);
    const scrolls = calls.filter((c) => c.short === "computer" && c.action === "scroll");
    // Older traces have no result text; their rows keep up to 5 error texts per run.
    const nsTrace = calls.filter((c) => /NS_ERROR_UNEXPECTED/.test(c.text_head ?? "")).length;
    const nsRows = sum(rs.map((r) => (r.error_samples ?? []).filter((e) => /NS_ERROR_UNEXPECTED/.test(e)).length));
    const hasHeads = calls.some((c) => "text_head" in c);
    const notOffered = {};
    for (const r of rs)
      for (const [t, n] of Object.entries(r.tool_calls_by_tool ?? {}))
        if (r.tools_available && !r.tools_available.includes(t) && t !== "Agent") notOffered[shortTool(t)] = (notOffered[shortTool(t)] ?? 0) + n;
    const byTool = {};
    for (const c of calls) (byTool[c.short] ??= []).push(c);
    return { l, rs, clicks, finds, scrolls, ns: hasHeads ? String(nsTrace) : `≥${nsRows}`, notOffered, byTool, errors: calls.filter((c) => c.is_error).length };
  });
  lines.push(`| per call | ${facts.map((f) => f.l).join(" | ")} |`, `| --- | ${facts.map(() => "---").join(" | ")} |`);
  lines.push(`| computer left_click ms, median [min–max] | ${facts.map((f) => `${spread(f.clicks)} (${f.clicks.length} clicks)`).join(" | ")} |`);
  lines.push(`| find result bytes, median [min–max] | ${facts.map((f) => `${spread(f.finds)} (${f.finds.length} calls)`).join(" | ")} |`);
  lines.push(`| computer scroll actions (errors) | ${facts.map((f) => `${f.scrolls.length} (${f.scrolls.filter((c) => c.is_error).length})`).join(" | ")} |`);
  // Traces from before msg_calls existed can't tell a call issued alone from one queued behind a
  // navigate in the same message.
  const alone = (f, tool) => {
    const cs = (f.byTool[tool] ?? []).filter((c) => c.msg_calls === 1);
    return (f.byTool[tool] ?? []).some((c) => "msg_calls" in c) ? `${cs.length ? fmt(sum(cs.map((c) => c.ms)) / cs.length) : "–"} (${cs.length} of ${f.byTool[tool].length})` : "not recorded";
  };
  lines.push(`| get_page_text mean ms, issued alone | ${facts.map((f) => alone(f, "get_page_text")).join(" | ")} |`);
  lines.push(`| find mean ms, issued alone | ${facts.map((f) => alone(f, "find")).join(" | ")} |`);
  lines.push(`| NS_ERROR_UNEXPECTED results | ${facts.map((f) => f.ns).join(" | ")} |`);
  lines.push(`| tool errors, all calls | ${facts.map((f) => f.errors).join(" | ")} |`);
  lines.push(`| calls to tools not offered | ${facts.map((f) => Object.entries(f.notOffered).map(([t, n]) => `${t} ${n}`).join(", ") || "0").join(" | ")} |`);
  lines.push("", "NS_ERROR_UNEXPECTED: a count from the traces' result text where the trace has it; \"≥n\" counts the error samples a row keeps (at most 5 per run), so it's a lower bound.", "");
  const tools = [...new Set(facts.flatMap((f) => Object.keys(f.byTool)))].sort((a, b) => sum(facts.map((f) => f.byTool[b]?.length ?? 0)) - sum(facts.map((f) => f.byTool[a]?.length ?? 0)));
  lines.push("By tool: calls per run, and mean ms per call. A call issued in the same message as a navigate waits for it, so its ms includes the page load; the after runs did that more often (navigate then get_page_text or find in one turn), which is why those two look slower per call here and not in the issued-alone rows above.", "");
  lines.push(`| tool | ${facts.map((f) => `${f.l} calls`).join(" | ")} | ${facts.map((f) => `${f.l} ms`).join(" | ")} |`, `| --- | ${facts.map(() => "---").join(" | ")} | ${facts.map(() => "---").join(" | ")} |`);
  for (const t of tools)
    lines.push(`| ${t} | ${facts.map((f) => fmt((f.byTool[t]?.length ?? 0) / f.rs.length, 2)).join(" | ")} | ${facts.map((f) => (f.byTool[t] ? fmt(sum(f.byTool[t].map((c) => c.ms)) / f.byTool[t].length) : "–")).join(" | ")} |`);
  lines.push("");
  return lines.join("\n");
}

const AFTER = opt("after", path.join(EVAL, "results/browsers-after.jsonl"));
const DEVTOOLS = opt("devtools", path.join(EVAL, "results/browsers-devtools.jsonl"));
const afterRows = readJsonl(AFTER).filter((r) => browserOf(r) === "firefox" && r.arm === "baseline");
const devtoolsRows = readJsonl(DEVTOOLS).filter((r) => browserOf(r) === "firefox" && r.arm === "baseline");
const beforeRows = compareRows.filter((r) => browserOf(r) === "firefox" && r.arm === "baseline");
const chromeRows = compareRows.filter((r) => browserOf(r) === "chrome" && r.arm === "baseline");

if (afterRows.length) {
  const ids = TASKS.map((t) => t.id).filter((id) => afterRows.some((r) => r.task === id));
  const cols = [["firefox before", beforeRows.filter((r) => ids.includes(r.task))], ["firefox after", afterRows], ["chrome", chromeRows.filter((r) => ids.includes(r.task))]];
  out.push("## Re-measure after restart: Firefox before, Firefox after, Chrome (baseline arm)", "");
  out.push(
    `Sources: Firefox before and Chrome are the rows in \`${path.relative(EVAL, COMPARE)}\`; Firefox after is \`${path.relative(EVAL, AFTER)}\`, the same ${ids.length} tasks, model and prompt, run again once Firefox had loaded main's extension (frames in find/read_page, keys follow the clicked frame, input fallback, click floor, trimmed find, occluded-window fix). The after runs also have everything else that landed on the MCP server since the first run: the batch tool, multi-field form_input, the tabId fill-in and the fetch hint in javascript_tool. Chrome's extension didn't change, so it wasn't run again.`,
    "",
    compareSets(cols, { ratioOf: [1, 0], taskIds: ids }),
    "### Per call",
    "",
    callFacts(cols),
  );
  const mdn = (rs) => rs.filter((r) => r.task === "gen-mdn-iframe");
  const [b, a] = [mdn(cols[0][1]), mdn(cols[1][1])];
  if (a.length) {
    const toolsUsed = (rs) => {
      const o = {};
      for (const r of rs) for (const [t, n] of Object.entries(r.tool_calls_by_tool ?? {})) o[shortTool(t)] = (o[shortTool(t)] ?? 0) + n;
      return Object.entries(o).sort((x, y) => y[1] - x[1]).map(([t, n]) => `${t} ${n}`).join(", ");
    };
    const frameRefs = (rs) => rs.filter((r) => traceOf(r).some((c) => c.short === "form_input" && /@f\d+/.test(c.args) && !c.is_error)).length;
    out.push("### gen-mdn-iframe", "", "| | firefox before | firefox after |", "| --- | --- | --- |");
    out.push(`| wall s | ${spread(b.map((r) => r.wall_ms / 1000), (v) => fmt(v, 1))} | ${spread(a.map((r) => r.wall_ms / 1000), (v) => fmt(v, 1))} |`);
    out.push(`| tool calls | ${spread(b.map((r) => r.tool_calls))} | ${spread(a.map((r) => r.tool_calls))} |`);
    out.push(`| input tokens | ${spread(b.map(inputTokens), k)} | ${spread(a.map(inputTokens), k)} |`);
    out.push(`| runs that set the select through a frame ref (form_input ref_N@fM) | ${frameRefs(b)}/${b.length} | ${frameRefs(a)}/${a.length} |`);
    out.push(`| runs that used javascript_tool | ${b.filter((r) => r.tool_calls_by_tool?.mcp__firefox__javascript_tool).length}/${b.length} | ${a.filter((r) => r.tool_calls_by_tool?.mcp__firefox__javascript_tool).length}/${a.length} |`);
    out.push(`| tools, all runs | ${toolsUsed(b)} | ${toolsUsed(a)} |`, "");
  }
}

if (devtoolsRows.length) {
  const ids = TASKS.map((t) => t.id).filter((id) => devtoolsRows.some((r) => r.task === id));
  const off = afterRows.filter((r) => ids.includes(r.task));
  const cols = [["devtools off", off], ["devtools on", devtoolsRows]];
  const dtCalls = sum(devtoolsRows.map((r) => r.tool_calls_by_tool?.mcp__firefox__devtools ?? 0));
  out.push("## devtools on vs off (Firefox, baseline arm)", "");
  out.push(
    `Sources: off is \`${path.relative(EVAL, AFTER)}\`; on is \`${path.relative(EVAL, DEVTOOLS)}\`, the same tasks with the MCP server started with FIREFOX_BRIDGE_DEVTOOLS=1 (\`run.mjs --devtools\`), run right after. With it on, the model is offered one more tool (devtools) and the extension keeps each session tab's console and network log from page load. The model called devtools ${dtCalls} time(s) in ${devtoolsRows.length} runs.`,
    "",
    compareSets(cols, { ratioOf: [1, 0], taskIds: ids }),
    "### Per call",
    "",
    callFacts(cols),
  );
}

// ---- re-measure 2: the fixes from the first re-measure, after a second restart ---------------

// What each fix was meant to change, counted from the traces.
function fixChecks(cols) {
  const lines = [`| check | ${cols.map(([l]) => l).join(" | ")} |`, `| --- | ${cols.map(() => "---").join(" | ")} |`];
  const facts = cols.map(([, rs]) => {
    let finds = 0;
    let afterFind = 0;
    const notOffered = {};
    let created = 0;
    const scrollFrame = [];
    let apiFetches = 0;
    let open = 0;
    for (const r of rs) {
      const tr = traceOf(r);
      const offered = new Set(r.tools_available ?? []);
      let closed = false;
      tr.forEach((c, i) => {
        if (c.short === "find") finds++;
        if (offered.size && !offered.has(c.tool) && c.tool !== "Agent") {
          notOffered[shortTool(c.tool)] = (notOffered[shortTool(c.tool)] ?? 0) + 1;
          if (tr[i - 1]?.short === "find") afterFind++;
        }
        if (/^Created tab \d+/.test(c.text_head ?? "")) created++;
        if (c.short === "computer" && c.action === "scroll_to" && /@f\d+/.test(c.args)) scrollFrame.push((c.text_head ?? "").match(/\((-?\d+), (-?\d+)\)/)?.[0] ?? "?");
        const text = `${c.args ?? ""} ${JSON.stringify(c.batch_actions ?? "")}`;
        if (r.task.startsWith("data-") && (c.short === "javascript_tool" || c.short === "batch") && /fetch\(/.test(text) && /\/api|algolia|\.json/.test(text)) apiFetches++;
        if (c.short === "tabs_close_mcp" || (c.short === "batch" && /tabs_close/.test(text))) closed = true;
      });
      if (!closed && !r.tool_calls_by_tool?.mcp__firefox__tabs_close_mcp) open++;
    }
    const hn = rs.filter((r) => r.task === "data-hn-readability");
    return { rs, finds, afterFind, notOffered, created, scrollFrame, apiFetches, open, hn };
  });
  const row = (label, fn) => lines.push(`| ${label} | ${facts.map(fn).join(" | ")} |`);
  row("calls to a tool not offered, right after a find (find calls)", (f) => `${f.afterFind} (${f.finds})`);
  row("calls to tools not offered, all", (f) => Object.entries(f.notOffered).map(([t, n]) => `${t} ${n}`).join(", ") || "0");
  row("computer scroll_to on a frame ref: the center it reported", (f) => (f.scrollFrame.length ? [...new Set(f.scrollFrame)].map((p) => `${p} x${f.scrollFrame.filter((q) => q === p).length}`).join(", ") : "–"));
  row("runs that never closed their tab", (f) => `${f.open} of ${f.rs.length}`);
  row('results that start "Created tab N"', (f) => f.created);
  row("javascript_tool fetches of an API or JSON in data tasks", (f) => f.apiFetches);
  row("data-hn-readability input tokens, median [min–max]", (f) => spread(f.hn.map(inputTokens), k));
  lines.push("");
  return lines.join("\n");
}

const AFTER2 = opt("after2", path.join(EVAL, "results/browsers-after-2.jsonl"));
const after2Rows = readJsonl(AFTER2).filter((r) => browserOf(r) === "firefox" && r.arm === "baseline");
if (after2Rows.length) {
  const ids = TASKS.map((t) => t.id).filter((id) => after2Rows.some((r) => r.task === id));
  const cols = [["firefox after", afterRows.filter((r) => ids.includes(r.task))], ["firefox after-2", after2Rows], ["chrome", chromeRows.filter((r) => ids.includes(r.task))]];
  out.push("## Re-measure 2: the re-measure's fixes, after another restart (baseline arm)", "");
  out.push(
    `Sources: Firefox after is \`${path.relative(EVAL, AFTER)}\` (the first re-measure); Firefox after-2 is \`${path.relative(EVAL, AFTER2)}\`, the same ${ids.length} tasks, model and prompt, once Firefox had restarted with main at c1ad4bb. It loads what the first re-measure's traces led to: find's header names \`computer left_click\`, scroll_to on a frame ref reports screenshot coordinates, tabs_context_mcp and navigate say "Created tab N ... close it", javascript_tool says to fetch pages rather than the site's API, computer's description says it has no separate screenshot or click tools, and typing fires change on Tab or a click away in background tabs. Chrome is the rows in \`${path.relative(EVAL, COMPARE)}\`, not run again.`,
    "",
    compareSets(cols, { ratioOf: [1, 0], taskIds: ids }),
    "### What each fix was meant to change",
    "",
    fixChecks(cols.slice(0, 2)),
    "### Per call",
    "",
    callFacts(cols),
  );
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, out.join("\n"));
console.log(`wrote ${path.relative(process.cwd(), OUT)} (${rows.length} Firefox arm runs, ${compareRows.length} browser comparison runs)`);
