-- Additive print-proposal and review layer for multi-print subjects.
--
-- A proposal is NOT a second catalogue. It references the existing subject
-- (fb_card_definitions) and existing approved assets (fb_assets). It never owns
-- a copy, serial, wallet entry or ledger row; issued copies remain exclusively
-- in fb_card_instances and the existing award tables.
--
-- Approval links a proposal to one existing artwork edition. The edition row is
-- never rewritten by this layer: fb_artwork_editions, fb_variants and every
-- historical render/award stay authoritative for collectable prints and finishes.

CREATE TABLE IF NOT EXISTS fb_print_proposals (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  card_id TEXT NOT NULL REFERENCES fb_card_definitions(id),
  print_number TEXT NOT NULL,
  print_key TEXT NOT NULL,
  role TEXT NOT NULL CHECK (
    role IN (
      'portrait',
      'action_scene',
      'alternate_art',
      'special_release',
      'ensemble',
      'location',
      'object',
      'other'
    )
  ),
  title TEXT NOT NULL,
  creative_direction TEXT NOT NULL,
  source_asset_id TEXT NOT NULL REFERENCES fb_assets(id),
  artwork_asset_id TEXT REFERENCES fb_assets(id),
  background_asset_id TEXT REFERENCES fb_assets(id),
  rights_note TEXT,
  source_refs_json TEXT NOT NULL DEFAULT '[]',
  provenance_json TEXT NOT NULL DEFAULT '{}',
  finish_keys_json TEXT NOT NULL DEFAULT '["plain"]',
  status TEXT NOT NULL CHECK (status IN ('draft','proposed','approved','rejected')) DEFAULT 'draft',
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_by TEXT NOT NULL REFERENCES fb_users(id),
  reviewed_by TEXT REFERENCES fb_users(id),
  reviewed_at TEXT,
  review_note TEXT,
  approved_edition_id TEXT REFERENCES fb_artwork_editions(id),
  approved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, card_id, print_number),
  UNIQUE (tenant_id, print_key)
);

CREATE INDEX IF NOT EXISTS fb_print_proposals_card_idx
  ON fb_print_proposals(tenant_id, card_id, status, print_number);

CREATE INDEX IF NOT EXISTS fb_print_proposals_status_idx
  ON fb_print_proposals(tenant_id, status, updated_at DESC);

-- One artwork edition can be linked to at most one approved proposal. NULL
-- proposal links are ignored, so existing editions remain unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS fb_print_proposals_edition_idx
  ON fb_print_proposals(tenant_id, approved_edition_id)
  WHERE approved_edition_id IS NOT NULL;

-- Append-only review history. The current proposal row is the working state;
-- this table is the auditable record of submissions, rejections and approvals.
CREATE TABLE IF NOT EXISTS fb_print_proposal_reviews (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  proposal_id TEXT NOT NULL REFERENCES fb_print_proposals(id),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  decision TEXT NOT NULL CHECK (decision IN ('submitted','revised','approved','rejected','linked')),
  reviewer_id TEXT NOT NULL REFERENCES fb_users(id),
  note TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, proposal_id, revision)
);

CREATE INDEX IF NOT EXISTS fb_print_proposal_reviews_proposal_idx
  ON fb_print_proposal_reviews(tenant_id, proposal_id, created_at DESC);
