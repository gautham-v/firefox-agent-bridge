# Eval harness

Measures whether four speed ideas make the agent faster without making it worse, before any of
them is built. Each idea is an arm built only from today's tools plus an appended system prompt
(`arms.mjs`), so the extension and MCP server are the same in every arm:

- **baseline**: today's tools, no extra guidance.
- **strip**: read articles through a reader-view extraction. `about:reader` can't be opened
  with today's tools (`tabs.update` rejects it as an illegal URL, and pages can't navigate to
  it), so the agent runs Mozilla's Readability.js, the library behind Reader View, in the page
  with `javascript_tool`, falling back to a DOM heuristic when the page's CSP blocks the import.
- **data**: on list pages, list `performance` fetch/XHR entries, re-fetch the JSON in the page
  and read trimmed fields before the DOM.
- **fanout**: one sub-agent (Task tool) per page on compare tasks.
- **a11y** can't be faked end to end, so `probe-a11y.mjs` measures what `read_page` misses
  instead. `probe-strip.mjs` measures reader-view token savings and content survival offline.

Tasks (`tasks.mjs`) are read-only and on public pages: 3 articles (strip), 3 list/search pages
(data), 2 five-page comparisons (fanout). Each ends with a fixed JSON answer that a checker
scores. Answer keys were checked by hand in Firefox on 2026-09-29; tasks on pages that change
daily also rebuild their key from the site's public API at check time (`liveKey`).

## Running

```sh
node eval/run.mjs          # runs pending (task, arm, run#) cells for up to 8 min; run again to continue
node eval/run.mjs --dry-run
node eval/probe-strip.mjs  # each probe is resumable and stops before --max-minutes (default 8)
node eval/probe-a11y.mjs
node eval/report.mjs       # writes eval/results/report.md
```

`run.mjs` options: `--max-minutes 8 --concurrency 3 --runs 3 --model claude-sonnet-5-5
--tasks id,id --arms a,b --out file --run-timeout-min 7`. Each run is `claude -p` with
`--strict-mcp-config` and an MCP config pointing at this checkout's `mcp/server.mjs`, only the
Firefox tools (plus Task for fanout), no session persistence, in its own tab group. A run cut
off by the chunk's deadline isn't recorded and runs again next time; one that hits the per-run
cap is recorded as a timeout.

Output: `results/runs.jsonl` (one line per run: wall time, tool calls by tool, screenshots,
tokens per model, turns, cost, answer, checker fields, errors), `results/probe-strip.json`,
`results/probe-a11y.json` and `results/report.md`.

Runs drive your real Firefox in background tab groups. The prompts tell the agent to close its
tabs; a run that fails can leave a group behind (shown as Disconnected).

## To re-measure after restart

Extension changes that only take effect once Firefox restarts and loads them. Re-run these tasks
against Chrome's numbers (`eval/vs-chrome`) and note what moved.

- **Frames in find/read_page, keys follow the last click** (gen-mdn-iframe): `find` and
  `read_page` now reach the select inside MDN's live-sample iframe (in a shadow root, cross-origin)
  with a `ref_N@fM` that `form_input` sets in place; `key`/`type` go to the frame the last click
  landed in and say which element got them and its value. Was 71 calls / 1315k tokens / 114s
  median; expect about 5 to 15 calls and no answer worked out from the source. Also run
  `scripts/test-firefox.mjs`, which has steps for both.
- **Input the pres shell can't take** (gen-mdn-iframe): a scroll or click whose pres-shell
  dispatch threw `NS_ERROR_UNEXPECTED [nsIDOMWindowUtils.dispatchDOMEventViaPresShellForTesting]`
  now dispatches the event on the element instead (and sends the click itself), and a scroll still
  scrolls or passes up to the parent frame. Was 5 of 7 scrolls and 2 clicks failing over the
  live-sample frame; expect none, and no `window.scrollBy` fallbacks.
- **Click floor** (gen-apg-datepicker, gen-wiki-chain, gen-mdn-iframe): a click no longer sleeps
  500ms for a tab it might open (it waits 100ms, 500ms only on a link or form that targets a new
  tab, and goes on once the tab arrives), and the cursor jumps instead of easing for 150 to 350ms
  in a tab the user isn't looking at. `computer:left_click` median was 696ms (Chrome 161ms);
  expect under about 200ms in background tabs.
