-- New protocol state only. Existing render jobs, assets and approvals remain intact.
-- Operator rows must be explicitly provisioned by a trusted administrator; no
-- credential is designated by this migration.
CREATE TABLE fb_render_operators (
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  grant_id TEXT NOT NULL REFERENCES fb_agent_grants(id),
  token_id TEXT NOT NULL REFERENCES fb_agent_tokens(id),
  token_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','revoked')),
  created_by TEXT NOT NULL REFERENCES fb_users(id),
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY (tenant_id, grant_id, token_id)
);
CREATE TABLE fb_bound_render_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  idempotency_key TEXT NOT NULL,
  manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
  manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256)=64),
  operator_grant_id TEXT NOT NULL,
  operator_token_id TEXT NOT NULL,
  operator_token_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','running','awaiting_review','approved','rejected','succeeded','failed')),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt>=0),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id,idempotency_key),
  FOREIGN KEY (tenant_id,operator_grant_id,operator_token_id)
    REFERENCES fb_render_operators(tenant_id,grant_id,token_id)
);
CREATE UNIQUE INDEX fb_bound_render_one_active_variant ON fb_bound_render_jobs(tenant_id,json_extract(manifest_json,'$.variantId'))
  WHERE status IN ('pending','running','awaiting_review','approved');
CREATE TABLE fb_bound_render_candidates (
  job_id TEXT NOT NULL REFERENCES fb_bound_render_jobs(id),
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  attempt INTEGER NOT NULL CHECK (attempt>0),
  side TEXT NOT NULL CHECK (side IN ('front','back')),
  r2_key TEXT NOT NULL,
  object_version TEXT NOT NULL,
  object_etag TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256)=64),
  bytes INTEGER NOT NULL CHECK (bytes>0),
  mime TEXT NOT NULL CHECK (mime IN ('image/png','image/webp')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (job_id,attempt,side)
);
CREATE TABLE fb_bound_render_reviews (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  job_id TEXT NOT NULL REFERENCES fb_bound_render_jobs(id),
  attempt INTEGER NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
  manifest_sha256 TEXT NOT NULL,
  front_sha256 TEXT NOT NULL,
  back_sha256 TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user','agent')),
  actor_id TEXT NOT NULL,
  represented_user_id TEXT NOT NULL REFERENCES fb_users(id),
  note TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (job_id,attempt)
);
CREATE TRIGGER fb_bound_render_job_identity_immutable BEFORE UPDATE OF
  tenant_id,idempotency_key,manifest_json,manifest_sha256,operator_grant_id,operator_token_id,operator_token_hash
  ON fb_bound_render_jobs BEGIN SELECT RAISE(ABORT,'bound render identity is immutable'); END;
CREATE TRIGGER fb_bound_render_candidate_immutable_update BEFORE UPDATE ON fb_bound_render_candidates
  BEGIN SELECT RAISE(ABORT,'bound render candidate is immutable'); END;
CREATE TRIGGER fb_bound_render_candidate_immutable_delete BEFORE DELETE ON fb_bound_render_candidates
  BEGIN SELECT RAISE(ABORT,'bound render candidate is immutable'); END;
CREATE TRIGGER fb_bound_render_review_immutable_update BEFORE UPDATE ON fb_bound_render_reviews
  BEGIN SELECT RAISE(ABORT,'bound render review is immutable'); END;
CREATE TRIGGER fb_bound_render_review_immutable_delete BEFORE DELETE ON fb_bound_render_reviews
  BEGIN SELECT RAISE(ABORT,'bound render review is immutable'); END;
CREATE TABLE fb_bound_render_outputs (
  asset_id TEXT PRIMARY KEY REFERENCES fb_assets(id),
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  job_id TEXT NOT NULL REFERENCES fb_bound_render_jobs(id),
  side TEXT NOT NULL CHECK (side IN ('front','back')),
  r2_key TEXT NOT NULL,
  object_version TEXT NOT NULL,
  object_etag TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256)=64),
  bytes INTEGER NOT NULL CHECK (bytes>0),
  mime TEXT NOT NULL CHECK (mime IN ('image/png','image/webp')),
  created_at TEXT NOT NULL,
  UNIQUE (job_id,side)
);
CREATE TRIGGER fb_bound_render_output_immutable_update BEFORE UPDATE ON fb_bound_render_outputs
  BEGIN SELECT RAISE(ABORT,'bound render output is immutable'); END;
CREATE TRIGGER fb_bound_render_output_immutable_delete BEFORE DELETE ON fb_bound_render_outputs
  BEGIN SELECT RAISE(ABORT,'bound render output is immutable'); END;
CREATE TABLE fb_bound_render_derivatives (
  derivative_id TEXT PRIMARY KEY REFERENCES fb_asset_derivatives(id),
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  source_asset_id TEXT NOT NULL REFERENCES fb_assets(id),
  r2_key TEXT NOT NULL,
  object_version TEXT NOT NULL,
  object_etag TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256)=64),
  bytes INTEGER NOT NULL CHECK (bytes>0),
  created_at TEXT NOT NULL
);
CREATE TRIGGER fb_bound_derivative_immutable_update BEFORE UPDATE ON fb_bound_render_derivatives
  BEGIN SELECT RAISE(ABORT,'bound render derivative is immutable'); END;
CREATE TRIGGER fb_bound_derivative_immutable_delete BEFORE DELETE ON fb_bound_render_derivatives
  BEGIN SELECT RAISE(ABORT,'bound render derivative is immutable'); END;

-- Additional lineage edges not covered by the draw policy epoch.
CREATE TABLE fb_bound_lineage_epoch (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
INSERT INTO fb_bound_lineage_epoch(id,revision) VALUES (1,0);
CREATE TRIGGER bound_lineage_fb_print_proposals_insert AFTER INSERT ON fb_print_proposals BEGIN UPDATE fb_bound_lineage_epoch SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER bound_lineage_fb_print_proposals_update AFTER UPDATE ON fb_print_proposals BEGIN UPDATE fb_bound_lineage_epoch SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER bound_lineage_fb_print_proposals_delete AFTER DELETE ON fb_print_proposals BEGIN UPDATE fb_bound_lineage_epoch SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER bound_lineage_fb_variant_back_renders_insert AFTER INSERT ON fb_variant_back_renders BEGIN UPDATE fb_bound_lineage_epoch SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER bound_lineage_fb_variant_back_renders_update AFTER UPDATE ON fb_variant_back_renders BEGIN UPDATE fb_bound_lineage_epoch SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER bound_lineage_fb_variant_back_renders_delete AFTER DELETE ON fb_variant_back_renders BEGIN UPDATE fb_bound_lineage_epoch SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER bound_lineage_fb_asset_derivatives_insert AFTER INSERT ON fb_asset_derivatives BEGIN UPDATE fb_bound_lineage_epoch SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER bound_lineage_fb_asset_derivatives_update AFTER UPDATE ON fb_asset_derivatives BEGIN UPDATE fb_bound_lineage_epoch SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER bound_lineage_fb_asset_derivatives_delete AFTER DELETE ON fb_asset_derivatives BEGIN UPDATE fb_bound_lineage_epoch SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER bound_lineage_fb_brand_url_refs_insert AFTER INSERT ON fb_brand_url_refs BEGIN UPDATE fb_bound_lineage_epoch SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER bound_lineage_fb_brand_url_refs_update AFTER UPDATE ON fb_brand_url_refs BEGIN UPDATE fb_bound_lineage_epoch SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER bound_lineage_fb_brand_url_refs_delete AFTER DELETE ON fb_brand_url_refs BEGIN UPDATE fb_bound_lineage_epoch SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER bound_lineage_fb_brand_url_dirty_insert AFTER INSERT ON fb_brand_url_dirty BEGIN UPDATE fb_bound_lineage_epoch SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER bound_lineage_fb_brand_url_dirty_update AFTER UPDATE ON fb_brand_url_dirty BEGIN UPDATE fb_bound_lineage_epoch SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER bound_lineage_fb_brand_url_dirty_delete AFTER DELETE ON fb_brand_url_dirty BEGIN UPDATE fb_bound_lineage_epoch SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER bound_lineage_fb_brand_index_rebuilds_insert AFTER INSERT ON fb_brand_index_rebuilds BEGIN UPDATE fb_bound_lineage_epoch SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER bound_lineage_fb_brand_index_rebuilds_update AFTER UPDATE ON fb_brand_index_rebuilds BEGIN UPDATE fb_bound_lineage_epoch SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER bound_lineage_fb_brand_index_rebuilds_delete AFTER DELETE ON fb_brand_index_rebuilds BEGIN UPDATE fb_bound_lineage_epoch SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER bound_lineage_fb_bound_render_outputs_insert AFTER INSERT ON fb_bound_render_outputs BEGIN UPDATE fb_bound_lineage_epoch SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER bound_lineage_fb_bound_render_outputs_update AFTER UPDATE ON fb_bound_render_outputs BEGIN UPDATE fb_bound_lineage_epoch SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER bound_lineage_fb_bound_render_outputs_delete AFTER DELETE ON fb_bound_render_outputs BEGIN UPDATE fb_bound_lineage_epoch SET revision=revision+1 WHERE id=1; END;
