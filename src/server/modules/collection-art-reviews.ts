import { imageSize } from "image-size";
import { ApiError, requireRecentStrongAuth, requireUser, type Ctx } from "../context";
import { first, nowIso } from "../db";
import { newId, sha256Hex } from "../ids";

type Selection = { id: string; sha256: string };
export type CollectionArtDecision = {
  decision: "approved" | "rejected";
  note: string;
  mark: Selection;
  cover: Selection;
  back: Selection;
  evidence: Selection;
};

// This path deliberately does not use the compatibility role parser, which
// treats malformed or empty global-role scopes as unrestricted.
const authority = `EXISTS (
  SELECT 1 FROM fb_collections c JOIN fb_users u ON u.id = ?
  JOIN fb_memberships m ON m.user_id = u.id AND m.tenant_id = ? AND m.status = 'active' AND m.revoked_at IS NULL
  JOIN fb_sessions s ON s.id = ? AND s.user_id = u.id AND s.tenant_id = m.tenant_id
    AND s.revoked_at IS NULL AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    AND s.assurance = ? AND (s.assurance = 'access' OR (s.assurance IN ('passkey','mfa')
      AND s.auth_time >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 minutes')
      AND s.auth_time <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))
  WHERE c.id = ? AND c.archived_at IS NULL AND u.disabled_at IS NULL
    AND ((u.platform_admin = 1 AND EXISTS (SELECT 1 FROM fb_platform_admins p WHERE p.user_id = u.id AND p.status = 'active' AND p.revoked_at IS NULL))
      OR (c.scope = 'global' AND EXISTS (SELECT 1 FROM fb_platform_role_assignments p
        WHERE p.user_id = u.id AND p.role = 'global_collection_admin' AND p.status = 'active' AND p.revoked_at IS NULL
          AND json_valid(p.scopes_json) AND (json_type(CASE WHEN json_valid(p.scopes_json) THEN p.scopes_json ELSE '{}' END, '$.all') = 'true'
            OR (json_type(CASE WHEN json_valid(p.scopes_json) THEN p.scopes_json ELSE '{}' END, '$.all') = 'false'
              AND json_type(CASE WHEN json_valid(p.scopes_json) THEN p.scopes_json ELSE '{}' END, '$.collectionIds') = 'array'
              AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(p.scopes_json) THEN p.scopes_json ELSE '{}' END, '$.collectionIds') WHERE type <> 'text')
              AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(p.scopes_json) THEN p.scopes_json ELSE '{}' END, '$.collectionIds') WHERE value = c.id)))))
      OR (c.scope = 'bot' AND c.owner_tenant_id = m.tenant_id AND m.role = 'owner'
        AND EXISTS (SELECT 1 FROM fb_bots b WHERE b.tenant_id = m.tenant_id AND b.owner_user_id = u.id AND b.status = 'active')))
)`;

export async function recordCollectionArtReview(ctx: Ctx, collectionId: string, input: CollectionArtDecision) {
  const user = requireUser(ctx);
  if (ctx.actor.type !== "user") throw new ApiError(403, "human_strong_auth_required", "Recording this decision requires a signed-in human with recent strong authentication.");
  if (ctx.actor.id !== user.id || ctx.actor.representedUserId !== user.id) throw new ApiError(403, "review_actor_invalid", "The reviewer must match the signed-in account.");
  requireRecentStrongAuth(ctx, 30);
  if (!ctx.sessionId) throw new ApiError(403, "session_required", "Sign in again before recording a review.");
  const note = input.note.trim();
  if (note.length < 20 || note.length > 2000) throw new ApiError(422, "review_note_required", "Describe the reviewed artwork and evidence in at least 20 characters.");
  const selections = [input.mark, input.cover, input.back, input.evidence];
  const args = [user.id, ctx.tenant.id, ctx.sessionId, ctx.sessionAssurance, collectionId];
  const permitted = await first<{ ok: number }>(ctx.db, `SELECT ${authority} AS ok`, ...args);
  if (!permitted?.ok) throw new ApiError(403, "collection_review_forbidden", "This account cannot review that collection.");
  const snapshots: Array<{ r2_key: string; mime: string; revision: number; processing_state: string }> = [];
  for (const selection of selections) {
    if (!/^[a-f0-9]{64}$/.test(selection.sha256)) throw new ApiError(422, "review_hash_invalid", "Each selected asset needs its exact SHA-256.");
    const asset = await first<{ id: string; r2_key: string; sha256: string; review_status: string; mime: string; revision: number; processing_state: string }>(ctx.db,
      "SELECT id, r2_key, sha256, review_status, mime, revision, processing_state FROM fb_assets WHERE id = ? AND tenant_id = ? AND archived_at IS NULL", selection.id, ctx.tenant.id);
    if (!asset || asset.sha256 !== selection.sha256 || asset.processing_state !== "ready" || ["rejected", "placeholder"].includes(asset.review_status) || !["image/png", "image/jpeg", "image/webp"].includes(asset.mime)) throw new ApiError(422, "review_asset_invalid", "A selected asset is unavailable, rejected or does not match its recorded hash.");
    if (asset.r2_key.startsWith('collection-brand-v1/')) throw new ApiError(409, 'review_asset_unavailable', 'This collection image cannot yet be reviewed.');
    if (asset.r2_key.startsWith('bound-render-stage-v1/')) throw new ApiError(409, 'review_asset_unavailable', 'This render must use its version-bound review.');
    const object = await ctx.media.get(asset.r2_key);
    if (!object) throw new ApiError(422, "review_asset_missing", "A selected asset is missing from storage.");
    if (object.size > 8 * 1024 * 1024) throw new ApiError(422, "review_asset_invalid", "A selected asset is too large to review.");
    const bytes = new Uint8Array(await object.arrayBuffer());
    let dimensions: { width?: number; height?: number };
    try { dimensions = imageSize(bytes); } catch { throw new ApiError(422, "review_asset_invalid", "A selected asset is not a readable image."); }
    if (!dimensions.width || !dimensions.height || await sha256Hex(bytes) !== selection.sha256) throw new ApiError(409, "review_asset_changed", "A selected asset changed; reload it before reviewing.");
    snapshots.push(asset);
  }
  const id = newId("car");
  const now = nowIso();
  const guard = selections.map(() => "EXISTS (SELECT 1 FROM fb_assets WHERE id = ? AND tenant_id = ? AND sha256 = ? AND r2_key = ? AND mime = ? AND revision = ? AND processing_state = ? AND archived_at IS NULL AND review_status NOT IN ('rejected','placeholder'))").join(" AND ");
  const insert = ctx.db.prepare(`INSERT INTO fb_collection_art_reviews
    (id, tenant_id, collection_id, decision, actor_kind, actor_id, represented_user_id, mark_asset_id, mark_sha256, cover_asset_id, cover_sha256, back_asset_id, back_sha256, evidence_asset_id, evidence_sha256, note, request_id, created_at)
    SELECT ?, ?, ?, ?, 'user', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${authority} AND ${guard}`)
    .bind(id, ctx.tenant.id, collectionId, input.decision, ctx.actor.id, user.id,
      ...selections.flatMap((item) => [item.id, item.sha256]), note, ctx.requestId, now,
      ...args, ...selections.flatMap((item, index) => [item.id, ctx.tenant.id, item.sha256, snapshots[index]!.r2_key, snapshots[index]!.mime, snapshots[index]!.revision, snapshots[index]!.processing_state]));
  const audit = ctx.db.prepare(`INSERT INTO fb_audit_events (id, tenant_id, actor_type, actor_id, represented_user_id, action, object_type, object_id, metadata_json, request_id, created_at)
    SELECT ?, ?, 'user', ?, ?, 'collection.art.reviewed', 'collection_art_review', ?, ?, ?, ? WHERE changes() = 1`)
    .bind(newId("aud"), ctx.tenant.id, ctx.actor.id, user.id, id, JSON.stringify({ collection_id: collectionId, decision: input.decision }), ctx.requestId, now);
  const [result] = await ctx.db.batch([insert, audit]);
  if (result?.meta.changes !== 1) throw new ApiError(409, "review_changed", "Access or a selected asset changed. Reload before recording the review.");
  return { id, collection_id: collectionId, decision: input.decision, actor_kind: "user", actor_id: ctx.actor.id, created_at: now };
}
