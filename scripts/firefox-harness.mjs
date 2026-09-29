// Shared setup for the real-Firefox tests (test-firefox.mjs, test-codex.mjs): a temp HOME and
// profile, install.sh, Xvfb, Firefox, a stdio MCP client for mcp/server.mjs, and a small
// Marionette client for what the bridge can't do itself. Linux only.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function until(what, fn, ms = 10_000, every = 100) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(every);
  }
}

export function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

export function requireFirefox() {
  if (process.env.FIREFOX_BIN) return process.env.FIREFOX_BIN;
  console.error("Set FIREFOX_BIN to a Firefox Developer Edition or Nightly binary.");
  process.exit(2);
}

export async function createHarness({ prefix, firefoxBin }) {
  // Unix socket paths are limited to about 108 bytes, so the temp dir stays short.
  const TMP = fs.mkdtempSync(`/tmp/${prefix}`);
  const HOME = path.join(TMP, "home");
  const PROFILE = path.join(TMP, "profile");
  const SOCKET = path.join(HOME, ".firefox-agent-bridge", "bridge.sock");
  const HOST_LOG = path.join(HOME, ".firefox-agent-bridge", "host.log");
  const FF_LOG = path.join(TMP, "firefox.log");
  fs.mkdirSync(HOME);
  fs.mkdirSync(PROFILE);
  const env = { ...process.env, HOME, XDG_CONFIG_HOME: path.join(HOME, ".config") };
  delete env.MOZ_HEADLESS;
  delete env.CODEX_HOME;
  const MN_PORT = await freePort();
  const children = [];
  const servers = [];
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");

  const h = {
    TMP, HOME, PROFILE, SOCKET, HOST_LOG, MN_PORT, env, children, servers,
    firefox: null,
    passed: 0,

    async step(name, fn) {
      const t0 = Date.now();
      await fn();
      h.passed++;
      console.log(`ok ${h.passed} - ${name} (${Date.now() - t0}ms)`);
    },

    // Serves fixed HTML by path.
    serve(port, routes) {
      const server = http.createServer((req, res) => {
        const body = routes[new URL(req.url, "http://x").pathname];
        res.writeHead(body ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
        res.end(body ?? "not found");
      });
      servers.push(server);
      return new Promise((r) => server.listen(port, "127.0.0.1", r));
    },

    startXvfb() {
      // -displayfd picks a free display and writes its number to fd 3.
      const xvfb = spawn("Xvfb", ["-displayfd", "3", "-screen", "0", "1400x1000x24", "-nolisten", "tcp"], {
        stdio: ["ignore", "ignore", "pipe", "pipe"],
      });
      children.push(xvfb);
      let err = "";
      xvfb.stderr.on("data", (d) => (err += d));
      return new Promise((resolve, reject) => {
        let out = "";
        xvfb.stdio[3].on("data", (d) => {
          out += d;
          if (out.includes("\n")) resolve(`:${out.trim()}`);
        });
        xvfb.once("exit", (code) => reject(new Error(`Xvfb exited (${code}): ${err}`)));
      });
    },

    // Runs install.sh with these options on the test profile, checks the Firefox side, and adds
    // test-only prefs. Returns the script's output.
    install(options, installEnv = env) {
      const out = execFileSync("sh", [path.join(ROOT, "scripts/install.sh"), ...options, PROFILE], { env: installEnv, encoding: "utf8" });
      const manifest = JSON.parse(fs.readFileSync(path.join(HOME, ".mozilla/native-messaging-hosts/firefox_agent_bridge.json"), "utf8"));
      assert.equal(manifest.name, "firefox_agent_bridge");
      assert.ok(fs.statSync(manifest.path).mode & 0o111, "launcher is executable");
      assert.equal(fs.readFileSync(path.join(PROFILE, "extensions/firefox-agent-bridge@local"), "utf8").trim(), path.join(ROOT, "extension"));
      const userJs = fs.readFileSync(path.join(PROFILE, "user.js"), "utf8");
      for (const pref of ["xpinstall.signatures.required", "extensions.experiments.enabled", "extensions.autoDisableScopes"]) assert.ok(userJs.includes(pref), pref);
      // No first-run pages, and Marionette on a free port.
      fs.appendFileSync(
        path.join(PROFILE, "user.js"),
        [
          ["browser.shell.checkDefaultBrowser", false],
          ["browser.aboutwelcome.enabled", false],
          ["browser.startup.homepage_override.mstone", '"ignore"'],
          ["startup.homepage_welcome_url", '""'],
          ["datareporting.policy.dataSubmissionEnabled", false],
          ["browser.startup.page", 3],
          ["marionette.port", MN_PORT],
        ]
          .map(([k, v]) => `user_pref("${k}", ${v});\n`)
          .join(""),
      );
      return out;
    },

    startFirefox(display) {
      const log = fs.openSync(FF_LOG, "a");
      h.firefox = spawn(firefoxBin, ["-profile", PROFILE, "-no-remote", "-marionette", "-remote-allow-system-access", "--window-size=1400,950"], {
        env: { ...env, DISPLAY: display },
        cwd: TMP,
        stdio: ["ignore", log, log],
      });
      children.push(h.firefox);
    },

    // Waits for the native host's socket and the extension's hello.
    async waitForBridge() {
      try {
        await until("bridge.sock", () => fs.existsSync(SOCKET), 60_000, 250);
      } catch (e) {
        throw new Error(`${e.message}\n${h.diagnostics()}`);
      }
      await until("extension hello in host.log", () => read(HOST_LOG).includes("extension connected"), 10_000);
    },

    hostLog: () => read(HOST_LOG),

    diagnostics() {
      return `--- host.log ---\n${read(HOST_LOG) || "(missing)"}\n--- Firefox output (last 60 lines) ---\n${read(FF_LOG).split("\n").slice(-60).join("\n")}`;
    },

    // The extension's moz-extension:// uuid, once Firefox has written prefs.js.
    extensionUuid() {
      return until("extension uuid in prefs.js", () => {
        const raw = read(path.join(PROFILE, "prefs.js")).match(/user_pref\("extensions\.webextensions\.uuids", "(.*)"\);/)?.[1];
        if (!raw) return null;
        return JSON.parse(JSON.parse(`"${raw}"`))["firefox-agent-bridge@local"];
      }, 30_000, 500);
    },

    mcpClient: (name) => mcpClient(name, env, children),
    marionette: () => marionette(MN_PORT),

    async cleanup() {
      for (const c of children.reverse()) c.kill("SIGKILL");
      for (const s of servers) s.close();
      await sleep(300);
      if (!process.env.KEEP) fs.rmSync(TMP, { recursive: true, force: true });
    },
  };
  // Ctrl-C would otherwise leave Firefox, Xvfb and the temp dir behind.
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.once(sig, () => {
      for (const c of children) c.kill("SIGKILL");
      if (!process.env.KEEP) fs.rmSync(TMP, { recursive: true, force: true });
      process.exit(130);
    });
  }
  return h;
}

// ---- MCP client over stdio -----------------------------------------------------------------

function mcpClient(name, env, children) {
  const proc = spawn(process.execPath, [path.join(ROOT, "mcp/server.mjs")], { env, stdio: ["pipe", "pipe", "inherit"] });
  children.push(proc);
  const waiting = new Map();
  let nextId = 1;
  readline.createInterface({ input: proc.stdout }).on("line", (line) => {
    const msg = JSON.parse(line);
    waiting.get(msg.id)?.(msg);
    waiting.delete(msg.id);
  });
  const request = (method, params, ms = 60_000) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`${name}: ${method} ${params?.name ?? ""} got no answer in ${ms}ms`)), ms);
      waiting.set(id, (m) => (clearTimeout(timer), resolve(m)));
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  // Resolves to { text, images, isError }.
  const call = async (tool, args = {}) => {
    const msg = await request("tools/call", { name: tool, arguments: args });
    if (msg.error) throw new Error(`${tool}: JSON-RPC error ${msg.error.message}`);
    const content = msg.result.content ?? [];
    return {
      text: content.filter((c) => c.type === "text").map((c) => c.text).join("\n"),
      images: content.filter((c) => c.type === "image"),
      isError: !!msg.result.isError,
    };
  };
  // Like call, but a tool error fails the test.
  const ok = async (tool, args) => {
    const r = await call(tool, args);
    if (r.isError) throw new Error(`${tool} ${JSON.stringify(args)} failed: ${r.text}`);
    return r;
  };
  const js = async (tabId, code) => (await ok("javascript_tool", { action: "javascript_exec", tabId, text: code })).text;
  return {
    name,
    request,
    call,
    ok,
    js,
    init: () => request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name, version: "1.2.3" } }),
    notify: (method) => proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n"),
  };
}

// ---- Marionette ----------------------------------------------------------------------------

async function marionette(port) {
  const sock = await until(
    "Marionette",
    () =>
      new Promise((resolve) => {
        const s = net.connect(port, "127.0.0.1", () => resolve(s));
        s.on("error", () => resolve(null));
      }),
    30_000,
    300,
  );
  let buf = Buffer.alloc(0);
  const waiting = new Map();
  let nextId = 0;
  let greeted;
  const greeting = new Promise((r) => (greeted = r));
  sock.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      const colon = buf.indexOf(58);
      if (colon < 0) return;
      const n = Number(buf.subarray(0, colon).toString());
      if (buf.length < colon + 1 + n) return;
      const msg = JSON.parse(buf.subarray(colon + 1, colon + 1 + n).toString());
      buf = buf.subarray(colon + 1 + n);
      if (!Array.isArray(msg)) {
        greeted();
        continue;
      }
      const [, id, error, result] = msg;
      waiting.get(id)?.(error, result);
      waiting.delete(id);
    }
  });
  const cmd = (name, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      waiting.set(id, (error, result) => (error ? reject(new Error(`${name}: ${JSON.stringify(error)}`)) : resolve(result)));
      const body = JSON.stringify([0, id, name, params]);
      sock.write(`${Buffer.byteLength(body)}:${body}`);
    });
  await greeting;
  await cmd("WebDriver:NewSession", { capabilities: {} });
  const chrome = async (script, args = []) => {
    await cmd("Marionette:SetContext", { value: "chrome" });
    try {
      return (await cmd("WebDriver:ExecuteScript", { script, args })).value;
    } finally {
      await cmd("Marionette:SetContext", { value: "content" });
    }
  };
  return {
    cmd,
    chrome,
    close: () => sock.destroy(),
    groupTitles: () => chrome("return gBrowser.tabGroups.map((g) => g.label)"),
    // Switches to the tab showing url (without selecting it) and returns its handle.
    toTab: async (url) => {
      for (const handle of await cmd("WebDriver:GetWindowHandles")) {
        await cmd("WebDriver:SwitchToWindow", { handle, focus: false });
        if ((await cmd("WebDriver:GetCurrentURL")).value === url) return handle;
      }
      throw new Error(`no tab at ${url}`);
    },
    screenshot: async (file) => {
      const { value } = await cmd("WebDriver:TakeScreenshot", { full: false, hash: false });
      fs.writeFileSync(file, Buffer.from(value, "base64"));
    },
  };
}
