import { describe, expect, it } from "vitest";
import { bootstrap, ctxFor, fixturePool, makeInstance, runtime, tenant } from "./helpers";
import { createUser, addMembership } from "../../src/server/modules/identity";
import { createCollection, addCollectionCards } from "../../src/server/modules/collections";
import { getCard, listCards } from "../../src/server/modules/catalogue";
import { effectiveCardAudience, canViewCard, viewerAccess } from "../../src/server/modules/visibility";
import type { Ctx } from "../../src/server/context";
import { readConfig } from "../../src/server/config";

async function strongOwner(): Promise<Ctx> {
  const owner=await ctxFor('cabinet','owner@foilbury.local');const now=new Date().toISOString(),id=`visibility-session-${crypto.randomUUID()}`;
  await runtime.DB.prepare("INSERT INTO fb_sessions (id,token_hash,user_id,tenant_id,csrf_token,created_at,expires_at,last_seen_at,assurance,auth_time) VALUES (?,?,?,?,'test',?,?,?,'passkey',?)").bind(id,id,owner.user!.id,owner.tenant.id,now,new Date(Date.now()+60000).toISOString(),now,now).run();
  return {...owner,sessionId:id,sessionAssurance:'passkey',sessionAuthTime:now};
}

function anonymous(ctx: Ctx): Ctx {
  return {
    ...ctx,
    user: null,
    actor: { type: "system", id: "anonymous", representedUserId: null, label: "Anonymous" },
    sessionId: null,
    sessionAssurance: null,
    accessIdentity: null,
    accessStatus: null,
  };
}

async function nonMember(email: string): Promise<Ctx> {
  const base = await ctxFor("cabinet", "owner@foilbury.local");
  const user = await createUser(runtime.DB, { email, displayName: "Non Member", password: "a-long-test-password" });
  return {
    ...base,
    user: {
      id: user.id,
      email: user.email,
      displayName: "Non Member",
      role: "player",
      platformAdmin: false,
      emailVerified: true,
      capabilities: [],
    },
    actor: { type: "user", id: user.id, representedUserId: user.id, label: "Non Member" },
  };
}

describe("explicit collection visibility", () => {
  it("keeps a member collection out of anonymous and non-member catalogue reads", async () => {
    await bootstrap();
    const owner = await strongOwner();
    const fixture = await fixturePool(owner);
    const collection = await createCollection(owner, {
      name: "Member Only",
      scope: "global",
      status: "published",
      viewAudience: "members",
    });
    await addCollectionCards(owner, collection.id, [fixture.cardId]);
    // Remove the fixture card from the public fixture collection so the card's
    // effective audience is the member collection alone.
    await runtime.DB.prepare("DELETE FROM fb_collection_cards WHERE collection_id = 'col_test_public'").run();

    const signedOut = anonymous(owner);
    expect(await listCards(signedOut, { publicOnly: true })).toHaveLength(0);
    expect(await listCards(signedOut, {})).toHaveLength(0);
    expect(await canViewCard(signedOut, fixture.cardId)).toBe(false);
    await expect(getCard(signedOut, fixture.cardId)).rejects.toMatchObject({ code: "card_not_found" });

    const outsider = await nonMember("outsider@example.com");
    expect(await listCards(outsider, {})).toHaveLength(0);
    expect(await canViewCard(outsider, fixture.cardId)).toBe(false);

    const member = await ctxFor("cabinet", "player@foilbury.local");
    expect(await listCards(member, {})).toHaveLength(1);
    expect(await effectiveCardAudience(member, fixture.cardId)).toBe("members");
  });

  it("never widens a card because one permissive collection link was added", async () => {
    await bootstrap();
    const owner = await strongOwner();
    const fixture = await fixturePool(owner);
    const privateCollection = await createCollection(owner, {
      name: "Private World",
      scope: "global",
      status: "published",
      viewAudience: "private",
    });
    await addCollectionCards(owner, privateCollection.id, [fixture.cardId]);
    // The fixture card is still in the public fixture collection. The most
    // restrictive link wins, so it is no longer public.
    expect(await effectiveCardAudience(owner, fixture.cardId)).toBe("private");
    const signedOut = anonymous(owner);
    expect(await listCards(signedOut, { publicOnly: true })).toHaveLength(0);
    expect(await canViewCard(signedOut, fixture.cardId)).toBe(false);
  });

  it("allows an explicitly invited viewer into a private collection only", async () => {
    await bootstrap();
    const owner = await strongOwner();
    const fixture = await fixturePool(owner);
    const collection = await createCollection(owner, {
      name: "Private Invitation",
      scope: "global",
      status: "published",
      viewAudience: "private",
    });
    await addCollectionCards(owner, collection.id, [fixture.cardId]);
    await runtime.DB.prepare("DELETE FROM fb_collection_cards WHERE collection_id = 'col_test_public'").run();
    const viewer = await nonMember("invited@example.com");
    expect(await canViewCard(viewer, fixture.cardId)).toBe(false);
    await runtime.DB
      .prepare("INSERT INTO fb_collection_viewers (collection_id, user_id, granted_by, created_at) VALUES (?, ?, ?, ?)")
      .bind(collection.id, viewer.user!.id, owner.user!.id, new Date().toISOString())
      .run();
    expect(await canViewCard(viewer, fixture.cardId)).toBe(true);
    const access = await viewerAccess(viewer);
    expect(access.explicitCollectionIds.has(collection.id)).toBe(true);
  });

  it("denies a revoked member immediately", async () => {
    await bootstrap();
    const owner = await strongOwner();
    const fixture = await fixturePool(owner);
    const collection = await createCollection(owner, {
      name: "Member Revocation",
      scope: "global",
      status: "published",
      viewAudience: "members",
    });
    await addCollectionCards(owner, collection.id, [fixture.cardId]);
    await runtime.DB.prepare("DELETE FROM fb_collection_cards WHERE collection_id = 'col_test_public'").run();
    const member = await ctxFor("cabinet", "player@foilbury.local");
    expect(await canViewCard(member, fixture.cardId)).toBe(true);
    await runtime.DB.prepare("UPDATE fb_memberships SET status = 'revoked', revoked_at = ? WHERE tenant_id = ? AND user_id = ?")
      .bind(new Date().toISOString(), member.tenant.id, member.user!.id)
      .run();
    expect(await canViewCard(member, fixture.cardId)).toBe(false);
  });
});
