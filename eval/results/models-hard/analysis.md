# Model x effort benchmark, hard tier (round 2): analysis

162 runs: 9 configs (Sonnet 5.5, Opus 5.5 and Fable 5.1 at low, medium and high effort), 6 tasks, 3 rounds, concurrency 3. There were no timeouts, infra errors or rate limits, and no run overlapped another eval. Cost is the CLI's list-price `total_cost_usd`, not what the subscription bills: $108.52 for the matrix plus $19.75 for 38 smoke runs, $128.27 in total.

The tasks are in `eval/models-tasks-hard.mjs`. Three are ordinary: a rules task (2026 World Cup tie-breakers, read from Wikipedia) and two exact-reading tasks. Five forbid `javascript_tool` (all but the World Cup tie-break), and a run that uses it scores 0. Two earlier drafts were at ceiling in smoke runs (see "How the tier was made hard").

## Headline
- **The hard tier separates the models, but only a little.** Mean score (passes of 18):

  | model | low | medium | high |
  |---|---|---|---|
  | Sonnet 5.5 | 0.935 (14) | 0.930 (12) | 0.994 (17) |
  | Opus 5.5 | 0.981 (16) | 0.989 (17) | 0.991 (17) |
  | Fable 5.1 | 0.991 (17) | 1.000 (18) | 1.000 (18) |

  Fable passed 53 of 54 runs and Sonnet 43 of 54 (Fisher p = 0.004). Sonnet low and medium together passed 26 of 36, against Opus's 50 of 54 (p = 0.016).
- **Effort now buys score, but only for Sonnet, and only at high.**
  - Sonnet medium to high: +0.064 mean score, up on 4 of 6 tasks and down on none, for x1.06 cost and x1.05 wall time.
  - Sonnet low to medium bought nothing: -0.005, up on 2 tasks and down on 2.
  - For Opus and Fable each step moves score by 0.009 or less. Both are close to ceiling already at low.
- **Sonnet high matches Opus at every effort for less money.** It scores 0.994 at $0.386 a run. Opus high scores 0.991 at $0.555, and Opus is also slower at every level.
- **Fable is the only config with no misses** (medium and high, 18 of 18 each). It is also the fastest: median 71 s at low and at high, against 79–88 s for Sonnet and 84–99 s for Opus. It costs 3.2–3.6x Sonnet at the same effort.
- **Score vs cost frontier:** Sonnet low ($0.302, 0.935), Sonnet high ($0.386, 0.994) and Fable medium ($1.212, 1.000).
- **Score vs time frontier:** Fable low and Fable high, both at 71 s median.
- **The misses are slips, not missing capability.** Every model solved the Evil sudoku (54 of 54) and every run passed the 13-shape tldraw grid. The misses are:
  - one star misread out of 167;
  - one row miscounted out of 582;
  - a goals tally in a three-team head-to-head added up wrong;
  - "which team drops from 8th" answered one place off;
  - giving up on a text box whose `change` event never fired.

## Recommendations
| use | config | why |
|---|---|---|
| Sidebar chat default | **Sonnet 5.5 high** (was medium) | On hard tasks it scores 0.994 against medium's 0.930, at the same mean cost ($0.386 vs $0.390). On round 1's easy tasks it cost 7% more than medium and took 1.2x as long. |
| Quick tasks | **Sonnet 5.5 low** | Cheapest on both tiers ($0.114 easy, $0.302 hard). On hard tasks it passes 14 of 18, and its misses are counting slips. |
| Fan-out sub-agents | **Sonnet 5.5 low**, or **high** where one wrong count matters | Cost per successful task: $0.388 at low, $0.409 at high. High's extra passes almost pay for its extra cost. |
| Must be right, or fastest | **Fable 5.1 medium** | 18 of 18 passes, 83 s median (low and high run 71 s). $1.21 a run, or $1.21 per success. |
| Avoid | Sonnet medium, and Opus | Sonnet medium did worst of the 9 configs (12 of 18) and costs the same as Sonnet high. Opus is never better than Sonnet high and costs 1.1–1.4x more. |

## Diminishing returns
Each cell is the geometric mean of the per-task ratios of cell medians. The bracket counts the tasks (of 6) where the median rose. Score is the mean change over tasks, with how many tasks went up and down.

| model | step | score | cost | wall | output tokens | tool calls |
|---|---|---|---|---|---|---|
| Sonnet | low→medium | -0.005 (2 up, 2 down) | x1.14 (5/6) | x1.14 (4/6) | x1.12 (4/6) | x1.02 (2/6) |
| Sonnet | medium→high | **+0.064 (4 up, 0 down)** | x1.06 (5/6) | x1.05 (3/6) | x1.06 (4/6) | x0.92 (4/6) |
| Opus | low→medium | +0.007 (2 up, 1 down) | x1.20 (5/6) | x1.06 (3/6) | x1.05 (4/6) | x1.13 (3/6) |
| Opus | medium→high | +0.002 (1 up, 1 down) | x1.06 (5/6) | **x1.23 (6/6)** | **x1.29 (6/6)** | x1.23 (5/6) |
| Fable | low→medium | +0.009 (1 up, 0 down) | **x1.27 (6/6)** | x1.16 (5/6) | x1.12 (5/6) | x0.97 (2/6) |
| Fable | medium→high | 0.000 | x1.03 (4/6) | x0.99 (3/6) | x0.99 (3/6) | x0.94 (1/6) |

- **Where returns stop:**
  - Sonnet gains nothing from low to medium and gains from medium to high.
  - Opus and Fable stop paying at low. For Opus, high adds time and tokens on 6 of 6 tasks for +0.002 score. For Fable, medium costs x1.27 on 6 of 6 tasks for +0.009 (one books run).
- **Same effort, across models:**
  - Opus costs x1.39, x1.46 and x1.47 of Sonnet at low, medium and high. It scores +0.046 and +0.059 higher at low and medium, and -0.003 at high.
  - Fable costs x3.20, x3.56 and x3.47 of Sonnet, and scores +0.056, +0.070 and +0.006 higher.
  - Both use far fewer calls than Sonnet (x0.29–0.52), because they batch (see Tool use). Their wall time is similar: x0.80–1.08.
- **Small samples:**
  - Sonnet high against medium is 17 of 18 passes against 12 of 18 (Fisher p = 0.09). The step is consistent across tasks, but it is not settled.
  - Sonnet high against low is 17 against 14 (p = 0.34).

## Per-task failure modes (read from the traces)
| task | misses (of 27 runs per model) | failure mode |
|---|---|---|
| wc-tiebreak | Sonnet 5 (low 2, medium 2, plus 1 pushed-out), Opus 1, Fable 0 | Slips on the head-to-head goals total, and one place off on who drops out |
| uitp-no-js | Sonnet 3 (medium 2, high 1) | Typed into the text box, the button never renamed, and the run gave up without trying `form_input` |
| books-no-js | Sonnet 3, Opus 2, Fable 1 | One star misread, which moves an average outside ±0.011 |
| hockey-no-js | Sonnet 1 (medium), Opus 1 (medium) | Counted 33 or 35 seasons of 50+ wins, not 34 |
| sudoku-no-js, tldraw-no-js | none | – |

- **wc-tiebreak:**
  - In 4 Sonnet runs (low 2, medium 2) Bexley was ranked first. Each of these runs quoted the right rule order and got the head-to-head goals wrong: "each team scored 3 goals in them" or "4 goals scored". Bexley scored 2 and the other two scored 3, and criterion c should have put Bexley third. From there the runs fell through to overall goal difference, which is what the 2022 rules would give.
  - Sonnet high got it right 3 of 3.
  - Two runs (Sonnet low, Opus low) answered Paraguay for "pushed out". Paraguay moves from 7th to 8th and still advances; Senegal drops to 9th.
  - Every run got the fair-play arithmetic right, including the one-deduction rule (-9 and -9) and the footnoted -3 and -5.
- **uitp-no-js:**
  - All 3 misses are the text box. Typing with `computer` and then Tab or a click never fired the page's `change` event, in any config (see Confounds).
  - Every passing run ended with `form_input`. Opus and Fable always fell back to it after typing failed. Sonnet low went to it first. Sonnet medium and high typed, pressed Tab and Enter, and stopped.
- **books-no-js:**
  - All 6 misses are a single miscount. The answers were 3.31 for Young Adult (179 stars read, key 178), 3.20 for Fiction (208, key 207), and 3.06 or 3.10 for Fantasy (147 or 149, key 148).
  - The winner, the eight todos, their exact titles and prices, the completed set and the filter were right in every run.
  - Sonnet medium, round 2, read the ratings from `view-source:` pages instead of screenshots and got every star right. The prompt allows that.
- **hockey-no-js:** a scan of 582 rows at 100 per page. The two misses were off by one on the 50-win count. The tie-heavy per-year question, the franchise trap and the 63-number signed sum were right in all 54 runs.
- **sudoku-no-js:**
  - Every config solved the Evil puzzle without code, usually in one thinking pass and one `form_input` of 55 fields (Fable 5 actions median, Sonnet 5–7).
  - The one smoke failure was the page itself: pressing "How am I doing?" on a full grid submits it and loads a new page. The prompt now says not to press it.
- **tldraw-no-js:** 54 of 54 passed through the UI: six labeled rectangles, equal gaps and aligned rows and columns, row colors, six bound arrows with two labels, all in a frame named Loop. One Opus run used light-green; like round 1, the check accepts the light shades.
- **No run broke the no-JavaScript rule.**

## Tool use
| config | calls (median) | actions incl. batch contents (median) | share of calls that are `batch` | screenshots+zooms (median) | tool errors / 18 runs | calls to nonexistent tools |
|---|---|---|---|---|---|---|
| Sonnet low / medium / high | 25 / 35 / 45 | 63 / 35 / 45 | 1% / 1% / 0% | 6.5 / 3.5 / 6 | 24 / 27 / 21 | 13 / 15 / 13 |
| Opus low / medium / high | 8.5 / 10 / 13.5 | 34 / 31 / 37 | 60% / 48% / 35% | 0.5 / 1 / 2 | 8 / 9 / 5 | 0 / 0 / 1 |
| Fable low / medium / high | 6.5 / 8.5 / 7.5 | 45 / 38.5 / 39.5 | 66% / 67% / 69% | 1 / 1.5 / 1 | 10 / 11 / 8 | 0 / 0 / 0 |

- **Batching is the biggest behavioral split.** Opus and Fable put most of their work into `batch` calls (8–9 per run). Sonnet almost never does, so it takes 3–5x the calls for about the same number of actions.
  - This is why Sonnet reads 1.8–2x as much cache per run (422k–648k mean, against 211k–366k for Fable).
  - It is also why Sonnet's cost advantage is smaller here than in round 1 (Fable is x3.2–3.6 of Sonnet, against x4.0–4.3 in round 1).
- **Output tokens:**
  - Sonnet's median output is flat across effort (about 10.7k at every level).
  - Opus goes 5.7k, 6.8k, 7.9k and Fable 5.7k, 7.0k, 7.4k.
  - So Sonnet high's extra passes come from how it spends thinking, not from more of it.
- **Calls to nonexistent tools are still Sonnet-only:** 13–15 per 18 runs, all `mcp__firefox__screenshot`, as in round 1. Aliasing that name, or pointing the error at `computer`, would save a turn each time.
- **Screenshots:** Sonnet takes 3.5–6.5 per run. Opus and Fable take 0.5–2, and read the page through `find`, `read_page` and `get_page_text` inside batches.

## Confounds
- **Only 3 runs per cell.** A difference is called consistent only if it holds on at least 5 of 6 tasks. The Sonnet medium-to-high score step holds on 4 of 6 with none down.
- **The `computer` type path fails on UI Testing Playground's text input.** Trusted typing followed by Tab or a click never fires `change` there, so the button can't be renamed without `form_input`. This is an extension gap as much as a model difference: a real keyboard would fire `change` on blur. Fixing it would probably turn Sonnet's 3 uitp misses into passes, leaving Sonnet medium at about 0.96.
- **The tool set changed since round 1.** `batch` and multi-field `form_input` came in with the climb-1 commit, after round 1 ran. So call counts, turns and cache reads can't be compared across rounds, and Opus and Fable gain more from `batch` than Sonnet does.
- **No-JS is a constraint I added.** It is what made the tier hard: without it, drafts 1 and 2 were solved through the page's JavaScript and ran at ceiling. It measures careful reading and UI work, which is what the extension exists for, but it isn't how a user would ask.
- **The rules were adjusted during the run, then all 162 rows were re-graded** (`models-rescore.mjs`), so every row uses the final rules:
  - tldraw's light-blue and light-green count, as in round 1 (changed 1 row);
  - `view-source:` counts against the no-JS rule only on sudoku, the only prompt that forbids it (changed 1 row).
- **Load:** runs ran three at a time (a mean of 1.9 sibling runs), with no other eval or harness agent running, which is the same as round 1's rounds 2 and 3.
- **Cost is list price.** On the subscription, what matters is usage-limit burn, which roughly follows these ratios.

## Compared with round 1
| | round 1 (easy, 6 tasks) | round 2 (hard, 6 tasks) |
|---|---|---|
| Sonnet low / medium / high score | 1.00 / 1.00 / 1.00 | 0.935 / 0.930 / 0.994 |
| Opus low / medium / high score | 1.00 / 1.00 / 1.00 | 0.981 / 0.989 / 0.991 |
| Fable low / medium / high score | 1.00 / 1.00 / 1.00 | 0.991 / 1.000 / 1.000 |
| Sonnet low cost / median time | $0.114 / 35 s | $0.302 / 79 s |
| Fable cost vs Sonnet, same effort | x4.0–4.3 | x3.2–3.6 |
| Opus cost vs Sonnet, same effort | x1.6–1.8 | x1.4–1.5 |
| Effort buys score? | no | Sonnet medium→high only (+0.064) |
| Score vs cost frontier | Sonnet low | Sonnet low, Sonnet high, Fable medium |

- **What changed:**
  - Round 1 could only rank configs on cost and time. Round 2 shows Sonnet's misses, and that high fixes most of them at no extra cost.
  - The sidebar recommendation moves from Sonnet medium to Sonnet high. On the hard tier medium is the weakest config, and high costs the same.
- **What held:**
  - Sonnet low is still the cheapest config that gets most things right.
  - Opus still has no role: Sonnet high matches it for less.
  - Fable is still the fastest and most reliable, at 3–4x the price.
  - Sonnet is still the only model that calls nonexistent tools.

## How the tier was made hard
Two drafts were at ceiling in smoke runs (Sonnet low and Fable high, one run each).
- **Draft 1:** franchise totals with a name trap, US/Moscow/Sydney DST from a Wikipedia table, a simpler tie-break, a books-to-TodoMVC compare, a UI Testing Playground timing gauntlet, and a tldraw loop. Sonnet low passed all six in 14–147 s, mostly by writing JavaScript: fetching every page, stopping the progress bar from a MutationObserver, and building the diagram through tldraw's editor API.
- **Draft 2:** 2026 tax rules from irs.gov, Caracas / Lord Howe / Samoa time-zone history, the 4-level tie-break, and no-JS versions of books, the gauntlet and tldraw. Sonnet low read 55 star ratings off screenshots without an error.
- **Final version:** it kept what separated behavior (no JS, rules read from a page) and scaled up what has to be exactly right:
  - 167 star ratings instead of 55;
  - 582 rows with ties and a 63-number sum;
  - a 13-shape framed grid with equal gaps;
  - an Evil sudoku instead of a Hard one.

## charts.json
Written by `eval/models-charts.mjs`, which reproduces round 1's `charts.json` series from its runs (only the hand-written notes differ). Same seven series, keyed by config:
1. `score_vs_cost`, with its frontier: Sonnet low, Sonnet high, Fable medium.
2. `score_vs_time`, with its frontier: Fable low and Fable high, both by pooled median and by the time index.
3. `effort_curves`: per model. `haiku_default_reference` is null, because Haiku wasn't run.
4. `heatmap_task_config_mean_score`, with pass counts.
5. `tool_use_per_config`.
6. `token_breakdown_per_config`.
7. `cost_per_successful_task`.

## Sonnet rerun after the restart (2026-09-30)
Sonnet 5.5 at low, medium and high, the same 6 tasks x 3 rounds (54 runs), once Firefox had restarted with main at c1ad4bb. It loads the typing fix (`change` fires on Tab or a click away in background tabs) and the `computer` description that says there are no separate screenshot or click tools. Rows are in `sonnet-rerun.jsonl`, the generated tables in `sonnet-rerun-report.md`. Same concurrency (3) and load (1.9 sibling runs, no other eval) as round 2. $16.75 list.

| | round 2 low | rerun low | round 2 medium | rerun medium | round 2 high | rerun high |
|---|---|---|---|---|---|---|
| mean score (passes of 18) | 0.935 (14) | 0.891 (12) | 0.930 (12) | 0.991 (17) | 0.994 (17) | 0.970 (15) |
| uitp-no-js passes | 3/3 | 3/3 | 1/3 | 3/3 | 2/3 | 3/3 |
| calls to tools not offered | 13 | 13 | 15 | 8 | 13 | 7 |
| mean cost | $0.302 | $0.301 | $0.390 | $0.306 | $0.386 | $0.323 |
| median wall time | 79 s | 75 s | 80 s | 67 s | 88 s | 81 s |
| median tool calls | 25 | 27 | 35 | 33.5 | 45 | 44 |

Per task, mean score (passes of 3):

| task | low r2 | low rerun | medium r2 | medium rerun | high r2 | high rerun |
|---|---|---|---|---|---|---|
| books-no-js | 0.89 (1) | 0.89 (1) | 0.94 (2) | 0.94 (2) | 1.00 (3) | 0.89 (1) |
| hockey-no-js | 1.00 (3) | 0.87 (1) | 0.93 (2) | 1.00 (3) | 1.00 (3) | 0.93 (2) |
| sudoku-no-js | 1.00 (3) | 0.70 (2) | 1.00 (3) | 1.00 (3) | 1.00 (3) | 1.00 (3) |
| tldraw-no-js | 1.00 (3) | 1.00 (3) | 1.00 (3) | 1.00 (3) | 1.00 (3) | 1.00 (3) |
| uitp-no-js | 1.00 (3) | 1.00 (3) | 0.93 (1) | 1.00 (3) | 0.96 (2) | 1.00 (3) |
| wc-tiebreak | 0.72 (1) | 0.89 (2) | 0.78 (1) | 1.00 (3) | 1.00 (3) | 1.00 (3) |

- **uitp-no-js went from 6 of 9 to 9 of 9.** Two runs (medium and high) typed "Ship it 42" with `computer` and the button took the name without `form_input`, which no run could do in round 2. The other 7 used `form_input` from the start, so the typing path was tested twice, not nine times.
- **The effort ranking moved, within noise.** Medium went from 12 to 17 passes (Fisher p = 0.09), high from 17 to 15 and low from 14 to 12 (p = 0.60 and 0.71). Over both rounds (36 runs each): low 26 passes (0.913), medium 29 (0.960), high 32 (0.982). High is still best and low is now weakest; medium isn't the worst config any more.
- **The other misses are the same slips as round 2.** Books: one star miscounted in Fiction (3.20 or 3.17 for 3.185) in 5 runs, and in Young Adult too (3.31 for 3.296) in 2 of them. Hockey: 30 or 33 seasons of 50+ wins instead of 34, and one year missing from a tie list. Sudoku low, round 2: a wrong solution entered in rows 1-8. wc-tiebreak low, round 3: Bexley ranked first from the head-to-head goals slip.
- **Closing the tab can lose the answer.** `tabs_context_mcp` now says "Created tab N for this session; close it with tabs_close_mcp when done." wc-tiebreak runs closed their tab 9 times in 9 (6 in round 2). One (medium, round 1) gave its JSON, then closed the tab and ended on "I closed the tab I opened. The answer is above.", which the harness scored 0. `models.mjs` and `models-rescore.mjs` now take the last JSON from an earlier message when the final one has none (`answer_source: "earlier_text"`), and the row was rescored to 1. Round 2 had no row without a JSON answer. State tasks still left their tabs open: no inspect errors.
- **Calls to tools not offered: 41 to 28 over 54 runs, but not from the description.** Round 2's 41 were `screenshot` 18, `zoom` 5, a `_placeholder` name 12 (`left_click_placeholder`, `screenshot_placeholder`, ...) and 6 others. The rerun's 28 are `screenshot` 21, a `_placeholder` name 6 and `type` 1. Every one has empty input and is followed by the same action through `computer`, so it reads as a slip in emitting the call, not a belief that the tool exists; the description can't reach it. Each costs one error turn.
- **Cheaper for medium and high.** Mean cost $0.306 and $0.323 against $0.390 and $0.386, and 7–13 s faster at the median. Low was unchanged.
