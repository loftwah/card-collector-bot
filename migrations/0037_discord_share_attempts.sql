-- Preserve the existing share record and its unique historical identity.
-- Only a confirmed pre-POST cancellation can open a new attempt; an
-- interrupted or ambiguous POST stays reserved for explicit reconciliation.
CREATE TABLE fb_discord_share_attempts (
  id TEXT PRIMARY KEY,
  share_id TEXT NOT NULL REFERENCES fb_discord_shares(id),
  interaction_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('reserved','not_sent','uncertain','delivered')),
  message_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX fb_discord_share_one_live_attempt ON fb_discord_share_attempts(share_id)
  WHERE state IN ('reserved','uncertain','delivered');
CREATE INDEX fb_discord_share_attempt_history ON fb_discord_share_attempts(share_id,created_at,id);
