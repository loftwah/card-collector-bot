-- Explicit Bot-owner reviewed member releases; existing releases and rewards remain unchanged.
CREATE TABLE fb_member_set_releases (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES fb_tenants(id), set_id TEXT NOT NULL REFERENCES fb_sets(id),
 set_version INTEGER NOT NULL, reward_amount INTEGER NOT NULL CHECK(reward_amount>=0),
 roster_json TEXT NOT NULL CHECK(json_valid(roster_json)), collections_json TEXT NOT NULL CHECK(json_valid(collections_json)), snapshot_hash TEXT NOT NULL,
 reviewed_by TEXT NOT NULL REFERENCES fb_users(id), reviewed_at TEXT NOT NULL
);
CREATE TABLE fb_member_set_revocations (release_id TEXT PRIMARY KEY REFERENCES fb_member_set_releases(id), revoked_by TEXT NOT NULL REFERENCES fb_users(id), revoked_at TEXT NOT NULL);
CREATE TABLE fb_member_set_active (tenant_id TEXT NOT NULL REFERENCES fb_tenants(id), set_id TEXT NOT NULL REFERENCES fb_sets(id), set_version INTEGER NOT NULL, release_id TEXT NOT NULL UNIQUE REFERENCES fb_member_set_releases(id), PRIMARY KEY(tenant_id,set_id,set_version));
CREATE TRIGGER member_set_releases_no_update BEFORE UPDATE ON fb_member_set_releases BEGIN SELECT RAISE(ABORT,'member_set_release_immutable'); END;
CREATE TRIGGER member_set_releases_no_delete BEFORE DELETE ON fb_member_set_releases BEGIN SELECT RAISE(ABORT,'member_set_release_immutable'); END;
CREATE TRIGGER member_set_revocations_no_update BEFORE UPDATE ON fb_member_set_revocations BEGIN SELECT RAISE(ABORT,'member_set_revocation_immutable'); END;
CREATE TRIGGER member_set_revocations_no_delete BEFORE DELETE ON fb_member_set_revocations BEGIN SELECT RAISE(ABORT,'member_set_revocation_immutable'); END;
DROP TRIGGER public_set_claim_guard;
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
AND NOT EXISTS (
 SELECT 1 FROM fb_member_set_releases mr
 JOIN fb_sets s ON s.id=mr.set_id AND s.tenant_id=mr.tenant_id AND s.version=mr.set_version AND s.status='published'
 JOIN fb_set_reward_rules rr ON rr.tenant_id=s.tenant_id AND rr.set_id=s.id AND rr.set_version=s.version AND rr.reward_amount=mr.reward_amount
 JOIN fb_memberships m ON m.tenant_id=mr.tenant_id AND m.user_id=NEW.user_id AND m.status='active' AND m.revoked_at IS NULL
 JOIN fb_users u ON u.id=m.user_id AND u.disabled_at IS NULL
 JOIN fb_wallets w ON w.tenant_id=m.tenant_id AND w.user_id=m.user_id
 WHERE mr.tenant_id=NEW.tenant_id AND mr.set_id=NEW.set_id AND mr.set_version=NEW.set_version AND mr.reward_amount=NEW.reward_amount
  AND EXISTS (SELECT 1 FROM fb_member_set_active active WHERE active.release_id=mr.id AND active.tenant_id=mr.tenant_id AND active.set_id=mr.set_id AND active.set_version=mr.set_version)
  AND NOT EXISTS (SELECT 1 FROM fb_member_set_revocations rv WHERE rv.release_id=mr.id)
  AND json_array_length(mr.roster_json) BETWEEN 1 AND 40
  AND (SELECT COALESCE(json_group_array(json_array(card_id,slug,name,sort)),'[]') FROM
   (SELECT sm.card_id,cd.slug,cd.name,sm.sort FROM fb_set_memberships sm JOIN fb_card_definitions cd ON cd.id=sm.card_id AND cd.tenant_id=sm.tenant_id
    WHERE sm.tenant_id=mr.tenant_id AND sm.set_id=mr.set_id AND sm.set_version=mr.set_version ORDER BY sm.card_id))=mr.roster_json
  AND (SELECT COALESCE(json_group_array(json_array(card_id,id,name,scope,owner_tenant_id,status,view_audience,public_approved_at,archived_at)),'[]') FROM
   (SELECT sm.card_id,c.id,c.name,c.scope,c.owner_tenant_id,c.status,c.view_audience,c.public_approved_at,c.archived_at FROM fb_set_memberships sm JOIN fb_collection_cards cc ON cc.card_id=sm.card_id JOIN fb_collections c ON c.id=cc.collection_id WHERE sm.tenant_id=mr.tenant_id AND sm.set_id=mr.set_id AND sm.set_version=mr.set_version ORDER BY sm.card_id,c.id))=mr.collections_json
  AND EXISTS (SELECT 1 FROM fb_set_memberships sm JOIN fb_collection_cards cc ON cc.card_id=sm.card_id JOIN fb_collections c ON c.id=cc.collection_id WHERE sm.tenant_id=mr.tenant_id AND sm.set_id=mr.set_id AND sm.set_version=mr.set_version AND c.view_audience='members')
  AND NOT EXISTS (SELECT 1 FROM fb_set_memberships sm LEFT JOIN fb_card_definitions cd ON cd.id=sm.card_id AND cd.tenant_id=sm.tenant_id
   WHERE sm.tenant_id=mr.tenant_id AND sm.set_id=mr.set_id AND sm.set_version=mr.set_version AND
    (cd.id IS NULL OR cd.status<>'published' OR cd.archived_at IS NOT NULL
     OR NOT EXISTS (SELECT 1 FROM fb_collection_cards cc WHERE cc.card_id=sm.card_id)
     OR EXISTS (SELECT 1 FROM fb_collection_cards cc LEFT JOIN fb_collections c ON c.id=cc.collection_id WHERE cc.card_id=sm.card_id AND
       (c.id IS NULL OR c.status<>'published' OR c.archived_at IS NOT NULL OR c.scope NOT IN ('global','bot') OR (c.scope='bot' AND c.owner_tenant_id IS NOT mr.tenant_id)
        OR NOT ((c.view_audience='public' AND c.public_approved_at IS NOT NULL) OR c.view_audience='members')))
     OR NOT EXISTS (SELECT 1 FROM fb_card_instances ci WHERE ci.tenant_id=sm.tenant_id AND ci.user_id=NEW.user_id AND ci.card_id=sm.card_id AND ci.status IN ('owned','reserved'))))
  AND NOT EXISTS (SELECT 1 FROM fb_set_completion_claims prior WHERE prior.tenant_id=NEW.tenant_id AND prior.user_id=NEW.user_id AND prior.idempotency_key=NEW.idempotency_key)
)
BEGIN SELECT RAISE(ABORT,'public_set_claim_guard'); END;
