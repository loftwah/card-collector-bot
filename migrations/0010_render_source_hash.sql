-- Bind each published render to the artwork edition revision that produced it.
-- A changed source hash makes the previous render ineligible for queue reuse,
-- so an art correction re-renders the affected variants without forcing the
-- entire catalogue. Existing rows keep NULL and are refreshed once on the next
-- normal render queue pass.
ALTER TABLE fb_variant_renders ADD COLUMN source_hash TEXT;
CREATE INDEX IF NOT EXISTS fb_variant_renders_source_idx ON fb_variant_renders(tenant_id, variant_id, source_hash);
