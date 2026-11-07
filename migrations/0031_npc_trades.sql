-- Human-initiated NPC trade decisions. The trade itself uses the existing
-- fb_trades/fb_trade_items/fb_trade_acceptances lifecycle and its reservation
-- and ownership triggers. This table records the deterministic NPC decision
-- and the reason shown to the human.
CREATE TABLE IF NOT EXISTS fb_npc_trade_decisions (
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  trade_id TEXT NOT NULL REFERENCES fb_trades(id),
  npc_id TEXT NOT NULL REFERENCES fb_npc_collectors(id),
  decision TEXT NOT NULL CHECK (decision IN ('accept','decline')),
  reason TEXT NOT NULL,
  wants_json TEXT NOT NULL DEFAULT '{}',
  spare_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, trade_id)
);
CREATE INDEX IF NOT EXISTS fb_npc_trade_decisions_npc_idx ON fb_npc_trade_decisions(tenant_id, npc_id, created_at DESC);
