// Teach's host half: turning a recording and a draft into replay.json and SKILL.md, and writing
// them where Save and Try it once say, with HOME set to a temp dir.
//   node --test host/test/*.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildReplay, createTeach, skillMarkdown } from "../teach.mjs";

const RECORDING = {
  id: "rec-1",
  site: "bpl.bibliocommons.com",
  start: "https://bpl.bibliocommons.com/",
  steps: [
    { n: 1, action: "click", target: { role: "link", name: "Log in", css: "#login", near: "Welcome back" } },
    { n: 2, action: "type", target: { role: "textbox", name: "Library card" }, value: "2123400000" },
    { n: 3, action: "type", target: { role: "textbox", name: "PIN", frame: [{ index: 0, url: "https://login.example/" }] }, secret: "keychain" },
    { n: 4, action: "click", target: { role: "link", name: "Help" } },
    { n: 5, action: "key", key: "Enter", target: { role: "textbox", name: "PIN" } },
    { n: 6, action: "click", target: { role: "button", name: "Renew all" } },
    { n: 7, action: "navigate", url: "https://bpl.bibliocommons.com/checkedout" },
  ],
};

const DRAFT = {
  name: "renew-library-books",
  description: "Renew everything checked out at Brooklyn Public Library.",
  trigger: "renew my books",
  inputs: [{ name: "card_number", step: 2, from: "input", about: "the library card number" }],
  checks: 'Page shows "Renewed" for each item',
  notes: ['"Renew all" is hidden until the list finishes loading.'],
  steps: [{ from: 1 }, { from: 2 }, { from: 3 }, { from: 5 }, { from: 6, expect: { text: "Renewed" } }, { from: 99 }],
};

test("buildReplay keeps the draft's steps, makes named values inputs, and reads secrets from inputs", () => {
  const replay = buildReplay(RECORDING, DRAFT, new Set([1, 6]));
  assert.deepEqual(replay, {
    version: 1,
    site: "bpl.bibliocommons.com",
    start: "https://bpl.bibliocommons.com/",
    inputs: ["card_number", "pin:keychain"],
    steps: [
      { click: { role: "link", name: "Log in", css: "#login", near: "Welcome back" }, shot: "steps/1.jpg" },
      { type: { role: "textbox", name: "Library card" }, text: "{card_number}" },
      { type: { role: "textbox", name: "PIN", frame: [{ index: 0, url: "https://login.example/" }] }, text: "{pin}" },
      { key: "Enter" },
      { click: { role: "button", name: "Renew all" }, expect: { text: "Renewed" }, shot: "steps/6.jpg" },
    ],
  });
});

test("buildReplay without a step plan replays every recorded step; unnamed values stay literal", () => {
  const replay = buildReplay(RECORDING, { name: "x" });
  assert.equal(replay.steps.length, 7);
  assert.equal(replay.steps[1].text, "2123400000");
  assert.equal(replay.steps[6].navigate, "https://bpl.bibliocommons.com/checkedout");
  assert.deepEqual(replay.inputs, ["pin:keychain"]);
  // A draft can't turn a secret into a literal, or name an input badly.
  const odd = buildReplay(RECORDING, { inputs: [{ name: "Bad Name", step: 2 }, { name: "code", step: 3, from: "input" }], steps: [{ from: 3, text: "guess" }] });
  assert.deepEqual(odd.inputs, ["code:keychain"]);
  assert.deepEqual(odd.steps, [{ type: { role: "textbox", name: "PIN", frame: [{ index: 0, url: "https://login.example/" }] }, text: "{code}" }]);
});

test("buildReplay: a select recorded without its value (a masked field) reads it from an ask input", () => {
  const replay = buildReplay({ site: "shop.example", steps: [{ n: 1, action: "select", target: { role: "combobox", name: "Expiry month" }, secret: "ask" }] }, { name: "pay", steps: [{ from: 1 }] });
  assert.deepEqual(replay.inputs, ["expiry_month:ask"]);
  assert.deepEqual(replay.steps, [{ select: { role: "combobox", name: "Expiry month" }, value: "{expiry_month}" }]);
});

test("skillMarkdown: frontmatter, replay first (or not), inputs, steps and notes", () => {
  const replay = buildReplay(RECORDING, DRAFT);
  const md = skillMarkdown(DRAFT, replay, { dir: "/h/.claude/skills/renew-library-books" });
  assert.match(md, /^---\nname: renew-library-books\ndescription: "Renew everything checked out at Brooklyn Public Library\. Use when the user says \\"renew my books\\"\."\n---\n/);
  assert.match(md, /call the Firefox `replay_steps` tool with `path` set to `\/h\/\.claude\/skills\/renew-library-books\/replay\.json` and the inputs below/);
  assert.match(md, /It worked when: Page shows "Renewed" for each item/);
  assert.match(md, /- `card_number`: the library card number \(ask the user if they didn't say\)/);
  assert.match(md, /- `pin` \(a saved password: look it up in the macOS Keychain/);
  assert.match(md, /2\. Type `\{card_number\}` into textbox "Library card"/);
  assert.match(md, /5\. Click button "Renew all"; then the page shows "Renewed"/);
  assert.match(md, /## Site notes\n\n- "Renew all" is hidden until the list finishes loading\./);
  const manual = skillMarkdown(DRAFT, replay, { dir: "/d", useReplay: false });
  assert.doesNotMatch(manual, /call the Firefox `replay_steps`/);
  assert.match(manual, /following the recorded steps below/);
});

function setup(env = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fab-teach-"));
  const sent = [];
  const teach = createTeach({ send: (m) => sent.push(m), home, env });
  return { home, sent, teach, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

const JPEG = Buffer.from("fake jpeg").toString("base64");

test("Save writes SKILL.md, replay.json and the kept steps' screenshots; a second save needs replace", () => {
  const { home, sent, teach, cleanup } = setup();
  try {
    assert.equal(teach.handle({ type: "chat.send" }), false);
    teach.handle({ type: "teach.save", requestId: "a", mode: "skill", engine: "claude", draft: DRAFT, recording: RECORDING, replay: true, shots: { 1: JPEG, 4: JPEG, x: JPEG } });
    const dir = path.join(home, ".claude/skills/renew-library-books");
    assert.deepEqual(sent[0], { type: "teach.saved", requestId: "a", ok: true, dir, replayPath: path.join(dir, "replay.json") });
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "replay.json"), "utf8")).steps[0].shot, "steps/1.jpg");
    assert.match(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8"), /^---\nname: renew-library-books/);
    assert.deepEqual(fs.readdirSync(path.join(dir, "steps")), ["1.jpg"], "only screenshots of kept steps");
    assert.equal(fs.readFileSync(path.join(dir, "steps/1.jpg"), "utf8"), "fake jpeg");

    teach.handle({ type: "teach.save", requestId: "b", mode: "skill", engine: "claude", draft: DRAFT, recording: RECORDING });
    assert.deepEqual(sent[1], { type: "teach.saved", requestId: "b", ok: false, exists: true, dir, error: "A skill named renew-library-books already exists." });
    teach.handle({ type: "teach.save", requestId: "c", mode: "skill", engine: "claude", draft: { ...DRAFT, checks: "new" }, recording: RECORDING, replace: true, replay: false });
    assert.equal(sent[2].ok, true);
    assert.match(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8"), /It worked when: new/);
  } finally {
    cleanup();
  }
});

test("Try it once writes only a replay.json in the chat's folder; Codex skills go to Codex's folder", () => {
  const { home, sent, teach, cleanup } = setup();
  try {
    teach.handle({ type: "teach.save", requestId: "t", mode: "try", chatId: "chat-1", engine: "claude", draft: DRAFT, recording: RECORDING });
    const dir = path.join(home, ".firefox-agent-bridge/chat/teach/chat-1/renew-library-books");
    assert.equal(sent[0].ok, true);
    assert.equal(sent[0].replayPath, path.join(dir, "replay.json"));
    assert.deepEqual(fs.readdirSync(dir), ["replay.json"]);
    teach.handle({ type: "teach.save", requestId: "t2", mode: "try", chatId: "../x", draft: DRAFT, recording: RECORDING });
    assert.equal(sent[1].ok, false);

    teach.handle({ type: "teach.save", requestId: "c", mode: "skill", engine: "codex", draft: DRAFT, recording: RECORDING });
    assert.equal(sent[2].dir, path.join(home, ".codex/skills/renew-library-books"));
  } finally {
    cleanup();
  }
});

test("Save refuses a bad name or a draft with nothing to replay", () => {
  const { sent, teach, cleanup } = setup();
  try {
    for (const name of ["../escape", "Has Caps", "", "-dash"]) teach.handle({ type: "teach.save", requestId: name, mode: "skill", draft: { ...DRAFT, name }, recording: RECORDING });
    assert.ok(sent.every((m) => m.ok === false && /lowercase letters/.test(m.error)));
    teach.handle({ type: "teach.save", requestId: "e", mode: "skill", draft: { name: "empty", steps: [{ from: 42 }] }, recording: RECORDING });
    assert.equal(sent.at(-1).error, "The draft has no steps to save.");
  } finally {
    cleanup();
  }
});
