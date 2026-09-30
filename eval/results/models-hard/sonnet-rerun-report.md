# Model x effort benchmark

54 runs over 6 tasks and 3 configs (rounds 1, 2, 3). Generated 2026-09-30T08:59:00.706Z.

Cells show median (p25–p75). Score is the share of a task's sub-goals met (timeouts score 0); pass means every sub-goal. Cost is `total_cost_usd` from the CLI's result event (list-price equivalent). Output tokens include thinking. ★ = on the Pareto frontier.

## Per config

| config | n | pass | score | wall s | 1st tool s | tool calls | shots | turns | out tok | in tok (all) | cost $ | $/success | ★ score/cost | ★ score/time | timeouts | load (other eval) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| sonnet-5-5/low | 18 | 67% | 0.89 | 75 (41–96) | 2.0 (1.8–2.2) | 27 (7–88) | 4 (0–15) | 28 (8–89) | 10361 (4295–12131) | 164913 (80994–778062) | 0.232 (0.167–0.435) | 0.452 | ★ |  | 0 | 0.0 |
| sonnet-5-5/medium | 18 | 94% | 0.99 | 67 (43–103) | 2.4 (2.0–2.6) | 34 (7–83) | 5 (0–16) | 35 (8–84) | 9007 (4509–13304) | 173382 (85227–626919) | 0.239 (0.173–0.340) | 0.324 | ★ | ★ | 0 | 0.0 |
| sonnet-5-5/high | 18 | 83% | 0.97 | 81 (44–110) | 2.0 (1.9–2.2) | 44 (13–91) | 8 (0–22) | 45 (14–92) | 10546 (5170–15560) | 193297 (111154–919193) | 0.279 (0.179–0.433) | 0.388 |  |  | 0 | 0.0 |

## Errors and retries per config

| config | tool errors | repeated calls | retries after error | thinking blocks | tool result kchars |
|---|---|---|---|---|---|
| sonnet-5-5/low | 0 (0–1) | 0 (0–0) | 0 (0–0) | 7 (2–16) | 16.4 (5.8–27.9) |
| sonnet-5-5/medium | 0 (0–1) | 0 (0–0) | 0 (0–0) | 5 (2–9) | 14.0 (5.6–28.1) |
| sonnet-5-5/high | 0 (0–1) | 0 (0–0) | 0 (0–0) | 7 (4–18) | 15.8 (5.4–29.1) |

## Effort steps (within a model)

| model | step | Δ score | Δ pass | Δ median cost $ | Δ median wall s | Δ median out tok | $ per score point |
|---|---|---|---|---|---|---|---|
| sonnet-5-5 | low→medium | 0.10 | 28 pts | 0.008 | -8 | -1354 | 0.0008 |
| sonnet-5-5 | medium→high | -0.02 | -11 pts | 0.039 | 14 | 1539 | – |

## Per task

### books-no-js

| config | n | pass | score | wall s | tool calls | out tok | cost $ | $/success | ★ cost | ★ time |
|---|---|---|---|---|---|---|---|---|---|---|
| sonnet-5-5/low | 3 | 33% | 0.89 | 85 (83–87) | 82 (70–93) | 12158 (9864–12271) | 0.464 (0.461–0.730) | 1.918 | ★ | ★ |
| sonnet-5-5/medium | 3 | 67% | 0.94 | 116 (92–148) | 97 (74–101) | 15533 (11606–15837) | 0.726 (0.641–0.843) | 1.121 | ★ | ★ |
| sonnet-5-5/high | 3 | 33% | 0.89 | 121 (119–123) | 102 (102–104) | 16441 (16113–16483) | 0.677 (0.634–0.722) | 2.035 |  |  |

Sub-goal miss rate: averages 56%, winner 0%, right_books 0%, exact_titles_in_order 0%, completed_five_star 0%, active_filter 0%

### hockey-no-js

| config | n | pass | score | wall s | tool calls | out tok | cost $ | $/success | ★ cost | ★ time |
|---|---|---|---|---|---|---|---|---|---|---|
| sonnet-5-5/low | 3 | 33% | 0.87 | 39 (38–43) | 14 (10–14) | 4284 (4226–4305) | 0.167 (0.166–0.167) | 0.500 | ★ | ★ |
| sonnet-5-5/medium | 3 | 100% | 1.00 | 42 (36–44) | 14 (9–14) | 4501 (4008–4517) | 0.170 (0.154–0.177) | 0.164 | ★ | ★ |
| sonnet-5-5/high | 3 | 67% | 0.93 | 43 (43–46) | 14 (10–14) | 5163 (4881–5177) | 0.179 (0.175–0.179) | 0.265 |  |  |

Sub-goal miss rate: a_50_wins 22%, c_years 11%, b_plus_60 0%, d_franchise_wins 0%, e_new_sum 0%

### sudoku-no-js

| config | n | pass | score | wall s | tool calls | out tok | cost $ | $/success | ★ cost | ★ time |
|---|---|---|---|---|---|---|---|---|---|---|
| sonnet-5-5/low | 3 | 67% | 0.70 | 97 (96–110) | 7 (6–7) | 13814 (13623–15349) | 0.235 (0.232–0.252) | 0.366 | ★ | ★ |
| sonnet-5-5/medium | 3 | 100% | 1.00 | 104 (102–108) | 7 (6–12) | 14605 (14197–14680) | 0.249 (0.244–0.249) | 0.246 | ★ | ★ |
| sonnet-5-5/high | 3 | 100% | 1.00 | 105 (103–115) | 14 (14–15) | 15979 (15433–17289) | 0.280 (0.275–0.306) | 0.295 |  |  |

Sub-goal miss rate: row_1 11%, row_2 11%, row_3 11%, row_4 11%, row_5 11%, row_6 11%, row_7 11%, row_8 11%, row_9 0%

### tldraw-no-js

| config | n | pass | score | wall s | tool calls | out tok | cost $ | $/success | ★ cost | ★ time |
|---|---|---|---|---|---|---|---|---|---|---|
| sonnet-5-5/low | 3 | 100% | 1.00 | 67 (65–68) | 74 (57–82) | 9624 (9123–10361) | 0.225 (0.216–0.238) | 0.228 |  |  |
| sonnet-5-5/medium | 3 | 100% | 1.00 | 65 (58–66) | 76 (74–81) | 9489 (8912–10092) | 0.213 (0.208–0.227) | 0.219 | ★ |  |
| sonnet-5-5/high | 3 | 100% | 1.00 | 65 (63–68) | 85 (79–85) | 10479 (10001–10768) | 0.277 (0.253–0.281) | 0.264 |  | ★ |

Sub-goal miss rate: six_labeled_rectangles 0%, grid_order 0%, same_size 0%, rows_aligned 0%, columns_aligned 0%, even_gaps 0%, row_colors 0%, arrows_bound 0%, arrow_labels 0%, frame_loop 0%, nothing_else 0%

### uitp-no-js

| config | n | pass | score | wall s | tool calls | out tok | cost $ | $/success | ★ cost | ★ time |
|---|---|---|---|---|---|---|---|---|---|---|
| sonnet-5-5/low | 3 | 100% | 1.00 | 105 (101–113) | 105 (104–107) | 12030 (11677–12040) | 0.441 (0.429–0.470) | 0.452 |  |  |
| sonnet-5-5/medium | 3 | 100% | 1.00 | 92 (85–107) | 83 (83–94) | 9129 (9007–10490) | 0.340 (0.339–0.399) | 0.379 | ★ | ★ |
| sonnet-5-5/high | 3 | 100% | 1.00 | 97 (94–104) | 92 (90–99) | 10613 (10398–11428) | 0.444 (0.421–0.467) | 0.444 |  |  |

Sub-goal miss rate: ajax 0%, text_input 0%, mouseover_3 0%, overlapped_name 0%, scroll_all_4 0%, clear_all 0%, single_selects 0%, multi_selects 0%, table_cpu 0%

### wc-tiebreak

| config | n | pass | score | wall s | tool calls | out tok | cost $ | $/success | ★ cost | ★ time |
|---|---|---|---|---|---|---|---|---|---|---|
| sonnet-5-5/low | 3 | 67% | 0.89 | 23 (22–23) | 7 (7–7) | 2217 (2212–2349) | 0.079 (0.076–0.080) | 0.116 |  | ★ |
| sonnet-5-5/medium | 3 | 100% | 1.00 | 23 (23–24) | 6 (6–7) | 2446 (2387–2486) | 0.083 (0.078–0.084) | 0.080 |  | ★ |
| sonnet-5-5/high | 3 | 100% | 1.00 | 26 (23–28) | 6 (6–7) | 2655 (2455–2922) | 0.076 (0.076–0.085) | 0.082 | ★ |  |

Sub-goal miss rate: group_order 11%, bexley_third 11%, corwen_above_arden 0%, fair_play_scores 0%, pellham_position 0%, pushed_out 0%
