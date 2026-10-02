#!/usr/bin/env node
// /sidebar in Claude Code (the command install.sh writes to ~/.claude/commands/sidebar.md):
// moves the session this runs in to the Firefox sidebar, then ends this Claude Code so only
// one side has the session. Claude Code gives its commands CLAUDE_CODE_SESSION_ID and CLAUDE_PID.
//   node scripts/to-sidebar.mjs [session id]

import { spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const session = process.argv[2] || process.env.CLAUDE_CODE_SESSION_ID;
const pid = Number(process.env.CLAUDE_PID);
const SOCKET = process.env.FIREFOX_AGENT_BRIDGE_SOCKET || path.join(os.homedir(), ".firefox-agent-bridge", "bridge.sock");

const fail = (text) => {
  console.log(`Not moved: ${text}`);
  process.exit(0); // the command's output is the message; a failure exit would hide it
};
if (!session) fail("this isn't running inside a Claude Code session.");

const socket = net.createConnection(SOCKET);
const timer = setTimeout(() => fail("Firefox didn't answer."), 5000);
let buf = "";
socket.setEncoding("utf8");
socket.on("connect", () => socket.write(JSON.stringify({ type: "sidebar", id: 1, session }) + "\n"));
socket.on("error", () => fail("Firefox isn't running, or the bridge isn't connected."));
socket.on("data", (chunk) => {
  buf += chunk;
  const nl = buf.indexOf("\n");
  if (nl < 0) return;
  clearTimeout(timer);
  socket.end();
  let ok = false;
  try {
    ok = JSON.parse(buf.slice(0, nl)).ok === true;
  } catch {}
  if (!ok) fail("Firefox couldn't find this session. Send a message first, then try again.");
  console.log("Moved to the Firefox sidebar. Open the sidebar to continue there.");
  // After this command's output is in, so the terminal is left clean.
  if (pid > 1) spawn("sh", ["-c", `sleep 0.5; kill -TERM ${pid}`], { detached: true, stdio: "ignore" }).unref();
});
