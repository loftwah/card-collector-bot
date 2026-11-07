import { describe, expect, it } from "vitest";
import { createShareLink, revokeShareLink, updatePreferences } from "../../src/server/modules/economy";
import { bootstrap, ctxFor, fixturePool, makeInstance, runtime } from "./helpers";
import { nowIso } from "../../src/server/db";

describe("deliberate sharing", () => {
  it("requires explicit sharing consent and re-checks the captured audience", async () => {
    await bootstrap();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const fixture = await fixturePool(owner);
    const instanceId = await makeInstance(owner, owner.user!.id, fixture, "SHARE-CARD-1");
    await expect(createShareLink(owner, { kind: "card", targetId: instanceId })).rejects.toMatchObject({ code: "sharing_disabled" });
    await updatePreferences(owner, { sharingEnabled: true });
    const share = await createShareLink(owner, { kind: "card", targetId: instanceId, expiresInDays: 7 });
    expect(share.kind).toBe("card");
    expect(share.audience).toBe("public");
    expect(share.preview.card_name).toBeTruthy();
    expect(JSON.stringify(share.preview)).not.toMatch(/email|balance|ledger|account_id/i);
    const revoked = await revokeShareLink(owner, share.id);
    expect(revoked.status).toBe("revoked");
  });

  it("retires new whole-cabinet links without invalidating safe existing snapshots", async () => {
    await bootstrap();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    await updatePreferences(owner, { sharingEnabled: true });
    await expect(createShareLink(owner, { kind: "cabinet" })).rejects.toMatchObject({
      code: "share_kind_retired",
    });
    const profile = await createShareLink(owner, { kind: "profile", expiresInDays: 7 });
    expect(profile.kind).toBe("profile");
  });

  it("captures the chosen profile look and note without private identifiers", async () => {
    await bootstrap();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    await updatePreferences(owner, {
      sharingEnabled: true,
      profileLook: "night",
      profileBio: "Quiet shelves, loud cards.",
    });
    const profile = await createShareLink(owner, { kind: "profile", expiresInDays: 7 });
    expect(profile.preview.profile_look).toBe("night");
    expect(profile.preview.profile_bio).toBe("Quiet shelves, loud cards.");
    expect(JSON.stringify(profile.preview)).not.toMatch(/email|balance|ledger|account_id/i);
  });

  it("captures the saved composition, exact featured copy and shelf order without private identifiers", async () => {
    await bootstrap();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const fixture = await fixturePool(owner);
    const first = await makeInstance(owner, owner.user!.id, fixture, "SHARE-FEATURED");
    const second = await makeInstance(owner, owner.user!.id, fixture, "SHARE-SHELF");
    const now = nowIso();
    await runtime.DB.batch([
      runtime.DB.prepare("UPDATE fb_collections SET logo_url = '/media/logo.png', banner_url = '/media/banner.png' WHERE id = 'col_test_public'"),
      runtime.DB.prepare("UPDATE fb_card_instances SET favourite = 1 WHERE id IN (?, ?)").bind(first, second),
      runtime.DB
        .prepare(
          `INSERT INTO fb_achievement_definitions
          (id, scope, key, version, name, description, criteria_json, reward_json, visibility, art_key, category, sort, status, created_by, created_at, updated_at)
         VALUES ('ach_share_profile', 'platform', 'share-profile', 1, 'Shared badge', 'Earned for the share fixture.', '{}', '{}', 'member', 'medal-first', 'milestone', 0, 'active', 'test', ?, ?)`,
        )
        .bind(now, now),
      runtime.DB
        .prepare(
          `INSERT INTO fb_achievement_unlocks
          (id, tenant_id, user_id, achievement_id, achievement_version, earned_at, reward_state, reward_amount, notification_state, created_at)
         VALUES ('unl_share_profile', ?, ?, 'ach_share_profile', 1, ?, 'none', 0, 'suppressed', ?)`,
        )
        .bind(owner.tenant.id, owner.user!.id, now, now),
    ]);
    await updatePreferences(owner, {
      sharingEnabled: true,
      profileLook: "night",
      profileBio: "Quiet shelves, loud cards.",
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
        badgeIds: ["ach_share_profile"],
      },
    });
    const profile = await createShareLink(owner, { kind: "profile", expiresInDays: 7 });
    expect(profile.preview.presentation).toBeTruthy();
    expect(profile.preview.presentation.featured.card_name).toBe("Test One");
    expect(profile.preview.presentation.featured.serial).toBeUndefined();
    expect(JSON.stringify(profile.preview)).not.toMatch(/SHARE-FEATURED|"serial"/i);
    expect(profile.preview.presentation.favourites.map((card: { card_name: string }) => card.card_name)).toEqual(["Test One", "Test One"]);
    expect(profile.preview.presentation.badges.map((badge: { name: string }) => badge.name)).toEqual(["Shared badge"]);
    expect(profile.preview.presentation.frame).toBe("signal");
    expect(JSON.stringify(profile.preview)).not.toMatch(/email|balance|ledger|account_id/i);
  });

  it("does not let a player share another member's copy", async () => {
    await bootstrap();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const fixture = await fixturePool(owner);
    const ownerInstance = await makeInstance(owner, owner.user!.id, fixture, "SHARE-OWNER-ONLY");
    await updatePreferences(player, { sharingEnabled: true });
    await expect(createShareLink(player, { kind: "card", targetId: ownerInstance })).rejects.toMatchObject({ code: "instance_not_found" });
  });
});
