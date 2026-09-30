// Answer extraction and field checkers shared by the tasks.

// The last JSON object in the text (the task prompts ask for one on the final line).
export function lastJson(text) {
  if (!text) return null;
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  for (const body of fenced.reverse()) {
    try {
      const v = JSON.parse(body.trim());
      if (v && typeof v === "object") return v;
    } catch {}
  }
  for (let end = text.lastIndexOf("}"); end >= 0; end = text.lastIndexOf("}", end - 1)) {
    let depth = 0;
    for (let i = end; i >= 0; i--) {
      if (text[i] === "}") depth++;
      else if (text[i] === "{" && --depth === 0) {
        try {
          const v = JSON.parse(text.slice(i, end + 1));
          if (v && typeof v === "object") return v;
        } catch {}
        break;
      }
    }
  }
  return null;
}

// The answer is the last JSON in the final message. When that message has none, it is the last
// JSON in an earlier message: since tabs_context_mcp says "Created tab N ... close it", a run can
// answer, then close its tab and end on "I closed the tab. The answer is above."
export function answerOf(finalText, events) {
  const fromFinal = lastJson(finalText);
  if (fromFinal) return { answer: fromFinal, answerSource: "final" };
  let answer = null;
  for (const e of events)
    if (e.type === "assistant" && !e.parent_tool_use_id)
      for (const b of e.message?.content ?? []) if (b.type === "text") answer = lastJson(b.text) ?? answer;
  return { answer, answerSource: answer ? "earlier_text" : null };
}

export const norm = (s) =>
  String(s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[‘’“”]/g, "'")
    .replace(/[^\p{L}\p{N}.]+/gu, " ")
    .trim();

export function toNumber(v) {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return NaN;
  const m = v.replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : NaN;
}

// Checkers return true/false for one field.
export const num = (expected, tol = 0) => (v) => Math.abs(toNumber(v) - expected) <= tol;
export const match = (re) => (v) => re.test(String(v ?? ""));
export const eqNorm = (expected) => (v) => norm(v) === norm(expected);
export const pyReq = (expected) => (v) => String(v ?? "").replace(/\s+/g, "").replace(/^python/i, "") === expected.replace(/\s+/g, "");

// Same set of names: each expected item matches exactly one answer item (normalized, either
// containing the other), and there are no extra answer items.
export const sameSet = (expected) => (v) => {
  if (!Array.isArray(v)) return false;
  const got = v.map(norm);
  const want = expected.map(norm);
  if (got.length !== want.length) return false;
  const used = new Set();
  for (const w of want) {
    const i = got.findIndex((g, j) => !used.has(j) && (g === w || (g.length > 3 && w.includes(g)) || g.includes(w)));
    if (i < 0) return false;
    used.add(i);
  }
  return true;
};

// Applies {field: checker} to an answer object. Nested fields use "a.b" paths; keys are matched
// case-insensitively so "Express" and "express" both work.
export function checkFields(answer, checks) {
  const fields = {};
  const get = (obj, key) => {
    if (!obj || typeof obj !== "object") return undefined;
    if (key in obj) return obj[key];
    const k = Object.keys(obj).find((x) => norm(x) === norm(key));
    return k === undefined ? undefined : obj[k];
  };
  for (const [path, fn] of Object.entries(checks)) {
    const v = path.split("|").reduce((o, k) => get(o, k), answer);
    let ok = false;
    try {
      ok = !!fn(v);
    } catch {}
    fields[path] = ok;
  }
  return { pass: Object.values(fields).every(Boolean), fields };
}
