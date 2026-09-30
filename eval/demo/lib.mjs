// Pure pieces of the race video tooling (race.mjs records, compose.mjs composites), kept here so
// they can be unit tested without a screen, a browser or ffmpeg: host/test/race-demo.test.mjs.

// ---- recording side --------------------------------------------------------------------------

// Cap prints NDJSON (one JSON object per line) for record/export; anything else is ignored.
export function parseNdjson(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    try {
      out.push(JSON.parse(s));
    } catch {}
  }
  return out;
}

// The recording id from `cap record start --detach --json` (camelCase wrapper keys).
export function recordingIdOf(events) {
  for (const e of events) {
    const id = e.recordingId ?? e.recording_id ?? e.id;
    if (typeof id === "string" && id) return id;
  }
  return null;
}

const OWNERS = {
  firefox: (w) => w.bundleIdentifier === "org.mozilla.firefoxdeveloperedition" || w.ownerName === "Firefox Developer Edition",
  chrome: (w) => w.bundleIdentifier === "com.google.Chrome" || w.ownerName === "Google Chrome",
};

// The browser window to crop to, from `cap targets windows --json`: the first (front-most) big
// enough window of that browser whose id isn't in `exclude` (Chrome's windows from before the
// run, so the one the run opens is found). `id` picks one window by id instead.
export function pickWindow(windows, browser, { exclude = new Set(), id = null } = {}) {
  const mine = (Array.isArray(windows) ? windows : []).filter((w) => OWNERS[browser]?.(w));
  if (id != null) return mine.find((w) => String(w.id) === String(id)) ?? null;
  return mine.find((w) => !exclude.has(String(w.id)) && w.bounds?.width >= 400 && w.bounds?.height >= 300) ?? null;
}

// Wall-clock time (ms) of the recording's first video frame, t=0 of its display video, from the
// project's recording-logs.log ("Start gate admitted first video frame ..."). null when absent.
export function firstFrameAt(logText) {
  for (const line of String(logText ?? "").split("\n")) {
    if (!/admitted first video frame/.test(line)) continue;
    const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)/.exec(line.trim());
    if (m) return Date.parse(m[1]);
  }
  return null;
}

// When things happened in a run, from stream-json events stamped with the time they were read
// ({t, e}): the first tool call, the first tabs_close_mcp (the page is about to go away), the
// result event.
export function runTimes(timed) {
  let first = null;
  let close = null;
  let result = null;
  for (const { t, e } of timed) {
    if (e.type === "assistant" && !e.parent_tool_use_id) {
      for (const b of e.message?.content ?? []) {
        if (b.type !== "tool_use") continue;
        if (!first) first = { at: t, tool: b.name };
        if (close == null && /tabs_close_mcp$/.test(b.name)) close = t;
      }
    } else if (e.type === "result" && result == null) result = t;
  }
  return { first_tool_at: first?.at ?? null, first_tool: first?.tool ?? null, close_call_at: close, result_at: result };
}

// ---- compose side ----------------------------------------------------------------------------

const even = (n) => Math.max(2, 2 * Math.round(n / 2));
const evenDown = (n) => Math.max(2, 2 * Math.floor(n / 2));

// The crop in video pixels for a window's logical bounds. The scale comes from the video against
// the display's logical size (2 on a Retina display recorded at native resolution). Clamped to
// the frame and even, as yuv420p needs.
export function cropBox(bounds, display, video) {
  const sx = video.width / display.width;
  const sy = video.height / display.height;
  let x = Math.max(0, Math.round(bounds.x * sx));
  let y = Math.max(0, Math.round(bounds.y * sy));
  x -= x % 2;
  y -= y % 2;
  const w = evenDown(Math.min(bounds.width * sx, video.width - x));
  const h = evenDown(Math.min(bounds.height * sy, video.height - y));
  return { x, y, w, h, sx, sy };
}

// The take to show for one browser: the median time among the passing takes (the lower middle
// one for an even count), or among all when none passed.
export function medianTake(sidecars) {
  if (!sidecars.length) return null;
  const passing = sidecars.filter((s) => s.pass);
  const pool = (passing.length ? passing : sidecars).filter((s) => Number.isFinite(s.done_s)).sort((a, b) => a.done_s - b.done_s);
  return pool.length ? pool[Math.floor((pool.length - 1) / 2)] : null;
}

// Seconds with one decimal, cut rather than rounded, so the running timer (which shows the
// tenths passed) and the badge agree: 12.46 -> "12.4".
export const tenths = (s) => (Math.floor(s * 10 + 1e-6) / 10).toFixed(1);

// Where one side sits in its raw video and on the race's clock (all seconds, t=0 = the agent
// process starting): offset into the video, the time its picture holds from, the time its
// timer stops. hold: "close" freezes the picture at the first tabs_close_mcp call (the page as
// the agent left it; the timer runs on to the result), "result" at the result event.
export function sideTiming(sc, { hold = "close" } = {}) {
  const start = sc.agent_started_at;
  const done = (sc.result_at - start) / 1000;
  const closeAt = sc.close_call_at != null && sc.close_call_at < sc.result_at ? (sc.close_call_at - start) / 1000 : null;
  return {
    offset: (start - sc.recording.video_t0_at) / 1000,
    done,
    holdFrom: hold === "close" && closeAt != null ? closeAt : done,
  };
}

// Two panes, each under a header strip (label left, timer right), above a caption row.
// "side": scaled to one height, side by side and centered (16:9 for the blog and README).
// "stack": one above the other, full width (4:5 for phones), the first pane on top.
// Each pane is { x, y, w, h }; y is the top of the picture, the strip sits above it.
export function layout(a, b, { width = 1920, height = 1080, top = 104, bottom = 72, side = 48, gap = 40, mode = "side", strip = 66 } = {}) {
  if (mode === "stack") {
    const availH = height - top - bottom - strip - gap;
    const maxW = width - 2 * side;
    const h = evenDown(Math.min(availH / 2, maxW * (a.h / a.w), maxW * (b.h / b.w)));
    const wa = even((a.w * h) / a.h);
    const wb = even((b.w * h) / b.h);
    const y0 = evenDown(top + (availH - 2 * h) / 2);
    const panes = [
      { x: evenDown((width - wa) / 2), y: y0, w: wa, h },
      { x: evenDown((width - wb) / 2), y: y0 + h + gap + strip, w: wb, h },
    ];
    return { h, y: y0, panes };
  }
  const availH = height - top - bottom;
  const availW = width - 2 * side - gap;
  const h = evenDown(Math.min(availH, availW / (a.w / a.h + b.w / b.h)));
  const wa = even((a.w * h) / a.h);
  const wb = even((b.w * h) / b.h);
  const x1 = evenDown((width - (wa + gap + wb)) / 2);
  const y = evenDown(top + (availH - h) / 2);
  return { h, y, panes: [{ x: x1, y, w: wa, h }, { x: x1 + wa + gap, y, w: wb, h }] };
}

// The label bar above each pane (name left, timer right, race line along its bottom), in output
// pixels: its height and its gap to the pane.
export const STYLE = { stripH: 80, stripGap: 8 };

// What one side's label shows at race time t (seconds, one frame per tenth): the timer, whether
// that side is done, the race line's length as a share of the slowest side's time (both lines on
// one scale), and, once both are done, the winner's "1.6x faster". Uses the same tenths as the
// timer, so the finish shows on the frame whose timer reads the final time.
export function labelState(t, { done, doneAll, rivalDone }) {
  const k = Math.floor(t * 10 + 1e-6);
  const finished = k >= Math.floor(done * 10 + 1e-6);
  const shown = finished ? done : k / 10;
  const last = Math.max(doneAll, 1e-6);
  const allDone = k >= Math.floor(last * 10 + 1e-6);
  const faster = allDone && rivalDone > done ? `${(Math.floor((rivalDone / done) * 10 + 1e-6) / 10).toFixed(1)}×` : null;
  return { timer: tenths(shown), done: finished, line: Math.min(1, shown / last), faster };
}

// The ffmpeg filtergraph. Inputs: 0 = canvas, 1 = static overlay (the caption), then per side
// (left, right): raw video, label frames (10 a second; the last one stays up, frozen, by
// eof_action=repeat). Each side's picture holds its last frame from holdFrom to the end.
export function filterGraph({ sides, lay, total, fps = 30, style = STYLE }) {
  const parts = [];
  sides.forEach((s, i) => {
    const v = 2 + i * 2;
    const { crop, timing } = s;
    const pane = lay.panes[i];
    const pre = timing.offset < 0 ? `tpad=start_mode=clone:start_duration=${(-timing.offset).toFixed(3)},` : "";
    const start = Math.max(0, timing.offset);
    parts.push(
      `[${v}:v]${pre}trim=start=${start.toFixed(3)}:end=${(start + timing.holdFrom).toFixed(3)},setpts=PTS-STARTPTS,` +
        `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},scale=${pane.w}:${pane.h}:flags=lanczos,setsar=1,fps=${fps},` +
        `tpad=stop_mode=clone:stop_duration=${(total - timing.holdFrom + 1).toFixed(3)},trim=duration=${total.toFixed(3)}[p${i}]`,
    );
  });
  parts.push("[0:v][1:v]overlay=0:0[b0]");
  let n = 0;
  sides.forEach((s, i) => {
    const v = 2 + i * 2;
    const pane = lay.panes[i];
    parts.push(`[b${n}][p${i}]overlay=${pane.x}:${pane.y}[b${n + 1}]`);
    n++;
    parts.push(`[b${n}][${v + 1}:v]overlay=${pane.x}:${pane.y - style.stripGap - style.stripH}:eof_action=repeat[b${n + 1}]`);
    n++;
  });
  parts.push(`[b${n}]format=yuv420p[out]`);
  return parts.join(";\n");
}
