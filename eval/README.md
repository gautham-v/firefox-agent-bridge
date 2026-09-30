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
