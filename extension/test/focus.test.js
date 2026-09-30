"use strict";

// Which focus events the actor dispatches after its own input moved focus in a document that
// doesn't have focus (experiment/focus.sys.mjs). Gecko moves focus there silently, so without
// them a field typed into never fires change on Tab or a click elsewhere.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const load = () => import(path.join(__dirname, "..", "experiment", "focus.sys.mjs"));

const el = (tagName, isConnected = true) => ({ tagName, isConnected });
const summary = (events) => events.map((e) => `${e.type}:${e.target.tagName}>${e.relatedTarget?.tagName ?? "null"}${e.bubbles ? "^" : ""}`);

test("Tab from a field to a button: blur and focusout on the field, then focus and focusin on the button", async () => {
  const { focusEvents } = await load();
  const field = el("INPUT");
  const button = el("BUTTON");
  const events = focusEvents({ hasFocus: false, from: field, to: button });
  assert.deepEqual(summary(events), ["blur:INPUT>BUTTON", "focusout:INPUT>BUTTON^", "focus:BUTTON>INPUT", "focusin:BUTTON>INPUT^"]);
  assert.equal(events[0].target, field);
  assert.equal(events[2].target, button);
});

test("a document that has focus gets nothing: Gecko fires the real events there", async () => {
  const { focusEvents } = await load();
  assert.deepEqual(focusEvents({ hasFocus: true, from: el("INPUT"), to: el("BUTTON") }), []);
});

test("focus that didn't move gets nothing, as when typing into the same field", async () => {
  const { focusEvents } = await load();
  const field = el("TEXTAREA");
  assert.deepEqual(focusEvents({ hasFocus: false, from: field, to: field }), []);
  assert.deepEqual(focusEvents({ hasFocus: false, from: null, to: null }), []);
});

test("a click on the page itself blurs the field and focuses nothing", async () => {
  const { focusEvents } = await load();
  assert.deepEqual(summary(focusEvents({ hasFocus: false, from: el("INPUT"), to: null })), ["blur:INPUT>null", "focusout:INPUT>null^"]);
});

test("a click into a field from the page focuses it, so its value when focused is recorded", async () => {
  const { focusEvents } = await load();
  assert.deepEqual(summary(focusEvents({ hasFocus: false, from: null, to: el("INPUT") })), ["focus:INPUT>null", "focusin:INPUT>null^"]);
});

test("frames: focus moving into one only blurs; the iframe element itself gets no events", async () => {
  const { focusEvents } = await load();
  assert.deepEqual(summary(focusEvents({ hasFocus: false, from: el("INPUT"), to: el("IFRAME") })), ["blur:INPUT>null", "focusout:INPUT>null^"]);
  assert.deepEqual(summary(focusEvents({ hasFocus: false, from: el("FRAME"), to: el("INPUT") })), ["focus:INPUT>null", "focusin:INPUT>null^"]);
});

test("an element removed before focus left it gets no blur", async () => {
  const { focusEvents } = await load();
  assert.deepEqual(summary(focusEvents({ hasFocus: false, from: el("INPUT", false), to: el("BUTTON") })), ["focus:BUTTON>null", "focusin:BUTTON>null^"]);
});
