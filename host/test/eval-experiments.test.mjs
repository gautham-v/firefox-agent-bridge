// The eval runners' experiment arms (eval/lib/experiments.mjs): --experiments/--arm-label parsing,
// the MCP server env per arm, grouping rows by arm, and counting the screenshot tool only when a
// run was offered it.
//   node --test host/test/*.test.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { armEnv, armOf, parseArms } from "../../eval/lib/experiments.mjs";
import { screenshotActions } from "../../eval/lib/trace.mjs";

test("without --experiments there is one arm with no flags and no label", () => {
  assert.deepEqual(parseArms(["--runs", "1"]), [{ flags: [], label: null }]);
  assert.deepEqual(armEnv(parseArms([])[0]), {});
  assert.throws(() => parseArms(["--arm-label", "x"]), /needs --experiments/);
});

test("each --experiments is an arm, labeled by its flags unless --arm-label names it", () => {
  const arms = parseArms(["--experiments", "none", "--experiments", "batchHint, fewerShots", "--experiments", "pageTextCap=4000"]);
  assert.deepEqual(arms, [
    { flags: [], label: "none" },
    { flags: ["batchHint", "fewerShots"], label: "batchHint+fewerShots" },
    { flags: ["pageTextCap=4000"], label: "pageTextCap=4000" },
  ]);
  assert.deepEqual(armEnv(arms[1]), { FIREFOX_BRIDGE_EXPERIMENTS: "batchHint,fewerShots" });
  const named = parseArms(["--experiments", "none", "--arm-label", "off", "--experiments", "quietTabs", "--arm-label", "on"]);
  assert.deepEqual(named.map((a) => a.label), ["off", "on"]);
});

test("unknown flags, a label count that doesn't match and duplicate labels are refused", () => {
  assert.throws(() => parseArms(["--experiments", "batchHnt"]), /unknown experiment batchHnt/);
  assert.throws(() => parseArms(["--experiments", "none", "--experiments", "quietTabs", "--arm-label", "a"]), /1 --arm-label for 2/);
  assert.throws(() => parseArms(["--experiments", "quietTabs", "--experiments", "quietTabs"]), /share a label/);
});

test("armOf groups rows by label, then flags, and old rows as none", () => {
  assert.equal(armOf({ arm_label: "on", experiments: ["quietTabs"] }), "on");
  assert.equal(armOf({ experiments: ["batchHint", "fewerShots"] }), "batchHint+fewerShots");
  assert.equal(armOf({ experiments: [] }), "none");
  assert.equal(armOf({}), "none");
});

test("the screenshot tool counts as a screenshot only when the run was offered it", () => {
  const offered = ["mcp__firefox__computer", "mcp__firefox__screenshot", "mcp__firefox__batch"];
  assert.equal(screenshotActions("mcp__firefox__screenshot", {}), 0);
  assert.equal(screenshotActions("mcp__firefox__screenshot", {}, offered), 1);
  const batch = { actions: [{ tool: "screenshot", args: {} }, { tool: "computer", args: { action: "zoom" } }] };
  assert.equal(screenshotActions("mcp__firefox__batch", batch), 1);
  assert.equal(screenshotActions("mcp__firefox__batch", batch, offered), 2);
  assert.equal(screenshotActions("mcp__firefox__computer", { action: "screenshot" }), 1);
});
