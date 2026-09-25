#!/usr/bin/env node
// Calls one tool through the bridge, for testing without a Claude Code session.
//   node scripts/ffctl.mjs <tool> '<json args>' [session]
// Images are written to ~/.firefox-agent-bridge/ffctl-<n>.jpg and their paths printed.

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const [tool, rawArgs = "{}", session = "ffctl"] = process.argv.slice(2);
if (!tool) {
  console.error("usage: ffctl.mjs <tool> '<json args>' [session]");
  process.exit(2);
}
let args;
try {
  args = JSON.parse(rawArgs);
} catch (e) {
  console.error(`ffctl: args are not valid JSON: ${e.message}`);
  process.exit(2);
}
const dir = path.join(os.homedir(), ".firefox-agent-bridge");
const socket = net.createConnection(path.join(dir, "bridge.sock"));
let buf = "";
socket.setEncoding("utf8");
socket.on("connect", () => {
  socket.write(JSON.stringify({ type: "hello", client: { name: "ffctl", version: null }, pid: process.pid, cwd: process.cwd() }) + "\n");
  socket.write(JSON.stringify({ id: 1, session, tool, args }) + "\n");
});
socket.on("data", (chunk) => {
  buf += chunk;
  const nl = buf.indexOf("\n");
  if (nl < 0) return;
  const { result } = JSON.parse(buf.slice(0, nl));
  let n = 0;
  for (const item of result.content) {
    if (item.type === "text") console.log(item.text);
    else if (item.type === "image") {
      const file = path.join(dir, `ffctl-${n++}.${item.mimeType === "image/png" ? "png" : "jpg"}`);
      fs.writeFileSync(file, Buffer.from(item.data, "base64"));
      console.log(`[image ${item.mimeType} -> ${file}]`);
    }
  }
  if (result.isError) process.exitCode = 1;
  socket.end();
});
socket.on("close", () => {
  if (!buf.includes("\n")) {
    console.error("bridge: connection closed before a reply (Firefox quit, or the client was disconnected in the popup?)");
    process.exitCode = 1;
  }
});
socket.on("error", (e) => {
  console.error("bridge:", e.message);
  process.exit(1);
});
