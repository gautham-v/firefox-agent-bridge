// Experiment arms for run.mjs and models.mjs. Each `--experiments <flags>` on the command line is
// one arm: its flags go to that run's MCP server as FIREFOX_BRIDGE_EXPERIMENTS (see
// mcp/server.mjs). `--experiments none` is an arm with no flags. `--arm-label <name>`, given once
// per --experiments in the same order, names the arms; the default name is the flags joined with
// "+". Rows record `experiments` (the flags) and `arm_label`, so arms can share one results file.

import { execFileSync } from "node:child_process";
import { SERVER } from "./mcp-client.mjs";

// The flags this checkout's server knows, from the server itself.
export const knownFlags = () => execFileSync(process.execPath, [SERVER, "--list-experiments"], { encoding: "utf8" }).trim().split("\n");

// All values of a repeated option, in order.
const all = (argv, name) => argv.flatMap((a, i) => (a === `--${name}` && i + 1 < argv.length ? [argv[i + 1]] : []));

// The arms named on the command line, or one arm without flags or label (today's runs).
export function parseArms(argv) {
  const sets = all(argv, "experiments");
  const labels = all(argv, "arm-label");
  if (!sets.length) {
    if (labels.length) throw new Error("--arm-label needs --experiments (use --experiments none for an arm without flags)");
    return [{ flags: [], label: null }];
  }
  if (labels.length && labels.length !== sets.length) throw new Error(`${labels.length} --arm-label for ${sets.length} --experiments; give one per arm or none`);
  const known = knownFlags();
  const arms = sets.map((s, i) => {
    const flags = s === "none" ? [] : s.split(",").map((f) => f.trim()).filter(Boolean);
    for (const f of flags) if (!known.includes(f.split("=")[0])) throw new Error(`unknown experiment ${f}; the server knows ${known.join(", ")}`);
    return { flags, label: labels[i] ?? (flags.join("+") || "none") };
  });
  const names = arms.map((a) => a.label);
  if (new Set(names).size !== names.length) throw new Error(`two arms share a label: ${names.join(", ")}`);
  return arms;
}

// The MCP server env for an arm (empty for an arm without flags).
export const armEnv = (arm) => (arm.flags.length ? { FIREFOX_BRIDGE_EXPERIMENTS: arm.flags.join(",") } : {});

// A row's arm, for grouping in reports: its label, else its flags, else "none" (rows from before
// experiments existed, and runs without --experiments).
export const armOf = (r) => r.arm_label ?? (r.experiments?.length ? r.experiments.join("+") : "none");

// Safe in file names.
export const fileSafe = (s) => String(s).replace(/[^\w.+=-]+/g, "_");
