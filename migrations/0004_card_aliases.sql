CREATE TABLE IF NOT EXISTS fb_card_aliases (
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  source_card_id TEXT NOT NULL,
  target_card_id TEXT NOT NULL REFERENCES fb_card_definitions(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, source_card_id)
);
