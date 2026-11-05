-- Pending migration: intentionally not numbered or auto-applied.
-- Resolve ordering and rollback with the active migration series before release.
CREATE TABLE fb_npc_trade_offers (
  trade_id TEXT PRIMARY KEY REFERENCES fb_trades(id),
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  player_id TEXT NOT NULL REFERENCES fb_users(id),
  npc_id TEXT NOT NULL REFERENCES fb_npc_collectors(id),
  offered_instance_id TEXT NOT NULL REFERENCES fb_card_instances(id),
  requested_instance_id TEXT NOT NULL REFERENCES fb_card_instances(id),
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('interested','declined')),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, player_id, idempotency_key)
);
CREATE INDEX fb_npc_trade_player_idx ON fb_npc_trade_offers(tenant_id, player_id, created_at);
CREATE INDEX fb_npc_trade_npc_idx ON fb_npc_trade_offers(tenant_id, npc_id, created_at);
CREATE TABLE fb_npc_trade_expiry_cursor (
  id INTEGER PRIMARY KEY CHECK (id=1),
  expires_at TEXT,
  trade_id TEXT,
  revision INTEGER NOT NULL DEFAULT 0
);
INSERT INTO fb_npc_trade_expiry_cursor (id,expires_at,trade_id) VALUES (1,NULL,NULL);
CREATE INDEX fb_npc_trade_candidate_idx ON fb_card_instances(tenant_id,user_id,status,locked,id);
