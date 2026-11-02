-- Discord HTTP interactions, installation bindings and player identity links.
-- A guild is bound to exactly one Foilbury tenant for V1. The binding is server-side
-- and is never accepted from an interaction payload.

CREATE TABLE IF NOT EXISTS fb_discord_installations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  application_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  guild_name TEXT,
  channel_allowlist_json TEXT NOT NULL DEFAULT '[]',
  channel_key TEXT,
  game_enabled INTEGER NOT NULL DEFAULT 1,
  website_enabled INTEGER NOT NULL DEFAULT 1,
  api_enabled INTEGER NOT NULL DEFAULT 1,
  public_catalogue_enabled INTEGER NOT NULL DEFAULT 1,
  admin_gui_enabled INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  installed_by_discord_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (application_id, guild_id)
);
CREATE INDEX IF NOT EXISTS fb_discord_installations_tenant_idx
  ON fb_discord_installations(tenant_id, active);

CREATE TABLE IF NOT EXISTS fb_discord_identities (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  discord_user_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES fb_users(id),
  username TEXT,
  global_name TEXT,
  linked_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (tenant_id, discord_user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS fb_discord_identity_user_idx
  ON fb_discord_identities(tenant_id, user_id)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS fb_discord_interactions (
  interaction_id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL,
  guild_id TEXT,
  channel_id TEXT,
  discord_user_id TEXT,
  command_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing','completed','failed')),
  error_code TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS fb_discord_interactions_created_idx
  ON fb_discord_interactions(created_at DESC);

CREATE TABLE IF NOT EXISTS fb_discord_confirmations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  discord_user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS fb_discord_confirmations_user_idx
  ON fb_discord_confirmations(tenant_id, discord_user_id, expires_at);

-- Default admin GUI availability stays on, but a guild binding is required to
-- receive interactions. Existing domain services remain authoritative for
-- inventory, quotas and awards.
