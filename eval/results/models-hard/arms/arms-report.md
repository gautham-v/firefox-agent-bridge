# Experiment arms, hard tier: Sonnet 5.5 at low and high effort

168 runs, 7 arms (none, fastNavigate, screenshotAlias, quietTabs, pageTextCap, fewerShots, batchHint), low and high effort, 6 tasks, rounds 1, 2. Total list-price spend $53.10. Generated 2026-09-30T15:25:15.418Z.

Ratios are of medians, arm over `none`. Actions count the steps inside `batch` calls (the batch call itself doesn't count). Shots are screenshots and zooms, inside batches too. Input tokens include cache reads and writes. Cost is the CLI's list-price `total_cost_usd`.

## Effort low

| arm | n | pass | score | wall s (med / mean) | ×wall | calls | ×calls | actions | ×actions | shots | ×shots | in tok | ×in | out tok | ×out | cost $ (med / mean) | ×cost | bad-tool calls/run | tool errors |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| none | 12 | 7 (58%) | 0.905 | 91 / 83 |  | 25 |  | 47 |  | 5.5 |  | 137k |  | 9.9k |  | 0.234 / 0.290 |  | 0.42 | 1.0 |
| fastNavigate | 12 | 9 (75%) | 0.949 (+0.044) | 72 / 63 | ×0.79 | 33 | ×1.35 | 36 | ×0.76 | 3.0 | ×0.55 | 109k | ×0.79 | 8.7k | ×0.88 | 0.213 / 0.300 | ×0.91 | 0.67 | 1.1 |
| screenshotAlias | 12 | 9 (75%) | 0.963 (+0.058) | 84 / 80 | ×0.92 | 37 | ×1.51 | 48 | ×1.02 | 4.5 | ×0.82 | 149k | ×1.08 | 10.3k | ×1.04 | 0.276 / 0.297 | ×1.18 | 0.83 | 1.6 |
| quietTabs | 12 | 11 (92%) | 0.985 (+0.080) | 70 / 73 | ×0.77 | 32 | ×1.31 | 32 | ×0.68 | 2.0 | ×0.36 | 140k | ×1.02 | 9.8k | ×0.99 | 0.228 / 0.323 | ×0.97 | 0.75 | 1.3 |
| pageTextCap | 12 | 10 (83%) | 0.958 (+0.054) | 88 / 79 | ×0.96 | 37 | ×1.49 | 43 | ×0.90 | 4.0 | ×0.73 | 181k | ×1.32 | 11.1k | ×1.13 | 0.227 / 0.293 | ×0.97 | 0.83 | 1.6 |
| fewerShots | 12 | 9 (75%) | 0.880 (-0.025) | 81 / 78 | ×0.89 | 29 | ×1.18 | 46 | ×0.98 | 4.0 | ×0.73 | 174k | ×1.26 | 9.7k | ×0.99 | 0.223 / 0.287 | ×0.95 | 0.83 | 1.4 |
| batchHint | 12 | 10 (83%) | 0.958 (+0.054) | 79 / 69 | ×0.87 | 21 | ×0.84 | 45 | ×0.96 | 5.5 | ×1.00 | 183k | ×1.33 | 8.8k | ×0.89 | 0.219 / 0.263 | ×0.94 | 0.33 | 1.0 |

Geometric mean of the per-cell ratios (each task x effort cell's median over `none`'s), which a few long tasks can't dominate:

| arm | wall | cost | calls | actions | shots | in tok | out tok |
|---|---|---|---|---|---|---|---|
| fastNavigate | ×0.77 | ×0.96 | ×0.85 | ×0.80 | ×0.78 | ×0.89 | ×0.87 |
| screenshotAlias | ×0.92 | ×1.00 | ×0.92 | ×0.84 | ×0.88 | ×0.93 | ×0.96 |
| quietTabs | ×0.91 | ×1.05 | ×0.93 | ×0.82 | ×0.78 | ×1.00 | ×0.95 |
| pageTextCap | ×0.97 | ×1.02 | ×1.05 | ×0.94 | ×0.84 | ×1.02 | ×0.99 |
| fewerShots | ×0.95 | ×1.00 | ×0.97 | ×0.96 | ×0.76 | ×1.05 | ×0.96 |
| batchHint | ×0.83 | ×0.93 | ×0.83 | ×0.78 | ×0.82 | ×0.89 | ×0.88 |

Task consistency against `none` (cells = task; "↓" = the arm's cell median is lower by more than 5%, score: lower at all; sign-test p on the cells that moved):

| arm | wall | cost | calls | actions | shots | score |
|---|---|---|---|---|---|---|
| fastNavigate | 6↓ 0↑ 0= (p=0.03) | 4↓ 1↑ 1= (p=0.38) | 5↓ 1↑ 0= (p=0.22) | 6↓ 0↑ 0= (p=0.03) | 3↓ 0↑ 3= (p=0.25) | 0↓ 2↑ 4= |
| screenshotAlias | 4↓ 2↑ 0= (p=0.69) | 3↓ 3↑ 0= (p=1.00) | 3↓ 1↑ 2= (p=0.63) | 3↓ 1↑ 2= (p=0.63) | 1↓ 2↑ 3= (p=1.00) | 1↓ 4↑ 1= |
| quietTabs | 4↓ 0↑ 2= (p=0.13) | 3↓ 2↑ 1= (p=1.00) | 4↓ 1↑ 1= (p=0.38) | 5↓ 1↑ 0= (p=0.22) | 2↓ 1↑ 3= (p=1.00) | 1↓ 4↑ 1= |
| pageTextCap | 3↓ 1↑ 2= (p=0.63) | 0↓ 2↑ 4= (p=0.50) | 1↓ 2↑ 3= (p=1.00) | 2↓ 0↑ 4= (p=0.50) | 1↓ 0↑ 5= (p=1.00) | 0↓ 3↑ 3= |
| fewerShots | 2↓ 2↑ 2= (p=1.00) | 2↓ 2↑ 2= (p=1.00) | 2↓ 3↑ 1= (p=1.00) | 3↓ 2↑ 1= (p=1.00) | 3↓ 1↑ 2= (p=0.63) | 2↓ 3↑ 1= |
| batchHint | 4↓ 1↑ 1= (p=0.38) | 3↓ 2↑ 1= (p=1.00) | 3↓ 0↑ 3= (p=0.25) | 3↓ 1↑ 2= (p=0.63) | 2↓ 1↑ 3= (p=1.00) | 0↓ 4↑ 2= |

## Effort high

| arm | n | pass | score | wall s (med / mean) | ×wall | calls | ×calls | actions | ×actions | shots | ×shots | in tok | ×in | out tok | ×out | cost $ (med / mean) | ×cost | bad-tool calls/run | tool errors |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| none | 12 | 11 (92%) | 0.986 | 77 / 79 |  | 35 |  | 48 |  | 6.0 |  | 221k |  | 10.5k |  | 0.268 / 0.327 |  | 0.50 | 1.5 |
| fastNavigate | 12 | 11 (92%) | 0.986 (+0.000) | 84 / 84 | ×1.10 | 35 | ×1.00 | 42 | ×0.88 | 7.0 | ×1.17 | 208k | ×0.94 | 10.0k | ×0.95 | 0.267 / 0.338 | ×1.00 | 0.67 | 1.2 |
| screenshotAlias | 12 | 12 (100%) | 1.000 (+0.014) | 81 / 74 | ×1.05 | 35 | ×1.00 | 35 | ×0.73 | 4.5 | ×0.75 | 197k | ×0.89 | 9.3k | ×0.89 | 0.261 / 0.338 | ×0.98 | 0.58 | 1.1 |
| quietTabs | 12 | 9 (75%) | 0.963 (-0.023) | 93 / 88 | ×1.21 | 25 | ×0.70 | 91 | ×1.90 | 9.0 | ×1.50 | 280k | ×1.27 | 11.2k | ×1.07 | 0.305 / 0.340 | ×1.14 | 0.58 | 1.4 |
| pageTextCap | 12 | 12 (100%) | 1.000 (+0.014) | 102 / 86 | ×1.33 | 43 | ×1.21 | 54 | ×1.13 | 7.5 | ×1.25 | 236k | ×1.07 | 11.4k | ×1.08 | 0.299 / 0.336 | ×1.12 | 0.83 | 1.3 |
| fewerShots | 12 | 10 (83%) | 0.969 (-0.017) | 88 / 82 | ×1.14 | 32 | ×0.91 | 68 | ×1.42 | 4.0 | ×0.67 | 312k | ×1.41 | 10.6k | ×1.01 | 0.280 / 0.359 | ×1.04 | 0.92 | 1.4 |
| batchHint | 12 | 11 (92%) | 0.972 (-0.014) | 81 / 88 | ×1.06 | 34 | ×0.97 | 88 | ×1.82 | 10.5 | ×1.75 | 310k | ×1.40 | 10.5k | ×1.00 | 0.258 / 0.335 | ×0.96 | 0.67 | 1.3 |

Geometric mean of the per-cell ratios (each task x effort cell's median over `none`'s), which a few long tasks can't dominate:

| arm | wall | cost | calls | actions | shots | in tok | out tok |
|---|---|---|---|---|---|---|---|
| fastNavigate | ×1.05 | ×1.05 | ×1.07 | ×1.05 | ×1.35 | ×1.18 | ×1.04 |
| screenshotAlias | ×0.97 | ×1.02 | ×1.21 | ×1.11 | ×1.28 | ×1.08 | ×0.95 |
| quietTabs | ×1.12 | ×1.07 | ×1.19 | ×1.81 | ×1.50 | ×1.20 | ×1.09 |
| pageTextCap | ×1.10 | ×1.05 | ×1.07 | ×1.06 | ×1.27 | ×1.05 | ×1.05 |
| fewerShots | ×1.07 | ×1.09 | ×1.25 | ×1.59 | ×1.28 | ×1.32 | ×1.02 |
| batchHint | ×1.11 | ×1.05 | ×1.26 | ×1.63 | ×1.65 | ×1.28 | ×1.02 |

Task consistency against `none` (cells = task; "↓" = the arm's cell median is lower by more than 5%, score: lower at all; sign-test p on the cells that moved):

| arm | wall | cost | calls | actions | shots | score |
|---|---|---|---|---|---|---|
| fastNavigate | 3↓ 3↑ 0= (p=1.00) | 2↓ 2↑ 2= (p=1.00) | 3↓ 2↑ 1= (p=1.00) | 2↓ 1↑ 3= (p=1.00) | 0↓ 3↑ 3= (p=0.25) | 0↓ 0↑ 6= |
| screenshotAlias | 2↓ 2↑ 2= (p=1.00) | 2↓ 3↑ 1= (p=1.00) | 2↓ 3↑ 1= (p=1.00) | 3↓ 2↑ 1= (p=1.00) | 1↓ 2↑ 3= (p=1.00) | 0↓ 1↑ 5= |
| quietTabs | 1↓ 5↑ 0= (p=0.22) | 1↓ 4↑ 1= (p=0.38) | 2↓ 3↑ 1= (p=1.00) | 1↓ 4↑ 1= (p=0.38) | 0↓ 4↑ 2= (p=0.13) | 2↓ 0↑ 4= |
| pageTextCap | 2↓ 3↑ 1= (p=1.00) | 1↓ 3↑ 2= (p=0.63) | 1↓ 4↑ 1= (p=0.38) | 1↓ 3↑ 2= (p=0.63) | 0↓ 3↑ 3= (p=0.25) | 0↓ 1↑ 5= |
| fewerShots | 2↓ 3↑ 1= (p=1.00) | 1↓ 3↑ 2= (p=0.63) | 2↓ 3↑ 1= (p=1.00) | 3↓ 2↑ 1= (p=1.00) | 1↓ 3↑ 2= (p=0.63) | 1↓ 0↑ 5= |
| batchHint | 1↓ 5↑ 0= (p=0.22) | 2↓ 2↑ 2= (p=1.00) | 3↓ 3↑ 0= (p=1.00) | 3↓ 3↑ 0= (p=1.00) | 0↓ 4↑ 2= (p=0.13) | 1↓ 1↑ 4= |

## Both efforts

| arm | n | pass | score | wall s (med / mean) | ×wall | calls | ×calls | actions | ×actions | shots | ×shots | in tok | ×in | out tok | ×out | cost $ (med / mean) | ×cost | bad-tool calls/run | tool errors |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| none | 24 | 18 (75%) | 0.945 | 84 / 81 |  | 25 |  | 47 |  | 5.5 |  | 138k |  | 10.1k |  | 0.240 / 0.309 |  | 0.46 | 1.3 |
| fastNavigate | 24 | 20 (83%) | 0.968 (+0.022) | 75 / 74 | ×0.90 | 35 | ×1.43 | 36 | ×0.76 | 3.5 | ×0.64 | 175k | ×1.27 | 9.6k | ×0.95 | 0.244 / 0.319 | ×1.01 | 0.67 | 1.1 |
| screenshotAlias | 24 | 21 (88%) | 0.981 (+0.036) | 81 / 77 | ×0.96 | 35 | ×1.43 | 35 | ×0.74 | 4.5 | ×0.82 | 159k | ×1.15 | 9.6k | ×0.95 | 0.271 / 0.318 | ×1.13 | 0.71 | 1.3 |
| quietTabs | 24 | 20 (83%) | 0.974 (+0.029) | 79 / 80 | ×0.94 | 25 | ×1.00 | 66 | ×1.40 | 3.5 | ×0.64 | 187k | ×1.36 | 10.4k | ×1.03 | 0.272 / 0.332 | ×1.13 | 0.67 | 1.4 |
| pageTextCap | 24 | 22 (92%) | 0.979 (+0.034) | 91 / 82 | ×1.08 | 37 | ×1.49 | 43 | ×0.90 | 4.5 | ×0.82 | 181k | ×1.31 | 11.1k | ×1.10 | 0.269 / 0.314 | ×1.12 | 0.83 | 1.4 |
| fewerShots | 24 | 19 (79%) | 0.925 (-0.021) | 87 / 80 | ×1.04 | 30 | ×1.20 | 64 | ×1.35 | 4.0 | ×0.73 | 227k | ×1.65 | 9.9k | ×0.99 | 0.254 / 0.323 | ×1.06 | 0.88 | 1.4 |
| batchHint | 24 | 21 (88%) | 0.965 (+0.020) | 79 / 78 | ×0.94 | 29 | ×1.16 | 83 | ×1.76 | 9.5 | ×1.73 | 280k | ×2.03 | 9.4k | ×0.93 | 0.251 / 0.299 | ×1.04 | 0.50 | 1.2 |

Geometric mean of the per-cell ratios (each task x effort cell's median over `none`'s), which a few long tasks can't dominate:

| arm | wall | cost | calls | actions | shots | in tok | out tok |
|---|---|---|---|---|---|---|---|
| fastNavigate | ×0.90 | ×1.00 | ×0.95 | ×0.92 | ×1.02 | ×1.03 | ×0.95 |
| screenshotAlias | ×0.94 | ×1.01 | ×1.05 | ×0.97 | ×1.06 | ×1.00 | ×0.95 |
| quietTabs | ×1.01 | ×1.06 | ×1.05 | ×1.22 | ×1.08 | ×1.10 | ×1.02 |
| pageTextCap | ×1.03 | ×1.03 | ×1.06 | ×1.00 | ×1.04 | ×1.04 | ×1.02 |
| fewerShots | ×1.01 | ×1.04 | ×1.10 | ×1.23 | ×0.99 | ×1.18 | ×0.99 |
| batchHint | ×0.96 | ×0.98 | ×1.02 | ×1.13 | ×1.16 | ×1.07 | ×0.95 |

Task consistency against `none` (cells = task x effort; "↓" = the arm's cell median is lower by more than 5%, score: lower at all; sign-test p on the cells that moved):

| arm | wall | cost | calls | actions | shots | score |
|---|---|---|---|---|---|---|
| fastNavigate | 9↓ 3↑ 0= (p=0.15) | 6↓ 3↑ 3= (p=0.51) | 8↓ 3↑ 1= (p=0.23) | 8↓ 1↑ 3= (p=0.04) | 3↓ 3↑ 6= (p=1.00) | 0↓ 2↑ 10= |
| screenshotAlias | 6↓ 4↑ 2= (p=0.75) | 5↓ 6↑ 1= (p=1.00) | 5↓ 4↑ 3= (p=1.00) | 6↓ 3↑ 3= (p=0.51) | 2↓ 4↑ 6= (p=0.69) | 1↓ 5↑ 6= |
| quietTabs | 5↓ 5↑ 2= (p=1.00) | 4↓ 6↑ 2= (p=0.75) | 6↓ 4↑ 2= (p=0.75) | 6↓ 5↑ 1= (p=1.00) | 2↓ 5↑ 5= (p=0.45) | 3↓ 4↑ 5= |
| pageTextCap | 5↓ 4↑ 3= (p=1.00) | 1↓ 5↑ 6= (p=0.22) | 2↓ 6↑ 4= (p=0.29) | 3↓ 3↑ 6= (p=1.00) | 1↓ 3↑ 8= (p=0.63) | 0↓ 4↑ 8= |
| fewerShots | 4↓ 5↑ 3= (p=1.00) | 3↓ 5↑ 4= (p=0.73) | 4↓ 6↑ 2= (p=0.75) | 6↓ 4↑ 2= (p=0.75) | 4↓ 4↑ 4= (p=1.00) | 3↓ 3↑ 6= |
| batchHint | 5↓ 6↑ 1= (p=1.00) | 5↓ 4↑ 3= (p=1.00) | 6↓ 3↑ 3= (p=0.51) | 6↓ 4↑ 2= (p=0.75) | 2↓ 5↑ 5= (p=0.45) | 1↓ 5↑ 6= |

## Did each flag do what it should (read from the streams)

Per arm, over all efforts. "Bad-tool calls" are calls to tools the run wasn't offered.

| arm | runs | batch calls/run | batch share of calls | steps per batch | calls that share a message with another | find/read_page results with the batch hint | navigate results with a tab list | navigate results ending "parsed" | navigate "still loading" | navigate ms (first call of a message), median (n) | get_page_text calls/run | capped results | calls with offset | get_page_text kchars/run | screenshot-tool calls/run | bad-tool calls/run (names) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| none | 24 | 1.50 | 3% | 7.0 | 10.33 | 0 of 91 | 0 of 101 | 0 | 0 | 1496 (65) | 2.13 | 0 | 0 | 6.3 | 0.00 | 0.46 (screenshot 8, left_click_placeholder 1, zoom 2) |
| fastNavigate | 24 | 0.25 | 1% | 13.2 | 11.21 | 0 of 71 | 0 of 107 | 0 | 0 | 523 (76) | 1.25 | 0 | 0 | 18.8 | 0.00 | 0.67 (screenshot 10, key 2, zoom 1, left_click 1, hover 1, zoom_placeholder 1) |
| screenshotAlias | 24 | 0.38 | 1% | 14.0 | 12.29 | 0 of 66 | 0 of 107 | 0 | 0 | 1499 (73) | 2.00 | 0 | 0 | 21.0 | 10.25 | 0.71 (type 1, key 5, zoom 2, triple_click_placeholder 1, left_click_placeholder 3, scroll 2, scroll_placeholder 2, triple_click 1) |
| quietTabs | 24 | 1.04 | 2% | 15.9 | 11.25 | 0 of 79 | 0 of 115 | 0 | 0 | 1497 (76) | 2.04 | 0 | 0 | 20.9 | 0.00 | 0.67 (screenshot_placeholder 2, left_click_placeholder 1, triple_click_placeholder 1, screenshot_none 1, screenshot 9, zoom 1, left_click 1) |
| pageTextCap | 24 | 0.83 | 2% | 10.3 | 11.25 | 0 of 86 | 0 of 112 | 0 | 0 | 1503 (75) | 1.79 | 4 | 6 | 6.4 | 0.00 | 0.83 (key 2, screenshot 11, scroll 2, left_click 2, type 1, zoom 1, hover 1) |
| fewerShots | 24 | 0.75 | 2% | 15.8 | 11.79 | 0 of 75 | 0 of 113 | 0 | 0 | 1499 (80) | 2.42 | 0 | 0 | 20.5 | 0.00 | 0.88 (type 3, screenshot 12, screenshot_placeholder 1, screenshot_dummy 1, left_click_placeholder 1, left_click 1, zoom 1, scroll 1) |
| batchHint | 24 | 0.88 | 2% | 16.4 | 10.88 | 68 of 68 | 0 of 113 | 0 | 0 | 1495 (80) | 1.54 | 0 | 0 | 6.5 | 0.00 | 0.50 (screenshot 8, type_placeholder 1, scroll 1, hover 1, key 1) |

## Per task: median wall s / calls / cost $ (both efforts pooled, 4 runs per cell) and passes

| task | none | fastNavigate | screenshotAlias | quietTabs | pageTextCap | fewerShots | batchHint |
|---|---|---|---|---|---|---|---|
| books-no-js | 109s / 99 / 0.61 (1/4) | 110s / 101 / 0.72 (3/4) | 118s / 97 / 0.62 (3/4) | 133s / 104 / 0.72 (2/4) | 101s / 99 / 0.60 (4/4) | 126s / 106 / 0.72 (3/4) | 120s / 102 / 0.58 (3/4) |
| hockey-no-js | 40s / 9 / 0.17 (3/4) | 31s / 4 / 0.15 (4/4) | 40s / 14 / 0.17 (4/4) | 43s / 14 / 0.17 (4/4) | 44s / 14 / 0.18 (4/4) | 45s / 14 / 0.18 (3/4) | 38s / 10 / 0.17 (4/4) |
| sudoku-no-js | 99s / 6 / 0.23 (4/4) | 95s / 7 / 0.23 (4/4) | 115s / 6 / 0.28 (3/4) | 107s / 6 / 0.25 (4/4) | 105s / 6 / 0.25 (4/4) | 106s / 9 / 0.25 (3/4) | 94s / 6 / 0.23 (4/4) |
| tldraw-no-js | 71s / 68 / 0.26 (4/4) | 67s / 71 / 0.26 (4/4) | 70s / 75 / 0.24 (4/4) | 79s / 85 / 0.30 (3/4) | 87s / 71 / 0.29 (4/4) | 75s / 83 / 0.26 (4/4) | 64s / 64 / 0.25 (4/4) |
| uitp-no-js | 129s / 103 / 0.50 (3/4) | 90s / 91 / 0.42 (3/4) | 105s / 102 / 0.45 (4/4) | 111s / 98 / 0.44 (3/4) | 119s / 102 / 0.49 (4/4) | 95s / 93 / 0.43 (4/4) | 89s / 91 / 0.40 (4/4) |
| wc-tiebreak | 26s / 8 / 0.08 (3/4) | 22s / 8 / 0.08 (2/4) | 22s / 7 / 0.07 (3/4) | 27s / 7 / 0.08 (4/4) | 25s / 7 / 0.08 (2/4) | 25s / 8 / 0.09 (2/4) | 25s / 8 / 0.08 (2/4) |

## Failed runs

| arm | effort | task | round | score | wall s | note |
|---|---|---|---|---|---|---|
| none | high | books-no-js | 1 | 0.83 | 146 | averages |
| none | low | books-no-js | 1 | 0.83 | 112 | averages |
| none | low | wc-tiebreak | 2 | 0.50 | 27 | group_order, bexley_third, fair_play_scores |
| none | low | uitp-no-js | 2 | 0.89 | 202 | scroll_all_4 |
| none | low | hockey-no-js | 2 | 0.80 | 40 | c_years |
| none | low | books-no-js | 2 | 0.83 | 96 | averages |
| fastNavigate | low | wc-tiebreak | 1 | 0.83 | 19 | fair_play_scores |
| fastNavigate | low | uitp-no-js | 1 | 0.89 | 75 | scroll_all_4 |
| fastNavigate | high | books-no-js | 2 | 0.83 | 181 | averages |
| fastNavigate | low | wc-tiebreak | 2 | 0.67 | 21 | group_order, bexley_third |
| screenshotAlias | low | sudoku-no-js | 1 | 0.89 | 117 | row_3 |
| screenshotAlias | low | wc-tiebreak | 2 | 0.83 | 22 | pushed_out |
| screenshotAlias | low | books-no-js | 2 | 0.83 | 144 | averages |
| quietTabs | high | books-no-js | 1 | 0.83 | 147 | averages |
| quietTabs | high | books-no-js | 2 | 0.83 | 153 | averages |
| quietTabs | low | tldraw-no-js | 2 | 0.82 | 91 | arrow_labels, nothing_else |
| quietTabs | high | uitp-no-js | 2 | 0.89 | 116 | scroll_all_4 |
| pageTextCap | low | wc-tiebreak | 1 | 0.83 | 24 | fair_play_scores |
| pageTextCap | low | wc-tiebreak | 2 | 0.67 | 25 | group_order, bexley_third |
| fewerShots | low | sudoku-no-js | 1 | 0.89 | 104 | row_5 |
| fewerShots | low | wc-tiebreak | 1 | 0.67 | 29 | group_order, bexley_third |
| fewerShots | high | hockey-no-js | 1 | 0.80 | 51 | c_years |
| fewerShots | high | books-no-js | 2 | 0.83 | 124 | averages |
| fewerShots | low | wc-tiebreak | 2 | 0.00 | 22 | group_order, bexley_third, corwen_above_arden, fair_play_scores, pellham_position, pushed_out |
| batchHint | high | wc-tiebreak | 1 | 0.67 | 29 | group_order, bexley_third |
| batchHint | low | books-no-js | 2 | 0.83 | 126 | averages |
| batchHint | low | wc-tiebreak | 2 | 0.67 | 21 | group_order, bexley_third |
