import { beforeEach, describe, expect, it } from "vitest";
import { classifyArtLineage } from "../../src/server/modules/art-lineage";
import { bootstrap, ctxFor, fixturePool, runtime } from "./helpers";
import { getPoolPreview } from "../../src/server/modules/pools";

describe("artwork lineage at draw eligibility", () => {
  beforeEach(async () => {
    await bootstrap();
  });

  it("excludes an AI background until the Bot opts in", async () => {
    const ctx = await ctxFor("cabinet", "owner@foilbury.local");
    const f = await fixturePool(ctx);
    await runtime.DB.prepare("UPDATE fb_assets SET origin = 'ai_generated' WHERE id = ?")
      .bind(f.renderAsset)
      .run();
    await runtime.DB.prepare("UPDATE fb_artwork_editions SET background_asset_id = ? WHERE id = ?")
      .bind(f.renderAsset, f.editionId)
      .run();
    expect((await getPoolPreview(ctx, "test-pool")).eligible_count).toBe(0);
    await runtime.DB.prepare("UPDATE fb_bots SET ai_art_enabled = 1 WHERE tenant_id = ?")
      .bind(ctx.tenant.id)
      .run();
    expect((await getPoolPreview(ctx, "test-pool")).eligible_count).toBe(1);
  });

  it("traces derived inputs and never treats missing or cyclic ancestry as known non-AI", async () => {
    const ctx = await ctxFor("cabinet", "owner@foilbury.local");
    const f = await fixturePool(ctx);
    await runtime.DB.prepare(
      "UPDATE fb_assets SET origin = 'derived', dependencies_json = ? WHERE id = ?",
    )
      .bind(JSON.stringify([f.renderAsset]), f.subjectAsset)
      .run();
    await runtime.DB.prepare("UPDATE fb_assets SET origin = 'ai_assisted' WHERE id = ?")
      .bind(f.renderAsset)
      .run();
    expect((await classifyArtLineage(runtime.DB, [f.subjectAsset])).get(f.subjectAsset)).toBe("ai");
    expect((await getPoolPreview(ctx, "test-pool")).eligible_count).toBe(0);
    await runtime.DB.prepare(
      "UPDATE fb_assets SET origin = 'derived', dependencies_json = ? WHERE id = ?",
    )
      .bind(JSON.stringify([f.subjectAsset]), f.renderAsset)
      .run();
    expect((await classifyArtLineage(runtime.DB, [f.subjectAsset])).get(f.subjectAsset)).toBe(
      "unknown",
    );
    expect((await getPoolPreview(ctx, "test-pool")).eligible_count).toBe(0);
    await runtime.DB.prepare("UPDATE fb_assets SET dependencies_json = ? WHERE id = ?")
      .bind(JSON.stringify(["missing-asset"]), f.subjectAsset)
      .run();
    expect((await classifyArtLineage(runtime.DB, [f.subjectAsset])).get(f.subjectAsset)).toBe(
      "unknown",
    );
    expect((await getPoolPreview(ctx, "test-pool")).eligible_count).toBe(0);
    await runtime.DB.prepare("UPDATE fb_assets SET origin = 'unknown' WHERE id = ?")
      .bind(f.subjectAsset)
      .run();
    expect((await classifyArtLineage(runtime.DB, [f.subjectAsset])).get(f.subjectAsset)).toBe(
      "unknown",
    );
    expect((await getPoolPreview(ctx, "test-pool")).eligible_count).toBe(0);
  });
  it("classifies more than 512 independent roots without truncating later assets", async () => {
    const ctx = await ctxFor("cabinet", "owner@foilbury.local");
    const statements = Array.from({ length: 520 }, (_, i) =>
      runtime.DB.prepare(
        "INSERT INTO fb_assets (id, tenant_id, kind, name, mime, bytes, r2_key, sha256, visibility, origin, created_at) VALUES (?, ?, 'subject', 'Lineage fixture', 'image/png', 1, ?, ?, 'private', ?, ?)",
      ).bind(
        `lin_${i}`,
        ctx.tenant.id,
        `lineage/${i}`,
        `lineage-hash-${i}`,
        i === 519 ? "ai_generated" : "sourced",
        new Date().toISOString(),
      ),
    );
    for (let i = 0; i < statements.length; i += 80)
      await runtime.DB.batch(statements.slice(i, i + 80));
    const result = await classifyArtLineage(
      runtime.DB,
      statements.map((_, i) => `lin_${i}`),
    );
    expect(result.size).toBe(520);
    expect(result.get("lin_0")).toBe("no-recorded-ai");
    expect(result.get("lin_519")).toBe("ai");
  });

  it("classifies a deeply shared dependency graph within a bounded traversal", async () => {
    const ctx = await ctxFor("cabinet", "owner@foilbury.local");
    const statements = Array.from({ length: 60 }, (_, i) =>
      runtime.DB.prepare(
        "INSERT INTO fb_assets (id, tenant_id, kind, name, mime, bytes, r2_key, sha256, visibility, origin, dependencies_json, created_at) VALUES (?, ?, 'subject', 'Graph fixture', 'image/png', 1, ?, ?, 'private', ?, ?, ?)",
      ).bind(
        `graph_${i}`,
        ctx.tenant.id,
        `graph/${i}`,
        `graph-hash-${i}`,
        i < 2 ? "sourced" : "derived",
        JSON.stringify(i < 2 ? [] : [`graph_${i - 1}`, `graph_${i - 2}`]),
        new Date().toISOString(),
      ),
    );
    await runtime.DB.batch(statements);
    expect((await classifyArtLineage(runtime.DB, ["graph_59"])).get("graph_59")).toBe("no-recorded-ai");
  });
});
