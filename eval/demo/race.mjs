#!/usr/bin/env node
// Records takes for the race video: one task run by Claude Code with the Firefox bridge tools and
// by Claude Code with Claude in Chrome, exactly as eval/run.mjs runs them (same prompt, model,
// flags and stream-json; lib/claude-args.mjs), while Cap records the whole screen. Takes run one
// at a time, Firefox's first, then Chrome's; never both at once.
//
//   node eval/demo/race.mjs --task gen-apg-datepicker [--browser firefox,chrome] [--takes 3]
//        [--dir ~/Movies/fab-race/<task>-<time>] [--model claude-sonnet-5-5] [--screen <id>]
//        [--firefox-window <id>] [--lead-in 2] [--tail 2] [--gap 5] [--run-timeout-min 7]
//        [--no-show-tabs] [--no-export] [--no-activate] [--dry-run]
//
// Per take, in --dir (outside the repo: the recordings show the whole screen):
//   <browser>-<take>.cap   Cap project; its raw display video is what compose.mjs crops
//   <browser>-<take>.mp4   `cap export` of it, for watching (Cap's editor look, not for cropping)
//   <browser>-<take>.json  sidecar: when the agent process started, its first tool call, its
//                          first tabs_close_mcp, the result event; pass/fail from the task's
//                          checker, cost, tool calls; the browser window's bounds on screen; the
//                          wall-clock time of the video's first frame
//   <browser>-<take>.stream.jsonl, .trace.jsonl   raw stream-json and the per-call trace
//
// Firefox runs get FIREFOX_BRIDGE_SHOW_TABS=1 in their MCP config (demo-only; needs Firefox
// restarted once on an extension with it) so the agent's tab opens in front of the Firefox
// Developer Edition window; without it the work happens in a background tab and nothing moves
// on camera. Chrome runs open their own window; its bounds are read once it appears.
//
// --dry-run prints what each take would run and touches nothing.

import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { lastJson } from "../lib/check.mjs";
import { browserClaudeArgs, firefoxMcpConfig } from "../lib/claude-args.mjs";
import { childEnv, summarize } from "../lib/stream.mjs";
import { toolTrace } from "../lib/trace.mjs";
import { taskById } from "../tasks.mjs";
import { firstFrameAt, parseNdjson, pickWindow, recordingIdOf, runTimes } from "./lib.mjs";

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(path.dirname(HERE));

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const flag = (name) => argv.includes(`--${name}`);

const TASK = taskById(opt("task", ""));
if (!TASK) throw new Error(`--task must be a task id from eval/tasks.mjs (e.g. gen-apg-datepicker)`);
const BROWSERS = opt("browser", "firefox,chrome").split(",");
for (const b of BROWSERS) if (!["firefox", "chrome"].includes(b)) throw new Error(`unknown --browser ${b}`);
BROWSERS.sort((a, b) => (a === "firefox" ? -1 : b === "firefox" ? 1 : 0)); // Firefox's takes first
const TAKES = Number(opt("takes", 1));
const MODEL = opt("model", "claude-sonnet-5-5");
const LEAD_IN_MS = Number(opt("lead-in", 2)) * 1000;
const TAIL_MS = Number(opt("tail", 2)) * 1000;
const GAP_MS = Number(opt("gap", 5)) * 1000;
const RUN_CAP_MS = Number(opt("run-timeout-min", 7)) * 60_000;
const SHOW_TABS = !flag("no-show-tabs");
const DRY = flag("dry-run");
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "").replace(/^(\d{8})/, "$1-");
const DIR = path.resolve(opt("dir", path.join(os.homedir(), "Movies", "fab-race", `${TASK.id}-${stamp}`)));
if (DIR.startsWith(ROOT + path.sep)) throw new Error(`--dir ${DIR} is inside the repo; recordings show the whole screen, keep them outside`);
const CAP = process.env.CAP_BIN || "cap";
const CLAUDE = process.env.CLAUDE_BIN || "claude";

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cap(args) {
  const { stdout } = await run(CAP, [...args, "--json"], { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}
const capJson = async (args) => JSON.parse(await cap(args));
const windows = async () => capJson(["targets", "windows"]).catch(() => []);

// ---- setup -----------------------------------------------------------------------------------

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fab-race-"));
const FF_CONFIG = path.join(TMP, "mcp.json");
fs.writeFileSync(FF_CONFIG, JSON.stringify(firefoxMcpConfig(path.join(ROOT, "mcp/server.mjs"), SHOW_TABS ? { FIREFOX_BRIDGE_SHOW_TABS: "1" } : {}), null, 2));
const EMPTY_CONFIG = path.join(TMP, "mcp-empty.json");
fs.writeFileSync(EMPTY_CONFIG, JSON.stringify({ mcpServers: {} }));
const argsFor = (browser) => browserClaudeArgs({ task: TASK, arm: "baseline", browser, model: MODEL, mcpConfig: FF_CONFIG, emptyMcpConfig: EMPTY_CONFIG });

let screen = { id: opt("screen"), logical: null, physical: null };
if (!DRY) {
  const screens = await capJson(["targets", "screens"]);
  const s = screens.find((x) => (screen.id ? String(x.id) === String(screen.id) : x.primary)) ?? screens[0];
  if (!s) throw new Error("cap found no screen to record");
  screen = { id: String(s.id), name: s.name, logical: s.logicalSize, physical: s.physicalSize };
}

// ---- one take --------------------------------------------------------------------------------

async function activate(app) {
  await run("osascript", ["-e", `tell application "${app}" to activate`]).catch((e) => log(`couldn't bring ${app} forward: ${e.message}`));
}

async function take(browser, n) {
  const base = path.join(DIR, `${browser}-${n}`);
  const capPath = `${base}.cap`;
  if (fs.existsSync(capPath)) throw new Error(`${capPath} exists; pick another --dir`);
  const args = argsFor(browser);
  if (DRY) {
    log(`[dry-run] ${browser} take ${n}:`);
    console.log(`  cap record start --screen ${screen.id ?? "<primary>"} --detach --fps 30 --path ${capPath} --json`);
    console.log(`  ${CLAUDE} ${args.map((a) => (/[\s"'*{}]/.test(a) ? JSON.stringify(a) : a)).join(" ")}`);
    console.log(`  cap record stop --id <recordingId> --json; cap export ${capPath} ${base}.mp4 --json`);
    return null;
  }

  // Which windows were there before: Chrome's run opens a new one, and that is the one to crop.
  const before = await windows();
  const beforeChrome = new Set(before.filter((w) => pickWindow([w], "chrome", {})).map((w) => String(w.id)));
  let win = null;
  if (browser === "firefox") {
    if (!flag("no-activate")) await activate("Firefox Developer Edition");
    await sleep(500);
    win = pickWindow(await windows(), "firefox", { id: opt("firefox-window") });
    if (!win) throw new Error("no Firefox Developer Edition window on screen to record; open one (or pass --firefox-window <id> from `cap targets windows`)");
  }

  const recStartedCall = Date.now();
  const started = parseNdjson(await cap(["record", "start", "--screen", screen.id, "--detach", "--fps", "30", "--path", capPath]));
  const recordingId = recordingIdOf(started);
  if (!recordingId) throw new Error(`cap record start said: ${JSON.stringify(started)}`);
  const recStarted = Date.now();
  log(`${browser} take ${n}: recording ${recordingId}`);
  await sleep(LEAD_IN_MS);

  // The agent, as run.mjs runs it.
  const cwd = fs.mkdtempSync(path.join(TMP, `${browser}-${n}-`));
  const agentStarted = Date.now();
  const proc = spawn(CLAUDE, args, { cwd, env: childEnv(), stdio: ["ignore", "pipe", "pipe"] });
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
        events.push({ t: Date.now(), e: JSON.parse(line) });
      } catch {}
    }
  });
  proc.stderr.on("data", (d) => (stderr += d));
  let killed = null;
  const timer = setTimeout(() => {
    killed = "run_timeout";
    proc.kill("SIGTERM");
    setTimeout(() => proc.kill("SIGKILL"), 5000).unref();
  }, RUN_CAP_MS);
  const exited = new Promise((resolve) => proc.on("exit", (code, signal) => resolve({ code, signal, at: Date.now() })));

  // Window bounds while it runs: Firefox's window (it may be moved), Chrome's new window once it
  // appears. Every change is kept; the last one before the result is the crop.
  const samples = [];
  let running = true;
  const sampler = (async () => {
    while (running) {
      const list = await windows();
      const w =
        browser === "firefox"
          ? pickWindow(list, "firefox", { id: win.id })
          : pickWindow(list, "chrome", { exclude: beforeChrome }) ?? pickWindow(list, "chrome", {});
      const last = samples.at(-1);
      if (w && (!last || last.id !== String(w.id) || JSON.stringify(last.bounds) !== JSON.stringify(w.bounds)))
        samples.push({ at: Date.now(), id: String(w.id), name: w.name, owner: w.ownerName, new_window: browser === "chrome" ? !beforeChrome.has(String(w.id)) : null, bounds: w.bounds });
      await sleep(700);
    }
  })();

  const exit = await exited;
  clearTimeout(timer);
  running = false;
  await sampler;
  await sleep(TAIL_MS);
  const stopped = parseNdjson(await cap(["record", "stop", "--id", recordingId]).catch((e) => `{"error": ${JSON.stringify(e.message)}}`));
  log(`${browser} take ${n}: agent exited ${exit.code ?? exit.signal} after ${((exit.at - agentStarted) / 1000).toFixed(1)}s; recording stopped`);

  // The raw display video and when its first frame was captured.
  const errors = [];
  const stopError = stopped.find((e) => e.error);
  if (stopError) errors.push(`cap record stop: ${stopError.error}`);
  let video = null;
  let videoT0 = null;
  let videoT0Source = null;
  try {
    const project = await capJson(["project", "inspect", capPath]);
    const seg = project.meta?.segments?.[0]?.display;
    video = seg?.path ? path.join(capPath, seg.path) : null;
    const logFile = path.join(capPath, "recording-logs.log");
    videoT0 = fs.existsSync(logFile) ? firstFrameAt(fs.readFileSync(logFile, "utf8")) : null;
    videoT0Source = "recording-logs.log first video frame";
    if (videoT0 == null) {
      // Not logged: take the start command's return plus the segment's own start offset.
      videoT0 = recStarted + (seg?.start_time ?? 0) * 1000;
      videoT0Source = "cap record start returned + segment start_time";
    }
  } catch (e) {
    errors.push(`cap project inspect: ${e.message}`);
  }
  let exported = null;
  if (!flag("no-export")) {
    try {
      const out = parseNdjson(await cap(["export", capPath, `${base}.mp4`]));
      const bad = out.find((e) => e.type === "Error" || e.error);
      if (bad) throw new Error(bad.error ?? JSON.stringify(bad));
      exported = `${base}.mp4`;
    } catch (e) {
      errors.push(`cap export: ${e.message}`);
    }
  }

  // Score it as run.mjs does.
  const m = summarize(events.map((x) => x.e));
  const times = runTimes(events);
  const answer = lastJson(m.final_text);
  let key = TASK.key;
  let keySource = "static";
  if (TASK.liveKey) {
    try {
      key = await TASK.liveKey();
      keySource = "live";
    } catch (e) {
      errors.push(`live key: ${e.message}`);
    }
  }
  const check = answer ? TASK.check(answer, key) : { pass: false, fields: {} };
  if (killed) errors.push(killed);
  if (exit.code !== 0 && !killed) errors.push(`exit ${exit.code ?? exit.signal}`);
  if (m.is_error) errors.push(`result ${m.result_subtype}`);
  if (!answer) errors.push("no JSON answer");
  if (stderr.trim()) errors.push(`stderr: ${stderr.trim().slice(0, 300)}`);
  if (events.some((x) => x.e.type === "user" && /Browser extension is not connected/i.test(JSON.stringify(x.e.message?.content ?? ""))))
    errors.push("chrome extension not connected (this take says nothing about the task)");
  const resultAt = times.result_at ?? exit.at;
  const windowAt = samples.filter((s) => s.at <= resultAt).at(-1) ?? samples[0] ?? (win && { at: agentStarted, id: String(win.id), name: win.name, owner: win.ownerName, bounds: win.bounds });
  if (!windowAt) errors.push("no browser window found on screen");

  fs.writeFileSync(`${base}.stream.jsonl`, events.map((x) => JSON.stringify(x)).join("\n") + "\n");
  fs.writeFileSync(`${base}.trace.jsonl`, toolTrace(events).map((c) => JSON.stringify(c)).join("\n") + "\n");
  const sidecar = {
    version: 1,
    task: TASK.id, browser, take: n, model: m.model ?? MODEL,
    prompt_sha1: crypto.createHash("sha1").update(args[1]).digest("hex"),
    show_tabs: browser === "firefox" ? SHOW_TABS : null,
    agent_started_at: agentStarted,
    first_tool_at: times.first_tool_at, first_tool: times.first_tool,
    close_call_at: times.close_call_at,
    result_at: resultAt, result_event: times.result_at != null,
    exit_at: exit.at,
    done_s: (resultAt - agentStarted) / 1000,
    pass: check.pass, fields: check.fields, key_source: keySource, answer,
    cost_usd: m.cost_usd, tool_calls: m.tool_calls, tool_calls_by_tool: m.tool_calls_by_tool, screenshot_actions: m.screenshot_actions,
    turns: m.turns, tool_errors: m.tool_errors, errors,
    window: windowAt ? { id: windowAt.id, name: windowAt.name, owner: windowAt.owner, bounds: windowAt.bounds, sampled_at: windowAt.at } : null,
    window_samples: samples,
    display: { id: screen.id, name: screen.name, logical: screen.logical, physical: screen.physical },
    recording: {
      cap_path: capPath, recording_id: recordingId, start_called_at: recStartedCall, start_returned_at: recStarted,
      video, video_t0_at: videoT0, video_t0_source: videoT0Source, export: exported,
    },
    stream_file: `${base}.stream.jsonl`, trace_file: `${base}.trace.jsonl`,
    iso: { agent_started_at: new Date(agentStarted).toISOString(), result_at: new Date(resultAt).toISOString() },
  };
  fs.writeFileSync(`${base}.json`, JSON.stringify(sidecar, null, 2) + "\n");
  log(`${browser} take ${n}: pass=${check.pass} ${sidecar.done_s.toFixed(1)}s tools=${m.tool_calls} $${m.cost_usd?.toFixed(3) ?? "?"}${errors.length ? ` errors=${errors.join("; ").slice(0, 200)}` : ""}`);
  return sidecar;
}

// ---- main ------------------------------------------------------------------------------------

if (!DRY) fs.mkdirSync(DIR, { recursive: true });
log(`task ${TASK.id}, model ${MODEL}, ${TAKES} take(s) each of ${BROWSERS.join(" then ")}, into ${DIR}${DRY ? " (dry run)" : ""}`);
const done = [];
try {
  for (const browser of BROWSERS)
    for (let n = 1; n <= TAKES; n++) {
      if (done.length) await sleep(GAP_MS);
      const sc = await take(browser, n);
      if (sc) done.push(sc);
    }
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}
if (!DRY) {
  for (const b of BROWSERS) {
    const s = done.filter((x) => x.browser === b);
    log(`${b}: ${s.map((x) => `${x.done_s.toFixed(1)}s${x.pass ? "" : " (fail)"}`).join(", ")}`);
  }
  log(`next: node eval/demo/compose.mjs --dir ${DIR}`);
}
