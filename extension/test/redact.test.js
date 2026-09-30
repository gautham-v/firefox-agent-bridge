"use strict";

// Rule matching and text masking from experiment/redact.sys.mjs, which the actor uses to decide
// which fields are masked and what the agent reads in their place.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const load = () => import(path.join(__dirname, "..", "experiment", "redact.sys.mjs"));

const RULES = { always: ["password", "cc-*", "one-time-code", "new-password", "current-password"], sites: { "chase.com": [".account-number", "#routing"] } };

test("the always rules match input types and autocomplete tokens, with cc-* covering every card field", async () => {
  const { fieldKind } = await load();
  assert.equal(fieldKind(RULES, { tag: "INPUT", type: "password", autocomplete: null }), "password");
  assert.equal(fieldKind(RULES, { tag: "INPUT", type: "password", autocomplete: "current-password" }), "current-password");
  assert.equal(fieldKind(RULES, { tag: "INPUT", type: "text", autocomplete: "billing cc-number" }), "cc-number");
  assert.equal(fieldKind(RULES, { tag: "SELECT", type: "select-one", autocomplete: "CC-EXP-MONTH" }), "cc-exp-month");
  assert.equal(fieldKind(RULES, { tag: "INPUT", type: "text", autocomplete: "one-time-code" }), "one-time-code");
  assert.equal(fieldKind(RULES, { tag: "INPUT", type: "email", autocomplete: "email" }), null);
  assert.equal(fieldKind(RULES, { tag: "INPUT", type: "hidden", autocomplete: null }), null);
  // A type only counts on an input.
  assert.equal(fieldKind({ always: ["password"] }, { tag: "TEXTAREA", type: "password", autocomplete: "" }), null);
  assert.equal(fieldKind({ always: [] }, { tag: "INPUT", type: "password", autocomplete: "" }), null);
  assert.equal(fieldKind(undefined, { tag: "INPUT", type: "password", autocomplete: "" }), null);
});

test("site selectors apply to the site and its subdomains only", async () => {
  const { siteSelectors, selectorKind } = await load();
  assert.deepEqual(siteSelectors(RULES, "chase.com"), [".account-number", "#routing"]);
  assert.deepEqual(siteSelectors(RULES, "secure.chase.com"), [".account-number", "#routing"]);
  assert.deepEqual(siteSelectors(RULES, "notchase.com"), []);
  assert.deepEqual(siteSelectors(RULES, ""), []);
  assert.equal(selectorKind(".account-number"), "account-number");
  assert.equal(selectorKind("#routing"), "routing");
  assert.equal(selectorKind("div.balance > span"), "site rule");
});

test("markers and bar labels say what the field is and whether it's filled", async () => {
  const { marker, barLabel } = await load();
  assert.equal(marker("cc-number", true), "[redacted: cc-number, filled]");
  assert.equal(marker("password", false), "[redacted: password, empty]");
  assert.equal(barLabel("cc-number", true), "card number · filled");
  assert.equal(barLabel("cc-csc", true), "cvc · filled");
  assert.equal(barLabel("account-number", false), "account number · empty");
});

test("scrub replaces masked text wherever it appears; short text only as a word of its own", async () => {
  const { scrub } = await load();
  const card = { text: "4242 4242 4242 4242", marker: "[redacted: cc-number, filled]", echo: true };
  const acct = { text: "1234 5678 90", marker: "[redacted: account-number, filled]", echo: false };
  const branch = { text: "12", marker: "[redacted: branch, filled]", echo: false };
  const cvc = { text: "314", marker: "[redacted: cc-csc, filled]", echo: true };
  const out = scrub("Card 4242 4242 4242 4242 ends in 4242. Checking1234 5678 90 at branch 12, not 112. Total $314.00", [card, acct, branch, cvc]);
  assert.equal(out.text, "Card [redacted: cc-number, filled] ends in 4242. Checking[redacted: account-number, filled] at branch [redacted: branch, filled], not 112. Total $314.00");
  assert.deepEqual([...out.hits].sort(), [0, 1, 2]);
  // A short field value is only masked where the field itself is shown, never looked for elsewhere.
  assert.equal(scrub("CVC 314", [cvc]).text, "CVC 314");
  // Regex characters are literal, and a longer secret wins over one it contains.
  const pw = { text: "p4$$(w0rd)", marker: "[redacted: password, filled]", echo: true };
  const part = { text: "p4$$", marker: "[x]", echo: true };
  assert.equal(scrub("was p4$$(w0rd) here", [part, pw]).text, "was [redacted: password, filled] here");
  // A marker already written isn't matched again.
  const word = { text: "filled", marker: "[y]", echo: true };
  assert.equal(scrub("4242 4242 4242 4242", [card, word]).text, "[redacted: cc-number, filled]");
  assert.deepEqual(scrub("nothing here", []), { text: "nothing here", hits: new Set() });
});

test("page text marks masked fields after the line that is their label", async () => {
  const { markLabels } = await load();
  const text = "Checkout\nEmail\ngautham@example.com\nCard number\nExpiry\nCVC\nPay";
  const out = markLabels(text, [
    { label: "Card  number", marker: "[redacted: cc-number, filled]" },
    { label: "Expiry", marker: "[redacted: cc-exp, filled]" },
    { label: "Nowhere", marker: "[redacted: cc-csc, empty]" },
  ]);
  assert.equal(out.text, "Checkout\nEmail\ngautham@example.com\nCard number  [redacted: cc-number, filled]\nExpiry  [redacted: cc-exp, filled]\nCVC\nPay");
  assert.deepEqual([...out.hits], [0, 1]);
});
