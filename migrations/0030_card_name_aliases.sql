-- Alternate display names are separate from the existing card-ID redirect map.
-- Names resolve exact, normalized searches without creating duplicate identities.
CREATE TABLE IF NOT EXISTS fb_card_name_aliases (
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  card_id TEXT NOT NULL REFERENCES fb_card_definitions(id),
  alias TEXT NOT NULL,
  normalized TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, normalized),
  UNIQUE (tenant_id, card_id, normalized)
);
CREATE INDEX IF NOT EXISTS fb_card_name_aliases_card_idx ON fb_card_name_aliases(tenant_id, card_id);
