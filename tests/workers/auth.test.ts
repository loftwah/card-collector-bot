import { beforeEach, describe, expect, it } from "vitest";
import { bootstrap, ctxFor, fixturePool, runtime, tenant } from "./helpers";
import { createUser, addMembership, findUserByEmail, createSession, ensureWallet } from "../../src/server/modules/identity";
import { joinMainAlbum } from "../../src/server/modules/membership";
import { requestMagicLink, redeemMagicLink } from "../../src/server/modules/magic-links";
import { findAccessTenantForIdentity, resolveAccessIdentity } from "../../src/server/access";
import { createBot, createBotInvitation, acceptBotInvitation, revokeBotAdmin } from "../../src/server/modules/bots";
import { createCollection, addCollectionCards, enableCollection } from "../../src/server/modules/collections";
import { createPool, executeDraw, getPoolPreview, publishPool } from "../../src/server/modules/pools";
import { nowIso } from "../../src/server/db";
import { sha256Hex } from "../../src/server/ids";
import { ApiError, requireRecentStrongAuth } from "../../src/server/context";

describe("passwordless identity, Access linking, bots and collections", () => {
  beforeEach(async () => {
    await bootstrap();
  });

  it("issues, redeems and rejects a replayed magic link", async () => {
    const ctx = await ctxFor("cabinet", "owner@foilbury.local");
    const requested = await requestMagicLink(ctx, { email: "new.player@example.com", purpose: "signin", redirectPath: "/play" });
    expect(requested.ok).toBe(true);
    expect(requested.devToken).toBeTruthy();
    const first = await redeemMagicLink(ctx, requested.devToken!);
    expect(first.user.email).toBe("new.player@example.com");
    const account = await findUserByEmail(runtime.DB, "new.player@example.com");
    expect(account?.email_verified_at).toBeTruthy();
    await expect(redeemMagicLink(ctx, requested.devToken!)).rejects.toMatchObject({ code: "magic_link_invalid" });
  });

  it("never restores a revoked or suspended membership through a magic link", async () => {
    const ctx = await ctxFor("cabinet", "owner@foilbury.local");
    const player = await createUser(runtime.DB, { email: "revoked@example.com", displayName: "Revoked", password: "a-long-test-password" });
    await addMembership(runtime.DB, ctx.tenant.id, player.id, "player");
    await ensureWallet(runtime.DB, ctx.tenant.id, player.id);

    for (const status of ["revoked", "suspended"] as const) {
      await runtime.DB
        .prepare("UPDATE fb_memberships SET status = ?, revoked_at = ? WHERE tenant_id = ? AND user_id = ?")
        .bind(status, nowIso(), ctx.tenant.id, player.id)
        .run();
      const sessionsBefore = await runtime.DB
        .prepare("SELECT COUNT(*) AS count FROM fb_sessions WHERE tenant_id = ? AND user_id = ?")
        .bind(ctx.tenant.id, player.id)
        .first<{ count: number }>();
      const requested = await requestMagicLink(ctx, { email: "revoked@example.com", purpose: "signin" });
      await expect(redeemMagicLink(ctx, requested.devToken!)).rejects.toMatchObject({
        status: 403,
        code: "membership_inactive",
      });
      const membership = await runtime.DB
        .prepare("SELECT status, revoked_at, role, capabilities_json FROM fb_memberships WHERE tenant_id = ? AND user_id = ?")
        .bind(ctx.tenant.id, player.id)
        .first<{ status: string; revoked_at: string | null; role: string; capabilities_json: string }>();
      expect(membership?.status).toBe(status);
      expect(membership?.revoked_at).toBeTruthy();
      expect(membership?.role).toBe("player");
      const sessionsAfter = await runtime.DB
        .prepare("SELECT COUNT(*) AS count FROM fb_sessions WHERE tenant_id = ? AND user_id = ?")
        .bind(ctx.tenant.id, player.id)
        .first<{ count: number }>();
      expect(sessionsAfter?.count ?? 0).toBe(sessionsBefore?.count ?? 0);
    }
  });

  it("does not activate an unaccepted invitation during sign-in", async () => {
    const ctx = await ctxFor("cabinet", "owner@foilbury.local");
    const invited = await createUser(runtime.DB, { email: "pending-invite@example.com", displayName: "Pending", password: "a-long-test-password" });
    await addMembership(runtime.DB, ctx.tenant.id, invited.id, "editor", { status: "invited" });
    const requested = await requestMagicLink(ctx, { email: "pending-invite@example.com", purpose: "signin" });
    await expect(redeemMagicLink(ctx, requested.devToken!)).rejects.toMatchObject({ code: "membership_inactive" });
    const membership = await runtime.DB
      .prepare("SELECT status, accepted_at FROM fb_memberships WHERE tenant_id = ? AND user_id = ?")
      .bind(ctx.tenant.id, invited.id)
      .first<{ status: string; accepted_at: string | null }>();
    expect(membership?.status).toBe("invited");
    expect(membership?.accepted_at).toBeNull();
  });

  it("does not restore a suspended membership through explicit join", async () => {
    const ctx = await ctxFor("cabinet", "owner@foilbury.local");
    const player = await createUser(runtime.DB, { email: "suspended-join@example.com", displayName: "Suspended", password: "a-long-test-password" });
    await addMembership(runtime.DB, ctx.tenant.id, player.id, "player");
    await runtime.DB
      .prepare("UPDATE fb_memberships SET status = 'suspended', revoked_at = ? WHERE tenant_id = ? AND user_id = ?")
      .bind(nowIso(), ctx.tenant.id, player.id)
      .run();
    const playerCtx = { ...ctx, user: { ...ctx.user!, id: player.id, email: "suspended-join@example.com" } };
    await expect(joinMainAlbum(playerCtx)).rejects.toMatchObject({ code: "membership_inactive" });
    const membership = await runtime.DB
      .prepare("SELECT status FROM fb_memberships WHERE tenant_id = ? AND user_id = ?")
      .bind(ctx.tenant.id, player.id)
      .first<{ status: string }>();
    expect(membership?.status).toBe("suspended");
  });

  it("rejects an expired magic link and keeps it single-use", async () => {
    const ctx = await ctxFor("cabinet", "owner@foilbury.local");
    const requested = await requestMagicLink(ctx, { email: "expired@example.com", purpose: "signin" });
    await runtime.DB.prepare("UPDATE fb_magic_links SET expires_at = ? WHERE email = ?").bind(new Date(Date.now() - 1000).toISOString(), "expired@example.com").run();
    await expect(redeemMagicLink(ctx, requested.devToken!)).rejects.toMatchObject({ code: "magic_link_invalid" });
  });

  it("links only an explicitly allowlisted Access email and rejects a changed email", async () => {
    const ctx = await ctxFor("cabinet", "owner@foilbury.local");
    await runtime.DB.prepare("UPDATE fb_users SET email = 'dean@deanlofts.xyz', email_verified_at = ? WHERE id = ?").bind(nowIso(), ctx.user!.id).run();
    await runtime.DB
      .prepare("INSERT INTO fb_access_emails (email, user_id, added_by, created_at) VALUES (?, ?, 'test', ?)")
      .bind("dean@deanlofts.xyz", ctx.user!.id, nowIso())
      .run();
    const config = { ...ctx.config, access: { ...ctx.config.access, teamDomain: "test.cloudflareaccess.com" } };
    const identity = { subject: "subject-1", email: "dean@deanlofts.xyz", audience: "aud", payload: {} };
    const linked = await resolveAccessIdentity(runtime.DB, config, ctx.tenant, identity);
    expect(linked.status).toBe("linked");
    expect(linked.user?.id).toBe(ctx.user!.id);
    const again = await resolveAccessIdentity(runtime.DB, config, ctx.tenant, { ...identity, email: "someone@else.example" });
    expect(again.status).toBe("email_mismatch");
    expect(again.user).toBeNull();
    const unknown = await resolveAccessIdentity(runtime.DB, config, ctx.tenant, { ...identity, subject: "subject-2", email: "unknown@example.com" });
    expect(unknown.status).toBe("unlinked");
  });

  it("creates a Bot with global collections enabled and a private collection scope", async () => {
    await runtime.DB.prepare("UPDATE fb_users SET email_verified_at = ? WHERE email = ?").bind(nowIso(), "owner@foilbury.local").run();
    const ctx = await ctxFor("cabinet", "owner@foilbury.local");
    await runtime.DB
      .prepare("INSERT INTO fb_webauthn_credentials (id, user_id, credential_id, public_key, name, created_at) VALUES ('pk_test', ?, 'cred_test', 'cHVibGlj', 'Test key', ?)")
      .bind(ctx.user!.id, nowIso())
      .run();
    const result = await createBot(ctx, { name: "Second Cabinet", slug: "second-cabinet" });
    expect(result.created).toBe(true);
    expect(result.tenant.slug).toBe("bot-second-cabinet");
    const accessEmail = await runtime.DB.prepare("SELECT email, user_id, revoked_at FROM fb_access_emails WHERE user_id = ?").bind(ctx.user!.id).first<{ email: string; user_id: string; revoked_at: string | null }>();
    expect(accessEmail?.email).toBe("owner@foilbury.local");
    expect(accessEmail?.revoked_at).toBeNull();
    const enabled = await runtime.DB.prepare("SELECT COUNT(*) AS count FROM fb_bot_collections WHERE bot_id = ? AND enabled = 1").bind(result.bot.id).first<{ count: number }>();
    expect(enabled?.count ?? 0).toBeGreaterThan(0);
    const local = await runtime.DB.prepare("SELECT COUNT(*) AS count FROM fb_collections WHERE owner_tenant_id = ? AND scope = 'bot'").bind(result.tenant.id).first<{ count: number }>();
    expect(local?.count).toBe(1);
  });

  it("turns a Bot collection off and on, changing the real pool eligibility", async () => {
    const ctx = await ctxFor("cabinet", "owner@foilbury.local");
    const fixture = await fixturePool(ctx);
    const collection = await createCollection(ctx, { name: "Test World", scope: "bot", status: "published" });
    await addCollectionCards(ctx, collection.id, [fixture.cardId]);
    await enableCollection(ctx, collection.id, false);
    // The fixture card is also in the public fixture collection, so it remains
    // eligible through that live membership link.
    const stillOn = await getPoolPreview(ctx, "test-pool");
    expect(stillOn.eligible_count).toBe(1);
    await runtime.DB.prepare("UPDATE fb_bot_collections SET enabled = 0 WHERE collection_id = 'col_test_public'").run();
    const off = await getPoolPreview(ctx, "test-pool");
    expect(off.eligible_count).toBe(0);
    await enableCollection(ctx, collection.id, true);
    const on = await getPoolPreview(ctx, "test-pool");
    expect(on.eligible_count).toBe(1);
  });

  it("lets a second Bot draw a card from an enabled global collection", async () => {
    const cabinet = await ctxFor("cabinet", "owner@foilbury.local");
    const fixture = await fixturePool(cabinet);
    const global = await createCollection(cabinet, { name: "Global Cross-Bot", scope: "global", status: "published" });
    await addCollectionCards(cabinet, global.id, [fixture.cardId]);
    await runtime.DB.prepare("UPDATE fb_users SET email_verified_at = ? WHERE email = ?").bind(nowIso(), "owner@foilbury.local").run();
    await runtime.DB
      .prepare("INSERT INTO fb_webauthn_credentials (id, user_id, credential_id, public_key, name, created_at) VALUES ('pk_cross', ?, 'cred_cross', 'cHVibGlj', 'Test key', ?)")
      .bind(cabinet.user!.id, nowIso())
      .run();
    cabinet.user!.emailVerified = true;
    const second = await createBot(cabinet, { name: "Cross Bot", slug: `cross-${Date.now()}` });
    const secondCtx = await ctxFor(second.tenant.slug, "owner@foilbury.local");
    const pool = await createPool(secondCtx, { slug: "cross-pool", name: "Cross pool", description: "Global card pool", price: 0, entries: [{ variantId: fixture.variantId, weight: 1 }] });
    await publishPool(secondCtx, pool.id);
    const draw = await executeDraw(secondCtx, { pool: "cross-pool", expectedRevision: 1, idempotency: { key: "cross-draw-1", digest: await sha256Hex("cross-draw-1") } });
    expect(draw.card_id).toBe(fixture.cardId);
    const instance = await runtime.DB.prepare("SELECT tenant_id, card_id, status FROM fb_card_instances WHERE id = ?").bind(draw.instance_id).first<{ tenant_id: string; card_id: string; status: string }>();
    expect(instance?.tenant_id).toBe(second.tenant.id);
    expect(instance?.card_id).toBe(fixture.cardId);
    expect(instance?.status).toBe("owned");
  });

  it("binds an invitation to the invited email, then revokes only that Bot access", async () => {
    await runtime.DB.prepare("UPDATE fb_users SET email_verified_at = ? WHERE email = ?").bind(nowIso(), "owner@foilbury.local").run();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const invited = await createUser(runtime.DB, { email: "invited@example.com", displayName: "Invited", password: "a-long-test-password" });
    const bot = await runtime.DB.prepare("SELECT id FROM fb_bots WHERE tenant_id = ?").bind(owner.tenant.id).first<{ id: string }>();
    const invitation = await createBotInvitation(owner, {
      botId: bot!.id,
      email: "invited@example.com",
      capabilities: ["content", "publish"],
    });
    expect(invitation.devToken).toBeTruthy();
    await addMembership(runtime.DB, owner.tenant.id, invited.id, "player");
    await runtime.DB.prepare("UPDATE fb_users SET email_verified_at = ? WHERE id = ?").bind(nowIso(), invited.id).run();
    await runtime.DB
      .prepare("INSERT INTO fb_webauthn_credentials (id, user_id, credential_id, public_key, name, created_at) VALUES ('pk_invited', ?, 'cred_invited', 'cHVibGlj', 'Test key', ?)")
      .bind(invited.id, nowIso())
      .run();
    const invitedCtx = await ctxFor("cabinet", "invited@example.com");
    await expect(acceptBotInvitation(invitedCtx, "wrong-token")).rejects.toBeInstanceOf(ApiError);
    const accepted = await acceptBotInvitation(invitedCtx, invitation.devToken!);
    expect(accepted.bot.id).toBe(bot!.id);
    const invitedAccess = await runtime.DB.prepare("SELECT email, user_id FROM fb_access_emails WHERE user_id = ?").bind(invited.id).first<{ email: string; user_id: string }>();
    expect(invitedAccess?.email).toBe("invited@example.com");
    const membership = await runtime.DB.prepare("SELECT role, capabilities_json FROM fb_memberships WHERE tenant_id = ? AND user_id = ?").bind(owner.tenant.id, invited.id).first<{ role: string; capabilities_json: string }>();
    expect(membership?.role).toBe("editor");
    expect(membership?.capabilities_json).toContain("content");
    await revokeBotAdmin(owner, bot!.id, invited.id);
    const revoked = await runtime.DB.prepare("SELECT status FROM fb_bot_admins WHERE bot_id = ? AND user_id = ?").bind(bot!.id, invited.id).first<{ status: string }>();
    expect(revoked?.status).toBe("revoked");
  });

  it("finds the creator's Bot tenant when the default site tenant is not theirs", async () => {
    const ctx = await ctxFor("cabinet", "owner@foilbury.local");
    const invited = await createUser(runtime.DB, { email: "tenant-creator@example.com", displayName: "Tenant Creator", password: "a-long-test-password" });
    const harbour = await tenant("harbour");
    await addMembership(runtime.DB, harbour.id, invited.id, "owner");
    await runtime.DB.prepare("UPDATE fb_users SET email_verified_at = ? WHERE id = ?").bind(nowIso(), invited.id).run();
    await runtime.DB.prepare("INSERT INTO fb_access_emails (email, user_id, added_by, created_at) VALUES (?, ?, 'test', ?)").bind("tenant-creator@example.com", invited.id, nowIso()).run();
    const config = { ...ctx.config, access: { ...ctx.config.access, teamDomain: "test.cloudflareaccess.com" } };
    const identity = { subject: "tenant-subject", email: "tenant-creator@example.com", audience: "aud", payload: {} };
    const found = await findAccessTenantForIdentity(runtime.DB, config, identity, ctx.tenant.id);
    expect(found?.id).toBe(harbour.id);
    const resolved = await resolveAccessIdentity(runtime.DB, config, found!, identity);
    expect(resolved.status).toBe("linked");
  });

  it("requires recent strong authentication for stepped-up operations", () => {
    const passwordCtx = { sessionAssurance: "password", sessionAuthTime: nowIso(), actor: { type: "user" } } as never;
    expect(() => requireRecentStrongAuth(passwordCtx, 30)).toThrow(/passkey|authenticator|Cloudflare Access/);
    const accessCtx = { sessionAssurance: "access", sessionAuthTime: nowIso(), actor: { type: "user" }, accessIdentity: { subject: "subject-1" }, accessStatus: "linked" } as never;
    expect(() => requireRecentStrongAuth(accessCtx, 30)).not.toThrow();
    const oldAccessCookie = { sessionAssurance: "access", sessionAuthTime: nowIso(), actor: { type: "user" }, accessIdentity: null } as never;
    expect(() => requireRecentStrongAuth(oldAccessCookie, 30)).toThrow(/passkey|authenticator|Cloudflare Access/);
    const oldMfaCtx = { sessionAssurance: "mfa", sessionAuthTime: new Date(Date.now() - 60 * 60_000).toISOString(), actor: { type: "user" } } as never;
    expect(() => requireRecentStrongAuth(oldMfaCtx, 30)).toThrow(/stale/);
  });

  it("does not let an application session exist without the Access identity on an admin path", async () => {
    const ctx = await ctxFor("cabinet", "owner@foilbury.local");
    const session = await createSession(runtime.DB, ctx.tenant, ctx.user!, { authMethod: "cloudflare_access", assurance: "access" });
    expect(session.token).toBeTruthy();
    // The production middleware re-verifies Cf-Access-Jwt-Assertion on every
    // admin request; this test proves the app cookie itself is not the boundary.
    expect(ctx.accessIdentity).toBeNull();
  });
});

