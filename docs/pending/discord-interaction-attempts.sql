-- Test-only design sketch. Not an ordered production migration.
-- Parent interaction remains the stable Discord interaction; each actual
-- execution or replay gets its own immutable identity and terminal outcome.
ALTER TABLE fb_discord_interactions ADD COLUMN current_attempt_id TEXT;
CREATE TABLE fb_discord_interaction_attempts (
  attempt_id TEXT PRIMARY KEY,
  interaction_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  guild_id TEXT,
  discord_user_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('processing','completed','failed','expired')),
  error_code TEXT,
  delivery_visibility TEXT CHECK(delivery_visibility IN ('private','public','private_fallback')),
  finished_at TEXT,
  expiry_batch_id TEXT,
  CHECK ((status='processing' AND finished_at IS NULL) OR (status<>'processing' AND finished_at IS NOT NULL))
);
CREATE INDEX fb_discord_attempts_interaction_idx ON fb_discord_interaction_attempts(interaction_id,started_at,attempt_id);
CREATE INDEX fb_discord_attempts_expiry_idx ON fb_discord_interaction_attempts(status,started_at,attempt_id);
CREATE INDEX fb_discord_attempts_expiry_batch_idx ON fb_discord_interaction_attempts(status,expiry_batch_id,attempt_id);
CREATE INDEX fb_discord_timeout_reconcile_idx ON fb_discord_interactions(status,error_code,completed_at,interaction_id);
CREATE INDEX fb_discord_processing_attempt_idx ON fb_discord_interactions(status,current_attempt_id,created_at,interaction_id);
CREATE INDEX fb_draw_discord_idempotency_lookup_idx ON fb_draws(idempotency_key);
CREATE TABLE fb_discord_timeout_reconcile_cursor (id INTEGER PRIMARY KEY CHECK(id=1), completed_at TEXT NOT NULL, interaction_id TEXT NOT NULL, high_completed_at TEXT NOT NULL, high_interaction_id TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation>=0));
INSERT INTO fb_discord_timeout_reconcile_cursor (id,completed_at,interaction_id,high_completed_at,high_interaction_id,generation) VALUES (1,'','','','',0);
