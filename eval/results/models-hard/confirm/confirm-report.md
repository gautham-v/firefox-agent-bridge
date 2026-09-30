# Experiment arms, hard tier: Sonnet 5.5 at low and high effort

48 runs, 2 arms (before, kept), low and high effort, 6 tasks, rounds 1, 2. Total list-price spend $15.14. Generated 2026-09-30T16:05:11.445Z.

Ratios are of medians, arm over `before`. Actions count the steps inside `batch` calls (the batch call itself doesn't count). Shots are screenshots and zooms, inside batches too. Input tokens include cache reads and writes. Cost is the CLI's list-price `total_cost_usd`.

## Effort low

| arm | n | pass | score | wall s (med / mean) | ×wall | calls | ×calls | actions | ×actions | shots | ×shots | in tok | ×in | out tok | ×out | cost $ (med / mean) | ×cost | bad-tool calls/run | tool errors |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| before | 12 | 10 (83%) | 0.945 | 74 / 75 |  | 41 |  | 41 |  | 3.5 |  | 119k |  | 9.4k |  | 0.214 / 0.267 |  | 0.42 | 0.8 |
| kept | 12 | 11 (92%) | 0.983 (+0.039) | 83 / 73 | ×1.12 | 24 | ×0.59 | 43 | ×1.04 | 4.0 | ×1.14 | 154k | ×1.29 | 10.4k | ×1.11 | 0.262 / 0.272 | ×1.22 | 0.50 | 1.8 |

Geometric mean of the per-cell ratios (each task x effort cell's median over `before`'s), which a few long tasks can't dominate:

| arm | wall | cost | calls | actions | shots | in tok | out tok |
|---|---|---|---|---|---|---|---|
| kept | ×1.03 | ×1.06 | ×1.03 | ×1.18 | ×1.12 | ×1.11 | ×1.05 |

Task consistency against `before` (cells = task; "↓" = the arm's cell median is lower by more than 5%, score: lower at all; sign-test p on the cells that moved):

| arm | wall | cost | calls | actions | shots | score |
|---|---|---|---|---|---|---|
| kept | 2↓ 3↑ 1= (p=1.00) | 1↓ 4↑ 1= (p=0.38) | 2↓ 2↑ 2= (p=1.00) | 2↓ 3↑ 1= (p=1.00) | 1↓ 1↑ 4= (p=1.00) | 1↓ 1↑ 4= |

## Effort high

| arm | n | pass | score | wall s (med / mean) | ×wall | calls | ×calls | actions | ×actions | shots | ×shots | in tok | ×in | out tok | ×out | cost $ (med / mean) | ×cost | bad-tool calls/run | tool errors |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| before | 12 | 9 (75%) | 0.963 | 105 / 91 |  | 37 |  | 91 |  | 8.5 |  | 232k |  | 11.6k |  | 0.299 / 0.370 |  | 0.83 | 1.5 |
| kept | 12 | 12 (100%) | 1.000 (+0.037) | 104 / 91 | ×1.00 | 39 | ×1.05 | 93 | ×1.02 | 10.0 | ×1.18 | 313k | ×1.35 | 11.5k | ×0.99 | 0.309 / 0.353 | ×1.03 | 0.58 | 1.7 |

Geometric mean of the per-cell ratios (each task x effort cell's median over `before`'s), which a few long tasks can't dominate:

| arm | wall | cost | calls | actions | shots | in tok | out tok |
|---|---|---|---|---|---|---|---|
| kept | ×0.99 | ×0.98 | ×0.91 | ×0.97 | ×1.03 | ×0.95 | ×1.02 |

Task consistency against `before` (cells = task; "↓" = the arm's cell median is lower by more than 5%, score: lower at all; sign-test p on the cells that moved):

| arm | wall | cost | calls | actions | shots | score |
|---|---|---|---|---|---|---|
| kept | 1↓ 2↑ 3= (p=1.00) | 3↓ 2↑ 1= (p=1.00) | 2↓ 2↑ 2= (p=1.00) | 1↓ 3↑ 2= (p=0.63) | 1↓ 1↑ 4= (p=1.00) | 0↓ 3↑ 3= |

## Both efforts

| arm | n | pass | score | wall s (med / mean) | ×wall | calls | ×calls | actions | ×actions | shots | ×shots | in tok | ×in | out tok | ×out | cost $ (med / mean) | ×cost | bad-tool calls/run | tool errors |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| before | 24 | 19 (79%) | 0.954 | 95 / 83 |  | 37 |  | 70 |  | 5.5 |  | 151k |  | 10.0k |  | 0.285 / 0.319 |  | 0.63 | 1.1 |
| kept | 24 | 23 (96%) | 0.992 (+0.038) | 87 / 82 | ×0.91 | 25 | ×0.68 | 77 | ×1.11 | 8.0 | ×1.45 | 249k | ×1.65 | 11.2k | ×1.12 | 0.275 / 0.312 | ×0.97 | 0.54 | 1.7 |

Geometric mean of the per-cell ratios (each task x effort cell's median over `before`'s), which a few long tasks can't dominate:

| arm | wall | cost | calls | actions | shots | in tok | out tok |
|---|---|---|---|---|---|---|---|
| kept | ×1.01 | ×1.02 | ×0.97 | ×1.07 | ×1.07 | ×1.03 | ×1.04 |

Task consistency against `before` (cells = task x effort; "↓" = the arm's cell median is lower by more than 5%, score: lower at all; sign-test p on the cells that moved):

| arm | wall | cost | calls | actions | shots | score |
|---|---|---|---|---|---|---|
| kept | 3↓ 5↑ 4= (p=0.73) | 4↓ 6↑ 2= (p=0.75) | 4↓ 4↑ 4= (p=1.00) | 3↓ 6↑ 3= (p=0.51) | 2↓ 2↑ 8= (p=1.00) | 1↓ 4↑ 7= |

## Did each flag do what it should (read from the streams)

Per arm, over all efforts. "Bad-tool calls" are calls to tools the run wasn't offered.

| arm | runs | batch calls/run | batch share of calls | steps per batch | calls that share a message with another | find/read_page results with the batch hint | navigate results with a tab list | navigate results ending "parsed" | navigate "still loading" | navigate ms (first call of a message), median (n) | get_page_text calls/run | capped results | calls with offset | get_page_text kchars/run | screenshot-tool calls/run | bad-tool calls/run (names) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| before | 24 | 0.88 | 2% | 11.8 | 11.92 | 0 of 72 | 0 of 104 | 0 | 0 | 1491 (67) | 1.54 | 0 | 0 | 6.4 | 0.00 | 0.63 (screenshot_placeholder 4, zoom_placeholder 1, screenshot_placeholder2 1, scroll_placeholder 1, screenshot 6, left_click 1, left_click_placeholder 1) |
| kept | 24 | 1.17 | 2% | 15.1 | 11.46 | 0 of 87 | 0 of 114 | 0 | 0 | 502 (75) | 1.50 | 0 | 0 | 6.2 | 0.00 | 0.54 (screenshot 7, zoom 1, zoom_placeholder_skip 1, screenshot_placeholder 1, left_click_placeholder 1, key 1, left_click 1) |

## Per task: median wall s / calls / cost $ (both efforts pooled, 4 runs per cell) and passes

| task | before | kept |
|---|---|---|
| books-no-js | 128s / 96 / 0.69 (3/4) | 103s / 99 / 0.58 (4/4) |
| hockey-no-js | 40s / 14 / 0.17 (4/4) | 32s / 14 / 0.17 (3/4) |
| sudoku-no-js | 112s / 10 / 0.31 (4/4) | 115s / 7 / 0.27 (4/4) |
| tldraw-no-js | 68s / 70 / 0.23 (4/4) | 84s / 66 / 0.28 (4/4) |
| uitp-no-js | 119s / 96 / 0.46 (3/4) | 128s / 98 / 0.44 (4/4) |
| wc-tiebreak | 23s / 7 / 0.07 (1/4) | 24s / 8 / 0.09 (4/4) |

## Failed runs

| arm | effort | task | round | score | wall s | note |
|---|---|---|---|---|---|---|
| before | low | wc-tiebreak | 1 | 0.67 | 16 | group_order, bexley_third |
| before | high | books-no-js | 1 | 0.83 | 170 | averages |
| before | high | wc-tiebreak | 2 | 0.83 | 19 | pushed_out |
| before | low | wc-tiebreak | 2 | 0.67 | 28 | group_order, bexley_third |
| before | high | uitp-no-js | 2 | 0.89 | 123 | scroll_all_4 |
| kept | low | hockey-no-js | 2 | 0.80 | 33 | b_plus_60 |
