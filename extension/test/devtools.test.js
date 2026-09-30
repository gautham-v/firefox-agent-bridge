"use strict";

// The devtools tool's buffers, URL scrubbing and output (devtools.js), without a browser.
// node --test extension/test/*.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { createDevtools, redactUrl, redactText, consoleLevel, sourceOf } = require("../devtools.js");

const T0 = new Date(2026, 8, 29, 12, 0, 1, 234).getTime(); // 12:00:01.234 local
const lines = (out) => out.split("\n");

test("URLs lose user:password@ and secret-looking query and fragment values, and keep the rest", () => {
  assert.equal(redactUrl("https://api.example.com/v1/items?id=3&page=2"), "https://api.example.com/v1/items?id=3&page=2");
  assert.equal(redactUrl("https://u:hunter2@example.com/x"), "https://example.com/x");
  assert.equal(
    redactUrl("https://example.com/cb?code=abc123&state=xyz&access_token=t0k&apiKey=k&X-Amz-Signature=deadbeef&password=p&zip_code=94110"),
    "https://example.com/cb?code=[redacted]&state=xyz&access_token=[redacted]&apiKey=[redacted]&X-Amz-Signature=[redacted]&password=[redacted]&zip_code=94110",
  );
  assert.equal(redactUrl("https://example.com/app#id_token=abc&scope=email"), "https://example.com/app#id_token=[redacted]&scope=email");
  assert.equal(redactUrl("https://example.com/docs#section-2"), "https://example.com/docs#section-2");
  assert.equal(redactUrl("https://example.com/?keyword=shoes&monkey=1"), "https://example.com/?keyword=shoes&monkey=1");
  assert.equal(redactUrl("https://example.com/?token="), "https://example.com/?token=", "an empty value has nothing to hide");
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
  assert.equal(redactUrl(`https://example.com/p/${jwt}`), "https://example.com/p/[redacted: jwt]");
});

test("console text has the URLs in it redacted, and JWTs and Authorization values cut out", () => {
  assert.equal(
    redactText("GET https://api.example.com/me?session=abcd failed: 401"),
    "GET https://api.example.com/me?session=[redacted] failed: 401",
  );
  assert.equal(redactText("sending Authorization: Bearer abcdefghijklmnop.qrs"), "sending Authorization: Bearer [redacted]");
  assert.equal(redactText("plain text stays"), "plain text stays");
});

test("levels: console API names map to five levels; sources drop their query", () => {
  assert.deepEqual(["warn", "error", "assert", "info", "debug", "trace", "log", "table", "warning"].map(consoleLevel), ["warning", "error", "error", "info", "debug", "debug", "log", "log", "warning"]);
  assert.equal(sourceOf("https://cdn.example.com/app.js?v=123", 41), "https://cdn.example.com/app.js:41");
  assert.equal(sourceOf("", 3), "");
});

test("console: one line per message, newest last, filtered by level and pattern, with a header saying what was left out", () => {
  const d = createDevtools();
  d.consoleBatch(5, {
    entries: [
      { level: "log", text: "boot", source: "https://a.example/app.js", line: 1, time: T0 },
      { level: "warn", text: "slow request https://a.example/api?token=s3cret", source: "https://a.example/app.js", line: 9, time: T0 + 1000 },
      { level: "error", text: "Uncaught TypeError: x is undefined", source: "https://a.example/app.js?v=2", line: 41, time: T0 + 2000 },
    ],
    dropped: 0,
  });
  assert.deepEqual(lines(d.read(5, { kind: "console" })), [
    "Tab 5 console: 3 messages. Newest last.",
    "12:00:01.234 log boot (https://a.example/app.js:1)",
    "12:00:02.234 warning slow request https://a.example/api?token=[redacted] (https://a.example/app.js:9)",
    "12:00:03.234 error Uncaught TypeError: x is undefined (https://a.example/app.js:41)",
  ]);
  assert.deepEqual(lines(d.read(5, { kind: "console", level: "warning" })), [
    "Tab 5 console: 2 messages; 1 of 3 kept didn't match level warning+. Newest last.",
    "12:00:02.234 warning slow request https://a.example/api?token=[redacted] (https://a.example/app.js:9)",
    "12:00:03.234 error Uncaught TypeError: x is undefined (https://a.example/app.js:41)",
  ]);
  assert.equal(lines(d.read(5, { kind: "console", pattern: "typeerror" }))[0], "Tab 5 console: 1 message; 2 of 3 kept didn't match pattern /typeerror/i. Newest last.");
  // The pattern runs on the redacted text, so it can't be used to probe a secret.
  assert.equal(lines(d.read(5, { kind: "console", pattern: "s3cret" }))[0], "Tab 5 console: 0 messages; 3 of 3 kept didn't match pattern /s3cret/i.");
  assert.equal(lines(d.read(5, { kind: "console", limit: 1 }))[0], "Tab 5 console: 1 message; the newest 1 of 3 that match. Newest last.");
  assert.throws(() => d.read(5, { kind: "console", pattern: "(" }), /pattern isn't a valid regular expression/);
  assert.throws(() => d.read(5, { kind: "logs" }), /kind must be/);
});

test("console: the same message from two listeners at the same moment is kept once", () => {
  const d = createDevtools();
  const e = { level: "error", text: "CORS blocked", source: "https://a.example/", line: 1, time: T0 };
  d.consoleBatch(5, { entries: [e] });
  d.consoleBatch(5, { entries: [e, { ...e, time: T0 + 1 }] });
  assert.equal(lines(d.read(5, { kind: "console" })).length, 3);
});

test("console: long messages are cut to 300 characters; clear empties the buffer", () => {
  const d = createDevtools();
  d.consoleBatch(5, { entries: [{ level: "log", text: "x".repeat(2000), time: T0 }] });
  const [, line] = lines(d.read(5, { kind: "console" }));
  assert.equal(line, `12:00:01.234 log ${"x".repeat(299)}…`);
  assert.match(d.read(5, { kind: "console", clear: true }), /^Tab 5 console: 1 message\. Newest last\. Cleared\./);
  assert.equal(d.read(5, { kind: "console" }), "Tab 5 console: 0 messages.");
});

test("the ring keeps the last 200 per kind per tab and counts what it dropped, with what frames couldn't send", () => {
  const d = createDevtools();
  const entries = Array.from({ length: 250 }, (_, i) => ({ level: "log", text: `m${i}`, time: T0 + i }));
  d.consoleBatch(5, { entries, dropped: 7 });
  const out = lines(d.read(5, { kind: "console", limit: 500 }));
  assert.equal(out[0], "Tab 5 console: 200 messages; 57 older dropped (the last 200 are kept). Newest last.");
  assert.equal(out.length, 201);
  assert.match(out[1], / m50$/);
  assert.match(out.at(-1), / m249$/);
  assert.equal(lines(d.read(5, { kind: "console" })).length, 51, "50 by default");
  assert.equal(d.read(6, { kind: "network" }), "Tab 6 network: 0 requests.", "tabs are kept apart");
});

test("network: method, status, type, size, duration and URL; redirects, failures and pending requests; onlyFailed", () => {
  const d = createDevtools();
  const start = (requestId, url, type = "xmlhttprequest", method = "GET", at = T0) => d.requestStarted({ requestId, tabId: 5, url, type, method, timeStamp: at });
  start("1", "https://a.example/", "main_frame");
  d.requestEnded({ requestId: "1", statusCode: 200, responseSize: 15360, timeStamp: T0 + 120 }, "done");
  start("2", "https://a.example/api/items?id=3&auth=x", "xmlhttprequest", "POST", T0 + 200);
  d.requestEnded({ requestId: "2", statusCode: 404, responseSize: 312, timeStamp: T0 + 245 }, "done");
  start("3", "https://cdn.example/lib.js", "script", "GET", T0 + 300);
  d.requestEnded({ requestId: "3", error: "NS_ERROR_CONNECTION_REFUSED", timeStamp: T0 + 312 }, "failed");
  start("4", "http://a.example/old", "sub_frame", "GET", T0 + 400);
  d.requestEnded({ requestId: "4", statusCode: 301, redirectUrl: "https://a.example/new?sid=9", timeStamp: T0 + 410 }, "redirect");
  start("5", "https://a.example/logo.png", "image", "GET", T0 + 500);
  d.requestEnded({ requestId: "5", statusCode: 200, fromCache: true, timeStamp: T0 + 501 }, "done");
  start("6", "https://a.example/stream", "xmlhttprequest", "GET", T0 + 600);
  d.requestEnded({ requestId: "unknown", statusCode: 200, timeStamp: T0 + 700 }, "done");
  assert.deepEqual(lines(d.read(5, { kind: "network" })), [
    "Tab 5 network: 6 requests. Newest last.",
    "12:00:01.234 GET 200 document 15.0kB 120ms https://a.example/",
    "12:00:01.434 POST 404 xhr 312B 45ms https://a.example/api/items?id=3&auth=[redacted]",
    "12:00:01.534 GET failed script - 12ms https://cdn.example/lib.js NS_ERROR_CONNECTION_REFUSED",
    "12:00:01.634 GET 301 iframe - 10ms http://a.example/old → https://a.example/new?sid=[redacted]",
    "12:00:01.734 GET 200 image cache 1ms https://a.example/logo.png",
    "12:00:01.834 GET pending xhr - - https://a.example/stream",
  ]);
  assert.deepEqual(lines(d.read(5, { kind: "network", onlyFailed: true, pattern: "a\\.example" })), [
    "Tab 5 network: 1 request; 5 of 6 kept didn't match failed only, pattern /a\\.example/i. Newest last.",
    "12:00:01.434 POST 404 xhr 312B 45ms https://a.example/api/items?id=3&auth=[redacted]",
  ]);
  d.forget(5);
  assert.equal(d.has(5), false);
  assert.equal(d.read(5, { kind: "network" }), "Tab 5 network: 0 requests.");
});
