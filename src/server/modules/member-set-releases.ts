import { ApiError, requireRecentStrongAuth, type Ctx } from "../context";
import { all, first, nowIso } from "../db";
import { newId, sha256Hex } from "../ids";
import { rosterSql } from "./public-set-releases";

// A deliberately narrow audience: every linked collection is public-approved or
// members-only, and Bot collections must belong to the current Bot. Private
// collection grants and cross-Bot membership are not silently inherited.
const memberCandidateSql = `NOT EXISTS (SELECT 1 FROM fb_member_set_revocations rv WHERE rv.release_id=mr.id)
 AND EXISTS (SELECT 1 FROM fb_sets s JOIN fb_set_reward_rules r ON r.tenant_id=s.tenant_id AND r.set_id=s.id AND r.set_version=s.version
  WHERE s.tenant_id=mr.tenant_id AND s.id=mr.set_id AND s.status='published' AND s.version=mr.set_version AND r.reward_amount=mr.reward_amount)
 AND json_array_length(mr.roster_json) BETWEEN 1 AND 40
 AND (SELECT COALESCE(json_group_array(json_array(card_id,slug,name,sort)),'[]') FROM
  (SELECT sm.card_id,cd.slug,cd.name,sm.sort FROM fb_set_memberships sm JOIN fb_card_definitions cd ON cd.id=sm.card_id AND cd.tenant_id=sm.tenant_id
   WHERE sm.tenant_id=mr.tenant_id AND sm.set_id=mr.set_id AND sm.set_version=mr.set_version ORDER BY sm.card_id))=mr.roster_json
 AND (SELECT COALESCE(json_group_array(json_array(card_id,id,name,scope,owner_tenant_id,status,view_audience,public_approved_at,archived_at)),'[]') FROM
  (SELECT sm.card_id,c.id,c.name,c.scope,c.owner_tenant_id,c.status,c.view_audience,c.public_approved_at,c.archived_at FROM fb_set_memberships sm JOIN fb_collection_cards cc ON cc.card_id=sm.card_id JOIN fb_collections c ON c.id=cc.collection_id WHERE sm.tenant_id=mr.tenant_id AND sm.set_id=mr.set_id AND sm.set_version=mr.set_version ORDER BY sm.card_id,c.id))=mr.collections_json
 AND EXISTS (SELECT 1 FROM fb_set_memberships sm JOIN fb_collection_cards cc ON cc.card_id=sm.card_id JOIN fb_collections c ON c.id=cc.collection_id
  WHERE sm.tenant_id=mr.tenant_id AND sm.set_id=mr.set_id AND sm.set_version=mr.set_version AND c.view_audience='members')
 AND NOT EXISTS (SELECT 1 FROM fb_set_memberships sm LEFT JOIN fb_card_definitions cd ON cd.id=sm.card_id AND cd.tenant_id=sm.tenant_id
  WHERE sm.tenant_id=mr.tenant_id AND sm.set_id=mr.set_id AND sm.set_version=mr.set_version AND
   (cd.id IS NULL OR cd.status<>'published' OR cd.archived_at IS NOT NULL OR NOT EXISTS (SELECT 1 FROM fb_collection_cards cc WHERE cc.card_id=sm.card_id)
    OR EXISTS (SELECT 1 FROM fb_collection_cards cc LEFT JOIN fb_collections c ON c.id=cc.collection_id WHERE cc.card_id=sm.card_id AND
     (c.id IS NULL OR c.status<>'published' OR c.archived_at IS NOT NULL OR c.scope NOT IN ('global','bot') OR (c.scope='bot' AND c.owner_tenant_id IS NOT mr.tenant_id)
      OR NOT ((c.view_audience='public' AND c.public_approved_at IS NOT NULL) OR c.view_audience='members')))))`;
export const memberReleaseSql = `${memberCandidateSql} AND EXISTS (SELECT 1 FROM fb_member_set_active active WHERE active.release_id=mr.id AND active.tenant_id=mr.tenant_id AND active.set_id=mr.set_id AND active.set_version=mr.set_version)`;

const ownerSql = `EXISTS (SELECT 1 FROM fb_memberships m JOIN fb_users u ON u.id=m.user_id
 JOIN fb_bots b ON b.tenant_id=m.tenant_id AND b.owner_user_id=u.id AND b.status='active'
 JOIN fb_sessions sess ON sess.id=? AND sess.user_id=u.id AND sess.tenant_id=m.tenant_id
 WHERE m.tenant_id=? AND m.user_id=? AND m.role='owner' AND m.status='active' AND m.revoked_at IS NULL AND u.disabled_at IS NULL
 AND sess.revoked_at IS NULL AND sess.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND sess.assurance=? AND sess.assurance IN ('mfa','passkey')
 AND sess.auth_time>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 minutes') AND sess.auth_time<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;
function ownerArgs(ctx: Ctx) {
  return [ctx.sessionId, ctx.tenant.id, ctx.user?.id ?? "", ctx.sessionAssurance];
}
async function assertOwner(ctx: Ctx) {
  if (
    !ctx.user ||
    ctx.actor.type !== "user" ||
    ctx.actor.id !== ctx.user.id ||
    ctx.actor.representedUserId !== ctx.user.id
  )
    throw new ApiError(403, "member_review_forbidden", "A signed-in Bot owner is required.");
  requireRecentStrongAuth(ctx, 30);
  const row = await first<{ ok: number }>(
    ctx.db,
    `SELECT CASE WHEN ${ownerSql} THEN 1 ELSE 0 END AS ok`,
    ...ownerArgs(ctx),
  );
  if (!row?.ok)
    throw new ApiError(
      403,
      "member_review_forbidden",
      "The owner authority or strong session is no longer active.",
    );
  return ctx.user;
}
async function snapshot(ctx: Ctx, setId: string) {
  const s = await first<{ id: string; version: number; reward: number }>(
    ctx.db,
    `SELECT s.id,s.version,r.reward_amount AS reward FROM fb_sets s JOIN fb_set_reward_rules r ON r.tenant_id=s.tenant_id AND r.set_id=s.id AND r.set_version=s.version WHERE s.tenant_id=? AND s.id=? AND s.status='published'`,
    ctx.tenant.id,
    setId,
  );
  if (!s)
    throw new ApiError(
      409,
      "member_set_unavailable",
      "The set is not available for member release.",
    );
  const cards = await all<{ card_id: string; slug: string; name: string; sort: number }>(
    ctx.db,
    `SELECT sm.card_id,cd.slug,cd.name,sm.sort FROM fb_set_memberships sm JOIN fb_card_definitions cd ON cd.id=sm.card_id AND cd.tenant_id=sm.tenant_id WHERE sm.tenant_id=? AND sm.set_id=? AND sm.set_version=? ORDER BY sm.card_id LIMIT 41`,
    ctx.tenant.id,
    setId,
    s.version,
  );
  if (!cards.length || cards.length > 40)
    throw new ApiError(409, "member_set_unavailable", "A member release requires 1–40 cards.");
  const collections = await first<{ value: string }>(
    ctx.db,
    `SELECT (${collectionSnapshotSql}) AS value`,
    ctx.tenant.id,
    setId,
    s.version,
  );
  return {
    id: s.id,
    version: s.version,
    reward: s.reward,
    roster: cards.map((c) => [c.card_id, c.slug, c.name, c.sort]),
    collections: JSON.parse(collections?.value ?? "[]"),
  };
}
const collectionSnapshotSql = `SELECT COALESCE(json_group_array(json_array(card_id,id,name,scope,owner_tenant_id,status,view_audience,public_approved_at,archived_at)),'[]') FROM
 (SELECT sm.card_id,c.id,c.name,c.scope,c.owner_tenant_id,c.status,c.view_audience,c.public_approved_at,c.archived_at FROM fb_set_memberships sm JOIN fb_collection_cards cc ON cc.card_id=sm.card_id JOIN fb_collections c ON c.id=cc.collection_id WHERE sm.tenant_id=? AND sm.set_id=? AND sm.set_version=? ORDER BY sm.card_id,c.id)`;
export async function previewMemberSetRelease(ctx: Ctx, setId: string) {
  await assertOwner(ctx);
  const value = await snapshot(ctx, setId);
  const permitted = await first<{ ok: number }>(
    ctx.db,
    `WITH mr AS (SELECT '' AS id,? AS tenant_id,? AS set_id,? AS set_version,? AS reward_amount,? AS roster_json,? AS collections_json)
 SELECT 1 AS ok FROM mr WHERE ${memberCandidateSql} AND ${ownerSql}`,
    ctx.tenant.id,
    setId,
    value.version,
    value.reward,
    JSON.stringify(value.roster),
    JSON.stringify(value.collections),
    ...ownerArgs(ctx),
  );
  if (!permitted)
    throw new ApiError(
      409,
      "member_set_unavailable",
      "The roster or owner access is not available for member release.",
    );
  return { snapshot: value, snapshot_hash: await sha256Hex(JSON.stringify(value)) };
}
export async function approveMemberSetRelease(ctx: Ctx, setId: string, expectedHash: string) {
  const user = await assertOwner(ctx),
    value = await snapshot(ctx, setId),
    hash = await sha256Hex(JSON.stringify(value));
  if (hash !== expectedHash)
    throw new ApiError(409, "member_set_changed", "The set changed; review it again.");
  const id = newId("msr"),
    now = nowIso(),
    roster = JSON.stringify(value.roster);
  // Validate the exact candidate using the same predicate used for live reads.
  // The candidate is inserted provisionally in the batch, then a failing guard
  // aborts the entire transaction if its roster/audience changed.
  const results = await ctx.db
    .batch([
      ctx.db
        .prepare(
          `INSERT INTO fb_member_set_releases(id,tenant_id,set_id,set_version,reward_amount,roster_json,collections_json,snapshot_hash,reviewed_by,reviewed_at)
   SELECT ?,?,?,?,?,?,?,?,?,? WHERE ${ownerSql} AND EXISTS (SELECT 1 FROM fb_sets s JOIN fb_set_reward_rules r ON r.tenant_id=s.tenant_id AND r.set_id=s.id AND r.set_version=s.version WHERE s.tenant_id=? AND s.id=? AND s.version=? AND s.status='published' AND r.reward_amount=?) AND (${rosterSql})=? AND (${collectionSnapshotSql})=?`,
        )
        .bind(
          id,
          ctx.tenant.id,
          setId,
          value.version,
          value.reward,
          roster,
          JSON.stringify(value.collections),
          hash,
          user.id,
          now,
          ...ownerArgs(ctx),
          ctx.tenant.id,
          setId,
          value.version,
          value.reward,
          ctx.tenant.id,
          setId,
          value.version,
          roster,
          ctx.tenant.id,
          setId,
          value.version,
          JSON.stringify(value.collections),
        ),
      ctx.db
        .prepare(
          `INSERT INTO fb_member_set_active(tenant_id,set_id,set_version,release_id) SELECT tenant_id,set_id,set_version,id FROM fb_member_set_releases WHERE id=?`,
        )
        .bind(id),
      ctx.db
        .prepare(
          `INSERT INTO fb_audit_events(id,tenant_id,actor_type,actor_id,represented_user_id,action,object_type,object_id,metadata_json,request_id,created_at)
   SELECT ?,?,'user',?,?,'member_set.approved','set',?,?,?,? FROM fb_member_set_releases mr WHERE mr.id=? AND ${memberReleaseSql} AND ${ownerSql}`,
        )
        .bind(
          newId("aud"),
          ctx.tenant.id,
          user.id,
          user.id,
          setId,
          JSON.stringify({ release_id: id, snapshot_hash: hash }),
          ctx.requestId,
          now,
          id,
          ...ownerArgs(ctx),
        ),
      ctx.db
        .prepare(
          `SELECT CASE WHEN EXISTS (SELECT 1 FROM fb_member_set_releases WHERE id=?) AND NOT EXISTS (SELECT 1 FROM fb_audit_events WHERE tenant_id=? AND action='member_set.approved' AND json_extract(metadata_json,'$.release_id')=?) THEN json('invalid') ELSE 1 END`,
        )
        .bind(id, ctx.tenant.id, id),
    ])
    .catch(async (error: unknown) => {
      if (
        String(error).includes("UNIQUE") &&
        (await first(
          ctx.db,
          "SELECT release_id FROM fb_member_set_active WHERE tenant_id=? AND set_id=? AND set_version=?",
          ctx.tenant.id,
          setId,
          value.version,
        ))
      )
        throw new ApiError(
          409,
          "member_set_active_exists",
          "Revoke the current member release before reviewing this version again.",
        );
      throw error;
    });
  if (!results[0]?.meta.changes)
    throw new ApiError(409, "member_set_changed", "The set or owner access changed; review again.");
  return { id, snapshot_hash: hash };
}

export async function revokeMemberSetRelease(ctx: Ctx, id: string) {
  const user = await assertOwner(ctx),
    now = nowIso();
  const [result] = await ctx.db.batch([
    ctx.db
      .prepare(
        `INSERT INTO fb_member_set_revocations(release_id,revoked_by,revoked_at)
   SELECT mr.id,?,? FROM fb_member_set_releases mr WHERE mr.id=? AND mr.tenant_id=? AND ${ownerSql} AND EXISTS (SELECT 1 FROM fb_member_set_active a WHERE a.release_id=mr.id) AND NOT EXISTS (SELECT 1 FROM fb_member_set_revocations rv WHERE rv.release_id=mr.id)`,
      )
      .bind(user.id, now, id, ctx.tenant.id, ...ownerArgs(ctx)),
    ctx.db.prepare(`DELETE FROM fb_member_set_active WHERE release_id=? AND changes()=1`).bind(id),
    ctx.db
      .prepare(
        `INSERT INTO fb_audit_events(id,tenant_id,actor_type,actor_id,represented_user_id,action,object_type,object_id,metadata_json,request_id,created_at)
   SELECT ?,?,'user',?,?,'member_set.revoked','member_set_release',?,'{}',?,? WHERE changes()=1`,
      )
      .bind(newId("aud"), ctx.tenant.id, user.id, user.id, id, ctx.requestId, now),
  ]);
  if (!result?.meta.changes)
    throw new ApiError(
      409,
      "member_set_unavailable",
      "The release or owner access is unavailable.",
    );
  return { id, revoked: true };
}

export async function listMemberSetReviews(ctx: Ctx, setId: string) {
  await assertOwner(ctx);
  const rows = await all<{
    id: string;
    set_version: number;
    reviewed_at: string;
    revoked_at: string | null;
  }>(
    ctx.db,
    `SELECT mr.id,mr.set_version,mr.reviewed_at,rv.revoked_at FROM fb_member_set_releases mr
     LEFT JOIN fb_member_set_revocations rv ON rv.release_id=mr.id
     WHERE mr.tenant_id=? AND mr.set_id=? AND ${ownerSql} ORDER BY mr.reviewed_at DESC LIMIT 101`,
    ctx.tenant.id,
    setId,
    ...ownerArgs(ctx),
  );
  if (rows.length > 100)
    throw new ApiError(503, "set_list_overloaded", "Too many reviews to show safely.");
  return { items: rows };
}

const memberSessionSql = `EXISTS (SELECT 1 FROM fb_memberships m JOIN fb_users u ON u.id=m.user_id
 WHERE m.tenant_id=mr.tenant_id AND m.user_id=? AND m.status='active' AND m.revoked_at IS NULL AND u.disabled_at IS NULL
 AND (EXISTS (SELECT 1 FROM fb_sessions sess WHERE sess.id=? AND sess.user_id=m.user_id AND sess.tenant_id=m.tenant_id AND sess.revoked_at IS NULL AND sess.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 OR (?='access' AND ?>unixepoch('now') AND EXISTS (SELECT 1 FROM fb_access_identities ai WHERE ai.user_id=m.user_id AND ai.team_domain=? AND ai.subject=? AND ai.email=? AND ai.revoked_at IS NULL) AND u.email=? COLLATE NOCASE)))`;
function memberSessionArgs(ctx: Ctx) {
  const access =
    ctx.sessionAssurance === "access" && ctx.accessStatus === "linked" ? ctx.accessIdentity : null;
  return [
    ctx.user?.id ?? "",
    ctx.sessionId,
    ctx.sessionAssurance,
    access?.payload.exp ?? 0,
    ctx.config.access.teamDomain,
    access?.subject ?? "",
    access?.email ?? "",
    access?.email ?? "",
  ];
}
function assertMember(ctx: Ctx) {
  if (
    !ctx.user ||
    ctx.actor.type !== "user" ||
    ctx.actor.id !== ctx.user.id ||
    ctx.actor.representedUserId !== ctx.user.id
  )
    throw new ApiError(403, "set_claim_unavailable", "A signed-in member is required.");
  return ctx.user;
}
export async function listMemberSetRewards(ctx: Ctx) {
  const user = assertMember(ctx);
  const rows = await all<{
    id: string;
    set_id: string;
    set_version: number;
    reward_amount: number;
    roster_json: string;
    owned: number;
    claimed: number;
  }>(
    ctx.db,
    `SELECT mr.id,mr.set_id,mr.set_version,mr.reward_amount,mr.roster_json,
   (SELECT COUNT(DISTINCT ci.card_id) FROM fb_card_instances ci WHERE ci.tenant_id=mr.tenant_id AND ci.user_id=? AND ci.status IN ('owned','reserved') AND ci.card_id IN (SELECT json_extract(value,'$[0]') FROM json_each(mr.roster_json))) AS owned,
   EXISTS (SELECT 1 FROM fb_set_completion_claims sc WHERE sc.tenant_id=mr.tenant_id AND sc.user_id=? AND sc.set_id=mr.set_id AND sc.set_version=mr.set_version) AS claimed
   FROM fb_member_set_releases mr WHERE mr.tenant_id=? AND ${memberReleaseSql} AND ${memberSessionSql} ORDER BY mr.id LIMIT 101`,
    user.id,
    user.id,
    ctx.tenant.id,
    ...memberSessionArgs(ctx),
  ).catch((error: unknown) => {
    if (/no such table: fb_member_set_(?:releases|revocations|active)\b/.test(String(error)))
      return [];
    throw error;
  });
  if (rows.length > 100)
    throw new ApiError(503, "set_list_overloaded", "Too many member sets to check safely.");
  return rows.map((row) => {
    const roster = JSON.parse(row.roster_json) as Array<[string, string, string, number]>;
    const label = roster
      .slice(0, 2)
      .map((card) => card[2])
      .join(" · ");
    return {
      id: row.set_id,
      release_id: row.id,
      name: `Member set · ${label}${roster.length > 2 ? ` +${roster.length - 2}` : ""}`,
      version: row.set_version,
      reward_amount: row.reward_amount,
      total: roster.length,
      owned: Number(row.owned),
      complete: Number(row.owned) === roster.length,
      claimed: Boolean(row.claimed),
    };
  });
}
export async function claimMemberSetCompletion(
  ctx: Ctx,
  setId: string,
  releaseId: string,
  key: string,
) {
  const user = assertMember(ctx);
  if (!key || key.length > 200)
    throw new ApiError(422, "idempotency_key_required", "A valid idempotency key is required.");
  const release = await first<{ id: string; set_version: number; reward_amount: number }>(
    ctx.db,
    `SELECT mr.id,mr.set_version,mr.reward_amount FROM fb_member_set_releases mr WHERE mr.id=? AND mr.tenant_id=? AND mr.set_id=? AND ${memberReleaseSql} AND ${memberSessionSql}`,
    releaseId,
    ctx.tenant.id,
    setId,
    ...memberSessionArgs(ctx),
  );
  if (!release)
    throw new ApiError(
      409,
      "set_completion_unavailable",
      "The set or your access changed. Refresh and try again.",
    );
  const existing = async () => {
    const rows = await all<{
      id: string;
      set_id: string;
      set_version: number;
      reward_amount: number;
      matched_release: number;
    }>(
      ctx.db,
      `SELECT sc.id,sc.set_id,sc.set_version,sc.reward_amount,EXISTS (SELECT 1 FROM fb_audit_events ae WHERE ae.tenant_id=sc.tenant_id AND ae.action='set.reward.claimed' AND json_extract(ae.metadata_json,'$.claim_id')=sc.id AND json_extract(ae.metadata_json,'$.release_id')=mr.id) AS matched_release FROM fb_set_completion_claims sc JOIN fb_member_set_releases mr ON mr.id=? AND mr.tenant_id=sc.tenant_id WHERE sc.tenant_id=? AND sc.user_id=? AND sc.idempotency_key=? AND ${memberReleaseSql} AND ${memberSessionSql} LIMIT 2`,
      releaseId,
      ctx.tenant.id,
      user.id,
      key,
      ...memberSessionArgs(ctx),
    );
    if (
      rows.length > 1 ||
      (rows[0] &&
        (rows[0].set_id !== setId ||
          rows[0].set_version !== release.set_version ||
          !rows[0].matched_release))
    )
      throw new ApiError(409, "idempotency_conflict", "That key was used for another claim.");
    return rows[0] ?? null;
  };
  const replay = await existing();
  if (replay)
    return {
      claim_id: replay.id,
      set_id: replay.set_id,
      set_version: replay.set_version,
      amount: replay.reward_amount,
    };
  const id = newId("swd"),
    now = nowIso();
  try {
    const [inserted] = await ctx.db.batch([
      ctx.db
        .prepare(
          `INSERT INTO fb_set_completion_claims(id,tenant_id,user_id,set_id,set_version,reward_amount,created_at,idempotency_key)
    SELECT ?,mr.tenant_id,?,mr.set_id,mr.set_version,mr.reward_amount,?,? FROM fb_member_set_releases mr
    WHERE mr.id=? AND mr.tenant_id=? AND mr.set_id=? AND ${memberReleaseSql} AND ${memberSessionSql}
    AND EXISTS (SELECT 1 FROM fb_wallets w WHERE w.tenant_id=mr.tenant_id AND w.user_id=?)
    AND NOT EXISTS (SELECT 1 FROM fb_set_completion_claims sc WHERE sc.tenant_id=mr.tenant_id AND sc.user_id=? AND sc.idempotency_key=?)
    AND NOT EXISTS (SELECT 1 FROM fb_set_memberships sm WHERE sm.tenant_id=mr.tenant_id AND sm.set_id=mr.set_id AND sm.set_version=mr.set_version AND NOT EXISTS (SELECT 1 FROM fb_card_instances ci WHERE ci.tenant_id=sm.tenant_id AND ci.user_id=? AND ci.card_id=sm.card_id AND ci.status IN ('owned','reserved')))`,
        )
        .bind(
          id,
          user.id,
          now,
          key,
          releaseId,
          ctx.tenant.id,
          setId,
          ...memberSessionArgs(ctx),
          user.id,
          user.id,
          key,
          user.id,
        ),
      ctx.db
        .prepare(
          `INSERT INTO fb_audit_events(id,tenant_id,actor_type,actor_id,represented_user_id,action,object_type,object_id,metadata_json,request_id,created_at)
    SELECT ?,?,'user',?,?,'set.reward.claimed','set',?,?,?,? WHERE changes()=1`,
        )
        .bind(
          newId("aud"),
          ctx.tenant.id,
          user.id,
          user.id,
          setId,
          JSON.stringify({
            version: release.set_version,
            amount: release.reward_amount,
            release_id: releaseId,
            claim_id: id,
          }),
          ctx.requestId,
          now,
        ),
    ]);
    if (inserted?.meta.changes)
      return {
        claim_id: id,
        set_id: setId,
        set_version: release.set_version,
        amount: release.reward_amount,
      };
  } catch (error) {
    if (!String(error).includes("UNIQUE")) throw error;
    const raced = await existing();
    if (raced)
      return {
        claim_id: raced.id,
        set_id: raced.set_id,
        set_version: raced.set_version,
        amount: raced.reward_amount,
      };
    const prior = await first<{ id: string }>(
      ctx.db,
      `SELECT sc.id FROM fb_set_completion_claims sc JOIN fb_member_set_releases mr ON mr.id=? AND mr.tenant_id=sc.tenant_id WHERE sc.tenant_id=? AND sc.user_id=? AND sc.set_id=? AND sc.set_version=? AND ${memberReleaseSql} AND ${memberSessionSql}`,
      releaseId,
      ctx.tenant.id,
      user.id,
      setId,
      release.set_version,
      ...memberSessionArgs(ctx),
    );
    if (prior)
      throw new ApiError(409, "already_claimed", "This set reward has already been claimed.");
    throw error;
  }
  const raced = await existing();
  if (raced)
    return {
      claim_id: raced.id,
      set_id: raced.set_id,
      set_version: raced.set_version,
      amount: raced.reward_amount,
    };
  throw new ApiError(
    409,
    "set_completion_unavailable",
    "The set or your access changed, or the roster is incomplete.",
  );
}
