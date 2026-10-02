#!/usr/bin/env node
// A stand-in for `claude -p --input-format stream-json --output-format stream-json`, speaking the
// same wire format the real CLI does (captured from Claude Code 2.1.285). What a turn does is
// chosen by a marker in the user's message; see `runTurn`. Each invocation appends one JSON line
// (argv, cwd, the chat's session env) to $FAKE_LOG.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const argv = process.argv.slice(2);
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);

// Subcommands the host runs for capability checks.
if (argv[0] === "--version") {
  console.log("9.9.9 (Claude Code)");
  process.exit(0);
}
if (argv[0] === "auth") {
  console.log(JSON.stringify({ loggedIn: process.env.FAKE_LOGGED_OUT !== "1" }));
  process.exit(process.env.FAKE_LOGGED_OUT === "1" ? 1 : 0);
}
if (argv[0] === "plugin") {
  console.log(JSON.stringify([
    { id: "swift-lsp@claude-plugins-official", enabled: true },
    { id: "typescript-lsp@claude-plugins-official", enabled: false },
  ]));
  process.exit(0);
}

const sessionId = flag("--session-id") ?? flag("--resume") ?? "00000000-0000-4000-8000-000000000000";
const cwd = fs.realpathSync(process.cwd());
if (process.env.FAKE_LOG) {
  fs.appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ argv, cwd, session: process.env.FIREFOX_AGENT_BRIDGE_SESSION ?? null, path: process.env.PATH, autoMemory: process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY ?? null })}\n`);
}

const write = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Session file, where the real CLI keeps the conversation (history and titles read it).
const dir = path.join(process.env.HOME ?? os.homedir(), ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
const file = path.join(dir, `${sessionId}.jsonl`);
const record = (o) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ sessionId, cwd, ...o })}\n`);
};

let counter = 0;
const pendingResponses = new Map(); // control request id -> resolver
let aborted = null; // set while a turn is running so an interrupt can end it

function init() {
  write({ type: "system", subtype: "init", session_id: sessionId, cwd, model: flag("--model"), tools: [], mcp_servers: [] });
}

async function assistantText(id, text, { deltas = true } = {}) {
  write({ type: "stream_event", event: { type: "message_start", message: { id, role: "assistant", content: [] } }, parent_tool_use_id: null });
  write({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }, parent_tool_use_id: null });
  write({ type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }, parent_tool_use_id: null });
  if (deltas) for (const part of text.match(/.{1,6}/gs)) write({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: part } }, parent_tool_use_id: null });
  write({ type: "assistant", message: { id, role: "assistant", model: flag("--model"), content: [{ type: "text", text }] }, parent_tool_use_id: null, uuid: `u-${++counter}` });
  record({ type: "assistant", uuid: `a-${counter}`, message: { id, role: "assistant", model: flag("--model"), content: [{ type: "text", text }] } });
  write({ type: "stream_event", event: { type: "message_stop" }, parent_tool_use_id: null });
}

function toolUse(id, name, input) {
  write({ type: "assistant", message: { id: `msg_${id}`, role: "assistant", content: [{ type: "tool_use", id, name, input }] }, parent_tool_use_id: null, uuid: `u-${++counter}` });
  record({ type: "assistant", uuid: `a-${counter}`, message: { id: `msg_${id}`, role: "assistant", content: [{ type: "tool_use", id, name, input }] } });
}

function toolResult(id, content, isError = false) {
  write({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] }, parent_tool_use_id: null });
  record({ type: "user", uuid: `r-${++counter}`, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] } });
}

const result = (extra = {}) => write({ type: "result", subtype: "success", is_error: false, duration_ms: 12, num_turns: 1, result: "", session_id: sessionId, queued_turn_count: 0, ...extra });

async function permission(name, input, suggestions) {
  const requestId = `perm-${++counter}`;
  const permission_suggestions = suggestions ?? [{ type: "addRules", rules: [{ toolName: name, ruleContent: input.command }], behavior: "allow", destination: "localSettings" }];
  write({ type: "control_request", request_id: requestId, request: { subtype: "can_use_tool", tool_name: name, input, tool_use_id: `toolu_${counter}`, permission_suggestions } });
  return new Promise((resolve) => pendingResponses.set(requestId, resolve));
}

async function runTurn(content) {
  const blocks = Array.isArray(content) ? content : [{ type: "text", text: String(content) }];
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const images = blocks.filter((b) => b.type === "image").length;
  init();
  record({ type: "user", uuid: `q-${++counter}`, message: { role: "user", content } });
  write({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, isReplay: true });
  const id = `msg_${++counter}`;

  // A message that arrives while this turn runs is taken into it, as Claude Code does between
  // tool calls: echoed, recorded as an attachment, and answered by this turn's one result.
  if (text.includes("[steerable]")) {
    await assistantText(id, "First part", {});
    const next = await new Promise((resolve) => (steer = resolve));
    steer = null;
    write({ type: "user", message: { role: "user", content: next }, parent_tool_use_id: null, isReplay: true });
    record({ type: "attachment", uuid: `q-${++counter}`, attachment: { type: "queued_command", prompt: next, commandMode: "prompt" } });
    await assistantText(`msg_${++counter}`, "Both parts", {});
    return result();
  }

  if (text.includes("[crash]")) {
    process.stderr.write("Error: boom, the engine crashed\n");
    process.exit(3);
  }
  if (text.includes("[auth]")) {
    write({ type: "assistant", message: { id, role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "Not logged in · Please run /login" }] }, error: "authentication_failed", isApiErrorMessage: true, parent_tool_use_id: null, uuid: "u-auth" });
    return result({ is_error: true, result: "Not logged in · Please run /login", num_turns: 1 });
  }
  if (text.includes("[limit]")) {
    write({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1790725800, rateLimitType: "five_hour" } });
    write({ type: "assistant", message: { id, role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "You've hit your limit · resets 3pm (America/Los_Angeles)" }] }, error: "rate_limit", isApiErrorMessage: true, parent_tool_use_id: null, uuid: "u-limit" });
    return result({ is_error: true, result: "You've hit your limit · resets 3pm (America/Los_Angeles)", api_error_status: 429 });
  }
  if (text.includes("[slow]")) {
    await assistantText(id, "Working on it", {});
    write({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "..." } }, parent_tool_use_id: null });
    await new Promise((resolve) => (aborted = resolve));
    aborted = null;
    return result({ subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_streaming", errors: ["[ede_diagnostic] result_type=user"] });
  }
  if (text.includes("[tool]")) {
    toolUse("toolu_ts", "ToolSearch", { query: "select:mcp__firefox__navigate", max_results: 5 });
    toolResult("toolu_ts", "loaded");
    toolUse("toolu_nav", "mcp__firefox__navigate", { url: "https://example.com/a/b?token=secret#frag" });
    toolResult("toolu_nav", "Navigated to https://example.com/a/b?token=secret\nTitle: Example");
    toolUse("toolu_type", "mcp__firefox__computer", { action: "type", tabId: 1, text: "hunter2" });
    toolResult("toolu_type", "Typed 7 characters");
    toolUse("toolu_js", "mcp__firefox__javascript_tool", { action: "javascript_exec", tabId: 1, text: "document.cookie" });
    toolResult("toolu_js", "session=abc", true);
    toolUse("toolu_shot", "mcp__firefox__computer", { action: "screenshot", tabId: 1 });
    toolResult("toolu_shot", [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } }]);
    await assistantText(`msg_${++counter}`, "Done with the page.");
    return result({ num_turns: 3 });
  }
  // Two sub-agents at once, their messages interleaved and tagged with the Agent call's id, the
  // way Claude Code streams them.
  if (text.includes("[fanout]")) {
    const tasks = [
      { id: "toolu_agent_a", name: "Agent", input: { description: "Read requests on PyPI", prompt: "Open pypi.org/project/requests and return the version", subagent_type: "general-purpose" } },
      { id: "toolu_agent_b", name: "Agent", input: { description: "Read httpx on PyPI", prompt: "Open pypi.org/project/httpx and return the version", subagent_type: "general-purpose" } },
    ];
    write({ type: "assistant", message: { id: `msg_${++counter}`, role: "assistant", content: tasks.map((x) => ({ type: "tool_use", ...x })) }, parent_tool_use_id: null, uuid: `u-${++counter}` });
    const sub = (parent, content) => write({ type: "assistant", message: { id: `msg_${++counter}`, role: "assistant", content }, parent_tool_use_id: parent, uuid: `u-${++counter}` });
    const subResult = (parent, id, content, isError = false) => write({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] }, parent_tool_use_id: parent });
    write({ type: "stream_event", event: { type: "message_start", message: { id: "msg_sub_stream", role: "assistant", content: [] } }, parent_tool_use_id: "toolu_agent_a" });
    sub("toolu_agent_a", [{ type: "tool_use", id: "toolu_a1", name: "mcp__firefox__tabs_create_mcp", input: {} }]);
    sub("toolu_agent_b", [{ type: "tool_use", id: "toolu_b1", name: "mcp__firefox__tabs_create_mcp", input: {} }]);
    subResult("toolu_agent_a", "toolu_a1", "Created tab 7 in the Claude tab group.");
    subResult("toolu_agent_b", "toolu_b1", "Created tab 8 in the Claude tab group.");
    sub("toolu_agent_a", [{ type: "text", text: "Opening the page" }, { type: "tool_use", id: "toolu_a2", name: "mcp__firefox__navigate", input: { tabId: 7, url: "https://pypi.org/project/requests/?q=1" } }]);
    sub("toolu_agent_b", [{ type: "tool_use", id: "toolu_b2", name: "mcp__firefox__javascript_tool", input: { action: "javascript_exec", tabId: 8, text: "document.querySelector('h1').textContent" } }]);
    subResult("toolu_agent_b", "toolu_b2", "TypeError: document.querySelector(...) is null", true);
    subResult("toolu_agent_a", "toolu_a2", "Tab 7: https://pypi.org/project/requests/\nTitle: requests");
    toolResult("toolu_agent_a", [{ type: "text", text: "requests 2.32.3" }, { type: "text", text: "agentId: a1b2c3 (use SendMessage to continue)\n<usage>total_tokens: 900</usage>" }]);
    toolResult("toolu_agent_b", [{ type: "text", text: "httpx 0.28.1\n(read from the page text)" }]);
    await assistantText(`msg_${++counter}`, "| Package | Version |\n| --- | --- |\n| requests | 2.32.3 |\n| httpx | 0.28.1 |");
    return result({ num_turns: 2 });
  }
  if (text.includes("[perm]")) {
    const input = { command: "touch fake-file", description: "Create a file" };
    const decision = await permission("Bash", input);
    const allowed = decision.behavior === "allow";
    const tid = `toolu_perm${counter}`;
    toolUse(tid, "Bash", input);
    toolResult(tid, allowed ? "" : "The user doesn't want to proceed", !allowed);
    await assistantText(`msg_${++counter}`, allowed ? "Ran it." : `Denied: ${decision.message}`);
    return result();
  }
  // "[permreq] [{name, input, suggestions}, ...]": asks for each in turn, then reports the answers.
  if (text.includes("[permreq]")) {
    const specs = JSON.parse(text.slice(text.indexOf("[permreq]") + 9).trim().split("\n")[0]);
    const answers = [];
    for (const spec of specs) answers.push((await permission(spec.name, spec.input, spec.suggestions)).behavior);
    await assistantText(`msg_${++counter}`, `answers: ${answers.join(",")}`);
    return result();
  }
  if (text.includes("[twoperm]")) {
    for (let i = 0; i < 2; i++) {
      const input = { command: "touch fake-file", description: "Create a file" };
      const decision = await permission("Bash", input);
      await assistantText(`msg_${++counter}`, `decision ${i}: ${decision.behavior}`);
    }
    return result();
  }
  if (text.includes("[title]")) record({ type: "ai-title", aiTitle: "Fake generated title" });
  const echo = text.includes("[env]") ? ` session=${process.env.FIREFOX_AGENT_BRIDGE_SESSION} images=${images} text=${JSON.stringify(text)}` : "";
  await assistantText(id, `Hello from the fake${echo}`);
  return result();
}

// Answers the control requests the host uses to learn what is installed.
function controlRequest(msg) {
  const r = msg.request;
  const ok = (response) => write({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response } });
  if (r.subtype === "initialize") {
    return ok({
      commands: [
        { name: "tdd", description: "Test-driven development with a red-green loop.", argumentHint: "" },
        { name: "clear", description: "Clear the conversation", builtin: true },
        { name: "viz", description: "Turn a discussion into a visual.", argumentHint: "" },
      ],
      models: [],
      account: { email: "me@example.com" },
    });
  }
  if (r.subtype === "mcp_status") {
    const polls = (globalThis.__polls = (globalThis.__polls ?? 0) + 1);
    return ok({
      mcpServers: [
        { name: "firefox", status: "connected" },
        { name: "claude.ai Gmail", status: polls < 2 ? "pending" : "connected" },
        { name: "claude.ai Stripe", status: "needs-auth" },
      ],
    });
  }
  if (r.subtype === "interrupt") {
    ok({ still_queued: [] });
    aborted?.();
    return;
  }
  write({ type: "control_response", response: { subtype: "error", request_id: msg.request_id, error: `unsupported ${r.subtype}` } });
}

let steer = null;
let chain = Promise.resolve();
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type === "control_request") return controlRequest(msg);
  if (msg.type === "control_response") {
    pendingResponses.get(msg.response?.request_id)?.(msg.response?.response ?? {});
    pendingResponses.delete(msg.response?.request_id);
    return;
  }
  if (msg.type === "user" && steer) return steer(msg.message.content);
  if (msg.type === "user") chain = chain.then(() => runTurn(msg.message.content));
});
rl.on("close", async () => {
  await chain;
  await sleep(Number(process.env.FAKE_EXIT_DELAY) || 10); // a slow shutdown, like a real process flushing its session
  process.exit(0);
});
