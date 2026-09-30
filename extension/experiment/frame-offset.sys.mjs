// Where a child frame's viewport sits in the top frame's viewport (the one screenshots and clicks
// use), as an offset: a point (x, y) in the frame's viewport, in its CSS pixels, is at
// (offset.x + offset.scale * x, offset.y + offset.scale * y) in the top frame's, in its CSS
// pixels. background.js turns those into screenshot pixels with its frame scale, which carries
// the tab zoom, as it does for the top frame's own coordinates.
//
// A frame's own mozInnerScreenX/Y can't be used for this: in an out-of-process frame (MDN's live
// examples, a cross-origin iframe in a shadow root) it read about (8, 46) while the frame sat at
// (826, 357) in the top page, so find, scroll_to and read_page put its elements off-screen.
// Instead each frame is placed by its <iframe> element's content box, measured by the actor in
// the document that holds the element (which is in the frame's parent's process, so this works
// across processes), and the boxes are chained frame by frame up to the top. The measure is
// passed in, so node tests run the chaining with mocked frames.

export const IDENTITY = Object.freeze({ x: 0, y: 0, scale: 1 });

// A frame element's content box in its document's viewport, and how much it is scaled there (CSS
// zoom on the element or an ancestor, a transform): the frame's CSS pixels times `scale` are its
// document's. Getting the layout size from the computed style rather than offsetWidth keeps
// fractional sizes, so an unscaled frame measures exactly 1. Borders and padding are in the
// element's own (unscaled) pixels, so they are scaled too.
export function contentBox(el) {
  const win = el.ownerDocument.defaultView;
  const cs = win.getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const num = (v) => parseFloat(v) || 0;
  const padLeft = num(cs.paddingLeft);
  const padTop = num(cs.paddingTop);
  const edgesX = num(cs.borderLeftWidth) + num(cs.borderRightWidth) + padLeft + num(cs.paddingRight);
  const edgesY = num(cs.borderTopWidth) + num(cs.borderBottomWidth) + padTop + num(cs.paddingBottom);
  const layout = (value, edges, fallback) => {
    const v = parseFloat(value);
    if (!(v > 0)) return fallback;
    return cs.boxSizing === "border-box" ? v : v + edges;
  };
  const width = layout(cs.width, edgesX, el.offsetWidth);
  const height = layout(cs.height, edgesY, el.offsetHeight);
  let scale = width > 0 && r.width > 0 ? r.width / width : height > 0 && r.height > 0 ? r.height / height : 1;
  if (!(scale > 0) || Math.abs(scale - 1) < 1e-3) scale = 1;
  return {
    x: r.left + scale * (num(el.clientLeft) + padLeft),
    y: r.top + scale * (num(el.clientTop) + padTop),
    scale,
  };
}

// A point in a frame's viewport, given in its parent's viewport's pixels.
export function toParent(box, x, y) {
  return { x: box.x + box.scale * x, y: box.y + box.scale * y };
}

// The offset of a frame inside a frame whose own offset is `outer`.
export function compose(outer, inner) {
  return { x: outer.x + outer.scale * inner.x, y: outer.y + outer.scale * inner.y, scale: outer.scale * inner.scale };
}

// A rect { x, y, width, height } in a frame's viewport, in the top frame's.
export function rectToTop(offset, r) {
  return { ...r, x: offset.x + offset.scale * r.x, y: offset.y + offset.scale * r.y, width: offset.scale * r.width, height: offset.scale * r.height };
}

// One frame's offset. `bc` is a BrowsingContext (or anything with .id and .parent);
// measure(parent, childId) answers the content box of the element holding frame childId in
// parent's document (contentBox's shape), or null when it can't. The boxes up the chain are
// measured at once. Null when any of them can't be measured (a frame not rendered, or going away).
export async function frameOffset(bc, measure) {
  const chain = [];
  for (let c = bc; c?.parent; c = c.parent) chain.unshift(c);
  const boxes = await Promise.all(chain.map((c) => Promise.resolve(measure(c.parent, c.id)).catch(() => null)));
  let at = IDENTITY;
  for (const box of boxes) {
    if (!validBox(box)) return null;
    at = compose(at, box);
  }
  return at;
}

// The offset of every frame under `top` (a BrowsingContext, whose getAllBrowsingContextsInSubtree
// includes itself), by frame id. Each frame's box is measured once, all at once, and chained from
// the top down. A frame whose box, or an ancestor's, can't be measured maps to null.
export async function frameOffsets(top, measure) {
  const all = top.getAllBrowsingContextsInSubtree();
  const boxes = new Map(
    await Promise.all(all.filter((c) => c !== top && c.parent).map(async (c) => [c.id, await Promise.resolve(measure(c.parent, c.id)).catch(() => null)])),
  );
  const out = new Map([[top.id, IDENTITY]]);
  const place = (c) => {
    if (out.has(c.id)) return out.get(c.id);
    const outer = c.parent ? place(c.parent) : null;
    const box = boxes.get(c.id);
    const at = outer && validBox(box) ? compose(outer, box) : null;
    out.set(c.id, at);
    return at;
  };
  for (const c of all) place(c);
  return out;
}

const validBox = (b) => !!b && Number.isFinite(b.x) && Number.isFinite(b.y) && b.scale > 0;
