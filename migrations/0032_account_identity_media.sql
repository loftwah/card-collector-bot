-- Account identity media: a chosen account avatar and an optional uploaded
-- profile banner. Discord avatar bytes and member uploads live in private R2
-- objects tracked by fb_member_media; a CDN URL is never the source of truth.
--
-- Additive only. Existing accounts fall back to the illustrated Foilbury Keeper,
-- never a letter monogram. A Worker-only rollback leaves the new columns and
-- rows unread, so no inventory, serial, ledger or preference row moves.

CREATE TABLE IF NOT EXISTS fb_member_media (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  user_id TEXT NOT NULL REFERENCES fb_users(id),
  kind TEXT NOT NULL CHECK (kind IN ('avatar','banner')),
  mime TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  renditions_json TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('upload','discord')),
  created_at TEXT NOT NULL,
  archived_at TEXT
);
CREATE INDEX IF NOT EXISTS fb_member_media_user_idx
  ON fb_member_media(tenant_id, user_id, kind, created_at DESC);

ALTER TABLE fb_users ADD COLUMN avatar_kind TEXT NOT NULL DEFAULT 'default'
  CHECK (avatar_kind IN ('default','discord','upload'));
ALTER TABLE fb_users ADD COLUMN avatar_default_key TEXT NOT NULL DEFAULT 'keeper';
ALTER TABLE fb_users ADD COLUMN avatar_asset_id TEXT;
ALTER TABLE fb_users ADD COLUMN avatar_source_hash TEXT;
ALTER TABLE fb_users ADD COLUMN avatar_updated_at TEXT;
ALTER TABLE fb_users ADD COLUMN banner_asset_id TEXT;
ALTER TABLE fb_users ADD COLUMN banner_source_hash TEXT;
ALTER TABLE fb_users ADD COLUMN banner_updated_at TEXT;

ALTER TABLE fb_discord_identities ADD COLUMN avatar_hash TEXT;
