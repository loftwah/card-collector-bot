-- Non-destructive artwork composition. The source asset is never modified; an
-- edition records how it is placed inside the card art window. Existing
-- editions keep a NULL composition and fall back to the authored default.
ALTER TABLE fb_artwork_editions ADD COLUMN composition_json TEXT;
