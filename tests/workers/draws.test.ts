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
  it.each([0, 80])("uses the atomic debit ledger for a %i-Foil draw when the wallet changes after commit", async (price) => {
    await bootstrap();
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const fixture = await fixturePool(player);
    await runtime.DB.prepare("UPDATE fb_pools SET price = ? WHERE id = ?").bind(price, fixture.poolId).run();
    const preview = await getPoolPreview(player, "test-pool");
    let injected = false;
    const db = new Proxy(player.db, { get(target, key) {
      if (key === "batch") return async (statements: D1PreparedStatement[]) => {
        const result = await target.batch(statements);
        if (!injected) {
          injected = true;
          await target.prepare("UPDATE fb_wallets SET balance = balance + 10 WHERE tenant_id = ? AND user_id = ?").bind(player.tenant.id, player.user!.id).run();
        }
        return result;
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const result = await executeDraw({ ...player, db }, { pool: "test-pool", expectedRevision: preview.revision, expectedDistribution: preview.distribution_fingerprint, idempotency: { key: `draw-ledger-race-${price}`, digest: `ledger-race-${price}` } });
    expect(injected).toBe(true);
    expect(result.balance_after_debit).toBe(350 - price);
    expect(result.credits_total).toBe(160);
    expect(result.current_balance).toBe(350 - price + 170);
    expect(result.settlement_pending).toBe(true);
  });

  it("does not invent a historical balance when the debit ledger cannot be read", async () => {
    await bootstrap();
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await fixturePool(player);
    const preview = await getPoolPreview(player, "test-pool");
    const db = new Proxy(player.db, { get(target, key) {
      if (key === "prepare") return (sql: string) => {
        if (sql.includes("SELECT balance_after FROM fb_ledger_entries")) throw new Error("injected debit ledger failure");
        return target.prepare(sql);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const result = await executeDraw({ ...player, db }, { pool: "test-pool", expectedRevision: preview.revision, expectedDistribution: preview.distribution_fingerprint, idempotency: { key: "draw-debit-read-failure-001", digest: "debit-read-failure" } });
    expect(result.settlement_pending).toBe(true);
    expect(result.balance_after_debit).toBeUndefined();
    expect(result.balance_after).toBeUndefined();
    expect(result.current_balance).toBe(430);
    expect(await getInventory(player)).toHaveLength(1);
  });

  it("does not count an existing achievement again on a later zero-price draw", async () => {
    await bootstrap();
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const fixture = await fixturePool(player);
    await runtime.DB.prepare("UPDATE fb_pools SET price = 0 WHERE id = ?").bind(fixture.poolId).run();
    const preview = await getPoolPreview(player, "test-pool");
    const first = await executeDraw(player, { pool: "test-pool", expectedRevision: preview.revision, expectedDistribution: preview.distribution_fingerprint, idempotency: { key: "draw-first-zero-001", digest: "first-zero" } });
    const before = await walletBalance(player, player.user!.id);
    expect(first.credits_total).toBe(160);
    const nextPreview = await getPoolPreview(player, "test-pool");
    const second = await executeDraw(player, { pool: "test-pool", expectedRevision: nextPreview.revision, expectedDistribution: nextPreview.distribution_fingerprint, idempotency: { key: "draw-next-zero-001", digest: "next-zero" } });
    expect(second.credits_total).toBe(0);
    expect(second.achievements).toEqual([]);
    expect(second.settlement_status).toBe("settled");
    expect(second.balance_after_debit).toBe(before);
    expect(second.balance_after).toBe(before);
    expect(await walletBalance(player, player.user!.id)).toBe(before);
    const ledger = await runtime.DB.prepare("SELECT COUNT(*) AS n FROM fb_ledger_entries WHERE tenant_id = ? AND user_id = ? AND reference_type = 'achievement'").bind(player.tenant.id, player.user!.id).first<{ n: number }>();
    expect(ledger?.n).toBe(1);
  });

  it("does not call a draw settled when its achievement ledger read fails", async () => {
    await bootstrap();
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await fixturePool(player);
    const preview = await getPoolPreview(player, "test-pool");
    const db = new Proxy(player.db, { get(target, key) {
      if (key === "prepare") return (sql: string) => {
        if (sql.includes("SELECT u.achievement_id AS id, d.name")) throw new Error("injected ledger read failure");
        return target.prepare(sql);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const result = await executeDraw({ ...player, db }, { pool: "test-pool", expectedRevision: preview.revision, expectedDistribution: preview.distribution_fingerprint, idempotency: { key: "draw-ledger-failure-001", digest: "ledger-failure" } });
    expect(result.settlement_pending).toBe(true);
    expect(result.credits_total).toBe(0);
    expect(await getInventory(player)).toHaveLength(1);
  });

  it("does not count an event-linked unlock without its matching ledger row", async () => {
    await bootstrap();
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await fixturePool(player);
    const preview = await getPoolPreview(player, "test-pool");
    let injected = false;
    const db = new Proxy(player.db, { get(target, key) {
      if (key === "prepare") return (sql: string) => {
        const statement = target.prepare(sql);
        if (!sql.includes("SELECT u.achievement_id AS id, d.name")) return statement;
        return new Proxy(statement, { get(s, property) {
          if (property === "bind") return (...args: unknown[]) => {
            const bound = s.bind(...args);
            return new Proxy(bound, { get(b, method) {
              if (method === "all") return async () => {
                injected = true;
                await target.prepare("UPDATE fb_achievement_unlocks SET reward_ledger_id = NULL WHERE tenant_id = ? AND user_id = ?").bind(player.tenant.id, player.user!.id).run();
                return b.all();
              };
              const value = Reflect.get(b, method, b);
              return typeof value === "function" ? value.bind(b) : value;
            } });
          };
          const value = Reflect.get(s, property, s);
          return typeof value === "function" ? value.bind(s) : value;
        } });
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const result = await executeDraw({ ...player, db }, { pool: "test-pool", expectedRevision: preview.revision, expectedDistribution: preview.distribution_fingerprint, idempotency: { key: "draw-unlinked-credit-001", digest: "unlinked-credit" } });
    expect(injected).toBe(true);
    expect(result.credits_total).toBe(0);
    expect(result.settlement_pending).toBe(true);
  });

  it("retries a previous pending entitlement without attributing it to the new draw", async () => {
    await bootstrap();
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const fixture = await fixturePool(player);
    await runtime.DB.prepare("UPDATE fb_pools SET price = 0 WHERE id = ?").bind(fixture.poolId).run();
    const preview = await getPoolPreview(player, "test-pool");
    await executeDraw(player, { pool: "test-pool", expectedRevision: preview.revision, expectedDistribution: preview.distribution_fingerprint, idempotency: { key: "draw-old-entitlement-001", digest: "old-entitlement" } });
    await runtime.DB.prepare("DELETE FROM fb_ledger_entries WHERE tenant_id = ? AND user_id = ? AND reference_type = 'achievement'").bind(player.tenant.id, player.user!.id).run();
    await runtime.DB.prepare("UPDATE fb_achievement_unlocks SET reward_state = 'pending', reward_ledger_id = NULL WHERE tenant_id = ? AND user_id = ?").bind(player.tenant.id, player.user!.id).run();
    await setBalance(player, player.user!.id, 350);
    const next = await getPoolPreview(player, "test-pool");
    const result = await executeDraw(player, { pool: "test-pool", expectedRevision: next.revision, expectedDistribution: next.distribution_fingerprint, idempotency: { key: "draw-retry-entitlement-001", digest: "retry-entitlement" } });
    expect(await walletBalance(player, player.user!.id)).toBe(510);
    expect(result.credits_total).toBe(0);
    expect(result.achievements).toEqual([]);
    expect(result.settlement_pending).toBe(true);
    const unlock = await runtime.DB.prepare("SELECT reward_state, reward_ledger_id FROM fb_achievement_unlocks WHERE tenant_id = ? AND user_id = ?").bind(player.tenant.id, player.user!.id).first<{reward_state:string;reward_ledger_id:string|null}>();
    expect(unlock?.reward_state).toBe("granted");
    expect(unlock?.reward_ledger_id).toBeTruthy();
  });

  it("keeps an unconfirmed recovered receipt pending and never invents a zero balance", async () => {
    await bootstrap();
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await fixturePool(player);
    const preview = await getPoolPreview(player, "test-pool");
    const idempotency = { key: "draw-replay-pending-001", digest: "pending-replay" };
    const input = { pool: "test-pool", expectedRevision: preview.revision, expectedDistribution: preview.distribution_fingerprint, idempotency };
    const original = await executeDraw(player, input);
    await runtime.DB.prepare("UPDATE fb_idempotency_keys SET response_json = json_remove(response_json, '$.settlement_status', '$.settlement_pending', '$.balance_after') WHERE idempotency_key = ?")
      .bind(idempotency.key).run();
    const recovered = await executeDraw(player, input);
    expect(recovered.instance_id).toBe(original.instance_id);
    expect(recovered.settlement_status).toBe("pending");
    expect(recovered.settlement_pending).toBe(true);
    const brokenWalletDb = new Proxy(player.db, {
      get(target, property) {
        if (property === "prepare") return (sql: string) => {
          if (sql.includes("SELECT w.balance, e.currency_name")) throw new Error("Injected wallet read failure");
          return target.prepare(sql);
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const withoutWallet = await executeDraw({ ...player, db: brokenWalletDb }, input);
    expect(withoutWallet.instance_id).toBe(original.instance_id);
    expect(withoutWallet.settlement_pending).toBe(true);
    expect(withoutWallet.current_balance).toBeUndefined();
    expect(await getInventory(player)).toHaveLength(1);
  });
  it("debits and issues once, replays the same receipt, and rejects a stale revision", async () => {
    await bootstrap();
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const fixture = await fixturePool(player);
    const preview = await getPoolPreview(player, "test-pool");
    expect(preview.eligible_count).toBe(1);
    expect(preview.price).toBe(80);

    const input = { key: "draw-test-001", digest: "draw-digest-a" };
    const result = await executeDraw(player, { pool: "test-pool", expectedRevision: preview.revision, expectedDistribution: preview.distribution_fingerprint, idempotency: input });
    expect(result.card_name).toBe("Test One");
    expect(result.balance_after_debit).toBe(270);
    expect(result.credits_total).toBe(160);
    expect(result.balance_after).toBe(430);
    expect(result.current_balance).toBe(430);
    const achievementFoil = result.achievements.reduce((sum, item) => sum + item.reward_amount, 0);
    expect(result.credits_total).toBe(achievementFoil);
    expect(await walletBalance(player, player.user!.id)).toBe(430);
    const inventory = await getInventory(player);
    expect(inventory).toHaveLength(1);
    expect(inventory[0]!.id).toBe(result.instance_id);

    const replay = await executeDraw(player, { pool: "test-pool", expectedRevision: preview.revision, expectedDistribution: preview.distribution_fingerprint, idempotency: input });
    expect(replay.replayed).toBe(true);
    expect(replay.draw_id).toBe(result.draw_id);
    expect(replay.instance_id).toBe(result.instance_id);
    expect(replay.serial).toBe(result.serial);
    expect(replay.balance_after_debit).toBe(270);
    expect(replay.credits_total).toBe(160);
    expect(replay.balance_after).toBe(430);
    expect(replay.current_balance).toBe(430);
    expect(await walletBalance(player, player.user!.id)).toBe(430);
    expect(await getInventory(player)).toHaveLength(1);
    const draws = await runtime.DB.prepare("SELECT id, instance_id, price FROM fb_draws WHERE tenant_id = ? AND user_id = ?")
      .bind(player.tenant.id, player.user!.id)
      .all<{ id: string; instance_id: string; price: number }>();
    expect(draws.results).toEqual([expect.objectContaining({ id: result.draw_id, instance_id: result.instance_id, price: 80 })]);
    const spend = await runtime.DB.prepare("SELECT COUNT(*) AS count, SUM(amount) AS amount FROM fb_ledger_entries WHERE tenant_id = ? AND user_id = ? AND kind = 'spend'")
      .bind(player.tenant.id, player.user!.id)
      .first<{ count: number; amount: number }>();
    expect(spend).toMatchObject({ count: 1, amount: -80 });

    await runtime.DB.prepare("UPDATE fb_pools SET revision = 2 WHERE id = ?").bind(fixture.poolId).run();
    await expect(
      executeDraw(player, { pool: "test-pool", expectedRevision: 1, expectedDistribution: preview.distribution_fingerprint, idempotency: { key: "draw-test-002", digest: "draw-digest-b" } }),
    ).rejects.toMatchObject({ code: "stale_pool_revision" });
    expect(await walletBalance(player, player.user!.id)).toBe(430);
  });

  it("rejects a changed payload under the same operation key without charging", async () => {
    await bootstrap();
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await fixturePool(player);
    const preview = await getPoolPreview(player, "test-pool");
    const input = { key: "draw-changed-payload-001", digest: "draw-changed-a" };
    const result = await executeDraw(player, { pool: "test-pool", expectedRevision: preview.revision, expectedDistribution: preview.distribution_fingerprint, idempotency: input });
    expect(await walletBalance(player, player.user!.id)).toBe(430);

    await expect(
      executeDraw(player, { pool: "test-pool", expectedRevision: preview.revision + 1, expectedDistribution: "different-distribution-000000000001", idempotency: { key: input.key, digest: "draw-changed-b" } }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });

    expect(await walletBalance(player, player.user!.id)).toBe(430);
    expect(await getInventory(player)).toHaveLength(1);
    const draws = await runtime.DB.prepare("SELECT COUNT(*) AS count FROM fb_draws WHERE tenant_id = ? AND user_id = ?")
      .bind(player.tenant.id, player.user!.id)
      .first<{ count: number }>();
    expect(draws?.count).toBe(1);
    const replay = await executeDraw(player, { pool: "test-pool", expectedRevision: preview.revision, expectedDistribution: preview.distribution_fingerprint, idempotency: input });
    expect(replay.replayed).toBe(true);
    expect(replay.instance_id).toBe(result.instance_id);
  });

  it("does not charge when reconciliation finds no receipt and the pool changed", async () => {
    await bootstrap();
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const fixture = await fixturePool(player);
    const preview = await getPoolPreview(player, "test-pool");
    const input = { key: "draw-lost-before-commit-001", digest: "draw-lost-a" };

    // Simulate a request that never reached the server: the same key now
    // reconciles against a pool whose revision has moved. No receipt exists,
    // so the server rejects before charging and the client may release the key.
    await runtime.DB.prepare("UPDATE fb_pools SET revision = 2 WHERE id = ?").bind(fixture.poolId).run();
    await expect(
      executeDraw(player, { pool: "test-pool", expectedRevision: preview.revision, expectedDistribution: preview.distribution_fingerprint, idempotency: input }),
    ).rejects.toMatchObject({ code: "stale_pool_revision" });

    expect(await walletBalance(player, player.user!.id)).toBe(350);
    expect(await getInventory(player)).toHaveLength(0);
    const draws = await runtime.DB.prepare("SELECT COUNT(*) AS count FROM fb_draws WHERE tenant_id = ? AND user_id = ?")
      .bind(player.tenant.id, player.user!.id)
      .first<{ count: number }>();
    expect(draws?.count).toBe(0);
    const keys = await runtime.DB.prepare("SELECT COUNT(*) AS count FROM fb_idempotency_keys WHERE tenant_id = ? AND idempotency_key = ?")
      .bind(player.tenant.id, input.key)
      .first<{ count: number }>();
    expect(keys?.count).toBe(0);
  });

  it("keeps the historical receipt while reporting the current balance on replay", async () => {
    await bootstrap();
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await fixturePool(player);
    const preview = await getPoolPreview(player, "test-pool");
    const input = { key: "draw-current-balance-001", digest: "draw-current-a" };
    const result = await executeDraw(player, { pool: "test-pool", expectedRevision: preview.revision, expectedDistribution: preview.distribution_fingerprint, idempotency: input });
    expect(result.balance_after).toBe(430);

    // Another tab or mission may move the wallet after the receipt was written.
    await setBalance(player, player.user!.id, 900);
    const replay = await executeDraw(player, { pool: "test-pool", expectedRevision: preview.revision, expectedDistribution: preview.distribution_fingerprint, idempotency: input });
    expect(replay.replayed).toBe(true);
    expect(replay.instance_id).toBe(result.instance_id);
    expect(replay.balance_after).toBe(430);
    expect(replay.current_balance).toBe(900);
    expect(await walletBalance(player, player.user!.id)).toBe(900);
    expect(await getInventory(player)).toHaveLength(1);
  });

  it("shows 500 − 80 + a settled 100 reward as 520 with separate debit and credit", async () => {
    await bootstrap();
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await fixturePool(player);
    await setBalance(player, player.user!.id, 500);
    await runtime.DB.prepare(
      "UPDATE fb_achievement_definitions SET reward_json = '{\"foil\":100}' WHERE key = 'first-card'",
    ).run();
    const preview = await getPoolPreview(player, "test-pool");
    const result = await executeDraw(player, {
      pool: "test-pool",
      expectedRevision: preview.revision,
      expectedDistribution: preview.distribution_fingerprint,
      idempotency: { key: "draw-economy-500-80-100", digest: "economy-fixture" },
    });
    expect(result.price).toBe(80);
    expect(result.balance_after_debit).toBe(420);
    expect(result.credits_total).toBe(100);
    expect(result.achievement_credits).toEqual([
      { id: "ach_first_card", name: "The first one is always special", amount: 100 },
    ]);
    expect(result.balance_after).toBe(520);
    expect(result.current_balance).toBe(520);
    expect(await walletBalance(player, player.user!.id)).toBe(520);
    const ledger = await runtime.DB.prepare(
      "SELECT kind, amount, description FROM fb_ledger_entries WHERE tenant_id = ? AND user_id = ? ORDER BY created_at",
    )
      .bind(player.tenant.id, player.user!.id)
      .all<{ kind: string; amount: number; description: string }>();
    expect(ledger.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "spend", amount: -80 }),
        expect.objectContaining({ kind: "issue", amount: 100, description: "Achievement: The first one is always special" }),
      ]),
    );
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
      executeDraw(player, { pool: "test-empty", expectedRevision: 1, expectedDistribution: empty.distribution_fingerprint, idempotency: { key: "draw-empty-001", digest: "digest-empty" } }),
    ).rejects.toMatchObject({ code: "empty_pool" });
    expect(await walletBalance(player, player.user!.id)).toBe(350);

    const preview = await getPoolPreview(player, "test-pool");
    await runtime.DB.prepare("UPDATE fb_variants SET status = 'retired' WHERE id = ?").bind(fixture.variantId).run();
    await expect(
      executeDraw(player, { pool: "test-pool", expectedRevision: preview.revision, expectedDistribution: preview.distribution_fingerprint, idempotency: { key: "draw-empty-002", digest: "digest-empty-2" } }),
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
      executeDraw(player, { pool: "test-pool", expectedRevision: preview.revision, expectedDistribution: preview.distribution_fingerprint, idempotency: { key: "draw-race-a", digest: "race-a" } }),
      executeDraw(player, { pool: "test-pool", expectedRevision: preview.revision, expectedDistribution: preview.distribution_fingerprint, idempotency: { key: "draw-race-b", digest: "race-b" } }),
    ]);
    const fulfilled = settled.filter((item) => item.status === "fulfilled");
    const rejected = settled.filter((item) => item.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(await walletBalance(player, player.user!.id)).toBe(20 + 160);
    expect(await getInventory(player)).toHaveLength(1);
    const summary = await getWalletSummary(player.db, player.tenant.id, player.user!.id);
    expect(summary.balance).toBe(20 + 160);
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
      executeDraw(ctx, { pool: "test-pool", expectedRevision: filtered.revision, expectedDistribution: filtered.distribution_fingerprint, channelKey: "family-table", idempotency: { key: "draw-filter-001", digest: "filter-1" } }),
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
