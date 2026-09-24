// Native messaging host. Firefox starts it when the extension connects; it bridges the
// extension (length-prefixed JSON on stdio) and any number of MCP servers (newline-delimited
// JSON on a Unix socket), one per Claude Code session.

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const DIR = path.join(os.homedir(), ".firefox-agent-bridge");
const SOCKET = path.join(DIR, "bridge.sock");
const LOG = path.join(DIR, "host.log");

fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
const log = (...a) => fs.appendFileSync(LOG, `${new Date().toISOString()} ${a.join(" ")}\n`);

// ---- extension side -----------------------------------------------------------------------

function send(msg) {
  const body = Buffer.from(JSON.stringify(msg));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  process.stdout.write(Buffer.concat([header, body]));
}

let pending = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length >= 4) {
    const len = pending.readUInt32LE(0);
    if (pending.length < 4 + len) break;
    const msg = JSON.parse(pending.subarray(4, 4 + len).toString());
    pending = pending.subarray(4 + len);
    onExtensionMessage(msg);
  }
});
process.stdin.on("end", shutdown);

// ---- MCP server side ----------------------------------------------------------------------

const clients = new Map(); // client id -> socket
let nextClient = 1;

function onExtensionMessage(msg) {
  if (msg.type === "hello") {
    log("extension connected, version", msg.version);
    return;
  }
  const [clientId, callId] = String(msg.id).split(":");
  const socket = clients.get(Number(clientId));
  if (socket && !socket.destroyed) socket.write(JSON.stringify({ id: Number(callId), result: msg.result }) + "\n");
}

try {
  fs.unlinkSync(SOCKET);
} catch {
  // no stale socket
}

const server = net.createServer((socket) => {
  const clientId = nextClient++;
  clients.set(clientId, socket);
  let buf = "";
  socket.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const req = JSON.parse(line);
      send({ type: "call", id: `${clientId}:${req.id}`, session: req.session, tool: req.tool, args: req.args });
    }
  });
  socket.on("close", () => clients.delete(clientId));
  socket.on("error", () => clients.delete(clientId));
});
server.listen(SOCKET, () => {
  fs.chmodSync(SOCKET, 0o600);
  log("listening on", SOCKET);
});

function shutdown() {
  log("extension disconnected; exiting");
  server.close();
  try {
    fs.unlinkSync(SOCKET);
  } catch {
    // already gone
  }
  process.exit(0);
}
