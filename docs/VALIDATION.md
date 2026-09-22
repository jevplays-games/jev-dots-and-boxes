# Executed validation record

Packaging date: 2026-09-22. Runtime: Node v22.16.0 on Linux, built-in SQLite; browser checks used Chromium and Python Playwright.

## Results

| Check | Executed result | Evidence |
|---|---|---|
| Node unit/integration suite | **63 passed, 0 failed, 0 skipped** | `reports/test-results.txt` |
| One-box exhaustive move orders | Both starters × 24 complete edge permutations | `tests/rules.test.mjs` |
| Seeded complete games | 1,000 deterministic rule-invariant checks | `tests/rules.test.mjs` |
| Independent exact-search oracle | 20 sampled five-edge endgames, every legal root compared | `tests/rules.test.mjs` |
| Complete authoritative local game | 40 edges, ownership, result, CSV and journal audit | `tests/api.test.mjs` |
| Complete mocked JEV ranked game | Every provider decision and final replay audited | `tests/api.test.mjs` |
| Concurrency and stale requests | Single committed decision under concurrent requests | `tests/api.test.mjs` |
| Discord and OAuth boundaries | Generated Ed25519 signatures, mocked consent/token response, state binding and session rotation | `tests/auth.test.mjs` |
| Leaderboard scope and pagination | World/server/channel isolation, version separation, ties and 27-user pagination fixture | `tests/api.test.mjs` |
| Browser UI | **17 interaction/layout checks passed**, no uncaught page errors | `reports/browser-tests.json` |
| Local paired benchmark | **12 complete games, six seat pairs**, no live provider attempts | `reports/benchmark/` |
| Sample analytics export | Journal audit passed; JSONL and five CSV tables exported | `reports/sample-export/`, `reports/sample-audit.json` |

Tests include malformed/invalid provider outputs, timeouts, retries, fallback demotion, illegal actions, forged results, modified/deleted/reordered events, wrong-owner exports, launch reuse/wrong-user/expiry checks, CSRF/origin rejection, token-log redaction, source-revision changes and opt-in diagnostics.

## Browser scope

Administrative policy in the packaging browser blocked top-level navigation. Browser tests therefore used the application's actual HTML/CSS/JS in an embedded document, with HTTP bridged to the real local API and the analysis worker sourced from the actual modules.

The test completed a board, navigated with keyboard controls, audited the journal, inspected candidates and events, scrubbed a replay, opened rankings and rules, and checked horizontal overflow at **390 px and 320 px**. Screenshots are actual renders of the implemented interface.

This method **does not validate native navigation, deployment CSP enforcement, browser cookie attributes, OAuth redirects or file-download behavior**. The test script includes a normal-navigation path for execution on an unrestricted machine. API tests separately inspect response headers, cookies, authorization and mocked OAuth behavior.

## External services not exercised

No real TypeSafe inference, Discord account consent, production Discord interaction delivery, application installation or Cloudflare deployment was performed. No credentials were supplied. Provider and OAuth tests used deterministic fixtures and generated signing keys; those tests must not be presented as live-service validation.

The benchmark used the local search/heuristic policy against a seeded random baseline. Its success is not evidence of JEV playing strength, calibration or human-level play. Search-regret evidence is limited to solved positions.

## Packaging integrity and remaining deployment checks

`reports/build-manifest.json` records source/asset sizes and executed checks. `SHA256SUMS.txt` covers shipped files. The ZIP excludes local databases, sessions, real credentials, dependency caches and temporary failure logs.

Before public launch: run normal browser tests, supply a deployment revision, test actual JEV requests, complete Discord OAuth and channel launch, verify live ranked settlement, inspect provider billing and storage sizes, apply host-level abuse controls, and choose evidence-retention periods. Hard/JEV search CPU budgets require measurement on the selected hosting plan. This validation is not an independent security audit or exhaustive enumeration of the full 4×4 state space.
