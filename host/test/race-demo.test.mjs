// The race video tooling's pure parts (eval/demo/lib.mjs) and the shared claude arguments
// (eval/lib/claude-args.mjs): finding the browser window in Cap's list, the video's first-frame
// time in Cap's log, run timings from stream-json, crop math at 2x, the median take, and the
// filtergraph's alignment, freeze and badge timing. eval/demo/dry-run.mjs renders it for real.
//   node --test host/test/*.test.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { cropBox, filterGraph, firstFrameAt, labelState, layout, medianTake, parseNdjson, pickWindow, recordingIdOf, runTimes, sideTiming, tenths } from "../../eval/demo/lib.mjs";
import { browserClaudeArgs, firefoxMcpConfig } from "../../eval/lib/claude-args.mjs";
import { taskById } from "../../eval/tasks.mjs";

// As `cap targets windows --json` lists them (front-most first).
const WINDOWS = [
  { id: "5852", name: "terminal", ownerName: "Ghostty", bundleIdentifier: "com.mitchellh.ghostty", bounds: { x: 1284, y: 33, width: 1268, height: 1399 } },
  { id: "77", name: "", ownerName: "Firefox Developer Edition", bundleIdentifier: "org.mozilla.firefoxdeveloperedition", bounds: { x: 0, y: 0, width: 200, height: 30 } },
  { id: "10376", name: "Firefox Agent Bridge", ownerName: "Firefox Developer Edition", bundleIdentifier: "org.mozilla.firefoxdeveloperedition", bounds: { x: 8, y: 33, width: 1268, height: 1399 } },
  { id: "900", name: "Old", ownerName: "Google Chrome", bundleIdentifier: "com.google.Chrome", bounds: { x: 100, y: 100, width: 1200, height: 900 } },
  { id: "901", name: "New Tab", ownerName: "Google Chrome", bundleIdentifier: "com.google.Chrome", bounds: { x: 1284, y: 40, width: 1260, height: 1380 } },
];

test("Cap's NDJSON: lines that aren't JSON are skipped; the recording id is found under its camelCase key", () => {
  const events = parseNdjson('warn: something\n{"event":"started","recordingId":"rec-1","pid":42,"path":"/x.cap"}\n\n{bad');
  assert.equal(events.length, 1);
  assert.equal(recordingIdOf(events), "rec-1");
  assert.equal(recordingIdOf([{ event: "error", error: "no permission" }]), null);
});

test("the Firefox window is the front-most big one; Chrome's is the one the run opened; an id picks exactly", () => {
  assert.equal(pickWindow(WINDOWS, "firefox").id, "10376", "the 200x30 sliver is skipped");
  assert.equal(pickWindow(WINDOWS, "chrome", { exclude: new Set(["900"]) }).id, "901");
  assert.equal(pickWindow(WINDOWS, "chrome").id, "900");
  assert.equal(pickWindow(WINDOWS, "firefox", { id: 77 }).id, "77");
  assert.equal(pickWindow(WINDOWS, "chrome", { exclude: new Set(["900", "901"]) }), null);
  assert.equal(pickWindow(null, "firefox"), null);
});

test("the video's t=0 is the log's first admitted frame; without that line there is none", () => {
  const log = [
    "2026-09-29T22:43:57.001330Z  INFO recording:studio_recording:segment{index=0}: cap_recording::studio_recording: pipeline playing",
    '2026-09-29T22:43:58.488204Z  INFO recording:studio_recording:segment{index=0}:screen-out:{task="mux-video"}: cap_recording::output_pipeline::core: Start gate admitted first video frame held_frames=52 admitted_after_arm_ms=25.447',
  ].join("\n");
  assert.equal(firstFrameAt(log), Date.parse("2026-09-29T22:43:58.488Z"));
  assert.equal(firstFrameAt("pipeline playing"), null);
});

test("run times: first tool call, first tabs_close_mcp (not a sub-agent's), result event", () => {
  const use = (name, extra = {}) => ({ type: "assistant", ...extra, message: { content: [{ type: "tool_use", name, input: {} }] } });
  const timed = [
    { t: 100, e: { type: "system", subtype: "init" } },
    { t: 900, e: { type: "assistant", message: { content: [{ type: "text", text: "on it" }] } } },
    { t: 1000, e: use("mcp__firefox__tabs_context_mcp") },
    { t: 5000, e: use("mcp__firefox__tabs_close_mcp", { parent_tool_use_id: "x" }) },
    { t: 6000, e: use("mcp__claude-in-chrome__tabs_close_mcp") },
    { t: 7000, e: use("mcp__firefox__tabs_close_mcp") },
    { t: 8000, e: { type: "result", subtype: "success" } },
  ];
  assert.deepEqual(runTimes(timed), { first_tool_at: 1000, first_tool: "mcp__firefox__tabs_context_mcp", close_call_at: 6000, result_at: 8000 });
  assert.deepEqual(runTimes([]), { first_tool_at: null, first_tool: null, close_call_at: null, result_at: null });
});

test("crop: logical window bounds become physical pixels at 2x, even, and clamped to the frame", () => {
  const display = { width: 2560, height: 1440 };
  assert.deepEqual(cropBox({ x: 8, y: 33, width: 1268, height: 1399 }, display, { width: 5120, height: 2880 }), { x: 16, y: 66, w: 2536, h: 2798, sx: 2, sy: 2 });
  // Recorded at logical size, the scale is 1 and odd offsets are rounded down to even.
  assert.deepEqual(cropBox({ x: 9, y: 33, width: 1267, height: 1399 }, display, { width: 2560, height: 1440 }), { x: 8, y: 32, w: 1266, h: 1398, sx: 1, sy: 1 });
  // A window hanging off the bottom right is cut at the frame's edge.
  const c = cropBox({ x: 2000, y: 1000, width: 1000, height: 1000 }, display, { width: 5120, height: 2880 });
  assert.deepEqual([c.x + c.w <= 5120, c.y + c.h <= 2880, c.w, c.h], [true, true, 1120, 880]);
});

test("the median take: among passing takes, lower middle for an even count; all takes when none passed", () => {
  const s = (take, done_s, pass = true) => ({ take, done_s, pass });
  assert.equal(medianTake([s(1, 14), s(2, 11), s(3, 30), s(4, 9, false)]).take, 1);
  assert.equal(medianTake([s(1, 14), s(2, 11)]).take, 2);
  assert.equal(medianTake([s(1, 20, false), s(2, 10, false), s(3, 15, false)]).take, 3);
  assert.equal(medianTake([]), null);
});

test("timing: offset into the video from its first frame, freeze at the close call or the result, timer to the result", () => {
  const sc = { agent_started_at: 12_000, close_call_at: 23_800, result_at: 24_460, recording: { video_t0_at: 10_000 } };
  assert.deepEqual(sideTiming(sc), { offset: 2, done: 12.46, holdFrom: 11.8 });
  assert.deepEqual(sideTiming(sc, { hold: "result" }), { offset: 2, done: 12.46, holdFrom: 12.46 });
  // No close call, or one after the result (a sub-agent's, say), holds from the result.
  assert.equal(sideTiming({ ...sc, close_call_at: null }).holdFrom, 12.46);
  assert.equal(sideTiming({ ...sc, close_call_at: 30_000 }).holdFrom, 12.46);
  assert.equal(tenths(12.46), "12.4");
  assert.equal(tenths(12.4), "12.4");
  assert.equal(tenths(0), "0.0");
});

test("layout: equal heights, side by side, inside the frame below the header and above the caption", () => {
  const lay = layout({ w: 2536, h: 2798 }, { w: 2520, h: 2760 });
  const [a, b] = lay.panes;
  assert.ok(lay.y >= 104 && lay.y + lay.h <= 1080 - 72);
  assert.ok(a.x >= 48 && b.x + b.w <= 1920 - 48 && a.x + a.w < b.x);
  assert.ok(Math.abs(a.w / lay.h - 2536 / 2798) < 0.01 && Math.abs(b.w / lay.h - 2520 / 2760) < 0.01);
  // Wide windows are limited by the width instead.
  const wide = layout({ w: 2560, h: 1440 }, { w: 2560, h: 1440 });
  assert.ok(wide.panes[1].x + wide.panes[1].w <= 1920 - 48 && wide.h < 1080 - 104 - 72);
});

test("filtergraph: each side is trimmed from its offset, cropped, frozen from holdFrom, and its label bar held", () => {
  const lay = layout({ w: 2536, h: 2798 }, { w: 2520, h: 2760 });
  const side = (offset, done, holdFrom, crop) => ({ timing: { offset, done, holdFrom }, crop });
  const g = filterGraph({
    sides: [side(2, 12.46, 11.8, { x: 16, y: 66, w: 2536, h: 2798 }), side(-0.5, 21.73, 21, { x: 2568, y: 80, w: 2520, h: 2760 })],
    lay,
    total: 24.73,
  });
  assert.match(g, /\[2:v\]trim=start=2\.000:end=13\.800,setpts=PTS-STARTPTS,crop=2536:2798:16:66,/);
  assert.match(g, /tpad=stop_mode=clone:stop_duration=13\.930,trim=duration=24\.730\[p0\]/);
  // A video that started after the agent is padded with its first frame instead.
  assert.match(g, /\[4:v\]tpad=start_mode=clone:start_duration=0\.500,trim=start=0\.000:end=21\.000,/);
  // The label bar sits over its pane's left edge, above the pane.
  assert.ok(g.includes(`[3:v]overlay=${lay.panes[0].x}:${lay.panes[0].y - 88}:eof_action=repeat`));
  assert.ok(g.includes(`[5:v]overlay=${lay.panes[1].x}:${lay.panes[1].y - 88}:eof_action=repeat`));
  assert.doesNotMatch(g, /enable=/);
  assert.match(g, /format=yuv420p\[out\]$/);
});

test("labelState: the timer runs to done and turns done on that tenth; lines share one scale; the winner gets its margin once both finish", () => {
  const ff = { done: 44.03, doneAll: 72.5, rivalDone: 72.5 };
  const ch = { done: 72.5, doneAll: 72.5, rivalDone: 44.03 };
  assert.deepEqual(labelState(20, ff), { timer: "20.0", done: false, line: 20 / 72.5, faster: null });
  assert.deepEqual(labelState(43.9, ff), { timer: "43.9", done: false, line: 43.9 / 72.5, faster: null });
  const at44 = labelState(44, ff);
  assert.equal(at44.timer, "44.0");
  assert.equal(at44.done, true);
  assert.equal(labelState(60, ff).timer, "44.0");
  assert.equal(labelState(60, ff).line, 44.03 / 72.5);
  assert.equal(labelState(60, ff).faster, null);
  assert.equal(labelState(72.5, ff).faster, "1.6×");
  assert.equal(labelState(72.5, ch).faster, null);
  assert.equal(labelState(72.5, ch).line, 1);
  assert.equal(labelState(72.4, ch).done, false);
});

test("race.mjs runs what run.mjs runs: same flags, and the prompt names each browser's tools", () => {
  const task = taskById("gen-apg-datepicker");
  const ff = browserClaudeArgs({ task, browser: "firefox", model: "claude-sonnet-5-5", mcpConfig: "/m.json", emptyMcpConfig: "/e.json" });
  assert.deepEqual(ff.slice(2), [
    "--output-format", "stream-json", "--verbose", "--model", "claude-sonnet-5-5", "--strict-mcp-config", "--mcp-config", "/m.json",
    "--tools", "", "--allowedTools", "mcp__firefox__*", "--disallowedTools", "Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch", "--no-session-persistence",
  ]);
  const ch = browserClaudeArgs({ task, browser: "chrome", model: "claude-sonnet-5-5", mcpConfig: "/m.json", emptyMcpConfig: "/e.json" });
  assert.deepEqual(ch.slice(2), [
    "--chrome", "--output-format", "stream-json", "--verbose", "--model", "claude-sonnet-5-5", "--strict-mcp-config", "--mcp-config", "/e.json",
    "--tools", "", "--allowedTools", "mcp__claude-in-chrome__*", "--disallowedTools", "Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch", "--no-session-persistence",
  ]);
  assert.equal(ch[1], ff[1].replaceAll("the Firefox browser tools", "the Chrome browser tools"));
  assert.notEqual(ch[1], ff[1]);
  const cfg = firefoxMcpConfig("/r/mcp/server.mjs", { FIREFOX_BRIDGE_SHOW_TABS: "1" });
  assert.deepEqual(cfg.mcpServers.firefox.env, { FIREFOX_BRIDGE_SHOW_TABS: "1" });
  assert.ok(!("env" in firefoxMcpConfig("/r/mcp/server.mjs").mcpServers.firefox));
});
