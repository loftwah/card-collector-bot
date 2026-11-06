-- Collector identity: a chosen starter look and a short self-written note.
-- Additive only. The previous Worker ignores both columns, so a Worker-only
-- rollback remains compatible; no existing preference or inventory row moves.
ALTER TABLE fb_player_preferences ADD COLUMN profile_look TEXT NOT NULL DEFAULT 'quiet';
ALTER TABLE fb_player_preferences ADD COLUMN profile_bio TEXT NOT NULL DEFAULT '';
