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

## Firefox vs Claude in Chrome

The same tasks, model and prompt run through (a) this repo's Firefox tools (`claude -p` with the
strict MCP config above) and (b) Claude in Chrome (`claude -p --chrome` with an empty strict MCP
config, so the Firefox tools aren't offered, and `--allowedTools "mcp__claude-in-chrome__*"`). The
prompt differs only in naming "the Firefox browser tools" or "the Chrome browser tools". Chrome
runs the baseline arm only. Rows carry `browser` (rows without it are Firefox).

Besides the 8 speed tasks there are 8 general tasks (`kind: "general"`, baseline only), each with
a checker, keys verified by hand on 2026-09-30:

| id | what it exercises |
| --- | --- |
| gen-wiki-chain | multi-hop link following on Wikipedia (Firefox → SpiderMonkey → Brendan Eich → Santa Clara University) |
| gen-pydocs-search | the site's own search (docs.python.org), then reading the top result |
| gen-elements-table | filtering and comparing rows in a large Wikipedia table |
| gen-quotes-scroll | an infinite-scroll list (quotes.toscrape.com/scroll) |
| gen-httpbin-form | filling and submitting a public test form (httpbin.org/forms/post), reading the echo |
| gen-mdn-iframe | a select inside a cross-origin iframe (MDN live sample on mdnplay.dev, inside shadow DOM) |
| gen-apg-datepicker | a calendar date picker dialog (W3C APG example) |
| gen-datatables-scroll | scroll-to-find in a virtualized table (DataTables Scroller, 2,500 rows, ~45 in the DOM) |

Every run also writes a per-tool-call trace to `results/traces/<run_id>.jsonl`: tool, argument
summary (batch actions listed), result bytes (text + decoded images), estimated tokens (text
bytes / 4, images w·h / 750), image count and sizes, error flag and duration (tool_use event to
tool_result event on the stream). Rows carry per-tool totals in `tool_stats_by_tool`, plus
`screenshot_actions` (including those inside a Chrome `browser_batch`) and `images_returned`
(Chrome's `scroll` also returns a screenshot).

Run both browsers into their own file, interleaved (task, then browser), so they share conditions:

```sh
node eval/run.mjs --browser firefox,chrome --arms baseline --out eval/results/browsers.jsonl --concurrency 2 --max-minutes 8
# repeat until it says "matrix complete"; add --tasks gen-wiki-chain,... to limit tasks
node eval/report.mjs   # adds the browser comparison from results/browsers.jsonl
```

Needs Chrome running with the Claude extension connected and signed in to the same account (check
with `claude -p --chrome` or the list_connected_browsers tool). If the extension isn't connected,
the run is not recorded and the chunk skips Chrome cells. Chrome needs its window on screen for
screenshots (a hidden window can return a blank first capture); Firefox tabs run in the background.

Known confound: Claude in Chrome's `find` calls a model server-side; those tokens aren't in the
counts. Claude in Chrome also has tools the Firefox server lacks (browser_batch, gif_creator,
console/network readers, shortcuts, resize_window, upload_image, browser selection).

## Running

```sh
node eval/run.mjs          # runs pending (task, arm, run#) cells for up to 8 min; run again to continue
node eval/run.mjs --dry-run
node eval/probe-strip.mjs  # each probe is resumable and stops before --max-minutes (default 8)
node eval/probe-a11y.mjs
node eval/report.mjs       # writes eval/results/report.md
```

`run.mjs` options: `--max-minutes 8 --concurrency 3 --runs 3 --model claude-sonnet-5-5
--tasks id,id --arms a,b --browser firefox|chrome|firefox,chrome --out file --run-timeout-min 7`. Each run is `claude -p` with
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

# Model x effort benchmark

Which model and effort level is worth using for browser tasks, and where effort stops paying.
`models.mjs` runs 6 complex tasks (`models-tasks.mjs`, each 10+ steps) on 10 configs: Haiku 4.5
at its default, and Sonnet 5.5, Opus 5.5 and Fable 5.1 at `--effort low|medium|high`. Haiku
takes `--effort` without error but ignores it (the CLI's init event says
`per_turn_effort_active: false`, and its output tokens don't follow the level), so it runs once,
labeled `default`.

| task | what it exercises | checked from |
|---|---|---|
| `research-synth` | 4 facts on 3 practice sites, combined into one computed number | answer |
| `form-demoqa` | long practice form: validation on empty submit, date picker, autocomplete, checkboxes, dependent dropdowns, fixing a rejected phone number | confirmation dialog in the tab |
| `todomvc-flow` | TodoMVC (React): add, rename, complete, delete, filter | app DOM in the tab |
| `books-paginated` | two paginated categories; star ratings only as icons/classes; counts, sums, extremes | answer |
| `tldraw-diagram` | canvas: 3 colored rectangles, an ellipse, 3 bound arrows | tldraw editor shapes and bindings |
| `internet-gauntlet` | dynamic controls, delayed render, infinite scroll, number drawn on a canvas, form in an iframe, shadow-root slot | 5 tabs' DOM + answer |

Every task scores partial credit (share of sub-goals met) and pass (all of them). State tasks
tell the agent to leave its tab open; each run has its own tab-group session
(`FIREFOX_AGENT_BRIDGE_SESSION` in its MCP config), so afterwards the worker joins that session,
runs the task's `inspect` snippets on the matching tabs, and closes them.

```sh
node eval/models.mjs --dry-run
node eval/models.mjs                 # one chunk (8.5 min); run again until it says complete
node eval/models-report.mjs          # writes results/models/report.md and summary.json
```

Options: `--configs haiku:default,sonnet:low,...` (or `--models sonnet,opus --efforts low,high`),
`--tasks`, `--rounds 3`, `--seed 7`, `--concurrency 3`, `--max-minutes 8.5`,
`--run-timeout-min 12`, `--out`, `--tag`, `--wait`.

The schedule is round-robin: each round runs every (task, config) once in a seeded shuffle, and
a round starts only after the previous one has started all its cells, so stopping early leaves
balanced data. Each run is a detached worker (`models.mjs --one`), so runs can outlive the
chunk that started them (up to the 12-minute cap, which records `timeout: true` and score 0);
the next chunk counts them toward the concurrency. A run with no result from the CLI (auth,
rate limit, crash) is recorded with `infra_error: true` and runs again (up to 3 tries).

Per run (`results/models/runs.jsonl`): model, effort, round, wall time, time to first tool call,
tool calls by tool, screenshots, turns, input/output/cache tokens (output includes thinking),
thinking blocks, `cost_usd` from the result event, tool errors, repeated identical consecutive
calls, retries after an error, score, pass, sub-goal fields, the inspected page state, and
load: how many other runs of this benchmark, other eval processes and other harnesses' `claude
-p` agents were running (sampled every 15 s). Raw stream-json goes to `results/models/streams/`.

## Hard tier (round 2)

Round 1 was at ceiling: Sonnet, Opus and Fable passed all 162 runs at every effort. `--tier hard`
runs six harder tasks (`models-tasks-hard.mjs`) on the 9 Sonnet/Opus/Fable configs (no Haiku)
into `results/models-hard/`. Four tasks forbid `javascript_tool` (a run that calls it, even
inside `batch`, scores 0; the harness passes each run's tool calls to `check()`), because drafts
without that rule were solved through the page's own JavaScript and stayed at ceiling.

| task | what it exercises | checked from | key from |
|---|---|---|---|
| `wc-tiebreak` | 2026 World Cup tie-breakers read from Wikipedia, applied through 4 levels (head-to-head goals, re-apply, fair play with one deduction per player per match, FIFA ranking); placing a team in the real third-place table via a footnote | answer | the article's criteria and table, applied by hand |
| `uitp-no-js` | no JS: UI Testing Playground widgets (15 s load, text box that needs real input, link replaced on hover with an exact click count, self-clearing covered field, scroll and hover targets, 9 fields to clear, multi-selects, a table that changes on reload) | 8 tabs' DOM + answer | live page state |
| `books-no-js` | no JS: star ratings only as icons, 167 books over 10 pages (page 1 alone ranks the categories differently), then 8 full titles and prices into TodoMVC | TodoMVC DOM + answer | every book fetched by script |
| `sudoku-no-js` | no JS: solve websudoku's Evil puzzle 1,234,567,890 by reasoning and enter 55 digits | the grid's inputs, row by row | the page's embedded solution, checked unique by a solver |
| `hockey-no-js` | no JS: exact counts over 582 rows (per-year maxima across all pages, with ties), a franchise whose 2011 name a different club used in the 1990s, a 63-number signed sum | answer | all rows fetched by script |
| `tldraw-no-js` | no JS: 6 labeled rectangles on an aligned 2x3 grid with equal gaps and row colors, 6 bound arrows with 2 labels, all in a frame named Loop | tldraw editor shapes, parents, bindings | – |

```sh
node eval/models.mjs --tier hard            # one chunk; run again until it says complete
node eval/models-rescore.mjs --in eval/results/models-hard/runs.jsonl   # after a checker fix
node eval/models-report.mjs --in eval/results/models-hard/runs.jsonl
node eval/models-charts.mjs --in eval/results/models-hard/runs.jsonl    # charts.json, round 1's schema
```

Result (162 runs, $108.52 list plus $19.75 of smoke runs; analysis in
`results/models-hard/analysis.md`):
mean score (passes of 18) Sonnet 0.935 (14) / 0.930 (12) / 0.994 (17) at low / medium / high,
Opus 0.981 (16) / 0.989 (17) / 0.991 (17), Fable 0.991 (17) / 1.000 (18) / 1.000 (18). Effort
bought score only for Sonnet, and only from medium to high (+0.064, up on 4 of 6 tasks, none
down, x1.06 cost). Misses were slips (one misread star in 167, one miscounted row, a head-to-head
goals total, a text box whose `change` event never fired after typing), not missing capability:
every config solved the sudoku and drew the tldraw grid.
