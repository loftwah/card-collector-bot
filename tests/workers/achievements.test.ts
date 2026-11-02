import { describe, expect, it } from "vitest";
import { bootstrap, ctxFor, fixturePool, makeInstance, runtime, walletBalance } from "./helpers";
import { evaluateAchievements, listAchievements } from "../../src/server/modules/achievements";
import { newId, sha256Hex } from "../../src/server/ids";
import { nowIso } from "../../src/server/db";

describe("achievements", () => {
  it("awards a first-card badge and reward once, then remains idempotent", async () => {
    await bootstrap();
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const fixture = await fixturePool(player);
    await makeInstance(player, player.user!.id, fixture, "ACH-FIRST-1");
    const before = await walletBalance(player, player.user!.id);
    const first = await evaluateAchievements(player, { userId: player.user!.id });
    const firstCard = first.unlocked.find((item) => item.key === "first-card");
    expect(firstCard).toBeTruthy();
    expect(firstCard?.reward_amount).toBe(160);
    expect(await walletBalance(player, player.user!.id)).toBe(before + 160);
    const unlocks = await runtime.DB.prepare("SELECT COUNT(*) AS count FROM fb_achievement_unlocks WHERE tenant_id = ? AND user_id = ? AND achievement_id = 'ach_first_card'").bind(player.tenant.id, player.user!.id).first<{ count: number }>();
    expect(unlocks?.count).toBe(1);
    await evaluateAchievements(player, { userId: player.user!.id });
    expect(await walletBalance(player, player.user!.id)).toBe(before + 160);
    const again = await runtime.DB.prepare("SELECT COUNT(*) AS count FROM fb_achievement_unlocks WHERE tenant_id = ? AND user_id = ? AND achievement_id = 'ach_first_card'").bind(player.tenant.id, player.user!.id).first<{ count: number }>();
    expect(again?.count).toBe(1);
  });

  it("does not double-award under concurrent evaluation", async () => {
    await bootstrap();
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const fixture = await fixturePool(player);
    await makeInstance(player, player.user!.id, fixture, "ACH-RACE-1");
    const before = await walletBalance(player, player.user!.id);
    await Promise.all([
      evaluateAchievements(player, { userId: player.user!.id }),
      evaluateAchievements(player, { userId: player.user!.id }),
    ]);
    const unlocks = await runtime.DB.prepare("SELECT COUNT(*) AS count FROM fb_achievement_unlocks WHERE tenant_id = ? AND user_id = ? AND achievement_id = 'ach_first_card'").bind(player.tenant.id, player.user!.id).first<{ count: number }>();
    expect(unlocks?.count).toBe(1);
    expect(await walletBalance(player, player.user!.id)).toBe(before + 160);
    const ledger = await runtime.DB.prepare("SELECT COUNT(*) AS count FROM fb_ledger_entries WHERE tenant_id = ? AND user_id = ? AND reference_type = 'achievement'").bind(player.tenant.id, player.user!.id).first<{ count: number }>();
    expect(ledger?.count).toBe(1);
  });

  it("recovers an interrupted reward once and reconciles a committed ledger row", async () => {
    await bootstrap();
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const fixture = await fixturePool(player);
    await makeInstance(player, player.user!.id, fixture, "ACH-RECOVER-1");
    const definition = await runtime.DB.prepare(
      "SELECT id, version, reward_json FROM fb_achievement_definitions WHERE key = 'first-card'",
    ).first<{ id: string; version: number; reward_json: string }>();
    expect(definition).toBeTruthy();
    const before = await walletBalance(player, player.user!.id);
    await runtime.DB.prepare(
      `INSERT INTO fb_achievement_unlocks
        (id, tenant_id, user_id, achievement_id, achievement_version, earned_at, reward_state, reward_amount, notification_state, created_at)
       VALUES ('unl_recovery_pending', ?, ?, ?, ?, ?, 'pending', 160, 'pending', ?)`,
    ).bind(player.tenant.id, player.user!.id, definition!.id, definition!.version, nowIso(), nowIso()).run();
    await evaluateAchievements(player, { userId: player.user!.id });
    expect(await walletBalance(player, player.user!.id)).toBe(before + 160);
    const unlock = await runtime.DB.prepare(
      "SELECT reward_state, reward_ledger_id, notification_state FROM fb_achievement_unlocks WHERE id = 'unl_recovery_pending'",
    ).first<{ reward_state: string; reward_ledger_id: string | null; notification_state: string }>();
    expect(unlock?.reward_state).toBe("granted");
    expect(unlock?.reward_ledger_id).toBeTruthy();
    const ledger = await runtime.DB.prepare(
      "SELECT COUNT(*) AS count FROM fb_ledger_entries WHERE tenant_id = ? AND user_id = ? AND reference_type = 'achievement'",
    ).bind(player.tenant.id, player.user!.id).first<{ count: number }>();
    expect(ledger?.count).toBe(1);
    const outbox = await runtime.DB.prepare(
      "SELECT COUNT(*) AS count FROM fb_outbox WHERE tenant_id = ? AND topic = 'achievement.earned' AND json_extract(payload_json, '$.unlock_id') = 'unl_recovery_pending'",
    ).bind(player.tenant.id).first<{ count: number }>();
    expect(outbox?.count).toBe(1);

    // Simulate a crash after the ledger commit but before the unlock state was
    // updated. The retry must reconcile to the existing ledger row, not pay again.
    await runtime.DB.prepare(
      "UPDATE fb_achievement_unlocks SET reward_state = 'pending', reward_ledger_id = NULL WHERE id = 'unl_recovery_pending'",
    ).run();
    await evaluateAchievements(player, { userId: player.user!.id });
    expect(await walletBalance(player, player.user!.id)).toBe(before + 160);
    const reconciled = await runtime.DB.prepare(
      "SELECT reward_state, reward_ledger_id FROM fb_achievement_unlocks WHERE id = 'unl_recovery_pending'",
    ).first<{ reward_state: string; reward_ledger_id: string | null }>();
    expect(reconciled?.reward_state).toBe("granted");
    expect(reconciled?.reward_ledger_id).toBeTruthy();
    const ledgerAgain = await runtime.DB.prepare(
      "SELECT COUNT(*) AS count FROM fb_ledger_entries WHERE tenant_id = ? AND user_id = ? AND reference_type = 'achievement'",
    ).bind(player.tenant.id, player.user!.id).first<{ count: number }>();
    expect(ledgerAgain?.count).toBe(1);
  });

  it("completes the four core finishes for one subject", async () => {
    await bootstrap();
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const fixture = await fixturePool(player);
    const taxonomy = await runtime.DB.prepare("SELECT id, key FROM fb_materials WHERE tenant_id = ?").bind(player.tenant.id).all<{ id: string; key: string }>();
    const effects = await runtime.DB.prepare("SELECT id, key FROM fb_effects WHERE tenant_id = ?").bind(player.tenant.id).all<{ id: string; key: string }>();
    const none = effects.results.find((effect) => effect.key === "none")!;
    const holo = effects.results.find((effect) => effect.key === "holographic")!;
    const materials = new Map(taxonomy.results.map((material) => [material.key, material.id]));
    await makeInstance(player, player.user!.id, fixture, "ACH-SET-plain");
    const specs = [
      ["silver", none.id],
      ["gold", none.id],
      ["diamond", holo.id],
    ] as const;
    for (const [material, effect] of specs) {
      const variantId = newId("var");
      await runtime.DB.prepare(
        "INSERT INTO fb_variants (id, tenant_id, card_id, edition_id, material_id, effect_id, name, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'published', ?)",
      ).bind(variantId, player.tenant.id, fixture.cardId, fixture.editionId, materials.get(material)!, effect, material, nowIso()).run();
      await makeInstance(player, player.user!.id, { cardId: fixture.cardId, variantId }, `ACH-SET-${material}`);
    }
    await evaluateAchievements(player, { userId: player.user!.id });
    const view = (await listAchievements(player, player.user!.id)).find((item) => item.key === "core-finish-set");
    expect(view?.state).toBe("earned");
    const holoUnlock = (await listAchievements(player, player.user!.id)).find((item) => item.key === "first-holographic");
    expect(holoUnlock?.state).toBe("earned");
  });

  it("keeps a versioned collection achievement earned after the roster grows", async () => {
    await bootstrap();
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const fixture = await fixturePool(player);
    const achievementId = "ach_test_collection_v1";
    await runtime.DB.prepare(
      `INSERT INTO fb_achievement_definitions
        (id, scope, tenant_id, key, version, name, description, criteria_json, reward_json, visibility, art_key, category, sort, status, created_by, created_at, updated_at)
       VALUES (?, 'bot', ?, 'test-collection-one', 1, 'One of one', 'Collect the first card in this test collection.', ?, '{"foil":100}', 'member', 'medal-test', 'collection', 5, 'active', 'test', ?, ?)`,
    ).bind(
      achievementId,
      player.tenant.id,
      JSON.stringify({ type: "collection_unique", collection_id: "col_test_public", target: 1 }),
      nowIso(),
      nowIso(),
    ).run();
    await makeInstance(player, player.user!.id, fixture, "ACH-VERSION-1");
    await evaluateAchievements(player, { userId: player.user!.id });
    const first = (await listAchievements(player, player.user!.id)).find((item) => item.id === achievementId);
    expect(first?.state).toBe("earned");
    // A later card in the same collection must not revoke the completed rule.
    const laterCard = `crd_${await sha256Hex("later-card")}`.slice(0, 30);
    await runtime.DB.prepare(
      "INSERT INTO fb_card_definitions (id, tenant_id, logical_id, slug, name, description, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, 'Later Card', 'A later addition.', 'published', ?, ?, 1)",
    ).bind(laterCard, player.tenant.id, "test:later", "later-card", nowIso(), nowIso()).run();
    await runtime.DB.prepare("INSERT INTO fb_collection_cards (collection_id, card_id, tenant_id, sort, added_by, added_at) VALUES ('col_test_public', ?, ?, 1, 'test', ?)").bind(laterCard, player.tenant.id, nowIso()).run();
    await evaluateAchievements(player, { userId: player.user!.id });
    const again = (await listAchievements(player, player.user!.id)).find((item) => item.id === achievementId);
    expect(again?.state).toBe("earned");
  });
});
