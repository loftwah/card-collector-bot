import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/server/context";
import { getWalletSummary } from "../../src/server/modules/wallet";
import { getInventory } from "../../src/server/modules/collection";
import { claimDailyReward } from "../../src/server/modules/economy";
import { executeDraw, getPoolPreview } from "../../src/server/modules/pools";
import { bootstrap, ctxFor, fixturePool, makeInstance, runtime, setBalance, walletBalance } from "./helpers";

describe("earned rewards", () => {
  it("records one idempotent daily credit and rejects changed request reuse", async () => {
    await bootstrap();
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const input = { key: "claim-test-001", digest: "digest-a" };
    const first = await claimDailyReward(player, input);
    expect(first.amount).toBe(120);
    expect(first.balance_after).toBe(470);
    expect(await walletBalance(player, player.user!.id)).toBe(470);

    const replay = await claimDailyReward(player, input);
    expect(replay.replayed).toBe(true);
    expect(replay.claim_id).toBe(first.claim_id);
    expect(await walletBalance(player, player.user!.id)).toBe(470);

    await expect(claimDailyReward(player, { key: "claim-test-001", digest: "digest-b" })).rejects.toMatchObject({
      code: "idempotency_conflict",
    });
    await expect(claimDailyReward(player, { key: "claim-test-002", digest: "digest-c" })).rejects.toMatchObject({
      code: "reward_cooldown",
    });
    expect(await walletBalance(player, player.user!.id)).toBe(470);
  });
});

describe("draw transaction", () => {
  it("debits and issues once, replays the same receipt, and rejects a stale revision", async () => {
    await bootstrap();
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const fixture = await fixturePool(player);
    const preview = await getPoolPreview(player, "test-pool");
    expect(preview.eligible_count).toBe(1);
    expect(preview.price).toBe(80);

    const input = { key: "draw-test-001", digest: "draw-digest-a" };
    const result = await executeDraw(player, { pool: "test-pool", expectedRevision: preview.revision, idempotency: input });
    expect(result.card_name).toBe("Test One");
    expect(result.balance_after).toBe(270);
    expect(await walletBalance(player, player.user!.id)).toBe(270);
    const inventory = await getInventory(player);
    expect(inventory).toHaveLength(1);
    expect(inventory[0]!.id).toBe(result.instance_id);

    const replay = await executeDraw(player, { pool: "test-pool", expectedRevision: preview.revision, idempotency: input });
    expect(replay.replayed).toBe(true);
    expect(replay.instance_id).toBe(result.instance_id);
    expect(await walletBalance(player, player.user!.id)).toBe(270);
    expect(await getInventory(player)).toHaveLength(1);

    await runtime.DB.prepare("UPDATE fb_pools SET revision = 2 WHERE id = ?").bind(fixture.poolId).run();
    await expect(
      executeDraw(player, { pool: "test-pool", expectedRevision: 1, idempotency: { key: "draw-test-002", digest: "draw-digest-b" } }),
    ).rejects.toMatchObject({ code: "stale_pool_revision" });
    expect(await walletBalance(player, player.user!.id)).toBe(270);
  });

  it("does not charge an empty pool and does not charge when eligibility disappears", async () => {
    await bootstrap();
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const fixture = await fixturePool(player);
    const now = new Date().toISOString();
    await runtime.DB.prepare(
      "INSERT INTO fb_pools (id, tenant_id, slug, name, description, status, revision, price, created_at, updated_at, published_at) VALUES ('pool_test_empty', ?, 'test-empty', 'Empty pool', 'No eligible entries.', 'active', 1, 50, ?, ?, ?)",
    ).bind(player.tenant.id, now, now, now).run();
    const empty = await getPoolPreview(player, "test-empty");
    expect(empty.eligible_count).toBe(0);
    await expect(
      executeDraw(player, { pool: "test-empty", expectedRevision: 1, idempotency: { key: "draw-empty-001", digest: "digest-empty" } }),
    ).rejects.toMatchObject({ code: "empty_pool" });
    expect(await walletBalance(player, player.user!.id)).toBe(350);

    const preview = await getPoolPreview(player, "test-pool");
    await runtime.DB.prepare("UPDATE fb_variants SET status = 'retired' WHERE id = ?").bind(fixture.variantId).run();
    await expect(
      executeDraw(player, { pool: "test-pool", expectedRevision: preview.revision, idempotency: { key: "draw-empty-002", digest: "digest-empty-2" } }),
    ).rejects.toMatchObject({ code: "empty_pool" });
    expect(await walletBalance(player, player.user!.id)).toBe(350);
  });

  it("cannot overspend under concurrent draws", async () => {
    await bootstrap();
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await fixturePool(player);
    await setBalance(player, player.user!.id, 100);
    const preview = await getPoolPreview(player, "test-pool");
    const settled = await Promise.allSettled([
      executeDraw(player, { pool: "test-pool", expectedRevision: preview.revision, idempotency: { key: "draw-race-a", digest: "race-a" } }),
      executeDraw(player, { pool: "test-pool", expectedRevision: preview.revision, idempotency: { key: "draw-race-b", digest: "race-b" } }),
    ]);
    const fulfilled = settled.filter((item) => item.status === "fulfilled");
    const rejected = settled.filter((item) => item.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(await walletBalance(player, player.user!.id)).toBe(20);
    expect(await getInventory(player)).toHaveLength(1);
    const summary = await getWalletSummary(player.db, player.tenant.id, player.user!.id);
    expect(summary.balance).toBe(20);
  });

  it("applies community and personal filters without improving hidden odds", async () => {
    await bootstrap();
    const ctx = await ctxFor("cabinet", "player@foilbury.local");
    const fixture = await fixturePool(ctx);
    const existingTag = await runtime.DB.prepare("SELECT id FROM fb_tags WHERE tenant_id = ? AND slug = 'horror'").bind(ctx.tenant.id).first<{ id: string }>();
    const tagId = existingTag?.id ?? "tag_test_horror";
    const now = new Date().toISOString();
    await runtime.DB.batch([
      ...(existingTag ? [] : [runtime.DB.prepare("INSERT INTO fb_tags (id, tenant_id, slug, name) VALUES (?, ?, 'horror', 'Horror')").bind(tagId, ctx.tenant.id)]),
      runtime.DB.prepare("INSERT INTO fb_card_tags (tenant_id, card_id, tag_id) VALUES (?, ?, ?)").bind(ctx.tenant.id, fixture.cardId, tagId),
      runtime.DB.prepare("INSERT INTO fb_topic_policies (id, tenant_id, channel_key, name, exclude_tags_json, active, created_at, updated_at) VALUES ('pol_test', ?, 'family-table', 'Family table', '[\"horror\"]', 1, ?, ?)").bind(ctx.tenant.id, now, now),
    ]);
    const filtered = await getPoolPreview(ctx, "test-pool", "family-table");
    expect(filtered.eligible_count).toBe(0);
    expect(filtered.filters.empty_reason).toContain("topic policy");
    await expect(
      executeDraw(ctx, { pool: "test-pool", expectedRevision: filtered.revision, channelKey: "family-table", idempotency: { key: "draw-filter-001", digest: "filter-1" } }),
    ).rejects.toMatchObject({ code: "empty_pool" });
    expect(await walletBalance(ctx, ctx.user!.id)).toBe(350);

    await runtime.DB.prepare("INSERT INTO fb_player_preferences (tenant_id, user_id, hide_tags_json, updated_at) VALUES (?, ?, '[\"horror\"]', ?)")
      .bind(ctx.tenant.id, ctx.user!.id, now)
      .run();
    const personal = await getPoolPreview(ctx, "test-pool");
    expect(personal.eligible_count).toBe(0);
    expect(personal.filters.player_excluded_tags).toContain("horror");
  });
});
