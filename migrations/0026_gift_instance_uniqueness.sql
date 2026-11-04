-- One administrator card gift per recipient per campaign.
--
-- The application already checks for an existing `gift:<campaign>` instance,
-- but two workers can both observe "none" before either inserts. This partial
-- unique index makes the per-recipient effect conditional at the storage layer.
-- It is additive; existing non-gift instances are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS fb_card_instances_gift_unique
  ON fb_card_instances (tenant_id, user_id, acquired_via)
  WHERE acquired_via LIKE 'gift:%';
