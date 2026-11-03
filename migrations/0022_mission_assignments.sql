-- Stable per-day mission assignment. The definition/version/target/reward are
-- snapshotted so a later balance/card change or deploy cannot move the goalposts
-- for the current UTC day.
CREATE TABLE IF NOT EXISTS fb_mission_assignments (
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  user_id TEXT NOT NULL REFERENCES fb_users(id),
  period_key TEXT NOT NULL,
  mission_key TEXT NOT NULL,
  version INTEGER NOT NULL,
  target INTEGER NOT NULL CHECK (target > 0),
  reward INTEGER NOT NULL CHECK (reward >= 0),
  definition_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, user_id, period_key, mission_key)
);
CREATE INDEX IF NOT EXISTS fb_mission_assignments_user_idx
  ON fb_mission_assignments(tenant_id, user_id, period_key);
