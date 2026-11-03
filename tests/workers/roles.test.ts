import { describe, expect, it } from "vitest";
import { bootstrap, ctxFor, fixturePool, runtime } from "./helpers";
import { addMembership, createUser } from "../../src/server/modules/identity";
import { createCollection, getCollection, updateCollection } from "../../src/server/modules/collections";
import { assignPlatformRole, revokePlatformRole, listPlatformPeople } from "../../src/server/modules/platform-roles";
import { confirmEmailChange } from "../../src/server/modules/magic-links";
import { nowIso } from "../../src/server/db";
import { sha256Hex, token } from "../../src/server/ids";
import { ApiError, requireGlobalCollectionManager, requireProtectedAccount, type Ctx } from "../../src/server/context";

async function playerCtx(email: string): Promise<Ctx> {
  const base = await ctxFor("cabinet", "owner@foilbury.local");
  const user = await createUser(runtime.DB, { email, displayName: "Scoped Admin", password: "a-long-test-password" });
  await runtime.DB.prepare("UPDATE fb_users SET email_verified_at = ? WHERE id = ?").bind(new Date().toISOString(), user.id).run();
  await addMembership(runtime.DB, base.tenant.id, user.id, "player");
  return {
    ...base,
    user: {
      id: user.id,
      email: user.email,
      displayName: "Scoped Admin",
      role: "player",
      platformAdmin: false,
      emailVerified: true,
      capabilities: [],
    },
    actor: { type: "user", id: user.id, representedUserId: user.id, label: "Scoped Admin" },
  };
}

function scoped(ctx: Ctx, collectionId: string): Ctx {
  return {
    ...ctx,
    user: {
      ...ctx.user!,
      platformRoles: ["global_collection_admin"],
      globalCollectionScope: { all: false, collectionIds: [collectionId] },
    },
  };
}

describe("scoped Global Collection Admin", () => {
  it("grants a scoped role without creating Super Admin and is idempotent", async () => {
    await bootstrap();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const admin = await playerCtx("kaylee@example.test");
    const first = await assignPlatformRole(owner, {
      userId: admin.user!.id,
      role: "global_collection_admin",
      scopes: { all: true },
      reason: "Owner-approved scoped curation.",
    });
    expect(first.changed).toBe(true);
    const again = await assignPlatformRole(owner, {
      userId: admin.user!.id,
      role: "global_collection_admin",
      scopes: { all: true },
      reason: "Owner-approved scoped curation.",
    });
    expect(again.changed).toBe(false);
    const user = await runtime.DB.prepare("SELECT platform_admin FROM fb_users WHERE id = ?").bind(admin.user!.id).first<{ platform_admin: number }>();
    expect(user?.platform_admin).toBe(0);
    const people = await listPlatformPeople(owner, { search: "kaylee@example.test" });
    expect(people).toHaveLength(1);
    expect(people[0]?.platform_roles[0]?.role).toBe("global_collection_admin");
  });

  it("allows a scoped manager to edit only the assigned shared collection", async () => {
    await bootstrap();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const fixture = await fixturePool(owner);
    const first = await createCollection(owner, { name: "Scoped One", scope: "global", status: "published", viewAudience: "members" });
    const second = await createCollection(owner, { name: "Scoped Two", scope: "global", status: "published", viewAudience: "members" });
    const admin = scoped(await playerCtx("kaylee2@example.test"), first.id);
    const updated = await updateCollection(admin, first.id, { description: "Curated by the scoped admin." });
    expect(updated.description).toBe("Curated by the scoped admin.");
    await expect(updateCollection(admin, second.id, { description: "No." })).rejects.toMatchObject({ code: "collection_not_found" });
    await expect(getCollection(admin, second.id, { includeAll: true })).rejects.toBeInstanceOf(ApiError);
    requireGlobalCollectionManager(admin, first.id);
    expect(() => requireGlobalCollectionManager(admin, second.id)).toThrow();
  });

  it("cannot approve a public showcase audience", async () => {
    await bootstrap();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    await fixturePool(owner);
    const collection = await createCollection(owner, { name: "Member World", scope: "global", status: "published", viewAudience: "members" });
    const admin = scoped(await playerCtx("kaylee3@example.test"), collection.id);
    await expect(updateCollection(admin, collection.id, { viewAudience: "public" })).rejects.toMatchObject({ code: "super_admin_required" });
  });

  it("revokes the role idempotently and restores no Super Admin", async () => {
    await bootstrap();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const admin = await playerCtx("kaylee4@example.test");
    await assignPlatformRole(owner, { userId: admin.user!.id, role: "global_collection_admin", scopes: { all: true }, reason: "Scope granted." });
    expect((await revokePlatformRole(owner, admin.user!.id, "global_collection_admin", "No longer required.")).changed).toBe(true);
    expect((await revokePlatformRole(owner, admin.user!.id, "global_collection_admin", "No longer required.")).changed).toBe(false);
    const row = await runtime.DB.prepare("SELECT platform_admin FROM fb_users WHERE id = ?").bind(admin.user!.id).first<{ platform_admin: number }>();
    expect(row?.platform_admin).toBe(0);
  });

  it("treats a verified Discord link as identity proof for a protected account without inventing an email", async () => {
    await bootstrap();
    const admin = await playerCtx("discord-only@example.test");
    await runtime.DB.prepare("UPDATE fb_users SET email_verified_at = NULL WHERE id = ?").bind(admin.user!.id).run();
    admin.user = { ...admin.user!, emailVerified: false };
    await expect(requireProtectedAccount(admin)).rejects.toMatchObject({ code: "identity_verification_required" });
    const now = new Date().toISOString();
    await runtime.DB.prepare(
      "INSERT INTO fb_discord_identities (id, tenant_id, discord_user_id, user_id, username, linked_at, last_seen_at) VALUES ('dci_test_scoped', ?, '999000111222333444', ?, 'scoped_tester', ?, ?)",
    ).bind(admin.tenant.id, admin.user!.id, now, now).run();
    await runtime.DB.prepare(
      "INSERT INTO fb_webauthn_credentials (id, user_id, credential_id, public_key, name, created_at) VALUES ('wac_test_scoped', ?, 'cred_test_scoped', 'pk_test_scoped', 'Test passkey', ?)",
    ).bind(admin.user!.id, now).run();
    await expect(requireProtectedAccount(admin)).resolves.toMatchObject({ id: admin.user!.id });
  });

  it("verifies a new email through a one-use link without merging another account", async () => {
    await bootstrap();
    const admin = await playerCtx("discord-email@example.test");
    const strong: Ctx = { ...admin, sessionAssurance: "passkey", sessionAuthTime: nowIso() };
    const raw = token("fbm");
    const now = nowIso();
    await runtime.DB.prepare(
      `INSERT INTO fb_magic_links (id, user_id, email, purpose, token_hash, redirect_path, created_at, expires_at, request_id)
       VALUES ('ml_test_email_change', ?, 'kaylee.real@example.test', 'link_email', ?, '/account/security?email=verified', ?, ?, 'test')`,
    ).bind(admin.user!.id, await sha256Hex(raw), now, new Date(Date.now() + 15 * 60_000).toISOString()).run();
    await expect(confirmEmailChange({ ...strong, sessionAssurance: "email" }, raw)).rejects.toBeInstanceOf(ApiError);
    await confirmEmailChange(strong, raw);
    const row = await runtime.DB.prepare("SELECT email, email_verified_at FROM fb_users WHERE id = ?").bind(admin.user!.id).first<{ email: string; email_verified_at: string | null }>();
    expect(row?.email).toBe("kaylee.real@example.test");
    expect(row?.email_verified_at).toBeTruthy();
    const duplicates = await runtime.DB.prepare("SELECT COUNT(*) AS count FROM fb_users WHERE email = ?").bind("kaylee.real@example.test").first<{ count: number }>();
    expect(duplicates?.count).toBe(1);
  });
});
