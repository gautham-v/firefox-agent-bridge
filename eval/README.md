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
--tasks id,id --arms a,b --browser firefox|chrome|firefox,chrome --out file --run-timeout-min 7
--devtools --streams dir --experiments flags --arm-label name`. `--devtools` starts the MCP server with
FIREFOX_BRIDGE_DEVTOOLS=1; `--experiments` is under "Experiments" below.
Each run is `claude -p` with `--strict-mcp-config` and an MCP config pointing at this checkout's
`mcp/server.mjs`, only the Firefox tools (plus Task for fanout), no session persistence, in its
own tab group. A run cut off by the chunk's deadline isn't recorded and runs again next time; one
that hits the per-run cap is recorded as a timeout.

Output: `results/runs.jsonl` (one line per run: wall time, tool calls by tool, screenshots,
tokens per model, turns, cost, answer, checker fields, errors), `results/probe-strip.json`,
`results/probe-a11y.json` and `results/report.md`.

Runs drive your real Firefox in background tab groups. The prompts tell the agent to close its
tabs; a run that fails can leave a group behind (shown as Disconnected).

## Re-measured after restart (2026-09-29)

Some extension changes only take effect once Firefox restarts and loads them. After a restart
with `-purgecaches`, the Firefox side of the browser comparison ran again (16 tasks x 3, baseline
arm) into `results/browsers-after.jsonl`, and once more with the devtools tool on into
`results/browsers-devtools.jsonl`. Chrome's rows in `results/browsers.jsonl` weren't re-run (its
extension didn't change). `report.mjs` compares them in "Re-measure after restart" and "devtools
on vs off".

```sh
node eval/run.mjs --browser firefox --arms baseline --concurrency 2 --out eval/results/browsers-after.jsonl
node eval/run.mjs --browser firefox --arms baseline --concurrency 2 --devtools --out eval/results/browsers-devtools.jsonl
node eval/report.mjs
```

The after runs also include everything else that landed on the MCP server since the first run
(batch, multi-field form_input, the tabId fill-in, the fetch hint in javascript_tool), so the
overall change isn't all from the restart. What each item measured:

- **Frames in find/read_page, keys follow the last click** (gen-mdn-iframe): was 71 calls /
  1315k tokens / 114s median; now 9 calls / 72k / 18s (all 3 pass). Every run found the select
  with `find` (`combobox "Choose an ice cream flavor:" [ref_1@f…] (in frame …mdnplay.dev)`), set
  it with `form_input` on that ref, and read "You like sardine" from a screenshot or zoom. No run
  used `javascript_tool` or navigated to the frame's page. Keys weren't exercised: no run typed
  into the frame.
- **Input the pres shell can't take**: `NS_ERROR_UNEXPECTED` results went from at least 6 (in the
  rows' error samples, all on gen-mdn-iframe) to 0. The fallback wasn't really tested, though: no
  run did a `computer` scroll, and both clicks into the live-sample frame (one in each set)
  worked. `computer` had 0 errors in 72 actions (148 with devtools on as well).
- **Click floor**: `computer:left_click` median went from 697ms to 123ms (38 clicks; Chrome
  161ms).
- **Trimmed find**: result size median 802 bytes [209–4226] before, 438 [195–778] after (Chrome
  438 [192–627]).
- **Tools not offered**: before, screenshot 4 and scroll_to 1. After, left_click 5 (3 in
  gen-pydocs-search, 2 in gen-wiki-chain) and screenshot 2; with devtools on, left_click 3 (all
  gen-pydocs-search). Every `left_click` call came right after a `find`, whose result now starts
  "(screenshot coordinates; click by ref if off-screen)". The old wording ("clicking by ref is
  more reliable") drew none in 34 find calls.
- **devtools on vs off**: the model never called devtools. Medians on/off: wall 0.97, calls 1.00,
  input tokens 1.02 (about the tool's definition), cost 0.94. Tool mix was the same.

`scripts/test-firefox.mjs` has steps for frames and keys but runs on Linux under Xvfb, so it
wasn't run here.

Per-tool ms: a call issued in the same message as a `navigate` waits for it. The after runs did
that more often (navigate then get_page_text or find in one turn), so their mean ms per call for
those two tools includes the page load. Traces now record `msg_calls` (calls in the same message)
and `text_head` (the first 300 characters of the result), and `run.mjs --streams dir` keeps each
run's raw stream-json.

## Re-measured again (2026-09-30)

The fixes the first re-measure's traces led to (branches `fix/remeasure-regressions` and
`fix/typing-change-event`) loaded once Firefox restarted with main at c1ad4bb. The browser
comparison's Firefox side ran again (16 tasks x 3, baseline arm) into
`results/browsers-after-2.jsonl`, and Sonnet 5.5's hard tier at low, medium and high (54 runs)
into `results/models-hard/sonnet-rerun.jsonl`. `report.mjs` compares the first in "Re-measure 2";
the second is in `results/models-hard/analysis.md` under "Sonnet rerun after the restart".

```sh
node eval/run.mjs --browser firefox --arms baseline --concurrency 2 --out eval/results/browsers-after-2.jsonl --streams <dir>
node eval/models.mjs --tier hard --configs sonnet:low,sonnet:medium,sonnet:high --out eval/results/models-hard/sonnet-rerun.jsonl
node eval/models-report.mjs --in eval/results/models-hard/sonnet-rerun.jsonl --prefix sonnet-rerun-
node eval/report.mjs
```

Browser comparison, first re-measure then this one: 48/48 passed both times; medians 16.6s to
14.9s, 6 calls both, 55k to 56k input tokens, $0.060 to $0.058 ($2.88 to $2.63 for all 48).
Chrome's first-run medians were 25.5s, 7 calls, 119k and $0.080. What each fix measured:

- **Tabs left open: 9 of 96 to 0 of 48.** Every run's first `tabs_context_mcp` answered
  "Created tab N for this session; close it with tabs_close_mcp when done." One side effect, in
  the hard tier: a wc-tiebreak run gave its JSON, then closed its tab and ended on "I closed the
  tab I opened. The answer is above." `models.mjs` now takes the last JSON from an earlier
  message when the final one has none (`answer_source: "earlier_text"`).
- **API calls from `javascript_tool` in data tasks: 7 to 0.** data-hn-readability's median input
  tokens went from 111k back to 56k (58k before the fetch hint), with no `javascript_tool` call at
  all.
- **Made-up `left_click` after `find`: 8 in 96 runs to 2 in 48** (per find call, 8 in 39 to 2 in
  21). Both are gen-pydocs-search's `find "search box"` then `mcp__firefox__left_click`, as before.
  Fewer, not gone.
- **uitp-no-js with Sonnet: 6 of 9 to 9 of 9.** Two runs typed into the text box with `computer`
  and the button took the name without `form_input`; the other 7 used `form_input` first.
  todomvc-flow's rename (round 1's task) wasn't rerun.
- **Calls to tools not offered, Sonnet hard tier: 41 to 28 over 54 runs, but `screenshot` went
  18 to 21.** The `computer` description didn't reach them: every one has empty input and is
  followed by the same action through `computer`.

Still open:

- The made-up `left_click` after `find "search box"` on docs.python.org (2 in 48).

Checked by hand after the next restart (2026-09-30, live on the MDN select page, 1422x809
screenshot):

- **Frame offsets:** `find` put the "Choose a pet" select at (905, 478), where a zoom of that
  region shows it. `scroll_to` on the multi-select's frame ref answered (607, 404), and the
  screenshot shows it at about (610, 410). Before: "(off-screen)" and (120, -8).
- **`find` duplicates and role queries** (uitestingplayground.com/textinput): `find "text input"`
  lists the heading once, and `find "button"` returns the button first.

## Experiments (MCP server flags)

Some changes to what the model sees can be switched per run in `mcp/server.mjs`, so they can be
A/B tested without restarting Firefox. The server reads a comma-separated list from
`FIREFOX_BRIDGE_EXPERIMENTS`. Unset, tools/list and every result are as before
(`host/test/fixtures/tools-list.json`). `node mcp/server.mjs --list-experiments` prints the flags.

| flag | what changes |
| --- | --- |
| `batchHint` | `find` and `read_page` results with refs end with "(The next clicks, typing and form_input on these refs can go in one batch call.)", except inside a batch. The `batch` description says to use it whenever the next two or more steps are known; `computer` says several clicks or keys on known refs go in one batch. |
| `fewerShots` | `computer`'s description says action results already report what changed (element, text typed, focus and its value), so a checking screenshot after each action is usually unnecessary; take one when the page's appearance matters. |
| `screenshotAlias` | Adds a `screenshot` tool ({tabId?, scale?}) that runs `computer`'s screenshot action, also inside `batch`; `computer` no longer says there is no screenshot tool. Sonnet calls this name with empty input about 0.4 times a run. |
| `quietTabs` | `navigate` leaves out "This session's tabs: {…}" while the session's tab ids are the ones the last result that showed a list had (`tabs_context_mcp`, `tabs_create_mcp`, or an earlier `navigate`). The created-tab note stays. |
| `pageTextCap` | `get_page_text` returns at most 8000 characters (`pageTextCap=4000` sets another default), then a line with how many are left and the `offset` to read on from. Adds optional `offset` and `max_chars`. The server slices the full text. |
| `fastNavigate` | `navigate` sends `wait: "interactive"` to the extension unless the call set `wait`. Until Firefox loads an extension that knows `wait`, it is ignored and this arm is the same as none. |

Both runners take `--experiments <flags>` for the MCP server they start. Given more than once,
each is an arm: `run.mjs` runs every Firefox cell once per arm, and `models.mjs` shuffles every
(task, config, arm) together within each round, so arms share conditions. `--experiments none`
is an arm without flags. `--arm-label <name>`, once per `--experiments` in the same order, names
the arms (default: the flags joined with `+`). Rows record `experiments` and `arm_label`, and
arms with different labels share one `--out` file. Without `--experiments`, cells and rows are
as before.

```sh
node eval/run.mjs --browser firefox --arms baseline --concurrency 2 --out eval/results/experiments.jsonl \
  --experiments none --experiments batchHint,fewerShots,screenshotAlias --arm-label none --arm-label hints
node eval/report.mjs --experiments eval/results/experiments.jsonl   # "Experiment arms (Firefox)"

node eval/models.mjs --tier hard --configs sonnet:medium --out eval/results/models-hard/experiments.jsonl \
  --experiments none --experiments batchHint --experiments fewerShots,screenshotAlias
node eval/models-report.mjs --in eval/results/models-hard/experiments.jsonl --prefix experiments-
```

Run each again until it says complete. `report.mjs` groups rows by arm ("none" first) and adds
batch share, actions per run, screenshot actions, calls to the screenshot tool and result sizes
for `navigate` and `get_page_text`. `models-report.mjs` splits every config by arm when the file
has more than one (`--by-arm` forces it) and adds an "Experiment arms" table against "none".
Models rows now also carry `screenshot_actions` (screenshots and zooms inside batches too); the
older `screenshots` counts top-level calls only.

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
`--run-timeout-min 12`, `--out`, `--tag`, `--wait`, `--experiments`, `--arm-label` ("Experiments" above).

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

Sonnet rerun after the typing fix (54 runs, $16.75; "Re-measured again" above): 0.891 (12) /
0.991 (17) / 0.970 (15) at low / medium / high, and uitp-no-js 9 of 9. Over both rounds, 26 / 29 /
32 passes of 36: high still best, low now weakest, and none of the steps is significant.
