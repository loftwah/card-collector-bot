-- EXPERIMENT ONLY. Apply all statements as one verified atomic D1 batch.
-- Never number or deploy until conflict, storage, rollback and recovery review.
-- Bound the number of rows processed by this initial migration. The 10,000-row
-- ceiling is experimental, not a remote latency or resource guarantee.
SELECT CASE WHEN (SELECT COUNT(*) FROM (SELECT 1 FROM fb_discord_identities LIMIT 10001))>10000
  THEN json('discord_binding_migration_too_large') ELSE 1 END;
CREATE INDEX fb_discord_identity_global_lookup_idx ON fb_discord_identities(discord_user_id,user_id,revoked_at);
CREATE TABLE fb_discord_global_bindings (
  discord_user_id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL
);
-- Only the compatible onboarding transaction creates this one-use permit.
-- A rollback Worker cannot create a new binding without such a transaction.
CREATE TABLE fb_discord_binding_admissions (
  discord_user_id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL
);
-- A Discord ID with multiple historical users requires manual verified review.
SELECT CASE WHEN EXISTS (
  SELECT discord_user_id FROM fb_discord_identities
  GROUP BY discord_user_id HAVING MIN(user_id) <> MAX(user_id)
) THEN json('conflicting_discord_bindings') ELSE 1 END;
INSERT INTO fb_discord_global_bindings (discord_user_id,user_id)
  SELECT discord_user_id,MIN(user_id) FROM fb_discord_identities GROUP BY discord_user_id;
-- Legacy first-interaction creates a reserved-email user, membership and wallet
-- before inserting its Discord identity. Block each earlier insert unless the
-- same account has an established binding or an in-transaction permit.
CREATE TRIGGER fb_discord_reserved_user_guard BEFORE INSERT ON fb_users
WHEN NEW.email GLOB 'discord.*@players.foilbury.invalid' AND NOT EXISTS (
  SELECT 1 FROM fb_discord_binding_admissions p
  WHERE NEW.email='discord.' || p.discord_user_id || '@players.foilbury.invalid' AND p.user_id=NEW.id
)
BEGIN SELECT RAISE(ABORT,'discord_global_binding_not_admitted'); END;
CREATE TRIGGER fb_discord_reserved_membership_guard BEFORE INSERT ON fb_memberships
WHEN EXISTS (SELECT 1 FROM fb_users u WHERE u.id=NEW.user_id AND u.email GLOB 'discord.*@players.foilbury.invalid'
  AND NOT EXISTS (SELECT 1 FROM fb_discord_global_bindings g WHERE g.user_id=u.id AND u.email='discord.' || g.discord_user_id || '@players.foilbury.invalid')
  AND NOT EXISTS (SELECT 1 FROM fb_discord_binding_admissions p WHERE p.user_id=u.id AND u.email='discord.' || p.discord_user_id || '@players.foilbury.invalid'))
BEGIN SELECT RAISE(ABORT,'discord_global_binding_not_admitted'); END;
CREATE TRIGGER fb_discord_reserved_wallet_guard BEFORE INSERT ON fb_wallets
WHEN EXISTS (SELECT 1 FROM fb_users u WHERE u.id=NEW.user_id AND u.email GLOB 'discord.*@players.foilbury.invalid'
  AND NOT EXISTS (SELECT 1 FROM fb_discord_global_bindings g WHERE g.user_id=u.id AND u.email='discord.' || g.discord_user_id || '@players.foilbury.invalid')
  AND NOT EXISTS (SELECT 1 FROM fb_discord_binding_admissions p WHERE p.user_id=u.id AND u.email='discord.' || p.discord_user_id || '@players.foilbury.invalid'))
BEGIN SELECT RAISE(ABORT,'discord_global_binding_not_admitted'); END;
CREATE TRIGGER fb_discord_global_bind_insert BEFORE INSERT ON fb_discord_identities
BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM fb_discord_global_bindings
    WHERE discord_user_id=NEW.discord_user_id AND user_id=NEW.user_id)
    AND NOT EXISTS (SELECT 1 FROM fb_discord_binding_admissions
    WHERE discord_user_id=NEW.discord_user_id AND user_id=NEW.user_id)
    THEN RAISE(ABORT,'discord_global_binding_not_admitted') END;
  INSERT INTO fb_discord_global_bindings (discord_user_id,user_id)
    VALUES (NEW.discord_user_id,NEW.user_id) ON CONFLICT(discord_user_id) DO NOTHING;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM fb_discord_global_bindings
    WHERE discord_user_id=NEW.discord_user_id AND user_id<>NEW.user_id)
    THEN RAISE(ABORT,'discord_global_binding_conflict') END;
  DELETE FROM fb_discord_binding_admissions WHERE discord_user_id=NEW.discord_user_id AND user_id=NEW.user_id;
END;
CREATE TRIGGER fb_discord_global_bind_immutable BEFORE UPDATE OF discord_user_id,user_id ON fb_discord_identities
WHEN NEW.discord_user_id<>OLD.discord_user_id OR NEW.user_id<>OLD.user_id
BEGIN
  SELECT RAISE(ABORT,'discord_global_binding_immutable');
END;
-- Removing a tenant link does not release the global binding. Removal or
-- reassignment needs a separately reviewed administrative recovery migration.
CREATE TRIGGER fb_discord_global_bindings_no_update BEFORE UPDATE ON fb_discord_global_bindings
BEGIN SELECT RAISE(ABORT,'discord_global_binding_immutable'); END;
CREATE TRIGGER fb_discord_global_bindings_no_delete BEFORE DELETE ON fb_discord_global_bindings
BEGIN SELECT RAISE(ABORT,'discord_global_binding_retained'); END;
