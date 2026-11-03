-- Persist the domain receipt a deferred interaction already committed, so a
-- render/lookup/Discord delivery failure after the commit can tell the player
-- the truth and offer the same recorded result instead of a second operation.
ALTER TABLE fb_discord_interactions ADD COLUMN receipt_kind TEXT;
ALTER TABLE fb_discord_interactions ADD COLUMN receipt_json TEXT;
ALTER TABLE fb_discord_interactions ADD COLUMN delivery_visibility TEXT;
