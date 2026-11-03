-- Scoped platform roles and richer share receipts.
--
-- A platform role is deliberately separate from a tenant/Bot membership and
-- from Cloudflare Access admission. Only the explicitly provisioned Super Admin
-- can grant these rows; the Worker re-checks the live role on every request.

CREATE TABLE IF NOT EXISTS fb_platform_role_assignments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES fb_users(id),
  role TEXT NOT NULL CHECK (role IN ('global_collection_admin')),
  scopes_json TEXT NOT NULL DEFAULT '{"all":true}',
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')) DEFAULT 'active',
  granted_by TEXT NOT NULL REFERENCES fb_users(id),
  granted_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  revoked_by TEXT REFERENCES fb_users(id),
  revoked_at TEXT,
  UNIQUE (user_id, role)
);

CREATE INDEX IF NOT EXISTS fb_platform_role_assignments_active_idx
  ON fb_platform_role_assignments(role, status);

-- Share links now carry the exact object and a truthful snapshot label. An
-- existing cabinet-wide link remains kind = 'cabinet' with no target.
ALTER TABLE fb_share_links ADD COLUMN kind TEXT NOT NULL DEFAULT 'cabinet';
ALTER TABLE fb_share_links ADD COLUMN target_id TEXT;
ALTER TABLE fb_share_links ADD COLUMN payload_json TEXT NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS fb_share_links_kind_idx
  ON fb_share_links(tenant_id, kind, status);
