# Model x effort benchmark: analysis

180 runs: 10 configs, 6 tasks, 3 rounds. No timeouts, infra errors or rate limits. Cost is the CLI's list-price `total_cost_usd`, not what the subscription bills. Per-config tables are in [report.md](report.md); chart series are in [charts.json](charts.json).

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
See the effort tables in [report.md](report.md).
