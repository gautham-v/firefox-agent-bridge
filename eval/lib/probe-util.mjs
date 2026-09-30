// Shared plumbing for the offline probes: argument parsing, a resumable results file keyed by
// URL, and a deadline so each invocation stays under --max-minutes.

import fs from "node:fs";
import path from "node:path";

export function probeArgs(defaults = {}) {
  const argv = process.argv.slice(2);
  const opt = (name, dflt) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : dflt;
  };
  return {
    maxMinutes: Number(opt("max-minutes", defaults.maxMinutes ?? 8)),
    limit: Number(opt("limit", Infinity)),
    only: opt("only")?.split(","),
    out: opt("out", defaults.out),
    redo: argv.includes("--redo"),
  };
}

export function resultsFile(file) {
  const load = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { rows: {} });
  const data = load();
  return {
    data,
    has: (url) => !!data.rows[url] && !data.rows[url].error,
    save(url, row) {
      data.rows[url] = row;
      data.updated = new Date().toISOString();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
    },
  };
}

// Races a promise against a timeout.
export function within(ms, p, what) {
  let t;
  return Promise.race([p, new Promise((_, rej) => (t = setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000}s`)), ms)))]).finally(() => clearTimeout(t));
}
