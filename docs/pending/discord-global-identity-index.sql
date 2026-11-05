-- Test-only proposal. Review the migration order and existing conflicting
-- identities before applying; this is not an ordered production migration.
CREATE INDEX fb_discord_identity_global_lookup_idx ON fb_discord_identities(discord_user_id,user_id,revoked_at);
