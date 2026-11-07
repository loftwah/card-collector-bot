-- Independent profile composition and curation.
-- Additive only: the previous Worker ignores both columns, so a Worker-only
-- rollback remains compatible. Existing looks and notes are preserved.
ALTER TABLE fb_player_preferences ADD COLUMN profile_presentation_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE fb_player_preferences ADD COLUMN profile_presentation_version INTEGER NOT NULL DEFAULT 1;
