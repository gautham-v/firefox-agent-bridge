// find's ranking of scored elements in one frame, apart from the DOM walk so node tests can run
// it. Entries are { el, score, roleHit, ... }; only el, score and roleHit are read.
//
// - One entry per element. An element can be scored twice, for its own text and for its role
//   and name (a heading is both), which showed the same line twice.
// - A query that names a role ("button", "text input") also gets the best elements with that
//   role, even when prose that mentions the word outscores them. Without this, `find "button"`
//   on a page whose instructions say "button" a dozen times left the button out.

export const FIND_MAX = 8;
export const FIND_KEEP = 0.5; // of the best score
export const FIND_ROLE_EXTRA = 3;

export function rankFind(scored, { max = FIND_MAX, keep = FIND_KEEP, roleExtra = FIND_ROLE_EXTRA } = {}) {
  const byEl = new Map();
  for (const m of scored) {
    const had = byEl.get(m.el);
    if (!had || m.score > had.score) byEl.set(m.el, m);
  }
  const kept = [...byEl.values()].sort((a, b) => b.score - a.score);
  const best = kept.length ? kept[0].score : 0;
  const close = kept.filter((m) => m.score >= Math.max(1, best * keep));
  const top = close.slice(0, max);
  const extra = top.some((m) => m.roleHit) ? [] : kept.filter((m) => m.roleHit && !top.includes(m)).slice(0, roleExtra);
  const sent = [...top, ...extra];
  return { sent, rest: close.filter((m) => !sent.includes(m)).map((m) => m.score) };
}
