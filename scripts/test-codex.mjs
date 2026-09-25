#!/usr/bin/env node
// End-to-end test with the Codex CLI as the MCP client, in a real Firefox on Linux, with no
// OpenAI account: Codex talks to a scripted fake model served here (the Responses API it
// streams from), and the fake model's tool calls go through Codex to the "firefox" MCP server
// that install.sh --codex registered. Each tool result Codex sends back is checked before the
// next call.
//   FIREFOX_BIN=/path/to/firefox CODEX_BIN=/path/to/codex node scripts/test-codex.mjs
// SHOTS_DIR sets where screenshots go (default: <tmpdir>/firefox-agent-bridge-shots).
// KEEP=1 leaves the temp dir in place.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { ROOT, createHarness, freePort, requireFirefox } from "./firefox-harness.mjs";

const CODEX_BIN = process.env.CODEX_BIN;
if (!CODEX_BIN) {
  console.error("Set CODEX_BIN to the codex CLI.");
  process.exit(2);
}
const SHOTS = process.env.SHOTS_DIR || path.join(os.tmpdir(), "firefox-agent-bridge-shots");
fs.mkdirSync(SHOTS, { recursive: true });
const h = await createHarness({ prefix: "fab-cx-", firefoxBin: requireFirefox() });

// install.sh looks for codex on PATH.
const BIN = path.join(h.TMP, "bin");
fs.mkdirSync(BIN);
fs.symlinkSync(path.resolve(CODEX_BIN), path.join(BIN, "codex"));
const env = { ...h.env, PATH: `${BIN}:${process.env.PATH}` };
const CODEX_CONFIG = path.join(h.HOME, ".codex", "config.toml");

const [PAGE_PORT, MODEL_PORT] = await Promise.all([freePort(), freePort()]);
const PAGE = `http://localhost:${PAGE_PORT}/`;
const PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Codex test page</title></head>
<body><h1>Codex test page</h1><button id="btn" style="width:160px;height:50px">Record click</button>
<script>
  window.clicks = [];
  document.getElementById("btn").addEventListener("click", (e) => clicks.push(e.isTrusted));
</script></body></html>`;

// ---- the fake model ------------------------------------------------------------------------
//
// Codex 0.157 only speaks the Responses API (wire_api "chat" is gone): it POSTs /v1/responses
// with stream: true and reads server-sent events. An MCP server's tools come as one
// { type: "namespace", name: "mcp__<server>", tools: [...] } entry in `tools`, and a call names
// the namespace and the bare tool name. Tool results come back in the next request's `input`
// as function_call_output items.

const NS = "mcp__firefox";
const requests = []; // every request body, for the report
const results = []; // { tool, args, text, images, error } per tool call, in order
let plan; // generator: gets each tool result, yields the next call or a final string

function sse(res, id, item) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const events = [
    { type: "response.created", response: { id } },
    { type: "response.output_item.done", item },
    { type: "response.completed", response: { id, usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 } } },
  ];
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
}

const message = (text) => ({ type: "message", role: "assistant", id: `msg_${requests.length}`, content: [{ type: "output_text", text }] });

function toolOutput(item) {
  const parts = typeof item.output === "string" ? [{ type: "input_text", text: item.output }] : item.output;
  return {
    text: parts.filter((p) => p.type === "input_text").map((p) => p.text).join("\n"),
    images: parts.filter((p) => p.type === "input_image"),
  };
}

const modelServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", async () => {
    const id = `resp_${requests.length + 1}`;
    let json;
    try {
      json = JSON.parse(body);
    } catch {
      res.writeHead(400).end();
      return;
    }
    requests.push(json);
    if (req.url !== "/v1/responses") {
      res.writeHead(404).end();
      return;
    }
    // Only turn requests drive the script; anything else (a title, a summary) gets a stub.
    const meta = JSON.parse(json.client_metadata?.["x-codex-turn-metadata"] ?? "{}");
    if (meta.request_kind && meta.request_kind !== "turn") return sse(res, id, message("ok"));
    const last = json.input.at(-1);
    let next;
    try {
      if (last.type === "function_call_output") {
        const r = results.at(-1);
        Object.assign(r, toolOutput(last));
        next = await plan.next(r);
      } else {
        next = await plan.next();
      }
    } catch (e) {
      next = { value: `FAILED: ${e.message}` };
      plan.error = e;
    }
    const v = next.value;
    if (typeof v === "string" || next.done) return sse(res, id, message(v ?? "done"));
    results.push({ tool: v.tool, args: v.args });
    sse(res, id, { type: "function_call", id: `fc_${results.length}`, call_id: `call_${results.length}`, namespace: NS, name: v.tool, arguments: JSON.stringify(v.args) });
  });
});
h.servers.push(modelServer);

// ---- codex exec ----------------------------------------------------------------------------

const FINAL = "Clicked the button in Firefox and saw myself in the bridge popup.";
const LAST_MESSAGE = path.join(h.TMP, "last-message.txt");

function runCodex() {
  const provider = `{ name = "fake", base_url = "http://127.0.0.1:${MODEL_PORT}/v1", env_key = "FAKE_MODEL_KEY", wire_api = "responses", request_max_retries = 0, stream_max_retries = 0 }`;
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--ephemeral",
    "--sandbox", "read-only",
    "-c", 'approval_policy="never"',
    "-c", `model_providers.fake=${provider}`,
    "-c", 'model_provider="fake"',
    "-c", 'model="fake-model"',
    "-c", "mcp_servers.firefox.tool_timeout_sec=120",
    // With no annotations on the tools, Codex asks before each MCP call, and approval_policy
    // "never" turns the ask into a refusal, so the test pre-approves this server's tools.
    "-c", 'mcp_servers.firefox.default_tools_approval_mode="approve"',
    "-C", h.TMP,
    "-o", LAST_MESSAGE,
    "Click the Record click button on the local test page in Firefox, then check the bridge popup.",
  ];
  const proc = spawn(path.join(BIN, "codex"), args, { env: { ...env, FAKE_MODEL_KEY: "not-a-real-key" }, cwd: h.TMP, stdio: ["ignore", "pipe", "pipe"] });
  h.children.push(proc);
  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (d) => (stdout += d));
  proc.stderr.on("data", (d) => (stderr += d));
  return new Promise((resolve) => {
    const timer = setTimeout(() => proc.kill("SIGKILL"), 180_000);
    proc.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, events: stdout.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l)) });
    });
  });
}

// ---- the test ------------------------------------------------------------------------------

let mn;
let failed = false;
const seen = {}; // what the checks inside the plan found
try {
  await h.serve(PAGE_PORT, { "/": PAGE_HTML });
  await new Promise((r) => modelServer.listen(MODEL_PORT, "127.0.0.1", r));

  await h.step("install.sh --codex registers the firefox server with codex mcp add", async () => {
    const out = h.install(["--codex"], env);
    assert.match(out, /Firefox: installed into/);
    assert.match(out, /Codex: registered\./);
    const config = fs.readFileSync(CODEX_CONFIG, "utf8");
    assert.match(config, /^\[mcp_servers\.firefox\]$/m);
    assert.ok(config.includes(`args = [${JSON.stringify(path.join(ROOT, "mcp/server.mjs"))}]`), config);
    assert.ok(config.includes(`command = ${JSON.stringify(process.execPath)}`), config);
  });

  const display = await h.startXvfb();
  h.startFirefox(display);
  await h.step(`Firefox on Xvfb ${display} starts the native host`, () => h.waitForBridge());
  mn = await h.marionette();
  const POPUP = `moz-extension://${await h.extensionUuid()}/popup/popup.html`;

  plan = (async function* () {
    let r = yield { tool: "navigate", args: { url: PAGE } };
    assert.match(r.text, /Title: Codex test page/, r.text);
    const tab = Number(r.text.match(/Tab (\d+):/)?.[1]);
    assert.ok(tab, r.text);

    r = yield { tool: "find", args: { tabId: tab, query: "Record click button" } };
    const ref = r.text.match(/ref_\d+/)?.[0];
    assert.ok(ref, r.text);

    r = yield { tool: "computer", args: { action: "left_click", tabId: tab, ref } };
    assert.match(r.text, /Clicked button "Record click"/, r.text);

    r = yield { tool: "javascript_tool", args: { action: "javascript_exec", tabId: tab, text: "JSON.stringify(clicks)" } };
    assert.match(r.text, /\[true\]/, r.text);
    seen.clicks = r.text;

    r = yield { tool: "computer", args: { action: "screenshot", tabId: tab } };
    assert.match(r.text, /Screenshot of tab \d+ \(\d+x\d+\)/, r.text);
    seen.screenshot = r.images;

    r = yield { tool: "tabs_create_mcp", args: {} };
    const popupTab = Number(r.text.match(/Created tab (\d+)/)?.[1]);
    assert.ok(popupTab, r.text);
    seen.groupText = r.text.match(/in the (.+?) tab group/)?.[1];

    r = yield { tool: "navigate", args: { tabId: popupTab, url: POPUP } };
    assert.match(r.text, /Title: Firefox Agent Bridge/, r.text);

    r = yield { tool: "get_page_text", args: { tabId: popupTab } };
    seen.popupText = r.text;
    // Codex is still connected here, so this is the moment to look at Firefox from outside.
    seen.groups = await mn.chrome("return gBrowser.tabGroups.map((g) => g.label + ' ' + g.color)");
    await mn.toTab(POPUP);
    await mn.screenshot(path.join(SHOTS, "popup-codex.png"));

    r = yield { tool: "tabs_close_mcp", args: { tabId: popupTab } };
    assert.match(r.text, new RegExp(`Closed tab ${popupTab}`), r.text);
    yield FINAL;
  })();

  let run;
  await h.step("codex exec drives Firefox through the fake model's tool calls", async () => {
    run = await runCodex();
    if (plan.error) throw plan.error;
    assert.equal(run.code, 0, `codex exec exited ${run.code ?? run.signal}\n${run.stderr.slice(-3000)}`);
    assert.equal(fs.readFileSync(LAST_MESSAGE, "utf8").trim(), FINAL);
    assert.equal(results.length, 9, results.map((r) => r.tool).join());
  });

  await h.step("the first request is a streaming Responses call with the firefox tools in one namespace", async () => {
    const first = requests[0];
    assert.equal(first.stream, true);
    const ns = first.tools.find((t) => t.type === "namespace" && t.name === NS);
    assert.ok(ns, `tools: ${first.tools.map((t) => t.name ?? t.type).join()}`);
    const names = ns.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["computer", "file_upload", "find", "form_input", "get_page_text", "javascript_tool", "navigate", "read_page", "tabs_close_mcp", "tabs_context_mcp", "tabs_create_mcp"]);
    for (const t of ns.tools) assert.equal(t.parameters.type, "object", t.name);
    console.log(`    tools: ${names.map((n) => `${NS}.${n}`).join(", ")}`);
  });

  await h.step("Codex reports every MCP call as completed in its --json events", async () => {
    const calls = run.events.filter((e) => e.type === "item.completed" && e.item?.type === "mcp_tool_call");
    assert.deepEqual(calls.map((e) => `${e.item.server}.${e.item.tool}`), results.map((r) => `firefox.${r.tool}`));
    for (const e of calls) assert.equal(e.item.status, "completed", JSON.stringify(e.item).slice(0, 500));
  });

  await h.step("the click was trusted, and the screenshot reached the model as an image", async () => {
    assert.match(seen.clicks, /\[true\]/);
    assert.equal(seen.screenshot.length, 1);
    const [, mime, data] = seen.screenshot[0].image_url.match(/^data:(image\/\w+);base64,(.*)$/);
    assert.equal(mime, "image/jpeg");
    const jpeg = Buffer.from(data, "base64");
    assert.deepEqual([...jpeg.subarray(0, 2)], [0xff, 0xd8]);
    fs.writeFileSync(path.join(SHOTS, "codex-test-page.jpg"), jpeg);
  });

  let clientName;
  await h.step("Codex's session gets a \"Codex\" tab group and shows in the popup", async () => {
    const hello = h.hostLog().match(/client \d+ connected: (.+?) (?:(\S+) )?pid=/);
    assert.ok(hello, h.hostLog());
    clientName = hello[1];
    console.log(`    Codex's clientInfo: name "${clientName}", version ${hello[2]}; tab groups: ${JSON.stringify(seen.groups)}`);
    assert.equal(seen.groupText, "Codex");
    assert.equal(seen.groups.length, 1, JSON.stringify(seen.groups));
    assert.match(seen.groups[0], /^Codex /);
    assert.ok(seen.popupText.includes(clientName), seen.popupText);
    assert.match(seen.popupText, /\(self-reported\)/);
    for (const s of ["navigate", "find", "computer: left_click", "javascript_tool", "computer: screenshot"]) assert.ok(seen.popupText.includes(s), `log shows "${s}"`);
    assert.ok(!seen.popupText.includes("JSON.stringify(clicks)"), "script text stays out of the log");
  });
} catch (e) {
  failed = true;
  console.error(`not ok ${h.passed + 1} - ${e.stack ?? e}`);
  if (/timed out|bridge\.sock|Firefox/.test(String(e.message)) && !String(e.message).includes("--- host.log")) console.error(h.diagnostics());
} finally {
  mn?.close();
  await h.cleanup();
}

console.log(failed ? `\nFAILED after ${h.passed} passing steps` : `\n${h.passed} passed. Screenshot in ${path.join(SHOTS, "popup-codex.png")}`);
process.exit(failed ? 1 : 0);
