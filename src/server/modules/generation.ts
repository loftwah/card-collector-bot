import { ApiError, type Ctx } from "../context";
import { all, first, nowIso } from "../db";
import { newId, sha256Hex } from "../ids";
import { auditStatement } from "../http";

const DEFAULT_MODEL = "fal-ai/flux-pro/v1.1";
const ESTIMATED_UNIT_MICROS = 40_000;

export interface GenerationJob {
  id: string;
  provider: string;
  model: string;
  status: string;
  prompt: string;
  input_hash: string;
  provider_job_id: string | null;
  output_asset_id: string | null;
  estimated_cost_micros: number;
  actual_cost_micros: number | null;
  uncertainty: string | null;
  created_at: string;
  updated_at: string;
}

export async function listGenerationJobs(ctx: Ctx) {
  return all<GenerationJob>(ctx.db, "SELECT * FROM fb_provider_jobs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 100", ctx.tenant.id);
}

export async function getGenerationJob(ctx: Ctx, id: string) {
  const job = await first<GenerationJob>(ctx.db, "SELECT * FROM fb_provider_jobs WHERE id = ? AND tenant_id = ?", id, ctx.tenant.id);
  if (!job) throw new ApiError(404, "generation_job_not_found", "Generation job not found.");
  return job;
}

export async function planGeneration(ctx: Ctx, input: { prompt: string; model?: string; count?: number; idempotencyKey: string }) {
  const count = Math.max(1, Math.min(10, input.count ?? 1));
  const model = input.model ?? DEFAULT_MODEL;
  const inputHash = await sha256Hex(JSON.stringify({ prompt: input.prompt, model, count }));
  const existing = await first<GenerationJob>(ctx.db, "SELECT * FROM fb_provider_jobs WHERE tenant_id = ? AND idempotency_key = ?", ctx.tenant.id, input.idempotencyKey);
  if (existing) return existing;
  const id = newId("gen");
  const now = nowIso();
  await ctx.db.batch([
    ctx.db
      .prepare(
        `INSERT INTO fb_provider_jobs
          (id, tenant_id, provider, model, status, prompt, input_hash, provider_job_id, output_asset_id,
           estimated_cost_micros, actual_cost_micros, uncertainty, requested_by, idempotency_key, created_at, updated_at)
         VALUES (?, ?, 'fal', ?, 'planned', ?, ?, NULL, NULL, ?, NULL, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        ctx.tenant.id,
        model,
        input.prompt,
        inputHash,
        ESTIMATED_UNIT_MICROS * count,
        "No provider response exists. This is an estimate only; no billed call has been made.",
        ctx.actor.id,
        input.idempotencyKey,
        now,
        now,
      ),
    auditStatement(ctx, "generation.planned", "provider_job", id, { model, count, estimated_cost_micros: ESTIMATED_UNIT_MICROS * count }),
  ]);
  return getGenerationJob(ctx, id);
}

export async function submitGeneration(ctx: Ctx, id: string) {
  const job = await getGenerationJob(ctx, id);
  if (job.status !== "planned") throw new ApiError(409, "generation_invalid_transition", `A ${job.status} job cannot be submitted.`);
  throw new ApiError(
    409,
    "generation_budget_unavailable",
    "No recorded generation ceiling and no verified server-side provider adapter are configured. The job remains planned; no request was made and no cost was incurred.",
    { job_id: job.id, estimated_cost_micros: job.estimated_cost_micros, ceiling_micros: 0 },
  );
}

export async function reviewGeneration(ctx: Ctx, id: string, decision: "approve" | "reject") {
  const job = await getGenerationJob(ctx, id);
  if (job.status !== "succeeded") {
    throw new ApiError(409, "generation_invalid_transition", "Only a completed provider result can be reviewed. No result exists.");
  }
  const status = decision === "approve" ? "review" : "failed";
  await ctx.db.batch([
    ctx.db.prepare("UPDATE fb_provider_jobs SET status = ?, updated_at = ? WHERE id = ? AND tenant_id = ?").bind(status, nowIso(), id, ctx.tenant.id),
    auditStatement(ctx, `generation.${decision}`, "provider_job", id),
  ]);
  return getGenerationJob(ctx, id);
}

export async function adoptGeneration(ctx: Ctx, id: string) {
  const job = await getGenerationJob(ctx, id);
  if (job.status !== "review" || !job.output_asset_id) {
    throw new ApiError(409, "generation_invalid_transition", "Only a reviewed job with a downloaded output asset can be adopted.");
  }
  await ctx.db.batch([
    ctx.db.prepare("UPDATE fb_provider_jobs SET status = 'adopted', updated_at = ? WHERE id = ? AND tenant_id = ?").bind(nowIso(), id, ctx.tenant.id),
    auditStatement(ctx, "generation.adopted", "provider_job", id, { output_asset_id: job.output_asset_id }),
  ]);
  return getGenerationJob(ctx, id);
}
