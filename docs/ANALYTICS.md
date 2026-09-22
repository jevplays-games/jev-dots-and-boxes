# Analytics and evidence contract

The application captures detailed game, candidate, provider, integrity and operational evidence. **Full match JSON is the primary evidence artifact.** The interface, summary and CSV tables are derived views. Analytics are not a hidden-thought transcript, player-surveillance feed or proof of unaided human skill.

## Collection layers

| Layer | Captured evidence | Authority / durability |
|---|---|---|
| Match manifest | Rules, profile, model pin, source revision, pool, starting seat, deployment configuration | Server-created; frozen per match |
| Event journal | Ordered event envelope, causal IDs, data, previous hash, SHA-256 head | Saved with authoritative state using compare-and-swap |
| Moves | Actor, edge, pre/post hashes, captures, retained turn, tactical snapshots, timing | Rules-computed |
| Candidates | Every legal edge and computed feature/search record at each opponent decision | Deterministic feature extraction; estimates marked |
| Inference | Exact structured request, request hash, valid response, probability distribution, attempts, usage | Server-generated request; provider-reported response |
| Operations | Normalized route, HTTP result, duration, bounded error code; optional client diagnostics | Best-effort operational table, separate from game journal |
| Benchmarks | Paired runs, seed, baselines, configuration, complete match evidence and summaries | Executed harness; live and local modes explicitly separated |

A server crash after a provider request but before its result is durably stored can leave an unresolved decision. This is recorded as an expired reservation/unknown consumption when recovered. The package does **not** claim exactly-once provider billing or lossless operational logs during a database outage.

## Every move

`move_committed` captures actor, edge ID, boxes claimed, whether the actor retains the move, terminal status, pre/post-state hashes, tactical features, available captures, server-observed turn duration, commit computation duration and decision ID/source. Scores and ownership are reconstructed from legal transitions rather than trusted from the browser.

Derived measures include scoring-move count, boxes won, double captures, third sides created, available captures declined, longest consecutive-action run and final margin. Declining a capture is a descriptive event, **not automatically a mistake**. A third side created while retaining the move may be exploitable by the same player.

## Every opponent candidate

The `decision_prepared` record retains all legal actions, even when the strongest profile narrows the admissible set to proven optimal choices. Candidate features include:

- Immediate captures, next player, newly created third sides, capturable boxes after the move, opponent capture availability and safe-move count.
- Structural component records: box membership, undrawn connections, exterior ports and chain/loop/unclassified category.
- Search result: estimated margin, exactness, requested depth, exactness, cutoffs, expanded nodes, budget and cache hits where supplied by the selected profile.

The candidate export joins the completed selection, probability, model certainty and source onto those rows. An action omitted from a proven-optimal admissible set has **null probability**, not zero model preference. Local/forced/solver decisions have no invented provider probability distribution.

## Every JEV decision and attempt

The prepared event contains the exact server-built request, readable structured state, criteria, state hash and request hash. No user profile, Discord token, API key or free-form browser text is sent as game state.

The completed record contains the selected edge, source, model, valid response, probabilities, confidence, entropy, top gap, candidate/admissible counts, feature/search statistics, timings and request size. Attempt events record attempt number, HTTP/error classification, success, elapsed duration, response size when available, reported token usage and optional estimated cost.

An unsuccessful raw provider body is not retained because it can contain sensitive operational material. Safe error codes distinguish timeout, HTTP failure, invalid response, network failure and quota failure. Successful structured model responses are retained in full.

Sources are `human`, `local`, `jev`, `forced`, `solver`, or `fallback` as applicable. `forced` and `solver` do not imply a provider call. A fallback invalidates ranked eligibility and switches the continuing match to explicitly labeled practice.

## Definitions and null semantics

| Measure | Definition / limitation |
|---|---|
| Confidence | Provider's certainty statistic; never relabeled probability of winning |
| Entropy | `-sum(p * log2(p))`, with zero-probability terms contributing zero |
| Normalized entropy | Entropy / `log2(option count)`; zero for a singleton |
| Top gap | Highest probability minus second highest; one-option second value is zero |
| Decision latency | Recorded total decision computation/transport duration; local rendering not included |
| Provider latency | One HTTP attempt including response handling; retries appear individually |
| Server turn duration | Time since previous authoritative move; includes idle/network delays, not pure human thought time |
| Timing statistics | Number of finite observations, min, max, mean and linearly interpolated p50/p95/p99 |
| Exact regret | Best final margin minus selected final margin from the actor's perspective; **null unless all candidates are exact** |
| Search estimate | Bounded-search score using a capture-continuation cutoff; not an exact win probability |
| Known token sums | Sum of reported usage only; unknown-usage attempts counted separately |
| Estimated cost | Configured per-million-token rates × reported tokens; null without sufficient rate/usage information |
| Unknown cost count | Attempts without a finite estimate, including failures with unreported consumption |
| Ranked eligibility | Server-owned match flag and successful verification; never a client assertion |
| Longest same-player run | Longest uninterrupted sequence of that player's committed edges, including an initial non-capture action |

A local match can truthfully have zero provider attempts while its estimated provider cost remains **null**, because no billing calculation was made. Do not interpret missing regret, missing confidence or missing latency as zero. An estimated-cost subtotal is not a full invoice when unknown-cost attempts exist.

## Event envelope and ordering

See `event.schema.json`. Each event includes `schema`, `matchId`, contiguous `sequence`, `utc`, `elapsedMs`, `clock`, `type`, `requestId`, `previousHash`, `data`, and `hash`.

`clock.domainId` identifies a JavaScript process/isolate clock domain. `clock.monotonicMs` is useful within that domain; values from different domains must not be subtracted. UTC and elapsed wall time can be affected by wall-clock changes. Contiguous sequence and causal IDs define authoritative order.

The hash is SHA-256 of recursively key-sorted JSON of the event excluding its own hash. JSON is UTF-8. `previousHash` is the prior event's hash; the first uses 64 zeroes. Independently retain a head hash to detect later chain replacement. The chain alone cannot stop a database administrator from rewriting an entire journal and recomputing every hash.

## Interface and exports

Overview presents live score and latency charts plus grouped quantitative metrics. Candidates presents any recorded opponent decision. Event timeline expands exact payloads. Replay scrubs or plays the sequence without making inference requests.

The export dialog exposes full JSON, compact replay, summary, audit, journal JSONL and flat CSV tables. CLI:

```sh
npm run audit -- full-match.json
npm run export -- full-match.json export-directory
node scripts/ops-export.mjs .data/game.sqlite operational-export
```

The full-match exporter audits first, then emits manifest, summary, audit, moves, decisions, candidates, attempts and events. Nested CSV cells contain JSON; CSV quoting neutralizes formula-like text. Empty tables may have no rows/header. JSONL is the lossless option for nested fields. No spreadsheet package is needed.

`analytics-catalog.json` supplies machine-readable names, units, evidence sources, calculation notes and missing-data interpretations. `analytics-queries.sql` supplies administrative SQL examples. SQL access is administrative, not a public browser endpoint.

## Privacy, retention and cost of detail

Essential gameplay/integrity evidence is collected for the match. Optional browser render, visibility and network diagnostics require the checkbox consent and use a fixed field allowlist. They are client-asserted, can be spoofed and never affect scoring. No keystroke text, message content or movement recording is collected.

Ordinary API paths are normalized before logging; query strings and authentication material are excluded. Read the deployment guide for external host/access-log settings, which this application cannot automatically control.

Hourly maintenance removes operational records older than 30 days and unranked matches older than 90 days. Ranked evidence is retained until the operator applies an explicit retention policy. Auth/session/launch records have separate expiration cleanup. A whole match can be hundreds of kilobytes because complete candidate sets and valid responses are intentionally preserved. Storage/egress planning should use actual journal sizes, not only the 40-edge replay size.

## What this does not measure

No hidden chain-of-thought, true subjective intent, actual CPU energy, external solver use, unreported provider billing, unobserved browser idle reasons, continuous guild membership or general JEV strength is inferred. Calibration and playing-strength conclusions require a held-out, adequately replicated live evaluation. The included local smoke benchmark is not that evaluation.
