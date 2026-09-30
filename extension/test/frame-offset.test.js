"use strict";

// Where a child frame sits in the top frame's viewport (experiment/frame-offset.sys.mjs): the
// <iframe>'s content box, measured in the document holding it, chained up to the top. Frames are
// mocked as { id, parent } browsing contexts and the measure answers from a table, as the actors
// would.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const load = () => import(path.join(__dirname, "..", "experiment", "frame-offset.sys.mjs"));

// A frame element as contentBox reads it: its bounding rect in its document's viewport (after
// zoom and transforms), its computed style (unscaled), clientLeft/Top (its borders).
function iframe({ rect, width, height, border = 0, padding = [0, 0, 0, 0], boxSizing = "content-box", offsetWidth, offsetHeight }) {
  const [pt, pr, pb, pl] = padding;
  const style = {
    boxSizing,
    width: typeof width === "number" ? `${width}px` : width,
    height: typeof height === "number" ? `${height}px` : height,
    paddingTop: `${pt}px`,
    paddingRight: `${pr}px`,
    paddingBottom: `${pb}px`,
    paddingLeft: `${pl}px`,
    borderTopWidth: `${border}px`,
    borderRightWidth: `${border}px`,
    borderBottomWidth: `${border}px`,
    borderLeftWidth: `${border}px`,
  };
  return {
    ownerDocument: { defaultView: { getComputedStyle: () => style } },
    getBoundingClientRect: () => ({ left: rect[0], top: rect[1], width: rect[2], height: rect[3] }),
    clientLeft: border,
    clientTop: border,
    offsetWidth: offsetWidth ?? 0,
    offsetHeight: offsetHeight ?? 0,
  };
}

// Browsing contexts: ids with parents; getAllBrowsingContextsInSubtree on the top one.
function tree(spec) {
  const byId = new Map();
  for (const [id, parent] of spec) byId.set(id, { id, parent: parent == null ? null : byId.get(parent) });
  const top = byId.get(spec[0][0]);
  top.getAllBrowsingContextsInSubtree = () => [...byId.values()];
  return byId;
}

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
const closeOffset = (got, want) => {
  close(got.x, want.x);
  close(got.y, want.y);
  close(got.scale, want.scale);
};

test("an iframe's content box is its rect less its border and padding", async () => {
  const { contentBox } = await load();
  // MDN's live example: 305.4 wide at (825.6, 356.75), no border or padding.
  assert.deepEqual(contentBox(iframe({ rect: [825.6, 356.75, 305.4, 370.5], width: 305.4, height: 370.5, boxSizing: "border-box" })), { x: 825.6, y: 356.75, scale: 1 });
  // border-box: 200 wide with a 3px border and 5px/7px padding; the content starts 10px in, 8px down.
  assert.deepEqual(
    contentBox(iframe({ rect: [40, 50, 200.4, 100], width: 200.4, height: 100, border: 3, padding: [5, 7, 5, 7], boxSizing: "border-box" })),
    { x: 50, y: 58, scale: 1 },
  );
});

test("a zoomed or transformed iframe scales its border, padding and content", async () => {
  const { contentBox } = await load();
  // zoom: 2 (measured in Firefox): the rect doubles, the computed style and clientLeft don't.
  closeOffset(contentBox(iframe({ rect: [80, 100, 400.8, 200], width: 200.4, height: 100, border: 3, padding: [5, 7, 5, 7], boxSizing: "border-box" })), { x: 100, y: 116, scale: 2 });
  // content-box sizing with zoom 1.5: the layout width is 200.4 + 2*3 + 2*7 = 220.4.
  closeOffset(contentBox(iframe({ rect: [60, 75, 330.6, 186], width: 200.4, height: 100, border: 3, padding: [5, 7, 5, 7] })), { x: 75, y: 87, scale: 1.5 });
  // transform: scale(.5) from the top left corner.
  closeOffset(contentBox(iframe({ rect: [40, 50, 100.2, 50], width: 200.4, height: 100, border: 3, padding: [5, 7, 5, 7], boxSizing: "border-box" })), { x: 45, y: 54, scale: 0.5 });
});

test("a computed size that isn't a length falls back to the offset size, and a box with no size isn't scaled", async () => {
  const { contentBox } = await load();
  closeOffset(contentBox(iframe({ rect: [10, 20, 600, 300], width: "auto", height: "auto", offsetWidth: 300, offsetHeight: 150 })), { x: 10, y: 20, scale: 2 });
  closeOffset(contentBox(iframe({ rect: [10, 20, 0, 0], width: "auto", height: "auto" })), { x: 10, y: 20, scale: 1 });
});

test("a point and a rect in a frame move into the top viewport by its offset", async () => {
  const { toParent, rectToTop, compose, IDENTITY } = await load();
  assert.deepEqual(toParent({ x: 826, y: 357, scale: 1 }, 126, 68), { x: 952, y: 425 });
  assert.deepEqual(toParent({ x: 100, y: 50, scale: 2 }, 10, 5), { x: 120, y: 60 });
  assert.deepEqual(rectToTop({ x: 100, y: 50, scale: 2 }, { x: 10, y: 5, width: 30, height: 20, label: "card" }), { x: 120, y: 60, width: 60, height: 40, label: "card" });
  assert.deepEqual(compose(IDENTITY, { x: 3, y: 4, scale: 1 }), { x: 3, y: 4, scale: 1 });
});

test("a frame's offset is its iframe's content box in the top frame (MDN's live example)", async () => {
  const { frameOffset } = await load();
  // The select sat at about (905, 404) in a 1422-wide screenshot of a 1496-wide viewport, 126x68 into
  // a frame at (826, 357): the frame's own mozInnerScreen put it near (0, -77) instead.
  const bcs = tree([[1], [12, 1]]);
  const asked = [];
  const measure = (parent, id) => (asked.push([parent.id, id]), { x: 825.6, y: 356.75, scale: 1 });
  const at = await frameOffset(bcs.get(12), measure);
  assert.deepEqual(asked, [[1, 12]], "the frame's parent measures it");
  const ratio = 1422 / 1496;
  assert.deepEqual([Math.round((at.x + 126) * ratio), Math.round((at.y + 68) * ratio)], [905, 404]);
});

test("nested frames chain their boxes up to the top, scales multiplying", async () => {
  const { frameOffset } = await load();
  // top 1 > frame 12 (in a shadow root: the box is measured the same) at (100, 200), zoomed 2 >
  // frame 13 at (10, 20) in frame 12's viewport, scaled .5 > frame 14 at (4, 6) in 13's.
  const bcs = tree([[1], [12, 1], [13, 12], [14, 13]]);
  const boxes = { 12: { x: 100, y: 200, scale: 2 }, 13: { x: 10, y: 20, scale: 0.5 }, 14: { x: 4, y: 6, scale: 1 } };
  const asked = [];
  const measure = async (parent, id) => (asked.push([parent.id, id]), boxes[id]);
  assert.deepEqual(await frameOffset(bcs.get(1), measure), { x: 0, y: 0, scale: 1 }, "the top frame is where it is");
  assert.deepEqual(asked, []);
  closeOffset(await frameOffset(bcs.get(13), measure), { x: 120, y: 240, scale: 1 });
  closeOffset(await frameOffset(bcs.get(14), measure), { x: 124, y: 246, scale: 1 });
  assert.deepEqual(asked.slice(2).sort(), [[1, 12], [12, 13], [13, 14]], "each parent measures its own child");
});

test("a frame whose box, or an ancestor's, can't be measured has no offset", async () => {
  const { frameOffset, frameOffsets } = await load();
  const bcs = tree([[1], [12, 1], [13, 12], [20, 1]]);
  const measure = async (parent, id) => {
    if (id === 12) return null; // not rendered
    if (id === 20) throw new Error("Actor destroyed");
    return { x: 1, y: 2, scale: 1 };
  };
  assert.equal(await frameOffset(bcs.get(13), measure), null);
  assert.equal(await frameOffset(bcs.get(20), measure), null);
  const all = await frameOffsets(bcs.get(1), measure);
  assert.deepEqual([...all.entries()], [[1, { x: 0, y: 0, scale: 1 }], [12, null], [13, null], [20, null]]);
  assert.equal(await frameOffset(bcs.get(13), () => ({ x: NaN, y: 0, scale: 1 })), null, "a box that isn't numbers is no box");
});

test("every frame of a tab is placed with one measure each", async () => {
  const { frameOffsets } = await load();
  const bcs = tree([[1], [12, 1], [13, 12], [20, 1]]);
  const boxes = { 12: { x: 100, y: 200, scale: 2 }, 13: { x: 10, y: 20, scale: 1 }, 20: { x: 5, y: 6, scale: 1 } };
  let measures = 0;
  const all = await frameOffsets(bcs.get(1), async (parent, id) => (measures++, boxes[id]));
  assert.equal(measures, 3);
  assert.deepEqual(Object.fromEntries(all), {
    1: { x: 0, y: 0, scale: 1 },
    12: { x: 100, y: 200, scale: 2 },
    13: { x: 120, y: 240, scale: 2 },
    20: { x: 5, y: 6, scale: 1 },
  });
});
