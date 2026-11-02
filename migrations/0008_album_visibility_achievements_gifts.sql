-- Foilbury album increment: explicit viewing audience, asset access, richer
-- profiles, achievements, scoped gifts and a generous main-album economy.
--
-- Additive only. Existing accounts, memberships, cards, variants, serials,
-- instances, wallets and ledger rows are preserved. "Global", "published" and
-- "public" remain three separate dimensions.

-- ---------------------------------------------------------------------------
-- Collections: lifecycle, viewing audience and public approval are separate.
-- ---------------------------------------------------------------------------

ALTER TABLE fb_collections ADD COLUMN view_audience TEXT NOT NULL DEFAULT 'members'
  CHECK (view_audience IN ('public','members','private'));
ALTER TABLE fb_collections ADD COLUMN public_approved_at TEXT;
ALTER TABLE fb_collections ADD COLUMN public_approved_by TEXT;
ALTER TABLE fb_collections ADD COLUMN source_work TEXT;
ALTER TABLE fb_collections ADD COLUMN source_context TEXT;
ALTER TABLE fb_collections ADD COLUMN content_advisory TEXT;
ALTER TABLE fb_collections ADD COLUMN release_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE fb_collections ADD COLUMN released_at TEXT;
ALTER TABLE fb_collections ADD COLUMN provenance_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE fb_collections ADD COLUMN featured INTEGER NOT NULL DEFAULT 0;
ALTER TABLE fb_collections ADD COLUMN back_url TEXT;

CREATE INDEX IF NOT EXISTS fb_collections_audience_idx
  ON fb_collections(view_audience, status, archived_at);

-- Explicit private-sharing grants. A private collection is visible only to
-- its owner scope, platform Super Admins and the users listed here.
CREATE TABLE IF NOT EXISTS fb_collection_viewers (
  collection_id TEXT NOT NULL REFERENCES fb_collections(id),
  user_id TEXT NOT NULL REFERENCES fb_users(id),
  granted_by TEXT NOT NULL REFERENCES fb_users(id),
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY (collection_id, user_id)
);
CREATE INDEX IF NOT EXISTS fb_collection_viewers_user_idx
  ON fb_collection_viewers(user_id, revoked_at);

-- ---------------------------------------------------------------------------
-- Assets: delivery classification, provenance and derivative records.
-- ---------------------------------------------------------------------------

ALTER TABLE fb_assets ADD COLUMN access_classification TEXT NOT NULL DEFAULT 'private'
  CHECK (access_classification IN ('public','member','private'));
ALTER TABLE fb_assets ADD COLUMN role TEXT;
ALTER TABLE fb_assets ADD COLUMN processing_state TEXT NOT NULL DEFAULT 'ready'
  CHECK (processing_state IN ('staged','processing','ready','failed','quarantined'));
ALTER TABLE fb_assets ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE fb_assets ADD COLUMN derivative_of_asset_id TEXT REFERENCES fb_assets(id);
ALTER TABLE fb_assets ADD COLUMN dependencies_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE fb_assets ADD COLUMN provenance_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE fb_assets ADD COLUMN official INTEGER NOT NULL DEFAULT 0;
ALTER TABLE fb_assets ADD COLUMN review_status TEXT NOT NULL DEFAULT 'unreviewed'
  CHECK (review_status IN ('unreviewed','reviewed','approved','rejected','placeholder'));

CREATE INDEX IF NOT EXISTS fb_assets_access_idx
  ON fb_assets(access_classification, processing_state, archived_at);

CREATE TABLE IF NOT EXISTS fb_asset_derivatives (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  source_asset_id TEXT NOT NULL REFERENCES fb_assets(id),
  size_key TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  mime TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ready','failed','stale')) DEFAULT 'ready',
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, source_asset_id, size_key)
);
CREATE INDEX IF NOT EXISTS fb_asset_derivatives_source_idx
  ON fb_asset_derivatives(source_asset_id, status);

CREATE TABLE IF NOT EXISTS fb_variant_back_renders (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  variant_id TEXT NOT NULL REFERENCES fb_variants(id),
  recipe_id TEXT NOT NULL REFERENCES fb_recipes(id),
  asset_id TEXT NOT NULL REFERENCES fb_assets(id),
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','published','retired')) DEFAULT 'draft',
  created_at TEXT NOT NULL,
  published_at TEXT,
  UNIQUE (tenant_id, variant_id, recipe_id)
);
CREATE INDEX IF NOT EXISTS fb_variant_back_renders_variant_idx
  ON fb_variant_back_renders(tenant_id, variant_id, status);

-- ---------------------------------------------------------------------------
-- Card / subject profiles: editorial layers, spoilers and typed attributes.
-- ---------------------------------------------------------------------------

ALTER TABLE fb_card_definitions ADD COLUMN bio_safe TEXT;
ALTER TABLE fb_card_definitions ADD COLUMN spoiler_level INTEGER NOT NULL DEFAULT 0
  CHECK (spoiler_level IN (0,1,2,3));
ALTER TABLE fb_card_definitions ADD COLUMN spoiler_bio TEXT;
ALTER TABLE fb_card_definitions ADD COLUMN attributes_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE fb_card_definitions ADD COLUMN source_refs_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE fb_card_definitions ADD COLUMN review_status TEXT NOT NULL DEFAULT 'unreviewed'
  CHECK (review_status IN ('unreviewed','draft','reviewed','approved','rejected','placeholder'));
ALTER TABLE fb_card_definitions ADD COLUMN source_work TEXT;
ALTER TABLE fb_card_definitions ADD COLUMN adaptation_boundary TEXT;
ALTER TABLE fb_card_definitions ADD COLUMN editorial_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE fb_card_definitions ADD COLUMN released_at TEXT;

CREATE INDEX IF NOT EXISTS fb_card_definitions_review_idx
  ON fb_card_definitions(tenant_id, review_status, status);

CREATE TABLE IF NOT EXISTS fb_card_relations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  card_id TEXT NOT NULL REFERENCES fb_card_definitions(id),
  related_card_id TEXT REFERENCES fb_card_definitions(id),
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS fb_card_relations_card_idx
  ON fb_card_relations(tenant_id, card_id);

ALTER TABLE fb_categories ADD COLUMN icon_url TEXT;
ALTER TABLE fb_categories ADD COLUMN spoiler_level INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- Membership admissions and revocation history. The ordinary membership table
-- stays authoritative; this records why access changed.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS fb_membership_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  user_id TEXT NOT NULL REFERENCES fb_users(id),
  event TEXT NOT NULL CHECK (event IN ('joined','approved','suspended','revoked','restored','role_changed')),
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  reason TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS fb_membership_events_user_idx
  ON fb_membership_events(tenant_id, user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Trusted domain events and achievements.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS fb_domain_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  user_id TEXT REFERENCES fb_users(id),
  event_type TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS fb_domain_events_user_idx
  ON fb_domain_events(tenant_id, user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS fb_achievement_definitions (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('platform','bot')),
  tenant_id TEXT REFERENCES fb_tenants(id),
  key TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  criteria_json TEXT NOT NULL,
  reward_json TEXT NOT NULL DEFAULT '{}',
  visibility TEXT NOT NULL CHECK (visibility IN ('public','member','private')) DEFAULT 'member',
  art_key TEXT NOT NULL DEFAULT 'medal-generic',
  category TEXT NOT NULL DEFAULT 'milestone',
  sort INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('draft','active','retired')) DEFAULT 'draft',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS fb_achievement_definitions_key_idx
  ON fb_achievement_definitions(scope, COALESCE(tenant_id, ''), key, version)
  WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS fb_achievement_definitions_active_idx
  ON fb_achievement_definitions(scope, status, sort);

CREATE TABLE IF NOT EXISTS fb_achievement_progress (
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  user_id TEXT NOT NULL REFERENCES fb_users(id),
  achievement_id TEXT NOT NULL REFERENCES fb_achievement_definitions(id),
  achievement_version INTEGER NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  target INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL CHECK (state IN ('locked','in_progress','earned')) DEFAULT 'locked',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, user_id, achievement_id, achievement_version)
);
CREATE INDEX IF NOT EXISTS fb_achievement_progress_user_idx
  ON fb_achievement_progress(tenant_id, user_id, state);

CREATE TABLE IF NOT EXISTS fb_achievement_unlocks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  user_id TEXT NOT NULL REFERENCES fb_users(id),
  achievement_id TEXT NOT NULL REFERENCES fb_achievement_definitions(id),
  achievement_version INTEGER NOT NULL,
  event_id TEXT REFERENCES fb_domain_events(id),
  earned_at TEXT NOT NULL,
  reward_state TEXT NOT NULL CHECK (reward_state IN ('none','pending','granted','failed')) DEFAULT 'none',
  reward_amount INTEGER NOT NULL DEFAULT 0,
  reward_ledger_id TEXT,
  notification_state TEXT NOT NULL CHECK (notification_state IN ('pending','sent','suppressed','failed')) DEFAULT 'pending',
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, user_id, achievement_id, achievement_version)
);
CREATE INDEX IF NOT EXISTS fb_achievement_unlocks_user_idx
  ON fb_achievement_unlocks(tenant_id, user_id, earned_at DESC);

-- ---------------------------------------------------------------------------
-- Scoped administrator gifts. A campaign is the durable idempotency boundary;
-- each recipient award is a separate, retry-safe ledger/card operation.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS fb_gift_campaigns (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  bot_id TEXT REFERENCES fb_bots(id),
  created_by TEXT NOT NULL REFERENCES fb_users(id),
  kind TEXT NOT NULL CHECK (kind IN ('foil','card','opening')),
  scope TEXT NOT NULL CHECK (scope IN ('single','recipients','bot_members','platform_members')),
  recipient_rule_json TEXT NOT NULL DEFAULT '{}',
  item_json TEXT NOT NULL DEFAULT '{}',
  message TEXT,
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('previewed','sending','completed','partial','failed','cancelled')) DEFAULT 'previewed',
  expected_recipients INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS fb_gift_campaigns_tenant_idx
  ON fb_gift_campaigns(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS fb_gift_campaigns_bot_idx
  ON fb_gift_campaigns(bot_id, created_at DESC);

CREATE TABLE IF NOT EXISTS fb_gift_awards (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES fb_gift_campaigns(id),
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  user_id TEXT NOT NULL REFERENCES fb_users(id),
  kind TEXT NOT NULL CHECK (kind IN ('foil','card','opening')),
  amount INTEGER NOT NULL DEFAULT 0,
  card_id TEXT REFERENCES fb_card_definitions(id),
  instance_id TEXT REFERENCES fb_card_instances(id),
  ledger_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','delivered','failed')) DEFAULT 'pending',
  error TEXT,
  receipt_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  UNIQUE (campaign_id, user_id)
);
CREATE INDEX IF NOT EXISTS fb_gift_awards_user_idx
  ON fb_gift_awards(tenant_id, user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Main-album economy defaults. Only the explicitly named main album is tuned;
-- creator Bot configurations are left untouched. Versioned and audited.
-- ---------------------------------------------------------------------------

UPDATE fb_economy_settings
   SET starter_grant = 800,
       daily_reward = 480,
       daily_cooldown_seconds = 86400,
       version = version + 1,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       updated_by = 'migration:0008'
 WHERE tenant_id = (SELECT id FROM fb_tenants WHERE slug = 'cabinet');

INSERT INTO fb_audit_events
  (id, tenant_id, actor_type, actor_id, represented_user_id, action, object_type, object_id,
   metadata_json, request_id, created_at)
SELECT 'aud_econ_0008', t.id, 'system', 'migration:0008', NULL, 'economy.updated', 'economy', t.id,
       '{"reason":"generous free-play defaults","starter_grant":800,"daily_reward":480,"daily_cooldown_seconds":86400,"version_before":1}',
       'migration:0008', strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM fb_tenants t
 WHERE t.slug = 'cabinet'
   AND NOT EXISTS (SELECT 1 FROM fb_audit_events a WHERE a.id = 'aud_econ_0008');

-- ---------------------------------------------------------------------------
-- Existing Loftwah-owned project collections are approved for the public
-- showcase. "Shared Characters" contains the same original cast, so it is
-- included deliberately rather than inferred from a scope label.
-- ---------------------------------------------------------------------------

UPDATE fb_collections
   SET view_audience = 'public',
       public_approved_at = COALESCE(public_approved_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
       public_approved_by = COALESCE(public_approved_by, 'usr_prod_owner')
 WHERE slug IN ('bubbles','fighter','protocol-11','shared')
   AND scope = 'global'
   AND owner_tenant_id = (SELECT id FROM fb_tenants WHERE slug = 'cabinet');

-- Delivery classification for existing published renders. A card is public
-- only when every collection it belongs to is public-approved. Otherwise its
-- render stays member-only. Source layers remain private.
UPDATE fb_assets
   SET access_classification = 'member'
 WHERE visibility = 'public_export';

UPDATE fb_assets
   SET access_classification = 'private'
 WHERE visibility = 'private';

UPDATE fb_assets
   SET access_classification = 'public'
 WHERE access_classification = 'member'
   AND id IN (SELECT vr.asset_id FROM fb_variant_renders vr WHERE vr.status = 'published')
   AND NOT EXISTS (
     SELECT 1
       FROM fb_variant_renders vr2
       JOIN fb_variants v ON v.id = vr2.variant_id
       JOIN fb_collection_cards cc ON cc.card_id = v.card_id
       JOIN fb_collections c ON c.id = cc.collection_id
      WHERE vr2.asset_id = fb_assets.id
        AND c.archived_at IS NULL
        AND c.view_audience <> 'public'
   );

-- Seed the platform achievement suite. Criteria are versioned and never
-- rewritten in place; a later definition version is a new row.
INSERT OR IGNORE INTO fb_achievement_definitions
  (id, scope, tenant_id, key, version, name, description, criteria_json, reward_json, visibility, art_key, category, sort, status, created_by, created_at, updated_at)
VALUES
  ('ach_first_card', 'platform', NULL, 'first-card', 1,
   'The first one is always special', 'Open your first card and give it a home in your album.',
   '{"type":"unique_cards","target":1}',
   '{"foil":160}', 'member', 'medal-first', 'milestone', 10, 'active', 'system',
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('ach_unique_10', 'platform', NULL, 'ten-different', 1,
   'A real collection', 'Collect 10 different subjects.',
   '{"type":"unique_cards","target":10}',
   '{"foil":240}', 'member', 'medal-shelf', 'milestone', 20, 'active', 'system',
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('ach_unique_25', 'platform', NULL, 'twenty-five-different', 1,
   'Cabinet full of stories', 'Collect 25 different subjects.',
   '{"type":"unique_cards","target":25}',
   '{"foil":400}', 'member', 'medal-cabinet', 'milestone', 30, 'active', 'system',
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('ach_unique_50', 'platform', NULL, 'fifty-different', 1,
   'The long shelf', 'Collect 50 different subjects.',
   '{"type":"unique_cards","target":50}',
   '{"foil":800}', 'member', 'medal-long-shelf', 'milestone', 40, 'active', 'system',
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('ach_first_silver', 'platform', NULL, 'first-silver', 1,
   'A little moonlight', 'Find your first Silver finish.',
   '{"type":"finish_first","materials":["silver"]}',
   '{"foil":160}', 'member', 'medal-silver', 'finish', 50, 'active', 'system',
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('ach_first_gold', 'platform', NULL, 'first-gold', 1,
   'Warm metal', 'Find your first Gold finish.',
   '{"type":"finish_first","materials":["gold"]}',
   '{"foil":240}', 'member', 'medal-gold', 'finish', 60, 'active', 'system',
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('ach_first_holo', 'platform', NULL, 'first-holographic', 1,
   'Hold it to the light', 'Find your first Holographic finish.',
   '{"type":"finish_first","materials":["diamond"],"effects":["holographic"]}',
   '{"foil":400}', 'member', 'medal-holo', 'finish', 70, 'active', 'system',
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('ach_finish_set', 'platform', NULL, 'core-finish-set', 1,
   'The same card, four ways', 'Own Plain, Silver, Gold and Holographic versions of one subject.',
   '{"type":"finish_set","materials":["plain","silver","gold","diamond"],"effects":["holographic"]}',
   '{"foil":480}', 'member', 'medal-quartet', 'finish', 80, 'active', 'system',
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('ach_explore_3', 'platform', NULL, 'three-worlds', 1,
   'Three worlds in', 'Explore three collections you can access.',
   '{"type":"explore_collections","target":3}',
   '{"foil":240}', 'member', 'medal-compass', 'explore', 90, 'active', 'system',
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('ach_explore_8', 'platform', NULL, 'eight-worlds', 1,
   'A well-travelled album', 'Explore eight collections you can access.',
   '{"type":"explore_collections","target":8}',
   '{"foil":560}', 'member', 'medal-atlas', 'explore', 100, 'active', 'system',
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('ach_gift_received', 'platform', NULL, 'a-note-in-the-post', 1,
   'A note in the post', 'Receive a gift from a Foilbury administrator.',
   '{"type":"gift_received","target":1}',
   '{"foil":0}', 'member', 'medal-parcel', 'community', 110, 'active', 'system',
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
