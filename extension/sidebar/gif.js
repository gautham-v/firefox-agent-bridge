"use strict";

// A small GIF89a encoder for the agent cam's Save as GIF (panel.js). The whole GIF shares one
// palette, from a median cut over pixels sampled across its frames. Each frame after the first
// is only the box that changed since the one before, with its unchanged pixels transparent, so a
// page that mostly sits still costs little. No dithering: pages are flat color and text, and
// dither noise would defeat both the transparency and the compression.
//
// Loaded two ways: as the sidebar's worker, which decodes the cam's frames, draws the redaction
// bars over them and encodes (the end of this file), and by the tests in Node, which stand in
// their own canvas for the worker's part.

const TRANSPARENT = 255; // the palette index for unchanged pixels; colors use 0..254
const MAX_COLORS = 255;

// Median cut. samples is r,g,b triplets. The box with the most pixels times its widest range is
// split at its median on that channel, until there are maxColors boxes or none can be split;
// each box's mean is a palette color. With maxColors or fewer distinct colors, each is exact.
function medianCut(samples, maxColors = MAX_COLORS) {
  const n = Math.floor(samples.length / 3);
  if (!n) return new Uint8Array(3);
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  const measure = (start, end) => {
    const lo = [255, 255, 255];
    const hi = [0, 0, 0];
    for (let i = start; i < end; i++) {
      const p = order[i] * 3;
      for (let c = 0; c < 3; c++) {
        const v = samples[p + c];
        if (v < lo[c]) lo[c] = v;
        if (v > hi[c]) hi[c] = v;
      }
    }
    const ranges = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
    const channel = ranges.indexOf(Math.max(...ranges));
    return { start, end, channel, range: ranges[channel], score: ranges[channel] * (end - start) };
  };
  const boxes = [measure(0, n)];
  const counts = new Uint32Array(256);
  while (boxes.length < maxColors) {
    let at = -1;
    for (let i = 0; i < boxes.length; i++) if (boxes[i].range > 0 && (at < 0 || boxes[i].score > boxes[at].score)) at = i;
    if (at < 0) break;
    const { start, end, channel } = boxes[at];
    // The median value on the channel, by count; a box whose top value holds the median splits
    // just under it instead, so both halves have pixels.
    counts.fill(0);
    for (let i = start; i < end; i++) counts[samples[order[i] * 3 + channel]]++;
    const half = (end - start) / 2;
    let cut = 0;
    for (let sum = 0; cut < 256; cut++) if ((sum += counts[cut]) >= half) break;
    let below = 0;
    for (let v = 0; v <= cut; v++) below += counts[v];
    if (below === end - start) {
      below -= counts[cut];
      cut--;
    }
    // Partition in place: values up to cut first.
    for (let i = start, j = end - 1; i <= j; ) {
      if (samples[order[i] * 3 + channel] <= cut) i++;
      else {
        const t = order[i];
        order[i] = order[j];
        order[j--] = t;
      }
    }
    boxes.splice(at, 1, measure(start, start + below), measure(start + below, end));
  }
  const palette = new Uint8Array(boxes.length * 3);
  boxes.forEach((b, k) => {
    const sum = [0, 0, 0];
    for (let i = b.start; i < b.end; i++) for (let c = 0; c < 3; c++) sum[c] += samples[order[i] * 3 + c];
    for (let c = 0; c < 3; c++) palette[k * 3 + c] = Math.round(sum[c] / (b.end - b.start));
  });
  return palette;
}

// Maps a color to its nearest palette index (weighted for the eye), remembered per 5-bit color.
function nearestMap(palette) {
  const n = palette.length / 3;
  const cache = new Int16Array(32768).fill(-1);
  return (r, g, b) => {
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let best = cache[key];
    if (best >= 0) return best;
    let bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const dr = palette[i * 3] - r;
      const dg = palette[i * 3 + 1] - g;
      const db = palette[i * 3 + 2] - b;
      const d = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    cache[key] = best;
    return best;
  };
}

// A growable byte buffer.
function bytes(size = 4096) {
  let buf = new Uint8Array(size);
  let len = 0;
  const room = (k) => {
    if (len + k <= buf.length) return;
    const next = new Uint8Array(Math.max(buf.length * 2, len + k));
    next.set(buf.subarray(0, len));
    buf = next;
  };
  return {
    byte(b) {
      room(1);
      buf[len++] = b;
    },
    u16(v) {
      room(2);
      buf[len++] = v & 255;
      buf[len++] = (v >> 8) & 255;
    },
    put(arr) {
      room(arr.length);
      buf.set(arr, len);
      len += arr.length;
    },
    ascii(s) {
      for (const ch of s) this.byte(ch.charCodeAt(0));
    },
    get length() {
      return len;
    },
    done: () => buf.slice(0, len),
  };
}

// GIF's LZW, as the code stream before it is cut into sub-blocks. Codes grow from minCodeSize+1
// bits to 12; when all 4096 are taken, a clear code starts the table over. The table is indexed
// by prefix code and pixel, and stamped with a generation, so a clear costs nothing.
const LZW_SLOTS = 4096 << 8;
let lzwStamp = null;
let lzwCode = null;
let lzwGen = 0;

function lzwEncode(pixels, minCodeSize = 8) {
  if (!lzwStamp) {
    lzwStamp = new Uint32Array(LZW_SLOTS);
    lzwCode = new Uint16Array(LZW_SLOTS);
  }
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const out = bytes(Math.max(64, pixels.length >> 1));
  let size = minCodeSize + 1;
  let next = eoi + 1;
  let acc = 0;
  let bits = 0;
  const emit = (code) => {
    acc |= code << bits;
    bits += size;
    while (bits >= 8) {
      out.byte(acc & 255);
      acc >>>= 8;
      bits -= 8;
    }
  };
  const gen = () => (lzwGen = (lzwGen + 1) >>> 0 || 1);
  let stamp = gen();
  emit(clear);
  if (!pixels.length) {
    emit(eoi);
    if (bits) out.byte(acc & 255);
    return out.done();
  }
  let prefix = pixels[0];
  for (let i = 1; i < pixels.length; i++) {
    const k = pixels[i];
    const slot = (prefix << 8) | k;
    if (lzwStamp[slot] === stamp) {
      prefix = lzwCode[slot];
      continue;
    }
    emit(prefix);
    if (next === 4096) {
      emit(clear);
      stamp = gen();
      next = eoi + 1;
      size = minCodeSize + 1;
    } else {
      // The decoder adds each entry one code later, so the width grows as the entry that needs
      // it is made, not after.
      if (next >= 1 << size) size++;
      lzwStamp[slot] = stamp;
      lzwCode[slot] = next++;
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  if (bits) out.byte(acc & 255);
  return out.done();
}

// A GIF of width x height frames that loops forever. add() takes each frame's RGBA pixels and
// how long it shows, in ms; end() answers the file. A frame that comes out the same as the one
// before, once mapped to the palette, only lengthens that one.
function createGif(width, height, palette, { loop = 0 } = {}) {
  const colors = Math.min(MAX_COLORS, Math.floor(palette.length / 3));
  const table = new Uint8Array(256 * 3);
  table.set(palette.subarray(0, colors * 3));
  const nearest = nearestMap(table.subarray(0, colors * 3));
  const out = bytes(1 << 16);
  out.ascii("GIF89a");
  out.u16(width);
  out.u16(height);
  out.byte(0xf7); // a global table of 256 colors, 8 bits each
  out.byte(0); // background color
  out.byte(0); // square pixels
  out.put(table);
  out.put([0x21, 0xff, 0x0b]);
  out.ascii("NETSCAPE2.0");
  out.put([0x03, 0x01]);
  out.u16(loop);
  out.byte(0);

  let shown = null; // the palette indexes on screen after the last frame
  let pending = null; // the last frame, held until its delay is final

  const write = (f) => {
    const cs = Math.max(2, Math.min(65535, Math.round(f.delay / 10)));
    // Graphic control: each frame stays under the next (disposal 1), transparent where unchanged.
    out.put([0x21, 0xf9, 0x04, (1 << 2) | (f.transparent ? 1 : 0)]);
    out.u16(cs);
    out.byte(f.transparent ? TRANSPARENT : 0);
    out.byte(0);
    out.byte(0x2c);
    out.u16(f.x);
    out.u16(f.y);
    out.u16(f.w);
    out.u16(f.h);
    out.byte(0); // no local table, not interlaced
    out.byte(8);
    const data = lzwEncode(f.pixels, 8);
    for (let i = 0; i < data.length; i += 255) {
      const n = Math.min(255, data.length - i);
      out.byte(n);
      out.put(data.subarray(i, i + n));
    }
    out.byte(0);
  };

  return {
    add(rgba, delay) {
      const px = new Uint8Array(width * height);
      for (let i = 0, p = 0; i < px.length; i++, p += 4) px[i] = nearest(rgba[p], rgba[p + 1], rgba[p + 2]);
      if (!shown) {
        shown = px;
        pending = { x: 0, y: 0, w: width, h: height, pixels: px, delay, transparent: false };
        return;
      }
      let x0 = width;
      let y0 = height;
      let x1 = -1;
      let y1 = -1;
      for (let y = 0, i = 0; y < height; y++) {
        for (let x = 0; x < width; x++, i++) {
          if (px[i] === shown[i]) continue;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          y1 = y;
        }
      }
      if (x1 < 0) {
        pending.delay += delay;
        return;
      }
      write(pending);
      const w = x1 - x0 + 1;
      const h = y1 - y0 + 1;
      const pixels = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y0 + y) * width + x0 + x;
          pixels[y * w + x] = px[i] === shown[i] ? TRANSPARENT : px[i];
        }
      }
      shown = px;
      pending = { x: x0, y: y0, w, h, pixels, delay, transparent: true };
    },
    end() {
      if (pending) write(pending);
      pending = null;
      out.byte(0x3b);
      return out.done();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The worker. panel.js sends the kept frames, each { url, masks, delay }: a JPEG data URL, the
// masked fields' boxes as fractions of the viewport ({ x, y, width, height, label }), and how
// long it shows. Every frame is drawn at the first one's size with its bars over it before
// anything is sampled or encoded, so no pixel of a masked field reaches the GIF. Answers
// { blob } or { error }.

const BAR = "#1c1b22"; // the page's own bar colors (actor-child.sys.mjs)
const BAR_INK = "#fbfbfe";
const SAMPLE_FRAMES = 24;
const SAMPLE_PIXELS = 120_000;

async function decodeFrame(url) {
  const [head, data] = String(url).split(",", 2);
  const bin = atob(data);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return createImageBitmap(new Blob([buf], { type: /^data:([^;,]+)/.exec(head)?.[1] ?? "image/jpeg" }));
}

// Draws a frame fitted into the canvas, then its bars, and answers the pixels.
function drawFrame(ctx, image, masks) {
  const { width: W, height: H } = ctx.canvas;
  const k = Math.min(W / image.width, H / image.height);
  const box = { x: (W - image.width * k) / 2, y: (H - image.height * k) / 2, w: image.width * k, h: image.height * k };
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(image, box.x, box.y, box.w, box.h);
  for (const m of masks ?? []) {
    // Rounded outward, so a partly covered pixel is covered.
    const x0 = Math.max(0, Math.floor(box.x + m.x * box.w));
    const y0 = Math.max(0, Math.floor(box.y + m.y * box.h));
    const x1 = Math.min(W, Math.ceil(box.x + (m.x + m.width) * box.w));
    const y1 = Math.min(H, Math.ceil(box.y + (m.y + m.height) * box.h));
    if (x1 <= x0 || y1 <= y0) continue;
    ctx.fillStyle = BAR;
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    if (m.label && y1 - y0 >= 11 && x1 - x0 >= 40) {
      try {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0, y0, x1 - x0, y1 - y0);
        ctx.clip();
        ctx.font = "9px system-ui, sans-serif";
        ctx.textBaseline = "middle";
        ctx.fillStyle = BAR_INK;
        ctx.fillText(String(m.label), x0 + 4, (y0 + y1) / 2);
      } catch {
        // the bar is what matters; its label is a nicety
      } finally {
        ctx.restore();
      }
    }
  }
  return ctx.getImageData(0, 0, W, H).data;
}

async function camGif(frames) {
  if (!frames?.length) throw new Error("No frames to save.");
  const first = await decodeFrame(frames[0].url);
  const canvas = new OffscreenCanvas(first.width, first.height);
  first.close();
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const render = async (f) => {
    const image = await decodeFrame(f.url);
    try {
      return drawFrame(ctx, image, f.masks);
    } finally {
      image.close();
    }
  };
  // The palette, from pixels of up to SAMPLE_FRAMES frames spread over the GIF.
  const picks = Math.min(SAMPLE_FRAMES, frames.length);
  const every = Math.max(1, Math.floor((canvas.width * canvas.height * picks) / SAMPLE_PIXELS));
  const samples = [];
  for (let j = 0; j < picks; j++) {
    const rgba = await render(frames[Math.floor((j * frames.length) / picks)]);
    for (let p = 0; p < rgba.length; p += 4 * every) samples.push(rgba[p], rgba[p + 1], rgba[p + 2]);
  }
  const gif = createGif(canvas.width, canvas.height, medianCut(Uint8Array.from(samples)));
  for (const f of frames) gif.add(await render(f), f.delay);
  return new Blob([gif.end()], { type: "image/gif" });
}

if (typeof module !== "undefined") module.exports = { medianCut, lzwEncode, createGif, camGif, TRANSPARENT };
else if (typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope) {
  self.onmessage = ({ data }) =>
    camGif(data?.frames).then(
      (blob) => self.postMessage({ blob }),
      (e) => self.postMessage({ error: e?.message ?? String(e) }),
    );
}
