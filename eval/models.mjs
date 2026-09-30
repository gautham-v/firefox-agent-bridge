#!/usr/bin/env node
// Model x effort benchmark: runs every (task, config) of models-tasks.mjs with `claude -p --model
// <id> --effort <level>` and appends one JSON line per run to eval/results/models/runs.jsonl.
//
//   node eval/models.mjs [--max-minutes 8.5] [--concurrency 3] [--rounds 3] [--seed 7]
//                        [--configs haiku:default,sonnet:low,...] | [--models sonnet,opus --efforts low,high]
//                        [--tasks id,id] [--out eval/results/models/runs.jsonl] [--run-timeout-min 12]
//                        [--tag smoke] [--wait] [--dry-run] [--tier base|hard]
//
// --tier hard runs models-tasks-hard.mjs into eval/results/models-hard/runs.jsonl, without Haiku.
//
// Schedule: round-robin. Round r runs every (task, config) once, in an order shuffled with a seed
// derived from --seed and r, and round r+1 starts only after every cell of round r has started, so
// a run that stops early leaves the data balanced across configs.
//
// Chunked and resumable: each invocation is a scheduler that keeps up to --concurrency runs going
// until --max-minutes is up, then exits. Each run is its own detached worker process (this file
// with --one), so a run can go on past the chunk (up to --run-timeout-min) and records itself when
// it ends; the next chunk counts runs still going toward the concurrency. --wait makes the chunk
// wait for its runs to finish instead of leaving them behind.
//
// Each run gets its own Firefox tab-group session. After the agent exits, the worker joins that
// session over MCP, runs the task's `inspect` snippets on the tabs left open (state tasks), then
// closes every tab in the session.

import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { answerOf } from "./lib/check.mjs";
import { startMcp } from "./lib/mcp-client.mjs";
import { childEnv, summarize } from "./lib/stream.mjs";
import * as round1 from "./models-tasks.mjs";
import * as hard from "./models-tasks-hard.mjs";

const SELF = fileURLToPath(import.meta.url);
const EVAL = path.dirname(SELF);
const ROOT = path.dirname(EVAL);

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const flag = (name) => argv.includes(`--${name}`);

// --tier hard: the hard tasks (models-tasks-hard.mjs), results in results/models-hard/, and no
// Haiku by default. Without it, round 1's tasks, output and configs are unchanged.
const TIER = opt("tier", "base");
if (!["base", "hard"].includes(TIER)) throw new Error(`--tier must be base or hard, not ${TIER}`);
const { TASKS, score, taskById } = TIER === "hard" ? hard : round1;

export const MODELS = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-5-5",
  opus: "claude-opus-5-5",
  fable: "claude-fable-5-1",
};
// Haiku 4.5 takes --effort without error but ignores it (the CLI reports per_turn_effort_active:
// false, and output tokens don't track the level), so it runs once, at its default.
export const DEFAULT_CONFIGS = [
  "haiku:default",
  ...["sonnet", "opus", "fable"].flatMap((m) => ["low", "medium", "high"].map((e) => `${m}:${e}`)),
];

function parseConfigs() {
  let list;
  if (opt("configs")) list = opt("configs").split(",");
  else if (opt("models")) {
    const efforts = (opt("efforts") ?? "low,medium,high").split(",");
    list = opt("models").split(",").flatMap((m) => (m === "haiku" || m === MODELS.haiku ? ["haiku:default"] : efforts.map((e) => `${m}:${e}`)));
  } else list = TIER === "hard" ? DEFAULT_CONFIGS.filter((c) => !c.startsWith("haiku")) : DEFAULT_CONFIGS;
  return list.map((c) => {
    const [m, effort = "default"] = c.split(":");
    const model = MODELS[m] ?? m;
    return { id: `${model}/${effort}`, model, effort };
  });
}

const OUT = path.resolve(opt("out", path.join(EVAL, TIER === "hard" ? "results/models-hard/runs.jsonl" : "results/models/runs.jsonl")));
const DIR = path.dirname(OUT);
const INFLIGHT = path.join(DIR, "inflight");
const STREAMS = path.join(DIR, "streams");
const LOGS = path.join(DIR, "logs");
const RUN_CAP_MIN = Number(opt("run-timeout-min", 12));
const CLAUDE = process.env.CLAUDE_BIN || "claude";
const TAG = opt("tag", null);

const cellKey = (c) => `${c.task}|${c.config}|${c.round}`;
const fileKey = (c) => cellKey(c).replace(/[^\w.-]+/g, "_");

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

// ---- load: what else is running ------------------------------------------------------------

// Counts, from `ps`, this benchmark's other runs, other eval harness processes (eval/run.mjs,
// probes, other runners) and `claude -p` agents started by other harnesses.
function loadSample(selfPid) {
  let out = "";
  try {
    out = execFileSync("ps", ["-Ao", "pid=,command="], { encoding: "utf8", maxBuffer: 16 << 20 });
  } catch {
    return null;
  }
  const s = { siblings: 0, other_eval: 0, other_claude: 0 };
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!m || Number(m[1]) === selfPid) continue;
    const cmd = m[2];
    if (/models\.mjs --one/.test(cmd)) s.siblings++;
    else if (/node .*eval\/(run|probe-[\w-]+|[\w-]*run[\w-]*)\.mjs/.test(cmd)) s.other_eval++;
    else if (/(^|\/)claude -p /.test(cmd) && /fab-eval-|--mcp-config/.test(cmd) && !/fab-models-/.test(cmd)) s.other_claude++;
  }
  return s;
}

// ---- worker: one run -----------------------------------------------------------------------

function claudeArgs(task, config, mcpConfig) {
  const args = [
    "-p", task.prompt,
    "--output-format", "stream-json", "--verbose",
    "--model", config.model,
    "--strict-mcp-config", "--mcp-config", mcpConfig,
    "--tools", "",
    "--allowedTools", "mcp__firefox__*",
    "--disallowedTools", "Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch",
    "--no-session-persistence",
  ];
  if (config.effort !== "default") args.push("--effort", config.effort);
  return args;
}

async function inspectAndClose(session, task) {
  const state = {};
  const errors = [];
  let tabsLeft = null;
  let mcp;
  try {
    mcp = await startMcp({ name: "eval-models-check", session, timeoutMs: 60_000 });
    const ctx = JSON.parse(await mcp.call("tabs_context_mcp"));
    const tabs = ctx.availableTabs ?? [];
    tabsLeft = tabs.map((t) => t.url);
    for (const ins of task.inspect ?? []) {
      const re = new RegExp(ins.url);
      const tab = [...tabs].reverse().find((t) => re.test(t.url ?? ""));
      if (!tab) {
        state[ins.name] = null;
        errors.push(`${ins.name}: no open tab matching ${ins.url}`);
        continue;
      }
      try {
        state[ins.name] = await mcp.js(tab.tabId, ins.js);
      } catch (e) {
        state[ins.name] = null;
        errors.push(`${ins.name}: ${String(e.message ?? e).slice(0, 200)}`);
      }
    }
  } catch (e) {
    errors.push(`inspect: ${String(e.message ?? e).slice(0, 200)}`);
  } finally {
    if (mcp) await mcp.close().catch(() => {});
  }
  return { state, errors, tabsLeft };
}

async function runOne(cell) {
  const task = taskById(cell.task);
  const config = parseConfigs().find((c) => c.id === cell.config) ?? (() => {
    const [model, effort] = cell.config.split("/");
    return { id: cell.config, model, effort };
  })();
  fs.mkdirSync(INFLIGHT, { recursive: true });
  fs.mkdirSync(STREAMS, { recursive: true });
  const inflightFile = path.join(INFLIGHT, `${fileKey(cell)}.json`);
  const session = `eval-models-${randomUUID()}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fab-models-"));
  const mcpConfig = path.join(tmp, "mcp.json");
  fs.writeFileSync(
    mcpConfig,
    JSON.stringify({ mcpServers: { firefox: { type: "stdio", command: process.execPath, args: [path.join(ROOT, "mcp/server.mjs")], env: { FIREFOX_AGENT_BRIDGE_SESSION: session } } } }),
  );
  const started = Date.now();
  fs.writeFileSync(inflightFile, JSON.stringify({ ...cell, pid: process.pid, started_at: new Date(started).toISOString(), session }));

  const streamFile = path.join(STREAMS, `${fileKey(cell)}${TAG ? "-" + TAG : ""}.jsonl`);
  const streamOut = fs.createWriteStream(streamFile);
  const proc = spawn(CLAUDE, claudeArgs(task, config, mcpConfig), { cwd: tmp, env: childEnv(), stdio: ["ignore", "pipe", "pipe"] });
  const events = [];
  let buf = "";
  let stderr = "";
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    streamOut.write(chunk);
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        e._t = Date.now() - started;
        events.push(e);
      } catch {}
    }
  });
  proc.stderr.on("data", (d) => (stderr += d));

  const samples = [];
  const sample = () => {
    const s = loadSample(process.pid);
    if (s) samples.push(s);
  };
  sample();
  const sampler = setInterval(sample, 15_000);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGTERM");
    setTimeout(() => proc.kill("SIGKILL"), 5000).unref();
  }, RUN_CAP_MIN * 60_000);
  const exit = await new Promise((resolve) => proc.on("exit", (code, signal) => resolve({ code, signal })));
  clearTimeout(timer);
  clearInterval(sampler);
  streamOut.end();
  const wall_ms = Date.now() - started;

  const m = summarize(events);
  const { state, errors: inspectErrors, tabsLeft } = await inspectAndClose(session, task);
  const { answer, answerSource } = answerOf(m.final_text, events);
  // The agent's tool calls, for tasks whose rules limit the tools (the hard tier's no-JS tasks).
  const trace = events.filter((e) => e.type === "assistant" && !e.parent_tool_use_id).flatMap((e) => (e.message?.content ?? []).filter((b) => b.type === "tool_use").map((b) => ({ name: b.name, input: b.input })));
  let fields = {};
  try {
    fields = task.check(answer, state, trace);
  } catch (e) {
    inspectErrors.push(`check: ${e.message}`);
  }
  let { score: sc, pass } = score(fields);
  if (timedOut) {
    sc = 0;
    pass = false;
  }
  const rateLimited = events.some((e) => e.type === "rate_limit_event" && e.rate_limit_info?.status && e.rate_limit_info.status !== "allowed");
  // No result event and not a timeout: the CLI or API failed (auth, rate limit, crash), not the
  // model. Such rows are kept but don't count as done, so the cell runs again.
  const infraError = !timedOut && m.result_subtype == null;
  const errors = [];
  if (timedOut) errors.push("run_timeout");
  if (exit.code !== 0 && !timedOut) errors.push(`exit ${exit.code ?? exit.signal}`);
  if (m.is_error) errors.push(`result ${m.result_subtype}`);
  if (!answer) errors.push("no JSON answer");
  if (stderr.trim()) errors.push(`stderr: ${stderr.trim().slice(0, 300)}`);
  const agg = (k) => (samples.length ? { max: Math.max(...samples.map((s) => s[k])), mean: +(samples.reduce((a, s) => a + s[k], 0) / samples.length).toFixed(2) } : null);

  const row = {
    task: cell.task, config: config.id, model: config.model, effort: config.effort, round: cell.round, order: cell.order, tag: TAG,
    started_at: new Date(started).toISOString(), wall_ms, first_tool_ms: m.first_tool_ms,
    timeout: timedOut, infra_error: infraError, rate_limited: rateLimited,
    score: sc, pass, fields, answer, answer_source: answerSource, final_text: m.final_text?.slice(-1500) ?? null,
    state, inspect_errors: inspectErrors, tabs_left: tabsLeft,
    model_reported: m.model, per_turn_effort_active: m.per_turn_effort_active,
    thinking_blocks: m.thinking_blocks, thinking_signature_chars: m.thinking_signature_chars, thinking_text_chars: m.thinking_text_chars,
    turns: m.turns, assistant_messages: m.assistant_messages,
    tool_calls: m.tool_calls, tool_calls_by_tool: m.tool_calls_by_tool, screenshots: m.screenshots,
    tool_errors: m.tool_errors, repeated_calls: m.repeated_calls, retries_after_error: m.retries_after_error, error_samples: m.error_samples,
    tool_result_chars: m.tool_result_chars, tool_result_images: m.tool_result_images,
    usage: m.usage, tokens_all_models: m.tokens_all_models ?? null, model_usage: m.model_usage,
    cost_usd: m.cost_usd, duration_ms: m.duration_ms, duration_api_ms: m.duration_api_ms,
    load: { siblings: agg("siblings"), other_eval: agg("other_eval"), other_claude: agg("other_claude"), samples: samples.length },
    session_id: m.session_id, stream_file: path.relative(ROOT, streamFile), errors,
  };
  fs.mkdirSync(DIR, { recursive: true });
  fs.appendFileSync(OUT, JSON.stringify(row) + "\n");
  fs.rmSync(inflightFile, { force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`done ${cellKey(cell)} score=${sc} pass=${pass} ${(wall_ms / 1000).toFixed(0)}s tools=${m.tool_calls} cost=${m.cost_usd?.toFixed(3)}${errors.length ? " errors=" + errors.join("; ").slice(0, 200) : ""}`);
}

// ---- scheduler -----------------------------------------------------------------------------

// Seeded PRNG (mulberry32) and Fisher-Yates shuffle.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(xs, seed) {
  const r = rng(seed);
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function allCells(configs, tasks, rounds, seed) {
  const cells = [];
  for (let round = 1; round <= rounds; round++) {
    const base = tasks.flatMap((t) => configs.map((c) => ({ task: t.id, config: c.id })));
    shuffle(base, seed * 1000 + round).forEach((c, i) => cells.push({ ...c, round, order: i }));
  }
  return cells;
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function inflight() {
  if (!fs.existsSync(INFLIGHT)) return [];
  const out = [];
  for (const f of fs.readdirSync(INFLIGHT)) {
    const p = path.join(INFLIGHT, f);
    try {
      const x = JSON.parse(fs.readFileSync(p, "utf8"));
      if (alive(x.pid)) out.push(x);
      else fs.rmSync(p, { force: true }); // the worker died without recording; the cell runs again
    } catch {}
  }
  return out;
}

// A cell is done when it has a row that isn't an infrastructure failure, or after 3 failures.
function doneKeys(rows) {
  const ok = new Set();
  const fails = {};
  for (const r of rows) {
    const k = `${r.task}|${r.config}|${r.round}`;
    if (!r.infra_error) ok.add(k);
    else fails[k] = (fails[k] ?? 0) + 1;
  }
  for (const [k, n] of Object.entries(fails)) if (n >= 3) ok.add(k);
  return ok;
}

async function schedule() {
  const MAX_MIN = Number(opt("max-minutes", 8.5));
  const CONCURRENCY = Number(opt("concurrency", 3));
  const ROUNDS = Number(opt("rounds", 3));
  const SEED = Number(opt("seed", 7));
  const onlyTasks = opt("tasks")?.split(",");
  const configs = parseConfigs();
  const tasks = TASKS.filter((t) => !onlyTasks || onlyTasks.includes(t.id));
  const t0 = Date.now();
  const deadline = t0 + MAX_MIN * 60_000;
  const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s]`, ...a);

  const cells = allCells(configs, tasks, ROUNDS, SEED);
  const pendingNow = () => {
    const done = doneKeys(readRuns());
    const running = new Set(inflight().map(cellKey));
    return cells.filter((c) => !done.has(cellKey(c)) && !running.has(cellKey(c)));
  };
  let pending = pendingNow();
  log(`${cells.length} cells (${tasks.length} tasks x ${configs.length} configs x ${ROUNDS} rounds), ${cells.length - pending.length - inflight().length} done, ${inflight().length} running, ${pending.length} pending; concurrency ${CONCURRENCY}, chunk ${MAX_MIN} min`);
  log(`configs: ${configs.map((c) => c.id).join(", ")}`);
  if (flag("dry-run")) {
    for (const c of pending.slice(0, 40)) log("pending", cellKey(c));
    if (pending.length > 40) log(`... and ${pending.length - 40} more`);
    return;
  }

  const lock = path.join(DIR, "scheduler.lock");
  fs.mkdirSync(DIR, { recursive: true });
  if (fs.existsSync(lock)) {
    const pid = Number(fs.readFileSync(lock, "utf8"));
    if (alive(pid)) {
      log(`another chunk (pid ${pid}) is scheduling; exiting`);
      return;
    }
  }
  fs.writeFileSync(lock, String(process.pid));
  fs.mkdirSync(LOGS, { recursive: true });
  let started = 0;
  try {
    for (;;) {
      pending = pendingNow();
      const running = inflight();
      const remaining = deadline - Date.now();
      if (!pending.length && !running.length) break;
      if (remaining < 20_000) break;
      if (!pending.length && !flag("wait")) break;
      // Keep rounds whole: start a round-r+1 cell only once every round-r cell has started.
      const round = Math.min(...pending.map((c) => c.round));
      const next = pending.find((c) => c.round === round);
      if (next && running.length < CONCURRENCY && remaining > 60_000) {
        const logFd = fs.openSync(path.join(LOGS, `${fileKey(next)}.log`), "a");
        const args = [SELF, "--one", JSON.stringify(next), "--out", OUT, "--run-timeout-min", String(RUN_CAP_MIN)];
        if (TAG) args.push("--tag", TAG);
        if (TIER !== "base") args.push("--tier", TIER);
        if (opt("configs")) args.push("--configs", opt("configs"));
        const w = spawn(process.execPath, args, { detached: true, stdio: ["ignore", logFd, logFd], env: childEnv() });
        w.unref();
        fs.closeSync(logFd);
        // Mark it right away so the next loop doesn't start it twice before the worker writes.
        fs.mkdirSync(INFLIGHT, { recursive: true });
        fs.writeFileSync(path.join(INFLIGHT, `${fileKey(next)}.json`), JSON.stringify({ ...next, pid: w.pid, started_at: new Date().toISOString() }));
        started++;
        log(`start ${cellKey(next)} (pid ${w.pid})`);
        await new Promise((r) => setTimeout(r, 3000)); // stagger starts
        continue;
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
  } finally {
    fs.rmSync(lock, { force: true });
  }
  const rows = readRuns();
  const done = doneKeys(rows);
  const left = cells.filter((c) => !done.has(cellKey(c))).length;
  log(`chunk over: started ${started}; ${cells.length - left}/${cells.length} done, ${inflight().length} still running (they record themselves), ${left} not done${left ? " (run again to continue)" : " (complete)"}`);
}

if (opt("one")) {
  await runOne(JSON.parse(opt("one")));
  process.exit(0);
} else {
  await schedule();
}
