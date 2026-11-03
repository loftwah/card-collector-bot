-- Finish/edition-specific wishes. The subject remains the primary key; the
-- optional target records the exact published variant the collector wants.
ALTER TABLE fb_wishlists ADD COLUMN target_material_key TEXT;
ALTER TABLE fb_wishlists ADD COLUMN target_effect_key TEXT;
ALTER TABLE fb_wishlists ADD COLUMN target_variant_id TEXT;
