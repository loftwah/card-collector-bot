import { beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "../../src/server/context";
import { adjustWallet as adjustWalletImpl } from "../../src/server/modules/economy";
import { getWalletSummary } from "../../src/server/modules/wallet";
import { bootstrap, ctxFor, runtime, setBalance, walletBalance } from "./helpers";
import { routeApi } from "../../src/server/api/router";

async function strongContext(ctx: Awaited<ReturnType<typeof ctxFor>>) {
  const now = new Date().toISOString(), id = `admin-session-${crypto.randomUUID()}`;
  await runtime.DB.prepare("INSERT INTO fb_sessions (id,token_hash,user_id,tenant_id,csrf_token,created_at,expires_at,last_seen_at,assurance,auth_time) VALUES (?,?,?,?, 'test',?,?,?,'passkey',?)")
    .bind(id,id,ctx.user!.id,ctx.tenant.id,now,new Date(Date.now()+60000).toISOString(),now,now).run();
  return {...ctx,sessionId:id,sessionAssurance:'passkey' as const,sessionAuthTime:now};
}

async function adjustWallet(ctx: Parameters<typeof adjustWalletImpl>[0], input: Parameters<typeof adjustWalletImpl>[1]) {
  const now = new Date().toISOString();
  const sessionId = `test_session_${crypto.randomUUID()}`;
  await runtime.DB.prepare("INSERT INTO fb_sessions (id, token_hash, user_id, tenant_id, csrf_token, created_at, expires_at, last_seen_at, assurance, auth_time) VALUES (?, ?, ?, ?, 'test', ?, ?, ?, 'passkey', ?)")
    .bind(sessionId, sessionId, ctx.user!.id, ctx.tenant.id, now, new Date(Date.now() + 60_000).toISOString(), now, now).run();
  return adjustWalletImpl({ ...ctx, sessionId, sessionAssurance: "passkey", sessionAuthTime: now }, input);
}

async function configure(
  userId: string,
  tenantId: string,
  input: {
    capabilities: string[];
    selfGrantsEnabled: boolean;
    grantLimit: number;
  },
) {
  await runtime.DB.prepare(
    `UPDATE fb_memberships
        SET capabilities_json = ?, self_grants_enabled = ?, grant_limit = ?,
            capability_revision = capability_revision + 1
      WHERE tenant_id = ? AND user_id = ?`,
  )
    .bind(
      JSON.stringify(input.capabilities),
      input.selfGrantsEnabled ? 1 : 0,
      input.grantLimit,
      tenantId,
      userId,
    )
    .run();
}

describe("scoped Admin Foil grants", () => {
  beforeEach(async () => {
    await bootstrap();
  });

  it("grants with one ledger and audit receipt when the capability and policy allow it", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await setBalance(owner, player.user!.id, 300);
    await configure(player.user!.id, owner.tenant.id, {
      capabilities: ["content", "grants"],
      selfGrantsEnabled: true,
      grantLimit: 250,
    });
    const admin = await ctxFor("cabinet", "player@foilbury.local");
    const result = await adjustWallet(admin, {
      userId: admin.user!.id,
      amount: 100,
      reason: "Reviewed fixture: content and money authority together.",
      idempotency: { key: "scoped-self-grant-001", digest: "self-grant" },
    });
    expect(result.balance_after).toBe(400);
    expect(await walletBalance(admin, admin.user!.id)).toBe(400);
    const ledger = await runtime.DB.prepare(
      "SELECT amount, idempotency_key FROM fb_ledger_entries WHERE tenant_id = ? AND user_id = ? AND idempotency_key = ?",
    )
      .bind(owner.tenant.id, admin.user!.id, "adjust:scoped-self-grant-001")
      .first<{ amount: number; idempotency_key: string }>();
    expect(ledger?.amount).toBe(100);
    const audit = await runtime.DB.prepare(
      "SELECT action, metadata_json FROM fb_audit_events WHERE tenant_id = ? AND action = 'wallet.adjusted' ORDER BY created_at DESC LIMIT 1",
    )
      .bind(owner.tenant.id)
      .first<{ action: string; metadata_json: string }>();
    expect(audit?.action).toBe("wallet.adjusted");
    expect(audit?.metadata_json).toContain("content and money authority");
  });

  it("enforces the visible ceiling and positive whole-number rule without mutation", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await setBalance(owner, player.user!.id, 300);
    await configure(player.user!.id, owner.tenant.id, {
      capabilities: ["grants"],
      selfGrantsEnabled: true,
      grantLimit: 250,
    });
    const admin = await ctxFor("cabinet", "player@foilbury.local");
    await expect(
      adjustWallet(admin, {
        userId: admin.user!.id,
        amount: 251,
        reason: "Over the visible ceiling.",
        idempotency: { key: "scoped-over-limit", digest: "limit" },
      }),
    ).rejects.toMatchObject({ code: "grant_limit_exceeded" });
    await expect(
      adjustWallet(admin, {
        userId: admin.user!.id,
        amount: -100,
        reason: "Negative self grant attempt.",
        idempotency: { key: "scoped-negative", digest: "negative" },
      }),
    ).rejects.toMatchObject({ code: "amount_invalid" });
    expect(await walletBalance(admin, admin.user!.id)).toBe(300);
  });

  it("revocation and self-grant disablement apply to a stale session on the next mutation", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await setBalance(owner, player.user!.id, 300);
    await configure(player.user!.id, owner.tenant.id, {
      capabilities: ["grants"],
      selfGrantsEnabled: true,
      grantLimit: 250,
    });
    const stale = await ctxFor("cabinet", "player@foilbury.local");

    await configure(player.user!.id, owner.tenant.id, {
      capabilities: ["content"],
      selfGrantsEnabled: false,
      grantLimit: 0,
    });
    await expect(
      adjustWallet(stale, {
        userId: stale.user!.id,
        amount: 100,
        reason: "Stale form after capability removal.",
        idempotency: { key: "scoped-stale-revoked", digest: "stale" },
      }),
    ).rejects.toMatchObject({ code: "grants_capability_required" });
    expect(await walletBalance(stale, stale.user!.id)).toBe(300);

    await configure(player.user!.id, owner.tenant.id, {
      capabilities: ["grants"],
      selfGrantsEnabled: false,
      grantLimit: 250,
    });
    const fresh = await ctxFor("cabinet", "player@foilbury.local");
    await expect(
      adjustWallet(fresh, {
        userId: fresh.user!.id,
        amount: 100,
        reason: "Self-grants disabled.",
        idempotency: { key: "scoped-self-disabled", digest: "disabled" },
      }),
    ).rejects.toMatchObject({ code: "self_grants_disabled" });
    expect(await walletBalance(fresh, fresh.user!.id)).toBe(300);
  });

  it("does not credit or write a ledger entry when money authority changes before the atomic wallet batch", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await setBalance(owner, player.user!.id, 300);
    await configure(player.user!.id, owner.tenant.id, { capabilities: ["content", "grants"], selfGrantsEnabled: true, grantLimit: 250 });
    const admin = await ctxFor("cabinet", "player@foilbury.local");
    const db = new Proxy(runtime.DB, { get(target, key) {
      if (key === "batch") return async (...args: Parameters<typeof target.batch>) => {
        await target.prepare("UPDATE fb_memberships SET capabilities_json = '[\"content\"]', self_grants_enabled = 0, capability_revision = capability_revision + 1 WHERE tenant_id = ? AND user_id = ?").bind(owner.tenant.id, player.user!.id).run();
        return target.batch(...args);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    await expect(adjustWallet({ ...admin, db }, { userId: player.user!.id, amount: 100, reason: "Capability removed before commit", idempotency: { key: "race-grant", digest: "race-grant" } })).rejects.toMatchObject({ code: "adjustment_not_applied" });
    expect(await walletBalance(admin, player.user!.id)).toBe(300);
    const row = await runtime.DB.prepare("SELECT COUNT(*) AS count FROM fb_ledger_entries WHERE tenant_id = ? AND idempotency_key = 'adjust:race-grant'").bind(owner.tenant.id).first<{ count: number }>();
    expect(row?.count).toBe(0);
    const membership = await runtime.DB.prepare("SELECT capabilities_json FROM fb_memberships WHERE tenant_id = ? AND user_id = ?").bind(owner.tenant.id, player.user!.id).first<{ capabilities_json: string }>();
    expect(JSON.parse(membership!.capabilities_json)).toEqual(["content"]);
  });

  it("keeps owner corrections working and does not write a debit receipt if the balance falls before commit", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await setBalance(owner, player.user!.id, 300);
    const initial = await adjustWallet(owner, { userId: player.user!.id, amount: -20, reason: "Owner correction fixture", idempotency: { key: "owner-correction-ok", digest: "owner-correction-ok" } });
    expect(initial.balance_after).toBe(280);
    const db = new Proxy(runtime.DB, { get(target, key) {
      if (key === "batch") return async (...args: Parameters<typeof target.batch>) => {
        await target.prepare("UPDATE fb_wallets SET balance = 10 WHERE tenant_id = ? AND user_id = ?").bind(owner.tenant.id, player.user!.id).run();
        return target.batch(...args);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    await expect(adjustWallet({ ...owner, db }, { userId: player.user!.id, amount: -100, reason: "Concurrent balance fixture", idempotency: { key: "owner-correction-race", digest: "owner-correction-race" } })).rejects.toMatchObject({ code: "adjustment_not_applied" });
    expect(await walletBalance(owner, player.user!.id)).toBe(10);
    const row = await runtime.DB.prepare("SELECT COUNT(*) AS count FROM fb_ledger_entries WHERE tenant_id = ? AND idempotency_key = 'adjust:owner-correction-race'").bind(owner.tenant.id).first<{ count: number }>();
    expect(row?.count).toBe(0);
  });
  it("serializes concurrent retries and rejects a changed payload without a second credit", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await setBalance(owner, player.user!.id, 300);
    const input = { userId: player.user!.id, amount: 100, reason: "Concurrent fixture credit", idempotency: { key: "same-grant-key", digest: "same-grant-digest" } };
    const results = await Promise.all([adjustWallet(owner, input), adjustWallet(owner, input)]);
    expect(results.map((item) => item.replayed).sort()).toEqual([false, true]);
    expect(await walletBalance(owner, player.user!.id)).toBe(400);
    await expect(adjustWallet(owner, { ...input, idempotency: { ...input.idempotency, digest: "different-digest" } })).rejects.toMatchObject({ code: "idempotency_conflict" });
    const counts = await runtime.DB.prepare("SELECT (SELECT COUNT(*) FROM fb_ledger_entries WHERE tenant_id = ? AND idempotency_key = 'adjust:same-grant-key') AS ledger, (SELECT COUNT(*) FROM fb_audit_events WHERE tenant_id = ? AND action = 'wallet.adjusted' AND object_id = ?) AS audits").bind(owner.tenant.id, owner.tenant.id, player.user!.id).first<{ ledger: number; audits: number }>();
    expect(counts).toEqual({ ledger: 1, audits: 1 });
  });
  it("rolls back wallet and ledger when an audit batch statement fails", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await setBalance(owner, player.user!.id, 300);
    const db = new Proxy(runtime.DB, { get(target, key) {
      if (key === "batch") return async (statements: Parameters<typeof target.batch>[0]) => target.batch([...statements, target.prepare("SELECT * FROM deliberately_missing_table")]);
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    await expect(adjustWallet({ ...owner, db }, { userId: player.user!.id, amount: 100, reason: "Rollback fixture check", idempotency: { key: "audit-failure-check", digest: "audit-failure-check" } })).rejects.toThrow();
    expect(await walletBalance(owner, player.user!.id)).toBe(300);
    const row = await runtime.DB.prepare("SELECT COUNT(*) AS count FROM fb_ledger_entries WHERE tenant_id = ? AND idempotency_key = 'adjust:audit-failure-check'").bind(owner.tenant.id).first<{ count: number }>();
    expect(row?.count).toBe(0);
  });
  it("holds Access-only adjustments when real login recency cannot be verified", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await setBalance(owner, player.user!.id, 300);
    const now = new Date().toISOString();
    await runtime.DB.prepare("INSERT INTO fb_access_identities (id, user_id, team_domain, subject, email, linked_at, last_seen_at) VALUES ('access_fixture', ?, 'fixture.cloudflareaccess.com', 'subject-fixture', ?, ?, ?)").bind(owner.user!.id, owner.user!.email, now, now).run();
    const ctx = { ...owner, config: { ...owner.config, access: { ...owner.config.access, teamDomain: "fixture.cloudflareaccess.com" } }, sessionId: null, sessionAssurance: "access", sessionAuthTime: now, accessStatus: "linked" as const, accessIdentity: { subject: "subject-fixture", email: owner.user!.email, audience: "fixture", payload: { exp: Math.floor(Date.now() / 1000) + 60 } } };
    const body = { userId: player.user!.id, amount: 50, reason: "Verified Access fixture", idempotency: { key: "access-adjustment", digest: "access-adjustment" } };
    await expect(adjustWalletImpl(ctx, body)).rejects.toMatchObject({ code: "session_required" });
    expect(await walletBalance(owner, player.user!.id)).toBe(300);
    await runtime.DB.prepare("UPDATE fb_access_identities SET revoked_at = ? WHERE id = 'access_fixture'").bind(now).run();
    await expect(adjustWalletImpl(ctx, { ...body, idempotency: { key: "revoked-access-adjustment", digest: "revoked-access-adjustment" } })).rejects.toMatchObject({ code: "session_required" });
    expect(await walletBalance(owner, player.user!.id)).toBe(300);
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_ledger_entries WHERE tenant_id=? AND idempotency_key IN ('adjust:access-adjustment','adjust:revoked-access-adjustment')").bind(owner.tenant.id).first<{n:number}>())?.n).toBe(0);
  });
  it("does not return a prior receipt if the session is revoked during the receipt read", async () => {
    const owner=await ctxFor('cabinet','owner@foilbury.local'), player=await ctxFor('cabinet','player@foilbury.local');
    await setBalance(owner,player.user!.id,300);
    const now=new Date().toISOString(), session='receipt_read_session';
    await runtime.DB.prepare("INSERT INTO fb_sessions (id,token_hash,user_id,tenant_id,csrf_token,created_at,expires_at,last_seen_at,assurance,auth_time) VALUES (?, ?, ?, ?, 'test', ?, ?, ?, 'passkey', ?)").bind(session,session,owner.user!.id,owner.tenant.id,now,new Date(Date.now()+60000).toISOString(),now,now).run();
    const strong={...owner,sessionId:session,sessionAssurance:'passkey',sessionAuthTime:now};
    const body={userId:player.user!.id,amount:25,reason:'Receipt authorization fixture',idempotency:{key:'receipt-read-race',digest:'receipt-read-race'}};
    const first=await adjustWalletImpl(strong,body);
    expect(first.balance_after).toBe(325);
    const db=new Proxy(runtime.DB,{get(target,key){
      if(key==='prepare') return (sql:string)=>{
        const stmt=target.prepare(sql); if(!sql.includes('SELECT request_digest,response_json FROM fb_idempotency_keys')) return stmt;
        return new Proxy(stmt,{get(inner,method){
          if(method==='bind') return (...values:unknown[])=>{
            const bound=inner.bind(...values);
            return new Proxy(bound,{get(result,operation){
              if(operation==='first') return async()=>{await target.prepare('UPDATE fb_sessions SET revoked_at=? WHERE id=?').bind(now,session).run();return result.first();};
              const v=Reflect.get(result,operation,result);return typeof v==='function'?v.bind(result):v;
            }});
          };
          const v=Reflect.get(inner,method,inner);return typeof v==='function'?v.bind(inner):v;
        }});
      };
      const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v;
    }});
    await expect(adjustWalletImpl({...strong,db},body)).rejects.toMatchObject({code:'adjustment_not_applied'});
    expect(await walletBalance(owner,player.user!.id)).toBe(325);
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_ledger_entries WHERE tenant_id=? AND idempotency_key='adjust:receipt-read-race'").bind(owner.tenant.id).first<{n:number}>())?.n).toBe(1);
  });
  it("reports a committed adjustment truthfully if receipt access disappears", async () => {
    const owner=await ctxFor('cabinet','owner@foilbury.local'), player=await ctxFor('cabinet','player@foilbury.local');
    await setBalance(owner,player.user!.id,300);
    const now=new Date().toISOString(), session='receipt_after_commit';
    await runtime.DB.prepare("INSERT INTO fb_sessions (id,token_hash,user_id,tenant_id,csrf_token,created_at,expires_at,last_seen_at,assurance,auth_time) VALUES (?, ?, ?, ?, 'test', ?, ?, ?, 'passkey', ?)").bind(session,session,owner.user!.id,owner.tenant.id,now,new Date(Date.now()+60000).toISOString(),now,now).run();
    const strong={...owner,sessionId:session,sessionAssurance:'passkey',sessionAuthTime:now};
    const body={userId:player.user!.id,amount:25,reason:'Receipt after commit fixture',idempotency:{key:'receipt-after-commit',digest:'receipt-after-commit'}};
    const db=new Proxy(runtime.DB,{get(target,key){
      if(key==='batch') return async(...args:Parameters<typeof target.batch>)=>{
        const result=await target.batch(...args);
        await target.prepare('UPDATE fb_sessions SET revoked_at=? WHERE id=?').bind(now,session).run();
        return result;
      };
      const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v;
    }});
    await expect(adjustWalletImpl({...strong,db},body)).rejects.toMatchObject({code:'adjustment_receipt_missing',message:expect.stringContaining('was applied')});
    expect(await walletBalance(owner,player.user!.id)).toBe(325);
    await runtime.DB.prepare('UPDATE fb_sessions SET revoked_at=NULL WHERE id=?').bind(session).run();
    expect(await adjustWalletImpl(strong,body)).toMatchObject({replayed:true,balance_after:325});
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_ledger_entries WHERE tenant_id=? AND idempotency_key='adjust:receipt-after-commit'").bind(owner.tenant.id).first<{n:number}>())?.n).toBe(1);
  });
  it("reports a committed adjustment truthfully if the receipt database read fails", async () => {
    const owner=await ctxFor('cabinet','owner@foilbury.local'), player=await ctxFor('cabinet','player@foilbury.local');
    await setBalance(owner,player.user!.id,300);
    const now=new Date().toISOString(), session='receipt_database_failure';
    await runtime.DB.prepare("INSERT INTO fb_sessions (id,token_hash,user_id,tenant_id,csrf_token,created_at,expires_at,last_seen_at,assurance,auth_time) VALUES (?, ?, ?, ?, 'test', ?, ?, ?, 'passkey', ?)").bind(session,session,owner.user!.id,owner.tenant.id,now,new Date(Date.now()+60000).toISOString(),now,now).run();
    const strong={...owner,sessionId:session,sessionAssurance:'passkey',sessionAuthTime:now};
    const body={userId:player.user!.id,amount:25,reason:'Receipt database failure fixture',idempotency:{key:'receipt-db-failure',digest:'receipt-db-failure'}};
    let committed=false;
    const db=new Proxy(runtime.DB,{get(target,key){
      if(key==='batch') return async(...args:Parameters<typeof target.batch>)=>{const result=await target.batch(...args);committed=true;return result;};
      if(key==='prepare') return (sql:string)=>{
        const stmt=target.prepare(sql);if(!sql.includes('SELECT request_digest,response_json FROM fb_idempotency_keys')) return stmt;
        return new Proxy(stmt,{get(inner,method){
          if(method==='bind') return (...values:unknown[])=>{
            const bound=inner.bind(...values);
            return new Proxy(bound,{get(result,operation){
              if(operation==='first') return async()=>{if(committed) throw new Error('fixture database failure');return result.first();};
              const v=Reflect.get(result,operation,result);return typeof v==='function'?v.bind(result):v;
            }});
          };
          const v=Reflect.get(inner,method,inner);return typeof v==='function'?v.bind(inner):v;
        }});
      };
      const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v;
    }});
    await expect(adjustWalletImpl({...strong,db},body)).rejects.toMatchObject({code:'adjustment_receipt_missing',message:expect.stringContaining('was applied')});
    expect(await walletBalance(owner,player.user!.id)).toBe(325);
    expect(await adjustWalletImpl(strong,body)).toMatchObject({replayed:true,balance_after:325});
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_ledger_entries WHERE tenant_id=? AND idempotency_key='adjust:receipt-db-failure'").bind(owner.tenant.id).first<{n:number}>())?.n).toBe(1);
  });
  it("fences session, explicit Bot grant and recipient revocations immediately before commit", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await setBalance(owner, player.user!.id, 300);
    await configure(player.user!.id, owner.tenant.id, { capabilities: ["grants", "content"], selfGrantsEnabled: true, grantLimit: 250 });
    const bot = await runtime.DB.prepare("SELECT id FROM fb_bots WHERE tenant_id = ?").bind(owner.tenant.id).first<{ id: string }>();
    await runtime.DB.prepare("INSERT INTO fb_bot_admins (id, bot_id, user_id, role, capabilities_json, status, created_at) VALUES ('grant_fixture', ?, ?, 'admin', '[\"grants\",\"content\"]', 'active', ?)").bind(bot!.id, player.user!.id, new Date().toISOString()).run();
    const admin = await ctxFor("cabinet", "player@foilbury.local");
    for (const mode of ["session", "grant", "recipient"]) {
      const db = new Proxy(runtime.DB, { get(target, key) {
        if (key === "batch") return async (...args: Parameters<typeof target.batch>) => {
          if (mode === "session") await target.prepare("UPDATE fb_sessions SET revoked_at = ? WHERE user_id = ?").bind(new Date().toISOString(), player.user!.id).run();
          if (mode === "grant") await target.prepare("UPDATE fb_bot_admins SET status = 'revoked' WHERE id = 'grant_fixture'").run();
          if (mode === "recipient") await target.prepare("UPDATE fb_memberships SET status = 'revoked' WHERE tenant_id = ? AND user_id = ?").bind(owner.tenant.id, player.user!.id).run();
          return target.batch(...args);
        };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
      await expect(adjustWallet({ ...(mode === "recipient" ? owner : admin), db }, { userId: player.user!.id, amount: 100, reason: "Concurrent authority fixture", idempotency: { key: `race-${mode}`, digest: `race-${mode}` } })).rejects.toMatchObject({ code: "adjustment_not_applied" });
      expect(await walletBalance(admin, player.user!.id)).toBe(300);
      await runtime.DB.prepare("UPDATE fb_bot_admins SET status = 'active' WHERE id = 'grant_fixture'").run();
      await runtime.DB.prepare("UPDATE fb_memberships SET status = 'active' WHERE tenant_id = ? AND user_id = ?").bind(owner.tenant.id, player.user!.id).run();
    }
  });
  it("rejects an in-flight former Bot Owner after ownership changes", async () => {
    const original = await ctxFor("cabinet", "owner@foilbury.local");
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await runtime.DB.prepare("UPDATE fb_users SET platform_admin = 0 WHERE id = ?").bind(original.user!.id).run();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    await setBalance(owner, player.user!.id, 300);
    const db = new Proxy(runtime.DB, { get(target, key) {
      if (key === "batch") return async (...args: Parameters<typeof target.batch>) => {
        await target.prepare("UPDATE fb_bots SET owner_user_id = ? WHERE tenant_id = ?").bind(player.user!.id, owner.tenant.id).run();
        return target.batch(...args);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    await expect(adjustWallet({ ...owner, db }, { userId: player.user!.id, amount: 100, reason: "Owner reassignment fixture", idempotency: { key: "owner-changed", digest: "owner-changed" } })).rejects.toMatchObject({ code: "adjustment_not_applied" });
    expect(await walletBalance(owner, player.user!.id)).toBe(300);
    const row = await runtime.DB.prepare("SELECT COUNT(*) AS count FROM fb_ledger_entries WHERE tenant_id = ? AND idempotency_key = 'adjust:owner-changed'").bind(owner.tenant.id).first<{ count: number }>();
    expect(row?.count).toBe(0);
  });
  it("fails closed for agent credentials until their exact grant can be bound at commit", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await setBalance(owner, player.user!.id, 300);
    const agent = { ...owner, actor: { type: "agent" as const, id: "fixture-agent", representedUserId: owner.user!.id, label: "Fixture" }, scopes: ["economy:grant"] };
    await expect(adjustWalletImpl(agent, { userId: player.user!.id, amount: 100, reason: "Agent grant fixture", idempotency: { key: "agent-not-bound", digest: "agent-not-bound" } })).rejects.toMatchObject({ code: "human_strong_auth_required" });
    expect(await walletBalance(owner, player.user!.id)).toBe(300);
  });

  it("lets the Super Admin edit an existing Admin's capability and policy through the API", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const player = await ctxFor("cabinet", "player@foilbury.local");
    // Make the player a real Bot Admin row without creating a duplicate account.
    const bot = await runtime.DB.prepare("SELECT id FROM fb_bots WHERE tenant_id = ? LIMIT 1")
      .bind(owner.tenant.id)
      .first<{ id: string }>();
    await runtime.DB.prepare(
      `INSERT INTO fb_bot_admins (id, bot_id, user_id, role, capabilities_json, status, created_at, accepted_at)
       VALUES ('badm_scoped_test', ?, ?, 'admin', '["content"]', 'active', ?, ?)`,
    )
      .bind(bot!.id, player.user!.id, new Date().toISOString(), new Date().toISOString())
      .run();
    await runtime.DB.prepare(
      "UPDATE fb_memberships SET role = 'editor', capabilities_json = '[\"content\"]' WHERE tenant_id = ? AND user_id = ?",
    )
      .bind(owner.tenant.id, player.user!.id)
      .run();

    const request = new Request("https://foilbury.test/api/v1/admin/bot/admins/" + player.user!.id, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-foilbury-csrf": "test" },
      body: JSON.stringify({
        capabilities: ["content", "grants"],
        selfGrantsEnabled: true,
        grantLimit: 300,
        reason: "Owner enables the requested scoped Admin self-grant.",
      }),
    });
    const ownerCtx = await strongContext(owner);
    const response = await routeApi(request, ownerCtx, "admin/bot/admins/" + player.user!.id);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      capabilities: string[];
      self_grants_enabled: boolean;
      grant_limit: number;
    };
    expect(body.capabilities).toEqual(["content", "grants"]);
    expect(body.self_grants_enabled).toBe(true);
    expect(body.grant_limit).toBe(300);
    const updated = await ctxFor("cabinet", "player@foilbury.local");
    expect(updated.user!.capabilities).toEqual(["content", "grants"]);
    expect(updated.user!.selfGrantsEnabled).toBe(true);
    expect(updated.user!.grantLimit).toBe(300);
    const audit = await runtime.DB.prepare(
      "SELECT metadata_json FROM fb_audit_events WHERE action = 'bot.admin.capabilities.updated' ORDER BY created_at DESC LIMIT 1",
    ).first<{ metadata_json: string }>();
    expect(audit?.metadata_json).toContain("Owner enables the requested");
  });

  it("keeps a revoked Admin's account, cards and ledger intact", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await setBalance(owner, player.user!.id, 300);
    const before = await getWalletSummary(owner.db, owner.tenant.id, player.user!.id, 10);
    await runtime.DB.prepare(
      "UPDATE fb_memberships SET status = 'revoked', revoked_at = ?, capabilities_json = '[]' WHERE tenant_id = ? AND user_id = ?",
    )
      .bind(new Date().toISOString(), owner.tenant.id, player.user!.id)
      .run();
    const stale = await ctxFor("cabinet", "player@foilbury.local");
    await expect(
      adjustWallet(stale, {
        userId: stale.user!.id,
        amount: 100,
        reason: "Revoked admin attempt.",
        idempotency: { key: "scoped-revoked", digest: "revoked" },
      }),
    ).rejects.toMatchObject({ code: "membership_revoked" });
    const after = await getWalletSummary(owner.db, owner.tenant.id, player.user!.id, 10);
    expect(after.balance).toBe(before.balance);
  });
  it('allows the live Super Admin to edit a different Bot owner’s administrator', async () => {
    const initial=await ctxFor('cabinet','owner@foilbury.local');
    const target=await ctxFor('cabinet','player@foilbury.local');
    const other=await ctxFor('harbour','harbour.owner@foilbury.test');
    await runtime.DB.prepare('UPDATE fb_bots SET owner_user_id=? WHERE tenant_id=?').bind(other.user!.id,initial.tenant.id).run();
    await runtime.DB.prepare("UPDATE fb_memberships SET role='player' WHERE tenant_id=? AND user_id=?").bind(initial.tenant.id,initial.user!.id).run();
    await runtime.DB.prepare("UPDATE fb_memberships SET role='editor',capabilities_json='[\"content\"]' WHERE tenant_id=? AND user_id=?").bind(initial.tenant.id,target.user!.id).run();
    const owner=await strongContext(await ctxFor('cabinet','owner@foilbury.local'));
    expect(owner.user!.platformAdmin).toBe(true);
    const path=`admin/bot/admins/${target.user!.id}`;
    const request=new Request(`https://foilbury.test/api/v1/${path}`,{method:'PATCH',headers:{'content-type':'application/json','x-foilbury-csrf':'test'},body:JSON.stringify({capabilities:['content','grants'],selfGrantsEnabled:false,grantLimit:100,reason:'Super Admin fixture'})});
    expect((await routeApi(request,owner,path)).status).toBe(200);
    expect((await ctxFor('cabinet','player@foilbury.local')).user!.capabilities).toEqual(['content','grants']);
  });

  it('does not revive an explicitly revoked Bot admin grant', async () => {
    const owner=await strongContext(await ctxFor('cabinet','owner@foilbury.local'));
    const target=await ctxFor('cabinet','player@foilbury.local');
    await runtime.DB.prepare("UPDATE fb_memberships SET role='editor',capabilities_json='[\"content\"]' WHERE tenant_id=? AND user_id=?").bind(owner.tenant.id,target.user!.id).run();
    await runtime.DB.prepare("INSERT INTO fb_bot_admins (id,bot_id,user_id,role,capabilities_json,status,revoked_at,created_at) SELECT 'revoked-admin',id,?,'admin','[\"content\"]','revoked',?,? FROM fb_bots WHERE tenant_id=?").bind(target.user!.id,new Date().toISOString(),new Date().toISOString(),owner.tenant.id).run();
    const path=`admin/bot/admins/${target.user!.id}`;
    const request=new Request(`https://foilbury.test/api/v1/${path}`,{method:'PATCH',headers:{'content-type':'application/json','x-foilbury-csrf':'test'},body:JSON.stringify({capabilities:['grants'],selfGrantsEnabled:false,grantLimit:100,reason:'Revoked fixture'})});
    await expect(routeApi(request,owner,path)).rejects.toMatchObject({code:'admin_changed'});
    expect((await ctxFor('cabinet','player@foilbury.local')).user!.capabilities).toEqual(['content']);
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_audit_events WHERE action='bot.admin.capabilities.updated'").first<{n:number}>())?.n).toBe(0);
  });

  it.each(['owner transfer','owner transfer elsewhere','session revoked','session weakened','session stale','membership revoked','target disabled','target revision','target policy changed','target grant changed','audit failure'])("rolls back an admin capability edit after %s", async (race) => {
    const base = await ctxFor('cabinet','owner@foilbury.local');
    const player = await ctxFor('cabinet','player@foilbury.local');
    const other = await ctxFor('harbour','harbour.owner@foilbury.test');
    await runtime.DB.prepare('UPDATE fb_users SET platform_admin=0 WHERE id=?').bind(base.user!.id).run();
    await runtime.DB.prepare("UPDATE fb_memberships SET role='editor',capabilities_json='[\"content\"]' WHERE tenant_id=? AND user_id=?").bind(base.tenant.id,player.user!.id).run();
    const owner = await strongContext({...base,user:{...base.user!,platformAdmin:false}});
    const path=`admin/bot/admins/${player.user!.id}`;
    const request=new Request(`https://foilbury.test/api/v1/${path}`,{method:'PATCH',headers:{'content-type':'application/json','x-foilbury-csrf':'test'},body:JSON.stringify({capabilities:['grants'],selfGrantsEnabled:false,grantLimit:100,reason:'Race fixture'})});
    let injected=false;
    const db=new Proxy(runtime.DB,{get(target,prop){if(prop==='batch') return async (statements:Parameters<typeof target.batch>[0])=>{
      if (!injected) { injected=true;
        if(race==='owner transfer') await target.prepare('UPDATE fb_bots SET owner_user_id=? WHERE tenant_id=?').bind(player.user!.id,owner.tenant.id).run();
        if(race==='owner transfer elsewhere') await target.prepare('UPDATE fb_bots SET owner_user_id=? WHERE tenant_id=?').bind(other.user!.id,owner.tenant.id).run();
        if(race==='session revoked') await target.prepare('UPDATE fb_sessions SET revoked_at=? WHERE id=?').bind(new Date().toISOString(),owner.sessionId).run();
        if(race==='session weakened') await target.prepare("UPDATE fb_sessions SET assurance='password' WHERE id=?").bind(owner.sessionId).run();
        if(race==='session stale') await target.prepare("UPDATE fb_sessions SET auth_time='2000-01-01T00:00:00.000Z' WHERE id=?").bind(owner.sessionId).run();
        if(race==='membership revoked') await target.prepare("UPDATE fb_memberships SET status='revoked',revoked_at=? WHERE tenant_id=? AND user_id=?").bind(new Date().toISOString(),owner.tenant.id,owner.user!.id).run();
        if(race==='target disabled') await target.prepare('UPDATE fb_users SET disabled_at=? WHERE id=?').bind(new Date().toISOString(),player.user!.id).run();
        if(race==='target revision') await target.prepare('UPDATE fb_memberships SET capability_revision=capability_revision+1 WHERE tenant_id=? AND user_id=?').bind(owner.tenant.id,player.user!.id).run();
        if(race==='target policy changed') await target.prepare('UPDATE fb_memberships SET grant_limit=7 WHERE tenant_id=? AND user_id=?').bind(owner.tenant.id,player.user!.id).run();
        if(race==='target grant changed') await target.prepare("INSERT INTO fb_bot_admins (id,bot_id,user_id,role,capabilities_json,status,created_at) SELECT 'race-admin',id,?,'admin','[\"content\"]','revoked',? FROM fb_bots WHERE tenant_id=?").bind(player.user!.id,new Date().toISOString(),owner.tenant.id).run();
      }
      return target.batch(race==='audit failure' ? [...statements,target.prepare("SELECT json('injected_rollback')")] : statements);
    };const value=Reflect.get(target,prop,target);return typeof value==='function'?value.bind(target):value;}});
    await expect(routeApi(request,{...owner,db},path)).rejects.toThrow();
    const membership=await runtime.DB.prepare('SELECT capabilities_json,self_grants_enabled,grant_limit FROM fb_memberships WHERE tenant_id=? AND user_id=?').bind(owner.tenant.id,player.user!.id).first<{capabilities_json:string;self_grants_enabled:number;grant_limit:number}>();
    expect(membership?.capabilities_json).toBe('["content"]');
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_audit_events WHERE action='bot.admin.capabilities.updated'").first<{n:number}>())?.n).toBe(0);
  });
});
