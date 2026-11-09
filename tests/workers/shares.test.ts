import { describe, expect, it } from "vitest";
import { createShareLink, revokeShareLink, updatePreferences } from "../../src/server/modules/economy";
import { bootstrap, ctxFor, fixturePool, makeInstance, runtime } from "./helpers";

describe("deliberate sharing", () => {
  it("requires explicit sharing consent and re-checks the captured audience", async () => {
    await bootstrap();
    const base = await ctxFor("cabinet", "owner@foilbury.local");
    const now = new Date().toISOString(), session = `share-session-${crypto.randomUUID()}`;
    await runtime.DB.prepare("INSERT INTO fb_sessions (id,token_hash,user_id,tenant_id,csrf_token,created_at,expires_at,last_seen_at,assurance,auth_time) VALUES (?,?,?,?, 'test',?,?,?,'password',?)")
      .bind(session,session,base.user!.id,base.tenant.id,now,new Date(Date.now()+3600000).toISOString(),now,now).run();
    const owner = {...base,sessionId:session,sessionAssurance:'password' as const,sessionAuthTime:now};
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

  it("retires new whole-cabinet links while offering bounded snapshots", async () => {
    await bootstrap();
    const base = await ctxFor("cabinet", "owner@foilbury.local");
    const now = new Date().toISOString(), session = `share-session-${crypto.randomUUID()}`;
    await runtime.DB.prepare("INSERT INTO fb_sessions (id,token_hash,user_id,tenant_id,csrf_token,created_at,expires_at,last_seen_at,assurance,auth_time) VALUES (?,?,?,?, 'test',?,?,?,'password',?)")
      .bind(session,session,base.user!.id,base.tenant.id,now,new Date(Date.now()+3600000).toISOString(),now,now).run();
    const owner = {...base,sessionId:session,sessionAssurance:'password' as const,sessionAuthTime:now};
    await updatePreferences(owner, { sharingEnabled: true });
    await expect(createShareLink(owner, { kind: "cabinet" })).rejects.toMatchObject({
      code: "share_kind_retired",
    });
    expect((await createShareLink(owner, { kind: "profile", expiresInDays: 7 })).kind).toBe("profile");
    const wishlist = await createShareLink(owner, { kind: "wishlist", expiresInDays: 7 });
    expect(wishlist.kind).toBe("wishlist");
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
