// Rule matching and text masking for redaction, kept free of DOM and Firefox APIs so the tests
// can load it in Node. The actor (actor-child.sys.mjs) finds the fields; this decides which are
// sensitive and what the agent reads in their place.
//
// Rules come from ~/.firefox-agent-bridge/redact.json, through the host and background.js:
// { always: [input types or autocomplete tokens, "cc-*" globs], sites: { "chase.com": [selectors] } }

// Shown on the bars drawn over fields in screenshots; other kinds read as their token.
const KIND_LABELS = {
  "cc-number": "card number",
  "cc-exp": "expiry",
  "cc-exp-month": "expiry month",
  "cc-exp-year": "expiry year",
  "cc-csc": "cvc",
  "cc-name": "name on card",
  "cc-given-name": "name on card",
  "cc-additional-name": "name on card",
  "cc-family-name": "name on card",
  "cc-type": "card type",
  "one-time-code": "one-time code",
  "new-password": "new password",
  "current-password": "password",
};

// Field values shorter than this aren't looked for elsewhere in the text (a month, a CVC would
// mask every "08" or "314" on the page); where the field itself is shown, it is always masked.
const MIN_ECHO = 4;

const tokenMatches = (token, value) => (token.endsWith("*") ? value.startsWith(token.slice(0, -1)) : value === token);

// The selectors that apply to a host: a site key covers the host and its subdomains.
export function siteSelectors(rules, host) {
  const h = String(host ?? "").toLowerCase();
  const out = [];
  for (const [site, list] of Object.entries(rules?.sites ?? {})) {
    if (h === site || h.endsWith(`.${site}`)) out.push(...(Array.isArray(list) ? list : []).filter((s) => typeof s === "string" && s));
  }
  return out;
}

// What makes a form field sensitive under the `always` rules: its first matching autocomplete
// token, else its input type. Null when it isn't.
export function fieldKind(rules, { tag, type, autocomplete }) {
  const always = (rules?.always ?? []).filter((t) => typeof t === "string" && t).map((t) => t.toLowerCase());
  if (!always.length) return null;
  const tokens = String(autocomplete ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const token = tokens.find((t) => always.some((a) => tokenMatches(a, t)));
  if (token) return token;
  const t = String(type ?? "").toLowerCase();
  if (tag === "INPUT" && t && t !== "hidden" && always.some((a) => tokenMatches(a, t))) return t;
  return null;
}

// A site rule's kind: a plain class or id selector names itself (".account-number" is
// "account-number"); anything more involved is just a site rule.
export function selectorKind(selector) {
  const m = /^[.#]?([\w-]+)$/.exec(String(selector).trim());
  return m ? m[1] : "site rule";
}

export const marker = (kind, filled) => `[redacted: ${kind}, ${filled ? "filled" : "empty"}]`;

export const barLabel = (kind, filled) => `${KIND_LABELS[kind] ?? kind.replace(/[-_]+/g, " ")} · ${filled ? "filled" : "empty"}`;

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Replaces each secret in text with its marker. Secrets are { text, marker, echo }, where echo
// marks a field's value (only looked for when long enough) as against the text of a masked
// element. Text runs together where the page has no space between elements ("Checking1234"), so a
// secret is matched anywhere, except a short one, which must not sit inside a longer word or
// number. Returns the text and the indexes of the secrets that were found.
export function scrub(text, secrets) {
  const hits = new Set();
  const byNeedle = new Map();
  secrets.forEach((s, i) => {
    const needle = String(s.text ?? "").trim();
    if (needle.length >= (s.echo ? MIN_ECHO : 2) && !byNeedle.has(needle)) byNeedle.set(needle, i);
  });
  if (!byNeedle.size) return { text: String(text), hits };
  // One pass, longest first, so a secret that contains another is replaced whole and a marker
  // already written is never matched again.
  const needles = [...byNeedle.keys()].sort((a, b) => b.length - a.length);
  const pattern = needles.map((n) => (n.length >= MIN_ECHO ? escape(n) : `(?<![\\p{L}\\p{N}])${escape(n)}(?![\\p{L}\\p{N}])`)).join("|");
  const re = new RegExp(pattern, "gu");
  const out = String(text).replace(re, (m) => {
    const i = byNeedle.get(m);
    hits.add(i);
    return secrets[i].marker;
  });
  return { text: out, hits };
}

// Page text doesn't include what's typed into fields, so a masked field is marked after its
// label instead: the first line that is exactly the label's text, not yet marked, gets the marker.
// Fields is [{ label, marker }]; returns the text and the indexes of the fields marked.
export function markLabels(text, fields) {
  const lines = String(text).split("\n");
  const taken = new Set();
  const hits = new Set();
  fields.forEach((f, i) => {
    const label = String(f.label ?? "").replace(/\s+/g, " ").trim();
    if (!label) return;
    const at = lines.findIndex((l, n) => !taken.has(n) && l.replace(/\s+/g, " ").trim() === label);
    if (at < 0) return;
    taken.add(at);
    lines[at] = `${lines[at].trimEnd()}  ${f.marker}`;
    hits.add(i);
  });
  return { text: lines.join("\n"), hits };
}
