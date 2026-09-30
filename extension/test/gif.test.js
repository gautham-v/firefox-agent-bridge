"use strict";

// The agent cam's GIF encoder (extension/sidebar/gif.js): its LZW against a textbook decoder, the
// palette, and whole files read back block by block and played onto a screen.
const test = require("node:test");
const assert = require("node:assert/strict");
const { medianCut, lzwEncode, createGif, TRANSPARENT } = require("../sidebar/gif.js");

// A GIF LZW decoder written the way decoders are, not from the encoder.
function lzwDecode(data, minCodeSize) {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let size = minCodeSize + 1;
  let table = [];
  const reset = () => {
    table = [];
    for (let i = 0; i < clear; i++) table.push([i]);
    table.push(null, null);
    size = minCodeSize + 1;
  };
  reset();
  const out = [];
  let prev = null;
  let pos = 0;
  const read = () => {
    let code = 0;
    for (let i = 0; i < size; i++, pos++) {
      if (pos >> 3 >= data.length) return eoi;
      code |= ((data[pos >> 3] >> (pos & 7)) & 1) << i;
    }
    return code;
  };
  for (;;) {
    const code = read();
    if (code === clear) {
      reset();
      prev = null;
      continue;
    }
    if (code === eoi) break;
    let entry;
    if (prev == null) entry = table[code];
    else {
      entry = code < table.length ? table[code] : [...table[prev], table[prev][0]];
      assert.ok(entry, `code ${code} is in the table`);
      if (table.length < 4096) table.push([...table[prev], entry[0]]);
    }
    out.push(...entry);
    if (table.length === 1 << size && size < 12) size++;
    prev = code;
  }
  return Uint8Array.from(out);
}

// Reads a GIF's blocks and plays its frames onto a screen of palette indexes.
function decodeGif(buf) {
  let p = 0;
  const u8 = () => buf[p++];
  const u16 = () => buf[p++] | (buf[p++] << 8);
  const ascii = (n) => String.fromCharCode(...buf.subarray(p, (p += n)));
  const gif = { frames: [], loop: null };
  gif.signature = ascii(6);
  gif.width = u16();
  gif.height = u16();
  const packed = u8();
  p += 2;
  assert.ok(packed & 0x80, "has a global color table");
  const colors = 2 << (packed & 7);
  gif.palette = buf.subarray(p, (p += colors * 3));
  const screen = new Uint8Array(gif.width * gif.height);
  const blocks = () => {
    const parts = [];
    for (let n = u8(); n; n = u8()) parts.push(...buf.subarray(p, (p += n)));
    return Uint8Array.from(parts);
  };
  let control = null;
  for (;;) {
    const b = u8();
    if (b === 0x3b) break;
    if (b === 0x21) {
      const label = u8();
      if (label === 0xf9) {
        const body = blocks();
        control = { disposal: (body[0] >> 2) & 7, transparent: body[0] & 1 ? body[3] : null, delay: body[1] | (body[2] << 8) };
      } else if (label === 0xff) {
        const n = u8();
        const id = ascii(n);
        const body = blocks();
        if (id === "NETSCAPE2.0") gif.loop = body[1] | (body[2] << 8);
      } else blocks();
      continue;
    }
    assert.equal(b, 0x2c, `an image descriptor at byte ${p - 1}`);
    const f = { x: u16(), y: u16(), w: u16(), h: u16(), ...control };
    assert.equal(u8() & 0x80, 0, "no local color table");
    const minCodeSize = u8();
    const pixels = lzwDecode(blocks(), minCodeSize);
    f.pixels = pixels;
    assert.equal(pixels.length, f.w * f.h, "the frame decodes to its size");
    for (let y = 0; y < f.h; y++) {
      for (let x = 0; x < f.w; x++) {
        const v = pixels[y * f.w + x];
        if (v !== f.transparent) screen[(f.y + y) * gif.width + f.x + x] = v;
      }
    }
    f.screen = screen.slice();
    gif.frames.push(f);
    control = null;
  }
  assert.equal(p, buf.length, "the trailer ends the file");
  return gif;
}

// The screen's colors as [r, g, b] per pixel.
const colorsOf = (gif, screen) => [...screen].map((i) => [...gif.palette.subarray(i * 3, i * 3 + 3)]);

function rgbaOf(w, h, at) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = at(x, y);
      out.set([r, g, b, 255], (y * w + x) * 4);
    }
  }
  return out;
}

const seeded = (seed) => () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 8) / 16777216;

test("LZW round-trips short, repetitive and table-filling input", () => {
  const rnd = seeded(7);
  const cases = [
    new Uint8Array([]),
    new Uint8Array([42]),
    new Uint8Array(5000).fill(3),
    Uint8Array.from({ length: 3000 }, (_, i) => i % 7),
    // random bytes fill the 4096-code table many times over, so clears are exercised
    Uint8Array.from({ length: 200_000 }, () => Math.floor(rnd() * 256)),
    Uint8Array.from({ length: 50_000 }, () => (rnd() < 0.9 ? 0 : Math.floor(rnd() * 255))),
  ];
  for (const input of cases) assert.deepEqual(lzwDecode(lzwEncode(input, 8), 8), input, `${input.length} pixels`);
  const small = Uint8Array.from({ length: 20_000 }, () => Math.floor(rnd() * 4));
  assert.deepEqual(lzwDecode(lzwEncode(small, 2), 2), small, "a 2-bit alphabet");
  // Repetition compresses.
  assert.ok(lzwEncode(new Uint8Array(100_000), 8).length < 1000);
});

test("the palette is exact for a few colors and capped at 255 for many", () => {
  const few = [
    [255, 255, 255],
    [28, 27, 34],
    [117, 66, 229],
    [0, 0, 0],
  ];
  const samples = Uint8Array.from(Array.from({ length: 400 }, (_, i) => few[i % 4]).flat());
  const pal = medianCut(samples);
  const got = [];
  for (let i = 0; i < pal.length; i += 3) got.push([...pal.subarray(i, i + 3)]);
  assert.deepEqual(got.map(String).sort(), few.map(String).sort());

  const rnd = seeded(3);
  const many = Uint8Array.from({ length: 30_000 * 3 }, () => Math.floor(rnd() * 256));
  assert.equal(medianCut(many).length, 255 * 3);
  assert.equal(medianCut(many, 16).length, 16 * 3);
  assert.equal(medianCut(new Uint8Array(0)).length, 3, "no samples still gives a color");
});

test("a GIF reads back: header, loop, delays, and each frame only the box that changed", () => {
  const W = 20;
  const H = 12;
  const white = [255, 255, 255];
  const ink = [28, 27, 34];
  const accent = [117, 66, 229];
  const base = (x, y) => (y === 5 && x > 2 && x < 17 ? ink : white);
  const moved = (x, y) => (x >= 8 && x <= 10 && y >= 2 && y <= 3 ? accent : base(x, y));
  const frames = [rgbaOf(W, H, base), rgbaOf(W, H, moved), rgbaOf(W, H, moved), rgbaOf(W, H, base)];
  const samples = Uint8Array.from([white, ink, accent].flat());
  const gif = createGif(W, H, medianCut(samples));
  gif.add(frames[0], 400);
  gif.add(frames[1], 400);
  gif.add(frames[2], 800); // the same as the one before: it only lengthens it
  gif.add(frames[3], 2000);
  const file = gif.end();
  const out = decodeGif(file);

  assert.equal(out.signature, "GIF89a");
  assert.equal(out.width, W);
  assert.equal(out.height, H);
  assert.equal(out.loop, 0, "loops forever");
  assert.deepEqual(out.frames.map((f) => f.delay), [40, 120, 200], "delays in hundredths, the repeat folded in");
  assert.deepEqual(out.frames.map((f) => [f.x, f.y, f.w, f.h]), [
    [0, 0, W, H],
    [8, 2, 3, 2],
    [8, 2, 3, 2],
  ]);
  assert.deepEqual(out.frames.map((f) => f.transparent), [null, TRANSPARENT, TRANSPARENT]);
  assert.ok(out.frames.every((f) => f.disposal === 1), "each frame stays under the next");
  const expect = [base, moved, base];
  out.frames.forEach((f, n) => {
    const want = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) want.push(expect[n](x, y));
    assert.deepEqual(colorsOf(out, f.screen), want, `frame ${n} plays back exactly`);
  });
});

test("many colors are mapped to near ones, and a frame's unchanged pixels go transparent", () => {
  const W = 96;
  const H = 64;
  const grad = (x, y) => [x * 2.6, y * 4, (x + y) * 1.5].map((v) => Math.round(v) & 255);
  const box = (x, y) => (x >= 40 && x < 60 && y >= 20 && y < 30 ? [255, 255, 255] : grad(x, y));
  const a = rgbaOf(W, H, grad);
  const b = rgbaOf(W, H, box);
  const samples = [];
  for (const f of [a, b]) for (let p = 0; p < f.length; p += 4) samples.push(f[p], f[p + 1], f[p + 2]);
  const gif = createGif(W, H, medianCut(Uint8Array.from(samples)));
  gif.add(a, 100);
  gif.add(b, 100);
  const out = decodeGif(gif.end());
  assert.equal(out.frames.length, 2);
  const [, second] = out.frames;
  assert.deepEqual([second.x, second.y, second.w, second.h], [40, 20, 20, 10]);
  assert.ok(second.pixels.every((v) => v !== TRANSPARENT), "the whole box changed");
  let err = 0;
  const shown = colorsOf(out, out.frames[1].screen);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) err += Math.hypot(...box(x, y).map((v, c) => v - shown[y * W + x][c]));
  assert.ok(err / (W * H) < 12, `mean color error ${(err / (W * H)).toFixed(1)}`);
});

// The worker's part, with a canvas that paints solid rectangles and scales images by nearest
// pixel, and "JPEGs" that are JSON: a light page, a red logo that isn't masked, and a red field
// that is.
class FakeCanvas {
  constructor(width, height) {
    Object.assign(this, { width, height, px: new Uint8ClampedArray(width * height * 4) });
  }
  getContext() {
    const canvas = this;
    const paint = (x, y, [r, g, b]) => x >= 0 && y >= 0 && x < canvas.width && y < canvas.height && canvas.px.set([r, g, b, 255], (y * canvas.width + x) * 4);
    const hex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
    return {
      canvas,
      fillStyle: "#000000",
      fillRect(x, y, w, h) {
        for (let j = Math.round(y); j < Math.round(y + h); j++) for (let i = Math.round(x); i < Math.round(x + w); i++) paint(i, j, hex(this.fillStyle));
      },
      drawImage(img, x, y, w, h) {
        for (let j = Math.round(y); j < Math.round(y + h); j++) {
          for (let i = Math.round(x); i < Math.round(x + w); i++) paint(i, j, img.at(Math.floor(((i - x) * img.width) / w), Math.floor(((j - y) * img.height) / h)));
        }
      },
      getImageData: () => ({ data: canvas.px.slice() }),
      save() {},
      restore() {},
      beginPath() {},
      rect() {},
      clip() {},
      fillText() {},
    };
  }
}

const RED = [230, 20, 30];
const LOGO = { x: 2, y: 2, w: 6, h: 4 };
const inBox = (x, y, b) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h;
const fakeShot = (w, h, field) => `data:image/jpeg;base64,${Buffer.from(JSON.stringify({ w, h, field })).toString("base64")}`;
async function fakeBitmap(blob) {
  const { w, h, field } = JSON.parse(await blob.text());
  const k = w / 80; // boxes are in an 80-wide shot's pixels
  const at = (x, y) => (inBox(x / k, y / k, field) || inBox(x / k, y / k, LOGO) ? RED : [250, 250, 250]);
  return { width: w, height: h, at, close() {} };
}

test("the worker covers every masked field before anything is sampled or encoded", async (t) => {
  Object.assign(globalThis, { OffscreenCanvas: FakeCanvas, createImageBitmap: fakeBitmap });
  t.after(() => {
    delete globalThis.OffscreenCanvas;
    delete globalThis.createImageBitmap;
  });
  const { camGif } = require("../sidebar/gif.js");
  const W = 80;
  const H = 50;
  const box = (b) => ({ x: b.x / W, y: b.y / H, width: b.w / W, height: b.h / H, label: "password · filled" });
  const f1 = { x: 20, y: 10, w: 30, h: 8 };
  const f2 = { x: 20, y: 30, w: 30, h: 8 };
  const frames = [
    { url: fakeShot(W, H, f1), masks: [box(f1)], delay: 400 },
    // twice the size, drawn at the first frame's
    { url: fakeShot(W * 2, H * 2, f2), masks: [box(f2)], delay: 400 },
    { url: fakeShot(W, H, f1), masks: [box(f1)], delay: 2000 },
  ];
  const blob = await camGif(frames);
  assert.equal(blob.type, "image/gif");
  const out = decodeGif(new Uint8Array(await blob.arrayBuffer()));
  assert.equal(out.width, W);
  assert.equal(out.height, H);
  assert.deepEqual(out.frames.map((f) => f.delay), [40, 40, 200]);
  const near = (c, want) => Math.hypot(...c.map((v, i) => v - want[i])) < 40;
  out.frames.forEach((f, n) => {
    const field = [f1, f2, f1][n];
    const shown = colorsOf(out, f.screen);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const c = shown[y * W + x];
        if (inBox(x, y, field)) assert.ok(near(c, [28, 27, 34]), `frame ${n} (${x}, ${y}) is under the bar`);
        else if (inBox(x, y, LOGO)) assert.ok(near(c, RED), "the logo, not masked, keeps its red");
        else assert.ok(!near(c, RED), `frame ${n} (${x}, ${y}) shows no field`);
      }
    }
  });
  await assert.rejects(camGif([]), /No frames/);
});
