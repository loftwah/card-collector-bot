-- Channel audience policy for Discord reveals.
--
-- A player's entitlement to a card does not make a Discord channel a safe
-- destination for that card's artwork. Each installation records the audience
-- it has verified for a channel. A missing or weaker policy keeps restricted
-- reveals ephemeral to the invoker.
ALTER TABLE fb_discord_installations ADD COLUMN channel_audience_json TEXT NOT NULL DEFAULT '{}';

-- One explicit share per member, channel and object. A repeated click cannot
-- produce a duplicate announcement; the receipt is deliberately not a claim
-- that an already-delivered Discord attachment can be revoked.
CREATE TABLE IF NOT EXISTS fb_discord_shares (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  message_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, user_id, channel_id, object_type, object_id)
);

CREATE INDEX IF NOT EXISTS idx_fb_discord_shares_lookup
  ON fb_discord_shares (tenant_id, user_id, channel_id, created_at);

