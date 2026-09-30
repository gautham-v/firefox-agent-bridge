"use strict";

// find's ranking in one frame (experiment/find-rank.sys.mjs): one entry per element, and the
// elements with a role the query names kept even when prose outscores them.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const load = () => import(path.join(__dirname, "..", "experiment", "find-rank.sys.mjs"));

test("an element scored for its own text and for its role and name comes back once, at its better score", async () => {
  const { rankFind } = await load();
  // uitestingplayground.com/textinput, find "text input": the heading matched twice.
  const heading = { id: "h3" };
  const field = { id: "input" };
  const { sent, rest } = rankFind([
    { el: heading, score: 9, role: "heading" },
    { el: heading, score: 14.5, role: "heading" },
    { el: field, score: 8, role: "textbox", roleHit: true },
  ]);
  assert.deepEqual(sent.map((m) => [m.el.id, m.score]), [["h3", 14.5], ["input", 8]]);
  assert.deepEqual(rest, []);
});

test("a query naming a role keeps the best elements with that role when prose outscores them", async () => {
  const { rankFind } = await load();
  // find "button": list items and a label that say "button" score 7, the button (named
  // "Renamed") 4, and there are more than 8 of them.
  const prose = Array.from({ length: 10 }, (_, i) => ({ el: { id: `li${i}` }, score: 7 }));
  const button = { el: { id: "button" }, score: 4, roleHit: true };
  const far = { el: { id: "other-button" }, score: 2.5, roleHit: true };
  const { sent, rest } = rankFind([...prose, button, far]);
  assert.equal(sent.length, 10, "the best 8, then the two buttons");
  assert.deepEqual(sent.slice(8).map((m) => m.el.id), ["button", "other-button"]);
  // Behind: two list items; the buttons are sent, so not counted again.
  assert.deepEqual(rest, [7, 7]);
});

test("nothing extra when a shown match already has the role, and at most 3 extras", async () => {
  const { rankFind } = await load();
  const withHit = rankFind([
    { el: 1, score: 9, roleHit: true },
    { el: 2, score: 8 },
    { el: 3, score: 1, roleHit: true },
  ]);
  assert.deepEqual(withHit.sent.map((m) => m.el), [1, 2]);
  const many = rankFind([{ el: "text", score: 20 }, ...[1, 2, 3, 4, 5].map((i) => ({ el: `b${i}`, score: 3 - i / 10, roleHit: true }))]);
  assert.deepEqual(many.sent.map((m) => m.el), ["text", "b1", "b2", "b3"]);
});

test("the best 8 of those close to the best, and the scores of the close ones left out", async () => {
  const { rankFind } = await load();
  const { sent, rest } = rankFind([...Array.from({ length: 10 }, (_, i) => ({ el: i, score: 20 - i })), { el: "far", score: 3 }]);
  assert.deepEqual(sent.map((m) => m.el), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(rest, [12, 11]);
});
