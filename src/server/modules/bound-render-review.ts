import { boundLineageFence } from "./media";
import type { Ctx } from "../context";
import { ApiError } from "../context";
import { all, first, nowIso } from "../db";
import { newId } from "../ids";
import { collectionWriteGuard } from "./collections";
import { readVerifiedRenderInput } from "./assets";
import { commitRenderManifest, renderManifestReferenceFence } from "./render-manifest";
import { boundRenderAudienceFence } from "./bound-render-audience";

type Candidate = {
  side: "front" | "back";
  r2_key: string;
  object_version: string;
  object_etag: string;
  content_sha256: string;
  bytes: number;
  mime: string;
};
async function reviewSnapshot(ctx: Ctx, id: string, publicApproval: boolean) {
  const row = await first<{
    manifest_json: string;
    manifest_sha256: string;
    attempt: number;
    status: string;
    scope: "global" | "bot";
    collection_id: string;
  }>(
    ctx.db,
    `SELECT j.manifest_json,j.manifest_sha256,j.attempt,j.status,c.scope,c.id AS collection_id FROM fb_bound_render_jobs j
     JOIN fb_collections c ON c.id=json_extract(j.manifest_json,'$.collectionId') WHERE j.id=? AND j.tenant_id=?`,
    id,
    ctx.tenant.id,
  );
  if (!row || !["global", "bot"].includes(row.scope))
    throw new ApiError(404, "render_review_unavailable", "The render review is unavailable.");
  let raw: unknown;
  try {
    raw = JSON.parse(row.manifest_json);
  } catch {
    throw new ApiError(409, "render_review_unavailable", "The render review is invalid.");
  }
  const { manifest, sha256 } = await commitRenderManifest(raw);
  if (
    sha256 !== row.manifest_sha256 ||
    manifest.tenantId !== ctx.tenant.id ||
    manifest.collectionId !== row.collection_id
  )
    throw new ApiError(409, "render_review_unavailable", "The render review is invalid.");
  // A bearer represents a person but is not the provisioned Super Admin.
  // Delegated review requires a current collection scope or Bot authority.
  const guard = collectionWriteGuard(ctx, row.scope, row.collection_id, publicApproval, {denyAgentPlatform:true});
  let extra = "1",
    extraArgs: unknown[] = [];
  if (ctx.actor.type === "agent") {
    const credential = ctx.agentCredential;
    if (!credential?.verifiedTokenHash || !/^[a-f0-9]{64}$/.test(credential.verifiedTokenHash))
      throw new ApiError(403, "render_review_forbidden", "The reviewer credential is unavailable.");
    extra = `EXISTS (SELECT 1 FROM fb_agent_tokens t WHERE t.id=? AND t.grant_id=? AND t.token_hash=? AND t.revoked_at IS NULL)`;
    extraArgs = [credential.tokenId, credential.grantId, credential.verifiedTokenHash];
  }
  const permitted = await first(
    ctx.db,
    `SELECT 1 WHERE ${guard.sql} AND ${extra}`,
    ...guard.args,
    ...extraArgs,
  );
  if (!permitted)
    throw new ApiError(403, "render_review_forbidden", "The reviewer authority changed.");
  const items = await all<Candidate>(
    ctx.db,
    `SELECT side,r2_key,object_version,object_etag,content_sha256,bytes,mime FROM fb_bound_render_candidates
    WHERE tenant_id=? AND job_id=? AND attempt=? ORDER BY side`,
    ctx.tenant.id,
    id,
    row.attempt,
  );
  const front = items.find((x) => x.side === "front"),
    back = items.find((x) => x.side === "back");
  if (items.length !== 2 || !front || !back)
    throw new ApiError(409, "render_review_unavailable", "Both staged sides are required.");
  const fence = await renderManifestReferenceFence(manifest);
  const audienceFence = boundRenderAudienceFence(ctx, manifest.cardId);
  const lineage = await boundLineageFence(ctx, Object.values(manifest.assets).filter((item): item is NonNullable<typeof item> => item !== null).map(item => item.id));
  const candidateMatch = (side: Candidate) => [
    side.side,
    side.r2_key,
    side.object_version,
    side.object_etag,
    side.content_sha256,
    side.bytes,
    side.mime,
  ];
  const sideSql = `EXISTS (SELECT 1 FROM fb_bound_render_candidates c WHERE c.job_id=j.id AND c.tenant_id=j.tenant_id AND c.attempt=j.attempt
    AND c.side=? AND c.r2_key=? AND c.object_version=? AND c.object_etag=? AND c.content_sha256=? AND c.bytes=? AND c.mime=?)`;
  const matchSql = `j.id=? AND j.tenant_id=? AND j.attempt=? AND j.manifest_json=? AND j.manifest_sha256=?
    AND ${sideSql} AND ${sideSql} AND ${guard.sql} AND ${extra} AND ${fence.predicate} AND ${audienceFence.sql} AND ${lineage.sql}`;
  const matchArgs = [
    id,
    ctx.tenant.id,
    row.attempt,
    row.manifest_json,
    row.manifest_sha256,
    ...candidateMatch(front),
    ...candidateMatch(back),
    ...guard.args,
    ...extraArgs,
    ...fence.args,
    ...audienceFence.args,
    ...lineage.args,
  ];
  return { row, manifest, front, back, matchSql, matchArgs };
}

/** Preview is scoped and always rechecked after reading the exact pinned bytes. */
export async function inspectBoundRender(ctx: Ctx, id: string) {
  const snapshot = await reviewSnapshot(ctx, id, false);
  if (snapshot.row.status !== "awaiting_review")
    throw new ApiError(409, "render_review_unavailable", "The render is not awaiting review.");
  const read = (c: Candidate) =>
    readVerifiedRenderInput(ctx.media, {
      key: c.r2_key,
      version: c.object_version,
      etag: c.object_etag,
      sha256: c.content_sha256,
      bytes: c.bytes,
    });
  const [front, back] = await Promise.all([read(snapshot.front), read(snapshot.back)]);
  const current = await first(
    ctx.db,
    `SELECT 1 FROM fb_bound_render_jobs j WHERE j.status='awaiting_review' AND ${snapshot.matchSql}`,
    ...snapshot.matchArgs,
  );
  if (!current)
    throw new ApiError(
      409,
      "render_inputs_changed",
      "The review authority or render inputs changed.",
    );
  return {
    manifest: snapshot.manifest,
    manifestSha256: snapshot.row.manifest_sha256,
    attempt: snapshot.row.attempt,
    front: { sha256: snapshot.front.content_sha256, mime: snapshot.front.mime, bytes: front },
    back: { sha256: snapshot.back.content_sha256, mime: snapshot.back.mime, bytes: back },
  };
}

/** Record the exact reviewed pair. Public-showcase approval uses the existing
 * human Super Admin boundary; other creative reviews may use delegated scope. */
export async function reviewBoundRender(
  ctx: Ctx,
  id: string,
  input: {
    decision: "approved" | "rejected";
    manifestSha256: string;
    frontSha256: string;
    backSha256: string;
    note: string;
  },
) {
  if (
    !["approved", "rejected"].includes(input.decision) ||
    typeof input.note !== "string" ||
    input.note.length > 2000 ||
    ![input.manifestSha256, input.frontSha256, input.backSha256].every(
      (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value),
    )
  )
    throw new ApiError(422, "render_review_invalid", "Provide a valid render review.");
  const existing = async () => {
    const initial = await reviewSnapshot(ctx, id, false);
    if (initial.row.status !== input.decision) return null;
    const publicApproval =
      input.decision === "approved" && initial.manifest.metadata.serial === "PUBLIC SHOWCASE";
    const current = publicApproval ? await reviewSnapshot(ctx, id, true) : initial;
    return first<{ id: string; attempt: number }>(
      ctx.db,
      `SELECT r.id,r.attempt FROM fb_bound_render_jobs j
      JOIN fb_bound_render_reviews r ON r.job_id=j.id AND r.tenant_id=j.tenant_id AND r.attempt=j.attempt
      WHERE j.status=? AND r.decision=? AND r.manifest_sha256=? AND r.front_sha256=? AND r.back_sha256=?
        AND r.actor_type=? AND r.actor_id=? AND r.represented_user_id=? AND r.note=? AND ${current.matchSql}`,
      input.decision,
      input.decision,
      input.manifestSha256,
      input.frontSha256,
      input.backSha256,
      ctx.actor.type,
      ctx.actor.id,
      ctx.actor.representedUserId,
      input.note,
      ...current.matchArgs,
    );
  };
  const initial = await reviewSnapshot(ctx, id, false);
  if (initial.row.status !== "awaiting_review") {
    const replay = await existing();
    if (replay)
      return { id, attempt: replay.attempt, decision: input.decision, reviewId: replay.id };
    throw new ApiError(
      409,
      "render_review_changed",
      "This render has already been reviewed or is unavailable.",
    );
  }
  // Read bytes under ordinary creative-review authority before requesting the
  // stricter public approval guard at the commit boundary.
  const preview = await inspectBoundRender(ctx, id);
  if (
    preview.manifestSha256 !== input.manifestSha256 ||
    preview.front.sha256 !== input.frontSha256 ||
    preview.back.sha256 !== input.backSha256
  )
    throw new ApiError(409, "render_review_changed", "The render changed; inspect it again.");
  const publicApproval =
    input.decision === "approved" && preview.manifest.metadata.serial === "PUBLIC SHOWCASE";
  const snapshot = await reviewSnapshot(ctx, id, publicApproval),
    now = nowIso(),
    reviewId = newId("rrv");
  if (
    snapshot.row.attempt !== preview.attempt ||
    snapshot.row.manifest_sha256 !== preview.manifestSha256 ||
    snapshot.front.content_sha256 !== preview.front.sha256 ||
    snapshot.back.content_sha256 !== preview.back.sha256
  )
    throw new ApiError(409, "render_review_changed", "The render changed; inspect it again.");
  const results = await ctx.db.batch([
    ctx.db
      .prepare(
        `UPDATE fb_bound_render_jobs AS j SET status=?,updated_at=? WHERE j.status='awaiting_review' AND ${snapshot.matchSql} RETURNING id`,
      )
      .bind(input.decision, now, ...snapshot.matchArgs),
    ctx.db
      .prepare(
        `INSERT INTO fb_bound_render_reviews(id,tenant_id,job_id,attempt,decision,manifest_sha256,front_sha256,back_sha256,actor_type,actor_id,represented_user_id,note,created_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE changes()=1`,
      )
      .bind(
        reviewId,
        ctx.tenant.id,
        id,
        preview.attempt,
        input.decision,
        preview.manifestSha256,
        preview.front.sha256,
        preview.back.sha256,
        ctx.actor.type,
        ctx.actor.id,
        ctx.actor.representedUserId,
        input.note,
        now,
      ),
    ctx.db
      .prepare(
        `INSERT INTO fb_audit_events(id,tenant_id,actor_type,actor_id,represented_user_id,action,object_type,object_id,metadata_json,request_id,created_at)
      SELECT ?,?,?,?,?, 'render.bound_reviewed','bound_render_job',?,?,?,? WHERE changes()=1`,
      )
      .bind(
        newId("aud"),
        ctx.tenant.id,
        ctx.actor.type,
        ctx.actor.id,
        ctx.actor.representedUserId,
        id,
        JSON.stringify({ decision: input.decision, review_id: reviewId }),
        ctx.requestId,
        now,
      ),
  ]);
  let saved: { id: string; attempt: number } | null;
  try {
    saved = await existing();
  } catch (error) {
    if (results[0]?.results?.length)
      throw new ApiError(
        409,
        "render_review_receipt_pending",
        "The review may have been recorded. Retry the same review after restoring access.",
      );
    throw error;
  }
  if (saved) return { id, attempt: saved.attempt, decision: input.decision, reviewId: saved.id };
  if (!results[0]?.results?.length)
    throw new ApiError(409, "render_review_changed", "The reviewer authority or render changed.");
  throw new ApiError(
    409,
    "render_review_receipt_pending",
    "The review may have been recorded. Retry the same review after restoring access.",
  );
}
