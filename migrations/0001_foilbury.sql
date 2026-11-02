-- Foilbury domain schema. EmDash owns its own tables in the same local D1 database.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS fb_schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fb_tenants (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  tagline TEXT,
  created_at TEXT NOT NULL,
  settings_json TEXT NOT NULL DEFAULT '{}',
  community_policy_json TEXT NOT NULL DEFAULT '{}',
  economy_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS fb_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  platform_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  disabled_at TEXT
);

CREATE TABLE IF NOT EXISTS fb_memberships (
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  user_id TEXT NOT NULL REFERENCES fb_users(id),
  role TEXT NOT NULL CHECK (role IN ('owner','editor','economy_admin','player')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS fb_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES fb_users(id),
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS fb_sessions_user_idx ON fb_sessions(user_id, tenant_id);

CREATE TABLE IF NOT EXISTS fb_agent_grants (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  agent_name TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  represented_user_id TEXT NOT NULL REFERENCES fb_users(id),
  scopes_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','revoked','expired')),
  expires_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS fb_agent_grants_tenant_idx ON fb_agent_grants(tenant_id, agent_id);

CREATE TABLE IF NOT EXISTS fb_agent_tokens (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES fb_agent_grants(id),
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS fb_agent_tokens_grant_idx ON fb_agent_tokens(grant_id);

CREATE TABLE IF NOT EXISTS fb_classes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  UNIQUE (tenant_id, key)
);

CREATE TABLE IF NOT EXISTS fb_categories (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  parent_id TEXT REFERENCES fb_categories(id),
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  UNIQUE (tenant_id, slug)
);

CREATE TABLE IF NOT EXISTS fb_tags (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  archived_at TEXT,
  UNIQUE (tenant_id, slug)
);

CREATE TABLE IF NOT EXISTS fb_rarities (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  weight INTEGER NOT NULL DEFAULT 100,
  tone TEXT NOT NULL DEFAULT 'neutral',
  sort INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  UNIQUE (tenant_id, key)
);

CREATE TABLE IF NOT EXISTS fb_materials (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  sort INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  UNIQUE (tenant_id, key)
);

CREATE TABLE IF NOT EXISTS fb_effects (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  sort INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  UNIQUE (tenant_id, key)
);

CREATE TABLE IF NOT EXISTS fb_assets (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  kind TEXT NOT NULL CHECK (kind IN ('subject','background','frame','material','effect','brand','render')),
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  bytes INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('private','public_export')) DEFAULT 'private',
  source_repo TEXT,
  source_path TEXT,
  source_commit TEXT,
  source_logical_id TEXT,
  credit TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, r2_key)
);
CREATE INDEX IF NOT EXISTS fb_assets_sha_idx ON fb_assets(tenant_id, sha256);

CREATE TABLE IF NOT EXISTS fb_recipes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  config_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','published','retired')) DEFAULT 'draft',
  created_at TEXT NOT NULL,
  published_at TEXT,
  UNIQUE (tenant_id, version)
);

CREATE TABLE IF NOT EXISTS fb_card_definitions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  logical_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  subtitle TEXT,
  description TEXT NOT NULL,
  class_id TEXT REFERENCES fb_classes(id),
  category_id TEXT REFERENCES fb_categories(id),
  rarity_id TEXT REFERENCES fb_rarities(id),
  status TEXT NOT NULL CHECK (status IN ('draft','published','retired')) DEFAULT 'draft',
  source_repo TEXT,
  source_path TEXT,
  source_commit TEXT,
  source_logical_id TEXT,
  credit TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, logical_id)
);
CREATE INDEX IF NOT EXISTS cards_tenant_status_idx ON fb_card_definitions(tenant_id, status);

CREATE TABLE IF NOT EXISTS fb_card_tags (
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  card_id TEXT NOT NULL REFERENCES fb_card_definitions(id),
  tag_id TEXT NOT NULL REFERENCES fb_tags(id),
  PRIMARY KEY (tenant_id, card_id, tag_id)
);

CREATE TABLE IF NOT EXISTS fb_artwork_editions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  card_id TEXT NOT NULL REFERENCES fb_card_definitions(id),
  name TEXT NOT NULL,
  subject_asset_id TEXT NOT NULL REFERENCES fb_assets(id),
  background_asset_id TEXT REFERENCES fb_assets(id),
  recipe_id TEXT NOT NULL REFERENCES fb_recipes(id),
  status TEXT NOT NULL CHECK (status IN ('draft','published','retired')) DEFAULT 'draft',
  source_repo TEXT,
  source_path TEXT,
  source_commit TEXT,
  source_logical_id TEXT,
  source_hash TEXT,
  credit TEXT,
  created_at TEXT NOT NULL,
  archived_at TEXT
);
CREATE INDEX IF NOT EXISTS editions_card_idx ON fb_artwork_editions(tenant_id, card_id);

CREATE TABLE IF NOT EXISTS fb_variants (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  card_id TEXT NOT NULL REFERENCES fb_card_definitions(id),
  edition_id TEXT NOT NULL REFERENCES fb_artwork_editions(id),
  material_id TEXT NOT NULL REFERENCES fb_materials(id),
  effect_id TEXT REFERENCES fb_effects(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','published','retired')) DEFAULT 'draft',
  created_at TEXT NOT NULL,
  archived_at TEXT,
  UNIQUE (tenant_id, edition_id, material_id, effect_id)
);
CREATE INDEX IF NOT EXISTS fb_variants_card_idx ON fb_variants(tenant_id, card_id, status);

CREATE TABLE IF NOT EXISTS fb_sets (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','published','retired')) DEFAULT 'draft',
  version INTEGER NOT NULL DEFAULT 1,
  published_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, slug)
);

CREATE TABLE IF NOT EXISTS fb_set_memberships (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  set_id TEXT NOT NULL REFERENCES fb_sets(id),
  set_version INTEGER NOT NULL,
  card_id TEXT NOT NULL REFERENCES fb_card_definitions(id),
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, set_id, set_version, card_id)
);
CREATE INDEX IF NOT EXISTS fb_set_memberships_version_idx ON fb_set_memberships(tenant_id, set_id, set_version);

CREATE TABLE IF NOT EXISTS fb_set_reward_rules (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  set_id TEXT NOT NULL REFERENCES fb_sets(id),
  set_version INTEGER NOT NULL,
  reward_amount INTEGER NOT NULL CHECK (reward_amount >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, set_id, set_version)
);

CREATE TABLE IF NOT EXISTS fb_economy_settings (
  tenant_id TEXT PRIMARY KEY REFERENCES fb_tenants(id),
  currency_name TEXT NOT NULL,
  currency_symbol TEXT NOT NULL,
  starter_grant INTEGER NOT NULL CHECK (starter_grant >= 0),
  daily_reward INTEGER NOT NULL CHECK (daily_reward >= 0),
  daily_cooldown_seconds INTEGER NOT NULL CHECK (daily_cooldown_seconds >= 0),
  recycle_enabled INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fb_wallets (
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  user_id TEXT NOT NULL REFERENCES fb_users(id),
  balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS fb_ledger_entries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  user_id TEXT NOT NULL REFERENCES fb_users(id),
  kind TEXT NOT NULL CHECK (kind IN ('issue','spend','burn','correction','transfer_in','transfer_out','recycle')),
  amount INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  reference_type TEXT,
  reference_id TEXT,
  description TEXT NOT NULL,
  idempotency_key TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  actor_type TEXT NOT NULL DEFAULT 'system',
  actor_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_user_idx ON fb_ledger_entries(tenant_id, user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS ledger_idem_idx ON fb_ledger_entries(tenant_id, user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS fb_reward_claims (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  user_id TEXT NOT NULL REFERENCES fb_users(id),
  rule_key TEXT NOT NULL,
  rule_version INTEGER NOT NULL,
  period_key TEXT NOT NULL,
  amount INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  UNIQUE (tenant_id, user_id, idempotency_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS reward_period_idx ON fb_reward_claims(tenant_id, user_id, rule_key, period_key);

CREATE TABLE IF NOT EXISTS fb_pools (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','active','retired')) DEFAULT 'draft',
  revision INTEGER NOT NULL DEFAULT 1,
  price INTEGER NOT NULL CHECK (price >= 0),
  published_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, slug)
);

CREATE TABLE IF NOT EXISTS fb_pool_entries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  pool_id TEXT NOT NULL REFERENCES fb_pools(id),
  pool_revision INTEGER NOT NULL,
  variant_id TEXT NOT NULL REFERENCES fb_variants(id),
  weight INTEGER NOT NULL CHECK (weight > 0),
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, pool_id, pool_revision, variant_id)
);

CREATE TABLE IF NOT EXISTS fb_draws (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  user_id TEXT NOT NULL REFERENCES fb_users(id),
  pool_id TEXT NOT NULL REFERENCES fb_pools(id),
  pool_revision INTEGER NOT NULL,
  price INTEGER NOT NULL,
  variant_id TEXT NOT NULL REFERENCES fb_variants(id),
  instance_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  random_commitment TEXT NOT NULL,
  UNIQUE (tenant_id, user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS fb_draws_user_idx ON fb_draws(tenant_id, user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS fb_card_instances (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  user_id TEXT NOT NULL REFERENCES fb_users(id),
  card_id TEXT NOT NULL REFERENCES fb_card_definitions(id),
  variant_id TEXT NOT NULL REFERENCES fb_variants(id),
  serial TEXT NOT NULL,
  acquired_via TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('owned','reserved','traded','surrendered','gifted')) DEFAULT 'owned',
  favourite INTEGER NOT NULL DEFAULT 0,
  locked INTEGER NOT NULL DEFAULT 0,
  reserved_for TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, serial)
);
CREATE INDEX IF NOT EXISTS instances_user_idx ON fb_card_instances(tenant_id, user_id, status);
CREATE INDEX IF NOT EXISTS instances_card_idx ON fb_card_instances(tenant_id, card_id);

CREATE TABLE IF NOT EXISTS fb_instance_history (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  instance_id TEXT NOT NULL REFERENCES fb_card_instances(id),
  event TEXT NOT NULL,
  from_user_id TEXT REFERENCES fb_users(id),
  to_user_id TEXT REFERENCES fb_users(id),
  reference_type TEXT,
  reference_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS history_instance_idx ON fb_instance_history(tenant_id, instance_id, created_at);

CREATE TABLE IF NOT EXISTS fb_favourites (
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  user_id TEXT NOT NULL REFERENCES fb_users(id),
  card_id TEXT NOT NULL REFERENCES fb_card_definitions(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, user_id, card_id)
);

CREATE TABLE IF NOT EXISTS fb_wishlists (
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  user_id TEXT NOT NULL REFERENCES fb_users(id),
  card_id TEXT NOT NULL REFERENCES fb_card_definitions(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, user_id, card_id)
);

CREATE TABLE IF NOT EXISTS fb_trades (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  proposer_id TEXT NOT NULL REFERENCES fb_users(id),
  recipient_id TEXT NOT NULL REFERENCES fb_users(id),
  status TEXT NOT NULL CHECK (status IN ('open','accepted','declined','cancelled','expired','completed')) DEFAULT 'open',
  revision INTEGER NOT NULL DEFAULT 1,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  idempotency_key TEXT,
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS fb_trades_tenant_idx ON fb_trades(tenant_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS fb_trade_items (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  trade_id TEXT NOT NULL REFERENCES fb_trades(id),
  side TEXT NOT NULL CHECK (side IN ('proposer','recipient')),
  instance_id TEXT NOT NULL REFERENCES fb_card_instances(id),
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, trade_id, instance_id)
);

CREATE TABLE IF NOT EXISTS fb_trade_acceptances (
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  trade_id TEXT NOT NULL REFERENCES fb_trades(id),
  revision INTEGER NOT NULL,
  user_id TEXT NOT NULL REFERENCES fb_users(id),
  accepted_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, trade_id, revision, user_id)
);

CREATE TABLE IF NOT EXISTS fb_gifts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  sender_id TEXT NOT NULL REFERENCES fb_users(id),
  recipient_id TEXT NOT NULL REFERENCES fb_users(id),
  instance_id TEXT NOT NULL REFERENCES fb_card_instances(id),
  status TEXT NOT NULL CHECK (status IN ('reserved','completed','cancelled','expired')) DEFAULT 'reserved',
  created_at TEXT NOT NULL,
  completed_at TEXT,
  idempotency_key TEXT NOT NULL,
  UNIQUE (tenant_id, sender_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS fb_recycle_receipts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  user_id TEXT NOT NULL REFERENCES fb_users(id),
  instance_id TEXT NOT NULL,
  credit_amount INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  UNIQUE (tenant_id, user_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS fb_set_completion_claims (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  user_id TEXT NOT NULL REFERENCES fb_users(id),
  set_id TEXT NOT NULL REFERENCES fb_sets(id),
  set_version INTEGER NOT NULL,
  reward_amount INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  UNIQUE (tenant_id, user_id, set_id, set_version)
);

CREATE TABLE IF NOT EXISTS fb_idempotency_keys (
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('in_progress','completed','failed')) DEFAULT 'completed',
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, actor_type, actor_id, operation, idempotency_key)
);

CREATE TABLE IF NOT EXISTS fb_outbox (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  topic TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','processing','delivered','failed')) DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS fb_outbox_pending_idx ON fb_outbox(status, available_at);

CREATE TABLE IF NOT EXISTS fb_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed','cancelled')) DEFAULT 'pending',
  payload_json TEXT NOT NULL,
  result_json TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  available_at TEXT NOT NULL,
  locked_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS fb_jobs_pending_idx ON fb_jobs(status, available_at);

CREATE TABLE IF NOT EXISTS fb_import_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  source TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  summary_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS fb_import_items (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  run_id TEXT NOT NULL REFERENCES fb_import_runs(id),
  source TEXT NOT NULL,
  source_repo TEXT NOT NULL,
  source_path TEXT NOT NULL,
  source_commit TEXT NOT NULL,
  logical_id TEXT NOT NULL,
  hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('discovered','previewed','imported','updated','unchanged','failed')),
  card_id TEXT,
  asset_id TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, source, source_path, source_commit, logical_id, hash)
);
CREATE INDEX IF NOT EXISTS fb_import_items_logical_idx ON fb_import_items(tenant_id, source, logical_id);

CREATE TABLE IF NOT EXISTS fb_audit_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  represented_user_id TEXT,
  action TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  request_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_tenant_idx ON fb_audit_events(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS fb_catalogue_releases (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','superseded')) DEFAULT 'active',
  manifest_json TEXT NOT NULL,
  checksum TEXT NOT NULL,
  published_by TEXT NOT NULL,
  published_at TEXT NOT NULL,
  UNIQUE (tenant_id, version)
);

CREATE TABLE IF NOT EXISTS fb_topic_policies (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  channel_key TEXT NOT NULL,
  name TEXT NOT NULL,
  exclude_tags_json TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, channel_key)
);

CREATE TABLE IF NOT EXISTS fb_player_preferences (
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  user_id TEXT NOT NULL REFERENCES fb_users(id),
  hide_tags_json TEXT NOT NULL DEFAULT '[]',
  reduced_motion INTEGER NOT NULL DEFAULT 0,
  sound_enabled INTEGER NOT NULL DEFAULT 0,
  sharing_enabled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS fb_share_links (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  user_id TEXT NOT NULL REFERENCES fb_users(id),
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('active','revoked','expired')) DEFAULT 'active',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS fb_notification_deliveries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  outbox_id TEXT NOT NULL REFERENCES fb_outbox(id),
  destination_type TEXT NOT NULL,
  destination_ref TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','sent','failed','suppressed')) DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);

CREATE TABLE IF NOT EXISTS fb_provider_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('planned','submitted','succeeded','failed','review','adopted','cancelled')) DEFAULT 'planned',
  prompt TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  provider_job_id TEXT,
  output_asset_id TEXT,
  estimated_cost_micros INTEGER NOT NULL DEFAULT 0,
  actual_cost_micros INTEGER,
  uncertainty TEXT,
  requested_by TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS fb_rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS fb_counters (
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  scope TEXT NOT NULL,
  value INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, scope)
);

CREATE TABLE IF NOT EXISTS fb_wallet_debits (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  reference TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS fb_draws_guard_balance
BEFORE INSERT ON fb_draws
WHEN (SELECT balance FROM fb_wallets WHERE tenant_id = NEW.tenant_id AND user_id = NEW.user_id) < NEW.price
BEGIN
  SELECT RAISE(ABORT, 'insufficient_funds');
END;

CREATE TRIGGER IF NOT EXISTS fb_draws_apply_debit
AFTER INSERT ON fb_draws
BEGIN
  UPDATE fb_wallets
     SET balance = balance - NEW.price,
         updated_at = NEW.created_at
   WHERE tenant_id = NEW.tenant_id AND user_id = NEW.user_id;
  INSERT INTO fb_ledger_entries
    (id, tenant_id, user_id, kind, amount, balance_after, reference_type, reference_id,
     description, idempotency_key, metadata_json, actor_type, actor_id, created_at)
  VALUES
    ('led_' || NEW.id, NEW.tenant_id, NEW.user_id, 'spend', -NEW.price,
     (SELECT balance FROM fb_wallets WHERE tenant_id = NEW.tenant_id AND user_id = NEW.user_id),
     'draw', NEW.id, 'Cabinet draw', NEW.idempotency_key,
     json_object('pool_id', NEW.pool_id, 'pool_revision', NEW.pool_revision, 'variant_id', NEW.variant_id),
     'user', NEW.user_id, NEW.created_at);
END;

CREATE TRIGGER IF NOT EXISTS rewards_guard_cooldown
BEFORE INSERT ON fb_reward_claims
WHEN EXISTS (
  SELECT 1 FROM fb_reward_claims
   WHERE tenant_id = NEW.tenant_id AND user_id = NEW.user_id
     AND rule_key = NEW.rule_key
     AND datetime(created_at) > datetime(NEW.created_at, '-' || (SELECT daily_cooldown_seconds FROM fb_economy_settings WHERE tenant_id = NEW.tenant_id) || ' seconds')
)
BEGIN
  SELECT RAISE(ABORT, 'reward_cooldown');
END;

CREATE TRIGGER IF NOT EXISTS rewards_apply_credit
AFTER INSERT ON fb_reward_claims
BEGIN
  UPDATE fb_wallets SET balance = balance + NEW.amount, updated_at = NEW.created_at
   WHERE tenant_id = NEW.tenant_id AND user_id = NEW.user_id;
  INSERT INTO fb_ledger_entries
    (id, tenant_id, user_id, kind, amount, balance_after, reference_type, reference_id,
     description, idempotency_key, metadata_json, actor_type, actor_id, created_at)
  VALUES
    ('led_' || NEW.id, NEW.tenant_id, NEW.user_id, 'issue', NEW.amount,
     (SELECT balance FROM fb_wallets WHERE tenant_id = NEW.tenant_id AND user_id = NEW.user_id),
     'reward', NEW.id, 'Daily cabinet allowance', NEW.idempotency_key,
     json_object('rule_key', NEW.rule_key, 'rule_version', NEW.rule_version, 'period_key', NEW.period_key),
     'user', NEW.user_id, NEW.created_at);
END;

CREATE TRIGGER IF NOT EXISTS recycle_guard
BEFORE INSERT ON fb_recycle_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM fb_card_instances
   WHERE id = NEW.instance_id AND tenant_id = NEW.tenant_id AND user_id = NEW.user_id
     AND status = 'owned' AND favourite = 0 AND locked = 0
)
BEGIN
  SELECT RAISE(ABORT, 'instance_not_eligible');
END;

CREATE TRIGGER IF NOT EXISTS recycle_apply
AFTER INSERT ON fb_recycle_receipts
BEGIN
  UPDATE fb_card_instances SET status = 'surrendered', updated_at = NEW.created_at
   WHERE id = NEW.instance_id AND tenant_id = NEW.tenant_id AND user_id = NEW.user_id AND status = 'owned';
  INSERT INTO fb_instance_history
    (id, tenant_id, instance_id, event, from_user_id, to_user_id, reference_type, reference_id, metadata_json, created_at)
  VALUES
    ('ih_' || NEW.id, NEW.tenant_id, NEW.instance_id, 'recycled', NEW.user_id, NULL, 'recycle', NEW.id,
     json_object('credit', NEW.credit_amount), NEW.created_at);
  UPDATE fb_wallets SET balance = balance + NEW.credit_amount, updated_at = NEW.created_at
   WHERE tenant_id = NEW.tenant_id AND user_id = NEW.user_id;
  INSERT INTO fb_ledger_entries
    (id, tenant_id, user_id, kind, amount, balance_after, reference_type, reference_id,
     description, idempotency_key, metadata_json, actor_type, actor_id, created_at)
  VALUES
    ('led_' || NEW.id, NEW.tenant_id, NEW.user_id, 'recycle', NEW.credit_amount,
     (SELECT balance FROM fb_wallets WHERE tenant_id = NEW.tenant_id AND user_id = NEW.user_id),
     'recycle', NEW.id, 'Recycled duplicate', NEW.idempotency_key,
     json_object('instance_id', NEW.instance_id), 'user', NEW.user_id, NEW.created_at);
END;

CREATE TRIGGER IF NOT EXISTS set_completion_guard
BEFORE INSERT ON fb_set_completion_claims
WHEN NOT EXISTS (
  SELECT 1 FROM fb_set_memberships sm
   WHERE sm.tenant_id = NEW.tenant_id AND sm.set_id = NEW.set_id AND sm.set_version = NEW.set_version
)
BEGIN
  SELECT RAISE(ABORT, 'set_version_missing');
END;

CREATE TRIGGER IF NOT EXISTS set_completion_apply
AFTER INSERT ON fb_set_completion_claims
BEGIN
  UPDATE fb_wallets SET balance = balance + NEW.reward_amount, updated_at = NEW.created_at
   WHERE tenant_id = NEW.tenant_id AND user_id = NEW.user_id;
  INSERT INTO fb_ledger_entries
    (id, tenant_id, user_id, kind, amount, balance_after, reference_type, reference_id,
     description, idempotency_key, metadata_json, actor_type, actor_id, created_at)
  VALUES
    ('led_' || NEW.id, NEW.tenant_id, NEW.user_id, 'issue', NEW.reward_amount,
     (SELECT balance FROM fb_wallets WHERE tenant_id = NEW.tenant_id AND user_id = NEW.user_id),
     'set_completion', NEW.id, 'Set completion reward', NEW.idempotency_key,
     json_object('set_id', NEW.set_id, 'set_version', NEW.set_version),
     'user', NEW.user_id, NEW.created_at);
END;

INSERT OR IGNORE INTO fb_schema_meta (key, value) VALUES ('domain_schema_version', '1');
