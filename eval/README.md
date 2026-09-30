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
--devtools --streams dir`. `--devtools` starts the MCP server with FIREFOX_BRIDGE_DEVTOOLS=1.
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

Seen in the traces, and fixed since (branch `fix/remeasure-regressions`). The unit tests cover
the wording and the arithmetic; these need a Firefox restart and a rerun to confirm:

- `computer:scroll_to` on a frame ref (`ref_1@f…`) reported the element's center in the frame's
  own coordinates: "its center is now at (227, 10)" in all 6 MDN runs, where the select was at
  about (590, 403) in the screenshot (one run clicked there and hit it). `read_page` on a frame
  ref also labeled the frame's 698x71 viewport as "Viewport (screenshot frame)". Now the center
  is moved into the top frame's viewport by where each viewport sits on screen, as `find` does,
  after the frame's place stops changing (the page around a cross-process frame scrolls after
  the frame answers), and `read_page` on a frame ref says "Frame viewport (a part of the page,
  not the whole screenshot): WxH at (x, y) in the screenshot". **Check**: in gen-mdn-iframe,
  scroll_to on the select's ref answers about where the screenshot shows it, and a click there
  hits it. The settle loop is untested against real cross-process timing.
- The made-up `left_click` calls: `find`'s header now names the tool, "(screenshot coordinates;
  if off-screen, computer left_click its ref)". **Check**: calls to `mcp__firefox__left_click`
  (or any tool not offered) right after a `find`, per find call; the target is the old
  wording's 0 in 34.
- 5 of 48 after runs and 4 of 48 devtools runs didn't close their tab (1 of 48 before). Their
  answers say "I didn't open any tabs": the tab came from `tabs_context_mcp` with createIfEmpty.
  Now `tabs_context_mcp` and `navigate` without a tabId say "Created tab N for this session;
  close it with tabs_close_mcp when done." when they open the session's first tab. **Check**:
  runs that end with their tab still open, against 9 of 96.
- The fetch hint in `javascript_tool` led a data-hn-readability run to call the Algolia API 7
  times; the task's median input tokens went from 58k to 111k. The description now adds "Fetch the pages you would have
  navigated to, not the site's API." **Check**: API calls from `javascript_tool` in data tasks.

`scripts/test-firefox.mjs` has steps for frames and keys but runs on Linux under Xvfb, so it
wasn't run here.

Per-tool ms: a call issued in the same message as a `navigate` waits for it. The after runs did
that more often (navigate then get_page_text or find in one turn), so their mean ms per call for
those two tools includes the page load. Traces now record `msg_calls` (calls in the same message)
and `text_head` (the first 300 characters of the result), and `run.mjs --streams dir` keeps each
run's raw stream-json.

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
