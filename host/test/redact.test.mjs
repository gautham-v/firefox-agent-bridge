// The redaction rules file the host reads and passes to the extension.
//   node --test host/test/*.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DEFAULT_RULES, createRedactRules, normalizeRules } from "../redact.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fab-redact-"));

test("rules are normalized: lowercase tokens, site keys without www., selectors as lists", () => {
  assert.deepEqual(normalizeRules({ always: [" CC-* ", "password", "password", 3, ""], sites: { "www.Chase.com": ".account-number", "*.bank.example": [".a", " ", ".b"], "empty.com": [] } }), {
    always: ["cc-*", "password"],
    sites: { "chase.com": [".account-number"], "bank.example": [".a", ".b"] },
  });
  // No `always` is the defaults; an empty one masks nothing everywhere.
  assert.deepEqual(normalizeRules({ sites: {} }).always, DEFAULT_RULES.always);
  assert.deepEqual(normalizeRules({ always: [] }).always, []);
  assert.deepEqual(normalizeRules(null), { always: DEFAULT_RULES.always, sites: {} });
  assert.deepEqual(normalizeRules({ sites: { __proto__: [".x"] } }).sites, {});
  const proto = normalizeRules(JSON.parse('{"sites": {"__proto__": [".x"]}}')).sites;
  assert.deepEqual(Object.keys(proto), ["__proto__"]);
  assert.equal(Object.getPrototypeOf(proto), Object.prototype);
});

test("a missing file is written with the defaults (0600), and an edit is picked up once", () => {
  const dir = tmp();
  const file = path.join(dir, "redact.json");
  const logs = [];
  const r = createRedactRules(file, (m) => logs.push(m));
  assert.deepEqual(r.load(), DEFAULT_RULES);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), DEFAULT_RULES);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(r.changed(), null);

  fs.writeFileSync(file, JSON.stringify({ always: ["password"], sites: { "chase.com": [".account-number"] } }));
  assert.deepEqual(r.changed(), { always: ["password"], sites: { "chase.com": [".account-number"] } });
  assert.equal(r.changed(), null);

  // Broken JSON falls back to the defaults rather than masking nothing.
  fs.writeFileSync(file, "{ always: [");
  assert.deepEqual(r.changed(), DEFAULT_RULES);
  assert.ok(logs.some((l) => /using the default redaction rules/.test(l)));
  fs.rmSync(dir, { recursive: true, force: true });
});
