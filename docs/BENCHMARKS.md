# Benchmark methodology

## Included executed evidence

`reports/benchmark/` contains an executed **12-game local smoke run**: six seeded random-opponent pairs, each seed played with both starting seats on a 4×4-box board. The measured system was the **local Normal search policy**, not a live JEV model. Each game includes its complete journal and was independently replay-audited by the harness.

Read `summary.json`, `games.csv`, `pairs.csv` and the full per-game JSON files. These files are measurements from the packaging run, not demonstration values. Timings are specific to that runtime. The very weak random baseline makes favorable scores unsurprising and does not establish strength against skilled humans or chain-aware opponents.

## Commands

```sh
npm run benchmark -- --pairs 6 --mode local --opponent random --difficulty normal --seed 20260922 --out bench-output
npm run benchmark -- --pairs 20 --mode jev --opponent heuristic --difficulty normal --out live-jev-baseline
npm run benchmark -- --pairs 10 --mode jev --opponent jev --difficulty normal --out live-self-play
```

Set `TYPESAFE_API_KEY` in `.env` or the environment for live mode. Live evaluation incurs provider usage and requires explicit mode/opponent selection. A failure stops the live experiment rather than silently turning it into a local cohort.

Accepted opponent policies: seeded `random`, capture-first `greedy`, safe-edge `heuristic`, bounded `search`, and `jev`. Mode `local` uses the shared profile analysis and deterministic selection. Mode `jev` uses the same adapter as the hosted game. The opponent called “human” in the shared rules state is the benchmark baseline; that slot is not evidence of a real human participant.

## Pairing and estimates

Every pair uses the same seed and two starting seats. Store both games; summarize the pair before bootstrap resampling so seat partners are not treated as independent. The harness records pair-level bootstrap uncertainty using a deterministic 2,000-resample procedure. A small homogeneous smoke sample can produce a degenerate interval; that is not proof of universal success.

Deterministic policies from the empty board can repeatedly generate the same trajectory. Increasing a requested game count does not create independent evidence. Random-opponent seeds introduce variation but are still observations against that selected distribution. For scientific strength claims, add a prespecified held-out position suite, independent opponents and sufficient independent pairs.

Compare configurations only within the same board/rules version and include model, prompt, source revision and profile hashes. Report raw failures, fallback events, unreported tokens and unresolved decisions; do not filter difficult failures out of results without accounting for them.

## Measured outputs

Per game: outcome, score, starting seat, seed, source counts, request/attempt counts, latency summaries, fallback/invalid-output counts, tokens, missing usage/cost, evidence head and replay audit status. Per pair: both seats' outcomes/margins and balanced rate. Summary: score rate, mean margin, paired interval and measured timing distributions.

A distribution of **per-game mean** latencies is not a pooled distribution of all decisions. The summary labels that distinction; use decision-level exports for a pooled quantile. Probability certainty is not evaluated as a win probability. Exact-action regret is emitted only when every alternative was solved.

## Independent search check

The Node suite includes a separate recursive endgame oracle. Twenty sampled five-edge endgames compare every legal root value against that oracle. Tests also exhaust all 24 edge orders for a one-box board for both starters, and execute 1,000 seeded complete boards. This is extensive rule/solver regression evidence, not exhaustive enumeration of the entire 4×4 state space.

## Recommended research expansion

Freeze a held-out tactical set covering captures, double captures, retained-turn continuations, chains, loops, handouts and mixed components. Run four ablations: minimally encoded JEV, JEV with computed tactics, JEV with bounded search, and search without JEV. Pair seats and seeds; separate tuning data from test data. Record the share of decisions made by JEV, forced rules, proven solver choices and fallback. Publish system-level results without attributing all assistance to the model.

This package supplies the runner and evidence schema, not a fabricated result for those unexecuted live experiments.
