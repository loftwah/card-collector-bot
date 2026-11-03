import { beforeEach, describe, expect, it } from "vitest";
import { bootstrap, ctxFor, fixturePool, runtime, walletBalance } from "./helpers";
import { executeDraw, getPoolPreview } from "../../src/server/modules/pools";
import { getPreferences, updatePreferences } from "../../src/server/modules/economy";
import { nowIso } from "../../src/server/db";

describe("collection-first draw preferences and preview consent", () => {
  beforeEach(async () => {
    await bootstrap();
  });

  it("removes hidden collections from future eligibility without touching ownership", async () => {
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const fixture = await fixturePool(player);
    const before = await getPoolPreview(player, "test-pool");
    expect(before.eligible_count).toBe(1);
    expect(before.entries[0]!.collections.some((collection) => collection.id === "col_test_public")).toBe(true);
    expect(before.filters.unfiled_count).toBe(0);

    const saved = await updatePreferences(player, { hiddenCollectionIds: ["col_test_public"] });
    expect(saved.hidden_collection_ids).toEqual(["col_test_public"]);
    const after = await getPoolPreview(player, "test-pool");
    expect(after.eligible_count).toBe(0);
    expect(after.filters.player_hidden_collection_ids).toEqual(["col_test_public"]);
    expect(after.filters.empty_reason).toContain("turned off");
    expect(after.distribution_fingerprint).not.toBe(before.distribution_fingerprint);

    const balanceBefore = await walletBalance(player, player.user!.id);
    await expect(
      executeDraw(player, {
        pool: "test-pool",
        expectedRevision: before.revision,
        expectedDistribution: before.distribution_fingerprint,
        idempotency: { key: "hidden-collection-draw", digest: "hidden-collection" },
      }),
    ).rejects.toMatchObject({ code: "empty_pool" });
    expect(await walletBalance(player, player.user!.id)).toBe(balanceBefore);
    const inventory = await runtime.DB.prepare("SELECT COUNT(*) AS count FROM fb_card_instances WHERE tenant_id = ? AND user_id = ?").bind(player.tenant.id, player.user!.id).first<{ count: number }>();
    expect(inventory?.count ?? 0).toBe(0);
  });

  it("keeps a multi-collection card while any member collection remains included", async () => {
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const fixture = await fixturePool(player);
    const now = nowIso();
    await runtime.DB.batch([
      runtime.DB
        .prepare(
          "INSERT INTO fb_collections (id, slug, name, description, scope, owner_tenant_id, accent, status, view_audience, public_approved_at, public_approved_by, created_by, created_at, updated_at) VALUES ('col_test_second', 'test-second', 'Second World', 'A second collection.', 'global', ?, 'brass', 'published', 'members', NULL, NULL, 'test', ?, ?)",
        )
        .bind(player.tenant.id, now, now),
      runtime.DB
        .prepare(
          "INSERT INTO fb_collection_cards (collection_id, card_id, tenant_id, sort, added_by, added_at) VALUES ('col_test_second', ?, ?, 0, 'test', ?)",
        )
        .bind(fixture.cardId, player.tenant.id, now),
      runtime.DB
        .prepare("INSERT INTO fb_bot_collections (bot_id, collection_id, enabled, updated_at) SELECT b.id, 'col_test_second', 1, ? FROM fb_bots b WHERE b.tenant_id = ?")
        .bind(now, player.tenant.id),
    ]);

    await updatePreferences(player, { hiddenCollectionIds: ["col_test_public"] });
    const oneHidden = await getPoolPreview(player, "test-pool");
    expect(oneHidden.eligible_count).toBe(1);
    expect(oneHidden.entries[0]!.collections.map((item) => item.id).sort()).toEqual(["col_test_public", "col_test_second"]);

    await updatePreferences(player, { hiddenCollectionIds: ["col_test_public", "col_test_second"] });
    const allHidden = await getPoolPreview(player, "test-pool");
    expect(allHidden.eligible_count).toBe(0);
  });

  it("rejects an old preview when the effective distribution changes under the same revision", async () => {
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const fixture = await fixturePool(player);
    const preview = await getPoolPreview(player, "test-pool");
    const balanceBefore = await walletBalance(player, player.user!.id);

    // Simulate an administrator publishing a weight change without a revision
    // bump (the exact gap a pool revision cannot detect).
    await runtime.DB.prepare("UPDATE fb_pool_entries SET weight = 250 WHERE pool_id = ? AND variant_id = ?").bind(fixture.poolId, fixture.variantId).run();
    const changed = await getPoolPreview(player, "test-pool");
    expect(changed.revision).toBe(preview.revision);
    expect(changed.distribution_fingerprint).not.toBe(preview.distribution_fingerprint);

    await expect(
      executeDraw(player, {
        pool: "test-pool",
        expectedRevision: preview.revision,
        expectedDistribution: preview.distribution_fingerprint,
        idempotency: { key: "stale-distribution", digest: "stale-distribution" },
      }),
    ).rejects.toMatchObject({ code: "stale_distribution" });
    expect(await walletBalance(player, player.user!.id)).toBe(balanceBefore);
    const inventory = await runtime.DB.prepare("SELECT COUNT(*) AS count FROM fb_card_instances WHERE tenant_id = ? AND user_id = ?").bind(player.tenant.id, player.user!.id).first<{ count: number }>();
    expect(inventory?.count ?? 0).toBe(0);

    const accepted = await executeDraw(player, {
      pool: "test-pool",
      expectedRevision: changed.revision,
      expectedDistribution: changed.distribution_fingerprint,
      idempotency: { key: "fresh-distribution", digest: "fresh-distribution" },
    });
    expect(accepted.card_name).toBe("Test One");
    expect(accepted.distribution_fingerprint).toBe(changed.distribution_fingerprint);
  });

  it("reports legacy unfiled cards instead of hiding them in a residual pool", async () => {
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const fixture = await fixturePool(player);
    await runtime.DB.prepare("DELETE FROM fb_collection_cards WHERE card_id = ?").bind(fixture.cardId).run();
    const preview = await getPoolPreview(player, "test-pool");
    expect(preview.eligible_count).toBe(1);
    expect(preview.filters.unfiled_count).toBe(1);
    await updatePreferences(player, { hiddenCollectionIds: ["col_test_public"] });
    const stillThere = await getPoolPreview(player, "test-pool");
    expect(stillThere.eligible_count).toBe(1);
    expect(stillThere.filters.unfiled_count).toBe(1);
  });

  it("validates collection ids and preserves the separate content filter", async () => {
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await fixturePool(player);
    await expect(updatePreferences(player, { hiddenCollectionIds: ["col_missing"] })).rejects.toMatchObject({ code: "collection_invalid" });
    const current = await getPreferences(player);
    expect(current.hidden_collection_ids).toEqual([]);
    const saved = await updatePreferences(player, { hideTags: [], hiddenCollectionIds: [] });
    expect(saved.hide_tags).toEqual([]);
    expect(saved.hidden_collection_ids).toEqual([]);
  });
});
