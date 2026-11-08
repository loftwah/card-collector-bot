import { beforeEach, describe, expect, it } from "vitest";
import { bootstrap, ctxFor, fixturePool, makeInstance, runtime } from "./helpers";
import { createShareLink, revokeShareLink, updatePreferences } from "../../src/server/modules/economy";
import { resolveShareView } from "../../src/server/modules/shares";
import type { Ctx } from "../../src/server/context";
import { nowIso } from "../../src/server/db";
import { createUser, addMembership } from "../../src/server/modules/identity";
import { addCollectionCards, createCollection } from "../../src/server/modules/collections";

function anonymous(ctx: Ctx): Ctx {
  return {
    ...ctx,
    user: null,
    actor: { type: "system", id: "anonymous", representedUserId: null, label: "Anonymous" },
    csrfToken: "",
  };
}

describe("share privacy and lifecycle policy", () => {
  beforeEach(async () => {
    await bootstrap();
  });

  it("never exposes a member-only share or serial to an anonymous or cross-Bot viewer", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await updatePreferences(owner, { sharingEnabled: true });
    const profile = await createShareLink(owner, { kind: "profile", expiresInDays: 7 });

    const anon = await resolveShareView(anonymous(owner), profile.token);
    expect(anon.active).toBe(true);
    expect(anon.publicView).toBe(false);
    expect(anon.visible).toBe(false);

    const member = await resolveShareView(player, profile.token);
    expect(member.visible).toBe(true);
    expect(JSON.stringify(member.payload)).not.toMatch(/email|wallet|ledger|account_id|serial/i);

    const harbourUser = await createUser(runtime.DB, { email: "harbour-viewer@example.test", displayName: "Harbour Viewer", password: "a-long-test-password" });
    const harbour = await runtime.DB.prepare("SELECT id, slug, name FROM fb_tenants WHERE slug = 'harbour'").first<{ id: string; slug: string; name: string }>();
    await addMembership(runtime.DB, harbour!.id, harbourUser.id, "player");
    const crossBot: Ctx = {
      ...owner,
      user: {
        id: harbourUser.id,
        email: harbourUser.email,
        displayName: "Harbour Viewer",
        role: "player",
        platformAdmin: false,
        emailVerified: true,
        capabilities: [],
      },
      actor: { type: "user", id: harbourUser.id, representedUserId: harbourUser.id, label: "Harbour Viewer" },
    };
    const cross = await resolveShareView(crossBot, profile.token);
    expect(cross.visible).toBe(false);
  });

  it("omits the exact featured serial from a profile share snapshot", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const fixture = await fixturePool(owner);
    const instance = await makeInstance(owner, owner.user!.id, fixture, "FB-PRIVACY-PROFILE");
    await runtime.DB.prepare("UPDATE fb_card_instances SET favourite = 1 WHERE id = ?")
      .bind(instance)
      .run();
    await updatePreferences(owner, { sharingEnabled: true });
    const profile = await createShareLink(owner, { kind: "profile", expiresInDays: 7 });
    const member = await resolveShareView(player, profile.token);
    expect(member.visible).toBe(true);
    expect(JSON.stringify(member.payload)).not.toContain("FB-PRIVACY-PROFILE");
    expect(JSON.stringify(member.payload)).not.toMatch(/"serial"/i);
    expect(member.payload.presentation?.featured?.card_name).toBe("Test One");
  });

  it("keeps a public snapshot safe while refusing private identifiers", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const fixture = await fixturePool(owner);
    const instanceId = await makeInstance(owner, owner.user!.id, fixture, "SHARE-PUBLIC-1");
    await updatePreferences(owner, { sharingEnabled: true });
    const share = await createShareLink(owner, { kind: "card", targetId: instanceId, expiresInDays: 7 });
    expect(share.audience).toBe("public");

    const anon = await resolveShareView(anonymous(owner), share.token);
    expect(anon.active).toBe(true);
    expect(anon.publicView).toBe(true);
    expect(anon.visible).toBe(true);
    // The serial exists in the private record, but is never shown to a public
    // viewer; the page renders it only when showSerial is true.
    expect(anon.showSerial).toBe(false);
    const serial = String(anon.payload.serial);
    expect(serial.length).toBeGreaterThan(0);
    const ownerView = await resolveShareView(owner, share.token);
    expect(ownerView.showSerial).toBe(true);
  });

  it("inherits the most restrictive collection when a card belongs to a public and a members collection", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const fixture = await fixturePool(owner);
    const instanceId = await makeInstance(owner, owner.user!.id, fixture, "SHARE-MULTI-COLLECTION");
    const second = await createCollection(owner, {
      name: "Second Members World",
      scope: "global",
      status: "published",
      viewAudience: "members",
    });
    await addCollectionCards(owner, second.id, [fixture.cardId]);
    await updatePreferences(owner, { sharingEnabled: true });
    const share = await createShareLink(owner, { kind: "card", targetId: instanceId, expiresInDays: 7 });
    expect(share.audience).toBe("member");
    expect(share.preview.collection_id).toBe(second.id);
    const anon = await resolveShareView(anonymous(owner), share.token);
    expect(anon.publicView).toBe(false);
    expect(anon.visible).toBe(false);
    expect(JSON.stringify(anon.payload)).not.toContain("SHARE-MULTI-COLLECTION");
    const member = await resolveShareView(player, share.token);
    expect(member.visible).toBe(true);
  });

  it("closes a public card link when the card is later filed in a restricted collection", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const fixture = await fixturePool(owner);
    const instanceId = await makeInstance(owner, owner.user!.id, fixture, "SHARE-LATE-RESTRICTION");
    await updatePreferences(owner, { sharingEnabled: true });
    const share = await createShareLink(owner, { kind: "card", targetId: instanceId, expiresInDays: 7 });
    expect((await resolveShareView(anonymous(owner), share.token)).publicView).toBe(true);
    const restricted = await createCollection(owner, {
      name: "Later Restricted World",
      scope: "global",
      status: "published",
      viewAudience: "private",
    });
    await addCollectionCards(owner, restricted.id, [fixture.cardId]);
    const closed = await resolveShareView(anonymous(owner), share.token);
    expect(closed.active).toBe(true);
    expect(closed.publicView).toBe(false);
    expect(closed.visible).toBe(false);
  });

  it("denies a share when the owner row has revoked_at even if status is still active", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    await updatePreferences(owner, { sharingEnabled: true });
    const share = await createShareLink(owner, { kind: "profile", expiresInDays: 7 });
    await runtime.DB
      .prepare("UPDATE fb_memberships SET revoked_at = ? WHERE tenant_id = ? AND user_id = ?")
      .bind(nowIso(), owner.tenant.id, owner.user!.id)
      .run();
    const denied = await resolveShareView(owner, share.token);
    expect(denied.active).toBe(false);
    expect(denied.visible).toBe(false);
    expect(JSON.stringify(denied.payload)).toBe("{}");
  });

  it("does not let a player create a collection share for a collection they cannot view", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const privateCollection = await createCollection(owner, {
      name: "Owner Only World",
      scope: "global",
      status: "published",
      viewAudience: "private",
    });
    await updatePreferences(player, { sharingEnabled: true });
    await expect(
      createShareLink(player, { kind: "collection", targetId: privateCollection.id, expiresInDays: 7 }),
    ).rejects.toMatchObject({ code: "collection_not_found" });
  });

  it("closes a public link when the collection audience changes", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const fixture = await fixturePool(owner);
    const instanceId = await makeInstance(owner, owner.user!.id, fixture, "SHARE-AUDIENCE-1");
    await updatePreferences(owner, { sharingEnabled: true });
    const share = await createShareLink(owner, { kind: "card", targetId: instanceId, expiresInDays: 7 });
    expect((await resolveShareView(anonymous(owner), share.token)).publicView).toBe(true);
    await runtime.DB.prepare("UPDATE fb_collections SET view_audience = 'members', public_approved_at = NULL WHERE id = 'col_test_public'").run();
    const closed = await resolveShareView(anonymous(owner), share.token);
    expect(closed.active).toBe(true);
    expect(closed.publicView).toBe(false);
    expect(closed.visible).toBe(false);
    // A member still sees the member-audience snapshot.
    const player = await ctxFor("cabinet", "player@foilbury.local");
    expect((await resolveShareView(player, share.token)).visible).toBe(true);
  });

  it("stops resolving on revocation, expiry or the owner's revoked membership", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    await updatePreferences(owner, { sharingEnabled: true });
    const revoked = await createShareLink(owner, { kind: "profile", expiresInDays: 7 });
    await revokeShareLink(owner, revoked.id);
    expect((await resolveShareView(owner, revoked.token)).active).toBe(false);

    const expired = await createShareLink(owner, { kind: "profile", expiresInDays: 1 });
    await runtime.DB.prepare("UPDATE fb_share_links SET expires_at = ? WHERE id = ?").bind(new Date(Date.now() - 1000).toISOString(), expired.id).run();
    expect((await resolveShareView(owner, expired.token)).active).toBe(false);

    const ownerRevoked = await createShareLink(owner, { kind: "profile", expiresInDays: 7 });
    await runtime.DB
      .prepare("UPDATE fb_memberships SET status = 'revoked', revoked_at = ? WHERE tenant_id = ? AND user_id = ?")
      .bind(nowIso(), owner.tenant.id, owner.user!.id)
      .run();
    // Even the owner's own browser cannot keep the snapshot alive once they are
    // no longer an active member of the Bot.
    expect((await resolveShareView(owner, ownerRevoked.token)).active).toBe(false);
  });

  it("does not expose a member share to a viewer from another Bot", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    await updatePreferences(owner, { sharingEnabled: true });
    const share = await createShareLink(owner, { kind: "profile", expiresInDays: 7 });
    const harbour = await ctxFor("harbour", "harbour.owner@foilbury.test");
    const cross = await resolveShareView(harbour, share.token);
    // The token is recognised (so a legitimate recipient sees a sign-in/access
    // gate rather than a misleading 404), but the snapshot itself is withheld.
    expect(cross.visible).toBe(false);
    expect(cross.publicView).toBe(false);
    expect(cross.payload).toEqual({});
    expect(cross.showSerial).toBe(false);
  });
});
