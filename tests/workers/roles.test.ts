import { describe, expect, it } from "vitest";
import { bootstrap, ctxFor, fixturePool, runtime } from "./helpers";
import { addMembership, createUser } from "../../src/server/modules/identity";
import { createCollection, getCollection, updateCollection } from "../../src/server/modules/collections";
import { assignPlatformRole, revokePlatformRole, listPlatformPeople } from "../../src/server/modules/platform-roles";
import { setMemberStatus } from "../../src/server/modules/membership";
import { confirmEmailChange } from "../../src/server/modules/magic-links";
import { nowIso } from "../../src/server/db";
import { sha256Hex, token } from "../../src/server/ids";
import { ApiError, requireGlobalCollectionManager, requireProtectedAccount, type Ctx } from "../../src/server/context";

async function collectionSession(ctx: Ctx): Promise<Ctx> {
  const id=`role-collection-${crypto.randomUUID()}`,now=nowIso();
  await runtime.DB.prepare("INSERT INTO fb_sessions (id,token_hash,user_id,tenant_id,csrf_token,created_at,expires_at,last_seen_at,assurance,auth_time) VALUES (?,?,?,?,'test',?,?,?,'passkey',?)")
    .bind(id,id,ctx.user!.id,ctx.tenant.id,now,new Date(Date.now()+60000).toISOString(),now,now).run();
  return {...ctx,sessionId:id,sessionAssurance:'passkey',sessionAuthTime:now};
}

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
    const owner = await collectionSession(await ctxFor("cabinet", "owner@foilbury.local"));
    const fixture = await fixturePool(owner);
    const first = await createCollection(owner, { name: "Scoped One", scope: "global", status: "published", viewAudience: "members" });
    const second = await createCollection(owner, { name: "Scoped Two", scope: "global", status: "published", viewAudience: "members" });
    const admin = await collectionSession(scoped(await playerCtx("kaylee2@example.test"), first.id));
    await assignPlatformRole(owner, { userId: admin.user!.id, role: "global_collection_admin", scopes: { all: false, collectionIds: [first.id] }, reason: "Scoped curation fixture." });
    const updated = await updateCollection(admin, first.id, { description: "Curated by the scoped admin." });
    expect(updated.description).toBe("Curated by the scoped admin.");
    await expect(updateCollection(admin, second.id, { description: "No." })).rejects.toMatchObject({ code: "collection_not_found" });
    await expect(getCollection(admin, second.id, { includeAll: true })).rejects.toBeInstanceOf(ApiError);
    expect((await getCollection(admin, second.id)).id).toBe(second.id);
    await revokePlatformRole(owner, admin.user!.id, "global_collection_admin", "Scope revoked.");
    await expect(getCollection(admin, first.id, { includeAll: true })).rejects.toBeInstanceOf(ApiError);
    requireGlobalCollectionManager(admin, first.id);
    expect(() => requireGlobalCollectionManager(admin, second.id)).toThrow();
  });

  it("cannot approve a public showcase audience", async () => {
    await bootstrap();
    const owner = await collectionSession(await ctxFor("cabinet", "owner@foilbury.local"));
    await fixturePool(owner);
    const collection = await createCollection(owner, { name: "Member World", scope: "global", status: "published", viewAudience: "members" });
    const admin = scoped(await playerCtx("kaylee3@example.test"), collection.id);
    await assignPlatformRole(owner, { userId: admin.user!.id, role: "global_collection_admin", scopes: { all: false, collectionIds: [collection.id] }, reason: "Scoped curation fixture." });
    await expect(updateCollection(admin, collection.id, { viewAudience: "public" })).rejects.toMatchObject({ code: "super_admin_required" });
  });

  it('withdraws public approval when a scoped curator changes public copy and requires human reapproval',async()=>{
    await bootstrap();
    const owner=await collectionSession(await ctxFor('cabinet','owner@foilbury.local'));
    const collection=await createCollection(owner,{name:'Reviewed world',scope:'global',status:'published',viewAudience:'public'});
    const admin=await collectionSession(scoped(await playerCtx('collection-demotion@example.test'),collection.id));
    await assignPlatformRole(owner,{userId:admin.user!.id,role:'global_collection_admin',scopes:{all:false,collectionIds:[collection.id]},reason:'Curator fixture'});
    const changed=await updateCollection(admin,collection.id,{description:'Updated public-facing copy'});
    expect(changed.view_audience).toBe('members');expect(changed.public_approved_at).toBeNull();
    await expect(updateCollection(admin,collection.id,{viewAudience:'public'})).rejects.toMatchObject({code:'super_admin_required'});
    const reapproved=await updateCollection(owner,collection.id,{viewAudience:'public'});
    expect(reapproved.view_audience).toBe('public');expect(reapproved.public_approved_at).toBeTruthy();
    const unchanged=await updateCollection(owner,collection.id,{description:'Updated public-facing copy',viewAudience:'public'});
    expect(unchanged.view_audience).toBe('public');
  });

  it('does not mutate a collection when a scoped role is removed during the request',async()=>{
    await bootstrap();
    const owner=await collectionSession(await ctxFor('cabinet','owner@foilbury.local'));
    const collection=await createCollection(owner,{name:'Scoped race',scope:'global',status:'published',viewAudience:'members'});
    const admin=await collectionSession(scoped(await playerCtx('collection-rescope@example.test'),collection.id));
    await assignPlatformRole(owner,{userId:admin.user!.id,role:'global_collection_admin',scopes:{all:false,collectionIds:[collection.id]},reason:'Scope race fixture'});
    const db=new Proxy(runtime.DB,{get(target,key){
      if(key==='batch') return async (statements:Parameters<typeof target.batch>[0])=>{
        await target.prepare("UPDATE fb_platform_role_assignments SET status='revoked',revoked_at=? WHERE user_id=? AND role='global_collection_admin'").bind(nowIso(),admin.user!.id).run();
        return target.batch(statements);
      };
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    await expect(updateCollection({...admin,db},collection.id,{description:'Must not be saved'})).rejects.toMatchObject({code:'stale_write'});
    expect((await runtime.DB.prepare('SELECT description FROM fb_collections WHERE id=?').bind(collection.id).first<{description:string}>())?.description).not.toBe('Must not be saved');
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

  it('fences membership decisions at commit and rolls back audit and events together', async () => {
    await bootstrap();
    const owner=await ctxFor('cabinet','owner@foilbury.local');
    const player=await ctxFor('cabinet','player@foilbury.local');
    const now=nowIso();
    await runtime.DB.prepare(`INSERT INTO fb_sessions (id,token_hash,user_id,tenant_id,csrf_token,created_at,expires_at,last_seen_at,assurance,auth_time) VALUES ('membership_session','membership_hash',?,?,'test',?,?,?,'mfa',?)`).bind(owner.user!.id,owner.tenant.id,now,new Date(Date.now()+3600000).toISOString(),now,now).run();
    const strong={...owner,sessionId:'membership_session',sessionAssurance:'mfa' as const,sessionAuthTime:now};
    const revokedDb=new Proxy(runtime.DB,{get(target,key){
      if(key==='batch') return async(...args:Parameters<typeof target.batch>)=>{await target.prepare("UPDATE fb_sessions SET revoked_at=? WHERE id='membership_session'").bind(nowIso()).run();return target.batch(...args);};
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    await expect(setMemberStatus({...strong,db:revokedDb},player.user!.id,'suspended','Fixture decision')).rejects.toMatchObject({code:'membership_changed'});
    expect((await runtime.DB.prepare('SELECT status FROM fb_memberships WHERE tenant_id=? AND user_id=?').bind(owner.tenant.id,player.user!.id).first<{status:string}>())?.status).toBe('active');
    await runtime.DB.prepare("UPDATE fb_sessions SET revoked_at=NULL WHERE id='membership_session'").run();
    await runtime.DB.prepare("CREATE TRIGGER fail_membership_event BEFORE INSERT ON fb_membership_events WHEN NEW.event='suspended' BEGIN SELECT RAISE(ABORT,'test failure'); END").run();
    try { await expect(setMemberStatus(strong,player.user!.id,'suspended','Fixture decision')).rejects.toThrow(); } finally { await runtime.DB.prepare('DROP TRIGGER fail_membership_event').run(); }
    expect((await runtime.DB.prepare('SELECT status FROM fb_memberships WHERE tenant_id=? AND user_id=?').bind(owner.tenant.id,player.user!.id).first<{status:string}>())?.status).toBe('active');
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_audit_events WHERE action='membership.suspended' AND object_id=?").bind(player.user!.id).first<{n:number}>())?.n).toBe(0);
    const targetOwnerDb=new Proxy(runtime.DB,{get(target,key){
      if(key==='batch') return async(...args:Parameters<typeof target.batch>)=>{await target.prepare("UPDATE fb_bots SET owner_user_id=? WHERE tenant_id=?").bind(player.user!.id,owner.tenant.id).run();return target.batch(...args);};
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    await expect(setMemberStatus({...strong,db:targetOwnerDb},player.user!.id,'suspended','Fixture decision')).rejects.toMatchObject({code:'membership_changed'});
    await runtime.DB.prepare("UPDATE fb_bots SET owner_user_id=? WHERE tenant_id=?").bind(owner.user!.id,owner.tenant.id).run();
    const transferDb=new Proxy(runtime.DB,{get(target,key){
      if(key==='batch') return async(...args:Parameters<typeof target.batch>)=>{
        await target.prepare("UPDATE fb_bots SET owner_user_id=? WHERE tenant_id=?").bind(player.user!.id,owner.tenant.id).run();
        await target.prepare("UPDATE fb_platform_admins SET status='revoked',revoked_at=? WHERE user_id=?").bind(nowIso(),owner.user!.id).run();
        return target.batch(...args);
      };
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    await expect(setMemberStatus({...strong,db:transferDb},player.user!.id,'suspended','Fixture decision')).rejects.toMatchObject({code:'membership_changed'});
    expect((await runtime.DB.prepare('SELECT status FROM fb_memberships WHERE tenant_id=? AND user_id=?').bind(owner.tenant.id,player.user!.id).first<{status:string}>())?.status).toBe('active');
    await runtime.DB.prepare("UPDATE fb_bots SET owner_user_id=? WHERE tenant_id=?").bind(owner.user!.id,owner.tenant.id).run();
    await runtime.DB.prepare("UPDATE fb_platform_admins SET status='active',revoked_at=NULL WHERE user_id=?").bind(owner.user!.id).run();
    await setMemberStatus(strong,player.user!.id,'suspended','Fixture decision');
    expect((await runtime.DB.prepare('SELECT status FROM fb_memberships WHERE tenant_id=? AND user_id=?').bind(owner.tenant.id,player.user!.id).first<{status:string}>())?.status).toBe('suspended');
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_membership_events WHERE event='suspended' AND user_id=?").bind(player.user!.id).first<{n:number}>())?.n).toBe(1);
  });

  it('rejects malformed member-management capabilities at the transaction boundary', async () => {
    await bootstrap();
    const owner=await ctxFor('cabinet','owner@foilbury.local');
    const editor=await playerCtx('members-admin@example.test');
    const target=await ctxFor('cabinet','player@foilbury.local');
    const now=nowIso();
    const bot=await runtime.DB.prepare('SELECT id FROM fb_bots WHERE tenant_id=?').bind(owner.tenant.id).first<{id:string}>();
    await runtime.DB.prepare("UPDATE fb_memberships SET role='editor',capabilities_json='[\"members\"]' WHERE tenant_id=? AND user_id=?").bind(owner.tenant.id,editor.user!.id).run();
    await runtime.DB.prepare("INSERT INTO fb_bot_admins (id,bot_id,user_id,role,capabilities_json,status,created_at) VALUES ('members_grant',?,?,'admin','[\"members\"]','active',?)").bind(bot!.id,editor.user!.id,now).run();
    await runtime.DB.prepare(`INSERT INTO fb_sessions (id,token_hash,user_id,tenant_id,csrf_token,created_at,expires_at,last_seen_at,assurance,auth_time) VALUES ('members_editor_session','members_editor_hash',?,?,'test',?,?,?,'mfa',?)`).bind(editor.user!.id,editor.tenant.id,now,new Date(Date.now()+3600000).toISOString(),now,now).run();
    const strong={...editor,user:{...editor.user!,role:'editor' as const,capabilities:['members']},sessionId:'members_editor_session',sessionAssurance:'mfa' as const,sessionAuthTime:now};
    for(const table of ['fb_memberships','fb_bot_admins'] as const) {
      const db=new Proxy(runtime.DB,{get(dbTarget,key){
        if(key==='batch') return async(...args:Parameters<typeof dbTarget.batch>)=>{
          await dbTarget.prepare(table==='fb_memberships' ? "UPDATE fb_memberships SET capabilities_json='\"members\"' WHERE tenant_id=? AND user_id=?" : "UPDATE fb_bot_admins SET capabilities_json='[\"members\",3]' WHERE bot_id=? AND user_id=?").bind(table==='fb_memberships'?editor.tenant.id:bot!.id,editor.user!.id).run();
          return dbTarget.batch(...args);
        };
        const value=Reflect.get(dbTarget,key,dbTarget);return typeof value==='function'?value.bind(dbTarget):value;
      }});
      await expect(setMemberStatus({...strong,db},target.user!.id,'suspended','Fixture decision')).rejects.toMatchObject({code:'membership_changed'});
      await runtime.DB.prepare("UPDATE fb_memberships SET capabilities_json='[\"members\"]' WHERE tenant_id=? AND user_id=?").bind(editor.tenant.id,editor.user!.id).run();
      await runtime.DB.prepare("UPDATE fb_bot_admins SET capabilities_json='[\"members\"]' WHERE id='members_grant'").run();
    }
    expect((await runtime.DB.prepare('SELECT status FROM fb_memberships WHERE tenant_id=? AND user_id=?').bind(owner.tenant.id,target.user!.id).first<{status:string}>())?.status).toBe('active');
  });

  it("verifies a new email through a one-use link without merging another account", async () => {
    await bootstrap();
    const admin = await playerCtx("discord-email@example.test");
    // A Discord-linked account keeps the same Foilbury user ID when email is linked.
    await runtime.DB.prepare("INSERT INTO fb_discord_identities (id,tenant_id,discord_user_id,user_id,username,linked_at,last_seen_at) VALUES ('email_link_discord',?,'999000111222333445',?,'discord_member',?,?)").bind(admin.tenant.id,admin.user!.id,nowIso(),nowIso()).run();
    await runtime.DB.prepare('UPDATE fb_users SET email_verified_at=NULL WHERE id=?').bind(admin.user!.id).run();
    const sessionTime = nowIso();
    await runtime.DB.prepare(`INSERT INTO fb_sessions (id,token_hash,user_id,tenant_id,csrf_token,created_at,expires_at,last_seen_at,assurance,auth_time) VALUES ('email_change_session','email_change_hash',?,?, 'test',?,?,?,'passkey',?)`).bind(admin.user!.id,admin.tenant.id,sessionTime,new Date(Date.now()+3600000).toISOString(),sessionTime,sessionTime).run();
    const strong: Ctx = { ...admin, sessionId: 'email_change_session', sessionAssurance: "passkey", sessionAuthTime: sessionTime };
    const raw = token("fbm");
    const now = nowIso();
    await runtime.DB.prepare(
      `INSERT INTO fb_magic_links (id, user_id, email, purpose, token_hash, redirect_path, created_at, expires_at, request_id)
       VALUES ('ml_test_email_change', ?, 'kaylee.real@example.test', 'link_email', ?, '/account/security?email=verified', ?, ?, 'test')`,
    ).bind(admin.user!.id, await sha256Hex(raw), now, new Date(Date.now() + 15 * 60_000).toISOString()).run();
    await expect(confirmEmailChange({ ...strong, sessionAssurance: "email" }, raw)).rejects.toBeInstanceOf(ApiError);
    const revokedDb = new Proxy(runtime.DB,{get(target,key){
      if(key==='batch') return async(...args:Parameters<typeof target.batch>)=>{await target.prepare("UPDATE fb_sessions SET revoked_at=? WHERE id='email_change_session'").bind(nowIso()).run();return target.batch(...args);};
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    await expect(confirmEmailChange({...strong,db:revokedDb},raw)).rejects.toMatchObject({code:'email_change_changed'});
    expect((await runtime.DB.prepare("SELECT used_at FROM fb_magic_links WHERE id='ml_test_email_change'").first<{used_at:string|null}>())?.used_at).toBeNull();
    await runtime.DB.prepare("UPDATE fb_sessions SET revoked_at=NULL WHERE id='email_change_session'").run();
    const hashDb = new Proxy(runtime.DB,{get(target,key){
      if(key==='batch') return async(...args:Parameters<typeof target.batch>)=>{await target.prepare("UPDATE fb_magic_links SET token_hash='rotated_hash' WHERE id='ml_test_email_change'").run();return target.batch(...args);};
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    await expect(confirmEmailChange({...strong,db:hashDb},raw)).rejects.toMatchObject({code:'email_change_changed'});
    expect((await runtime.DB.prepare("SELECT used_at FROM fb_magic_links WHERE id='ml_test_email_change'").first<{used_at:string|null}>())?.used_at).toBeNull();
    await runtime.DB.prepare("UPDATE fb_magic_links SET token_hash=? WHERE id='ml_test_email_change'").bind(await sha256Hex(raw)).run();
    await runtime.DB.prepare("CREATE TRIGGER fail_email_audit BEFORE INSERT ON fb_audit_events WHEN NEW.action='identity.email.verified' BEGIN SELECT RAISE(ABORT,'test failure'); END").run();
    try { await expect(confirmEmailChange(strong,raw)).rejects.toThrow(); } finally { await runtime.DB.prepare('DROP TRIGGER fail_email_audit').run(); }
    expect((await runtime.DB.prepare("SELECT used_at FROM fb_magic_links WHERE id='ml_test_email_change'").first<{used_at:string|null}>())?.used_at).toBeNull();
    await confirmEmailChange(strong, raw);
    const row = await runtime.DB.prepare("SELECT email, email_verified_at FROM fb_users WHERE id = ?").bind(admin.user!.id).first<{ email: string; email_verified_at: string | null }>();
    expect(row?.email).toBe("kaylee.real@example.test");
    expect(row?.email_verified_at).toBeTruthy();
    const duplicates = await runtime.DB.prepare("SELECT COUNT(*) AS count FROM fb_users WHERE email = ?").bind("kaylee.real@example.test").first<{ count: number }>();
    expect(duplicates?.count).toBe(1);
    expect((await runtime.DB.prepare("SELECT user_id FROM fb_discord_identities WHERE id='email_link_discord'").first<{user_id:string}>())?.user_id).toBe(admin.user!.id);
  });
});
