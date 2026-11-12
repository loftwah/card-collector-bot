import { z } from "zod";
import { ApiError, type Ctx } from "../context";
import { json, readJson } from "../http";
import {
  addArtCandidate,
  addArtFeedback,
  approveArtCandidate,
  ART_CATEGORIES,
  artPendingReviewCount,
  cancelArtJob,
  claimArtJob,
  completeArtJob,
  createArtBrief,
  failArtJob,
  FEEDBACK_TAGS,
  getArtBrief,
  listArtAgentExport,
  listArtBriefs,
  listArtOptions,
  publishArtCandidate,
  queueArtGeneration,
  readArtCandidateFile,
  rejectArtCandidate,
  rollbackArtPublication,
  uploadCandidateRender,
} from "../modules/art-lab";
import { getBrandCatalogue, setBrandSelection } from "../modules/brand";
import { listArtTaste, saveArtTaste } from "../modules/art-taste";

const tasteSchema = z
  .object({
    pieceId: z.string().min(1).max(1500),
    grade: z.number().int().min(1).max(5).nullable().optional(),
    note: z.string().max(1000).optional(),
  })
  .strict()
  .refine((patch) => patch.grade !== undefined || patch.note !== undefined);

const briefSchema = z.object({
  category: z.enum(ART_CATEGORIES),
  collectionId: z.string().min(3).max(80).nullable().optional(),
  cardId: z.string().min(3).max(80).nullable().optional(),
  targetVariantId: z.string().min(3).max(80).nullable().optional(),
  title: z.string().min(2).max(160),
  intent: z.string().min(12).max(4000),
  references: z.array(z.string().max(1000)).max(20).optional(),
  audience: z.enum(["private", "members", "public"]).optional(),
  candidateCount: z.number().int().min(1).max(8).optional(),
  provider: z.string().min(1).max(80).optional(),
  model: z.string().min(1).max(120).optional(),
  methods: z.array(z.string().min(1).max(40)).min(1).max(4).optional(),
  styleKeys: z.array(z.string().min(1).max(40)).min(1).max(4).optional(),
  outputSizes: z.array(z.string().min(1).max(40)).max(10).optional(),
  notes: z.string().max(2000).nullable().optional(),
  costCapCents: z.number().int().min(50).max(2000).optional(),
});

const generateSchema = z.object({
  methods: z.array(z.string().min(1).max(40)).min(1).max(4).optional(),
  candidateCount: z.number().int().min(1).max(8).optional(),
});

const feedbackSchema = z.object({
  decision: z
    .enum(["comment", "like", "dislike", "shortlist", "needs_revision", "reject"])
    .optional(),
  tags: z.array(z.enum(FEEDBACK_TAGS)).max(8).optional(),
  body: z.string().max(2000).nullable().optional(),
});

const approveSchema = z.object({
  usage: z.string().min(3).max(200),
  notes: z.string().max(2000).nullable().optional(),
  vectorRef: z.string().max(1000).nullable().optional(),
  replace: z.boolean().optional(),
});

const rejectSchema = z.object({
  note: z.string().min(3).max(2000),
  tags: z.array(z.enum(FEEDBACK_TAGS)).max(8).optional(),
});

const publishSchema = z.object({
  confirmation: z.string().min(1).max(20),
  variantId: z.string().min(3).max(80).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  publishBack: z.boolean().optional(),
  vectorRef: z.string().max(1000).nullable().optional(),
});

const completeJobSchema = z.object({
  actualCostCents: z.number().int().min(0).max(100_000).optional(),
  costSource: z
    .enum(["provider_reported", "price_table", "estimated", "runner_recorded"])
    .optional(),
  note: z.string().max(1000).optional(),
});

const failJobSchema = z.object({
  message: z.string().min(3).max(2000),
  actualCostCents: z.number().int().min(0).max(100_000).optional(),
});

function pathId(value: string | undefined): string {
  if (!value || value.length < 3 || value.length > 80) {
    throw new ApiError(404, "not_found", "No matching Art Lab resource.");
  }
  return value;
}

/**
 * The Art Lab sub-router. It is reached from the main dispatcher under
 * `/api/v1/admin/art`; `/api/v1/studio/art` is the same route after the Studio
 * alias, with the live role check still performing the real authority check.
 */
export async function routeArtLab(
  request: Request,
  ctx: Ctx,
  segments: string[],
  url: URL,
  method: string,
): Promise<Response> {
  const rest = segments.slice(2);

  if (rest.length === 0 && method === "GET") {
    return json(
      await listArtBriefs(ctx, {
        category: url.searchParams.get("category") ?? undefined,
        limit: Number(url.searchParams.get("limit") ?? 100) || 100,
      }),
    );
  }
  if (rest.length === 1 && rest[0] === "options" && method === "GET") {
    return json(await listArtOptions(ctx));
  }
  if (rest.length === 1 && rest[0] === "taste" && method === "GET") {
    return json(await listArtTaste(ctx));
  }
  if (rest.length === 1 && rest[0] === "taste" && method === "POST") {
    const { pieceId, ...patch } = await readJson(request, tasteSchema);
    return json(await saveArtTaste(ctx, pieceId, patch));
  }
  if (rest.length === 1 && rest[0] === "brand" && method === "GET") {
    return json(await getBrandCatalogue(ctx));
  }
  if (rest.length === 2 && rest[0] === "brand" && rest[1] === "selection" && method === "POST") {
    const body = await readJson(
      request,
      z.object({ slot: z.string().min(3).max(40), path: z.string().min(3).max(500) }),
    );
    return json(await setBrandSelection(ctx, body));
  }
  if (rest.length === 1 && rest[0] === "count" && method === "GET") {
    return json({ count: await artPendingReviewCount(ctx) });
  }
  if (rest.length === 1 && rest[0] === "agent" && method === "GET") {
    return json(
      await listArtAgentExport(ctx, {
        briefId: url.searchParams.get("briefId") ?? undefined,
        limit: Number(url.searchParams.get("limit") ?? 50) || 50,
      }),
    );
  }

  if (rest.length === 1 && rest[0] === "briefs" && method === "POST") {
    const body = await readJson(request, briefSchema);
    return json({ brief: await createArtBrief(ctx, body) }, 201);
  }
  if (rest.length === 2 && rest[0] === "briefs" && rest[1] && method === "GET") {
    return json(await getArtBrief(ctx, pathId(rest[1])));
  }
  if (rest.length === 3 && rest[0] === "briefs" && rest[1] && rest[2] === "import" && method === "POST") {
    return json(await queueArtGeneration(ctx, pathId(rest[1]), {
      candidateCount: 1, externalImport: true,
    }), 202);
  }
  if (
    rest.length === 3 &&
    rest[0] === "briefs" &&
    rest[1] &&
    rest[2] === "generate" &&
    method === "POST"
  ) {
    const body =
      Number(request.headers.get("content-length") ?? 0) === 0
        ? {}
        : await readJson(request, generateSchema);
    const result = await queueArtGeneration(ctx, pathId(rest[1]), body);
    return json(result, 202);
  }

  if (rest.length === 2 && rest[0] === "jobs" && rest[1] === "claim" && method === "POST") {
    const body =
      Number(request.headers.get("content-length") ?? 0) === 0
        ? {}
        : await readJson(request, z.object({ jobId: z.string().min(3).max(80).optional() }));
    const claimed = await claimArtJob(ctx, body);
    return json({ job: claimed });
  }
  if (
    rest.length === 3 &&
    rest[0] === "jobs" &&
    rest[1] &&
    rest[2] === "candidates" &&
    method === "POST"
  ) {
    const form = await request.formData();
    return json({ candidate: await addArtCandidate(ctx, pathId(rest[1]), form) }, 201);
  }
  if (
    rest.length === 3 &&
    rest[0] === "jobs" &&
    rest[1] &&
    rest[2] === "complete" &&
    method === "POST"
  ) {
    const body = await readJson(request, completeJobSchema);
    return json({ job: await completeArtJob(ctx, pathId(rest[1]), body) });
  }
  if (
    rest.length === 3 &&
    rest[0] === "jobs" &&
    rest[1] &&
    rest[2] === "fail" &&
    method === "POST"
  ) {
    const body = await readJson(request, failJobSchema);
    return json({ job: await failArtJob(ctx, pathId(rest[1]), body) });
  }
  if (
    rest.length === 3 &&
    rest[0] === "jobs" &&
    rest[1] &&
    rest[2] === "cancel" &&
    method === "POST"
  ) {
    return json({ job: await cancelArtJob(ctx, pathId(rest[1])) });
  }

  if (
    rest.length === 3 &&
    rest[0] === "candidates" &&
    rest[1] &&
    rest[2] === "feedback" &&
    method === "POST"
  ) {
    const body = await readJson(request, feedbackSchema);
    return json(await addArtFeedback(ctx, pathId(rest[1]), body));
  }
  if (
    rest.length === 3 &&
    rest[0] === "candidates" &&
    rest[1] &&
    rest[2] === "approve" &&
    method === "POST"
  ) {
    const body = await readJson(request, approveSchema);
    return json({ candidate: await approveArtCandidate(ctx, pathId(rest[1]), body) });
  }
  if (
    rest.length === 3 &&
    rest[0] === "candidates" &&
    rest[1] &&
    rest[2] === "reject" &&
    method === "POST"
  ) {
    const body = await readJson(request, rejectSchema);
    return json({ candidate: await rejectArtCandidate(ctx, pathId(rest[1]), body) });
  }
  if (
    rest.length === 3 &&
    rest[0] === "candidates" &&
    rest[1] &&
    rest[2] === "publish" &&
    method === "POST"
  ) {
    const body = await readJson(request, publishSchema);
    return json(await publishArtCandidate(ctx, pathId(rest[1]), body));
  }
  if (
    rest.length === 3 &&
    rest[0] === "candidates" &&
    rest[1] &&
    rest[2] === "render" &&
    method === "POST"
  ) {
    const form = await request.formData();
    return json({ candidate: await uploadCandidateRender(ctx, pathId(rest[1]), form) });
  }
  if (
    rest.length === 3 &&
    rest[0] === "candidates" &&
    rest[1] &&
    rest[2] === "file" &&
    method === "GET"
  ) {
    const file = await readArtCandidateFile(
      ctx,
      pathId(rest[1]),
      url.searchParams.get("side") ?? "display",
    );
    const download = url.searchParams.get("download") === "1";
    return new Response(file.bytes, {
      headers: {
        "content-type": file.mime,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "content-disposition": download ? `attachment; filename="${file.filename}"` : "inline",
      },
    });
  }

  if (
    rest.length === 3 &&
    rest[0] === "approvals" &&
    rest[1] &&
    rest[2] === "rollback" &&
    method === "POST"
  ) {
    return json(await rollbackArtPublication(ctx, pathId(rest[1])));
  }

  throw new ApiError(404, "not_found", "No matching Art Lab route.");
}
