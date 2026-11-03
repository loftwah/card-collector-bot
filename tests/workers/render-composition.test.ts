import { beforeEach, describe, expect, it } from "vitest";
import { bootstrap, ctxFor, fixturePool, runtime } from "./helpers";
import { createRenderJobs } from "../../src/server/modules/imports";

describe("render composition contract", () => {
  beforeEach(async () => {
    await bootstrap();
  });

  it("carries the edition composition into the deterministic render job", async () => {
    const ctx = await ctxFor("cabinet", "owner@foilbury.local");
    const fixture = await fixturePool(ctx);
    await runtime.DB.prepare("UPDATE fb_artwork_editions SET composition_json = ? WHERE id = ?")
      .bind(JSON.stringify({ mode: "contain", zoom: 1.18, offsetX: 4, offsetY: -3 }), fixture.editionId)
      .run();
    const result = await createRenderJobs(ctx, { force: true });
    expect(result.queued).toBeGreaterThan(0);
    const job = await runtime.DB.prepare(
      "SELECT payload_json FROM fb_jobs WHERE kind = 'render_card' AND json_extract(payload_json, '$.variant_id') = ? ORDER BY created_at DESC LIMIT 1",
    )
      .bind(fixture.variantId)
      .first<{ payload_json: string }>();
    expect(job).toBeTruthy();
    const payload = JSON.parse(job!.payload_json) as { composition_json: string | null };
    expect(JSON.parse(payload.composition_json ?? "null")).toEqual({ mode: "contain", zoom: 1.18, offsetX: 4, offsetY: -3 });
  });
});
