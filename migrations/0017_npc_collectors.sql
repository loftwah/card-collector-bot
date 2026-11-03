-- Persistent synthetic collectors. They are ordinary Foilbury wallets and
-- inventories with an explicit synthetic identity, never human accounts.
ALTER TABLE fb_users ADD COLUMN is_synthetic INTEGER NOT NULL DEFAULT 0;
ALTER TABLE fb_users ADD COLUMN synthetic_kind TEXT;

CREATE TABLE IF NOT EXISTS fb_npc_collectors (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  bot_id TEXT REFERENCES fb_bots(id),
  user_id TEXT NOT NULL UNIQUE REFERENCES fb_users(id),
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  preset_key TEXT NOT NULL,
  preset_version INTEGER NOT NULL DEFAULT 1,
  avatar_url TEXT,
  bio TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('active','paused','retired')) DEFAULT 'active',
  goals_json TEXT NOT NULL DEFAULT '{}',
  config_json TEXT NOT NULL DEFAULT '{}',
  schedule_json TEXT NOT NULL DEFAULT '{"enabled":false,"interval_minutes":1440}',
  actions_count INTEGER NOT NULL DEFAULT 0,
  last_action_at TEXT,
  created_by TEXT NOT NULL REFERENCES fb_users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  retired_at TEXT,
  UNIQUE (tenant_id, slug)
);
CREATE INDEX IF NOT EXISTS fb_npc_collectors_tenant_idx ON fb_npc_collectors(tenant_id, status, name);

CREATE TABLE IF NOT EXISTS fb_npc_actions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  npc_id TEXT NOT NULL REFERENCES fb_npc_collectors(id),
  action TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('planned','completed','skipped','failed')) DEFAULT 'planned',
  reason TEXT,
  pool_slug TEXT,
  draw_id TEXT,
  instance_id TEXT,
  amount INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT NOT NULL,
  before_json TEXT NOT NULL DEFAULT '{}',
  after_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS fb_npc_actions_npc_idx ON fb_npc_actions(tenant_id, npc_id, created_at DESC);

CREATE TABLE IF NOT EXISTS fb_npc_limits (
  tenant_id TEXT PRIMARY KEY REFERENCES fb_tenants(id),
  max_npcs INTEGER NOT NULL DEFAULT 20 CHECK (max_npcs >= 0),
  max_draws_per_day INTEGER NOT NULL DEFAULT 40 CHECK (max_draws_per_day >= 0),
  paused_all INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
