#!/usr/bin/env node
// Runs the eval matrix (task x arm x run#) with `claude -p`, one fresh session per run, and
// appends one JSON line per finished run to eval/results/runs.jsonl. Resumable and chunked:
// each invocation runs pending cells until --max-minutes is used up, then exits; run it again
// to continue.
//
//   node eval/run.mjs [--max-minutes 8] [--concurrency 3] [--runs 3] [--model claude-sonnet-5-5]
//                     [--tasks id,id] [--arms baseline,strip] [--out eval/results/runs.jsonl]
//                     [--run-timeout-min 7] [--dry-run]
//
// Every run's MCP config points at THIS worktree's mcp/server.mjs, so all arms see the same tools
// even if main changes.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ARM_PROMPTS, ARM_TOOLS } from "./arms.mjs";
import { lastJson } from "./lib/check.mjs";
import { TASKS } from "./tasks.mjs";

const EVAL = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(EVAL);

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const flag = (name) => argv.includes(`--${name}`);

const MAX_MIN = Number(opt("max-minutes", 8));
const CONCURRENCY = Number(opt("concurrency", 3));
const RUNS = Number(opt("runs", 3));
const MODEL = opt("model", "claude-sonnet-5-5");
const RUN_CAP_MIN = Number(opt("run-timeout-min", Math.min(7, MAX_MIN)));
const OUT = path.resolve(opt("out", path.join(EVAL, "results/runs.jsonl")));
const ONLY_TASKS = opt("tasks")?.split(",");
const ONLY_ARMS = opt("arms")?.split(",");
const CLAUDE = process.env.CLAUDE_BIN || "claude";
const DEFAULT_EXPECTED_MS = 4 * 60_000;

const t0 = Date.now();
const deadline = t0 + MAX_MIN * 60_000;
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s]`, ...a);

// ---- matrix --------------------------------------------------------------------------------

function readRuns() {
  if (!fs.existsSync(OUT)) return [];
  return fs
    .readFileSync(OUT, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

const cellKey = (c) => `${c.task}|${c.arm}|${c.run}`;

// Ordered run# first, then task, then arm, so a partial matrix stays balanced and each arm runs
// close in time to its baseline.
function allCells() {
  const cells = [];
  for (let run = 1; run <= RUNS; run++)
    for (const t of TASKS) {
      if (ONLY_TASKS && !ONLY_TASKS.includes(t.id)) continue;
      for (const arm of ["baseline", ...t.arms]) {
        if (ONLY_ARMS && !ONLY_ARMS.includes(arm)) continue;
        cells.push({ task: t.id, arm, run });
      }
    }
  return cells;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};

// How long a cell is likely to take, from earlier runs of the same task/arm (or task).
function expectedMs(cell, done) {
  const same = done.filter((r) => r.task === cell.task && r.arm === cell.arm).map((r) => r.wall_ms);
  if (same.length) return median(same);
  const task = done.filter((r) => r.task === cell.task).map((r) => r.wall_ms);
  return task.length ? median(task) : DEFAULT_EXPECTED_MS;
}

// ---- one run -------------------------------------------------------------------------------

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fab-eval-"));
const MCP_CONFIG = path.join(TMP, "mcp.json");
fs.writeFileSync(
  MCP_CONFIG,
  JSON.stringify({ mcpServers: { firefox: { type: "stdio", command: process.execPath, args: [path.join(ROOT, "mcp/server.mjs")] } } }, null, 2),
);

// Nested `claude` refuses to start, or attaches to this session, with these set.
const STRIP_ENV = [
  "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_BRIDGE_SESSION_ID", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_CODE_EXECPATH", "CLAUDE_PID", "CLAUDE_EFFORT", "AI_AGENT",
  "FIREFOX_AGENT_BRIDGE_SESSION",
];

export function claudeArgs(task, arm) {
  const args = [
    "-p", task.prompt,
    "--output-format", "stream-json", "--verbose",
    "--model", MODEL,
    "--strict-mcp-config", "--mcp-config", MCP_CONFIG,
    "--tools", ARM_TOOLS[arm] ?? "",
    // The sub-agent tool is listed as "Task" but its tool_use blocks are named "Agent".
    "--allowedTools", ["mcp__firefox__*", ...(ARM_TOOLS[arm] ? [ARM_TOOLS[arm], "Agent"] : [])].join(","),
    "--disallowedTools", "Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch",
    "--no-session-persistence",
  ];
  if (ARM_PROMPTS[arm]) args.push("--append-system-prompt", ARM_PROMPTS[arm]);
  return args;
}

// Folds stream-json events into the per-run metrics.
function summarize(events) {
  const m = {
    session_id: null, model: null, tools_available: null,
    tool_calls: 0, tool_calls_by_tool: {}, subagent_tool_calls: 0, screenshots: 0,
    tool_errors: 0, error_samples: [], tool_result_chars: 0, tool_result_images: 0, turns: null, assistant_messages: 0,
    usage: null, model_usage: null, cost_usd: null, duration_ms: null, duration_api_ms: null,
    result_subtype: null, is_error: null, final_text: null,
  };
  for (const e of events) {
    if (e.type === "system" && e.subtype === "init") {
      m.session_id = e.session_id;
      m.model = e.model;
      m.tools_available = e.tools;
    } else if (e.type === "assistant") {
      m.assistant_messages++;
      for (const b of e.message?.content ?? []) {
        if (b.type !== "tool_use") continue;
        m.tool_calls++;
        m.tool_calls_by_tool[b.name] = (m.tool_calls_by_tool[b.name] ?? 0) + 1;
        if (e.parent_tool_use_id) m.subagent_tool_calls++;
        if (b.name === "mcp__firefox__computer" && ["screenshot", "zoom"].includes(b.input?.action)) m.screenshots++;
      }
    } else if (e.type === "user") {
      const content = e.message?.content;
      for (const b of Array.isArray(content) ? content : []) {
        if (b.type !== "tool_result") continue;
        // Size of what the tools fed back into the context (text chars, image count).
        for (const c of Array.isArray(b.content) ? b.content : [{ type: "text", text: String(b.content ?? "") }]) {
          if (c.type === "image") m.tool_result_images++;
          else m.tool_result_chars += (c.text ?? "").length;
        }
        if (b.is_error) {
          m.tool_errors++;
          const text = Array.isArray(b.content) ? b.content.map((c) => c.text ?? "").join(" ") : String(b.content ?? "");
          if (m.error_samples.length < 5) m.error_samples.push(text.slice(0, 300));
        }
      }
    } else if (e.type === "result") {
      m.turns = e.num_turns;
      m.usage = e.usage
        ? {
            input_tokens: e.usage.input_tokens ?? 0,
            output_tokens: e.usage.output_tokens ?? 0,
            cache_creation_input_tokens: e.usage.cache_creation_input_tokens ?? 0,
            cache_read_input_tokens: e.usage.cache_read_input_tokens ?? 0,
          }
        : null;
      m.model_usage = e.modelUsage ?? null;
      m.cost_usd = e.total_cost_usd ?? null;
      m.duration_ms = e.duration_ms ?? null;
      m.duration_api_ms = e.duration_api_ms ?? null;
      m.result_subtype = e.subtype;
      m.is_error = e.is_error;
      m.final_text = typeof e.result === "string" ? e.result : null;
    }
  }
  // Totals across all models (sub-agents included) from modelUsage.
  if (m.model_usage) {
    const t = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    for (const u of Object.values(m.model_usage)) {
      t.input_tokens += u.inputTokens ?? 0;
      t.output_tokens += u.outputTokens ?? 0;
      t.cache_creation_input_tokens += u.cacheCreationInputTokens ?? 0;
      t.cache_read_input_tokens += u.cacheReadInputTokens ?? 0;
    }
    m.tokens_all_models = t;
  }
  return m;
}

function runCell(cell, capMs) {
  const task = TASKS.find((t) => t.id === cell.task);
  const env = { ...process.env };
  for (const k of STRIP_ENV) delete env[k];
  const cwd = fs.mkdtempSync(path.join(TMP, `${cell.task}-${cell.arm}-${cell.run}-`));
  const started = Date.now();
  const proc = spawn(CLAUDE, claudeArgs(task, cell.arm), { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const events = [];
  let buf = "";
  let stderr = "";
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {}
    }
  });
  proc.stderr.on("data", (d) => (stderr += d));
  let killedBy = null;
  const kill = (why) => {
    if (killedBy) return;
    killedBy = why;
    proc.kill("SIGTERM");
    setTimeout(() => proc.kill("SIGKILL"), 5000).unref();
  };
  const timer = setTimeout(() => kill(capMs >= RUN_CAP_MIN * 60_000 ? "run_timeout" : "chunk_deadline"), capMs);
  return {
    proc,
    kill,
    done: new Promise((resolve) => {
      proc.on("exit", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, killedBy, events, stderr, wall_ms: Date.now() - started, started });
      });
    }),
  };
}

async function finish(cell, r) {
  const task = TASKS.find((t) => t.id === cell.task);
  const m = summarize(r.events);
  const answer = lastJson(m.final_text);
  let key = task.key;
  let key_source = "static";
  let live_key_error = null;
  if (task.liveKey) {
    try {
      key = await task.liveKey();
      key_source = "live";
    } catch (e) {
      live_key_error = String(e.message ?? e);
    }
  }
  const check = answer ? task.check(answer, key) : { pass: false, fields: {} };
  const staticCheck = answer && key_source === "live" ? task.check(answer, task.key) : null;
  const errors = [];
  if (r.killedBy) errors.push(r.killedBy);
  if (r.code !== 0 && !r.killedBy) errors.push(`exit ${r.code ?? r.signal}`);
  if (m.is_error) errors.push(`result ${m.result_subtype}`);
  if (!answer) errors.push("no JSON answer");
  if (r.stderr.trim()) errors.push(`stderr: ${r.stderr.trim().slice(0, 300)}`);
  return {
    task: cell.task, arm: cell.arm, run: cell.run, kind: task.kind,
    started_at: new Date(r.started).toISOString(), wall_ms: r.wall_ms,
    model: m.model ?? MODEL, session_id: m.session_id,
    pass: check.pass, fields: check.fields, pass_static_key: staticCheck?.pass ?? null,
    key_source, live_key: key_source === "live" ? key : undefined, live_key_error,
    answer, final_text: m.final_text?.slice(-2000) ?? null,
    turns: m.turns, assistant_messages: m.assistant_messages,
    tool_calls: m.tool_calls, tool_calls_by_tool: m.tool_calls_by_tool, subagent_tool_calls: m.subagent_tool_calls,
    screenshots: m.screenshots, tool_errors: m.tool_errors, error_samples: m.error_samples,
    tool_result_chars: m.tool_result_chars, tool_result_images: m.tool_result_images,
    usage: m.usage, tokens_all_models: m.tokens_all_models ?? null, model_usage: m.model_usage,
    cost_usd: m.cost_usd, duration_ms: m.duration_ms, duration_api_ms: m.duration_api_ms,
    tools_available: m.tools_available, errors,
    harness: { claude_args_tools: ARM_TOOLS[cell.arm] ?? "", concurrency: CONCURRENCY },
  };
}

// ---- main ----------------------------------------------------------------------------------

const done = readRuns();
const doneKeys = new Set(done.map(cellKey));
const pending = allCells().filter((c) => !doneKeys.has(cellKey(c)));
log(`${allCells().length} cells, ${done.length} recorded in ${path.relative(process.cwd(), OUT)}, ${pending.length} pending; model ${MODEL}, concurrency ${CONCURRENCY}, ${MAX_MIN} min`);

if (flag("dry-run")) {
  for (const c of pending) log("pending", cellKey(c));
  process.exit(0);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const running = new Set();
let recorded = 0;
let discarded = 0;

process.on("SIGINT", () => {
  for (const r of running) r.kill("interrupted");
});

async function worker() {
  while (pending.length) {
    const remaining = deadline - Date.now();
    // Start a cell only if it's likely to finish before the chunk ends.
    const i = pending.findIndex((c) => expectedMs(c, done) * 1.3 <= remaining);
    if (i < 0 || remaining < 30_000) return;
    const cell = pending.splice(i, 1)[0];
    const capMs = Math.min(RUN_CAP_MIN * 60_000, remaining - 5_000);
    log(`start ${cellKey(cell)} (cap ${(capMs / 60000).toFixed(1)} min)`);
    const handle = runCell(cell, capMs);
    running.add(handle);
    const r = await handle.done;
    running.delete(handle);
    if (r.killedBy === "chunk_deadline" || r.killedBy === "interrupted") {
      discarded++;
      log(`discarded ${cellKey(cell)} (${r.killedBy} after ${(r.wall_ms / 1000).toFixed(0)}s); it stays pending`);
      continue;
    }
    const row = await finish(cell, r);
    fs.appendFileSync(OUT, JSON.stringify(row) + "\n");
    done.push(row);
    recorded++;
    log(`done  ${cellKey(cell)} pass=${row.pass} ${(row.wall_ms / 1000).toFixed(0)}s tools=${row.tool_calls} shots=${row.screenshots}${row.errors.length ? " errors=" + row.errors.join("; ").slice(0, 200) : ""}`);
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => new Promise((r) => setTimeout(r, i * 2000)).then(worker)));
const left = allCells().filter((c) => !new Set(readRuns().map(cellKey)).has(cellKey(c))).length;
log(`chunk over: ${recorded} recorded, ${discarded} discarded, ${left} pending${left ? " (run again to continue)" : " (matrix complete)"}`);
fs.rmSync(TMP, { recursive: true, force: true });
