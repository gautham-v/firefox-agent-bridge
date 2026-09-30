// Teach by doing, the host's half (docs/teach.md). The panel sends the user's recorded steps and
// the engine's draft of a skill from them; this turns the two into replay.json and SKILL.md and
// writes them, with each step's screenshot, into a skill folder (Save skill) or the chat's
// folder (Try it once). The user pressing Save in the panel is the consent for the write.
//
//   const teach = createTeach({ send, log });
//   teach.handle(msg)   // true if msg was a teach.* message

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const isInputName = (s) => typeof s === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(s);
const SECRETS = new Set(["keychain", "ask"]);
const MAX_SHOT_BYTES = 2_000_000;
const UNSAFE_IDS = new Set(["__proto__", "constructor", "prototype"]);
const validId = (id) => typeof id === "string" && /^[\w-]{1,64}$/.test(id) && !UNSAFE_IDS.has(id);

const str = (v, n = 300) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");
const slug = (s) => str(s, 80).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "n$1").slice(0, 30);

function cleanTarget(t) {
  const out = { role: str(t?.role, 40), name: str(t?.name, 150) };
  if (t?.css) out.css = str(t.css, 300);
  if (t?.near) out.near = str(t.near, 150);
  if (Array.isArray(t?.frame) && t.frame.length) out.frame = t.frame.slice(0, 8).map((f) => ({ index: Number(f?.index) || 0, url: str(f?.url, 300) }));
  return out;
}

function cleanExpect(e) {
  if (!e || typeof e !== "object") return null;
  const out = {};
  if (str(e.text, 200)) out.text = str(e.text, 200);
  if (str(e.url, 300)) out.url = str(e.url, 300);
  return Object.keys(out).length ? out : null;
}

// The replay: the recorded steps the draft kept, in its order, with typed values the draft
// named swapped for {input} placeholders. A secret step always reads from an input, since its
// value was never recorded. `shots` holds the recorded step numbers that have a screenshot.
export function buildReplay(recording, draft, shots = new Set()) {
  const recorded = new Map((Array.isArray(recording?.steps) ? recording.steps : []).map((s) => [s?.n, s]));
  const inputs = new Map(); // name -> "input" | "keychain" | "ask"
  const inputFor = new Map(); // recorded step number -> input name
  for (const i of Array.isArray(draft?.inputs) ? draft.inputs : []) {
    if (!isInputName(i?.name)) continue;
    const rec = recorded.get(i.step);
    inputs.set(i.name, SECRETS.has(rec?.secret) ? rec.secret : SECRETS.has(i.from) ? i.from : "input");
    if (rec) inputFor.set(rec.n, i.name);
  }
  const plan = Array.isArray(draft?.steps) && draft.steps.length ? draft.steps : [...recorded.keys()].map((n) => ({ from: n }));
  const steps = [];
  for (const d of plan) {
    const rec = recorded.get(d?.from);
    if (!rec) continue;
    let input = isInputName(d.input) ? d.input : inputFor.get(rec.n);
    if (rec.secret && !input) {
      input = slug(rec.target?.name) || "secret";
      for (let k = 2; inputs.has(input) && inputs.get(input) !== rec.secret; k++) input = `${slug(rec.target?.name) || "secret"}_${k}`;
    }
    if (input && !inputs.has(input)) inputs.set(input, SECRETS.has(rec.secret) ? rec.secret : "input");
    const target = cleanTarget(rec.target);
    let step;
    if (rec.action === "click") step = { click: target };
    else if (rec.action === "type") step = { type: target, text: input ? `{${input}}` : String(rec.value ?? "") };
    else if (rec.action === "select") step = { select: target, value: input ? `{${input}}` : String(rec.value ?? "") };
    else if (rec.action === "key") step = { key: /^[A-Za-z]{1,20}$/.test(rec.key) ? rec.key : "Enter" };
    else if (rec.action === "navigate" && /^https?:/.test(rec.url ?? "")) step = { navigate: str(rec.url, 2000) };
    else continue;
    const expect = cleanExpect(d.expect);
    if (expect) step.expect = expect;
    if (shots.has(rec.n)) step.shot = `steps/${rec.n}.jpg`;
    steps.push(step);
  }
  return {
    version: 1,
    site: str(recording?.site, 200),
    start: /^https?:/.test(recording?.start ?? "") ? str(recording.start, 2000) : "",
    inputs: [...inputs].map(([name, from]) => (from === "input" ? name : `${name}:${from}`)),
    steps,
  };
}

const quoted = (t) => `${t.role || "element"}${t.name ? ` "${t.name}"` : ""}`;

function stepLine(s) {
  let line;
  if (s.click) line = `Click ${quoted(s.click)}`;
  else if (s.type) line = `Type ${/^\{\w+\}$/.test(s.text) ? `\`${s.text}\`` : JSON.stringify(s.text)} into ${quoted(s.type)}`;
  else if (s.select) line = `Select ${/^\{\w+\}$/.test(s.value) ? `\`${s.value}\`` : JSON.stringify(s.value)} in ${quoted(s.select)}`;
  else if (s.key) line = `Press ${s.key}`;
  else line = `Go to ${s.navigate}`;
  const after = [s.expect?.text && `the page shows "${s.expect.text}"`, s.expect?.url && `the URL contains "${s.expect.url}"`].filter(Boolean);
  return after.length ? `${line}; then ${after.join(" and ")}` : line;
}

const INPUT_SOURCES = {
  input: "ask the user if they didn't say",
  keychain: "a saved password: look it up in the macOS Keychain (or wherever the user keeps it) rather than asking for it in chat",
  ask: "ask the user each time; it changes",
};

// SKILL.md: frontmatter from the draft, then how to run it. With `replay` on, the agent runs the
// recorded steps first and only reasons about the page where they stop matching.
export function skillMarkdown(draft, replay, { dir, useReplay = true } = {}) {
  const name = str(draft?.name, 64);
  const trigger = str(draft?.trigger, 120);
  let description = str(draft?.description, 600) || `Do the task recorded on ${replay.site}.`;
  if (trigger && !description.toLowerCase().includes(trigger.toLowerCase())) description += ` Use when the user says "${trigger}".`;
  const file = path.join(dir, "replay.json");
  const about = new Map((Array.isArray(draft?.inputs) ? draft.inputs : []).map((i) => [i?.name, str(i?.about, 200)]));
  const lines = ["---", `name: ${name}`, `description: ${JSON.stringify(description)}`, "---", ""];
  if (useReplay) {
    lines.push(`Run the recorded steps first: call the Firefox \`replay_steps\` tool with \`path\` set to \`${file}\`${replay.inputs.length ? " and the inputs below" : ""}. If a step doesn't match, it stops and returns the page as it is; finish the goal from there with the other Firefox tools.`);
  } else {
    lines.push(`Do this with the Firefox tools, following the recorded steps below. \`${file}\` has each element's role, name and CSS selector.`);
  }
  if (replay.site) lines.push("", `Recorded on ${replay.site}${replay.start ? `, starting at ${replay.start}` : ""}.`);
  const checks = str(draft?.checks, 300);
  if (checks) lines.push("", `It worked when: ${checks}`);
  if (replay.inputs.length) {
    lines.push("", "## Inputs", "");
    for (const spec of replay.inputs) {
      const [input, from = "input"] = spec.split(":");
      lines.push(`- \`${input}\`${about.get(input) ? `: ${about.get(input)}` : ""} (${INPUT_SOURCES[from] ?? INPUT_SOURCES.input})`);
    }
  }
  lines.push("", "## Recorded steps", "", ...replay.steps.map((s, i) => `${i + 1}. ${stepLine(s)}`));
  const notes = (Array.isArray(draft?.notes) ? draft.notes : []).map((n) => str(n, 300)).filter(Boolean);
  if (notes.length) lines.push("", "## Site notes", "", ...notes.map((n) => `- ${n}`));
  return `${lines.join("\n")}\n`;
}

export function createTeach({ send, log = () => {}, home = os.homedir(), env = process.env } = {}) {
  const dirs = {
    claude: env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"),
    codex: env.CODEX_HOME || path.join(home, ".codex"),
    chat: path.join(home, ".firefox-agent-bridge", "chat"),
  };

  function save(msg) {
    const reply = (fields) => send({ type: "teach.saved", requestId: msg.requestId, ...fields });
    const draft = msg.draft && typeof msg.draft === "object" ? msg.draft : null;
    const name = typeof draft?.name === "string" ? draft.name : "";
    if (!SKILL_NAME.test(name)) return reply({ ok: false, error: "The skill needs a name of lowercase letters, digits and dashes. Ask for one." });
    const tryOnce = msg.mode === "try";
    if (tryOnce && !validId(msg.chatId)) return reply({ ok: false, error: "There's no chat to try it in." });
    // Try it once writes only a replay.json, in the chat's own folder, which the agent reads freely.
    const dir = tryOnce ? path.join(dirs.chat, "teach", msg.chatId, name) : path.join(msg.engine === "codex" ? dirs.codex : dirs.claude, "skills", name);
    if (!tryOnce && !msg.replace && fs.existsSync(path.join(dir, "SKILL.md"))) return reply({ ok: false, exists: true, dir, error: `A skill named ${name} already exists.` });
    const shots = new Map();
    for (const [n, data] of Object.entries(msg.shots && typeof msg.shots === "object" ? msg.shots : {})) {
      const bytes = /^\d{1,3}$/.test(n) && typeof data === "string" ? Buffer.from(data, "base64") : null;
      if (bytes?.length && bytes.length <= MAX_SHOT_BYTES) shots.set(Number(n), bytes);
    }
    const replay = buildReplay(msg.recording, draft, new Set(shots.keys()));
    if (!replay.steps.length) return reply({ ok: false, error: "The draft has no steps to save." });
    fs.mkdirSync(dir, tryOnce ? { recursive: true, mode: 0o700 } : { recursive: true });
    for (const s of replay.steps) {
      if (!s.shot) continue;
      fs.mkdirSync(path.join(dir, "steps"), { recursive: true });
      fs.writeFileSync(path.join(dir, s.shot), shots.get(Number(/\d+/.exec(s.shot)[0])));
    }
    fs.writeFileSync(path.join(dir, "replay.json"), `${JSON.stringify(replay, null, 2)}\n`);
    if (!tryOnce) fs.writeFileSync(path.join(dir, "SKILL.md"), skillMarkdown(draft, replay, { dir, useReplay: msg.replay !== false }));
    log(`teach: wrote ${tryOnce ? "a replay to try" : "the skill"} ${name} in ${dir}`);
    reply({ ok: true, dir, replayPath: path.join(dir, "replay.json") });
  }

  return {
    handle(msg) {
      if (typeof msg?.type !== "string" || !msg.type.startsWith("teach.")) return false;
      if (msg.type !== "teach.save") {
        log(`ignoring unknown ${msg.type}`);
        return true;
      }
      try {
        save(msg);
      } catch (e) {
        log(`teach.save failed: ${e.stack ?? e.message}`);
        send({ type: "teach.saved", requestId: msg.requestId, ok: false, error: `Couldn't write the skill: ${e.message}` });
      }
      return true;
    },
  };
}
