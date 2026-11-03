-- Additive lineage for non-destructive artwork revisions. Existing editions and
-- renders are untouched.
ALTER TABLE fb_artwork_editions ADD COLUMN parent_edition_id TEXT;
