import { describe, expect, it } from "vitest";
import { bootstrap, ctxFor, fixturePool, makeInstance, runtime } from "./helpers";
import { evaluateAchievements, listAchievements } from "../../src/server/modules/achievements";
import { nowIso } from "../../src/server/db";

async function addFinishVariant(cardId: string, editionId: string, tenantId: string, materialKey: string, effectKey: string, name: string) {
  const material = await runtime.DB.prepare("SELECT id FROM fb_materials WHERE tenant_id = ? AND key = ?").bind(tenantId, materialKey).first<{ id: string }>();
  const effect = await runtime.DB.prepare("SELECT id FROM fb_effects WHERE tenant_id = ? AND key = ?").bind(tenantId, effectKey).first<{ id: string }>();
  if (!material || !effect) throw new Error(`Missing ${materialKey}/${effectKey}`);
  const id = `var_mastery_${materialKey}_${effectKey}`;
  await runtime.DB.prepare(
    "INSERT INTO fb_variants (id, tenant_id, card_id, edition_id, material_id, effect_id, name, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'published', ?)",
  ).bind(id, tenantId, cardId, editionId, material.id, effect.id, name, nowIso()).run();
  return id;
}

describe("finish mastery achievements", () => {
  it("counts one subject per finish, rejects duplicate-subject shortcuts and uses a frozen roster", async () => {
    await bootstrap();
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const fixture = await fixturePool(player);
    const tenantId = player.tenant.id;
    const plain = fixture.variantId;
    const silver = await addFinishVariant(fixture.cardId, fixture.editionId, tenantId, "silver", "none", "Silver");
    const gold = await addFinishVariant(fixture.cardId, fixture.editionId, tenantId, "gold", "none", "Gold");
    const holo = await addFinishVariant(fixture.cardId, fixture.editionId, tenantId, "diamond", "none", "Holographic");
    await makeInstance(player, player.user!.id, { cardId: fixture.cardId, variantId: plain }, "MASTERY-PLAIN");
    await makeInstance(player, player.user!.id, { cardId: fixture.cardId, variantId: silver }, "MASTERY-SILVER");
    await makeInstance(player, player.user!.id, { cardId: fixture.cardId, variantId: gold }, "MASTERY-GOLD");
    await makeInstance(player, player.user!.id, { cardId: fixture.cardId, variantId: gold }, "MASTERY-GOLD-DUP");
    await makeInstance(player, player.user!.id, { cardId: fixture.cardId, variantId: holo }, "MASTERY-HOLO");

    const now = nowIso();
    await runtime.DB.prepare(
      `INSERT INTO fb_achievement_definitions
        (id, scope, tenant_id, key, version, name, description, criteria_json, reward_json, visibility, art_key, category, sort, status, created_by, created_at, updated_at)
       VALUES ('ach_test_gold_mastery', 'platform', NULL, 'test-gold-mastery', 1, 'Test Gold run',
         'Every subject in the frozen test roster in Gold.', ?, '{"foil":0}', 'member', 'medal-gold', 'finish', 9000, 'active', 'test', ?, ?)`,
    )
      .bind(
        JSON.stringify({ type: "collection_finish_set", collection_id: "col_test_public", finish: "gold", roster_card_ids: [fixture.cardId], target: 1 }),
        now,
        now,
      )
      .run();
    await runtime.DB.prepare(
      `INSERT INTO fb_achievement_definitions
        (id, scope, tenant_id, key, version, name, description, criteria_json, reward_json, visibility, art_key, category, sort, status, created_by, created_at, updated_at)
       VALUES ('ach_test_core_mastery', 'platform', NULL, 'test-core-mastery', 1, 'Test Core mastery',
         'Every subject in the frozen test roster in all four finishes.', ?, '{"foil":0}', 'member', 'medal-collection', 'collection', 9001, 'active', 'test', ?, ?)`,
    )
      .bind(
        JSON.stringify({ type: "collection_core_set", collection_id: "col_test_public", roster_card_ids: [fixture.cardId], target: 1 }),
        now,
        now,
      )
      .run();

    const evaluated = await evaluateAchievements(player, { userId: player.user!.id });
    expect(evaluated.unlocked.some((item) => item.key === "test-gold-mastery")).toBe(true);
    expect(evaluated.unlocked.some((item) => item.key === "test-core-mastery")).toBe(true);
    const views = await listAchievements(player, player.user!.id);
    const goldProgress = views.find((item) => item.key === "test-gold-mastery");
    expect(goldProgress?.progress).toBe(1);
    expect(goldProgress?.target).toBe(1);

    // A later roster addition must not alter this definition's target.
    await runtime.DB.prepare("UPDATE fb_collection_cards SET card_id = card_id WHERE collection_id = 'col_test_public'").run();
    const after = await listAchievements(player, player.user!.id);
    expect(after.find((item) => item.key === "test-gold-mastery")?.target).toBe(1);
  });
});
