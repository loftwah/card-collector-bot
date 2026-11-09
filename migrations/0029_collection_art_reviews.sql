-- Append-only collection artwork decisions. This is evidence only: it never
-- changes collection metadata, asset visibility, distribution or publication.
CREATE TABLE IF NOT EXISTS fb_collection_art_reviews (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  collection_id TEXT NOT NULL REFERENCES fb_collections(id),
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'agent')),
  actor_id TEXT NOT NULL,
  represented_user_id TEXT NOT NULL REFERENCES fb_users(id),
  mark_asset_id TEXT NOT NULL REFERENCES fb_assets(id),
  mark_sha256 TEXT NOT NULL CHECK (length(mark_sha256) = 64),
  cover_asset_id TEXT NOT NULL REFERENCES fb_assets(id),
  cover_sha256 TEXT NOT NULL CHECK (length(cover_sha256) = 64),
  back_asset_id TEXT NOT NULL REFERENCES fb_assets(id),
  back_sha256 TEXT NOT NULL CHECK (length(back_sha256) = 64),
  evidence_asset_id TEXT NOT NULL REFERENCES fb_assets(id),
  evidence_sha256 TEXT NOT NULL CHECK (length(evidence_sha256) = 64),
  note TEXT NOT NULL,
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS fb_collection_art_reviews_collection_idx
  ON fb_collection_art_reviews(tenant_id, collection_id, created_at);
CREATE TRIGGER IF NOT EXISTS fb_collection_art_reviews_no_update
  BEFORE UPDATE ON fb_collection_art_reviews BEGIN SELECT RAISE(ABORT, 'collection artwork reviews are immutable'); END;
CREATE TRIGGER IF NOT EXISTS fb_collection_art_reviews_no_delete
  BEFORE DELETE ON fb_collection_art_reviews BEGIN SELECT RAISE(ABORT, 'collection artwork reviews are immutable'); END;
