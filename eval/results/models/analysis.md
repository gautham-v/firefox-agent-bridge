# Model x effort benchmark: analysis

180 runs: 10 configs, 6 tasks, 3 rounds. No timeouts, infra errors or rate limits. Cost is the CLI's list-price `total_cost_usd`, not what the subscription bills.

## Headline
- **Score is at ceiling.** Sonnet 5.5, Opus 5.5 and Fable 5.1 passed all 18 runs at every effort level (162 of 162). Only Haiku 4.5 failed any runs: 10 of 18 passes, mean score 0.86. Effort bought no score for any model, so every difference below is cost, time or behavior.
- **Score vs cost:** Sonnet low is the only point on the frontier, at $0.114 per run. Opus low costs 1.6x that at the same effort and Fable low costs 4.1x. Both ratios hold on 6 of 6 tasks.
- **Score vs time:** the top configs are close to a tie.
  - Sonnet low and medium, Opus low, and Fable at all three levels have median wall times of 34–38s.
  - Runs in the same cell vary by a median of 1.48x, which is larger than the gaps between these configs.
  - By pooled median time the frontier point is Sonnet medium (34.1s). By task-normalized time it is Fable low (index 0.79 against 0.89 for Sonnet low), but Fable low is faster on only 4 of 6 tasks.
  - Fable reaches its first tool call sooner every time: 1.5s, against 2.2s for Sonnet and 2.6s for Opus.
- **Haiku 4.5 is dominated.** It scores lower and costs 3.0x Sonnet low ($0.337 per run). It is also 4x slower (144s median) and uses 12x the tokens (1.9M per run, mostly cache reads over about 49 turns).

## Recommendations
| use | config | why |
|---|---|---|
| Sidebar chat default | **Sonnet 5.5 medium** | Same score and median time as low (time index 0.88 vs 0.89) for 7% more mean cost. A cheap hedge for real tasks harder than this suite. |
| Quick tasks | **Sonnet 5.5 low** | Cheapest, and as fast as anything else. It batches input: all 7 TodoMVC items went in one `type` call in 3 of 3 runs. |
| Fan-out sub-agents | **Sonnet 5.5 low** | Cost per successful task is $0.114, against $0.165 for Opus low, $0.408 for Fable low and $0.607 for Haiku. |
| Avoid | Haiku, and any model at high | Haiku fails canvas and dynamic-page work and still reports success. High effort adds cost and steps and buys no score. |

- **Fable low** is only worth it if first-token latency matters more than 4x the cost.
- **Opus** has no role on this suite. It is never faster than Sonnet at the same effort and costs 1.6–1.8x.

## Diminishing returns
Each cell is the geometric mean of the per-task ratios, with the number of tasks (of 6) where the median went up in brackets. Score change is 0.00 for every step.

| model | step | cost | wall | output tokens | tool calls | screenshots |
|---|---|---|---|---|---|---|
| Sonnet | low→medium | x1.14 (4/6) | x0.99 (3/6) | x1.13 (5/6) | x1.09 (3/6) | x1.20 (2/6) |
| Sonnet | medium→high | x1.07 (4/6) | **x1.23 (5/6)** | x1.10 (4/6) | x1.09 (3/6) | x1.33 (2/6) |
| Opus | low→medium | **x1.21 (6/6)** | **x1.25 (6/6)** | **x1.33 (6/6)** | x1.28 (5/6) | x1.78 (3/6) |
| Opus | medium→high | x1.13 (4/6) | x1.09 (4/6) | x1.09 (4/6) | x1.02 (2/6) | x1.07 (1/6) |
| Fable | low→medium | x1.11 (3/6) | x1.08 (4/6) | x1.20 (5/6) | x1.29 (4/6) | x1.21 (3/6) |
| Fable | medium→high | **x1.15 (6/6)** | x1.05 (2/6) | x1.08 (5/6) | x1.04 (4/6) | x1.92 (4/6) |

- **Low to high, the effects that hold:**
  - Output tokens rise x1.23 for Sonnet, x1.45 for Opus and x1.29 for Fable, on 17 of 18 model-task pairs.
  - Cost rises x1.22, x1.37 and x1.28, on 17 of 18.
  - Opus is the most effort-sensitive: from low to medium, cost, time and output tokens rise on 6 of 6 tasks and tool calls on 5 of 6.
- **Same effort, across models:**
  - Opus costs x1.61, x1.71 and x1.80 of Sonnet at low, medium and high. Its wall time is x1.01, x1.27 and x1.13 of Sonnet's.
  - Fable costs x4.1, x4.0 and x4.3 of Sonnet. Its wall time is x0.89 at low, x0.97 at medium and x0.82 at high.
- **Where returns start to diminish:** this suite can't show it, because low effort already gets full marks.

## Per-task failures (all Haiku)
| task | score | pass | failure mode |
|---|---|---|---|
| internet-gauntlet | 0.59 | 0/3 | Claimed steps it hadn't done (3 of 3 runs) |
| tldraw-diagram | 0.71 | 0/3 | Left an arrow unbound and reported it bound (3 of 3 runs) |
| research-synth | 0.93 | 2/3 | Computed from a mis-rounded input |
| books-paginated | 0.94 | 2/3 | Picked the wrong item |
| form-demoqa, todomvc-flow | 1.00 | 3/3 | – |

- **internet-gauntlet:**
  - Infinite scroll stopped at 2, 9 and 9 paragraphs. Haiku still reported a "10th paragraph" twice.
  - It misread the canvas number twice (1557 for 15571, 1525.9 for 15259).
  - In the iframe form it typed without clearing the fields, leaving "JohnAda DoeLovelace", and marked the step done. In one run it closed that tab, which it was told to leave open.
- **tldraw-diagram:** the green→ellipse arrow was never bound in any run. Round 1 also left other arrows half-bound and overlapped two rectangles, and round 2 used light-red. Every final message claims the arrows are bound.
- **research-synth:** density came out as 3.01 instead of 2.999, so the final was 627.13 against 626.62, outside the ±0.5 tolerance.
- **books-paginated:** wrong cheapest Mystery title ("Hide Away" instead of "Tastes Like Fear").

Across all 8 failed runs:
- Every one ended with a confident success message. None gave up.
- There were no timeouts and no loops. Repeated calls were about the same in every config (11–14 per 18 runs).
- The cause was wrong-element or partial actions that were never checked against the page, not running out of steps.

## Tool use
| config | tool calls (median) | screenshots (median) | tool errors per 18 runs | calls to nonexistent tools |
|---|---|---|---|---|
| Haiku default | 48 | 11 | 16 | 9 |
| Sonnet low / medium / high | 23 / 29.5 / 37 | 3 / 4 / 6 | 14 / 13 / 13 | 10 / 9 / 10 |
| Opus low / medium / high | 24.5 / 35 / 37.5 | 1.5 / 3 / 2.5 | 8 / 3 / 3 | 7 / 3 / 3 |
| Fable low / medium / high | 23.5 / 30.5 / 36 | 0 / 1 / 3 | 0 / 0 / 0 | 0 / 0 / 0 |

- **Higher effort adds steps; it doesn't cut wasted ones.** Tool calls from low to high rise x1.19 for Sonnet, x1.30 for Opus and x1.36 for Fable, each on 5 of 6 tasks.
  - TodoMVC shows why. At low effort, 7 of 9 runs typed all 7 items in one newline-joined `type` call (about 20 calls in total). At high effort, 0 of 9 did; they typed each item and pressed Enter separately (36–38 calls).
  - High effort also takes more checking screenshots. Fable goes from 0 to 3.
- **Most wasted steps are calls to tools that don't exist:** `mcp__firefox__screenshot` and `mcp__firefox__left_click`.
  - Sonnet does this about 10 times per 18 runs at every effort. Opus drops from 7 to 3 at medium. Fable never does.
  - Retries after an error are 0–1 per config, except Haiku at 7.
  - This is a fix in the extension, not a model choice. Aliasing those two names, or pointing the error at `computer`, saves a turn each time.
- **Tokens are mostly cache reads.**
  - The top configs use 120k–200k tokens per run, of which only 3–4k are output.
  - Haiku reads 1.84M cache tokens per run. That is why it costs more than Sonnet despite its lower per-token price.

## Confounds
- **Only 3 runs per cell.** A difference is called consistent above only if it holds on at least 5 of 6 tasks. Most cost ratios qualify. Most time differences between the top configs don't.
- **Load:** 14 runs, all in round 1, overlapped another eval.
  - 7 of those 14 were Fable runs, and the overlapped runs took 1.65x their cell median. Fable's speed edge is, if anything, understated.
  - Rounds 2 and 3 had no outside load. Median times are robust to this; mean times are not.
- **Ceiling:** 162 of 162 top-model runs passed. The suite can't rank Sonnet, Opus and Fable on quality or show what high effort buys. That needs a harder tier: longer tasks, ambiguous instructions, or recovering from errors.
- **Haiku runs without `--effort`,** because the CLI reports `per_turn_effort_active: false`.
- **Cost is list price.** On the subscription, what matters is usage-limit burn, which roughly follows these cost ratios.

## charts.json
Seven series, each keyed by config:
1. `score_vs_cost`, with its frontier: Sonnet low.
2. `score_vs_time`, with its frontier: Sonnet medium by pooled median time, Fable low by the task-normalized time index.
3. `effort_curves`: per model, with Haiku's default run as a reference point.
4. `heatmap_task_config_mean_score`, with pass counts.
5. `tool_use_per_config`.
6. `token_breakdown_per_config`: mean and median of input, cache write, cache read and output.
7. `cost_per_successful_task`.
