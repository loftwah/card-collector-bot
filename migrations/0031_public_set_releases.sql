-- Explicit reviewed public releases. Historical sets and claims are untouched.
CREATE TABLE IF NOT EXISTS fb_public_set_releases (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES fb_tenants(id),
  set_id TEXT NOT NULL REFERENCES fb_sets(id),
  set_version INTEGER NOT NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  reward_amount INTEGER NOT NULL CHECK (reward_amount >= 0),
  roster_json TEXT NOT NULL CHECK (json_valid(roster_json)),
  snapshot_hash TEXT NOT NULL,
  review_note TEXT NOT NULL,
  reviewed_by TEXT NOT NULL REFERENCES fb_users(id),
  reviewed_at TEXT NOT NULL,
  UNIQUE (tenant_id, set_id, set_version)
);
CREATE INDEX IF NOT EXISTS public_set_release_lookup ON fb_public_set_releases(tenant_id,set_id,set_version);
CREATE TABLE IF NOT EXISTS fb_public_set_release_revocations (
  release_id TEXT PRIMARY KEY REFERENCES fb_public_set_releases(id),
  revoked_by TEXT NOT NULL REFERENCES fb_users(id),
  revoked_at TEXT NOT NULL,
  reason TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS public_set_releases_no_update BEFORE UPDATE ON fb_public_set_releases BEGIN SELECT RAISE(ABORT,'public_set_release_immutable'); END;
CREATE TRIGGER IF NOT EXISTS public_set_releases_no_delete BEFORE DELETE ON fb_public_set_releases BEGIN SELECT RAISE(ABORT,'public_set_release_immutable'); END;
CREATE TRIGGER IF NOT EXISTS public_set_revocations_no_update BEFORE UPDATE ON fb_public_set_release_revocations BEGIN SELECT RAISE(ABORT,'public_set_revocation_immutable'); END;
CREATE TRIGGER IF NOT EXISTS public_set_revocations_no_delete BEFORE DELETE ON fb_public_set_release_revocations BEGIN SELECT RAISE(ABORT,'public_set_revocation_immutable'); END;

-- Existing claims are untouched. Every new claim must match a live reviewed
-- public release, active member, wallet and the complete frozen roster.
CREATE TRIGGER IF NOT EXISTS public_set_claim_guard BEFORE INSERT ON fb_set_completion_claims
WHEN NOT EXISTS (
  SELECT 1 FROM fb_public_set_releases pr
  JOIN fb_sets s ON s.id=pr.set_id AND s.tenant_id=pr.tenant_id AND s.version=pr.set_version AND s.status='published'
  JOIN fb_set_reward_rules rr ON rr.tenant_id=s.tenant_id AND rr.set_id=s.id AND rr.set_version=s.version
  JOIN fb_memberships m ON m.tenant_id=pr.tenant_id AND m.user_id=NEW.user_id AND m.status='active' AND m.revoked_at IS NULL
  JOIN fb_users u ON u.id=m.user_id AND u.disabled_at IS NULL
  JOIN fb_wallets w ON w.tenant_id=m.tenant_id AND w.user_id=m.user_id
  WHERE pr.tenant_id=NEW.tenant_id AND pr.set_id=NEW.set_id AND pr.set_version=NEW.set_version
    AND pr.reward_amount=NEW.reward_amount AND rr.reward_amount=pr.reward_amount
    AND s.slug=pr.slug AND s.name=pr.name AND s.description=pr.description
    AND NOT EXISTS (SELECT 1 FROM fb_public_set_release_revocations rv WHERE rv.release_id=pr.id)
    AND json_array_length(pr.roster_json) BETWEEN 1 AND 40
    AND (SELECT COALESCE(json_group_array(json_array(card_id,slug,name,sort)),'[]') FROM
      (SELECT sm.card_id,cd.slug,cd.name,sm.sort FROM fb_set_memberships sm JOIN fb_card_definitions cd ON cd.id=sm.card_id AND cd.tenant_id=sm.tenant_id
       WHERE sm.tenant_id=pr.tenant_id AND sm.set_id=pr.set_id AND sm.set_version=pr.set_version ORDER BY sm.card_id))=pr.roster_json
    AND NOT EXISTS (SELECT 1 FROM fb_set_memberships sm LEFT JOIN fb_card_definitions cd ON cd.id=sm.card_id AND cd.tenant_id=sm.tenant_id
      WHERE sm.tenant_id=pr.tenant_id AND sm.set_id=pr.set_id AND sm.set_version=pr.set_version AND
        (cd.id IS NULL OR cd.status<>'published' OR cd.archived_at IS NOT NULL
         OR NOT EXISTS (SELECT 1 FROM fb_collection_cards cc WHERE cc.card_id=sm.card_id)
         OR EXISTS (SELECT 1 FROM fb_collection_cards cc JOIN fb_collections c ON c.id=cc.collection_id WHERE cc.card_id=sm.card_id AND
            NOT (c.scope='global' AND c.status='published' AND c.archived_at IS NULL AND c.view_audience='public' AND c.public_approved_at IS NOT NULL))
         OR NOT EXISTS (SELECT 1 FROM fb_card_instances ci WHERE ci.tenant_id=sm.tenant_id AND ci.user_id=NEW.user_id AND ci.card_id=sm.card_id AND ci.status IN ('owned','reserved'))))
    AND NOT EXISTS (SELECT 1 FROM fb_set_completion_claims prior WHERE prior.tenant_id=NEW.tenant_id AND prior.user_id=NEW.user_id AND prior.idempotency_key=NEW.idempotency_key)
)
BEGIN SELECT RAISE(ABORT,'public_set_claim_guard'); END;
