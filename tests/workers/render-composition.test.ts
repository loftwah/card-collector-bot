import { beforeEach, describe, expect, it } from "vitest";
import { bootstrap, ctxFor, fixturePool, runtime } from "./helpers";
import { createRenderJobs } from "../../src/server/modules/imports";
import { createEditionForCard } from "../../src/server/modules/catalogue";

describe("render composition contract", () => {
  beforeEach(async () => {
    await bootstrap();
  });

  it("does not enqueue a job while exact render inputs cannot be bound", async () => {
    const ctx = await ctxFor("cabinet", "owner@foilbury.local");
    const fixture = await fixturePool(ctx);
    await runtime.DB.prepare("UPDATE fb_artwork_editions SET composition_json = ? WHERE id = ?")
      .bind(JSON.stringify({ mode: "contain", zoom: 1.18, offsetX: 4, offsetY: -3 }), fixture.editionId)
      .run();
    await expect(createRenderJobs(ctx, { force: true })).rejects.toMatchObject({ code: "render_publication_unavailable" });
    const job = await runtime.DB.prepare(
      "SELECT payload_json FROM fb_jobs WHERE kind = 'render_card' AND json_extract(payload_json, '$.variant_id') = ? ORDER BY created_at DESC LIMIT 1",
    )
      .bind(fixture.variantId)
      .first<{ payload_json: string }>();
    expect(job).toBeNull();
  });

  it("creates a non-destructive revision with its own composition and lineage", async () => {
    const ctx = await ctxFor("cabinet", "owner@foilbury.local");
    const fixture = await fixturePool(ctx);
    await runtime.DB.prepare("UPDATE fb_artwork_editions SET composition_json = ? WHERE id = ?")
      .bind(JSON.stringify({ mode: "contain", zoom: 1.05, offsetX: 0, offsetY: 0 }), fixture.editionId)
      .run();
    const revised = await createEditionForCard(ctx, fixture.cardId, {
      name: "Revised edition",
      subjectAssetId: fixture.subjectAsset,
      backgroundAssetId: null,
      recipeId: fixture.recipeId,
      materials: ["gold"],
      variants: [{ material: "gold", effect: "holographic" }],
      status: "published",
      parentEditionId: fixture.editionId,
      composition: { mode: "fill", zoom: 1.4, offsetX: -6, offsetY: 8 },
    });
    const created = revised.editions.find((edition) => edition.name === "Revised edition");
    expect(created).toBeTruthy();
    const row = await runtime.DB
      .prepare("SELECT parent_edition_id, composition_json, subject_asset_id, status FROM fb_artwork_editions WHERE id = ?")
      .bind(created!.id)
      .first<{ parent_edition_id: string; composition_json: string; subject_asset_id: string; status: string }>();
    expect(row).toMatchObject({ parent_edition_id: fixture.editionId, subject_asset_id: fixture.subjectAsset, status: "published" });
    expect(JSON.parse(row!.composition_json)).toEqual({ mode: "fill", zoom: 1.4, offsetX: -6, offsetY: 8 });
    const original = await runtime.DB
      .prepare("SELECT composition_json, subject_asset_id FROM fb_artwork_editions WHERE id = ?")
      .bind(fixture.editionId)
      .first<{ composition_json: string; subject_asset_id: string }>();
    expect(JSON.parse(original!.composition_json)).toEqual({ mode: "contain", zoom: 1.05, offsetX: 0, offsetY: 0 });
    expect(original!.subject_asset_id).toBe(fixture.subjectAsset);
    const variants = await runtime.DB
      .prepare("SELECT v.name, m.key AS material_key, e.key AS effect_key FROM fb_variants v JOIN fb_materials m ON m.id = v.material_id LEFT JOIN fb_effects e ON e.id = v.effect_id WHERE v.edition_id = ?")
      .bind(created!.id)
      .all<{ name: string; material_key: string; effect_key: string }>();
    expect(variants.results).toHaveLength(1);
    expect(variants.results[0]).toMatchObject({ material_key: "gold", effect_key: "holographic" });
  });
});
