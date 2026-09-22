-- D1 / SQLite JSON queries. Administrative use only; not public API endpoints.
-- Never join sessions, oauth_flows or credential-bearing tables into exports.

-- Completed results by immutable opponent pool and starting seat.
SELECT pool_id, season_id, first_player, COUNT(*) games,
       SUM(outcome='win') human_wins, SUM(outcome='draw') draws,
       SUM(outcome='loss') human_losses
FROM matches WHERE ranked=1 AND verified=1 AND status IN ('completed','forfeit')
GROUP BY pool_id,season_id,first_player;

-- Provider failures and usage coverage. Filter one pool in real comparisons.
SELECT m.pool_id, json_extract(e.value,'$.data.errorCode') error_code,
       COUNT(*) attempts,
       SUM(json_extract(e.value,'$.data.usage.input_tokens')) known_input_tokens,
       SUM(json_extract(e.value,'$.data.usage') IS NULL) unknown_usage_attempts
FROM matches m,json_each(m.record_json,'$.events') e
WHERE json_extract(e.value,'$.type')='provider_attempt'
GROUP BY m.pool_id,error_code;

-- Unresolved decision reservations: billable work might have occurred.
SELECT id, pool_id, json_extract(record_json,'$.pending.id') decision_id,
       json_extract(record_json,'$.pending.expiresAt') lease_expires
FROM matches WHERE status='active' AND json_extract(record_json,'$.pending') IS NOT NULL;

-- API route counts and error rates over the retained operational window.
SELECT json_extract(data_json,'$.route') route,
       COUNT(*) requests,
       SUM(json_extract(data_json,'$.status')>=500) server_errors,
       SUM(json_extract(data_json,'$.status')=429) rate_limits,
       AVG(json_extract(data_json,'$.latencyMs')) mean_ms
FROM operational_events WHERE type='http_request'
GROUP BY route;

-- Retention / storage planning. UTF-8 byte length matters, not character count.
SELECT MAX(length(CAST(record_json AS BLOB))) largest_match_bytes,
       AVG(length(CAST(record_json AS BLOB))) mean_match_bytes,
       COUNT(*) matches
FROM matches;

-- Opt-in browser data stays explicitly client-asserted and separate from results.
SELECT utc,json_extract(data_json,'$.matchId') match_id,
       json_extract(data_json,'$.events') events
FROM operational_events WHERE type='client_telemetry';
