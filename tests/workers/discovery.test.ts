import { beforeEach, describe, expect, it } from "vitest";
import { bootstrap, ctxFor, fixturePool, runtime } from "./helpers";
import { routeApi } from "../../src/server/api/router";
import { listCards } from "../../src/server/modules/catalogue";
import type { Ctx } from "../../src/server/context";
import { ApiError } from "../../src/server/context";
import { nowIso } from "../../src/server/db";

function anonymous(ctx: Ctx): Ctx {
  return {
    ...ctx,
    user: null,
    actor: { type: "system", id: "anonymous", representedUserId: null, label: "Anonymous" },
    csrfToken: "",
  };
}

async function get(ctx: Ctx, path: string) {
  try {
    const response = await routeApi(new Request(`http://localhost:5173${path}`), ctx, path.replace(/^\/api\/v1\//, ""));
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  } catch (error) {
    if (error instanceof ApiError) return { status: error.status, body: { error: { code: error.code } } };
    throw error;
  }
}

describe("discovery and direct lookup privacy", () => {
  beforeEach(async () => {
    await bootstrap();
  });

  it("does not enumerate pool metadata to an anonymous caller", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    await fixturePool(owner);
    const anon = await get(anonymous(owner), "/api/v1/pools");
    expect(anon.status).toBe(401);
    expect(JSON.stringify(anon.body)).not.toContain("Test pool");
  });

  it("does not expose a members-only collection by id to an anonymous caller", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    await fixturePool(owner);
    const now = nowIso();
    await runtime.DB.prepare(
      "INSERT INTO fb_collections (id, slug, name, description, scope, owner_tenant_id, accent, status, view_audience, public_approved_at, public_approved_by, created_by, created_at, updated_at) VALUES ('col_member_only', 'member-only', 'Member Only', 'Restricted world.', 'global', ?, 'brass', 'published', 'members', NULL, NULL, 'test', ?, ?)",
    )
      .bind(owner.tenant.id, now, now)
      .run();
    const anon = await get(anonymous(owner), "/api/v1/collections/col_member_only");
    expect(anon.status).toBe(404);
    expect(JSON.stringify(anon.body)).not.toContain("Member Only");
    const member = await get(await ctxFor("cabinet", "player@foilbury.local"), "/api/v1/collections/col_member_only");
    expect(member.status).toBe(200);
  });

  it("finds the 201st public card directly rather than searching a 200-row page", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const fixture = await fixturePool(owner);
    const now = nowIso();
    await runtime.DB.prepare(
      `WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 201)
       INSERT INTO fb_card_definitions (id, tenant_id, logical_id, slug, name, subtitle, description, status, created_at, updated_at, version)
       SELECT 'crd_bulk_' || n, ?, 'bulk:' || n, 'zz-bulk-' || n, 'ZZ Card ' || printf('%03d', n), 'Bulk', 'A bulk card for direct lookup.', 'published', ?, ?, 1 FROM seq`,
    )
      .bind(owner.tenant.id, now, now)
      .run();
    await runtime.DB.prepare(
      `WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 201)
       INSERT INTO fb_collection_cards (collection_id, card_id, tenant_id, sort, added_by, added_at)
       SELECT 'col_test_public', 'crd_bulk_' || n, ?, n, 'test', ? FROM seq`,
    )
      .bind(owner.tenant.id, now)
      .run();
    const material = await runtime.DB.prepare("SELECT id FROM fb_materials WHERE tenant_id = ? AND key = 'plain'").bind(owner.tenant.id).first<{ id: string }>();
    const effect = await runtime.DB.prepare("SELECT id FROM fb_effects WHERE tenant_id = ? AND key = 'none'").bind(owner.tenant.id).first<{ id: string }>();
    await runtime.DB.batch([
      runtime.DB.prepare(
        "INSERT INTO fb_artwork_editions (id, tenant_id, card_id, name, subject_asset_id, recipe_id, status, source_repo, source_path, source_commit, source_hash, created_at) VALUES ('edt_bulk_201', ?, 'crd_bulk_201', 'Bulk edition', ?, ?, 'published', 'test/repo', 'test/subject.png', 'test-commit', 'test-hash', ?)",
      ).bind(owner.tenant.id, fixture.subjectAsset, fixture.recipeId, now),
      runtime.DB.prepare(
        "INSERT INTO fb_variants (id, tenant_id, card_id, edition_id, material_id, effect_id, name, status, created_at) VALUES ('var_bulk_201', ?, 'crd_bulk_201', 'edt_bulk_201', ?, ?, 'Plain', 'published', ?)",
      ).bind(owner.tenant.id, material!.id, effect!.id, now),
      runtime.DB.prepare(
        "INSERT INTO fb_variant_renders (id, tenant_id, variant_id, recipe_id, asset_id, public_url, width, height, sha256, status, created_at, published_at) VALUES ('vr_bulk_201', ?, 'var_bulk_201', ?, ?, '/media/public/bulk-201', 750, 1050, 'bulk-render-hash', 'published', ?, ?)",
      ).bind(owner.tenant.id, fixture.recipeId, fixture.renderAsset, now, now),
      runtime.DB.prepare(
        "INSERT INTO fb_catalogue_releases (id, tenant_id, version, status, manifest_json, checksum, published_by, published_at) VALUES ('rel_test', ?, 1, 'active', '{}', 'test-checksum', 'test', ?)",
      ).bind(owner.tenant.id, now),
    ]);

    const anon = anonymous(owner);
    const firstPage = await listCards(anon, { publicOnly: true, limit: 200 });
    expect(firstPage.some((card) => card.id === "crd_bulk_201")).toBe(false);
    const direct = await get(anon, "/api/v1/cards/crd_bulk_201");
    expect(direct.status).toBe(200);
    expect((direct.body.card as { name: string }).name).toBe("ZZ Card 201");
  });
});
