import { ApiError, requireRecentStrongAuth, requireSuperAdmin, type Ctx } from "../context";
import { all, first, nowIso } from "../db";
import { newId, sha256Hex } from "../ids";

// Canonical order and a small fixed maximum keep the review and claim bounded.
export const rosterSql = `SELECT COALESCE(json_group_array(json_array(card_id,slug,name,sort)),'[]') FROM
  (SELECT sm.card_id,cd.slug,cd.name,sm.sort FROM fb_set_memberships sm JOIN fb_card_definitions cd ON cd.id=sm.card_id AND cd.tenant_id=sm.tenant_id WHERE sm.tenant_id = ? AND sm.set_id = ? AND sm.set_version = ? ORDER BY sm.card_id)`;
export const publicRosterSql = `NOT EXISTS (
  SELECT 1 FROM fb_set_memberships sm LEFT JOIN fb_card_definitions cd ON cd.id = sm.card_id AND cd.tenant_id = sm.tenant_id
  WHERE sm.tenant_id = ? AND sm.set_id = ? AND sm.set_version = ? AND (
    cd.id IS NULL OR cd.status <> 'published' OR cd.archived_at IS NOT NULL
    OR NOT EXISTS (SELECT 1 FROM fb_collection_cards cc WHERE cc.card_id = sm.card_id)
    OR EXISTS (SELECT 1 FROM fb_collection_cards cc JOIN fb_collections c ON c.id = cc.collection_id
      WHERE cc.card_id = sm.card_id AND NOT (c.scope = 'global' AND c.status = 'published' AND c.archived_at IS NULL AND c.view_audience = 'public' AND c.public_approved_at IS NOT NULL))
  ))`;

/** Correlated, live validity for a previously and explicitly reviewed release. */
export const currentReleaseSql = `NOT EXISTS (SELECT 1 FROM fb_public_set_release_revocations rv WHERE rv.release_id = pr.id)
  AND EXISTS (SELECT 1 FROM fb_sets s JOIN fb_set_reward_rules r ON r.tenant_id=s.tenant_id AND r.set_id=s.id AND r.set_version=s.version
    WHERE s.tenant_id=pr.tenant_id AND s.id=pr.set_id AND s.status='published' AND s.version=pr.set_version
      AND s.slug=pr.slug AND s.name=pr.name AND s.description=pr.description AND r.reward_amount=pr.reward_amount)
  AND (SELECT COALESCE(json_group_array(json_array(card_id,slug,name,sort)),'[]') FROM (SELECT sm.card_id,cd.slug,cd.name,sm.sort FROM fb_set_memberships sm JOIN fb_card_definitions cd ON cd.id=sm.card_id AND cd.tenant_id=sm.tenant_id WHERE sm.tenant_id=pr.tenant_id AND sm.set_id=pr.set_id AND sm.set_version=pr.set_version ORDER BY sm.card_id))=pr.roster_json
  AND json_array_length(pr.roster_json) BETWEEN 1 AND 40
  AND NOT EXISTS (SELECT 1 FROM fb_set_memberships sm LEFT JOIN fb_card_definitions cd ON cd.id=sm.card_id AND cd.tenant_id=sm.tenant_id
    WHERE sm.tenant_id=pr.tenant_id AND sm.set_id=pr.set_id AND sm.set_version=pr.set_version AND
      (cd.id IS NULL OR cd.status<>'published' OR cd.archived_at IS NOT NULL
       OR NOT EXISTS (SELECT 1 FROM fb_collection_cards cc WHERE cc.card_id=sm.card_id)
       OR EXISTS (SELECT 1 FROM fb_collection_cards cc JOIN fb_collections c ON c.id=cc.collection_id
          WHERE cc.card_id=sm.card_id AND NOT (c.scope='global' AND c.status='published' AND c.archived_at IS NULL AND c.view_audience='public' AND c.public_approved_at IS NOT NULL))))`;

export async function currentPublicSetRelease(ctx: Ctx, setId: string) {
  try {
    return await first<{
      id: string;
      set_version: number;
      reward_amount: number;
      slug: string;
      name: string;
      description: string;
      roster_json: string;
    }>(
      ctx.db,
      `SELECT pr.id,pr.set_version,pr.reward_amount,pr.slug,pr.name,pr.description,pr.roster_json FROM fb_public_set_releases pr WHERE pr.tenant_id=? AND pr.set_id=? AND ${currentReleaseSql} LIMIT 1`,
      ctx.tenant.id,
      setId,
    );
  } catch (error) {
    // Before additive migration 0031 is applied, no release can be certified.
    // Do not hide other database faults as an empty public roster.
    if (
      /no such table: (?:fb_public_set_releases|fb_public_set_release_revocations)\b/.test(
        String(error),
      )
    )
      return null;
    throw error;
  }
}

/** Two bind parameters regardless of roster count; callers enforce the cap. */
export async function currentPublicSetReleases(ctx: Ctx, setIds: string[]) {
  if (setIds.length > 100) throw new ApiError(503,"set_list_overloaded","Too many sets to check safely. Please contact an administrator.");
  if (!setIds.length) return new Map();
  try {
    const rows = await all<{id:string;set_id:string;set_version:number;reward_amount:number;slug:string;name:string;description:string;roster_json:string}>(ctx.db,
      `SELECT pr.id,pr.set_id,pr.set_version,pr.reward_amount,pr.slug,pr.name,pr.description,pr.roster_json FROM fb_public_set_releases pr WHERE pr.tenant_id=? AND pr.set_id IN (SELECT value FROM json_each(?)) AND ${currentReleaseSql}`,
      ctx.tenant.id,JSON.stringify(setIds));
    return new Map(rows.map(row => [row.set_id,row]));
  } catch (error) {
    if (/no such table: (?:fb_public_set_releases|fb_public_set_release_revocations)\b/.test(String(error))) return new Map();
    throw error;
  }
}

export interface PublicSetSnapshot {
  id: string;
  version: number;
  slug: string;
  name: string;
  description: string;
  reward: number;
  roster: Array<[string, string, string, number]>;
}

async function snapshot(ctx: Ctx, setId: string): Promise<PublicSetSnapshot> {
  const row = await first<{
    id: string;
    version: number;
    slug: string;
    name: string;
    description: string;
    reward: number | null;
  }>(
    ctx.db,
    `SELECT s.id,s.version,s.slug,s.name,s.description,r.reward_amount AS reward FROM fb_sets s
      LEFT JOIN fb_set_reward_rules r ON r.tenant_id=s.tenant_id AND r.set_id=s.id AND r.set_version=s.version
      WHERE s.tenant_id=? AND s.id=? AND s.status='published'`,
    ctx.tenant.id,
    setId,
  );
  if (!row || row.reward === null)
    throw new ApiError(
      409,
      "public_set_unavailable",
      "A published set with a frozen reward is required.",
    );
  const members = await all<{ card_id: string; slug: string; name: string; sort: number }>(
    ctx.db,
    "SELECT sm.card_id,cd.slug,cd.name,sm.sort FROM fb_set_memberships sm JOIN fb_card_definitions cd ON cd.id=sm.card_id AND cd.tenant_id=sm.tenant_id WHERE sm.tenant_id=? AND sm.set_id=? AND sm.set_version=? ORDER BY sm.card_id LIMIT 41",
    ctx.tenant.id,
    row.id,
    row.version,
  );
  if (!members.length || members.length > 40)
    throw new ApiError(
      409,
      "public_set_unavailable",
      "The reviewed roster must contain between 1 and 40 cards.",
    );
  const ok = await first<{ ok: number }>(
    ctx.db,
    `SELECT CASE WHEN ${publicRosterSql} THEN 1 ELSE 0 END AS ok`,
    ctx.tenant.id,
    row.id,
    row.version,
  );
  if (!ok?.ok)
    throw new ApiError(
      409,
      "public_set_unavailable",
      "Every roster card must be currently public-approved.",
    );
  return {
    id: row.id,
    version: row.version,
    slug: row.slug,
    name: row.name,
    description: row.description,
    reward: row.reward,
    roster: members.map((m) => [m.card_id, m.slug, m.name, m.sort]),
  };
}

export async function previewPublicSetRelease(ctx: Ctx, setId: string) {
  await assertReviewer(ctx);
  const value = await snapshot(ctx, setId);
  await assertReviewer(ctx);
  return { snapshot: value, snapshot_hash: await sha256Hex(JSON.stringify(value)) };
}

// Review changes require an actual persisted passkey/MFA session. Access JWT
// review is held until an equivalent transaction-bound assurance is available.
const reviewerSql = `EXISTS (SELECT 1 FROM fb_users u JOIN fb_platform_admins pa ON pa.user_id=u.id AND pa.status='active' AND pa.revoked_at IS NULL
  JOIN fb_memberships m ON m.user_id=u.id AND m.tenant_id=? AND m.status='active' AND m.revoked_at IS NULL
  JOIN fb_sessions sess ON sess.id=? AND sess.user_id=u.id AND sess.tenant_id=m.tenant_id
  WHERE u.id=? AND u.platform_admin=1 AND u.disabled_at IS NULL AND sess.revoked_at IS NULL
    AND sess.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now') AND sess.assurance IN ('passkey','mfa')
    AND sess.assurance=? AND sess.auth_time >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 minutes')
    AND sess.auth_time <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

async function assertReviewer(ctx: Ctx) {
  const user = requireSuperAdmin(ctx);
  requireRecentStrongAuth(ctx, 30);
  if (
    ctx.actor.id !== user.id ||
    ctx.actor.representedUserId !== user.id ||
    !ctx.sessionId ||
    !["passkey", "mfa"].includes(ctx.sessionAssurance ?? "")
  )
    throw new ApiError(
      403,
      "review_session_required",
      "A current passkey or MFA session is required.",
    );
  const current = await first<{ ok: number }>(
    ctx.db,
    `SELECT CASE WHEN ${reviewerSql} THEN 1 ELSE 0 END AS ok`,
    ctx.tenant.id,
    ctx.sessionId,
    user.id,
    ctx.sessionAssurance,
  );
  if (!current?.ok)
    throw new ApiError(
      403,
      "review_session_required",
      "The reviewer session or platform authority is no longer active.",
    );
  return user;
}

/** Discover review candidates within this Bot; never infer public approval. */
export async function listPublicSetReviewCandidates(ctx: Ctx) {
  const user = await assertReviewer(ctx);
  const rosterEligible = publicRosterSql.replace("?", "s.tenant_id").replace("?", "s.id").replace("?", "s.version");
  const eligible = `(s.status='published' AND r.reward_amount IS NOT NULL
    AND (SELECT COUNT(*) FROM fb_set_memberships sm WHERE sm.tenant_id=s.tenant_id AND sm.set_id=s.id AND sm.set_version=s.version) BETWEEN 1 AND 40
    AND ${rosterEligible})`;
  const history = `EXISTS (SELECT 1 FROM fb_public_set_releases h WHERE h.tenant_id=s.tenant_id AND h.set_id=s.id)`;
  const rows = await all<{id:string;name:string;version:number;eligible:number;has_history:number}>(ctx.db,
    `SELECT s.id,s.name,s.version,CASE WHEN ${eligible} THEN 1 ELSE 0 END AS eligible,
      CASE WHEN ${history} THEN 1 ELSE 0 END AS has_history
     FROM fb_sets s LEFT JOIN fb_set_reward_rules r ON r.tenant_id=s.tenant_id AND r.set_id=s.id AND r.set_version=s.version
     WHERE s.tenant_id=? AND ${reviewerSql} AND (${eligible} OR ${history}) ORDER BY s.name,s.id LIMIT 101`,
    ctx.tenant.id,ctx.tenant.id,ctx.sessionId,user.id,ctx.sessionAssurance);
  if (rows.length>100) throw new ApiError(503,"set_list_overloaded","Too many review candidates to show safely.");
  return {items:rows.map(row=>({...row,eligible:Boolean(row.eligible),has_history:Boolean(row.has_history)}))};
}

export async function listPublicSetReviews(ctx: Ctx, setId: string) {
  await assertReviewer(ctx);
  const rows = await all<{
    id: string;
    set_version: number;
    snapshot_hash: string;
    review_note: string;
    reviewed_by: string;
    reviewed_at: string;
    revoked_at: string | null;
    reason: string | null;
  }>(
    ctx.db,
    `SELECT pr.id,pr.set_version,pr.snapshot_hash,pr.review_note,pr.reviewed_by,pr.reviewed_at,rv.revoked_at,rv.reason
     FROM fb_public_set_releases pr LEFT JOIN fb_public_set_release_revocations rv ON rv.release_id=pr.id
     WHERE pr.tenant_id=? AND pr.set_id=? ORDER BY pr.reviewed_at DESC,pr.id DESC`,
    ctx.tenant.id,
    setId,
  );
  await assertReviewer(ctx);
  return { items: rows };
}

export async function approvePublicSetRelease(
  ctx: Ctx,
  setId: string,
  expectedHash: string,
  note: string,
) {
  const user = await assertReviewer(ctx);
  if (note.trim().length < 20 || note.length > 2000)
    throw new ApiError(422, "review_note_required", "Record the review in at least 20 characters.");
  const value = await snapshot(ctx, setId);
  const hash = await sha256Hex(JSON.stringify(value));
  if (hash !== expectedHash)
    throw new ApiError(409, "public_set_changed", "The reviewed set changed; review it again.");
  const id = newId("psr"),
    now = nowIso(),
    roster = JSON.stringify(value.roster);
  const insert = ctx.db
    .prepare(
      `INSERT INTO fb_public_set_releases (id,tenant_id,set_id,set_version,slug,name,description,reward_amount,roster_json,snapshot_hash,review_note,reviewed_by,reviewed_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${reviewerSql}
    AND EXISTS (SELECT 1 FROM fb_sets s JOIN fb_set_reward_rules r ON r.tenant_id=s.tenant_id AND r.set_id=s.id AND r.set_version=s.version
      WHERE s.tenant_id=? AND s.id=? AND s.status='published' AND s.version=? AND s.slug=? AND s.name=? AND s.description=? AND r.reward_amount=?)
    AND (${rosterSql})=? AND ${publicRosterSql}`,
    )
    .bind(
      id,
      ctx.tenant.id,
      value.id,
      value.version,
      value.slug,
      value.name,
      value.description,
      value.reward,
      roster,
      hash,
      note.trim(),
      user.id,
      now,
      ctx.tenant.id,
      ctx.sessionId,
      user.id,
      ctx.sessionAssurance,
      ctx.tenant.id,
      value.id,
      value.version,
      value.slug,
      value.name,
      value.description,
      value.reward,
      ctx.tenant.id,
      value.id,
      value.version,
      roster,
      ctx.tenant.id,
      value.id,
      value.version,
    );
  const audit = ctx.db
    .prepare(
      `INSERT INTO fb_audit_events (id,tenant_id,actor_type,actor_id,represented_user_id,action,object_type,object_id,metadata_json,request_id,created_at)
    SELECT ?,?,'user',?,?,'public_set.approved','set',?,?,?,? WHERE changes()=1`,
    )
    .bind(
      newId("aud"),
      ctx.tenant.id,
      user.id,
      user.id,
      value.id,
      JSON.stringify({ release_id: id, snapshot_hash: hash }),
      ctx.requestId,
      now,
    );
  let result: D1Result | undefined;
  try {
    [result] = await ctx.db.batch([insert, audit]);
  } catch (error) {
    if (
      String(error).includes("UNIQUE") &&
      (await first<{ id: string }>(
        ctx.db,
        "SELECT id FROM fb_public_set_releases WHERE tenant_id=? AND set_id=? AND set_version=?",
        ctx.tenant.id,
        value.id,
        value.version,
      ))
    )
      throw new ApiError(
        409,
        "public_set_version_already_reviewed",
        "This set version has already been reviewed. Create a new version for another review.",
      );
    throw error;
  }
  if (!result?.meta.changes)
    throw new ApiError(
      409,
      "public_set_changed",
      "The set or reviewer authority changed; review it again.",
    );
  return { id, snapshot_hash: hash };
}

export async function revokePublicSetRelease(ctx: Ctx, releaseId: string, reason: string) {
  const user = await assertReviewer(ctx);
  if (reason.trim().length < 20 || reason.length > 2000)
    throw new ApiError(422, "review_note_required", "Record the reason in at least 20 characters.");
  const now = nowIso();
  const insert = ctx.db
    .prepare(
      `INSERT INTO fb_public_set_release_revocations (release_id,revoked_by,revoked_at,reason)
    SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM fb_public_set_releases WHERE id=? AND tenant_id=?) AND ${reviewerSql}`,
    )
    .bind(
      releaseId,
      user.id,
      now,
      reason.trim(),
      releaseId,
      ctx.tenant.id,
      ctx.tenant.id,
      ctx.sessionId,
      user.id,
      ctx.sessionAssurance,
    );
  const audit = ctx.db
    .prepare(
      `INSERT INTO fb_audit_events (id,tenant_id,actor_type,actor_id,represented_user_id,action,object_type,object_id,metadata_json,request_id,created_at)
    SELECT ?,?,'user',?,?,'public_set.revoked','public_set_release',?,'{}',?,? WHERE changes()=1`,
    )
    .bind(newId("aud"), ctx.tenant.id, user.id, user.id, releaseId, ctx.requestId, now);
  let result: D1Result | undefined;
  try {
    [result] = await ctx.db.batch([insert, audit]);
  } catch (error) {
    if (
      String(error).includes("UNIQUE") &&
      (await first<{ release_id: string }>(
        ctx.db,
        "SELECT release_id FROM fb_public_set_release_revocations WHERE release_id=?",
        releaseId,
      ))
    )
      throw new ApiError(
        409,
        "public_set_already_revoked",
        "This release has already been revoked.",
      );
    throw error;
  }
  if (!result?.meta.changes)
    throw new ApiError(409, "public_set_changed", "The release or reviewer authority changed.");
  return { revoked: true };
}
