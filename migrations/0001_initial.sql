PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(discord_id TEXT PRIMARY KEY,display_name TEXT NOT NULL,avatar_ref TEXT,created_at INTEGER NOT NULL,last_seen_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT REFERENCES users(discord_id),csrf_hash TEXT NOT NULL,context_json TEXT,pending_launch_hash TEXT,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_flows(state_hash TEXT PRIMARY KEY,browser_binding_hash TEXT NOT NULL,pending_launch_hash TEXT,expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS discord_launches(token_hash TEXT PRIMARY KEY,interaction_id TEXT NOT NULL UNIQUE,discord_user_id TEXT NOT NULL,guild_id TEXT NOT NULL,channel_id TEXT NOT NULL,expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS matches(
 id TEXT PRIMARY KEY,owner_key TEXT NOT NULL,user_id TEXT REFERENCES users(discord_id),
 guild_id TEXT,channel_id TEXT,launch_hash TEXT UNIQUE REFERENCES discord_launches(token_hash),pool_id TEXT NOT NULL,season_id TEXT NOT NULL,
 attempt_no INTEGER NOT NULL,first_player INTEGER NOT NULL CHECK(first_player IN(0,1)),status TEXT NOT NULL CHECK(status IN('active','completed','forfeit','void')),
 ranked INTEGER NOT NULL CHECK(ranked IN(0,1)),verified INTEGER NOT NULL CHECK(verified IN(0,1)),outcome TEXT CHECK(outcome IN('win','loss','draw') OR outcome IS NULL),
 created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,version INTEGER NOT NULL DEFAULT 0,record_json TEXT NOT NULL,
 CHECK(ranked=0 OR user_id IS NOT NULL),CHECK((guild_id IS NULL)=(channel_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_match ON matches(owner_key) WHERE status='active';
CREATE UNIQUE INDEX IF NOT EXISTS ranked_attempt ON matches(user_id,pool_id,attempt_no) WHERE ranked=1;
CREATE INDEX IF NOT EXISTS world_board ON matches(pool_id,season_id,verified,ranked,user_id);
CREATE INDEX IF NOT EXISTS server_board ON matches(guild_id,pool_id,season_id,verified,ranked,user_id);
CREATE INDEX IF NOT EXISTS channel_board ON matches(channel_id,pool_id,season_id,verified,ranked,user_id);
CREATE INDEX IF NOT EXISTS player_history ON matches(owner_key,created_at DESC);
CREATE INDEX IF NOT EXISTS match_expiry ON matches(status,expires_at);
CREATE TABLE IF NOT EXISTS quotas(bucket TEXT PRIMARY KEY,count INTEGER NOT NULL,expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS operational_events(id TEXT PRIMARY KEY,utc TEXT NOT NULL,type TEXT NOT NULL,data_json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS operation_time ON operational_events(utc);
