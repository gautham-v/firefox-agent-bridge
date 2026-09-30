#!/usr/bin/env node
// Proves compose.mjs without a browser, an agent or a screen recording: two synthetic "screen
// recordings" at the display's physical size (5120x2880 for the 2560x1440 logical display), red
// everywhere except a testsrc pattern exactly where the fake browser window is, plus sidecars
// like race.mjs writes. A crop that is off by a pixel shows red at the pane's edge, and testsrc's
// seconds counter shows which source second each pane is on, so the alignment and the freeze can
// be read off extracted frames.
//
//   node eval/demo/dry-run.mjs [--dir <scratch dir>]
//
// Firefox: the agent starts 2.0s into its recording, closes its tab at 11.8s, answers at 12.46s.
// Chrome: starts 3.5s in, closes at 21.0s, answers at 21.73s. Two more Firefox sidecars (a slower
// pass, a faster fail) check that the median passing take is the one picked. Frames at 1, 12, 13
// and 24s are written next to the output as frame-*.png.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const i = argv.indexOf("--dir");
const DIR = path.resolve(i >= 0 ? argv[i + 1] : path.join(os.tmpdir(), "fab-race-dry"));
fs.mkdirSync(DIR, { recursive: true });

const LOGICAL = { width: 2560, height: 1440 };
const SCALE = 2;
const T0 = Date.parse("2026-09-30T18:00:00.000Z");

function fakeScreen(name, bounds, seconds) {
  const file = path.join(DIR, `${name}-raw.mp4`);
  if (fs.existsSync(file)) return file;
  const [W, H] = [LOGICAL.width * SCALE, LOGICAL.height * SCALE];
  const [x, y, w, h] = [bounds.x, bounds.y, bounds.width, bounds.height].map((n) => n * SCALE);
  console.log(`rendering ${file} (${W}x${H}, ${seconds}s)`);
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `color=c=red:s=${W}x${H}:r=30:d=${seconds}`,
    "-f", "lavfi", "-i", `testsrc=s=${w}x${h}:r=30:d=${seconds}`,
    "-filter_complex", `[0:v][1:v]overlay=${x}:${y}:shortest=1,format=yuv420p`,
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30", file,
  ], { stdio: "inherit" });
  return file;
}

function sidecar({ browser, take, video, t0, startIn, closeAt, doneAt, pass, bounds }) {
  const start = t0 + startIn * 1000;
  const sc = {
    version: 1, synthetic: true, task: "gen-apg-datepicker", browser, take, model: "claude-sonnet-5-5",
    agent_started_at: start, first_tool_at: start + 2500, first_tool: "tabs_context_mcp",
    close_call_at: closeAt == null ? null : start + closeAt * 1000, result_at: start + doneAt * 1000, done_s: doneAt,
    pass, cost_usd: 0.07, tool_calls: 16,
    window: { id: browser === "firefox" ? "10376" : "20001", owner: browser, bounds },
    display: { id: "3", logical: LOGICAL, physical: { width: LOGICAL.width * SCALE, height: LOGICAL.height * SCALE } },
    recording: { video, video_t0_at: t0, video_t0_source: "synthetic" },
  };
  fs.writeFileSync(path.join(DIR, `${browser}-${take}.json`), JSON.stringify(sc, null, 2));
}

const ffBounds = { x: 8, y: 33, width: 1268, height: 1399 };
const chBounds = { x: 1284, y: 40, width: 1260, height: 1380 };
const ffVideo = fakeScreen("firefox", ffBounds, 18);
const chVideo = fakeScreen("chrome", chBounds, 28);
sidecar({ browser: "firefox", take: 1, video: ffVideo, t0: T0, startIn: 2.0, closeAt: 11.8, doneAt: 12.46, pass: true, bounds: ffBounds });
sidecar({ browser: "firefox", take: 2, video: ffVideo, t0: T0, startIn: 2.0, closeAt: 14.0, doneAt: 15.0, pass: true, bounds: ffBounds });
sidecar({ browser: "firefox", take: 3, video: ffVideo, t0: T0, startIn: 2.0, closeAt: 9.0, doneAt: 10.0, pass: false, bounds: ffBounds });
sidecar({ browser: "chrome", take: 1, video: chVideo, t0: T0 + 60_000, startIn: 3.5, closeAt: 21.0, doneAt: 21.73, pass: true, bounds: chBounds });

execFileSync(process.execPath, [path.join(HERE, "compose.mjs"), "--dir", DIR], { stdio: "inherit" });
const out = path.join(DIR, "race-gen-apg-datepicker.mp4");
for (const t of [1, 12, 13, 24]) execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(t), "-i", out, "-frames:v", "1", path.join(DIR, `frame-${t}s.png`)]);
console.log(`frames: ${DIR}/frame-{1,12,13,24}s.png`);
