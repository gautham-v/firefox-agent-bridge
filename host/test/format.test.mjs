// Unit tests for the summaries and error classification the chat panel shows.
//   node --test host/test/*.test.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyError, contextBlock, parseResetTime, stripContext, summarizePermission, summarizeToolResult, summarizeToolUse, toolTab } from "../chat-format.mjs";

test("firefox tool summaries never include typed text, form values, script source, key sequences or queries in URLs", () => {
  const cases = [
    ["mcp__firefox__computer", { action: "type", tabId: 1, text: "my password is hunter2" }, "Type 22 characters"],
    ["mcp__firefox__computer", { action: "key", tabId: 1, text: "cmd+a Backspace" }, "Press keys"],
    ["mcp__firefox__computer", { action: "left_click", tabId: 1, ref: "ref_3" }, "Click"],
    ["mcp__firefox__computer", { action: "wait", tabId: 1, duration: 2 }, "Wait 2s"],
    ["mcp__firefox__form_input", { ref: "ref_1", value: "s3cret", tabId: 1 }, "Fill in a form field"],
    ["mcp__firefox__javascript_tool", { action: "javascript_exec", text: "fetch('/api?key=abc')", tabId: 1 }, "Run a script on the page"],
    ["mcp__firefox__navigate", { url: "https://user:pw@example.com/a/b?token=abc#x" }, "Open example.com/a/b"],
    ["mcp__firefox__navigate", { url: "example.com" }, "Open example.com"],
    ["mcp__firefox__navigate", { url: "back" }, "Go back"],
    ["mcp__firefox__file_upload", { paths: ["/Users/me/secret.pdf", "/Users/me/b.png"], ref: "ref_2", tabId: 1 }, "Upload 2 file(s)"],
    ["mcp__firefox__get_page_text", { tabId: 1 }, "Read the page text"],
    ["mcp__firefox__tabs_context_mcp", {}, "List tabs"],
  ];
  for (const [name, input, want] of cases) {
    const got = summarizeToolUse(name, input);
    assert.equal(got, want);
    for (const leak of ["hunter2", "s3cret", "fetch(", "token=abc", "pw@", "secret.pdf", "Backspace"]) assert.ok(!got.includes(leak), `${name}: ${got}`);
  }
});

test("built-in tool summaries are short and name the target", () => {
  assert.equal(summarizeToolUse("Read", { file_path: "/a/b/notes.md" }), "Read notes.md");
  assert.equal(summarizeToolUse("Bash", { command: "ls", description: "List files" }), "List files");
  assert.equal(summarizeToolUse("Bash", { command: "x".repeat(300) }).length, 80);
  assert.equal(summarizeToolUse("WebFetch", { url: "https://example.com/p?q=1" }), "Fetch example.com/p");
  assert.equal(summarizeToolUse("mcp__claude_ai_Gmail__search_threads", {}), "claude_ai_Gmail search_threads");
});

test("a permission card shows what would run, and says when it couldn't show all of it", () => {
  assert.deepEqual(summarizePermission("Bash", { command: "touch x &&\n  echo hi " }), { summary: "touch x &&\n  echo hi", complete: true });
  assert.deepEqual(summarizePermission("Write", { file_path: "/tmp/a.txt", content: "secret body" }), { summary: "/tmp/a.txt", complete: true });
  assert.deepEqual(summarizePermission("WebFetch", { url: "https://example.com/a?q=1", prompt: "x" }), { summary: "https://example.com/a?q=1", complete: true });
  assert.deepEqual(summarizePermission("mcp__claude_ai_Gmail__send_message", { to: "a@example.com", body: "hi", cc: ["b@example.com"] }), {
    summary: 'to: a@example.com\nbody: hi\ncc: ["b@example.com"]',
    complete: true,
  });
  assert.deepEqual(summarizePermission("Glob", { pattern: "**/*.env", path: "/Users/me" }), { summary: "pattern: **/*.env\npath: /Users/me", complete: true });
  assert.deepEqual(summarizePermission("mcp__x__ping", {}), { summary: "x ping", complete: true });
  const long = summarizePermission("Bash", { command: `echo ${"y".repeat(2500)}` });
  assert.equal(long.complete, false);
  assert.equal(long.summary.length, 2000);
  assert.equal(summarizePermission("mcp__x__y", { body: "z".repeat(3000) }).complete, false);
});

test("tool results only carry text when they failed, plus a few harmless one-liners", () => {
  assert.equal(summarizeToolResult("mcp__firefox__get_page_text", "the page's private text", false), "");
  assert.equal(summarizeToolResult("mcp__firefox__javascript_tool", "document.cookie value", false), "");
  assert.equal(summarizeToolResult("mcp__firefox__navigate", "Navigated to https://a.example/\nTitle: A", false), "Navigated to https://a.example/");
  assert.equal(summarizeToolResult("mcp__firefox__computer", [{ type: "image", source: {} }], false), "Screenshot captured");
  assert.equal(summarizeToolResult("mcp__firefox__find", [{ type: "text", text: "Tab 3 not in this group\nmore" }], true), "Tab 3 not in this group");
  assert.equal(summarizeToolResult("Bash", "", true), "Failed");
});

test("errors map to the contract's codes", () => {
  assert.equal(classifyError("You've hit your limit · resets 3pm (America/Los_Angeles)"), "limit");
  assert.equal(classifyError("Claude AI usage limit reached|1790725800"), "limit");
  assert.equal(classifyError("You've hit your monthly spend limit."), "limit");
  assert.equal(classifyError("You've hit your usage limit. Upgrade to Pro, or try again later."), "limit");
  assert.equal(classifyError("API Error: 429 rate_limit_error"), "limit");
  assert.equal(classifyError("anything", "rate_limit"), "limit");
  assert.equal(classifyError("Not logged in · Please run /login"), "auth");
  assert.equal(classifyError("Invalid API key"), "auth");
  assert.equal(classifyError("x", "authentication_failed"), "auth");
  assert.equal(classifyError("OAuth token has expired"), "auth");
  assert.equal(classifyError("API Error: 500 internal server error"), null);
  assert.equal(classifyError("Tab 429 isn't in this group"), null);
  assert.equal(classifyError("API Error: 401 Unauthorized"), "auth");
});

test("the context block round-trips: what the model got is stripped back to what the user typed", () => {
  const block = contextBlock([{ tabId: 1, title: 'A "quoted"\ntitle', url: "https://a.example/", current: true }], [{ name: "a.pdf", path: "/tmp/up/a.pdf" }]);
  assert.match(block, /^<panel-context>\n/);
  assert.ok(!block.slice(0, -2).includes("\ntitle"), "titles are one line");
  const { text, files } = stripContext(`${block}what is on my screen?`);
  assert.equal(text, "what is on my screen?");
  assert.deepEqual(files, ["a.pdf"]);
  assert.equal(contextBlock([], []), "");
  assert.deepEqual(stripContext("plain"), { text: "plain", files: [] });
});

test("elements the user pointed at are listed by tab and ref, one line each, and never read back as files", () => {
  const elements = [
    { tabId: 4, ref: "ref_12", role: "figure", name: "Weekly signups", text: "Nov\n  Jan\nMar 4: /pricing v3" },
    { tabId: 4, ref: "ref_3@f9", role: "button", name: "", text: "" },
  ];
  const block = contextBlock([{ tabId: 4, title: "Growth", url: "https://x.example/", current: true }], [{ name: "a.pdf", path: "/tmp/up/a.pdf" }], elements);
  assert.match(block, /Elements the user pointed at with Alt\+click/);
  assert.match(block, /^- tab 4, ref_12: figure "Weekly signups", text: "Nov Jan Mar 4: \/pricing v3"$/m);
  assert.match(block, /^- tab 4, ref_3@f9: button$/m);
  const { text, files } = stripContext(`${block}why did this drop?`);
  assert.equal(text, "why did this drop?");
  assert.deepEqual(files, ["a.pdf"]);
});

test("reset times are read from the CLIs' wording", () => {
  assert.equal(parseResetTime("Claude AI usage limit reached|1790725800"), 1790725800 * 1000);
  const codex = parseResetTime("You've hit your usage limit. Upgrade to Plus, or try again at Oct 3rd, 2026 1:16 PM.");
  assert.equal(codex, new Date(2026, 9, 3, 13, 16).getTime());
  assert.equal(parseResetTime("You've hit your limit · resets 3pm"), null);
});

test("tool_start names the tab only for Firefox tools with a numeric tabId", () => {
  assert.deepEqual(toolTab("mcp__firefox__computer", { action: "left_click", tabId: 42 }), { tabId: 42 });
  assert.deepEqual(toolTab("mcp__firefox__tabs_create_mcp", {}), {});
  assert.deepEqual(toolTab("mcp__firefox__navigate", { tabId: "42" }), {});
  assert.deepEqual(toolTab("Read", { tabId: 42 }), {});
});
