-- Scoped Bot Admin self-grant policy. Capabilities remain the authority; these
-- separate controls decide whether an explicitly granted `grants` capability
-- can issue Foil, and within which visible ceiling. Super Admin / Bot Owner
-- retains the existing audited wallet operations.
ALTER TABLE fb_memberships ADD COLUMN self_grants_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE fb_memberships ADD COLUMN grant_limit INTEGER NOT NULL DEFAULT 500;
ALTER TABLE fb_memberships ADD COLUMN capability_revision INTEGER NOT NULL DEFAULT 1;
