-- Foilbury identity, passwordless auth, bots and collections.
-- This migration is additive and keeps the existing usr_prod_owner identity,
-- Discord link, inventory, serials and ledger rows intact.

-- ---------------------------------------------------------------------------
-- Accounts and sessions
-- ---------------------------------------------------------------------------

ALTER TABLE fb_users ADD COLUMN email_verified_at TEXT;
ALTER TABLE fb_users ADD COLUMN avatar_url TEXT;

-- Only one platform-wide Super Admin can exist. The role is provisioned by the
-- audited operator script, never by public registration or an admin API.
CREATE UNIQUE INDEX IF NOT EXISTS fb_users_single_super_admin
  ON fb_users(platform_admin) WHERE platform_admin = 1;

CREATE TABLE IF NOT EXISTS fb_platform_admins (
  user_id TEXT PRIMARY KEY REFERENCES fb_users(id),
  provisioned_by TEXT NOT NULL,
  provisioned_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','revoked')) DEFAULT 'active',
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS fb_access_emails (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  user_id TEXT NOT NULL REFERENCES fb_users(id),
  added_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS fb_access_identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES fb_users(id),
  team_domain TEXT NOT NULL,
  subject TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE,
  audience TEXT,
  linked_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (team_domain, subject)
);
CREATE INDEX IF NOT EXISTS fb_access_identities_user_idx
  ON fb_access_identities(user_id, revoked_at);

CREATE TABLE IF NOT EXISTS fb_magic_links (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES fb_users(id),
  email TEXT NOT NULL COLLATE NOCASE,
  purpose TEXT NOT NULL CHECK (purpose IN ('signin','verify_email','link_email')),
  token_hash TEXT NOT NULL UNIQUE,
  redirect_path TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  request_ip_hash TEXT,
  request_id TEXT
);
CREATE INDEX IF NOT EXISTS fb_magic_links_email_idx
  ON fb_magic_links(email, created_at DESC);

CREATE TABLE IF NOT EXISTS fb_webauthn_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES fb_users(id),
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports_json TEXT NOT NULL DEFAULT '[]',
  device_type TEXT,
  backed_up INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS fb_webauthn_user_idx ON fb_webauthn_credentials(user_id);

CREATE TABLE IF NOT EXISTS fb_auth_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES fb_users(id),
  kind TEXT NOT NULL CHECK (kind IN ('registration','authentication')),
  challenge TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS fb_auth_challenges_expiry_idx
  ON fb_auth_challenges(kind, expires_at);

CREATE TABLE IF NOT EXISTS fb_totp_secrets (
  user_id TEXT PRIMARY KEY REFERENCES fb_users(id),
  secret_enc TEXT NOT NULL,
  confirmed_at TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fb_recovery_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES fb_users(id),
  code_hash TEXT NOT NULL UNIQUE,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS fb_recovery_codes_user_idx ON fb_recovery_codes(user_id);

ALTER TABLE fb_sessions ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'password';
ALTER TABLE fb_sessions ADD COLUMN assurance TEXT NOT NULL DEFAULT 'password';
ALTER TABLE fb_sessions ADD COLUMN auth_time TEXT;
ALTER TABLE fb_sessions ADD COLUMN user_agent TEXT;
ALTER TABLE fb_sessions ADD COLUMN ip_hash TEXT;
ALTER TABLE fb_sessions ADD COLUMN access_subject TEXT;
ALTER TABLE fb_sessions ADD COLUMN revoked_reason TEXT;

-- ---------------------------------------------------------------------------
-- Bots and delegated administration
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS fb_bots (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL UNIQUE REFERENCES fb_tenants(id),
  owner_user_id TEXT NOT NULL REFERENCES fb_users(id),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL CHECK (status IN ('active','paused','archived')) DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE IF NOT EXISTS fb_bot_admins (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES fb_bots(id),
  user_id TEXT NOT NULL REFERENCES fb_users(id),
  role TEXT NOT NULL CHECK (role IN ('owner','admin')),
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('active','invited','revoked')) DEFAULT 'active',
  invited_by TEXT REFERENCES fb_users(id),
  created_at TEXT NOT NULL,
  accepted_at TEXT,
  revoked_at TEXT,
  UNIQUE (bot_id, user_id)
);
CREATE INDEX IF NOT EXISTS fb_bot_admins_user_idx ON fb_bot_admins(user_id, status);

CREATE TABLE IF NOT EXISTS fb_bot_invitations (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES fb_bots(id),
  email TEXT NOT NULL COLLATE NOCASE,
  role TEXT NOT NULL CHECK (role = 'admin'),
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending','accepted','revoked','expired')) DEFAULT 'pending',
  created_by TEXT NOT NULL REFERENCES fb_users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_by TEXT REFERENCES fb_users(id),
  accepted_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS fb_bot_invitations_bot_idx ON fb_bot_invitations(bot_id, status);

ALTER TABLE fb_memberships ADD COLUMN capabilities_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE fb_memberships ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE fb_memberships ADD COLUMN invited_by TEXT;
ALTER TABLE fb_memberships ADD COLUMN accepted_at TEXT;
ALTER TABLE fb_memberships ADD COLUMN revoked_at TEXT;

ALTER TABLE fb_discord_installations ADD COLUMN bot_id TEXT REFERENCES fb_bots(id);

-- ---------------------------------------------------------------------------
-- Collections: global platform collections and Bot-owned collections
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS fb_collections (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL CHECK (scope IN ('global','bot')),
  owner_tenant_id TEXT REFERENCES fb_tenants(id),
  logo_asset_id TEXT REFERENCES fb_assets(id),
  banner_asset_id TEXT REFERENCES fb_assets(id),
  logo_url TEXT,
  banner_url TEXT,
  accent TEXT NOT NULL DEFAULT 'brass',
  status TEXT NOT NULL CHECK (status IN ('draft','published','archived')) DEFAULT 'draft',
  sort INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS fb_collections_scope_slug_idx
  ON fb_collections(scope, COALESCE(owner_tenant_id, ''), slug)
  WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS fb_collection_cards (
  collection_id TEXT NOT NULL REFERENCES fb_collections(id),
  card_id TEXT NOT NULL REFERENCES fb_card_definitions(id),
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  sort INTEGER NOT NULL DEFAULT 0,
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (collection_id, card_id)
);
CREATE INDEX IF NOT EXISTS fb_collection_cards_card_idx ON fb_collection_cards(card_id);

CREATE TABLE IF NOT EXISTS fb_bot_collections (
  bot_id TEXT NOT NULL REFERENCES fb_bots(id),
  collection_id TEXT NOT NULL REFERENCES fb_collections(id),
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (bot_id, collection_id)
);

ALTER TABLE fb_card_definitions ADD COLUMN bio TEXT;
ALTER TABLE fb_card_definitions ADD COLUMN quote TEXT;
ALTER TABLE fb_card_definitions ADD COLUMN card_back_asset_id TEXT REFERENCES fb_assets(id);
ALTER TABLE fb_card_definitions ADD COLUMN visibility TEXT NOT NULL DEFAULT 'bot';
ALTER TABLE fb_pools ADD COLUMN collection_id TEXT REFERENCES fb_collections(id);

-- ---------------------------------------------------------------------------
-- Backfill bots, owners and the existing curated categories as global
-- collections. Existing inventory, serials and ledger rows are untouched.
-- ---------------------------------------------------------------------------

INSERT OR IGNORE INTO fb_bots (id, tenant_id, owner_user_id, slug, name, description, status, created_at, updated_at)
SELECT
  'bot_' || substr(hex(randomblob(8)), 1, 16),
  t.id,
  (SELECT m.user_id FROM fb_memberships m WHERE m.tenant_id = t.id AND m.role = 'owner' ORDER BY m.created_at LIMIT 1),
  'bot-' || lower(replace(t.slug, '_', '-')),
  t.name,
  t.tagline,
  'active',
  t.created_at,
  datetime('now')
FROM fb_tenants t
WHERE EXISTS (SELECT 1 FROM fb_memberships m WHERE m.tenant_id = t.id AND m.role = 'owner')
  AND NOT EXISTS (SELECT 1 FROM fb_bots b WHERE b.tenant_id = t.id);

INSERT OR IGNORE INTO fb_bot_admins (id, bot_id, user_id, role, capabilities_json, status, created_at, accepted_at)
SELECT
  'badm_' || substr(hex(randomblob(8)), 1, 16),
  b.id,
  b.owner_user_id,
  'owner',
  '["content","publish","economy","members","settings","inventory","grants"]',
  'active',
  b.created_at,
  b.created_at
FROM fb_bots b;

UPDATE fb_memberships
   SET capabilities_json = CASE role
       WHEN 'owner' THEN '["content","publish","economy","members","settings","inventory","grants"]'
       WHEN 'editor' THEN '["content","publish","members"]'
       WHEN 'economy_admin' THEN '["economy","inventory","grants"]'
       ELSE '[]'
     END,
       accepted_at = COALESCE(accepted_at, created_at)
 WHERE capabilities_json = '[]';

INSERT OR IGNORE INTO fb_collections
  (id, slug, name, description, scope, owner_tenant_id, logo_url, accent, status, sort, created_by, created_at, updated_at)
SELECT
  'col_' || c.id,
  c.slug,
  c.name,
  COALESCE(c.description, ''),
  'global',
  c.tenant_id,
  '/art/collections/' || c.slug || '.svg',
  CASE c.slug WHEN 'bubbles' THEN 'green' WHEN 'fighter' THEN 'oxblood' WHEN 'protocol-11' THEN 'brass' ELSE 'silver' END,
  'published',
  c.sort,
  COALESCE((SELECT m.user_id FROM fb_memberships m WHERE m.tenant_id = c.tenant_id AND m.role = 'owner' ORDER BY m.created_at LIMIT 1), 'system'),
  datetime('now'),
  datetime('now')
FROM fb_categories c
WHERE c.archived_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM fb_collections col WHERE col.slug = c.slug AND col.scope = 'global' AND col.owner_tenant_id = c.tenant_id);

INSERT OR IGNORE INTO fb_collection_cards (collection_id, card_id, tenant_id, sort, added_by, added_at)
SELECT
  col.id,
  cd.id,
  cd.tenant_id,
  0,
  col.created_by,
  datetime('now')
FROM fb_card_definitions cd
JOIN fb_categories c ON c.id = cd.category_id AND c.tenant_id = cd.tenant_id
JOIN fb_collections col ON col.slug = c.slug AND col.scope = 'global' AND col.owner_tenant_id = cd.tenant_id
WHERE cd.archived_at IS NULL;

UPDATE fb_card_definitions
   SET visibility = 'global'
 WHERE id IN (
   SELECT cc.card_id FROM fb_collection_cards cc
   JOIN fb_collections col ON col.id = cc.collection_id
   WHERE col.scope = 'global'
 );

INSERT OR IGNORE INTO fb_bot_collections (bot_id, collection_id, enabled, updated_at)
SELECT b.id, c.id, 1, datetime('now')
FROM fb_bots b CROSS JOIN fb_collections c
WHERE c.scope = 'global';

UPDATE fb_discord_installations
   SET bot_id = (SELECT b.id FROM fb_bots b WHERE b.tenant_id = fb_discord_installations.tenant_id)
 WHERE bot_id IS NULL;

-- A card that belongs to a collection can only drop when that Bot has at least
-- one of the card's collections enabled. Existing uncollected cards keep the
-- legacy behaviour, so this is additive to the pilot catalogue.
CREATE TRIGGER IF NOT EXISTS fb_draws_guard_collection
BEFORE INSERT ON fb_draws
WHEN EXISTS (
  SELECT 1 FROM fb_collection_cards cc WHERE cc.card_id = (SELECT card_id FROM fb_variants WHERE id = NEW.variant_id)
)
AND NOT EXISTS (
  SELECT 1 FROM fb_collection_cards cc
  JOIN fb_bot_collections bc ON bc.collection_id = cc.collection_id AND bc.enabled = 1
  JOIN fb_bots b ON b.id = bc.bot_id AND b.tenant_id = NEW.tenant_id
  WHERE cc.card_id = (SELECT card_id FROM fb_variants WHERE id = NEW.variant_id)
)
BEGIN
  SELECT RAISE(ABORT, 'collection_disabled');
END;

-- Global collections may contribute cards to a Bot pool. Bot-owned cards must
-- still belong to the Bot tenant.
DROP TRIGGER IF EXISTS fb_draws_guard_variant;
CREATE TRIGGER fb_draws_guard_variant
BEFORE INSERT ON fb_draws
WHEN NOT EXISTS (
  SELECT 1 FROM fb_pool_entries pe
  JOIN fb_variants v ON v.id = pe.variant_id
  JOIN fb_card_definitions cd ON cd.id = v.card_id
   WHERE pe.tenant_id = NEW.tenant_id AND pe.pool_id = NEW.pool_id
     AND pe.pool_revision = NEW.pool_revision AND pe.variant_id = NEW.variant_id
     AND pe.enabled = 1 AND v.status = 'published' AND v.archived_at IS NULL
     AND cd.status = 'published' AND cd.archived_at IS NULL
     AND (
       (v.tenant_id = NEW.tenant_id AND cd.tenant_id = NEW.tenant_id)
       OR EXISTS (
         SELECT 1 FROM fb_collection_cards cc
         JOIN fb_collections c ON c.id = cc.collection_id
         WHERE cc.card_id = cd.id AND c.scope = 'global' AND c.status = 'published'
           AND c.owner_tenant_id = v.tenant_id
       )
     )
)
BEGIN
  SELECT RAISE(ABORT, 'variant_unavailable');
END;
