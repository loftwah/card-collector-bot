import { boundLineageFence } from "./media";
import type { Ctx } from "../context";
import { ApiError } from "../context";
import { all, first, nowIso } from "../db";
import { canonicalJson, newId, sha256Hex } from "../ids";
import { imageSize } from "image-size";
import { detectMime, getAsset, readAsset, readVerifiedRenderInput } from "./assets";
import { liveStrongHumanSession, strongHumanArgs } from "./strong-session";
import { effectiveCardAudience } from "./visibility";
import { boundRenderAudienceFence } from "./bound-render-audience";
import {
  commitRenderManifest,
  readRenderManifestInputs,
  renderManifestReferenceFence,
} from "./render-manifest";

// This protocol is not wired to the public job routes yet. A designated
// credential remains subject to live grant, Bot authority and token checks.
function operator(ctx: Ctx) {
  const c = ctx.agentCredential,
    user = ctx.user;
  if (
    ctx.actor.type !== "agent" ||
    !user ||
    ctx.actor.representedUserId !== user.id ||
    !c?.grantId ||
    !c.tokenId ||
    !/^[a-f0-9]{64}$/.test(c.verifiedTokenHash ?? "")
  )
    throw new ApiError(
      403,
      "render_operator_required",
      "A designated renderer credential is required.",
    );
  return {
    sql: `EXISTS (SELECT 1 FROM fb_render_operators o
      JOIN fb_agent_tokens t ON t.id=o.token_id AND t.grant_id=o.grant_id
      JOIN fb_agent_grants g ON g.id=t.grant_id AND g.tenant_id=o.tenant_id
      JOIN fb_users u ON u.id=g.represented_user_id AND u.disabled_at IS NULL
      JOIN fb_memberships m ON m.user_id=u.id AND m.tenant_id=g.tenant_id AND m.status='active' AND m.revoked_at IS NULL
      JOIN fb_bots b ON b.tenant_id=g.tenant_id AND b.status='active'
      LEFT JOIN fb_bot_admins ba ON ba.bot_id=b.id AND ba.user_id=u.id
      WHERE o.tenant_id=? AND o.grant_id=? AND o.token_id=? AND o.status='active' AND o.revoked_at IS NULL
        AND t.revoked_at IS NULL AND t.token_hash=? AND o.token_hash=t.token_hash AND g.agent_id=? AND g.represented_user_id=?
        AND g.status='active' AND g.revoked_at IS NULL AND g.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
        AND json_type(CASE WHEN json_valid(g.scopes_json) THEN g.scopes_json ELSE 'null' END)='array'
        AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(g.scopes_json) THEN g.scopes_json ELSE '[]' END) WHERE type<>'text')
        AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(g.scopes_json) THEN g.scopes_json ELSE '[]' END) WHERE value='render:write')
        AND ((m.role='owner' AND b.owner_user_id=u.id) OR (m.role<>'owner' AND ba.role='admin' AND ba.status='active' AND ba.revoked_at IS NULL
          AND json_type(CASE WHEN json_valid(m.capabilities_json) THEN m.capabilities_json ELSE 'null' END)='array'
          AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(m.capabilities_json) THEN m.capabilities_json ELSE '[]' END) WHERE type<>'text')
          AND json_type(CASE WHEN json_valid(ba.capabilities_json) THEN ba.capabilities_json ELSE 'null' END)='array'
          AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(ba.capabilities_json) THEN ba.capabilities_json ELSE '[]' END) WHERE type<>'text')
          AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(m.capabilities_json) THEN m.capabilities_json ELSE '[]' END) WHERE value='content')
          AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(ba.capabilities_json) THEN ba.capabilities_json ELSE '[]' END) WHERE value='content'))))`,
    args: [ctx.tenant.id, c.grantId, c.tokenId, c.verifiedTokenHash, ctx.actor.id, user.id],
    grantId: c.grantId,
    tokenId: c.tokenId,
    tokenHash: c.verifiedTokenHash!,
  };
}

function auditForChange(ctx: Ctx, action: string, jobId: string, manifestSha: string) {
  return ctx.db
    .prepare(
      `INSERT INTO fb_audit_events
    (id,tenant_id,actor_type,actor_id,represented_user_id,action,object_type,object_id,metadata_json,request_id,created_at)
    SELECT ?,?,?,?,?,?,'bound_render_job',?,?,?,? WHERE changes()=1`,
    )
    .bind(
      newId("aud"),
      ctx.tenant.id,
      ctx.actor.type,
      ctx.actor.id,
      ctx.actor.representedUserId,
      action,
      jobId,
      JSON.stringify({ manifest_sha256: manifestSha }),
      ctx.requestId,
      nowIso(),
    );
}

/** Queue only a previously reviewed, byte-verifiable manifest. No output is published. */
export async function queueBoundRender(ctx: Ctx, input: unknown, key: string) {
  const auth = operator(ctx);
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(key))
    throw new ApiError(422, "idempotency_key_invalid", "Provide a render request key.");
  const { manifest, sha256 } = await commitRenderManifest(input);
  const audienceFence = boundRenderAudienceFence(ctx, manifest.cardId);
  if (manifest.tenantId !== ctx.tenant.id)
    throw new ApiError(404, "render_inputs_changed", "Render inputs are unavailable.");
  if (
    Object.values(manifest.assets).some(
      (a) =>
        a && (a.processingState !== "ready" || !["reviewed", "approved"].includes(a.reviewStatus)),
    )
  )
    throw new ApiError(
      409,
      "render_review_required",
      "All render inputs must already be reviewed and ready.",
    );
  const lineage = await boundLineageFence(ctx, Object.values(manifest.assets).filter((item): item is NonNullable<typeof item> => item !== null).map(item => item.id));
  const existing = () =>
    first<{ id: string; manifest_sha256: string; status: string }>(
      ctx.db,
      `SELECT j.id,j.manifest_sha256,j.status FROM fb_bound_render_jobs j WHERE j.tenant_id=? AND j.idempotency_key=?
     AND j.operator_grant_id=? AND j.operator_token_id=? AND j.operator_token_hash=? AND ${auth.sql} AND ${audienceFence.sql} AND ${lineage.sql}`,
      ctx.tenant.id,
      key,
      auth.grantId,
      auth.tokenId,
      auth.tokenHash,
      ...auth.args,
      ...audienceFence.args,
      ...lineage.args,
    );
  const previous = await existing();
  if (previous) {
    if (previous.manifest_sha256 !== sha256)
      throw new ApiError(
        409,
        "idempotency_conflict",
        "This render request key was used for different inputs.",
      );
    return { id: previous.id, status: previous.status };
  }
  // R2 is checked again by the executor before consumption. This check alone
  // cannot prevent an overwrite between stores and is not publication proof.
  await readRenderManifestInputs(ctx.media, manifest);
  const fence = await renderManifestReferenceFence(manifest),
    id = newId("brj"),
    now = nowIso();
  await ctx.db.batch([
    ctx.db
      .prepare(
        `INSERT INTO fb_bound_render_jobs
      (id,tenant_id,idempotency_key,manifest_json,manifest_sha256,operator_grant_id,operator_token_id,operator_token_hash,status,attempt,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,?,'pending',0,?,? WHERE ${auth.sql} AND ${fence.predicate} AND ${audienceFence.sql} AND ${lineage.sql}
      ON CONFLICT DO NOTHING`,
      )
      .bind(
        id,
        ctx.tenant.id,
        key,
        canonicalJson(manifest),
        sha256,
        auth.grantId,
        auth.tokenId,
        auth.tokenHash,
        now,
        now,
        ...auth.args,
        ...fence.args,
        ...audienceFence.args,
        ...lineage.args,
      ),
    auditForChange(ctx, "render.bound_queued", id, sha256),
  ]);
  const saved = await existing();
  if (!saved)
    throw new ApiError(
      409,
      "render_inputs_changed",
      "The renderer credential or render inputs changed; retry after refreshing.",
    );
  if (saved.manifest_sha256 !== sha256)
    throw new ApiError(
      409,
      "idempotency_conflict",
      "This render request key was used for different inputs.",
    );
  return { id: saved.id, status: saved.status };
}

/** Claim is bound to the exact designated credential and current D1 references. */
export async function claimBoundRender(ctx: Ctx, id: string) {
  const auth = operator(ctx);
  const job = await first<{ manifest_json: string; manifest_sha256: string }>(
    ctx.db,
    `SELECT j.manifest_json,j.manifest_sha256 FROM fb_bound_render_jobs j WHERE j.id=? AND j.tenant_id=? AND j.status='pending'
     AND j.operator_grant_id=? AND j.operator_token_id=? AND j.operator_token_hash=? AND ${auth.sql}`,
    id,
    ctx.tenant.id,
    auth.grantId,
    auth.tokenId,
    auth.tokenHash,
    ...auth.args,
  );
  if (!job)
    throw new ApiError(
      409,
      "render_job_unavailable",
      "The render job or renderer credential is unavailable.",
    );
  let raw: unknown;
  try {
    raw = JSON.parse(job.manifest_json);
  } catch {
    throw new ApiError(409, "render_job_unavailable", "The render job is invalid.");
  }
  const { manifest, sha256 } = await commitRenderManifest(raw);
  if (sha256 !== job.manifest_sha256 || manifest.tenantId !== ctx.tenant.id)
    throw new ApiError(409, "render_job_unavailable", "The render job is invalid.");
  const fence = await renderManifestReferenceFence(manifest),
    audienceFence = boundRenderAudienceFence(ctx, manifest.cardId),
    lineage = await boundLineageFence(ctx, Object.values(manifest.assets).filter((item): item is NonNullable<typeof item> => item !== null).map(item => item.id)),
    now = nowIso();
  const result = await ctx.db.batch([
    ctx.db
      .prepare(
        `UPDATE fb_bound_render_jobs SET status='running',attempt=attempt+1,updated_at=?
      WHERE id=? AND tenant_id=? AND status='pending' AND manifest_sha256=? AND manifest_json=?
        AND operator_grant_id=? AND operator_token_id=? AND operator_token_hash=? AND ${auth.sql} AND ${fence.predicate} AND ${audienceFence.sql} AND ${lineage.sql}
      RETURNING attempt`,
      )
      .bind(
        now,
        id,
        ctx.tenant.id,
        sha256,
        job.manifest_json,
        auth.grantId,
        auth.tokenId,
        auth.tokenHash,
        ...auth.args,
        ...fence.args,
        ...audienceFence.args,
        ...lineage.args,
      ),
    auditForChange(ctx, "render.bound_claimed", id, sha256),
  ]);
  const claimed = result[0]?.results?.[0] as { attempt: number } | undefined;
  if (!claimed)
    throw new ApiError(
      409,
      "render_inputs_changed",
      "The renderer credential or render inputs changed; retry after refreshing.",
    );
  return { id, attempt: claimed.attempt, manifest, manifestSha256: sha256 };
}

/** Return only bytes verified against the claimed manifest; recheck the live
 * operator and D1 inputs after R2 I/O. This is not a publication operation. */
export async function readBoundRenderInputs(ctx: Ctx, id: string, attempt: number) {
  const auth = operator(ctx);
  if (!Number.isSafeInteger(attempt) || attempt < 1)
    throw new ApiError(422, "attempt_required", "A current render attempt is required.");
  const find = (extraSql = "", extraArgs: unknown[] = []) =>
    first<{ manifest_json: string; manifest_sha256: string }>(
      ctx.db,
      `SELECT j.manifest_json,j.manifest_sha256 FROM fb_bound_render_jobs j WHERE j.id=? AND j.tenant_id=?
      AND j.status='running' AND j.attempt=? AND j.operator_grant_id=? AND j.operator_token_id=? AND j.operator_token_hash=?
      AND ${auth.sql} ${extraSql}`,
      id,
      ctx.tenant.id,
      attempt,
      auth.grantId,
      auth.tokenId,
      auth.tokenHash,
      ...auth.args,
      ...extraArgs,
    );
  const job = await find();
  if (!job)
    throw new ApiError(
      409,
      "render_job_unavailable",
      "The render attempt or renderer credential is unavailable.",
    );
  let raw: unknown;
  try {
    raw = JSON.parse(job.manifest_json);
  } catch {
    throw new ApiError(409, "render_job_unavailable", "The render job is invalid.");
  }
  const parsed = await commitRenderManifest(raw);
  const lineage = await boundLineageFence(ctx, Object.values(parsed.manifest.assets).filter((item): item is NonNullable<typeof item> => item !== null).map(item => item.id));
  const verified = await readRenderManifestInputs(ctx.media, parsed.manifest);
  if (verified.sha256 !== job.manifest_sha256 || verified.manifest.tenantId !== ctx.tenant.id)
    throw new ApiError(409, "render_job_unavailable", "The render job is invalid.");
  const fence = await renderManifestReferenceFence(verified.manifest);
  const audienceFence = boundRenderAudienceFence(ctx, verified.manifest.cardId);
  const current = await find(
    `AND j.manifest_json=? AND j.manifest_sha256=? AND ${fence.predicate} AND ${audienceFence.sql} AND ${lineage.sql}`,
    [job.manifest_json, job.manifest_sha256, ...fence.args, ...audienceFence.args, ...lineage.args],
  );
  if (!current)
    throw new ApiError(
      409,
      "render_inputs_changed",
      "The renderer credential or render inputs changed; retry after refreshing.",
    );
  return verified;
}

type StagedOutput = {
  side: "front" | "back";
  key: string;
  version: string;
  etag: string;
  sha256: string;
  bytes: number;
  mime: string;
};

/** Stage two pinned outputs for an authorised review. No asset or render row
 * is created here, and the objects are not reachable through media routes. */
export async function stageBoundRenderOutputs(
  ctx: Ctx,
  id: string,
  attempt: number,
  front: Uint8Array,
  back: Uint8Array,
) {
  const auth = operator(ctx);
  if (!/^brj_[A-Za-z0-9_-]+$/.test(id) || !Number.isSafeInteger(attempt) || attempt < 1)
    throw new ApiError(422, "render_attempt_invalid", "A current render attempt is required.");
  const proposed = [] as {
    side: "front" | "back";
    bytes: Uint8Array;
    sha256: string;
    mime: string;
  }[];
  for (const [side, bytes] of [
    ["front", front],
    ["back", back],
  ] as const) {
    if (!bytes.length || bytes.length > 8 * 1024 * 1024)
      throw new ApiError(422, "render_size_invalid", "Each render must be no larger than 8 MB.");
    const mime = detectMime(bytes);
    if (mime !== "image/png" && mime !== "image/webp")
      throw new ApiError(422, "render_type_invalid", "Each render must be PNG or WebP.");
    let size: { width?: number; height?: number };
    try {
      size = imageSize(bytes);
    } catch {
      throw new ApiError(422, "render_dimensions_invalid", "The render image could not be read.");
    }
    if (size.width !== 750 || size.height !== 1050)
      throw new ApiError(
        422,
        "render_dimensions_invalid",
        "Each render must be 750 by 1050 pixels.",
      );
    proposed.push({ side, bytes, sha256: await sha256Hex(bytes), mime });
  }
  const rows = () =>
    first<{ manifest_json: string; manifest_sha256: string; status: string }>(
      ctx.db,
      `SELECT j.manifest_json,j.manifest_sha256,j.status FROM fb_bound_render_jobs j
    WHERE j.id=? AND j.tenant_id=? AND j.attempt=? AND j.operator_grant_id=? AND j.operator_token_id=? AND j.operator_token_hash=? AND ${auth.sql}`,
      id,
      ctx.tenant.id,
      attempt,
      auth.grantId,
      auth.tokenId,
      auth.tokenHash,
      ...auth.args,
    );
  const before = await rows();
  if (!before)
    throw new ApiError(
      409,
      "render_job_unavailable",
      "The render attempt or renderer credential is unavailable.",
    );
  if (before.status === "awaiting_review") {
    let raw: unknown;
    try {
      raw = JSON.parse(before.manifest_json);
    } catch {
      throw new ApiError(409, "render_job_unavailable", "The render job is invalid.");
    }
    const parsed = await commitRenderManifest(raw);
    if (parsed.sha256 !== before.manifest_sha256)
      throw new ApiError(409, "render_job_unavailable", "The render job is invalid.");
    const audienceFence = boundRenderAudienceFence(ctx, parsed.manifest.cardId);
    const lineage = await boundLineageFence(ctx,Object.values(parsed.manifest.assets).filter((item): item is NonNullable<typeof item> => item !== null).map(item => item.id));
    const currentAudience = () =>
      first(
        ctx.db,
        `SELECT 1 FROM fb_bound_render_jobs j WHERE j.id=? AND j.tenant_id=? AND j.attempt=? AND j.status='awaiting_review'
      AND j.manifest_json=? AND j.manifest_sha256=? AND j.operator_grant_id=? AND j.operator_token_id=? AND j.operator_token_hash=? AND ${auth.sql} AND ${audienceFence.sql} AND ${lineage.sql}`,
        id,
        ctx.tenant.id,
        attempt,
        before.manifest_json,
        before.manifest_sha256,
        auth.grantId,
        auth.tokenId,
        auth.tokenHash,
        ...auth.args,
        ...audienceFence.args,
        ...lineage.args,
      );
    if (!(await currentAudience()))
      throw new ApiError(
        409,
        "render_job_unavailable",
        "The render audience or credential changed.",
      );
    const stored =
      (
        await ctx.db
          .prepare(
            `SELECT side,r2_key,object_version,object_etag,content_sha256,bytes,mime FROM fb_bound_render_candidates
      WHERE job_id=? AND tenant_id=? AND attempt=? ORDER BY side`,
          )
          .bind(id, ctx.tenant.id, attempt)
          .all<{
            side: string;
            r2_key: string;
            object_version: string;
            object_etag: string;
            content_sha256: string;
            bytes: number;
            mime: string;
          }>()
      ).results ?? [];
    if (
      stored.length !== 2 ||
      proposed.some(
        (p) =>
          !stored.some(
            (s) =>
              s.side === p.side &&
              s.content_sha256 === p.sha256 &&
              s.bytes === p.bytes.length &&
              s.mime === p.mime,
          ),
      )
    )
      throw new ApiError(
        409,
        "render_output_conflict",
        "This attempt already staged different output.",
      );
    for (const s of stored)
      await readVerifiedRenderInput(ctx.media, {
        key: s.r2_key,
        version: s.object_version,
        etag: s.object_etag,
        sha256: s.content_sha256,
        bytes: s.bytes,
      });
    if (!(await currentAudience()))
      throw new ApiError(409, "render_job_unavailable", "The renderer credential changed.");
    return { id, attempt, status: "awaiting_review" as const };
  }
  if (before.status !== "running")
    throw new ApiError(409, "render_job_unavailable", "The render attempt is unavailable.");
  const inputs = await readBoundRenderInputs(ctx, id, attempt);
  const staged: StagedOutput[] = [];
  for (const p of proposed) {
    const key = `bound-render-stage-v1/${ctx.tenant.id}/${id}/${attempt}/${p.side}-${p.sha256}`;
    await ctx.media.put(key, p.bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: p.mime },
    });
    const head = await ctx.media.head(key);
    if (!head) throw new ApiError(409, "render_output_changed", "A staged render is unavailable.");
    await readVerifiedRenderInput(ctx.media, {
      key,
      version: head.version,
      etag: head.etag,
      sha256: p.sha256,
      bytes: p.bytes.length,
    });
    staged.push({
      side: p.side,
      key,
      version: head.version,
      etag: head.etag,
      sha256: p.sha256,
      bytes: p.bytes.length,
      mime: p.mime,
    });
  }
  const fence = await renderManifestReferenceFence(inputs.manifest),
    audienceFence = boundRenderAudienceFence(ctx, inputs.manifest.cardId),
    lineage = await boundLineageFence(ctx,Object.values(inputs.manifest.assets).filter((item): item is NonNullable<typeof item> => item !== null).map(item => item.id)),
    now = nowIso();
  const results = await ctx.db.batch([
    ctx.db
      .prepare(
        `UPDATE fb_bound_render_jobs SET status='awaiting_review',updated_at=? WHERE id=? AND tenant_id=? AND attempt=? AND status='running'
      AND manifest_sha256=? AND operator_grant_id=? AND operator_token_id=? AND operator_token_hash=? AND ${auth.sql} AND ${fence.predicate} AND ${audienceFence.sql} AND ${lineage.sql} RETURNING id`,
      )
      .bind(
        now,
        id,
        ctx.tenant.id,
        attempt,
        inputs.sha256,
        auth.grantId,
        auth.tokenId,
        auth.tokenHash,
        ...auth.args,
        ...fence.args,
        ...audienceFence.args,
        ...lineage.args,
      ),
    ctx.db
      .prepare(
        `INSERT INTO fb_bound_render_candidates(job_id,tenant_id,attempt,side,r2_key,object_version,object_etag,content_sha256,bytes,mime,created_at)
      SELECT ?,?,?,json_extract(value,'$.side'),json_extract(value,'$.key'),json_extract(value,'$.version'),json_extract(value,'$.etag'),
        json_extract(value,'$.sha256'),json_extract(value,'$.bytes'),json_extract(value,'$.mime'),? FROM json_each(?) WHERE changes()=1`,
      )
      .bind(id, ctx.tenant.id, attempt, now, JSON.stringify(staged)),
    ctx.db
      .prepare(
        `INSERT INTO fb_audit_events(id,tenant_id,actor_type,actor_id,represented_user_id,action,object_type,object_id,metadata_json,request_id,created_at)
      SELECT ?,?,?,?,?, 'render.bound_staged','bound_render_job',?,?,?,? WHERE changes()=2`,
      )
      .bind(
        newId("aud"),
        ctx.tenant.id,
        ctx.actor.type,
        ctx.actor.id,
        ctx.actor.representedUserId,
        id,
        JSON.stringify({ manifest_sha256: inputs.sha256 }),
        ctx.requestId,
        now,
      ),
  ]);
  if (!results[0]?.results?.length)
    throw new ApiError(
      409,
      "render_inputs_changed",
      "The renderer credential or render inputs changed; retry after refreshing.",
    );
  // A revoked credential after commit must not obtain the receipt; the staged
  // rows and objects remain available to an authorised retry/review workflow.
  const stagedReceipt = await first(
    ctx.db,
    `SELECT 1 FROM fb_bound_render_jobs j WHERE j.id=? AND j.tenant_id=? AND j.attempt=? AND j.status='awaiting_review'
    AND j.manifest_sha256=? AND j.operator_grant_id=? AND j.operator_token_id=? AND j.operator_token_hash=? AND ${auth.sql} AND ${audienceFence.sql} AND ${lineage.sql}`,
    id,
    ctx.tenant.id,
    attempt,
    inputs.sha256,
    auth.grantId,
    auth.tokenId,
    auth.tokenHash,
    ...auth.args,
    ...audienceFence.args,
    ...lineage.args,
  );
  if (!stagedReceipt)
    throw new ApiError(409, "render_job_unavailable", "The renderer credential changed.");
  return { id, attempt, status: "awaiting_review" as const };
}

/** Publish a reviewed pair in one D1 transaction. The private staged keys stay
 * version-pinned; serving must verify those pins before this protocol is wired. */
export async function publishBoundRender(ctx: Ctx, id: string, attempt: number) {
  const auth = operator(ctx);
  if (!/^brj_[A-Za-z0-9_-]+$/.test(id) || !Number.isSafeInteger(attempt) || attempt < 1)
    throw new ApiError(422, "render_attempt_invalid", "A current render attempt is required.");
  const load = () =>
    first<{
      manifest_json: string;
      manifest_sha256: string;
      status: string;
      result_json: string | null;
      review_id: string;
    }>(
      ctx.db,
      `SELECT j.manifest_json,j.manifest_sha256,j.status,j.result_json,r.id AS review_id FROM fb_bound_render_jobs j
     JOIN fb_bound_render_reviews r ON r.job_id=j.id AND r.tenant_id=j.tenant_id AND r.attempt=j.attempt
       AND r.decision='approved' AND r.manifest_sha256=j.manifest_sha256
     WHERE j.id=? AND j.tenant_id=? AND j.attempt=? AND j.status IN ('approved','succeeded')
       AND j.operator_grant_id=? AND j.operator_token_id=? AND j.operator_token_hash=? AND ${auth.sql}`,
      id,
      ctx.tenant.id,
      attempt,
      auth.grantId,
      auth.tokenId,
      auth.tokenHash,
      ...auth.args,
    );
  const job = await load();
  if (!job)
    throw new ApiError(
      409,
      "render_publication_unavailable",
      "The approved render or renderer credential is unavailable.",
    );
  let raw: unknown;
  try {
    raw = JSON.parse(job.manifest_json);
  } catch {
    throw new ApiError(409, "render_job_unavailable", "The render job is invalid.");
  }
  const { manifest, sha256 } = await commitRenderManifest(raw);
  if (sha256 !== job.manifest_sha256 || manifest.tenantId !== ctx.tenant.id)
    throw new ApiError(409, "render_job_unavailable", "The render job is invalid.");
  const candidates = await all<{
    side: "front" | "back";
    r2_key: string;
    object_version: string;
    object_etag: string;
    content_sha256: string;
    bytes: number;
    mime: string;
  }>(
    ctx.db,
    `SELECT side,r2_key,object_version,object_etag,content_sha256,bytes,mime FROM fb_bound_render_candidates
     WHERE job_id=? AND tenant_id=? AND attempt=? ORDER BY side`,
    id,
    ctx.tenant.id,
    attempt,
  );
  const front = candidates.find((x) => x.side === "front"),
    back = candidates.find((x) => x.side === "back");
  if (candidates.length !== 2 || !front || !back)
    throw new ApiError(409, "render_publication_unavailable", "Both reviewed sides are required.");
  for (const c of [front, back])
    await readVerifiedRenderInput(ctx.media, {
      key: c.r2_key,
      version: c.object_version,
      etag: c.object_etag,
      sha256: c.content_sha256,
      bytes: c.bytes,
    });
  const fence = await renderManifestReferenceFence(manifest);
  const audienceFence = boundRenderAudienceFence(ctx, manifest.cardId);
  const lineage = await boundLineageFence(ctx, Object.values(manifest.assets).filter((item): item is NonNullable<typeof item> => item !== null).map(item => item.id));
  const sidePredicate = `EXISTS (SELECT 1 FROM fb_bound_render_candidates c WHERE c.job_id=j.id AND c.tenant_id=j.tenant_id AND c.attempt=j.attempt
    AND c.side=? AND c.r2_key=? AND c.object_version=? AND c.object_etag=? AND c.content_sha256=? AND c.bytes=? AND c.mime=?)`;
  const sideArgs = (c: typeof front) => [
    c.side,
    c.r2_key,
    c.object_version,
    c.object_etag,
    c.content_sha256,
    c.bytes,
    c.mime,
  ];
  const valid = `j.id=? AND j.tenant_id=? AND j.attempt=? AND j.manifest_json=? AND j.manifest_sha256=? AND j.operator_grant_id=? AND j.operator_token_id=? AND j.operator_token_hash=?
    AND EXISTS (SELECT 1 FROM fb_bound_render_reviews r WHERE r.id=? AND r.job_id=j.id AND r.tenant_id=j.tenant_id AND r.attempt=j.attempt
      AND r.decision='approved' AND r.manifest_sha256=j.manifest_sha256 AND r.front_sha256=? AND r.back_sha256=?)
    AND ${sidePredicate} AND ${sidePredicate} AND EXISTS (SELECT 1 FROM render_auth) AND EXISTS (SELECT 1 FROM render_refs) AND EXISTS (SELECT 1 FROM render_audience) AND EXISTS (SELECT 1 FROM render_lineage)`;
  const checks = `WITH render_auth AS MATERIALIZED (SELECT 1 WHERE ${auth.sql}), render_refs AS MATERIALIZED (${fence.sql}), render_audience AS MATERIALIZED (SELECT 1 WHERE ${audienceFence.sql}), render_lineage AS MATERIALIZED (SELECT 1 WHERE ${lineage.sql})`;
  const validArgs = [
    id,
    ctx.tenant.id,
    attempt,
    job.manifest_json,
    sha256,
    auth.grantId,
    auth.tokenId,
    auth.tokenHash,
    job.review_id,
    front.content_sha256,
    back.content_sha256,
    ...sideArgs(front),
    ...sideArgs(back),
  ];
  const checkArgs = [...auth.args, ...fence.args, ...audienceFence.args, ...lineage.args, ...validArgs];
  const replay = async () => {
    // Publication itself changes the lineage epochs. Re-authorize the entire
    // current graph before returning a receipt, including after a lost reply.
    const currentLineage = await boundLineageFence(ctx, Object.values(manifest.assets).filter((item): item is NonNullable<typeof item> => item !== null).map(item => item.id));
    return first<{ result_json: string }>(
      ctx.db,
      `${checks} SELECT j.result_json FROM fb_bound_render_jobs j WHERE j.status='succeeded' AND ${valid}`,
      ...auth.args, ...fence.args, ...audienceFence.args, ...currentLineage.args, ...validArgs,
    );
  };
  if (job.status === "succeeded") {
    const prior = await replay();
    if (!prior)
      throw new ApiError(
        409,
        "render_publication_unavailable",
        "The published render receipt is unavailable.",
      );
    return JSON.parse(prior.result_json) as Record<string, unknown>;
  }
  const now = nowIso(),
    frontId = newId("rnd"),
    backId = newId("rnd");
  const access =
    manifest.metadata.serial === "PUBLIC SHOWCASE"
      ? "public"
      : manifest.metadata.serial === "PRIVATE EDITION"
        ? "private"
        : "member";
  const result = {
    front: {
      assetId: frontId,
      publicUrl: `/media/render/${frontId}`,
      width: 750,
      height: 1050,
      sha256: front.content_sha256,
    },
    back: {
      assetId: backId,
      publicUrl: `/media/back/${backId}`,
      width: 750,
      height: 1050,
      sha256: back.content_sha256,
    },
  };
  const asset = (assetId: string, c: typeof front, role: string) =>
    ctx.db
      .prepare(
        `INSERT INTO fb_assets
    (id,tenant_id,kind,name,mime,width,height,bytes,r2_key,sha256,visibility,access_classification,role,processing_state,review_status,provenance_json,dependencies_json,created_at)
    VALUES (?,?,'render',?,?,750,1050,?,?,?,?,? ,?,'ready','approved',?,?,?)`,
      )
      .bind(
        assetId,
        ctx.tenant.id,
        `Reviewed ${c.side} render`,
        c.mime,
        c.bytes,
        c.r2_key,
        c.content_sha256,
        access === "public" ? "public_export" : "private",
        access,
        role,
        JSON.stringify({
          protocol: "foilbury-render-inputs-v1",
          manifest_sha256: sha256,
          review_id: job.review_id,
          job_id: id,
          side: c.side,
        }),
        JSON.stringify([...new Set(Object.values(manifest.assets).filter(Boolean).map(asset=>asset!.id))]),
        now,
      );
  const pin = (assetId: string, c: typeof front) =>
    ctx.db
      .prepare(
        `INSERT INTO fb_bound_render_outputs
    (asset_id,tenant_id,job_id,side,r2_key,object_version,object_etag,content_sha256,bytes,mime,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        assetId,
        ctx.tenant.id,
        id,
        c.side,
        c.r2_key,
        c.object_version,
        c.object_etag,
        c.content_sha256,
        c.bytes,
        c.mime,
        now,
      );
  try {
    await ctx.db.batch([
      ctx.db
        .prepare(
          `${checks} SELECT CASE WHEN COUNT(*)=1 THEN 1 ELSE json('bound_render_changed') END FROM fb_bound_render_jobs j WHERE j.status='approved' AND ${valid}`,
        )
        .bind(...checkArgs),
      asset(frontId, front, "render"),
      asset(backId, back, "render_back"),
      pin(frontId, front),
      pin(backId, back),
      ctx.db
        .prepare(
          `INSERT INTO fb_variant_renders(id,tenant_id,variant_id,recipe_id,asset_id,public_url,width,height,sha256,source_hash,status,created_at,published_at)
        VALUES(?,?,?,?,?,?,750,1050,?,?,'published',?,?) ON CONFLICT(tenant_id,variant_id,recipe_id) DO UPDATE SET asset_id=excluded.asset_id,
          public_url=excluded.public_url,width=excluded.width,height=excluded.height,sha256=excluded.sha256,source_hash=excluded.source_hash,status='published',published_at=excluded.published_at`,
        )
        .bind(
          newId("vr"),
          ctx.tenant.id,
          manifest.variantId,
          manifest.recipeId,
          frontId,
          result.front.publicUrl,
          front.content_sha256,
          manifest.editionSourceHash,
          now,
          now,
        ),
      ctx.db
        .prepare(
          `INSERT INTO fb_variant_back_renders(id,tenant_id,variant_id,recipe_id,asset_id,width,height,sha256,status,created_at,published_at)
        VALUES(?,?,?,?,?,750,1050,?,'published',?,?) ON CONFLICT(tenant_id,variant_id,recipe_id) DO UPDATE SET asset_id=excluded.asset_id,
          width=excluded.width,height=excluded.height,sha256=excluded.sha256,status='published',published_at=excluded.published_at`,
        )
        .bind(
          newId("vbr"),
          ctx.tenant.id,
          manifest.variantId,
          manifest.recipeId,
          backId,
          back.content_sha256,
          now,
          now,
        ),
      ctx.db
        .prepare(
          `UPDATE fb_bound_render_jobs SET status='succeeded',result_json=?,updated_at=? WHERE id=? AND tenant_id=? AND attempt=? AND status='approved'`,
        )
        .bind(JSON.stringify(result), now, id, ctx.tenant.id, attempt),
      ctx.db
        .prepare(
          `INSERT INTO fb_outbox(id,tenant_id,topic,payload_json,status,attempts,available_at,created_at) VALUES (?,?,'render.completed',?,'pending',0,?,?)`,
        )
        .bind(newId("out"), ctx.tenant.id, JSON.stringify({ job_id: id, ...result }), now, now),
      ctx.db
        .prepare(
          `INSERT INTO fb_audit_events(id,tenant_id,actor_type,actor_id,represented_user_id,action,object_type,object_id,metadata_json,request_id,created_at)
        VALUES (?,?,?,?,?,'render.bound_published','bound_render_job',?,?,?,?)`,
        )
        .bind(
          newId("aud"),
          ctx.tenant.id,
          ctx.actor.type,
          ctx.actor.id,
          ctx.actor.representedUserId,
          id,
          JSON.stringify({ review_id: job.review_id, manifest_sha256: sha256 }),
          ctx.requestId,
          now,
        ),
    ]);
  } catch (error) {
    const prior = await replay().catch(() => null);
    if (prior) return JSON.parse(prior.result_json) as Record<string, unknown>;
    const current = await first(
      ctx.db,
      `${checks} SELECT 1 FROM fb_bound_render_jobs j WHERE j.status='approved' AND ${valid}`,
      ...checkArgs,
    ).catch(() => undefined);
    if (current === null)
      throw new ApiError(
        409,
        "render_inputs_changed",
        "The renderer credential, approval or render inputs changed.",
      );
    throw error;
  }
  let saved: { result_json: string } | null;
  try {
    saved = await replay();
  } catch {
    throw new ApiError(
      409,
      "render_publication_receipt_pending",
      "The render may have been published. Retry the same attempt after restoring access.",
    );
  }
  if (!saved)
    throw new ApiError(
      409,
      "render_publication_receipt_pending",
      "The render may have been published. Retry the same attempt after restoring access.",
    );
  return JSON.parse(saved.result_json) as Record<string, unknown>;
}

/** Trusted renderer adds a derivative for an already-published pinned front.
 * The executor must derive it from the verified source; the operator is the
 * trust boundary and this record is not a cryptographic execution proof. */
export async function createBoundDerivative(
  ctx: Ctx,
  sourceAssetId: string,
  sizeKey: "thumb" | "preview" | "detail",
  bytes: Uint8Array,
) {
  const auth = operator(ctx),
    sizes = { thumb: [300, 420], preview: [600, 840], detail: [750, 1050] } as const;
  if (
    !(sizeKey in sizes) ||
    !bytes.length ||
    bytes.length > 8 * 1024 * 1024 ||
    detectMime(bytes) !== "image/webp"
  )
    throw new ApiError(422, "derivative_type_invalid", "Provide a valid WebP derivative.");
  let dimensions: { width?: number; height?: number };
  try {
    dimensions = imageSize(bytes);
  } catch {
    throw new ApiError(422, "derivative_dimensions_invalid", "The derivative could not be read.");
  }
  if (dimensions.width !== sizes[sizeKey][0] || dimensions.height !== sizes[sizeKey][1])
    throw new ApiError(
      422,
      "derivative_dimensions_invalid",
      "The derivative dimensions do not match its size.",
    );
  const source = () =>
    first<{
      r2_key: string;
      object_version: string;
      object_etag: string;
      content_sha256: string;
      bytes: number;
      card_id: string;
    }>(
      ctx.db,
      `SELECT p.r2_key,p.object_version,p.object_etag,p.content_sha256,p.bytes,v.card_id
    FROM fb_bound_render_outputs p JOIN fb_bound_render_jobs j ON j.id=p.job_id AND j.tenant_id=p.tenant_id AND j.status='succeeded'
    JOIN fb_assets a ON a.id=p.asset_id AND a.tenant_id=p.tenant_id AND a.r2_key=p.r2_key AND a.sha256=p.content_sha256 AND a.bytes=p.bytes AND a.archived_at IS NULL AND a.processing_state='ready'
    JOIN fb_variant_renders vr ON vr.asset_id=a.id AND vr.tenant_id=a.tenant_id AND vr.status='published'
    JOIN fb_variants v ON v.id=vr.variant_id AND v.tenant_id=vr.tenant_id
    WHERE p.tenant_id=? AND p.asset_id=? AND p.side='front' AND j.operator_grant_id=? AND j.operator_token_id=? AND j.operator_token_hash=? AND ${auth.sql}`,
      ctx.tenant.id,
      sourceAssetId,
      auth.grantId,
      auth.tokenId,
      auth.tokenHash,
      ...auth.args,
    );
  const original = await source();
  if (!original)
    throw new ApiError(
      409,
      "render_derivative_unavailable",
      "The source render or renderer credential is unavailable.",
    );
  const audienceFence = boundRenderAudienceFence(ctx, original.card_id);
  const lineage = await boundLineageFence(ctx, [sourceAssetId]);
  const audience = async () => {
    const currentLineage=await boundLineageFence(ctx,[sourceAssetId]);
    return first(ctx.db,`SELECT 1 WHERE ${auth.sql} AND ${audienceFence.sql} AND ${currentLineage.sql}`,
      ...auth.args,...audienceFence.args,...currentLineage.args);
  };
  if (!(await audience()))
    throw new ApiError(
      409,
      "render_derivative_unavailable",
      "The source audience or renderer credential changed.",
    );
  await readVerifiedRenderInput(ctx.media, {
    key: original.r2_key,
    version: original.object_version,
    etag: original.object_etag,
    sha256: original.content_sha256,
    bytes: original.bytes,
  });
  const hash = await sha256Hex(bytes),
    key = `bound-render-derivative-v1/${ctx.tenant.id}/${sourceAssetId}/${sizeKey}-${hash}`;
  await ctx.media.put(key, bytes, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "image/webp" },
  });
  const head = await ctx.media.head(key);
  if (!head) throw new ApiError(409, "render_output_changed", "The derivative is unavailable.");
  await readVerifiedRenderInput(ctx.media, {
    key,
    version: head.version,
    etag: head.etag,
    sha256: hash,
    bytes: bytes.length,
  });
  const same = async () =>
    first<{
      id: string;
      sha256: string;
      bytes: number;
      object_version: string;
      object_etag: string;
      r2_key: string;
    }>(
      ctx.db,
      `SELECT d.id,d.sha256,d.bytes,p.object_version,p.object_etag,p.r2_key FROM fb_asset_derivatives d
    JOIN fb_bound_render_derivatives p ON p.derivative_id=d.id AND p.tenant_id=d.tenant_id AND p.source_asset_id=d.source_asset_id AND p.r2_key=d.r2_key AND p.content_sha256=d.sha256 AND p.bytes=d.bytes
    WHERE d.tenant_id=? AND d.source_asset_id=? AND d.size_key=? AND d.status='ready' AND ${auth.sql}`,
      ctx.tenant.id,
      sourceAssetId,
      sizeKey,
      ...auth.args,
    );
  const prior = await same();
  if (prior) {
    if (prior.sha256 !== hash || prior.bytes !== bytes.length || prior.r2_key !== key)
      throw new ApiError(
        409,
        "derivative_conflict",
        "A different derivative already exists for this size.",
      );
    await readVerifiedRenderInput(ctx.media, {
      key: prior.r2_key,
      version: prior.object_version,
      etag: prior.object_etag,
      sha256: prior.sha256,
      bytes: prior.bytes,
    });
    if (!(await source()) || !(await audience()))
      throw new ApiError(409, "render_derivative_unavailable", "The renderer credential changed.");
    return {
      id: prior.id,
      width: dimensions.width,
      height: dimensions.height,
      bytes: bytes.length,
    };
  }
  const derivativeId = newId("drv"),
    now = nowIso();
  const valid = `EXISTS (SELECT 1 FROM fb_bound_render_outputs p JOIN fb_bound_render_jobs j ON j.id=p.job_id AND j.tenant_id=p.tenant_id AND j.status='succeeded'
    JOIN fb_assets a ON a.id=p.asset_id AND a.tenant_id=p.tenant_id AND a.r2_key=p.r2_key AND a.sha256=p.content_sha256 AND a.bytes=p.bytes AND a.processing_state='ready' AND a.archived_at IS NULL
    JOIN fb_variant_renders vr ON vr.asset_id=a.id AND vr.tenant_id=a.tenant_id AND vr.status='published'
    WHERE p.tenant_id=? AND p.asset_id=? AND p.side='front' AND p.r2_key=? AND p.object_version=? AND p.object_etag=? AND p.content_sha256=? AND p.bytes=?
      AND j.operator_grant_id=? AND j.operator_token_id=? AND j.operator_token_hash=?) AND ${auth.sql} AND ${audienceFence.sql} AND ${lineage.sql}`;
  const args = [
    ctx.tenant.id,
    sourceAssetId,
    original.r2_key,
    original.object_version,
    original.object_etag,
    original.content_sha256,
    original.bytes,
    auth.grantId,
    auth.tokenId,
    auth.tokenHash,
    ...auth.args,
    ...audienceFence.args,
    ...lineage.args,
  ];
  try {
    await ctx.db.batch([
      ctx.db
        .prepare(`SELECT CASE WHEN ${valid} THEN 1 ELSE json('bound_derivative_changed') END`)
        .bind(...args),
      ctx.db
        .prepare(
          `INSERT INTO fb_asset_derivatives(id,tenant_id,source_asset_id,size_key,r2_key,mime,width,height,bytes,sha256,status,created_at) VALUES (?,?,?,?,?,'image/webp',?,?,?,?,'ready',?)`,
        )
        .bind(
          derivativeId,
          ctx.tenant.id,
          sourceAssetId,
          sizeKey,
          key,
          dimensions.width,
          dimensions.height,
          bytes.length,
          hash,
          now,
        ),
      ctx.db
        .prepare(
          `INSERT INTO fb_bound_render_derivatives(derivative_id,tenant_id,source_asset_id,r2_key,object_version,object_etag,content_sha256,bytes,created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          derivativeId,
          ctx.tenant.id,
          sourceAssetId,
          key,
          head.version,
          head.etag,
          hash,
          bytes.length,
          now,
        ),
      ctx.db
        .prepare(
          `INSERT INTO fb_audit_events(id,tenant_id,actor_type,actor_id,represented_user_id,action,object_type,object_id,metadata_json,request_id,created_at)
      VALUES (?,?,?,?,?,'render.bound_derivative','asset_derivative',?,?,?,?)`,
        )
        .bind(
          newId("aud"),
          ctx.tenant.id,
          ctx.actor.type,
          ctx.actor.id,
          ctx.actor.representedUserId,
          derivativeId,
          JSON.stringify({ source_asset_id: sourceAssetId, size: sizeKey, sha256: hash }),
          ctx.requestId,
          now,
        ),
    ]);
  } catch (error) {
    const raced = await same().catch(() => null);
    if (!raced || raced.sha256 !== hash || raced.r2_key !== key || raced.bytes !== bytes.length)
      throw error;
    await readVerifiedRenderInput(ctx.media, {
      key: raced.r2_key,
      version: raced.object_version,
      etag: raced.object_etag,
      sha256: raced.sha256,
      bytes: raced.bytes,
    });
    if (!(await source()) || !(await audience()))
      throw new ApiError(409, "render_derivative_unavailable", "The renderer credential changed.");
    return {
      id: raced.id,
      width: dimensions.width,
      height: dimensions.height,
      bytes: bytes.length,
    };
  }
  let receiptAuthorized = false;
  try { receiptAuthorized = Boolean(await source()) && Boolean(await audience()); }
  catch { /* A committed derivative can be recovered with the same source and size. */ }
  if (!receiptAuthorized)
    throw new ApiError(
      409,
      "render_derivative_receipt_pending",
      "The derivative may have been saved. Retry after restoring access.",
    );
  return {
    id: derivativeId,
    width: dimensions.width,
    height: dimensions.height,
    bytes: bytes.length,
  };
}

/** Explicit Bot Owner designation; this never creates or expands an agent grant. */
export async function setBoundRenderOperator(
  ctx: Ctx,
  grantId: string,
  tokenId: string,
  active: boolean,
) {
  const session = strongHumanArgs(ctx);
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(grantId) || !/^[A-Za-z0-9_-]{1,200}$/.test(tokenId))
    throw new ApiError(422, "render_operator_invalid", "Choose a valid agent credential.");
  const owner = `${liveStrongHumanSession} AND EXISTS (SELECT 1 FROM fb_bots b JOIN fb_memberships m ON m.tenant_id=b.tenant_id
    WHERE b.tenant_id=? AND b.status='active' AND b.owner_user_id=? AND m.user_id=b.owner_user_id AND m.role='owner' AND m.status='active' AND m.revoked_at IS NULL)`;
  const ownerArgs = [...session, ctx.tenant.id, ctx.user!.id],
    now = nowIso();
  const mutation = active
    ? ctx.db
        .prepare(
          `INSERT INTO fb_render_operators(tenant_id,grant_id,token_id,token_hash,status,created_by,created_at,revoked_at)
    SELECT g.tenant_id,g.id,t.id,t.token_hash,'active',?,?,NULL FROM fb_agent_tokens t JOIN fb_agent_grants g ON g.id=t.grant_id
    JOIN fb_users u ON u.id=g.represented_user_id AND u.disabled_at IS NULL
    JOIN fb_memberships m ON m.user_id=u.id AND m.tenant_id=g.tenant_id AND m.status='active' AND m.revoked_at IS NULL
    WHERE g.tenant_id=? AND g.id=? AND t.id=? AND t.revoked_at IS NULL AND g.status='active' AND g.revoked_at IS NULL AND g.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND json_type(CASE WHEN json_valid(g.scopes_json) THEN g.scopes_json ELSE 'null' END)='array'
      AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(g.scopes_json) THEN g.scopes_json ELSE '[]' END) WHERE type<>'text')
      AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(g.scopes_json) THEN g.scopes_json ELSE '[]' END) WHERE value='render:write') AND ${owner}
    ON CONFLICT(tenant_id,grant_id,token_id) DO UPDATE SET token_hash=excluded.token_hash,status='active',created_by=excluded.created_by,created_at=excluded.created_at,revoked_at=NULL RETURNING token_id`,
        )
        .bind(ctx.user!.id, now, ctx.tenant.id, grantId, tokenId, ...ownerArgs)
    : ctx.db
        .prepare(
          `UPDATE fb_render_operators SET status='revoked',revoked_at=? WHERE tenant_id=? AND grant_id=? AND token_id=? AND status='active' AND ${owner} RETURNING token_id`,
        )
        .bind(now, ctx.tenant.id, grantId, tokenId, ...ownerArgs);
  const results = await ctx.db.batch([
    mutation,
    ctx.db
      .prepare(
        `INSERT INTO fb_audit_events(id,tenant_id,actor_type,actor_id,represented_user_id,action,object_type,object_id,metadata_json,request_id,created_at)
    SELECT ?,?,?,?,?,?,'agent_token',?,?,?,? WHERE changes()=1`,
      )
      .bind(
        newId("aud"),
        ctx.tenant.id,
        ctx.actor.type,
        ctx.actor.id,
        ctx.actor.representedUserId,
        active ? "render.operator_designated" : "render.operator_revoked",
        tokenId,
        JSON.stringify({ grant_id: grantId }),
        ctx.requestId,
        now,
      ),
  ]);
  if (!results[0]?.results?.length)
    throw new ApiError(
      409,
      "render_operator_unavailable",
      "The owner session or selected agent credential changed.",
    );
  return { grantId, tokenId, status: active ? ("active" as const) : ("revoked" as const) };
}

/** Assemble the exact current D1 references and R2 versions for an explicit
 * variant and collection. No source, missing back, or provenance is guessed. */
export async function prepareBoundRender(
  ctx: Ctx,
  variantId: string,
  collectionId: string,
  renderer: unknown,
) {
  const auth = operator(ctx);
  const row = await first<{
    variant_id: string;
    card_id: string;
    edition_id: string;
    edition_name: string;
    recipe_id: string;
    card_version: number;
    source_hash: string | null;
    recipe_version: number;
    recipe_config: string;
    name: string;
    subtitle: string | null;
    set_name: string;
    class_name: string | null;
    rarity: string | null;
    material: string;
    effect: string | null;
    composition_json: string | null;
    subject_id: string | null;
    background_id: string | null;
    back_id: string | null;
    mark_id: string | null;
    logo_url: string | null;
  }>(
    ctx.db,
    `SELECT v.id AS variant_id,cd.id AS card_id,e.id AS edition_id,e.name AS edition_name,e.recipe_id,cd.version AS card_version,e.source_hash,
      recipe.version AS recipe_version,recipe.config_json AS recipe_config,cd.name,cd.subtitle,c.name AS set_name,cls.name AS class_name,rarity.name AS rarity,
      mat.key AS material,fx.key AS effect,e.composition_json,e.subject_asset_id AS subject_id,e.background_asset_id AS background_id,
      cd.card_back_asset_id AS back_id,c.logo_asset_id AS mark_id,c.logo_url
     FROM fb_variants v JOIN fb_artwork_editions e ON e.id=v.edition_id AND e.tenant_id=v.tenant_id AND e.card_id=v.card_id
     JOIN fb_card_definitions cd ON cd.id=v.card_id AND cd.tenant_id=v.tenant_id JOIN fb_recipes recipe ON recipe.id=e.recipe_id AND recipe.tenant_id=v.tenant_id
     JOIN fb_materials mat ON mat.id=v.material_id AND mat.tenant_id=v.tenant_id LEFT JOIN fb_effects fx ON fx.id=v.effect_id AND fx.tenant_id=v.tenant_id
     LEFT JOIN fb_classes cls ON cls.id=cd.class_id AND cls.tenant_id=cd.tenant_id LEFT JOIN fb_rarities rarity ON rarity.id=cd.rarity_id AND rarity.tenant_id=cd.tenant_id
     JOIN fb_collection_cards cc ON cc.card_id=cd.id JOIN fb_collections c ON c.id=cc.collection_id
     WHERE v.tenant_id=? AND v.id=? AND c.id=? AND ${auth.sql}`,
    ctx.tenant.id,
    variantId,
    collectionId,
    ...auth.args,
  );
  if (!row)
    throw new ApiError(
      404,
      "render_inputs_unavailable",
      "The variant, collection or renderer credential is unavailable.",
    );
  if (!row.subject_id || !row.background_id || !row.back_id || (!row.mark_id && row.logo_url))
    throw new ApiError(
      409,
      "render_inputs_incomplete",
      "Register the exact subject, background, back and any collection mark before rendering.",
    );
  let composition: unknown;
  try {
    composition = JSON.parse(row.composition_json ?? "null");
  } catch {
    composition = null;
  }
  if (!composition)
    throw new ApiError(
      409,
      "render_inputs_incomplete",
      "Save an explicit composition before rendering.",
    );
  const lineage = await boundLineageFence(ctx, [row.subject_id,row.background_id,row.back_id,...(row.mark_id ? [row.mark_id] : [])]);
  const audience = await effectiveCardAudience(ctx, row.card_id);
  async function capture(assetId: string) {
    const asset = await first<{
      id: string;
      revision: number;
      r2_key: string;
      sha256: string;
      kind: string;
      processing_state: string;
      review_status: string;
      access_classification: string;
      provenance_json: string;
      dependencies_json: string;
      bytes: number;
      mime: string;
    }>(
      ctx.db,
      `SELECT a.id,a.revision,a.r2_key,a.sha256,a.kind,a.processing_state,a.review_status,a.access_classification,a.provenance_json,a.dependencies_json,a.bytes,a.mime
       FROM fb_assets a WHERE a.id=? AND a.tenant_id=? AND a.archived_at IS NULL AND ${auth.sql}`,
      assetId,
      ctx.tenant.id,
      ...auth.args,
    );
    if (
      !asset ||
      asset.processing_state !== "ready" ||
      !["reviewed", "approved"].includes(asset.review_status)
    )
      throw new ApiError(
        409,
        "render_review_required",
        "Every exact source must already be reviewed and ready.",
      );
    const head = await ctx.media.head(asset.r2_key);
    if (!head) throw new ApiError(409, "render_input_changed", "A render input is unavailable.");
    await readVerifiedRenderInput(ctx.media, {
      key: asset.r2_key,
      version: head.version,
      etag: head.etag,
      sha256: asset.sha256,
      bytes: asset.bytes,
    });
    return {
      id: asset.id,
      revision: asset.revision,
      key: asset.r2_key,
      version: head.version,
      etag: head.etag,
      sha256: asset.sha256,
      kind: asset.kind,
      processingState: asset.processing_state,
      reviewStatus: asset.review_status,
      accessClassification: asset.access_classification,
      provenanceJson: asset.provenance_json,
      dependenciesJson: asset.dependencies_json,
      bytes: asset.bytes,
      mime: asset.mime,
    };
  }
  const [subject, background, back, mark] = await Promise.all([
    capture(row.subject_id),
    capture(row.background_id),
    capture(row.back_id),
    row.mark_id ? capture(row.mark_id) : Promise.resolve(null),
  ]);
  const separator = row.edition_name.indexOf(" — "),
    printTitle = separator >= 0 ? row.edition_name.slice(separator + 3) : "";
  const candidate = {
    protocol: "foilbury-render-inputs-v1",
    tenantId: ctx.tenant.id,
    cardId: row.card_id,
    collectionId,
    variantId: row.variant_id,
    editionId: row.edition_id,
    editionName: row.edition_name,
    recipeId: row.recipe_id,
    cardVersion: row.card_version,
    editionSourceHash: row.source_hash,
    recipeVersion: row.recipe_version,
    recipeConfig: row.recipe_config,
    metadata: {
      name: row.name,
      subtitle: printTitle || row.subtitle || "",
      setName: row.set_name,
      serial:
        audience === "public"
          ? "PUBLIC SHOWCASE"
          : audience === "private"
            ? "PRIVATE EDITION"
            : "MEMBER EDITION",
      className: printTitle ? "Print" : row.class_name || "",
      rarity: row.rarity || "",
      material: row.material,
      effect: row.effect || "none",
      composition,
    },
    assets: { subject, background, back, mark },
    renderer,
  };
  const checked = await commitRenderManifest(candidate),
    fence = await renderManifestReferenceFence(checked.manifest),
    audienceFence = boundRenderAudienceFence(ctx, checked.manifest.cardId);
  const current = await first(
    ctx.db,
    `SELECT 1 WHERE ${auth.sql} AND ${fence.predicate} AND ${audienceFence.sql} AND ${lineage.sql}`,
    ...auth.args,
    ...fence.args,
    ...audienceFence.args,
    ...lineage.args,
  );
  if (!current)
    throw new ApiError(
      409,
      "render_inputs_changed",
      "The renderer credential or render inputs changed; retry after refreshing.",
    );
  return checked;
}

/** Release an uncommitted attempt without deleting its staged objects or review history. */
export async function cancelBoundRender(ctx: Ctx, id: string) {
  if (!/^brj_[A-Za-z0-9_-]+$/.test(id))
    throw new ApiError(404, "render_job_unavailable", "The render job is unavailable.");
  let guard: string, args: unknown[];
  if (ctx.actor.type === "agent") {
    const a = operator(ctx);
    guard = `${a.sql} AND j.operator_grant_id=? AND j.operator_token_id=? AND j.operator_token_hash=?`;
    args = [...a.args, a.grantId, a.tokenId, a.tokenHash];
  } else {
    const session = strongHumanArgs(ctx);
    guard = `${liveStrongHumanSession} AND EXISTS (SELECT 1 FROM fb_users u JOIN fb_memberships m ON m.user_id=u.id AND m.tenant_id=? AND m.status='active' AND m.revoked_at IS NULL
      JOIN fb_bots b ON b.tenant_id=m.tenant_id AND b.status='active' WHERE u.id=? AND u.disabled_at IS NULL AND
      ((m.role='owner' AND b.owner_user_id=u.id) OR (u.platform_admin=1 AND EXISTS (SELECT 1 FROM fb_platform_admins pa WHERE pa.user_id=u.id AND pa.status='active' AND pa.revoked_at IS NULL))))`;
    args = [...session, ctx.tenant.id, ctx.user!.id];
  }
  const now = nowIso(),
    results = await ctx.db.batch([
      ctx.db
        .prepare(
          `UPDATE fb_bound_render_jobs AS j SET status='failed',updated_at=? WHERE j.id=? AND j.tenant_id=?
      AND j.status IN ('pending','running','awaiting_review','approved') AND ${guard} RETURNING id`,
        )
        .bind(now, id, ctx.tenant.id, ...args),
      ctx.db
        .prepare(
          `INSERT INTO fb_audit_events(id,tenant_id,actor_type,actor_id,represented_user_id,action,object_type,object_id,metadata_json,request_id,created_at)
      SELECT ?,?,?,?,?,'render.bound_cancelled','bound_render_job',?,'{}',?,? WHERE changes()=1`,
        )
        .bind(
          newId("aud"),
          ctx.tenant.id,
          ctx.actor.type,
          ctx.actor.id,
          ctx.actor.representedUserId,
          id,
          ctx.requestId,
          now,
        ),
    ]);
  if (results[0]?.results?.length) return { id, status: "failed" as const };
  const prior = await first(
    ctx.db,
    `SELECT 1 FROM fb_bound_render_jobs j WHERE j.id=? AND j.tenant_id=? AND j.status='failed' AND ${guard}`,
    id,
    ctx.tenant.id,
    ...args,
  );
  if (prior) return { id, status: "failed" as const };
  throw new ApiError(
    409,
    "render_job_unavailable",
    "The render was already published or your authority changed.",
  );
}

/** The same designated credential can resume a lost-response job without
 * creating another attempt. No token hash is returned. */
export async function boundRenderStatus(ctx: Ctx, id: string) {
  const auth = operator(ctx);
  const row = await first<{
    status: string;
    attempt: number;
    manifest_json: string;
    manifest_sha256: string;
    result_json: string | null;
  }>(
    ctx.db,
    `SELECT j.status,j.attempt,j.manifest_json,j.manifest_sha256,j.result_json FROM fb_bound_render_jobs j
     WHERE j.id=? AND j.tenant_id=? AND j.operator_grant_id=? AND j.operator_token_id=? AND j.operator_token_hash=? AND ${auth.sql}`,
    id,
    ctx.tenant.id,
    auth.grantId,
    auth.tokenId,
    auth.tokenHash,
    ...auth.args,
  );
  if (!row) throw new ApiError(404, "render_job_unavailable", "The render job is unavailable.");
  let raw: unknown;
  try {
    raw = JSON.parse(row.manifest_json);
  } catch {
    throw new ApiError(409, "render_job_unavailable", "The render job is invalid.");
  }
  const { manifest, sha256 } = await commitRenderManifest(raw);
  if (sha256 !== row.manifest_sha256 || manifest.tenantId !== ctx.tenant.id)
    throw new ApiError(409, "render_job_unavailable", "The render job is invalid.");
  const fence = await renderManifestReferenceFence(manifest),
    audience = boundRenderAudienceFence(ctx, manifest.cardId),
    lineage = await boundLineageFence(ctx,Object.values(manifest.assets).filter((item): item is NonNullable<typeof item> => item !== null).map(item => item.id));
  const current = await first(
    ctx.db,
    `SELECT 1 FROM fb_bound_render_jobs j WHERE j.id=? AND j.tenant_id=? AND j.status=? AND j.attempt=? AND j.manifest_json=? AND j.manifest_sha256=?
    AND j.operator_grant_id=? AND j.operator_token_id=? AND j.operator_token_hash=? AND ${auth.sql} AND ${fence.predicate} AND ${audience.sql} AND ${lineage.sql}`,
    id,
    ctx.tenant.id,
    row.status,
    row.attempt,
    row.manifest_json,
    row.manifest_sha256,
    auth.grantId,
    auth.tokenId,
    auth.tokenHash,
    ...auth.args,
    ...fence.args,
    ...audience.args,
    ...lineage.args,
  );
  if (!current)
    throw new ApiError(
      409,
      "render_inputs_changed",
      "The renderer credential or render inputs changed.",
    );
  let result: unknown = null;
  if (row.result_json) {
    try {
      result = JSON.parse(row.result_json);
    } catch {
      throw new ApiError(409, "render_job_unavailable", "The render receipt is invalid.");
    }
  }
  return { id, status: row.status, attempt: row.attempt, manifestSha256: sha256, manifest, result };
}

/** Fetch the current published front for trusted derivative generation. */
export async function readBoundPublishedFront(ctx: Ctx, id: string) {
  const before = await boundRenderStatus(ctx, id);
  if (before.status !== "succeeded")
    throw new ApiError(409, "render_job_unavailable", "The render has not been published.");
  const receipt = await publishBoundRender(ctx, id, before.attempt);
  const front = receipt.front as { assetId?: unknown; sha256?: unknown } | undefined;
  if (typeof front?.assetId !== "string" || typeof front.sha256 !== "string")
    throw new ApiError(409, "render_job_unavailable", "The render receipt is invalid.");
  const asset = await getAsset(ctx, front.assetId);
  if (!asset.r2_key.startsWith("bound-render-stage-v1/") || asset.sha256 !== front.sha256)
    throw new ApiError(409, "render_output_changed", "The render output changed.");
  const bytes = new Uint8Array(await readAsset(ctx.media, asset, ctx.db));
  const after = await boundRenderStatus(ctx, id);
  if (
    after.status !== "succeeded" ||
    after.attempt !== before.attempt ||
    JSON.stringify(after.result) !== JSON.stringify(before.result)
  )
    throw new ApiError(409, "render_inputs_changed", "The render or its audience changed.");
  return { bytes, mime: asset.mime, sha256: asset.sha256, assetId: asset.id };
}
