-- Foilbury Art Lab.
--
-- One operator-only review surface for card art and brand art. Briefs own the
-- intent and spend ceiling; jobs own a bounded generation request; candidates
-- are immutable outputs with feedback and a separate approval/publication step.
-- Whole-card AI is a first-class method. The shared card renderer is one method
-- among several, not a mandatory gate.

CREATE TABLE IF NOT EXISTS fb_art_briefs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  category TEXT NOT NULL,
  collection_id TEXT,
  card_id TEXT,
  target_variant_id TEXT,
  title TEXT NOT NULL,
  intent TEXT NOT NULL,
  references_json TEXT NOT NULL DEFAULT '[]',
  audience TEXT NOT NULL DEFAULT 'members',
  status TEXT NOT NULL DEFAULT 'draft',
  candidate_count INTEGER NOT NULL DEFAULT 6,
  provider TEXT NOT NULL DEFAULT 'fal',
  model TEXT NOT NULL,
  methods_json TEXT NOT NULL DEFAULT '["whole_card"]',
  output_sizes_json TEXT NOT NULL DEFAULT '[]',
  notes TEXT,
  cost_cap_cents INTEGER NOT NULL DEFAULT 200,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS fb_art_briefs_tenant_idx
  ON fb_art_briefs(tenant_id, category, status, updated_at);

CREATE TABLE IF NOT EXISTS fb_art_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  brief_id TEXT NOT NULL REFERENCES fb_art_briefs(id),
  method TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt TEXT NOT NULL,
  count INTEGER NOT NULL,
  size TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  cost_estimate_cents INTEGER NOT NULL DEFAULT 0,
  cost_actual_cents INTEGER,
  cost_source TEXT,
  error TEXT,
  created_by TEXT NOT NULL,
  claimed_by TEXT,
  claimed_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS fb_art_jobs_queue_idx
  ON fb_art_jobs(tenant_id, status, created_at);
CREATE INDEX IF NOT EXISTS fb_art_jobs_brief_idx
  ON fb_art_jobs(brief_id, created_at);

CREATE TABLE IF NOT EXISTS fb_art_candidates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  brief_id TEXT NOT NULL REFERENCES fb_art_briefs(id),
  job_id TEXT NOT NULL REFERENCES fb_art_jobs(id),
  asset_id TEXT NOT NULL REFERENCES fb_assets(id),
  render_asset_id TEXT,
  render_back_asset_id TEXT,
  master_asset_id TEXT,
  preview_400_asset_id TEXT,
  thumb_128_asset_id TEXT,
  label TEXT NOT NULL,
  method TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt TEXT NOT NULL,
  seed TEXT,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  audience TEXT NOT NULL DEFAULT 'members',
  official INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'generated',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS fb_art_candidates_brief_idx
  ON fb_art_candidates(brief_id, status, created_at);
CREATE INDEX IF NOT EXISTS fb_art_candidates_job_idx
  ON fb_art_candidates(job_id);

CREATE TABLE IF NOT EXISTS fb_art_feedback (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  candidate_id TEXT NOT NULL REFERENCES fb_art_candidates(id),
  author_user_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  body TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS fb_art_feedback_candidate_idx
  ON fb_art_feedback(candidate_id, created_at);

CREATE TABLE IF NOT EXISTS fb_art_approvals (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  brief_id TEXT NOT NULL REFERENCES fb_art_briefs(id),
  candidate_id TEXT NOT NULL REFERENCES fb_art_candidates(id),
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  usage TEXT NOT NULL,
  notes TEXT,
  vector_ref TEXT,
  target_kind TEXT,
  target_id TEXT,
  published_asset_id TEXT,
  previous_state_json TEXT NOT NULL DEFAULT '{}',
  published_at TEXT,
  published_by TEXT,
  revoked_at TEXT,
  revoked_by TEXT,
  rollback_at TEXT,
  rollback_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS fb_art_approvals_candidate_idx
  ON fb_art_approvals(candidate_id, approved_at);
CREATE INDEX IF NOT EXISTS fb_art_approvals_brief_idx
  ON fb_art_approvals(brief_id, revoked_at, published_at);

-- Durable spend ledger view: jobs are the source of truth. Failed jobs still
-- count their recorded actual spend, so a provider error cannot hide a charge.
CREATE VIEW IF NOT EXISTS fb_art_spend AS
SELECT tenant_id,
       substr(created_at, 1, 10) AS spend_day,
       SUM(CASE
             WHEN status = 'cancelled' THEN 0
             WHEN cost_actual_cents IS NOT NULL THEN cost_actual_cents
             ELSE cost_estimate_cents
           END) AS spend_cents
  FROM fb_art_jobs
 GROUP BY tenant_id, substr(created_at, 1, 10);
