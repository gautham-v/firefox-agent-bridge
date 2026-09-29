#!/usr/bin/env node
// End-to-end test in a real Firefox on Linux: installs into a fresh profile under a temp HOME,
// starts Firefox on its own Xvfb display, and drives a local test page and the extension's
// popup through mcp/server.mjs as an MCP client would. Stop's Resume can't go through the
// bridge (Stop pauses every session, the clicker's included), so that one click goes through
// Marionette.
//   FIREFOX_BIN=/path/to/firefox node scripts/test-firefox.mjs
// SHOTS_DIR sets where screenshots go (default: <tmpdir>/firefox-agent-bridge-shots).
// KEEP=1 leaves the temp dir in place.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHarness, freePort, requireFirefox, until } from "./firefox-harness.mjs";

const SHOTS = process.env.SHOTS_DIR || path.join(os.tmpdir(), "firefox-agent-bridge-shots");
const h = await createHarness({ prefix: "fab-ff-", firefoxBin: requireFirefox() });
fs.mkdirSync(SHOTS, { recursive: true });

// ---- test pages ----------------------------------------------------------------------------

const [PAGE_PORT, FRAME_PORT] = await Promise.all([freePort(), freePort()]);
// Different hosts, so the iframe is cross-site and runs out of process under Fission.
const PAGE = `http://localhost:${PAGE_PORT}`;
const FRAME = `http://127.0.0.1:${FRAME_PORT}`;

const PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Bridge test page</title>
<style>
  body { font: 16px sans-serif; margin: 20px; }
  #btn { position: absolute; left: 40px; top: 110px; width: 160px; height: 50px; }
  #text { position: absolute; left: 240px; top: 120px; width: 200px; }
  #frame { position: absolute; left: 40px; top: 180px; width: 300px; height: 120px; border: 2px solid #888; }
  #color { position: absolute; left: 480px; top: 120px; }
  #blank { position: absolute; left: 40px; top: 330px; }
  #upload { position: absolute; left: 240px; top: 330px; }
  #tall { position: absolute; top: 0; left: 0; width: 1px; height: 3000px; }
</style></head>
<body>
<h1>Bridge test page</h1>
<p>Marker text: purple-giraffe-42</p>
<button id="btn">Record click</button>
<input id="text" aria-label="Your name" placeholder="Your name">
<label for="color" style="position:absolute;left:480px;top:95px">Favorite color</label>
<select id="color" aria-label="Favorite color"><option value="red">Red</option><option value="green">Green</option><option value="blue">Blue</option></select>
<iframe id="frame" src="${FRAME}/frame"></iframe>
<a id="blank" href="/other" target="_blank">Open other page</a>
<input id="upload" type="file" aria-label="Resume file">
<div id="tall"></div>
<script>
  window.clicks = [];
  window.keys = [];
  window.frameClicks = [];
  document.getElementById("btn").addEventListener("click", (e) => clicks.push(e.isTrusted));
  document.getElementById("text").addEventListener("keydown", (e) => keys.push([e.key, e.isTrusted]));
  addEventListener("message", (e) => { if (e.origin === ${JSON.stringify(FRAME)}) frameClicks.push(e.data); });
</script>
</body></html>`;

const OTHER_HTML = `<!doctype html><title>Other page</title><p>Opened by target=_blank</p>`;

const FRAME_HTML = `<!doctype html>
<html><head><style>body { margin: 0; } #fbtn { position: absolute; left: 20px; top: 20px; width: 140px; height: 50px; }</style></head>
<body><button id="fbtn">Frame button</button>
<script>
  let n = 0;
  document.getElementById("fbtn").addEventListener("click", (e) => parent.postMessage({ isTrusted: e.isTrusted, count: ++n }, "*"));
</script></body></html>`;

// ---- helpers -------------------------------------------------------------------------------

function saveImage(image, file) {
  const buf = Buffer.from(image.data, "base64");
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
  const isPng = buf.subarray(1, 4).toString() === "PNG";
  assert.ok(isJpeg || isPng, "screenshot is a JPEG or PNG");
  assert.equal(image.mimeType, isPng ? "image/png" : "image/jpeg");
  fs.writeFileSync(file.replace(/\.\w+$/, isPng ? ".png" : ".jpg"), buf);
  return buf;
}

const tabIdIn = (text) => Number(text.match(/Created tab (\d+)/)?.[1]);
const contextOf = (text) => JSON.parse(text.slice(text.indexOf("{")));

// Center of an element in screenshot coordinates. The bridge scales screenshots, so CSS pixels
// are converted with the frame size from the last screenshot's text.
async function centerOf(client, tabId, selector, frameScale) {
  const r = JSON.parse(await client.js(tabId, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 }); })()`));
  return [Math.round(r.x * frameScale), Math.round(r.y * frameScale)];
}

async function screenshotScale(client, tabId, file) {
  const r = await client.ok("computer", { action: "screenshot", tabId });
  assert.equal(r.images.length, 1, "screenshot returns one image");
  if (file) saveImage(r.images[0], file);
  const [, w] = r.text.match(/\((\d+)x(\d+)\)/).map(Number);
  const cssWidth = Number(await client.js(tabId, "innerWidth"));
  return w / cssWidth;
}

// ---- the test ------------------------------------------------------------------------------

let mn;
let failed = false;
try {
  await h.serve(PAGE_PORT, { "/": PAGE_HTML, "/other": OTHER_HTML });
  await h.serve(FRAME_PORT, { "/frame": FRAME_HTML });
  const UPLOAD = path.join(h.TMP, "upload-test.txt");
  fs.writeFileSync(UPLOAD, "upload body 123\n");

  await h.step("install.sh --no-clients writes the native manifest, proxy file and prefs", async () => {
    const out = h.install(["--no-clients"]);
    assert.match(out, /Firefox: installed into/);
    assert.doesNotMatch(out, /Claude Code|Codex|Claude desktop/);
  });

  const display = await h.startXvfb();
  h.startFirefox(display);

  await h.step(`Firefox on Xvfb ${display} starts the native host`, async () => {
    await h.waitForBridge();
  });

  mn = await h.marionette();
  const agent = h.mcpClient("test-client");
  let tab;
  let scale;

  await h.step("initialize and tools/list", async () => {
    const init = await agent.init();
    assert.equal(init.result.serverInfo.name, "firefox-agent-bridge");
    assert.doesNotMatch(init.result.instructions, /Claude/);
    agent.notify("notifications/initialized");
    const { result } = await agent.request("tools/list");
    const names = result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["computer", "file_upload", "find", "form_input", "get_page_text", "javascript_tool", "navigate", "read_page", "tabs_close_mcp", "tabs_context_mcp", "tabs_create_mcp"]);
    assert.doesNotMatch(JSON.stringify(result), /Claude/);
  });

  await h.step("tabs_context_mcp and tabs_create_mcp; group is named after the client", async () => {
    const empty = contextOf((await agent.ok("tabs_context_mcp", {})).text);
    assert.deepEqual(empty.availableTabs, []);
    const created = await agent.ok("tabs_context_mcp", { createIfEmpty: true });
    const ctx = contextOf(created.text);
    assert.equal(ctx.availableTabs.length, 1);
    assert.equal(ctx.tabGroup, "Test");
    const r = await agent.ok("tabs_create_mcp");
    tab = tabIdIn(r.text);
    assert.ok(tab > 0, r.text);
    assert.match(r.text, /in the Test tab group/);
    assert.equal(contextOf(r.text).availableTabs.length, 2);
    assert.deepEqual(await mn.groupTitles(), ["Test"]);
    // The first tab is spare; closing it checks tabs_close_mcp.
    const spare = ctx.availableTabs[0].tabId;
    assert.match((await agent.ok("tabs_close_mcp", { tabId: spare })).text, new RegExp(`Closed tab ${spare}`));
    assert.deepEqual(contextOf((await agent.ok("tabs_context_mcp", {})).text).availableTabs.map((t) => t.tabId), [tab]);
  });

  await h.step("navigate loads the test page in the background", async () => {
    const r = await agent.ok("navigate", { url: `${PAGE}/`, tabId: tab });
    assert.match(r.text, /Title: Bridge test page/);
    const selected = await mn.chrome("return gBrowser.selectedTab.label");
    assert.notEqual(selected, "Bridge test page", "the session tab didn't take focus");
    // Wait for the cross-origin iframe to load its button.
    await until("iframe load", async () => (await agent.js(tab, "document.getElementById('frame').contentWindow != null && document.readyState")) === "complete");
  });

  await h.step("computer screenshot returns an image", async () => {
    scale = await screenshotScale(agent, tab, path.join(SHOTS, "test-page.jpg"));
    assert.ok(scale > 0.3 && scale <= 1, `scale ${scale}`);
  });

  await h.step("left_click by coordinate is trusted", async () => {
    const at = await centerOf(agent, tab, "#btn", scale);
    await agent.ok("computer", { action: "left_click", tabId: tab, coordinate: at });
    assert.equal(await agent.js(tab, "JSON.stringify(clicks)"), "[true]");
  });

  const TYPED = "secret words 99";
  await h.step("type and key go to the focused input as trusted events", async () => {
    await agent.ok("computer", { action: "left_click", tabId: tab, coordinate: await centerOf(agent, tab, "#text", scale) });
    await agent.ok("computer", { action: "type", tabId: tab, text: TYPED });
    assert.equal(await agent.js(tab, "document.getElementById('text').value"), TYPED);
    await agent.ok("computer", { action: "key", tabId: tab, text: "Backspace", repeat: 3 });
    assert.equal(await agent.js(tab, "document.getElementById('text').value"), TYPED.slice(0, -3));
    const keys = JSON.parse(await agent.js(tab, "JSON.stringify(keys)"));
    assert.ok(keys.length >= TYPED.length, `keydowns: ${keys.length}`);
    assert.ok(keys.every(([, trusted]) => trusted === true), "every keydown is trusted");
    assert.deepEqual(keys.at(-1), ["Backspace", true]);
  });

  await h.step("scroll moves the page, also when over an iframe that can't scroll", async () => {
    const scrollY = async () => Number(await agent.js(tab, "scrollY"));
    await agent.ok("computer", { action: "scroll", tabId: tab, coordinate: [700, 600], scroll_direction: "down", scroll_amount: 3 });
    assert.equal(await scrollY(), 300);
    await agent.ok("computer", { action: "scroll", tabId: tab, coordinate: [700, 600], scroll_direction: "up", scroll_amount: 10 });
    assert.equal(await scrollY(), 0);
    // A wheel over a frame that can't scroll scrolls the page around it.
    const r = await agent.ok("computer", { action: "scroll", tabId: tab, coordinate: await centerOf(agent, tab, "#frame", scale), scroll_direction: "down", scroll_amount: 2 });
    assert.equal(await scrollY(), 200, r.text);
    assert.match(r.text, /Scrolled page down by 200px/);
    await agent.js(tab, "scrollTo(0, 0)");
  });

  let selectRef;
  let fileRef;
  await h.step("read_page, find, form_input and get_page_text", async () => {
    const tree = (await agent.ok("read_page", { tabId: tab, filter: "interactive" })).text;
    assert.match(tree, /Record click/);
    assert.match(tree, /ref_\d+/);
    const found = (await agent.ok("find", { tabId: tab, query: "favorite color select" })).text;
    selectRef = found.match(/ref_\d+/)?.[0];
    assert.ok(selectRef, found);
    await agent.ok("form_input", { tabId: tab, ref: selectRef, value: "Blue" });
    assert.equal(await agent.js(tab, "document.getElementById('color').value"), "blue");
    const files = (await agent.ok("find", { tabId: tab, query: "resume file input" })).text;
    fileRef = files.match(/ref_\d+/)?.[0];
    assert.ok(fileRef, files);
    const text = (await agent.ok("get_page_text", { tabId: tab })).text;
    assert.match(text, /purple-giraffe-42/);
    assert.match(text, /Bridge test page/);
  });

  await h.step("left_click inside the cross-origin iframe is trusted", async () => {
    const frame = JSON.parse(await agent.js(tab, "(() => { const r = document.getElementById('frame').getBoundingClientRect(); return JSON.stringify({ x: r.left + 2, y: r.top + 2 }); })()"));
    // The frame's button is at 20,20 (140x50) inside its 2px border.
    const at = [Math.round((frame.x + 90) * scale), Math.round((frame.y + 45) * scale)];
    await agent.ok("computer", { action: "left_click", tabId: tab, coordinate: at });
    const got = await until("frame click message", async () => {
      const v = JSON.parse(await agent.js(tab, "JSON.stringify(frameClicks)"));
      return v.length ? v : null;
    }, 5000);
    assert.deepEqual(got, [{ isTrusted: true, count: 1 }]);
  });

  await h.step("file_upload sets the file input without a picker", async () => {
    const r = await agent.ok("file_upload", { tabId: tab, ref: fileRef, paths: [UPLOAD] });
    assert.match(r.text, /upload-test\.txt/);
    assert.equal(await agent.js(tab, "await document.getElementById('upload').files[0].text()"), "upload body 123\n");
  });

  await h.step("a target=_blank link opens a tab in the group without taking focus", async () => {
    const before = await mn.chrome("return gBrowser.selectedTab.label");
    const r = await agent.ok("computer", { action: "left_click", tabId: tab, coordinate: await centerOf(agent, tab, "#blank", scale) });
    const opened = Number(r.text.match(/opened a new tab in this session's group: tab (\d+)/)?.[1]);
    assert.ok(opened, r.text);
    assert.match(r.text, /\/other \(Other page\)/);
    const ctx = contextOf((await agent.ok("tabs_context_mcp", {})).text);
    assert.deepEqual(ctx.availableTabs.map((t) => t.tabId).sort(), [tab, opened].sort());
    assert.equal(await mn.chrome("return gBrowser.selectedTab.label"), before, "focus went back to the user's tab");
    await agent.ok("tabs_close_mcp", { tabId: opened });
  });

  await h.step("the test page screenshot is saved as PNG", async () => {
    await mn.toTab(`${PAGE}/`);
    await mn.screenshot(path.join(SHOTS, "test-page.png"));
  });

  // ---- popup ----

  const uuid = await h.extensionUuid();
  const POPUP = `moz-extension://${uuid}/popup/popup.html`;
  let popupTab;

  await h.step("the popup page opens in a session tab and lists test-client", async () => {
    popupTab = tabIdIn((await agent.ok("tabs_create_mcp")).text);
    const r = await agent.ok("navigate", { tabId: popupTab, url: POPUP });
    assert.match(r.text, /Title: Firefox Agent Bridge/);
    const text = (await agent.ok("get_page_text", { tabId: popupTab })).text;
    assert.match(text, /test-client/);
    assert.match(text, /\(self-reported\)/);
    assert.match(text, /version 1\.2\.3/);
    assert.match(text, new RegExp(`pid \\d+`));
  });

  await h.step("the activity log shows the calls without typed text", async () => {
    const text = (await agent.ok("get_page_text", { tabId: popupTab })).text;
    for (const s of ["computer: type", `${TYPED.length} chars typed`, "computer: left_click", "file_upload", "form_input", "javascript_tool", "navigate"]) assert.ok(text.includes(s), `log shows "${s}"`);
    const html = await agent.js(popupTab, "document.body.innerHTML");
    for (const secret of [TYPED, "Blue", UPLOAD, "upload-test", "purple-giraffe", "favorite color", "getBoundingClientRect"]) {
      assert.ok(!html.includes(secret), `popup must not show "${secret}"`);
    }
    await mn.toTab(POPUP);
    await mn.screenshot(path.join(SHOTS, "popup.png"));
    saveImage((await agent.ok("computer", { action: "screenshot", tabId: popupTab })).images[0], path.join(SHOTS, "popup-bridge.jpg"));
  });

  await h.step("Stop pauses the session; Resume all restores it", async () => {
    const pscale = await screenshotScale(agent, popupTab);
    const stopRect = "return JSON.stringify(document.getElementById('stop').getBoundingClientRect())";
    const before = await agent.js(popupTab, stopRect.replace("return ", ""));
    const stop = await agent.call("computer", { action: "left_click", tabId: popupTab, coordinate: await centerOf(agent, popupTab, "#stop", pscale) });
    // The click that pressed Stop is itself stopped.
    assert.ok(stop.isError, stop.text);
    assert.match(stop.text, /stopped this call/);
    const refused = await agent.call("tabs_context_mcp", {});
    assert.ok(refused.isError);
    assert.match(refused.text, /The user paused this session/);
    await until("(paused) group title", async () => (await mn.groupTitles()).includes("Test (paused)"), 5000);
    await mn.toTab(POPUP);
    const status = () => mn.cmd("WebDriver:ExecuteScript", { script: "return document.getElementById('status').textContent" }).then((r) => r.value);
    await until("popup status Paused", async () => /^Paused: 1 session/.test(await status()), 3000);
    // A second click on Stop must not land on Resume all.
    assert.equal((await mn.cmd("WebDriver:ExecuteScript", { script: stopRect })).value, before, "Stop stays in place");
    await mn.screenshot(path.join(SHOTS, "popup-stopped.png"));
    const resume = await mn.cmd("WebDriver:FindElement", { using: "css selector", value: "#resume-all" });
    await mn.cmd("WebDriver:ElementClick", { id: Object.values(resume.value)[0] });
    await until("group title without (paused)", async () => (await mn.groupTitles()).includes("Test"), 5000);
    assert.equal((await agent.call("tabs_context_mcp", {})).isError, false);
  });

  await h.step("Disconnect blocks the client's name; Unblock lets it back", async () => {
    const helper = h.mcpClient("helper-agent");
    await helper.init();
    const htab = tabIdIn((await helper.ok("tabs_create_mcp")).text);
    await helper.ok("navigate", { tabId: htab, url: POPUP });
    assert.deepEqual((await mn.groupTitles()).sort(), ["Helper", "Test"]);
    const hscale = await screenshotScale(helper, htab);
    const disconnect = JSON.parse(
      await helper.js(htab, `(() => { const li = [...document.querySelectorAll("#client-list > li")].find((l) => l.textContent.includes("test-client")); const r = li.querySelector("button").getBoundingClientRect(); return JSON.stringify([r.left + r.width / 2, r.top + r.height / 2]); })()`),
    ).map((v) => Math.round(v * hscale));
    await helper.ok("computer", { action: "left_click", tabId: htab, coordinate: disconnect });
    const refused = await agent.call("tabs_context_mcp", {});
    assert.ok(refused.isError);
    assert.match(refused.text, /disconnected this client \("test-client"\)/);
    const again = await agent.call("get_page_text", { tabId: tab });
    assert.match(again.text, /disconnected this client/);
    const text = (await helper.ok("get_page_text", { tabId: htab })).text;
    assert.match(text, /Disconnected until you unblock them/);
    await mn.toTab(POPUP);
    await mn.screenshot(path.join(SHOTS, "popup-blocked.png"));
    // By ref this time: the list above it grows when test-client reconnects.
    const found = (await helper.ok("find", { tabId: htab, query: "Unblock button" })).text;
    const unblock = found.match(/"Unblock" \[(ref_\d+)\]/)?.[1];
    assert.ok(unblock, found);
    assert.match((await helper.ok("computer", { action: "left_click", tabId: htab, ref: unblock })).text, /Clicked button "Unblock"/);
    const back = await agent.call("get_page_text", { tabId: tab });
    assert.equal(back.isError, false, back.text);
    assert.match(back.text, /purple-giraffe-42/);
    await helper.ok("tabs_close_mcp", { tabId: htab });
  });

  await h.step("tabs_close_mcp closes the session's tabs", async () => {
    await agent.ok("tabs_close_mcp", { tabId: popupTab });
    await agent.ok("tabs_close_mcp", { tabId: tab });
    assert.deepEqual(contextOf((await agent.ok("tabs_context_mcp", {})).text).availableTabs, []);
    const refused = await agent.call("get_page_text", { tabId: tab });
    assert.ok(refused.isError);
    assert.match(refused.text, /no longer exists/);
  });

  await h.step("after a restart the session's group comes back as \"Test (earlier)\"", async () => {
    const kept = tabIdIn((await agent.ok("tabs_create_mcp")).text);
    await agent.ok("navigate", { tabId: kept, url: `${PAGE}/other` });
    const exited = new Promise((r) => h.firefox.once("exit", r));
    await mn.cmd("Marionette:Quit", { flags: ["eAttemptQuit"] }).catch(() => {});
    mn.close();
    await exited;
    await until("socket removed", () => !fs.existsSync(h.SOCKET), 10_000);
    h.startFirefox(display);
    await until("bridge.sock after restart", () => fs.existsSync(h.SOCKET), 60_000, 250);
    mn = await h.marionette();
    // The chrome side spells the WebExtension color "grey" as "gray".
    const groups = () => mn.chrome("return gBrowser.tabGroups.map((g) => g.label + ' ' + g.color)");
    await until("restored group renamed", async () => (await groups()).length, 15_000, 250);
    await until("restored group renamed", async () => (await groups()).join() === "Test (earlier) gray", 10_000, 250).catch(async () => {
      throw new Error(`groups after restart: ${JSON.stringify(await groups())}`);
    });
    // The MCP server reconnects on its next call, and gets a fresh group.
    const r = await agent.ok("tabs_create_mcp");
    assert.match(r.text, /in the Test tab group/);
    assert.deepEqual((await mn.groupTitles()).sort(), ["Test", "Test (earlier)"]);
  });
} catch (e) {
  failed = true;
  console.error(`not ok ${h.passed + 1} - ${e.stack ?? e}`);
  if (/timed out|bridge\.sock|Firefox/.test(String(e.message)) && !String(e.message).includes("--- host.log")) console.error(h.diagnostics());
} finally {
  mn?.close();
  await h.cleanup();
}

console.log(failed ? `\nFAILED after ${h.passed} passing steps` : `\n${h.passed} passed. Screenshots in ${SHOTS}`);
process.exit(failed ? 1 : 0);
