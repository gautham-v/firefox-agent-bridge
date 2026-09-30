## Arms against before (Firefox, 16 tasks x 1 run each)

Source: `eval/results/browsers-confirm.jsonl`. 32 runs, 2 arms, 16 tasks, arms interleaved within each task and run. Cost is list price from the result event.

### Per arm

| arm | pass | wall s median / mean | tool calls median / mean | actions mean | screenshot actions mean | input tokens median / mean | output tokens median / mean | cost median / mean | total cost | not-offered tool calls |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| before | 15/16 | 15.0 / 15.1 | 6 / 6.9 | 7.4 | 0.38 | 55.2k / 60.0k | 1.0k / 1.1k | 0.052 / 0.053 | 0.85 | 0 |
| kept | 16/16 | 12.9 / 13.7 | 6 / 7.6 | 8.6 | 0.44 | 60.3k / 64.9k | 1.0k / 1.1k | 0.054 / 0.056 | 0.89 | 1 |

### Each arm against before, by task

Ratios are arm / before. "Geomean" is the geometric mean of the per-task median ratios (each task counts once). "Up / down" counts tasks whose median moved by more than 10% in that direction, out of 16; "p" is a two-sided sign test on those. With 1 run a task's median is that run, so single-run luck decides it.

**wall s**

| arm | ratio of means | geomean of task ratios | tasks up / same / down | p |
| --- | --- | --- | --- | --- |
| kept | 0.91 | 0.88 | 2 / 5 / 9 | 0.07 |

**tool calls**

| arm | ratio of means | geomean of task ratios | tasks up / same / down | p |
| --- | --- | --- | --- | --- |
| kept | 1.11 | 1.09 | 4 / 9 / 3 | 1.00 |

**actions (batch contents counted)**

| arm | ratio of means | geomean of task ratios | tasks up / same / down | p |
| --- | --- | --- | --- | --- |
| kept | 1.17 | 1.11 | 5 / 9 / 2 | 0.45 |

**screenshot/zoom actions**

| arm | ratio of means | geomean of task ratios | tasks up / same / down | p |
| --- | --- | --- | --- | --- |
| kept | 1.17 | – | 0 / 16 / 0 | 1.00 |

**input tokens (incl. cache)**

| arm | ratio of means | geomean of task ratios | tasks up / same / down | p |
| --- | --- | --- | --- | --- |
| kept | 1.08 | 1.07 | 6 / 8 / 2 | 0.29 |

**output tokens**

| arm | ratio of means | geomean of task ratios | tasks up / same / down | p |
| --- | --- | --- | --- | --- |
| kept | 1.05 | 1.02 | 3 / 9 / 4 | 1.00 |

**cost USD**

| arm | ratio of means | geomean of task ratios | tasks up / same / down | p |
| --- | --- | --- | --- | --- |
| kept | 1.05 | 1.05 | 4 / 12 / 0 | 0.13 |

### Did each change do what it should

**navigate** (navigate time; get_page_text and find issued in the same message wait for it; the fastNavigate flag, now the default)

| arm | navigate ms median / mean | navigate calls | get_page_text ms median | results with the "returned once the page was parsed" note |
| --- | --- | --- | --- | --- |
| before | 1903 / 1945 | 17 | 1581 | 0 |
| kept | 597 / 768 | 23 | 204 | 1 |

### Failures

- gen-httpbin-form.baseline.firefox.1.before.2026-09-30T15-47-24-881Z: wrong answer
