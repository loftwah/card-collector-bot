-- Test-only pending schema; not an ordered production migration.
CREATE TABLE fb_discord_recovery_intents (
  state_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX fb_discord_recovery_intent_user_idx ON fb_discord_recovery_intents(tenant_id,user_id,consumed_at,expires_at);
CREATE INDEX fb_discord_recovery_intent_expiry_idx ON fb_discord_recovery_intents(expires_at);
CREATE TABLE fb_discord_recovery_challenges (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  discord_user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  global_name TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX fb_discord_recovery_user_idx ON fb_discord_recovery_challenges(tenant_id,user_id,consumed_at,expires_at);
CREATE INDEX fb_discord_recovery_expiry_idx ON fb_discord_recovery_challenges(expires_at);
CREATE TABLE fb_discord_recovery_rate_limits (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  window_started_at TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  PRIMARY KEY (tenant_id,user_id)
);
CREATE INDEX fb_discord_recovery_rate_expiry_idx ON fb_discord_recovery_rate_limits(window_started_at);
