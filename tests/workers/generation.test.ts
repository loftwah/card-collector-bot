import { describe, expect, it } from "vitest";
import { listGenerationJobs, planGeneration, reviewGeneration, submitGeneration } from "../../src/server/modules/generation";
import { bootstrap, ctxFor } from "./helpers";

describe("generation planning", () => {
  it("records a recoverable plan but refuses a billed submit without a ceiling", async () => {
    await bootstrap();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const job = await planGeneration(owner, {
      prompt: "A restrained background plate for a cabinet card",
      model: "fal-ai/flux-pro/v1.1",
      count: 1,
      idempotencyKey: "generation-test-1",
    });
    expect(job.status).toBe("planned");
    expect(job.output_asset_id).toBeNull();
    expect(job.estimated_cost_micros).toBeGreaterThan(0);
    const listed = await listGenerationJobs(owner);
    expect(listed.some((item) => item.id === job.id)).toBe(true);
    await expect(submitGeneration(owner, job.id)).rejects.toMatchObject({ code: "generation_budget_unavailable" });
    await expect(reviewGeneration(owner, job.id, "approve")).rejects.toMatchObject({ code: "generation_invalid_transition" });
    const stillPlanned = await listGenerationJobs(owner);
    expect(stillPlanned.find((item) => item.id === job.id)?.status).toBe("planned");
  });
});
