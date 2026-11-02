-- Tighten the pool draw guard to require the variant and card to belong to the same tenant.
DROP TRIGGER IF EXISTS fb_draws_guard_variant;
CREATE TRIGGER fb_draws_guard_variant
BEFORE INSERT ON fb_draws
WHEN NOT EXISTS (
  SELECT 1 FROM fb_pool_entries pe
  JOIN fb_variants v ON v.id = pe.variant_id AND v.tenant_id = pe.tenant_id
  JOIN fb_card_definitions cd ON cd.id = v.card_id AND cd.tenant_id = pe.tenant_id
   WHERE pe.tenant_id = NEW.tenant_id AND pe.pool_id = NEW.pool_id
     AND pe.pool_revision = NEW.pool_revision AND pe.variant_id = NEW.variant_id
     AND pe.enabled = 1 AND v.status = 'published' AND v.archived_at IS NULL
     AND cd.status = 'published' AND cd.archived_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'variant_unavailable');
END;
