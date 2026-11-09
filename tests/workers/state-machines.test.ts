import { beforeEach, describe, expect, it } from "vitest";
import { claimRenderJob, completeRenderJob, failRenderJob } from "../../src/server/modules/imports";
import { bootstrap, ctxFor, runtime } from "./helpers";

const NOW = () => new Date().toISOString();

async function job(
  tenantId: string,
  id: string,
  status: string,
  attempts = 1,
  maxAttempts = 3,
): Promise<void> {
  const now = NOW();
  await runtime.DB.prepare(
    `INSERT INTO fb_jobs
      (id, tenant_id, kind, status, payload_json, attempts, max_attempts, available_at, created_at, updated_at)
     VALUES (?, ?, 'render_card', ?, '{"variant_id":"var_test_variant","recipe_id":"rec_test"}', ?, ?, ?, ?, ?)`,
  )
    .bind(id, tenantId, status, attempts, maxAttempts, now, now, now)
    .run();
}

describe("render job state machine enforcement", () => {
  beforeEach(async () => {
    await bootstrap();
  });

  it("holds a retryable job without changing its attempt while publication is unavailable", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    await job(owner.tenant.id, "job_retryable", "failed", 1, 3);
    await expect(claimRenderJob(owner, "job_retryable")).rejects.toMatchObject({ code: "render_publication_unavailable" });
    const row = await runtime.DB.prepare(
      "SELECT status, attempts, locked_at FROM fb_jobs WHERE id = 'job_retryable'",
    ).first<{ status: string; attempts: number; locked_at: string | null }>();
    expect(row?.status).toBe("failed");
    expect(row?.attempts).toBe(1);
    expect(row?.locked_at).toBeNull();
  });

  it("does not write objects, front/back rows, job state or receipts for an in-flight completion", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    await job(owner.tenant.id, "job_inflight", "running", 1, 3);
    let puts = 0;
    const media = new Proxy(owner.media, { get(target, key) {
      if (key === "put") return async () => { puts++; throw new Error("unexpected object write"); };
      const value = Reflect.get(target,key,target); return typeof value === "function" ? value.bind(target) : value;
    } });
    const before = await runtime.DB.prepare("SELECT (SELECT COUNT(*) FROM fb_variant_renders) fronts,(SELECT COUNT(*) FROM fb_variant_back_renders) backs,(SELECT COUNT(*) FROM fb_assets) assets,(SELECT COUNT(*) FROM fb_outbox) outbox,(SELECT COUNT(*) FROM fb_audit_events) audit").first();
    await expect(completeRenderJob({ ...owner, media }, "job_inflight", new Uint8Array([1]), new Uint8Array([2]), 1)).rejects.toMatchObject({ code: "render_publication_unavailable" });
    expect(puts).toBe(0);
    expect(await runtime.DB.prepare("SELECT (SELECT COUNT(*) FROM fb_variant_renders) fronts,(SELECT COUNT(*) FROM fb_variant_back_renders) backs,(SELECT COUNT(*) FROM fb_assets) assets,(SELECT COUNT(*) FROM fb_outbox) outbox,(SELECT COUNT(*) FROM fb_audit_events) audit").first()).toEqual(before);
    expect(await runtime.DB.prepare("SELECT status,attempts,result_json FROM fb_jobs WHERE id='job_inflight'").first()).toMatchObject({status:"running",attempts:1,result_json:null});
  });

  it("refuses to claim beyond the retry limit", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    await job(owner.tenant.id, "job_exhausted", "failed", 3, 3);
    await expect(claimRenderJob(owner, "job_exhausted")).rejects.toMatchObject({
      code: "job_attempts_exhausted",
    });
  });

  it("cannot fail or complete an already terminal job", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    await job(owner.tenant.id, "job_succeeded", "succeeded", 1, 3);
    await expect(
      failRenderJob(owner, "job_succeeded", "late worker failure", 1),
    ).rejects.toMatchObject({ code: "job_not_running" });
    await expect(
      completeRenderJob(owner, "job_succeeded", new Uint8Array([1, 2, 3]), undefined, 1),
    ).rejects.toMatchObject({ code: "job_already_complete" });
    const row = await runtime.DB.prepare(
      "SELECT status, last_error FROM fb_jobs WHERE id = 'job_succeeded'",
    ).first<{ status: string; last_error: string | null }>();
    expect(row?.status).toBe("succeeded");
    expect(row?.last_error).toBeNull();
  });

  it("fences a stale attempt that lost ownership of the job", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    await job(owner.tenant.id, "job_superseded", "running", 1, 3);
    await runtime.DB.prepare(
      "UPDATE fb_jobs SET attempts = 2, status = 'running' WHERE id = 'job_superseded'",
    ).run();
    await expect(
      failRenderJob(owner, "job_superseded", "stale worker failure", 1),
    ).rejects.toMatchObject({ code: "job_attempt_superseded" });
    const row = await runtime.DB.prepare(
      "SELECT status, attempts, last_error FROM fb_jobs WHERE id = 'job_superseded'",
    ).first<{ status: string; attempts: number; last_error: string | null }>();
    expect(row?.status).toBe("running");
    expect(row?.attempts).toBe(2);
    expect(row?.last_error).toBeNull();
  });
});
