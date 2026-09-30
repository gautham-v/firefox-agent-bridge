// A small stdio MCP client for this worktree's mcp/server.mjs, used by the probes. Each client is
// its own session, so its tabs land in their own tab group in the user's Firefox; pass `session`
// to join an existing session's group (e.g. to inspect the tabs a finished agent run left open).

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
export const SERVER = path.join(ROOT, "mcp/server.mjs");

export async function startMcp({ name = "eval-probe", timeoutMs = 100_000, session = null } = {}) {
  const env = { ...process.env };
  delete env.FIREFOX_AGENT_BRIDGE_SESSION;
  if (session) env.FIREFOX_AGENT_BRIDGE_SESSION = session;
  const proc = spawn(process.execPath, [SERVER], { env, stdio: ["pipe", "pipe", "inherit"] });
  const waiting = new Map();
  let buf = "";
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      waiting.get(msg.id)?.(msg);
      waiting.delete(msg.id);
    }
  });
  let nextId = 1;
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`MCP ${method} timed out`));
      }, timeoutMs);
      waiting.set(id, (msg) => {
        clearTimeout(timer);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });

  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name, version: "0" } });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  // Calls a tool; returns its text (joined) and throws if the tool reported an error.
  const call = async (tool, args = {}) => {
    const r = await request("tools/call", { name: tool, arguments: args });
    const text = (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    if (r.isError) throw new Error(`${tool}: ${text}`);
    return text;
  };

  // Runs JS in a tab and parses a JSON result (the snippet should end with JSON.stringify(...)).
  const js = async (tabId, code) => {
    const text = await call("javascript_tool", { action: "javascript_exec", tabId, text: code });
    try {
      return JSON.parse(text);
    } catch {
      // Some results come back quoted or with a prefix; find the JSON body.
      const i = text.search(/[[{"]/);
      if (i >= 0) {
        try {
          const v = JSON.parse(text.slice(i));
          return typeof v === "string" ? JSON.parse(v) : v;
        } catch {}
      }
      throw new Error(`javascript_tool returned non-JSON: ${text.slice(0, 300)}`);
    }
  };

  const newTab = async () => {
    const text = await call("tabs_create_mcp");
    const m = text.match(/Created tab (\d+)/);
    if (!m) throw new Error(`tabs_create_mcp: ${text.slice(0, 200)}`);
    return Number(m[1]);
  };

  // Closes this session's tabs (giving up after 15s) and stops the server.
  const close = async () => {
    const closeTabs = (async () => {
      const ctx = JSON.parse(await call("tabs_context_mcp"));
      for (const t of ctx.availableTabs ?? []) await call("tabs_close_mcp", { tabId: t.tabId }).catch(() => {});
    })();
    await Promise.race([closeTabs, sleep(15_000)]).catch(() => {});
    proc.stdin.end();
    proc.kill();
  };

  return { proc, request, call, js, newTab, close };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const tokens = (s) => Math.round((s?.length ?? 0) / 4);
