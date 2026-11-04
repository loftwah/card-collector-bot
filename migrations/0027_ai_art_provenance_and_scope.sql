-- Artwork provenance, per-Bot AI artwork preference and installation-scoped
-- Discord collection scope.
--
-- The catalogue already records free-form provenance on assets. This migration
-- makes the AI boundary a typed, enforceable property so a Bot can exclude
-- AI-assisted artwork without losing historical inventory, achievements or
-- already-issued copies. Existing data is backfilled from the recorded
-- provenance/credit fields; assets that cannot be classified stay 'unknown'
-- and are reported by scripts/art-provenance-audit.mjs rather than guessed.

ALTER TABLE fb_assets ADD COLUMN origin TEXT NOT NULL DEFAULT 'unknown'
  CHECK (origin IN ('sourced','foilbury_original','ai_assisted','ai_generated','derived','unknown'));
ALTER TABLE fb_assets ADD COLUMN generation_json TEXT;

CREATE INDEX IF NOT EXISTS idx_fb_assets_origin ON fb_assets(tenant_id, origin);

-- The Bot is the scope at which a Discord installation, website cabinet, API
-- grant and draw pool agree. New Bots start with AI artwork excluded; the Bot
-- Owner can opt in from the admin surface.
ALTER TABLE fb_bots ADD COLUMN ai_art_enabled INTEGER NOT NULL DEFAULT 0;

-- NULL means "inherit the Bot's enabled collections". An explicit array is a
-- server-scoped allowlist; an empty array is intentionally empty and fails
-- closed instead of falling back to every global collection.
ALTER TABLE fb_discord_installations ADD COLUMN collection_allowlist_json TEXT;
ALTER TABLE fb_discord_installations ADD COLUMN configuration_revision INTEGER NOT NULL DEFAULT 1;

-- Durable state for the persistent Discord demonstration. The channel messages
-- are the product; this table keeps the run, configuration digest, stage status
-- and message ids recoverable across an interrupted publisher process.
CREATE TABLE IF NOT EXISTS fb_discord_demo_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  installation_id TEXT NOT NULL REFERENCES fb_discord_installations(id),
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES fb_users(id),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('demo','owner')),
  actor_label TEXT NOT NULL,
  collection_id TEXT,
  collection_slug TEXT,
  collection_release_version INTEGER,
  scope_digest TEXT,
  source_sha TEXT,
  worker_version TEXT,
  status TEXT NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned','running','completed','interrupted','failed')),
  stages_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fb_discord_demo_runs_channel
  ON fb_discord_demo_runs(guild_id, channel_id, created_at);

-- Deterministic, source-backed classifications. Rendering is a deterministic
-- derivative of the subject/background/recipe, not a generated original.
UPDATE fb_assets SET origin = 'derived' WHERE kind = 'render';
UPDATE fb_assets SET origin = 'foilbury_original' WHERE kind = 'brand';

-- Franchise member albums use a publicly published reference image with a
-- recorded source and rights note. The card design and finishes are Foilbury
-- originals; the subject layer is a sourced reference.
UPDATE fb_assets
   SET origin = 'sourced'
 WHERE kind IN ('subject','background')
   AND (provenance_json LIKE '%Sourced subject image%'
        OR provenance_json LIKE '%sourced from%'
        OR credit LIKE '%sourced from%');

-- The paid AI-assisted print set stored its structured record as a nested JSON
-- string. Promote it to a first-class generation record and repair the outer
-- provenance object so provider/model/request are queryable.
UPDATE fb_assets
   SET generation_json = json_extract(provenance_json, '$.note'),
       provenance_json = json_extract(provenance_json, '$.note'),
       origin = 'ai_assisted'
 WHERE json_valid(json_extract(provenance_json, '$.note'))
   AND (json_extract(provenance_json, '$.note') LIKE '%"provider":"fal.ai"%'
        OR json_extract(provenance_json, '$.note') LIKE '%"provider":"openai"%'
        OR json_extract(provenance_json, '$.note') LIKE '%AI-assisted%'
        OR json_extract(provenance_json, '$.note') LIKE '%AI-generated%');

-- Owner-supplied original-IP showcase assets have a credit but no structured
-- provenance. Keep them 'unknown' rather than infer authorship; they are
-- labelled as provenance review outstanding until the owner confirms.
UPDATE fb_assets
   SET origin = 'unknown'
 WHERE origin = 'unknown'
   AND kind IN ('subject','background')
   AND credit IS NOT NULL
   AND credit <> '';
