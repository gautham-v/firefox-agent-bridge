# Experiment arms on the 16 browser-comparison tasks (2026-09-30)

Six MCP server flags against no flags, Firefox, the 16 tasks from the Chrome comparison, baseline
prompt, `claude-sonnet-5-5`, 2 runs per task per arm (224 runs, $12.58 list, no infra retries).
Arms ran round-robin within each task and run at concurrency 2, so load and time of day hit all
of them alike. Rows are in `browsers-arms.jsonl`; `arms-analysis.mjs` wrote the second half of
this file, and the first half is `report.mjs --experiments`.

## Verdicts

Every run of every arm ends in about 14 to 16 seconds at the median and costs about $0.055, and
32 runs per arm can't see a 5% change. Read the verdicts as "what the traces show", not as
proof of a speedup.

| flag | verdict | evidence |
| --- | --- | --- |
| `batchHint` | keep | Tool calls per run 7.4 to 6.6 (ratio of means 0.89): fewer on 5 tasks, more on none; none's own run 1 against run 2 moved 2 up, 2 down. Batch calls 3 to 7, in cmp-pypi, cmp-npm and gen-apg-datepicker only (the multi-step tasks). Wall 0.97, cost 0.98, input tokens 0.96. The one failed run is a wrong answer shape on gen-httpbin-form (no `form` wrapper, no `content_length`), with a trace identical to the passing runs' calls. |
| `fewerShots` | drop | Screenshot and zoom actions 12 to 11 in 32 runs; the same tasks take them in both arms (datepicker 6 vs 5, mdn 3 vs 3, httpbin 2 vs 2). Sonnet already takes a screenshot only where the page's look matters, so there was little to remove. Calls 0.97, wall 1.02, cost 0.98: nothing measurable. Harmless, not useful here. |
| `screenshotAlias` | keep | Calls to a `screenshot` tool that isn't offered: 1 to 2 per 32 runs in the other six arms, each an error and a wasted turn; 0 errors in this arm, which used the alias 11 times in 7 runs. Wall 1.03, calls 0.97, cost 0.98, all inside noise. Keep for the errors it removes, not for speed. |
| `quietTabs` | unclear | Nothing to measure: no navigate result in any arm (39 in none, 36 here) ended with a tab list, because no task opens a tab, and the list only comes when one is opened. All ratios are noise. Needs a task where a click opens a tab. |
| `pageTextCap` | drop (at 8000) | The slowest arm: wall 1.10 (10 tasks slower, 1 faster, sign test p 0.01), output tokens 1.10, calls 1.08. It capped 7 of 33 `get_page_text` calls and 10 calls used `offset`; on the three long articles (art-ars-firefox, art-guardian-tang, data-ashby-ramp) calls went 2 to 4 because the model read on to the end. Pass rate unchanged. The cap only pays where the model doesn't need the rest of the page; these tasks do. |
| `fastNavigate` | keep, with one caveat | `navigate` 1901ms to 580ms median; a `get_page_text` in the same message 1571ms to 277ms. Text returned was the same length as none on every static page. Wall is 0.97 by mean and 0.96 by geomean (6 tasks faster, 3 slower, p 0.51), input tokens 0.95: the ~1.3s saved per navigate is small against 15 to 30s of model time. Caveat: on hn.algolia.com (a client-rendered page) one run got the "returned once the page was parsed; it is still loading" note, found an empty page, and fell back to 8 `javascript_tool` calls (25s, 88k tokens against 15s, 61k). The other run of that task was fine. One case in 37 navigates. |

## Aggregate against baseline

Ratios are arm / none over all 32 runs (means). Task-level counts are in the tables below.

| arm | pass | wall | tool calls | screenshots | input tokens | output tokens | cost | not-offered calls |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| none | 32/32 | 16.7s | 7.4 | 0.38 | 68.1k | 1.1k | $0.057 | 4 |
| batchHint | 31/32 | 0.97 | 0.89 | 0.92 | 0.96 | 0.89 | 0.98 | 5 |
| fewerShots | 32/32 | 1.02 | 0.97 | 0.92 | 0.96 | 0.99 | 0.98 | 4 |
| screenshotAlias | 32/32 | 1.03 | 0.97 | 1.08 | 0.95 | 0.98 | 0.98 | 1 |
| pageTextCap | 32/32 | 1.10 | 1.08 | 1.33 | 1.05 | 1.10 | 1.02 | 2 |
| quietTabs | 31/32 | 0.98 | 0.95 | 0.92 | 0.96 | 0.96 | 0.99 | 3 |
| fastNavigate | 32/32 | 0.97 | 0.96 | 1.00 | 0.95 | 1.00 | 0.98 | 3 |

The two failures (batchHint and quietTabs, gen-httpbin-form run 2) both answered with the echoed
fields flat instead of in the `{form, content_length}` shape the task asks for. Their calls match
the passing runs' (navigate, read_page, form_input, screenshot, click, get_page_text, close), so
this is an answer-format slip; 2 in 224 with no link to either flag.

Noise floor: none's run 1 against run 2 per task moved wall 3 up / 5 down, calls 2 / 2, input
tokens 4 / 2, cost 4 / 2 (tasks changing by more than 10%). Any arm inside that is not distinguishable.

---

## report.mjs tables

Source: `results/browsers-arms.jsonl`, grouped by arm (`run.mjs --experiments`; the flags each arm's MCP server ran with are in eval/README.md). Arms: none (no flags, 32 runs), batchHint (batchHint, 32 runs), fewerShots (fewerShots, 32 runs), screenshotAlias (screenshotAlias, 32 runs), pageTextCap (pageTextCap, 32 runs), quietTabs (quietTabs, 32 runs), fastNavigate (fastNavigate, 32 runs).

| metric | none | batchHint | fewerShots | screenshotAlias | pageTextCap | quietTabs | fastNavigate |  |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| runs | 32 | 32 | 32 | 32 | 32 | 32 | 32 | |
| success | 100% (32/32) | 97% (31/32) | 100% (32/32) | 100% (32/32) | 100% (32/32) | 97% (31/32) | 100% (32/32) | |
| wall time (s) | 14.5 [7.3–44.4] | 13.4 [8.0–34.2] | 14.4 [7.6–44.5] | 15.5 [7.4–43.6] | 16.2 [8.7–56.9] | 14.1 [8.2–34.2] | 15.5 [7.4–35.8] |  |
| tool calls | 6 [4–16] | 6 [3–15] | 6 [4–17] | 6 [4–16] | 7 [4–19] | 6 [4–17] | 6 [4–16] |  |
| screenshot/zoom actions | 0 [0–3] | 0 [0–3] | 0 [0–3] | 0 [0–3] | 0 [0–3] | 0 [0–3] | 0 [0–3] |  |
| turns | 7 [5–17] | 7 [4–16] | 7 [5–18] | 7 [5–17] | 8 [5–20] | 7 [5–18] | 7 [5–17] |  |
| input tokens (incl. cache) | 58k [37k–151k] | 55k [44k–142k] | 56k [42k–114k] | 59k [38k–102k] | 68k [38k–140k] | 55k [37k–151k] | 59k [38k–121k] |  |
| uncached input tokens | 7.9k [3.7k–15k] | 8.2k [3.8k–15k] | 7.1k [3.8k–14k] | 7.6k [3.9k–14k] | 7.3k [3.8k–25k] | 7.5k [3.8k–15k] | 7.1k [3.8k–16k] |  |
| output tokens | 967 [499–2.7k] | 944 [512–1.9k] | 1.0k [493–2.3k] | 1.1k [502–2.1k] | 1.2k [581–3.1k] | 977 [488–2.2k] | 1.1k [511–2.4k] |  |
| tool result KB (text + images) | 13.6 [0.4–212.7] | 14.3 [0.4–213.2] | 13.4 [0.5–212.6] | 13.8 [0.5–295.5] | 11.6 [0.4–244.3] | 13.8 [0.3–214.4] | 13.8 [0.4–212.7] |  |
| cost (USD) | 0.058 [0.029–0.101] | 0.057 [0.030–0.101] | 0.058 [0.030–0.075] | 0.056 [0.030–0.074] | 0.055 [0.030–0.136] | 0.053 [0.030–0.102] | 0.052 [0.030–0.108] |  |
| total wall time, all runs (min) | 8.9 | 8.6 | 9.1 | 9.2 | 9.8 | 8.7 | 8.7 | |
| total tool calls, all runs | 238 | 211 | 230 | 232 | 256 | 225 | 229 | |
| total cost, all runs (USD) | 1.82 | 1.78 | 1.78 | 1.78 | 1.85 | 1.80 | 1.77 | |

Median [min–max] per run.

Per task: median wall s / tool calls / input tokens, and success.

| task | none | batchHint | fewerShots | screenshotAlias | pageTextCap | quietTabs | fastNavigate |
| --- | --- | --- | --- | --- | --- | --- | --- |
| art-ars-dragon | 9.7s / 4 / 45k (2/2) | 8.1s / 4 / 45k (2/2) | 9.0s / 4 / 45k (2/2) | 9.0s / 4 / 45k (2/2) | 11.4s / 4 / 41k (2/2) | 11.3s / 4 / 45k (2/2) | 8.1s / 4 / 45k (2/2) |
| art-ars-firefox | 8.9s / 4 / 51k (2/2) | 9.2s / 4 / 51k (2/2) | 9.3s / 4 / 51k (2/2) | 8.1s / 4 / 52k (2/2) | 9.9s / 5 / 59k (2/2) | 9.2s / 4 / 51k (2/2) | 8.3s / 4 / 51k (2/2) |
| art-guardian-tang | 9.8s / 4 / 55k (2/2) | 10.6s / 4 / 55k (2/2) | 10.5s / 4 / 56k (2/2) | 8.0s / 4 / 56k (2/2) | 9.4s / 5 / 68k (2/2) | 8.6s / 4 / 55k (2/2) | 8.4s / 4 / 55k (2/2) |
| data-hn-readability | 14.6s / 6 / 61k (2/2) | 15.0s / 6 / 56k (2/2) | 15.2s / 7 / 61k (2/2) | 15.1s / 6 / 57k (2/2) | 17.2s / 6 / 61k (2/2) | 14.1s / 6 / 56k (2/2) | 25.4s / 8 / 88k (2/2) |
| data-crates-html | 12.6s / 6 / 49k (2/2) | 11.3s / 6 / 50k (2/2) | 13.0s / 6 / 50k (2/2) | 16.0s / 6 / 50k (2/2) | 11.8s / 6 / 50k (2/2) | 12.8s / 6 / 49k (2/2) | 9.1s / 6 / 54k (2/2) |
| data-ashby-ramp | 10.1s / 4 / 55k (2/2) | 10.0s / 4 / 55k (2/2) | 10.6s / 4 / 56k (2/2) | 10.8s / 4 / 56k (2/2) | 12.8s / 5 / 58k (2/2) | 16.4s / 4 / 55k (2/2) | 8.6s / 4 / 55k (2/2) |
| cmp-pypi | 22.5s / 8 / 71k (2/2) | 23.5s / 5 / 51k (2/2) | 31.4s / 6 / 71k (2/2) | 29.7s / 7 / 68k (2/2) | 38.2s / 9 / 91k (2/2) | 26.1s / 8 / 76k (2/2) | 23.1s / 6 / 62k (2/2) |
| cmp-npm | 33.7s / 9 / 77k (2/2) | 26.0s / 4 / 67k (2/2) | 33.4s / 5 / 63k (2/2) | 35.2s / 7 / 66k (2/2) | 25.1s / 9 / 72k (2/2) | 28.6s / 5 / 63k (2/2) | 18.9s / 6 / 69k (2/2) |
| gen-wiki-chain | 20.8s / 13 / 132k (2/2) | 24.3s / 13 / 141k (2/2) | 21.3s / 13 / 108k (2/2) | 16.4s / 12 / 96k (2/2) | 24.8s / 14 / 110k (2/2) | 16.9s / 11 / 114k (2/2) | 19.7s / 12 / 87k (2/2) |
| gen-pydocs-search | 14.7s / 14 / 96k (2/2) | 13.8s / 10 / 83k (2/2) | 15.1s / 14 / 104k (2/2) | 15.7s / 13 / 94k (2/2) | 14.5s / 12 / 93k (2/2) | 18.8s / 14 / 108k (2/2) | 17.8s / 13 / 96k (2/2) |
| gen-elements-table | 11.3s / 5 / 43k (2/2) | 10.3s / 4 / 47k (2/2) | 10.6s / 4 / 45k (2/2) | 12.6s / 6 / 53k (2/2) | 13.8s / 6 / 58k (2/2) | 11.0s / 5 / 43k (2/2) | 11.2s / 5 / 43k (2/2) |
| gen-quotes-scroll | 29.1s / 4 / 44k (2/2) | 26.6s / 4 / 44k (2/2) | 27.2s / 4 / 44k (2/2) | 24.0s / 4 / 44k (2/2) | 26.3s / 4 / 44k (2/2) | 23.4s / 4 / 44k (2/2) | 30.7s / 4 / 44k (2/2) |
| gen-httpbin-form | 12.1s / 9 / 70k (2/2) | 15.0s / 9 / 65k (1/2) | 11.8s / 9 / 65k (2/2) | 19.7s / 9 / 71k (2/2) | 14.4s / 9 / 71k (2/2) | 13.0s / 8 / 59k (1/2) | 11.6s / 9 / 64k (2/2) |
| gen-mdn-iframe | 15.1s / 9 / 77k (2/2) | 16.1s / 10 / 77k (2/2) | 16.7s / 9 / 66k (2/2) | 15.2s / 10 / 76k (2/2) | 20.7s / 11 / 74k (2/2) | 15.1s / 8 / 71k (2/2) | 14.8s / 9 / 66k (2/2) |
| gen-apg-datepicker | 25.8s / 16 / 102k (2/2) | 23.2s / 14 / 98k (2/2) | 23.5s / 16 / 94k (2/2) | 19.2s / 16 / 86k (2/2) | 26.4s / 17 / 123k (2/2) | 21.9s / 17 / 105k (2/2) | 22.8s / 16 / 89k (2/2) |
| gen-datatables-scroll | 16.6s / 6 / 63k (2/2) | 15.2s / 7 / 60k (2/2) | 15.6s / 8 / 66k (2/2) | 20.9s / 7 / 65k (2/2) | 18.2s / 8 / 72k (2/2) | 14.1s / 6 / 55k (2/2) | 21.5s / 7 / 64k (2/2) |

Each arm / none (medians):

| arm | wall time (s) | tool calls | screenshot/zoom actions | turns | input tokens (incl. cache) | uncached input tokens | output tokens | tool result KB (text + images) | cost (USD) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| batchHint | 0.93 | 0.92 | – | 0.93 | 0.95 | 1.03 | 0.98 | 1.06 | 0.99 |
| fewerShots | 0.99 | 1.00 | – | 1.00 | 0.96 | 0.90 | 1.07 | 0.99 | 1.01 |
| screenshotAlias | 1.07 | 1.00 | – | 1.00 | 1.01 | 0.96 | 1.09 | 1.01 | 0.98 |
| pageTextCap | 1.11 | 1.08 | – | 1.07 | 1.16 | 0.92 | 1.22 | 0.86 | 0.96 |
| quietTabs | 0.97 | 1.00 | – | 1.00 | 0.95 | 0.95 | 1.01 | 1.01 | 0.92 |
| fastNavigate | 1.07 | 1.00 | – | 1.00 | 1.02 | 0.90 | 1.09 | 1.01 | 0.90 |

### What the flags are meant to change

| per run | none | batchHint | fewerShots | screenshotAlias | pageTextCap | quietTabs | fastNavigate |
| --- | --- | --- | --- | --- | --- | --- | --- |
| batch share of calls | 1% (3/238) | 3% (7/211) | 3% (6/230) | 3% (6/232) | 1% (3/256) | 2% (4/225) | 2% (4/229) |
| actions per run (batch contents counted) | 7.9 | 7.8 | 8.3 | 8.3 | 8.6 | 7.7 | 8.1 |
| screenshot/zoom actions per run | 0.4 | 0.3 | 0.3 | 0.4 | 0.5 | 0.3 | 0.4 |
| screenshot tool calls (offered only with screenshotAlias) | 2 | 2 | 2 | 11 | 1 | 1 | 1 |
| navigate results that list the session's tabs | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| navigate result bytes, median [min–max] | 109 [55–266] | 132 [55–266] | 132 [55–266] | 120 [55–267] | 107 [55–267] | 121 [55–267] | 132 [55–267] |
| get_page_text result bytes, median [min–max] | 5588 [247–29756] | 5588 [247–29756] | 5395 [247–29756] | 5395 [247–29756] | 5394 [247–21677] | 5588 [1195–29756] | 4762 [247–29677] |

### Per call

| per call | none | batchHint | fewerShots | screenshotAlias | pageTextCap | quietTabs | fastNavigate |
| --- | --- | --- | --- | --- | --- | --- | --- |
| computer left_click ms, median [min–max] | 27 [11–38] (26 clicks) | 26 [15–46] (19 clicks) | 24 [13–48] (28 clicks) | 23 [10–43] (25 clicks) | 23 [16–42] (29 clicks) | 26 [9–100] (26 clicks) | 23 [12–66] (27 clicks) |
| find result bytes, median [min–max] | 568 [211–867] (14 calls) | 712 [291–1121] (14 calls) | 525 [192–867] (17 calls) | 505 [211–863] (14 calls) | 446 [211–800] (15 calls) | 611 [211–993] (13 calls) | 615 [211–862] (14 calls) |
| computer scroll actions (errors) | 0 (0) | 0 (0) | 0 (0) | 0 (0) | 0 (0) | 0 (0) | 0 (0) |
| get_page_text mean ms, issued alone | 16 (7 of 25) | 12 (4 of 23) | 13 (6 of 25) | 13 (4 of 27) | 17 (15 of 33) | 11 (4 of 23) | 14 (7 of 25) |
| find mean ms, issued alone | 53 (5 of 14) | 61 (4 of 14) | 46 (7 of 17) | 46 (4 of 14) | 39 (3 of 15) | 57 (4 of 13) | 45 (2 of 14) |
| NS_ERROR_UNEXPECTED results | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| tool errors, all calls | 7 | 8 | 6 | 4 | 6 | 5 | 6 |
| calls to tools not offered | left_click 2, screenshot 2 | left_click 2, scroll_to 1, screenshot 2 | left_click 2, screenshot 2 | left_click 1 | left_click 1, screenshot 1 | left_click 2, screenshot 1 | left_click 2, screenshot 1 |

NS_ERROR_UNEXPECTED: a count from the traces' result text where the trace has it; "≥n" counts the error samples a row keeps (at most 5 per run), so it's a lower bound.

By tool: calls per run, and mean ms per call. A call issued in the same message as a navigate waits for it, so its ms includes the page load; the after runs did that more often (navigate then get_page_text or find in one turn), which is why those two look slower per call here and not in the issued-alone rows above.

| tool | none calls | batchHint calls | fewerShots calls | screenshotAlias calls | pageTextCap calls | quietTabs calls | fastNavigate calls | none ms | batchHint ms | fewerShots ms | screenshotAlias ms | pageTextCap ms | quietTabs ms | fastNavigate ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| computer | 1.59 | 1.06 | 1.53 | 1.19 | 1.69 | 1.50 | 1.50 | 409 | 34 | 31 | 78 | 29 | 35 | 30 |
| navigate | 1.22 | 1.06 | 1.09 | 1.19 | 1.25 | 1.13 | 1.16 | 1944 | 1890 | 1828 | 1833 | 1880 | 1860 | 590 |
| tabs_close_mcp | 1.00 | 1.00 | 1.00 | 1.03 | 1.00 | 1.03 | 1.00 | 27 | 25 | 30 | 29 | 30 | 136 | 28 |
| tabs_context_mcp | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 56 | 56 | 57 | 49 | 52 | 54 | 55 |
| get_page_text | 0.78 | 0.72 | 0.78 | 0.84 | 1.03 | 0.72 | 0.78 | 1067 | 1303 | 1077 | 1211 | 791 | 1174 | 286 |
| javascript_tool | 0.91 | 0.63 | 0.66 | 0.69 | 1.09 | 0.75 | 0.81 | 1640 | 2264 | 1704 | 1492 | 1727 | 1691 | 2090 |
| find | 0.44 | 0.44 | 0.53 | 0.44 | 0.47 | 0.41 | 0.44 | 1060 | 1007 | 859 | 1017 | 967 | 1080 | 304 |
| batch | 0.09 | 0.22 | 0.19 | 0.19 | 0.09 | 0.13 | 0.13 | 6634 | 6086 | 10784 | 10591 | 7958 | 5634 | 2423 |
| read_page | 0.16 | 0.16 | 0.13 | 0.16 | 0.19 | 0.13 | 0.13 | 570 | 534 | 739 | 551 | 431 | 627 | 150 |
| form_input | 0.13 | 0.16 | 0.16 | 0.13 | 0.13 | 0.13 | 0.13 | 28 | 34 | 31 | 40 | 37 | 32 | 37 |
| screenshot | 0.06 | 0.06 | 0.06 | 0.34 | 0.03 | 0.03 | 0.03 | 1 | 2 | 1 | 246 | 1 | 1 | 1 |
| left_click | 0.06 | 0.06 | 0.06 | 0.03 | 0.03 | 0.06 | 0.06 | 1 | 1 | 2 | 1 | 1 | 1 | 1 |
| tabs_create_mcp | 0.00 | 0.00 | 0.00 | 0.03 | 0.00 | 0.03 | 0.00 | – | – | – | 35 | – | 35 | – |
| scroll_to | 0.00 | 0.03 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | – | 4 | – | – | – | – | – |

---

## Arms against no flags (Firefox, 16 tasks x 2 runs each)

Source: `eval/results/browsers-arms.jsonl`. 224 runs, 7 arms, 16 tasks, arms interleaved within each task and run. Cost is list price from the result event.

### Per arm

| arm | pass | wall s median / mean | tool calls median / mean | actions mean | screenshot actions mean | input tokens median / mean | output tokens median / mean | cost median / mean | total cost | not-offered tool calls |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| none | 32/32 | 14.5 / 16.7 | 6 / 7.4 | 7.9 | 0.38 | 58.3k / 68.1k | 967 / 1.1k | 0.058 / 0.057 | 1.82 | 4 |
| batchHint | 31/32 | 13.4 / 16.1 | 6 / 6.6 | 7.8 | 0.34 | 55.4k / 65.3k | 944 / 993 | 0.057 / 0.056 | 1.78 | 5 |
| fewerShots | 32/32 | 14.4 / 17.1 | 6 / 7.2 | 8.3 | 0.34 | 56.0k / 65.3k | 1.0k / 1.1k | 0.058 / 0.056 | 1.78 | 4 |
| screenshotAlias | 32/32 | 15.5 / 17.2 | 6 / 7.3 | 8.3 | 0.41 | 59.0k / 64.6k | 1.1k / 1.1k | 0.056 / 0.055 | 1.78 | 1 |
| pageTextCap | 32/32 | 16.2 / 18.4 | 7 / 8.0 | 8.6 | 0.50 | 67.9k / 71.5k | 1.2k / 1.2k | 0.055 / 0.058 | 1.85 | 2 |
| quietTabs | 31/32 | 14.1 / 16.3 | 6 / 7.0 | 7.7 | 0.34 | 55.3k / 65.6k | 977 / 1.1k | 0.053 / 0.056 | 1.80 | 3 |
| fastNavigate | 32/32 | 15.5 / 16.2 | 6 / 7.2 | 8.1 | 0.38 | 59.3k / 64.6k | 1.1k / 1.1k | 0.052 / 0.055 | 1.77 | 3 |

### Each arm against none, by task

Ratios are arm / none. "Geomean" is the geometric mean of the per-task median ratios (each task counts once). "Up / down" counts tasks whose median moved by more than 10% in that direction, out of 16; "p" is a two-sided sign test on those. With 2 runs a task's median is their mean, so single-run luck moves it a lot: the last row shows none's run 1 against none's run 2 the same way, which is the noise floor.

**wall s**

| arm | ratio of means | geomean of task ratios | tasks up / same / down | p |
| --- | --- | --- | --- | --- |
| batchHint | 0.97 | 0.98 | 2 / 12 / 2 | 1.00 |
| fewerShots | 1.02 | 1.02 | 2 / 14 / 0 | 0.50 |
| screenshotAlias | 1.03 | 1.03 | 5 / 7 / 4 | 1.00 |
| pageTextCap | 1.10 | 1.11 | 10 / 5 / 1 | 0.01 |
| quietTabs | 0.98 | 1.00 | 4 / 6 / 6 | 0.75 |
| fastNavigate | 0.97 | 0.96 | 3 / 7 / 6 | 0.51 |
| (none run 2 vs run 1) | – | – | 3 / 8 / 5 | 0.73 |

**tool calls**

| arm | ratio of means | geomean of task ratios | tasks up / same / down | p |
| --- | --- | --- | --- | --- |
| batchHint | 0.89 | 0.89 | 0 / 11 / 5 | 0.06 |
| fewerShots | 0.97 | 0.96 | 1 / 12 / 3 | 0.63 |
| screenshotAlias | 0.97 | 0.99 | 1 / 13 / 2 | 1.00 |
| pageTextCap | 1.08 | 1.09 | 7 / 8 / 1 | 0.07 |
| quietTabs | 0.95 | 0.95 | 0 / 12 / 4 | 0.13 |
| fastNavigate | 0.96 | 0.97 | 2 / 12 / 2 | 1.00 |
| (none run 2 vs run 1) | – | – | 2 / 12 / 2 | 1.00 |

**actions (batch contents counted)**

| arm | ratio of means | geomean of task ratios | tasks up / same / down | p |
| --- | --- | --- | --- | --- |
| batchHint | 0.98 | 0.99 | 1 / 13 / 2 | 1.00 |
| fewerShots | 1.04 | 1.04 | 2 / 12 / 2 | 1.00 |
| screenshotAlias | 1.06 | 1.05 | 2 / 14 / 0 | 0.50 |
| pageTextCap | 1.09 | 1.11 | 7 / 7 / 2 | 0.18 |
| quietTabs | 0.97 | 0.98 | 0 / 13 / 3 | 0.25 |
| fastNavigate | 1.02 | 1.04 | 3 / 13 / 0 | 0.25 |
| (none run 2 vs run 1) | – | – | 2 / 12 / 2 | 1.00 |

**screenshot/zoom actions**

| arm | ratio of means | geomean of task ratios | tasks up / same / down | p |
| --- | --- | --- | --- | --- |
| batchHint | 0.92 | – | 0 / 15 / 1 | 1.00 |
| fewerShots | 0.92 | – | 0 / 14 / 2 | 0.50 |
| screenshotAlias | 1.08 | – | 1 / 13 / 2 | 1.00 |
| pageTextCap | 1.33 | – | 1 / 15 / 0 | 1.00 |
| quietTabs | 0.92 | – | 0 / 15 / 1 | 1.00 |
| fastNavigate | 1.00 | – | 0 / 14 / 2 | 0.50 |
| (none run 2 vs run 1) | – | – | 1 / 14 / 1 | 1.00 |

**input tokens (incl. cache)**

| arm | ratio of means | geomean of task ratios | tasks up / same / down | p |
| --- | --- | --- | --- | --- |
| batchHint | 0.96 | 0.96 | 1 / 12 / 3 | 0.63 |
| fewerShots | 0.96 | 0.97 | 0 / 13 / 3 | 0.25 |
| screenshotAlias | 0.95 | 0.97 | 1 / 12 / 3 | 0.63 |
| pageTextCap | 1.05 | 1.06 | 6 / 9 / 1 | 0.13 |
| quietTabs | 0.96 | 0.96 | 1 / 11 / 4 | 0.38 |
| fastNavigate | 0.95 | 0.97 | 1 / 10 / 5 | 0.22 |
| (none run 2 vs run 1) | – | – | 4 / 10 / 2 | 0.69 |

**output tokens**

| arm | ratio of means | geomean of task ratios | tasks up / same / down | p |
| --- | --- | --- | --- | --- |
| batchHint | 0.89 | 0.91 | 1 / 11 / 4 | 0.38 |
| fewerShots | 0.99 | 0.99 | 2 / 11 / 3 | 1.00 |
| screenshotAlias | 0.98 | 0.99 | 2 / 12 / 2 | 1.00 |
| pageTextCap | 1.10 | 1.11 | 8 / 7 / 1 | 0.04 |
| quietTabs | 0.96 | 0.97 | 1 / 11 / 4 | 0.38 |
| fastNavigate | 1.00 | 1.01 | 4 / 8 / 4 | 1.00 |
| (none run 2 vs run 1) | – | – | 4 / 8 / 4 | 1.00 |

**cost USD**

| arm | ratio of means | geomean of task ratios | tasks up / same / down | p |
| --- | --- | --- | --- | --- |
| batchHint | 0.98 | 0.98 | 0 / 14 / 2 | 0.50 |
| fewerShots | 0.98 | 0.99 | 2 / 12 / 2 | 1.00 |
| screenshotAlias | 0.98 | 0.99 | 1 / 14 / 1 | 1.00 |
| pageTextCap | 1.02 | 1.01 | 4 / 7 / 5 | 1.00 |
| quietTabs | 0.99 | 0.99 | 1 / 14 / 1 | 1.00 |
| fastNavigate | 0.98 | 0.98 | 1 / 13 / 2 | 1.00 |
| (none run 2 vs run 1) | – | – | 4 / 10 / 2 | 0.69 |

### Did each flag do what it should

**batchHint** (batch calls, and how many actions they held)

| arm | runs using batch | batch calls | actions per batch | runs with 2+ same-turn calls that could have batched (find/read_page then form_input or computer in the next call) |
| --- | --- | --- | --- | --- |
| none | 2 of 32 | 3 | 6.0 | 9 |
| batchHint | 4 of 32 | 7 | 6.3 | 9 |

Per task, batch calls (none / batchHint), tasks where either used one:

cmp-pypi 0/2, cmp-npm 3/4, gen-apg-datepicker 0/1

**fewerShots** (screenshot actions, including zooms and those inside batches)

| arm | screenshot/zoom actions total | runs with any | mean per run |
| --- | --- | --- | --- |
| none | 12 | 7 of 32 | 0.38 |
| fewerShots | 11 | 7 of 32 | 0.34 |

Per task, screenshot actions (none / fewerShots), tasks where either had one:

gen-pydocs-search 1/0, gen-httpbin-form 2/2, gen-mdn-iframe 3/3, gen-apg-datepicker 6/5, gen-datatables-scroll 0/1

**screenshotAlias** (calls to the `screenshot` tool; in the other arms it is not offered)

| arm | screenshot tool calls | errors | runs using it | `computer` screenshot actions |
| --- | --- | --- | --- | --- |
| none | 2 | 2 | 2 | 11 |
| batchHint | 2 | 2 | 2 | 9 |
| fewerShots | 2 | 2 | 1 | 10 |
| screenshotAlias | 11 | 0 | 7 | 1 |
| pageTextCap | 1 | 1 | 1 | 14 |
| quietTabs | 1 | 1 | 1 | 11 |
| fastNavigate | 1 | 1 | 1 | 11 |

**pageTextCap** (`get_page_text` results at the 8000-character cap, and reads that used offset or max_chars)

| arm | get_page_text calls | result bytes median / max | calls with offset or max_chars | calls that hit the cap (bytes 7900-8300) |
| --- | --- | --- | --- | --- |
| none | 25 | 5.6k / 29.8k | 0 | 0 |
| pageTextCap | 33 | 5.4k / 21.7k | 10 | 7 |

Per task, get_page_text calls in the cap arm against none (tasks where the count differs):

art-ars-firefox 2 -> 4 (largest text in none 26.2k bytes); art-guardian-tang 2 -> 4 (largest text in none 29.8k bytes); data-ashby-ramp 2 -> 4 (largest text in none 24.1k bytes); cmp-pypi 0 -> 1 (largest text in none 0 bytes); cmp-npm 1 -> 2 (largest text in none 4.8k bytes); gen-wiki-chain 1 -> 2 (largest text in none 21.4k bytes); gen-pydocs-search 3 -> 2 (largest text in none 9.5k bytes)

**quietTabs** (navigate results that end with the session's tab list)

| arm | navigate calls | results with a tab list | navigate calls that opened a tab |
| --- | --- | --- | --- |
| none | 39 | 0 | 0 |
| quietTabs | 36 | 0 | 0 |

**fastNavigate** (navigate time; get_page_text and find issued in the same message wait for it)

| arm | navigate ms median / mean | navigate calls | get_page_text ms median | results with the "returned once the page was parsed" note |
| --- | --- | --- | --- | --- |
| none | 1901 / 1944 | 39 | 1571 | 0 |
| fastNavigate | 580 / 590 | 37 | 277 | 1 |

### Failures

- gen-httpbin-form.baseline.firefox.2.batchHint.2026-09-30T13-52-21-572Z: wrong answer
- gen-httpbin-form.baseline.firefox.2.quietTabs.2026-09-30T13-52-42-769Z: wrong answer
