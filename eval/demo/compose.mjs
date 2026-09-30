#!/usr/bin/env node
// Composites one Firefox take and one Chrome take from race.mjs into the race video: each
// browser window cropped out of its screen recording, both aligned to t=0 = the agent process
// starting, scaled to one height, side by side (Claude in Chrome left), a label and a running timer over
// each, the timer stopping when that side's result arrives, a "done in 12.4s" badge from then on,
// and the faster side's last frame held until the slower one finishes.
//
//   node eval/demo/compose.mjs --dir <race dir> [--firefox <sidecar.json>] [--chrome <sidecar.json>]
//        [--out race.mp4] [--social-out race-social.mp4] [--hold close|result] [--tail 3]
//        [--font file] [--mono-font file] [--speed 2] [--caption text] [--background image] [--keep-temp]
//
// Without --firefox/--chrome it takes the median-time passing take of each browser from the
// sidecars in --dir. Writes a 1920x1080 mp4 (h264, yuv420p, faststart, no audio) and a 1200-wide
// cut for social (1200x676: yuv420p needs an even height, so not 675), next to the sidecars
// unless --out says otherwise.
//
// ffmpeg here has no drawtext (no libfreetype), so text is drawn with ImageMagick (`magick`) into
// PNGs and overlaid: one static layer, one timer frame per tenth of a second (an image sequence
// at 10 fps whose last frame stays up), and a badge per side.
//
// --hold close (default) freezes each side's picture at its first tabs_close_mcp call, since the
// prompt makes the agent close its tab before answering and the window would otherwise end on
// whatever tab is left; its timer runs on to the result. --hold result freezes at the result.

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { STYLE, cropBox, filterGraph, layout, medianTake, sideTiming, tenths } from "./lib.mjs";

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const flag = (name) => argv.includes(`--${name}`);

const W = 1920;
const H = 1080;
const FPS = 30;
const BACKGROUND = opt("background") ? path.resolve(opt("background").replace(/^~(?=\/)/, os.homedir())) : null; // an image behind the panes, cropped to fill
if (BACKGROUND && !fs.existsSync(BACKGROUND)) throw new Error(`--background ${BACKGROUND} not found`);
const SPEED = Number(opt("speed", 1)); // playback speed of the final video; the timers keep showing real seconds
if (!(SPEED >= 1 && SPEED <= 8)) throw new Error("--speed is 1 to 8");
const TAIL = Number(opt("tail", 3)) * SPEED; // seconds the finished frame stays up, as watched
const HOLD = opt("hold", "close");
if (!["close", "result"].includes(HOLD)) throw new Error("--hold is close or result");
const LABELS = { firefox: "Firefox Agent Bridge", chrome: "Claude in Chrome" };
const MODEL_NAMES = { "claude-sonnet-5-5": "Sonnet 5.5", "claude-opus-5-5": "Opus 5.5", "claude-fable-5-1": "Fable 5.1", "claude-haiku-4-5-20251001": "Haiku 4.5" };
const cap1 = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const COLORS = { canvas: "#161618", strip: "rgba(0,0,0,0.55)", text: "#F5F5F7", muted: "#A1A1A6", badge: "rgba(12,12,14,0.78)" };

const firstFile = (...files) => files.find((f) => f && fs.existsSync(f));
const FONT = firstFile(opt("font"), path.join(os.homedir(), "Library/Fonts/Archivo[wdth,wght].ttf"), path.join(os.homedir(), "Library/Fonts/Inter-Medium.ttf"), path.join(os.homedir(), "Library/Fonts/InterVariable.ttf"), "/Library/Fonts/Inter-Medium.ttf", "/System/Library/Fonts/SFNS.ttf", "/System/Library/Fonts/Helvetica.ttc");
const MONO = firstFile(opt("mono-font"), path.join(os.homedir(), "Library/Fonts/GeistMono-Regular.otf"), "/System/Library/Fonts/SFNSMono.ttf", "/System/Library/Fonts/Menlo.ttc", FONT);

// ---- pick the takes --------------------------------------------------------------------------

const DIR = opt("dir") ? path.resolve(opt("dir")) : null;
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
function sidecarsIn(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => /^(firefox|chrome)-\d+\.json$/.test(f))
    .map((f) => ({ ...readJson(path.join(dir, f)), _file: path.join(dir, f) }));
}
function pick(browser) {
  const given = opt(browser);
  if (given) return { ...readJson(given), _file: path.resolve(given) };
  if (!DIR) throw new Error(`--dir or --${browser} is required`);
  const all = sidecarsIn(DIR).filter((s) => s.browser === browser);
  const chosen = medianTake(all);
  if (!chosen) throw new Error(`no ${browser} takes in ${DIR}`);
  if (!all.some((s) => s.pass)) console.warn(`warning: no ${browser} take passed; using the median of all`);
  console.log(`${browser}: take ${chosen.take} (${tenths(chosen.done_s)}s, pass=${chosen.pass}) of ${all.length}: ${all.map((s) => `${s.take}=${tenths(s.done_s)}s${s.pass ? "" : " fail"}`).join(", ")}`);
  return chosen;
}

const takes = [pick("chrome"), pick("firefox")]; // Claude in Chrome left, Firefox right
if (takes[0].task !== takes[1].task) throw new Error(`the takes are of different tasks: ${takes[0].task}, ${takes[1].task}`);
const outDir = DIR ?? path.dirname(takes[0]._file);
const modelName = MODEL_NAMES[String(takes[0].model).replace(/\[.*\]$/, "")] ?? takes[0].model;
const CAPTION = opt("caption") ?? [modelName + (takes[0].effort ? ` ${cap1(takes[0].effort)}` : ""), "same task and prompt", "one take each", ...(SPEED > 1 ? [`played at ${SPEED}x`] : [])].join(" · ");
const OUT = path.resolve(opt("out", path.join(outDir, `race-${takes[0].task}.mp4`)));
const SOCIAL = path.resolve(opt("social-out", OUT.replace(/\.mp4$/, "") + "-social.mp4"));

// ---- geometry and timing ---------------------------------------------------------------------

function probe(file) {
  const j = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", file], { encoding: "utf8" }));
  return { width: j.streams[0].width, height: j.streams[0].height, duration: Number(j.format.duration) };
}

const sides = takes.map((sc) => {
  const video = sc.recording?.video;
  if (!video || !fs.existsSync(video)) throw new Error(`${sc._file}: recording.video ${video} is missing`);
  if (!sc.window?.bounds) throw new Error(`${sc._file}: no window bounds`);
  const v = probe(video);
  const crop = cropBox(sc.window.bounds, sc.display.logical, v);
  const timing = sideTiming(sc, { hold: HOLD });
  if (timing.offset + timing.holdFrom > v.duration + 0.5) console.warn(`warning: ${sc.browser} take ${sc.take}: the video (${v.duration.toFixed(1)}s) ends before ${(timing.offset + timing.holdFrom).toFixed(1)}s; its last frame is held from there`);
  return { sc, video, v, crop, timing };
});
const total = Math.max(...sides.map((s) => s.timing.done)) + TAIL;
const lay = layout({ w: sides[0].crop.w, h: sides[0].crop.h }, { w: sides[1].crop.w, h: sides[1].crop.h }, { width: W, height: H });

// ---- overlays --------------------------------------------------------------------------------

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fab-race-"));
const magick = (args) =>
  new Promise((resolve, reject) => {
    const p = spawn("magick", args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`magick ${args.slice(-1)}: ${err.trim()}`))));
  });
async function pool(jobs, n = Math.max(2, os.cpus().length - 2)) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < jobs.length) await jobs[i++]();
  }));
}
const sizeOf = (file) => execFileSync("magick", ["identify", "-format", "%w %h", file], { encoding: "utf8" }).trim().split(" ").map(Number);

const stripTop = lay.y - STYLE.stripGap - STYLE.stripH;
const staticArgs = ["-size", `${W}x${H}`, "xc:none"];
sides.forEach((s, i) => {
  const p = lay.panes[i];
  staticArgs.push("-fill", COLORS.strip, "-draw", `roundrectangle ${p.x},${stripTop} ${p.x + p.w - 1},${stripTop + STYLE.stripH - 1} 10,10`);
  // Drawn centered in a strip-high box, as the timers are, so both sit on one line.
  staticArgs.push("(", "-size", `${Math.round(p.w / 2)}x${STYLE.stripH}`, "xc:none", "-font", FONT, "-pointsize", "28", "-fill", COLORS.text, "-gravity", "West", "-annotate", "+20+0", LABELS[s.sc.browser], ")");
  staticArgs.push("-gravity", "NorthWest", "-geometry", `+${p.x}+${stripTop}`, "-composite");
});
if (BACKGROUND) {
  // On a painting the caption needs its own dark pill to stay readable.
  const capText = path.join(TMP, "caption.png");
  await magick(["-background", "none", "-fill", COLORS.text, "-font", FONT, "-pointsize", "24", `label:${CAPTION}`, capText]);
  const [cw, ch] = sizeOf(capText);
  const pw = cw + 44, ph = ch + 18;
  staticArgs.push("-fill", COLORS.strip, "-draw", `roundrectangle ${(W - pw) / 2},${H - 22 - ph} ${(W + pw) / 2 - 1},${H - 23} ${ph / 2},${ph / 2}`);
  staticArgs.push(capText, "-gravity", "South", "-geometry", "+0+31", "-composite");
} else staticArgs.push("-font", FONT, "-pointsize", "24", "-fill", COLORS.muted, "-gravity", "South", "-annotate", "+0+26", CAPTION);
staticArgs.push(path.join(TMP, "static.png"));
await magick(staticArgs);

const TIMER = { w: 200, h: STYLE.stripH };
const jobs = [];
sides.forEach((s, i) => {
  const frames = Math.floor(s.timing.done * 10 + 1e-6) + 1;
  s.timerPattern = path.join(TMP, `timer${i}-%05d.png`);
  s.timerSize = TIMER;
  for (let k = 0; k < frames; k++)
    jobs.push(() =>
      magick(["-size", `${TIMER.w}x${TIMER.h}`, "xc:none", "-font", MONO, "-pointsize", "28", "-fill", COLORS.text, "-gravity", "East", "-annotate", "+20+0", `${tenths(k / 10)}s`, path.join(TMP, `timer${i}-${String(k).padStart(5, "0")}.png`)]),
    );
});
await pool(jobs);

for (const [i, s] of sides.entries()) {
  const text = path.join(TMP, `badge-text${i}.png`);
  await magick(["-background", "none", "-fill", COLORS.text, "-font", FONT, "-pointsize", "28", `label:done in ${tenths(s.timing.done)}s`, text]);
  const [tw, th] = sizeOf(text);
  const bw = tw + 48;
  const bh = th + 22;
  s.badge = path.join(TMP, `badge${i}.png`);
  await magick(["-size", `${bw}x${bh}`, "xc:none", "-fill", COLORS.badge, "-draw", `roundrectangle 0,0 ${bw - 1},${bh - 1} ${bh / 2},${bh / 2}`, text, "-gravity", "center", "-composite", s.badge]);
  s.badgeSize = { w: bw, h: bh };
}

// ---- render ----------------------------------------------------------------------------------

const graph = filterGraph({ sides, lay, total, fps: FPS });
const graphFile = path.join(TMP, "graph.txt");
fs.writeFileSync(graphFile, graph);
let canvasInput = ["-f", "lavfi", "-i", `color=c=${COLORS.canvas.replace("#", "0x")}:s=${W}x${H}:r=${FPS}:d=${total.toFixed(3)}`];
if (BACKGROUND) {
  const bg = path.join(TMP, "background.png");
  await magick([BACKGROUND, "-resize", `${W}x${H}^`, "-gravity", "center", "-extent", `${W}x${H}`, bg]);
  canvasInput = ["-loop", "1", "-framerate", String(FPS), "-t", total.toFixed(3), "-i", bg];
}
const inputs = [...canvasInput, "-loop", "1", "-framerate", String(FPS), "-i", path.join(TMP, "static.png")];
for (const s of sides) inputs.push("-i", s.video, "-framerate", "10", "-i", s.timerPattern, "-loop", "1", "-framerate", String(FPS), "-i", s.badge);

const ffmpeg = (args) => {
  const r = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "inherit" });
  return new Promise((resolve, reject) => r.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)))));
};
const X264 = (maxrate) => ["-c:v", "libx264", "-preset", "slow", "-crf", "22", "-maxrate", maxrate, "-bufsize", `${parseFloat(maxrate) * 2}M`, "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an"];
const REAL = SPEED > 1 ? path.join(TMP, "real-time.mp4") : OUT;
await ffmpeg([...inputs, "-/filter_complex", graphFile, "-map", "[out]", "-t", total.toFixed(3), "-r", String(FPS), ...(SPEED > 1 ? ["-c:v", "libx264", "-preset", "fast", "-crf", "16", "-pix_fmt", "yuv420p", "-an"] : X264("1.8M")), REAL]);
if (SPEED > 1) await ffmpeg(["-i", REAL, "-vf", `setpts=PTS/${SPEED}`, "-r", String(FPS), ...X264("2.4M"), OUT]);
await ffmpeg(["-i", OUT, "-vf", "scale=1200:-2:flags=lanczos", "-r", String(FPS), ...X264("1.1M"), SOCIAL]);

const mb = (f) => (fs.statSync(f).size / 1e6).toFixed(1);
console.log(
  JSON.stringify(
    {
      out: OUT,
      out_mb: Number(mb(OUT)),
      social: SOCIAL,
      social_mb: Number(mb(SOCIAL)),
      seconds: Number((total / SPEED).toFixed(1)),
      speed: SPEED,
      hold: HOLD,
      sides: sides.map((s, i) => ({
        browser: s.sc.browser,
        take: s.sc.take,
        sidecar: s.sc._file,
        done_s: Number(tenths(s.timing.done)),
        video_offset_s: Number(s.timing.offset.toFixed(3)),
        picture_holds_from_s: Number(s.timing.holdFrom.toFixed(3)),
        crop: s.crop,
        pane: { ...lay.panes[i], y: lay.y, h: lay.h },
      })),
      ...(flag("keep-temp") ? { temp: TMP } : {}),
    },
    null,
    2,
  ),
);
if (!flag("keep-temp")) fs.rmSync(TMP, { recursive: true, force: true });
