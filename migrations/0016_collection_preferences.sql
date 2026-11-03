-- Collection-first draw preferences. Personal exclusions are an additive,
-- private preference; they never change Bot distribution or another member's
-- eligibility. Legacy hide_tags_json stays as a separate content filter.
ALTER TABLE fb_player_preferences ADD COLUMN hidden_collection_ids_json TEXT NOT NULL DEFAULT '[]';
