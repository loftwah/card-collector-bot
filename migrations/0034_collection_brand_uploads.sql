-- A reservation tracks an isolated staged object through an atomic D1 receipt.
-- Existing assets and objects are deliberately untouched.
CREATE TABLE IF NOT EXISTS fb_collection_brand_uploads (
  tenant_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  upload_scope TEXT NOT NULL DEFAULT 'bot' CHECK(upload_scope IN ('global','bot')),
  asset_id TEXT NOT NULL UNIQUE,
  r2_key TEXT NOT NULL UNIQUE,
  object_version TEXT,
  object_etag TEXT,
  content_sha256 TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending','completed','abandoned')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id,actor_type,actor_id,idempotency_key)
);

-- A review is tied to a specific current collection revision and stored bytes.
CREATE TABLE IF NOT EXISTS fb_collection_brand_releases (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  collection_id TEXT NOT NULL,
  collection_version INTEGER NOT NULL,
  asset_id TEXT NOT NULL,
  object_version TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  asset_revision INTEGER NOT NULL,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  role TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fb_brand_url_dirty (collection_id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS fb_brand_url_refs (
  collection_id TEXT NOT NULL,
  slot TEXT NOT NULL CHECK(slot IN ('logo','banner','back')),
  asset_id TEXT NOT NULL,
  tracked INTEGER NOT NULL CHECK(tracked IN (0,1)),
  PRIMARY KEY(collection_id,slot)
);
CREATE INDEX IF NOT EXISTS fb_brand_url_refs_asset ON fb_brand_url_refs(asset_id,tracked);
CREATE TABLE IF NOT EXISTS fb_brand_url_corrections (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL,
  slot TEXT NOT NULL,
  previous_url TEXT NOT NULL,
  previous_asset_id TEXT,
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fb_brand_index_rebuilds (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('pending','completed')),
  started_by TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS fb_brand_index_one_pending ON fb_brand_index_rebuilds(status) WHERE status='pending';
INSERT OR IGNORE INTO fb_brand_url_dirty(collection_id) SELECT id FROM fb_collections;
CREATE TRIGGER IF NOT EXISTS fb_brand_urls_insert AFTER INSERT ON fb_collections BEGIN
  INSERT OR IGNORE INTO fb_brand_url_dirty(collection_id) VALUES (NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS fb_brand_urls_update AFTER UPDATE OF id,logo_url,banner_url,back_url,logo_asset_id,banner_asset_id ON fb_collections
WHEN OLD.id IS NOT NEW.id OR OLD.logo_url IS NOT NEW.logo_url OR OLD.banner_url IS NOT NEW.banner_url OR OLD.back_url IS NOT NEW.back_url OR OLD.logo_asset_id IS NOT NEW.logo_asset_id OR OLD.banner_asset_id IS NOT NEW.banner_asset_id BEGIN
  INSERT OR IGNORE INTO fb_brand_url_dirty(collection_id) VALUES (OLD.id);
  INSERT OR IGNORE INTO fb_brand_url_dirty(collection_id) VALUES (NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS fb_brand_urls_delete AFTER DELETE ON fb_collections BEGIN
  INSERT OR IGNORE INTO fb_brand_url_dirty(collection_id) VALUES (OLD.id);
END;

