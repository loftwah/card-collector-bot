import { describe, expect, it } from "vitest";
import { createShareLink, revokeShareLink, updatePreferences } from "../../src/server/modules/economy";
import { bootstrap, ctxFor, fixturePool, makeInstance } from "./helpers";

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
