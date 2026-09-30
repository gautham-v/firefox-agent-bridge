// The user's redaction rules, ~/.firefox-agent-bridge/redact.json. The host reads them and passes
// them to the extension, which masks matching fields in everything the agent reads or sees.
// Missing, the file is written with the defaults; unreadable, the defaults apply.

import fs from "node:fs";

// Input types and autocomplete tokens masked on every site ("cc-*" is every card field).
export const DEFAULT_RULES = {
  always: ["password", "cc-*", "one-time-code", "new-password", "current-password"],
  sites: {},
};

const isText = (s) => typeof s === "string" && s.trim() !== "";

// { always: [lowercase tokens], sites: { host: [selectors] } }. A missing `always` is the
// default one; an empty list means nothing is masked everywhere. Site keys lose a leading "www."
// or "*.", since a key covers its subdomains anyway.
export function normalizeRules(raw) {
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const always = Array.isArray(obj.always) ? [...new Set(obj.always.filter(isText).map((t) => t.trim().toLowerCase()))] : [...DEFAULT_RULES.always];
  const sites = new Map();
  if (obj.sites && typeof obj.sites === "object" && !Array.isArray(obj.sites)) {
    for (const [key, value] of Object.entries(obj.sites)) {
      const host = key.trim().toLowerCase().replace(/^\*\./, "").replace(/^www\./, "");
      const list = (Array.isArray(value) ? value : [value]).filter(isText).map((s) => s.trim());
      if (host && list.length) sites.set(host, [...(sites.get(host) ?? []), ...list]);
    }
  }
  return { always, sites: Object.fromEntries(sites) };
}

export function createRedactRules(file, log = () => {}) {
  let stamp = null;
  let rules = normalizeRules(DEFAULT_RULES);

  const stampOf = () => {
    try {
      const st = fs.statSync(file);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return null;
    }
  };

  function read() {
    if (stampOf() == null) {
      try {
        fs.writeFileSync(file, JSON.stringify(DEFAULT_RULES, null, 2) + "\n", { mode: 0o600, flag: "wx" });
        log(`wrote the default redaction rules to ${file}`);
      } catch (e) {
        if (e.code !== "EEXIST") log(`could not write ${file}: ${e.message}`);
      }
    }
    stamp = stampOf();
    try {
      rules = normalizeRules(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch (e) {
      log(`could not read ${file} (${e.message}); using the default redaction rules`);
      rules = normalizeRules(DEFAULT_RULES);
    }
    return rules;
  }

  return {
    // The rules as the file has them now.
    load: read,
    // The rules again when the file changed (or went away) since they were last read, else null.
    changed: () => (stampOf() === stamp ? null : read()),
  };
}
