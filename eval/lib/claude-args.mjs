// The `claude -p` arguments for one browser-comparison run, shared by run.mjs and demo/race.mjs
// so a recorded race runs exactly what the eval measures.
//
// Firefox: a strict MCP config naming only the Firefox server, only its tools (plus the arm's).
// Chrome: Claude in Chrome (`--chrome`) with an empty strict MCP config, so the Firefox tools
// aren't offered, and only the claude-in-chrome tools allowed.

import { ARM_PROMPTS, ARM_TOOLS } from "../arms.mjs";
import { promptFor } from "../tasks.mjs";

export function browserClaudeArgs({ task, arm = "baseline", browser = "firefox", model, mcpConfig, emptyMcpConfig }) {
  if (browser === "chrome")
    return [
      "-p", promptFor(task, browser),
      "--chrome",
      "--output-format", "stream-json", "--verbose",
      "--model", model,
      "--strict-mcp-config", "--mcp-config", emptyMcpConfig,
      "--tools", "",
      "--allowedTools", "mcp__claude-in-chrome__*",
      "--disallowedTools", "Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch",
      "--no-session-persistence",
    ];
  const args = [
    "-p", promptFor(task, browser),
    "--output-format", "stream-json", "--verbose",
    "--model", model,
    "--strict-mcp-config", "--mcp-config", mcpConfig,
    "--tools", ARM_TOOLS[arm] ?? "",
    // The sub-agent tool is listed as "Task" but its tool_use blocks are named "Agent".
    "--allowedTools", ["mcp__firefox__*", ...(ARM_TOOLS[arm] ? [ARM_TOOLS[arm], "Agent"] : [])].join(","),
    "--disallowedTools", "Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch",
    "--no-session-persistence",
  ];
  if (ARM_PROMPTS[arm]) args.push("--append-system-prompt", ARM_PROMPTS[arm]);
  return args;
}

// The Firefox MCP config run.mjs writes: this checkout's mcp/server.mjs, with env only when set.
export const firefoxMcpConfig = (serverPath, env = {}) => ({
  mcpServers: { firefox: { type: "stdio", command: process.execPath, args: [serverPath], ...(Object.keys(env).length ? { env } : {}) } },
});
