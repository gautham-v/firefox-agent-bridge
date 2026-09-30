// Native messaging host. Firefox starts it when the extension connects; it bridges the
// extension (length-prefixed JSON on stdio) and any number of MCP servers (newline-delimited
// JSON on a Unix socket), one per Claude Code session.

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createChat } from "./chat.mjs";
import { createTeach } from "./teach.mjs";

const DIR = path.join(os.homedir(), ".firefox-agent-bridge");
const SOCKET = path.join(DIR, "bridge.sock");
const LOG = path.join(DIR, "host.log");

fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
const log = (...a) => fs.appendFileSync(LOG, `${new Date().toISOString()} ${a.join(" ")}\n`);

// ---- extension side -----------------------------------------------------------------------

// The sidebar chat: `chat.*` messages are handled by chat.mjs, which runs Claude Code and Codex.
const chat = createChat({ send: (msg) => send(msg), log });
// Teach: `teach.*` messages write a drafted skill to disk (teach.mjs).
const teach = createTeach({ send: (msg) => send(msg), log });

// Firefox closes the connection to the host (and this process ends with it) when one message
// is over 1 MiB, so an oversize one is refused here instead. Returns whether it was sent.
const MAX_MESSAGE_BYTES = 1_000_000;

function send(msg) {
  const body = Buffer.from(JSON.stringify(msg));
  if (body.length > MAX_MESSAGE_BYTES) {
    log(`not sending a ${msg?.type} message of ${body.length} bytes to Firefox: over the native message limit`);
    return false;
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  process.stdout.write(Buffer.concat([header, body]));
  return true;
}

let pending = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length >= 4) {
    const len = pending.readUInt32LE(0);
    if (pending.length < 4 + len) break;
    const body = pending.subarray(4, 4 + len).toString();
    pending = pending.subarray(4 + len);
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      log(`ignoring malformed extension message (${body.length} bytes)`);
      continue;
    }
    onExtensionMessage(msg);
  }
});
process.stdin.on("end", shutdown);

// ---- MCP server side ----------------------------------------------------------------------

const clients = new Map(); // client id -> { socket, info: {name, version, pid, cwd} | null }
let nextClient = 1;

function onExtensionMessage(msg) {
  if (chat.handle(msg) || teach.handle(msg)) return;
  if (msg.type === "hello") {
    log("extension connected, version", msg.version);
    return;
  }
  if (msg.type === "disconnect_client") {
    const client = clients.get(Number(msg.clientId));
    if (client) {
      log(`client ${msg.clientId} (${client.info?.name ?? "no hello"}) disconnected by the user in Firefox`);
      client.socket.destroy();
    }
    return;
  }
  const [clientId, callId] = String(msg.id).split(":");
  const socket = clients.get(Number(clientId))?.socket;
  if (socket && !socket.destroyed) socket.write(JSON.stringify({ id: Number(callId), result: msg.result }) + "\n");
}

function announce(clientId, client, hello) {
  client.info = {
    name: typeof hello.client?.name === "string" ? hello.client.name : "unknown client",
    version: typeof hello.client?.version === "string" ? hello.client.version : null,
    pid: typeof hello.pid === "number" ? hello.pid : null,
    cwd: typeof hello.cwd === "string" ? hello.cwd : null,
  };
  const { name, version, pid, cwd } = client.info;
  log(`client ${clientId} connected: ${name}${version ? ` ${version}` : ""} pid=${pid} cwd=${cwd}`);
  send({ type: "client", event: "connected", client: { id: clientId, ...client.info } });
}

try {
  fs.unlinkSync(SOCKET);
} catch {
  // no stale socket
}

const server = net.createServer((socket) => {
  const clientId = nextClient++;
  const client = { socket, info: null };
  clients.set(clientId, client);
  let buf = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let req;
      try {
        req = JSON.parse(line);
      } catch {
        log(`client ${clientId}: ignoring malformed line (${line.length} chars)`);
        continue;
      }
      if (!req || typeof req !== "object") {
        log(`client ${clientId}: ignoring non-object line (${line.length} chars)`);
        continue;
      }
      if (req.type === "hello") {
        announce(clientId, client, req);
        continue;
      }
      if (!client.info) announce(clientId, client, {});
      const sent = send({
        type: "call",
        id: `${clientId}:${req.id}`,
        session: req.session,
        tool: req.tool,
        args: req.args,
        client: { id: clientId, name: client.info.name },
      });
      if (!sent) {
        const content = [{ type: "text", text: "This request is too large to pass to Firefox (the limit is 1 MB). Send less at once." }];
        socket.write(JSON.stringify({ id: req.id, result: { content, isError: true } }) + "\n");
      }
    }
  });
  socket.on("close", () => {
    clients.delete(clientId);
    if (!client.info) return;
    log(`client ${clientId} disconnected: ${client.info.name} pid=${client.info.pid}`);
    send({ type: "client", event: "disconnected", client: { id: clientId } });
  });
  socket.on("error", (e) => log(`client ${clientId} socket error: ${e.message}`));
});
server.listen(SOCKET, () => {
  fs.chmodSync(SOCKET, 0o600);
  log("listening on", SOCKET);
});

function shutdown() {
  log("extension disconnected; exiting");
  chat.shutdown();
  server.close();
  try {
    fs.unlinkSync(SOCKET);
  } catch {
    // already gone
  }
  process.exit(0);
}
