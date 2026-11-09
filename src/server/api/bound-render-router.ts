import { z } from "zod";
import { ApiError, assertCsrf, type Ctx } from "../context";
import { json, readJson } from "../http";
import { first } from "../db";
import { renderManifestSchema } from "../modules/render-manifest";
import {
  setBoundRenderOperator,
  prepareBoundRender,
  queueBoundRender,
  claimBoundRender,
  readBoundRenderInputs,
  stageBoundRenderOutputs,
  publishBoundRender,
  createBoundDerivative,
  cancelBoundRender,
  boundRenderStatus,
  readBoundPublishedFront,
} from "../modules/bound-render-jobs";
import { inspectBoundRender, reviewBoundRender } from "../modules/bound-render-review";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const attempt = z.number().int().positive();
function binary(bytes: Uint8Array, mime: string) {
  return new Response(bytes.slice().buffer, {
    headers: {
      "content-type": mime,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "content-disposition": mime === "image/svg+xml" ? "attachment" : "inline",
      "content-security-policy": "sandbox; default-src 'none'",
    },
  });
}
async function boundedRequest(request: Request, limit: number) {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit))
    throw new ApiError(413, "render_body_invalid", "Provide a bounded render upload.");
  if (!request.body) throw new ApiError(422, "render_body_invalid", "Provide a render upload.");
  const reader = request.body.getReader(),
    parts: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new ApiError(413, "render_body_invalid", "Provide a bounded render upload.");
    }
    parts.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return new Request(request.url, { method: "POST", headers: request.headers, body: bytes.buffer });
}
async function form(request: Request) {
  const bounded = await boundedRequest(request, 17 * 1024 * 1024);
  try {
    return await bounded.formData();
  } catch {
    throw new ApiError(422, "render_body_invalid", "Provide a valid render upload.");
  }
}
/** Candidate router. The top-level route remains held until independent end-to-end qualification. */
export async function routeBoundRender(
  request: Request,
  ctx: Ctx,
  segments: string[],
): Promise<Response> {
  if (request.method !== "GET") assertCsrf(ctx, request);
  if (segments[0] !== "admin" || segments[1] !== "bound-renders")
    throw new ApiError(404, "not_found", "Not found.");
  if (request.method === "POST" && segments.length === 3 && segments[2] === "operators") {
    const body = await readJson(
      await boundedRequest(request, 1_000_000),
      z.object({ grantId: id, tokenId: id, active: z.boolean() }).strict(),
    );
    return json(await setBoundRenderOperator(ctx, body.grantId, body.tokenId, body.active));
  }
  if (request.method === "POST" && segments.length === 3 && segments[2] === "prepare") {
    const body = await readJson(
      await boundedRequest(request, 1_000_000),
      z.object({ variantId: id, collectionId: id, renderer: z.unknown() }).strict(),
    );
    return json(await prepareBoundRender(ctx, body.variantId, body.collectionId, body.renderer));
  }
  if (request.method === "POST" && segments.length === 3 && segments[2] === "queue") {
    const body = await readJson(
      await boundedRequest(request, 1_000_000),
      z.object({ manifest: renderManifestSchema }).strict(),
    );
    return json(
      await queueBoundRender(ctx, body.manifest, request.headers.get("idempotency-key") ?? ""),
      201,
    );
  }
  const jobId = segments[2];
  if (!jobId || !id.safeParse(jobId).success) throw new ApiError(404, "not_found", "Not found.");
  if (request.method === "POST" && segments.length === 4 && segments[3] === "claim")
    return json(await claimBoundRender(ctx, jobId));
  if (request.method === "POST" && segments.length === 4 && segments[3] === "cancel")
    return json(await cancelBoundRender(ctx, jobId));
  if (request.method === "GET" && segments.length === 4 && segments[3] === "status")
    return json(await boundRenderStatus(ctx, jobId));
  if (
    request.method === "GET" &&
    segments.length === 5 &&
    segments[3] === "published" &&
    segments[4] === "front"
  ) {
    const output = await readBoundPublishedFront(ctx, jobId);
    return binary(output.bytes, output.mime);
  }
  if (request.method === "GET" && segments.length === 4 && segments[3] === "review") {
    const result = await inspectBoundRender(ctx, jobId);
    return json({
      manifest: result.manifest,
      manifestSha256: result.manifestSha256,
      attempt: result.attempt,
      front: { sha256: result.front.sha256, mime: result.front.mime },
      back: { sha256: result.back.sha256, mime: result.back.mime },
    });
  }
  if (
    request.method === "GET" &&
    segments.length === 5 &&
    segments[3] === "inputs" &&
    ["subject", "background", "back", "mark"].includes(segments[4] ?? "")
  ) {
    const n = attempt.safeParse(Number(new URL(request.url).searchParams.get("attempt")));
    if (!n.success)
      throw new ApiError(422, "attempt_required", "A current render attempt is required.");
    const data = await readBoundRenderInputs(ctx, jobId, n.data),
      role = segments[4] as "subject" | "background" | "back" | "mark";
    const bytes = data.bytes[role],
      asset = data.manifest.assets[role];
    if (!bytes || !asset)
      throw new ApiError(404, "render_input_unavailable", "That render input is unavailable.");
    return binary(bytes, asset.mime);
  }
  if (request.method === "POST" && segments.length === 4 && segments[3] === "stage") {
    const data = await form(request),
      front = data.get("front"),
      back = data.get("back"),
      n = attempt.safeParse(Number(data.get("attempt")));
    if (
      !(front instanceof File) ||
      !(back instanceof File) ||
      !n.success ||
      front.size > 8 * 1024 * 1024 ||
      back.size > 8 * 1024 * 1024
    )
      throw new ApiError(
        422,
        "render_outputs_required",
        "Provide both bounded render sides and the current attempt.",
      );
    return json(
      await stageBoundRenderOutputs(
        ctx,
        jobId,
        n.data,
        new Uint8Array(await front.arrayBuffer()),
        new Uint8Array(await back.arrayBuffer()),
      ),
    );
  }
  if (
    request.method === "GET" &&
    segments.length === 5 &&
    segments[3] === "preview" &&
    ["front", "back"].includes(segments[4] ?? "")
  ) {
    const result = await inspectBoundRender(ctx, jobId),
      side = result[segments[4] as "front" | "back"];
    return binary(side.bytes, side.mime);
  }
  if (request.method === "POST" && segments.length === 4 && segments[3] === "review") {
    const body = await readJson(
      await boundedRequest(request, 1_000_000),
      z
        .object({
          decision: z.enum(["approved", "rejected"]),
          manifestSha256: hash,
          frontSha256: hash,
          backSha256: hash,
          note: z.string().max(2000),
        })
        .strict(),
    );
    return json(await reviewBoundRender(ctx, jobId, body));
  }
  if (request.method === "POST" && segments.length === 4 && segments[3] === "publish") {
    const body = await readJson(
      await boundedRequest(request, 1_000_000),
      z.object({ attempt }).strict(),
    );
    return json(await publishBoundRender(ctx, jobId, body.attempt));
  }
  if (request.method === "POST" && segments.length === 4 && segments[3] === "derivatives") {
    const data = await form(request),
      file = data.get("file"),
      sourceAssetId = id.safeParse(data.get("sourceAssetId")),
      size = z.enum(["thumb", "preview", "detail"]).safeParse(data.get("sizeKey"));
    if (
      !(file instanceof File) ||
      file.size > 8 * 1024 * 1024 ||
      !sourceAssetId.success ||
      !size.success
    )
      throw new ApiError(422, "derivative_invalid", "Provide a bounded render derivative.");
    const linked = await first(
      ctx.db,
      "SELECT 1 FROM fb_bound_render_outputs WHERE job_id=? AND tenant_id=? AND asset_id=? AND side='front'",
      jobId,
      ctx.tenant.id,
      sourceAssetId.data,
    );
    if (!linked)
      throw new ApiError(404, "render_derivative_unavailable", "The source render is unavailable.");
    return json(
      await createBoundDerivative(
        ctx,
        sourceAssetId.data,
        size.data,
        new Uint8Array(await file.arrayBuffer()),
      ),
      201,
    );
  }
  throw new ApiError(404, "not_found", "Not found.");
}
