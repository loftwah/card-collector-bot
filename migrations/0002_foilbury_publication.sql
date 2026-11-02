-- Foilbury schema supplement: publication, rendering and transactional guards.
ALTER TABLE fb_tenants ADD COLUMN publication_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE fb_economy_settings ADD COLUMN recycle_rates_json TEXT NOT NULL DEFAULT '{"rarity":{"common":10,"uncommon":20,"rare":35,"cabinet_rare":60},"material":{"plain":0,"silver":5,"gold":10,"diamond":15}}';
ALTER TABLE fb_pools ADD COLUMN channel_key TEXT;

CREATE TABLE IF NOT EXISTS fb_variant_renders (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  variant_id TEXT NOT NULL REFERENCES fb_variants(id),
  recipe_id TEXT NOT NULL REFERENCES fb_recipes(id),
  asset_id TEXT NOT NULL REFERENCES fb_assets(id),
  public_url TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','published','retired')) DEFAULT 'draft',
  created_at TEXT NOT NULL,
  published_at TEXT,
  UNIQUE (tenant_id, variant_id, recipe_id)
);
CREATE INDEX IF NOT EXISTS fb_variant_renders_variant_idx ON fb_variant_renders(tenant_id, variant_id, status);

CREATE TRIGGER IF NOT EXISTS fb_draws_guard_pool
BEFORE INSERT ON fb_draws
WHEN NOT EXISTS (
  SELECT 1 FROM fb_pools p
   WHERE p.id = NEW.pool_id AND p.tenant_id = NEW.tenant_id
     AND p.status = 'active' AND p.revision = NEW.pool_revision AND p.price = NEW.price
)
BEGIN
  SELECT RAISE(ABORT, 'stale_pool_revision');
END;

CREATE TRIGGER IF NOT EXISTS fb_draws_guard_variant
BEFORE INSERT ON fb_draws
WHEN NOT EXISTS (
  SELECT 1 FROM fb_pool_entries pe
  JOIN fb_variants v ON v.id = pe.variant_id
  JOIN fb_card_definitions cd ON cd.id = v.card_id
   WHERE pe.tenant_id = NEW.tenant_id AND pe.pool_id = NEW.pool_id
     AND pe.pool_revision = NEW.pool_revision AND pe.variant_id = NEW.variant_id
     AND pe.enabled = 1 AND v.status = 'published' AND v.archived_at IS NULL
     AND cd.status = 'published' AND cd.archived_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'variant_unavailable');
END;

CREATE TRIGGER IF NOT EXISTS fb_trade_items_guard
BEFORE INSERT ON fb_trade_items
WHEN NOT EXISTS (
  SELECT 1 FROM fb_card_instances ci
  JOIN fb_trades t ON t.id = NEW.trade_id AND t.tenant_id = NEW.tenant_id
   WHERE ci.id = NEW.instance_id AND ci.tenant_id = NEW.tenant_id
     AND ci.status = 'owned' AND ci.locked = 0
     AND ((NEW.side = 'proposer' AND ci.user_id = t.proposer_id)
       OR (NEW.side = 'recipient' AND ci.user_id = t.recipient_id))
)
BEGIN
  SELECT RAISE(ABORT, 'trade_item_unavailable');
END;

CREATE TRIGGER IF NOT EXISTS fb_trade_items_reserve
AFTER INSERT ON fb_trade_items
BEGIN
  UPDATE fb_card_instances
     SET status = 'reserved', reserved_for = NEW.trade_id, updated_at = NEW.created_at
   WHERE id = NEW.instance_id AND tenant_id = NEW.tenant_id AND status = 'owned';
END;

CREATE TRIGGER IF NOT EXISTS fb_trades_guard_complete
BEFORE UPDATE OF status ON fb_trades
WHEN NEW.status = 'completed'
BEGIN
  SELECT RAISE(ABORT, 'trade_not_ready')
   WHERE NOT EXISTS (
     SELECT 1 FROM fb_trade_acceptances a
      WHERE a.tenant_id = NEW.tenant_id AND a.trade_id = NEW.id AND a.revision = NEW.revision
        AND a.user_id IN (NEW.proposer_id, NEW.recipient_id)
      GROUP BY a.trade_id HAVING COUNT(DISTINCT a.user_id) = 2
   );
  SELECT RAISE(ABORT, 'trade_item_invalid')
   WHERE EXISTS (
     SELECT 1 FROM fb_trade_items ti
     LEFT JOIN fb_card_instances ci ON ci.id = ti.instance_id
      WHERE ti.trade_id = NEW.id AND ti.tenant_id = NEW.tenant_id
        AND (ci.status IS NULL OR ci.status != 'reserved' OR ci.reserved_for IS NULL OR ci.reserved_for != NEW.id
          OR (ti.side = 'proposer' AND ci.user_id != NEW.proposer_id)
          OR (ti.side = 'recipient' AND ci.user_id != NEW.recipient_id))
   );
END;

CREATE TRIGGER IF NOT EXISTS fb_gifts_guard
BEFORE INSERT ON fb_gifts
WHEN NEW.status = 'completed' AND NOT EXISTS (
  SELECT 1 FROM fb_card_instances
   WHERE id = NEW.instance_id AND tenant_id = NEW.tenant_id AND user_id = NEW.sender_id
     AND status = 'owned' AND locked = 0
)
BEGIN
  SELECT RAISE(ABORT, 'gift_item_unavailable');
END;

CREATE TRIGGER IF NOT EXISTS fb_gifts_transfer
AFTER INSERT ON fb_gifts
WHEN NEW.status = 'completed'
BEGIN
  UPDATE fb_card_instances
     SET user_id = NEW.recipient_id, status = 'owned', reserved_for = NULL, updated_at = NEW.created_at
   WHERE id = NEW.instance_id AND tenant_id = NEW.tenant_id AND user_id = NEW.sender_id AND status = 'owned';
  INSERT INTO fb_instance_history
    (id, tenant_id, instance_id, event, from_user_id, to_user_id, reference_type, reference_id, metadata_json, created_at)
  VALUES
    ('ih_' || NEW.id, NEW.tenant_id, NEW.instance_id, 'gifted', NEW.sender_id, NEW.recipient_id,
     'gift', NEW.id, '{}', NEW.created_at);
END;
