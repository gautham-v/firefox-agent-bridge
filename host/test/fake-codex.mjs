#!/usr/bin/env node
// A stand-in for the Codex CLI: `codex exec [resume <id>] --json ... -` with the prompt on stdin,
// emitting the JSONL events codex-cli 0.153 prints (thread.started, item.started/completed,
// turn.completed / turn.failed). Each invocation appends its argv to $FAKE_LOG.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);

if (argv[0] === "--version") {
  console.log("codex-cli 9.9.9");
  process.exit(0);
}
if (argv[0] === "login") {
  console.log(process.env.FAKE_LOGGED_OUT === "1" ? "Not logged in" : "Logged in using ChatGPT");
  process.exit(process.env.FAKE_LOGGED_OUT === "1" ? 1 : 0);
}
if (argv[0] === "debug" && argv[1] === "models") {
  const levels = (...l) => l.map((effort) => ({ effort }));
  console.log(JSON.stringify({
    models: [
      { slug: "gpt-hidden", display_name: "Hidden", visibility: "hide", supported_reasoning_levels: levels("low") },
      { slug: "gpt-5.6-luna", display_name: "GPT-5.6-Luna", visibility: "list", supported_reasoning_levels: levels("low", "medium", "high", "xhigh", "max") },
      { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list", supported_reasoning_levels: levels("low", "medium", "high", "xhigh") },
    ],
  }));
  process.exit(0);
}
if (argv[0] === "mcp") {
  console.log(JSON.stringify([{ name: "firefox", enabled: true }, { name: "docs", enabled: true }, { name: "off", enabled: false }]));
  process.exit(0);
}

const resumeId = argv[1] === "resume" ? argv[2] : null;
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ argv, cwd: process.cwd(), session: process.env.FIREFOX_AGENT_BRIDGE_SESSION ?? null })}\n`);

// Codex records each thread as sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl.
const threadId = resumeId ?? "01a0eed2-0c7f-7e60-988d-86e3dc968a82";
const rolloutDir = path.join(process.env.CODEX_HOME ?? path.join(process.env.HOME ?? os.homedir(), ".codex"), "sessions/2026/09/29");
const rollout = (payload) => {
  fs.mkdirSync(rolloutDir, { recursive: true });
  fs.appendFileSync(path.join(rolloutDir, `rollout-2026-09-29T13-18-58-${threadId}.jsonl`), `${JSON.stringify({ type: "event_msg", payload })}\n`);
};

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", async () => {
  const out = (o) => console.log(JSON.stringify(o));
  out({ type: "thread.started", thread_id: threadId });
  rollout({ type: "item_completed", item: { type: "UserMessage", id: "u", content: [{ type: "text", text: prompt }] } });
  out({ type: "item.completed", item: { id: "item_0", type: "error", message: "Model metadata for `fake-model` not found." } });
  out({ type: "turn.started" });
  if (prompt.includes("[limit]")) {
    const limit = process.env.FAKE_LIMIT_TEXT ?? "You've hit your usage limit. Try again later.";
    out({ type: "error", message: limit });
    out({ type: "turn.failed", error: { message: limit } });
    process.exit(1);
  }
  if (prompt.includes("[slow]")) {
    out({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "Working..." } });
    setTimeout(() => {}, 60_000);
    return;
  }
  if (prompt.includes("[tool]")) {
    const item = { id: "item_1", type: "mcp_tool_call", server: "firefox", tool: "navigate", arguments: { url: "https://example.com/x?token=secret" }, result: null, error: null, status: "in_progress" };
    out({ type: "item.started", item });
    out({ type: "item.completed", item: { ...item, result: { content: [{ type: "text", text: "Navigated to https://example.com/x\nTitle: X" }] }, status: "completed" } });
    out({ type: "item.started", item: { id: "item_2", type: "command_execution", command: "ls -la", aggregated_output: "", exit_code: null, status: "in_progress" } });
    out({ type: "item.completed", item: { id: "item_2", type: "command_execution", command: "ls -la", aggregated_output: "x", exit_code: 0, status: "completed" } });
  }
  const reply = `codex says hi (${resumeId ? "resumed" : "new"})`;
  out({ type: "item.completed", item: { id: "item_9", type: "agent_message", text: reply } });
  rollout({ type: "item_completed", item: { type: "AgentMessage", id: "item_9", content: [{ type: "Text", text: reply }] } });
  rollout({ type: "task_complete", duration_ms: 5 });
  out({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
});
