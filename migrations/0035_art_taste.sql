CREATE TABLE IF NOT EXISTS fb_art_taste (
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  user_id TEXT NOT NULL REFERENCES fb_users(id),
  piece_id TEXT NOT NULL,
  grade INTEGER CHECK (grade BETWEEN 1 AND 5),
  note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, user_id, piece_id)
);
