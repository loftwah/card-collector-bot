import { beforeEach, describe, expect, it } from "vitest";
import { bootstrap, ctxFor, fixturePool, makeInstance, runtime, walletBalance } from "./helpers";
import { executeDraw, getPoolPreview, listEligiblePools } from "../../src/server/modules/pools";
import { getPreferences, updatePreferences, type ProfileLook } from "../../src/server/modules/economy";
import {
  getProfilePresentationOptions,
  resolveProfilePresentation,
} from "../../src/server/modules/profile-presentation";
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

  it("derives the selectable pool list from the same effective eligibility as preview and commit", async () => {
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await fixturePool(player);
    expect((await listEligiblePools(player)).map((preview) => preview.pool.slug)).toEqual([
      "test-pool",
    ]);

    await updatePreferences(player, { hiddenCollectionIds: ["col_test_public"] });
    expect(await listEligiblePools(player)).toEqual([]);

    await updatePreferences(player, { hiddenCollectionIds: [] });
    await runtime.DB.prepare(
      "UPDATE fb_bot_collections SET enabled = 0 WHERE collection_id = 'col_test_public'",
    ).run();
    expect(await listEligiblePools(player)).toEqual([]);

    await runtime.DB.prepare(
      "UPDATE fb_bot_collections SET enabled = 1 WHERE collection_id = 'col_test_public'",
    ).run();
    await runtime.DB.prepare("UPDATE fb_pools SET status = 'draft' WHERE slug = 'test-pool'").run();
    expect(await listEligiblePools(player)).toEqual([]);
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

  it("persists a chosen profile look and short collector note without touching draw eligibility", async () => {
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await fixturePool(player);
    const initial = await getPreferences(player);
    expect(initial.profile_look).toBe("quiet");
    expect(initial.profile_bio).toBe("");
    const saved = await updatePreferences(player, {
      profileLook: "night",
      profileBio: "  Deep-sea cards and quiet shelves.  ",
    });
    expect(saved.profile_look).toBe("night");
    expect(saved.profile_bio).toBe("Deep-sea cards and quiet shelves.");
    expect(saved.hidden_collection_ids).toEqual(initial.hidden_collection_ids);
    const reread = await getPreferences(player);
    expect(reread.profile_look).toBe("night");
    expect(reread.profile_bio).toBe("Deep-sea cards and quiet shelves.");
    await expect(updatePreferences(player, { profileLook: "neon" as ProfileLook })).rejects.toMatchObject({
      code: "profile_look_invalid",
    });
    await expect(updatePreferences(player, { profileBio: "x".repeat(161) })).rejects.toMatchObject({
      code: "profile_bio_too_long",
    });
  });

  it("persists independent profile components, exact copy, shelf order and badges with a version fence", async () => {
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const fixture = await fixturePool(player);
    const first = await makeInstance(player, player.user!.id, fixture, "PROFILE-FIRST");
    const second = await makeInstance(player, player.user!.id, fixture, "PROFILE-SECOND");
    const now = nowIso();
    await runtime.DB.batch([
      runtime.DB.prepare("UPDATE fb_collections SET logo_url = '/media/logo.png', banner_url = '/media/banner.png' WHERE id = 'col_test_public'"),
      runtime.DB.prepare("UPDATE fb_card_instances SET favourite = 1 WHERE id IN (?, ?)").bind(first, second),
      runtime.DB
        .prepare(
          `INSERT INTO fb_achievement_definitions
          (id, scope, key, version, name, description, criteria_json, reward_json, visibility, art_key, category, sort, status, created_by, created_at, updated_at)
         VALUES ('ach_profile_test', 'platform', 'profile-test', 1, 'Profile badge', 'Earned for the profile fixture.', '{}', '{}', 'member', 'medal-first', 'milestone', 0, 'active', 'test', ?, ?)`,
        )
        .bind(now, now),
      runtime.DB
        .prepare(
          `INSERT INTO fb_achievement_unlocks
          (id, tenant_id, user_id, achievement_id, achievement_version, earned_at, reward_state, reward_amount, notification_state, created_at)
         VALUES ('unl_profile_test', ?, ?, 'ach_profile_test', 1, ?, 'none', 0, 'suppressed', ?)`,
        )
        .bind(player.tenant.id, player.user!.id, now, now),
    ]);

    const options = await getProfilePresentationOptions(player);
    expect(options.collections.some((collection) => collection.id === "col_test_public")).toBe(true);
    expect(options.badges.map((badge) => badge.id)).toContain("ach_profile_test");

    const saved = await updatePreferences(player, {
      profileLook: "night",
      profilePresentationVersion: 1,
      profilePresentation: {
        portrait: "collection:col_test_public",
        banner: "collection:col_test_public",
        frame: "signal",
        avatarDecoration: "ring",
        nameTreatment: "wide",
        effect: "sheen",
        featuredInstanceId: first,
        favouriteInstanceIds: [second, first],
        badgeIds: ["ach_profile_test"],
      },
    });
    expect(saved.profile_presentation_version).toBe(2);
    expect(saved.profile_presentation.featuredInstanceId).toBe(first);
    expect(saved.profile_presentation.favouriteInstanceIds).toEqual([second, first]);
    expect(saved.profile_presentation.badgeIds).toEqual(["ach_profile_test"]);

    const reread = await getPreferences(player);
    expect(reread.profile_presentation.frame).toBe("signal");
    expect(reread.profile_presentation.avatarDecoration).toBe("ring");
    expect(reread.profile_presentation.nameTreatment).toBe("wide");
    expect(reread.profile_presentation.effect).toBe("sheen");

    const resolved = resolveProfilePresentation(reread.profile_presentation, options, reread.profile_presentation_version);
    expect(resolved.featured?.id).toBe(first);
    expect(resolved.featured?.serial).toBe("PROFILE-FIRST");
    expect(resolved.favourites.map((copy) => copy.id)).toEqual([second, first]);
    expect(resolved.badges.map((badge) => badge.id)).toEqual(["ach_profile_test"]);
    expect(resolved.fallbackNotes).toEqual([]);

    await expect(
      updatePreferences(player, {
        profilePresentationVersion: 1,
        profilePresentation: reread.profile_presentation,
      }),
    ).rejects.toMatchObject({ code: "profile_presentation_stale" });

    await expect(
      updatePreferences(player, {
        profilePresentationVersion: 2,
        profilePresentation: { ...reread.profile_presentation, featuredInstanceId: "ins_missing" },
      }),
    ).rejects.toMatchObject({ code: "profile_featured_unavailable" });

    await expect(
      updatePreferences(player, {
        profilePresentationVersion: 2,
        profilePresentation: { ...reread.profile_presentation, badgeIds: ["ach_missing"] },
      }),
    ).rejects.toMatchObject({ code: "profile_badge_unavailable" });

    await runtime.DB.prepare("UPDATE fb_card_instances SET status = 'traded', favourite = 0 WHERE id = ?").bind(first).run();
    const afterTrade = await getProfilePresentationOptions(player);
    const fallback = resolveProfilePresentation(reread.profile_presentation, afterTrade, 2);
    expect(fallback.featured?.id).toBe(second);
    expect(fallback.selection.favouriteInstanceIds).toContain(first);
    expect(fallback.favourites.map((copy) => copy.id)).toEqual([second]);
    expect(fallback.fallbackNotes.join(" ")).toContain("featured copy");
  });

  it("keeps two collectors' compositions independent", async () => {
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const fixture = await fixturePool(player);
    const playerCopy = await makeInstance(player, player.user!.id, fixture, "PLAYER-COPY");
    const ownerCopy = await makeInstance(owner, owner.user!.id, fixture, "OWNER-COPY");
    await runtime.DB.prepare("UPDATE fb_collections SET logo_url = '/media/logo.png' WHERE id = 'col_test_public'").run();
    await runtime.DB.prepare("UPDATE fb_card_instances SET favourite = 1 WHERE id IN (?, ?)").bind(playerCopy, ownerCopy).run();

    await updatePreferences(player, {
      profilePresentationVersion: 1,
      profilePresentation: {
        portrait: "mascot",
        banner: "none",
        frame: "double",
        avatarDecoration: "stamp",
        nameTreatment: "boxed",
        effect: "edge",
        featuredInstanceId: playerCopy,
        favouriteInstanceIds: [playerCopy],
        badgeIds: [],
      },
    });
    const ownerBefore = await getPreferences(owner);
    expect(ownerBefore.profile_presentation_version).toBe(1);
    expect(ownerBefore.profile_presentation.frame).toBe("none");
    expect(ownerBefore.profile_presentation.featuredInstanceId).toBeNull();

    await updatePreferences(owner, {
      profilePresentationVersion: 1,
      profilePresentation: {
        portrait: "mascot",
        banner: "none",
        frame: "hairline",
        avatarDecoration: "none",
        nameTreatment: "plain",
        effect: "none",
        featuredInstanceId: ownerCopy,
        favouriteInstanceIds: [ownerCopy],
        badgeIds: [],
      },
    });
    const playerAfter = await getPreferences(player);
    expect(playerAfter.profile_presentation.frame).toBe("double");
    expect(playerAfter.profile_presentation.featuredInstanceId).toBe(playerCopy);
    expect(playerAfter.profile_presentation.badgeIds).toEqual([]);
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
