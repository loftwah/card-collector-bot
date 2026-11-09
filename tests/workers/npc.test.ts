import { beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrap, ctxFor, fixturePool, runtime, setBalance } from "./helpers";
import {
  compareNpc,
  createNpc,
  getNpc,
  listNpcActions,
  playNpcOnce,
  previewNpcAction,
  reconcileNpcAction,
  resolveUncommittedNpcAction,
  runNpcBatch,
  runDueNpcs,
  setNpcLimits,
  setNpcStatus,
  updateNpc,
} from "../../src/server/modules/npcs";
import { createAgentGrant, createSession, login } from "../../src/server/modules/identity";
import { createGift } from "../../src/server/modules/trades";
import { requestMagicLink } from "../../src/server/modules/magic-links";
import { nowIso } from "../../src/server/db";
import { routeApi } from "../../src/server/api/router";
import { ApiError, resolveAgent, resolveSession, type Ctx } from "../../src/server/context";
import { runScheduledNpcProgression } from "../../src/server/modules/npcs";

async function ownerWithSession() {
  const owner = await ctxFor("cabinet", "owner@foilbury.local");
  const session = await createSession(owner.db, owner.tenant, owner.user!, { authMethod: "magic_link", assurance: "email" });
  const resolved = await resolveSession(owner.db, session.token);
  return { ...owner, sessionId: resolved!.sessionId, sessionAssurance: "email" };
}

async function send(ctx: Ctx, path: string, method = "GET", body?: unknown) {
  try {
    const response = await routeApi(
      new Request(`http://localhost:5173${path}`, {
        method,
        headers: { "content-type": "application/json", "x-foilbury-csrf": "test" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
      ctx,
      path.replace(/^\/api\/v1\//, ""),
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  } catch (error) {
    if (error instanceof ApiError) return { status: error.status, body: { error: { code: error.code } } };
    throw error;
  }
}

describe("persistent NPC collectors", () => {
  beforeEach(async () => {
    await bootstrap();
  });

  it("reports per-tenant scheduled failures without leaking errors and continues other tenants", async () => {
    const cabinet = await ownerWithSession();
    const harbour = await ctxFor("harbour", "harbour.owner@foilbury.test");
    await createNpc(cabinet, { name: "Schedule A", presetKey: "rookie" });
    await createNpc(harbour, { name: "Schedule B", presetKey: "rookie" });
    const logs: string[] = [];
    const logger = vi.spyOn(console, "error").mockImplementation((...args) => { logs.push(args.join(" ")); });
    const seen: string[] = [];
    try {
      const result = await runScheduledNpcProgression(cabinet.db, cabinet.media, cabinet.config, { run: async (_db, ctx) => {
        seen.push(ctx.tenant.id);
        if (ctx.tenant.id === cabinet.tenant.id) throw new Error("fixture-private-cookie");
        return { ran: 1, failed: 0, paused: false };
      } });
      expect(seen).toContain(cabinet.tenant.id);
      expect(seen).toContain(harbour.tenant.id);
      expect(result).toMatchObject({ tenants: 2, ran: 1, failed: 1 });
      expect(logs.join(" ")).toContain("scheduled.npc.tenant_failed");
      expect(logs.join(" ")).not.toContain("fixture-private-cookie");
    } finally { logger.mockRestore(); }
  });

  it("creates a clearly synthetic wallet-backed actor that cannot sign in", async () => {
    const owner = await ownerWithSession();
    const npc = await createNpc(owner, { name: "Nova Ledger", presetKey: "rookie" });
    expect(npc.synthetic_label).toBe("NPC · synthetic collector");
    expect(npc.balance).toBe(350);
    const row = await runtime.DB
      .prepare("SELECT u.is_synthetic, u.synthetic_kind, u.email, m.status, w.balance FROM fb_npc_collectors n JOIN fb_users u ON u.id = n.user_id JOIN fb_memberships m ON m.user_id = n.user_id AND m.tenant_id = n.tenant_id JOIN fb_wallets w ON w.user_id = n.user_id AND w.tenant_id = n.tenant_id WHERE n.id = ?")
      .bind(npc.id)
      .first<{ is_synthetic: number; synthetic_kind: string; email: string; status: string; balance: number }>();
    expect(row).toMatchObject({ is_synthetic: 1, synthetic_kind: "npc", status: "active", balance: 350 });
    expect(row?.email).toContain("@synthetic.invalid");
    await expect(login(owner.db, owner.tenant, row!.email, "anything")).rejects.toMatchObject({ code: "invalid_credentials" });
    const magic = await requestMagicLink(owner, { email: row!.email, purpose: "signin" });
    expect(magic.devToken).toBeUndefined();
  });

  it("plays one real draw with real serial, ledger and idempotent replay", async () => {
    const owner = await ownerWithSession();
    await fixturePool(owner);
    const npc = await createNpc(owner, { name: "Mira Circuit", presetKey: "variety_collector" });
    const preview = await previewNpcAction(owner, npc.id);
    expect(preview.allowed).toBe(true);
    expect(preview.pool).toBe("test-pool");
    expect(preview.price).toBe(80);

    const first = await playNpcOnce(owner, npc.id, "npc-action-test-001");
    expect(first.status).toBe("completed");
    expect(first.receipt.card_name).toBe("Test One");
    const receipt = first.receipt as {
      instance_id: string;
      serial: string;
      balance_after: number;
      balance_after_debit: number;
      credits_total: number;
    };
    expect(receipt.balance_after_debit).toBe(270);
    expect(receipt.credits_total).toBe(160);
    expect(receipt.balance_after).toBe(430);
    const instance = await runtime.DB
      .prepare("SELECT i.user_id, i.status, i.serial, u.is_synthetic FROM fb_card_instances i JOIN fb_users u ON u.id = i.user_id WHERE i.id = ?")
      .bind(receipt.instance_id)
      .first<{ user_id: string; status: string; serial: string; is_synthetic: number }>();
    expect(instance?.user_id).toBe((await getNpc(owner, npc.id)).row.user_id);
    expect(instance?.status).toBe("owned");
    expect(instance?.is_synthetic).toBe(1);
    expect(instance?.serial).toBe(receipt.serial);
    const ledger = await runtime.DB
      .prepare("SELECT kind, amount FROM fb_ledger_entries WHERE tenant_id = ? AND user_id = ? ORDER BY created_at")
      .bind(owner.tenant.id, instance!.user_id)
      .all<{ kind: string; amount: number }>();
    expect(ledger.results.some((row) => row.kind === "spend" && row.amount === -80)).toBe(true);

    const npcRow = (await getNpc(owner, npc.id)).row;
    const syntheticCtx = {
      ...owner,
      user: { id: npcRow.user_id, email: `npc.${npcRow.id}@synthetic.invalid`, displayName: npcRow.name, role: "player" as const, platformAdmin: false, capabilities: [], synthetic: true },
      actor: { type: "user" as const, id: npcRow.user_id, representedUserId: npcRow.user_id, label: `NPC ${npcRow.name}` },
    };
    await expect(createGift(syntheticCtx, { recipientEmail: "owner@foilbury.local", instanceId: receipt.instance_id, idempotencyKey: "npc-gift-denied" })).rejects.toMatchObject({ code: "synthetic_transfer_blocked" });
    const stillOwned = await runtime.DB.prepare("SELECT user_id FROM fb_card_instances WHERE id = ?").bind(receipt.instance_id).first<{ user_id: string }>();
    expect(stillOwned?.user_id).toBe(npcRow.user_id);

    const replay = await playNpcOnce(owner, npc.id, "npc-action-test-001");
    expect(replay.replayed).toBe(true);
    expect(replay.action_id).toBe(first.action_id);
    const summary = await getNpc(owner, npc.id);
    expect(summary.summary.cards).toBe(1);
    const achievementFoil = (first.receipt.achievements as Array<{ reward_amount: number }>).reduce((sum, item) => sum + item.reward_amount, 0);
    expect(summary.summary.balance).toBe(270 + achievementFoil);
    expect(summary.summary.actions_count).toBe(1);
  });

  it("recovers a committed draw after action finalization fails without another debit or counter increment", async () => {
    const owner = await ownerWithSession();
    await fixturePool(owner);
    const npc = await createNpc(owner, { name: "Recovery fixture", presetKey: "variety_collector", scheduleEnabled: true });
    const npcRow = (await getNpc(owner, npc.id)).row;
    const finalizers = new WeakSet<object>();
    let failures = 3;
    const db = new Proxy(runtime.DB, { get(target, key) {
      if (key === "prepare") return (sql: string) => {
        const statement = target.prepare(sql);
        if (!sql.includes("UPDATE fb_npc_actions SET status = 'completed'")) return statement;
        return new Proxy(statement, { get(inner, member) {
          if (member === "bind") return (...args: unknown[]) => { const bound = inner.bind(...args); finalizers.add(bound); return bound; };
          const value = Reflect.get(inner, member, inner);
          return typeof value === "function" ? value.bind(inner) : value;
        } });
      };
      if (key === "batch") return async (statements: Parameters<typeof target.batch>[0]) => {
        if (failures > 0 && statements.some((item) => finalizers.has(item))) { failures -= 1; throw new Error("fixture-secret-after-commit"); }
        return target.batch(statements);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    await expect(playNpcOnce({ ...owner, db }, npc.id, "npc-recovery-fixture")).rejects.toMatchObject({ code: "npc_recovery_pending" });
    const pending = await runtime.DB.prepare("SELECT status, reason FROM fb_npc_actions WHERE tenant_id = ? AND idempotency_key = 'npc-recovery-fixture'").bind(owner.tenant.id).first<{ status: string; reason: string }>();
    expect(pending?.status).toBe("planned");
    expect(pending?.reason).not.toContain("fixture-secret");
    await expect(playNpcOnce(owner, npc.id, "different-key-while-pending")).rejects.toMatchObject({ code: "npc_recovery_pending" });
    const scheduled = await runDueNpcs(owner.db, owner);
    expect(scheduled.ran).toBe(0);
    const beforeRecovery = await runtime.DB.prepare("SELECT COUNT(*) AS count FROM fb_draws WHERE tenant_id = ? AND user_id = ?").bind(owner.tenant.id, npcRow.user_id).first<{ count: number }>();
    expect(beforeRecovery?.count).toBe(1);
    await runtime.DB.prepare("UPDATE fb_npc_actions SET status = 'failed' WHERE tenant_id = ? AND idempotency_key = 'npc-recovery-fixture'").bind(owner.tenant.id).run();
    await expect(playNpcOnce(owner, npc.id, "different-key-after-legacy-failure")).rejects.toMatchObject({ code: "npc_recovery_pending" });
    const results = await Promise.all([playNpcOnce(owner, npc.id, "npc-recovery-fixture"), playNpcOnce(owner, npc.id, "npc-recovery-fixture")]);
    expect(results.every((item) => item.status === "completed" && item.replayed)).toBe(true);
    expect(results[0].receipt.instance_id).toBe(results[1].receipt.instance_id);
    const counts = await runtime.DB.prepare("SELECT (SELECT COUNT(*) FROM fb_draws WHERE tenant_id = ? AND user_id = ?) AS draws, (SELECT COUNT(*) FROM fb_card_instances WHERE tenant_id = ? AND user_id = ?) AS instances, (SELECT COUNT(*) FROM fb_ledger_entries WHERE tenant_id = ? AND user_id = ? AND kind = 'spend') AS debits, (SELECT actions_count FROM fb_npc_collectors WHERE id = ?) AS actions")
      .bind(owner.tenant.id, npcRow.user_id, owner.tenant.id, npcRow.user_id, owner.tenant.id, npcRow.user_id, npc.id).first<{ draws: number; instances: number; debits: number; actions: number }>();
    expect(counts).toEqual({ draws: 1, instances: 1, debits: 1, actions: 1 });
  });

  it("does not finalize or disclose a committed receipt after the manager session is revoked", async () => {
    const owner=await ownerWithSession();await fixturePool(owner);
    const npc=await createNpc(owner,{name:'Revoked receipt',presetKey:'rookie'});
    const npcRow=(await getNpc(owner,npc.id)).row;
    const finalizers=new WeakSet<object>();let injected=false;
    const db=new Proxy(runtime.DB,{get(target,key){
      if(key==='prepare')return (sql:string)=>{const statement=target.prepare(sql);if(!sql.includes("UPDATE fb_npc_actions SET status = 'completed'"))return statement;
        return new Proxy(statement,{get(inner,member){if(member==='bind')return (...args:unknown[])=>{const bound=inner.bind(...args);finalizers.add(bound);return bound;};const value=Reflect.get(inner,member,inner);return typeof value==='function'?value.bind(inner):value;}});};
      if(key==='batch')return async (statements:Parameters<typeof target.batch>[0])=>{if(!injected&&statements.some(item=>finalizers.has(item))){injected=true;await target.prepare('UPDATE fb_sessions SET revoked_at=? WHERE id=?').bind(nowIso(),owner.sessionId).run();}return target.batch(statements);};
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    await expect(playNpcOnce({...owner,db},npc.id,'receipt-revoked-key')).rejects.toMatchObject({code:'npc_recovery_pending'});
    expect((await runtime.DB.prepare('SELECT COUNT(*) n FROM fb_draws WHERE tenant_id=? AND user_id=?').bind(owner.tenant.id,npcRow.user_id).first<{n:number}>())?.n).toBe(1);
    expect((await getNpc(await ownerWithSession(),npc.id)).row.actions_count).toBe(0);
    await expect(playNpcOnce(owner,npc.id,'receipt-revoked-key')).rejects.toMatchObject({code:'npc_management_changed'});
    const recovered=await playNpcOnce(await ownerWithSession(),npc.id,'receipt-revoked-key');
    expect(recovered).toMatchObject({status:'completed',replayed:true});
    expect((await getNpc(await ownerWithSession(),npc.id)).row.actions_count).toBe(1);
  });

  it("does not finalize a committed receipt after the exact agent token is rotated", async () => {
    const owner=await ownerWithSession();await fixturePool(owner);
    const npc=await createNpc(owner,{name:'Rotated receipt',presetKey:'rookie'});
    const npcRow=(await getNpc(owner,npc.id)).row;
    const grant=await createAgentGrant(owner,{agentName:'Receipt recovery agent',representedUserId:owner.user!.id,scopes:['npc:read','npc:write'],expiresInDays:1});
    const principal=await resolveAgent(owner.db,owner.config,grant.token,owner.tenant);
    const agent:Ctx={...owner,...principal,agentCredential:principal.credential,sessionId:null};
    const finalizers=new WeakSet<object>();let injected=false;
    const db=new Proxy(runtime.DB,{get(target,key){
      if(key==='prepare')return (sql:string)=>{const statement=target.prepare(sql);if(!sql.includes("UPDATE fb_npc_actions SET status = 'completed'"))return statement;
        return new Proxy(statement,{get(inner,member){if(member==='bind')return (...args:unknown[])=>{const bound=inner.bind(...args);finalizers.add(bound);return bound;};const value=Reflect.get(inner,member,inner);return typeof value==='function'?value.bind(inner):value;}});};
      if(key==='batch')return async (statements:Parameters<typeof target.batch>[0])=>{if(!injected&&statements.some(item=>finalizers.has(item))){injected=true;await target.prepare('UPDATE fb_agent_tokens SET token_hash=? WHERE id=?').bind('rotated-receipt-token',principal.credential.tokenId).run();}return target.batch(statements);};
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    await expect(playNpcOnce({...agent,db},npc.id,'agent-receipt-key')).rejects.toMatchObject({code:'npc_recovery_pending'});
    expect((await runtime.DB.prepare('SELECT COUNT(*) n FROM fb_draws WHERE tenant_id=? AND user_id=?').bind(owner.tenant.id,npcRow.user_id).first<{n:number}>())?.n).toBe(1);
    expect((await getNpc(owner,npc.id)).row.actions_count).toBe(0);
    await expect(playNpcOnce(agent,npc.id,'agent-receipt-key')).rejects.toMatchObject({code:'npc_management_changed'});
    expect(await playNpcOnce(owner,npc.id,'agent-receipt-key')).toMatchObject({status:'completed',replayed:true});
    expect((await getNpc(owner,npc.id)).row.actions_count).toBe(1);
  });

  it("handles simultaneous first submissions of the same NPC action key without another draw", async () => {
    const owner = await ownerWithSession();
    await fixturePool(owner);
    const npc = await createNpc(owner, { name: "Concurrent fixture", presetKey: "variety_collector" });
    const npcRow = (await getNpc(owner, npc.id)).row;
    const results = await Promise.all([playNpcOnce(owner, npc.id, "same-initial-key"), playNpcOnce(owner, npc.id, "same-initial-key")]);
    expect(results.every((item) => ["planned", "completed"].includes(item.status))).toBe(true);
    const recovered = await playNpcOnce(owner, npc.id, "same-initial-key");
    expect(recovered.status).toBe("completed");
    const count = await runtime.DB.prepare("SELECT COUNT(*) AS count FROM fb_draws WHERE tenant_id = ? AND user_id = ?").bind(owner.tenant.id, npcRow.user_id).first<{ count: number }>();
    expect(count?.count).toBe(1);
    expect((await getNpc(owner, npc.id)).row.actions_count).toBe(1);
  });

  it("reserves the last daily slot atomically across two NPCs", async () => {
    const owner = await ownerWithSession();
    await fixturePool(owner);
    const first = await createNpc(owner, { name: "Quota one", presetKey: "variety_collector" });
    const second = await createNpc(owner, { name: "Quota two", presetKey: "variety_collector" });
    await setNpcLimits(owner, { maxDrawsPerDay: 1 });
    const outcomes = await Promise.allSettled([playNpcOnce(owner, first.id, "quota-one"), playNpcOnce(owner, second.id, "quota-two")]);
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    const count = await runtime.DB.prepare("SELECT COUNT(*) AS count FROM fb_draws d JOIN fb_npc_collectors n ON n.user_id = d.user_id WHERE d.tenant_id = ?").bind(owner.tenant.id).first<{ count: number }>();
    expect(count?.count).toBe(1);
  });

  it.each(["pause", "quota"])("fences %s changes at the draw transaction", async (mode) => {
    const owner = await ownerWithSession();
    await fixturePool(owner);
    const npc = await createNpc(owner, { name: "Commit guard fixture", presetKey: "variety_collector" });
    const npcRow = (await getNpc(owner, npc.id)).row;
    const guards = new WeakSet<object>();
    const db = new Proxy(runtime.DB, { get(target, key) {
      if (key === "prepare") return (sql: string) => {
        const statement = target.prepare(sql);
        if (!sql.includes("json('npc_guard_rejected')")) return statement;
        return new Proxy(statement, { get(inner, member) {
          if (member === "bind") return (...args: unknown[]) => { const bound = inner.bind(...args); guards.add(bound); return bound; };
          const value = Reflect.get(inner, member, inner);
          return typeof value === "function" ? value.bind(inner) : value;
        } });
      };
      if (key === "batch") return async (statements: Parameters<typeof target.batch>[0]) => {
        if (statements.some((item) => guards.has(item))) {
          if (mode === "pause") await target.prepare("UPDATE fb_npc_limits SET paused_all = 1 WHERE tenant_id = ?").bind(owner.tenant.id).run();
          else await target.prepare("UPDATE fb_npc_limits SET max_draws_per_day = 0 WHERE tenant_id = ?").bind(owner.tenant.id).run();
        }
        return target.batch(statements);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const resolved = await playNpcOnce({ ...owner, db }, npc.id, `commit-${mode}`);
    expect(resolved.status).toBe("skipped");
    expect(resolved.receipt).toEqual({ resolution: "no_draw_committed" });
    const replay = await playNpcOnce(owner, npc.id, `commit-${mode}`);
    expect(replay).toMatchObject({ replayed: true, action_id: resolved.action_id, status: "skipped" });
    const count = await runtime.DB.prepare("SELECT COUNT(*) AS count FROM fb_draws WHERE tenant_id = ? AND user_id = ?").bind(owner.tenant.id, npcRow.user_id).first<{ count: number }>();
    expect(count?.count).toBe(0);
  });

  it.each(["resolution-first", "draw-first"])("serializes %s against the same NPC draw and preserves replay", async (order) => {
    const owner = await ownerWithSession();
    await fixturePool(owner);
    const npc = await createNpc(owner, { name: `Resolution ${order}`, presetKey: "variety_collector" });
    const npcRow = (await getNpc(owner, npc.id)).row;
    const actionKey = `race-${order}`;
    const guards = new WeakSet<object>();
    let resolution: unknown;
    const db = new Proxy(runtime.DB, { get(target, key) {
      if (key === "prepare") return (sql: string) => {
        const statement = target.prepare(sql);
        if (!sql.includes("json('npc_guard_rejected')")) return statement;
        return new Proxy(statement, { get(inner, member) {
          if (member === "bind") return (...args: unknown[]) => { const bound = inner.bind(...args); guards.add(bound); return bound; };
          const value = Reflect.get(inner, member, inner);
          return typeof value === "function" ? value.bind(inner) : value;
        } });
      };
      if (key === "batch") return async (statements: Parameters<typeof target.batch>[0]) => {
        if (!statements.some((item) => guards.has(item))) return target.batch(statements);
        const action = await target.prepare("SELECT id FROM fb_npc_actions WHERE tenant_id=? AND idempotency_key=?").bind(owner.tenant.id, actionKey).first<{ id: string }>();
        if (order === "resolution-first") resolution = await resolveUncommittedNpcAction(owner, npcRow, action!.id, actionKey);
        const result = await target.batch(statements);
        if (order === "draw-first") resolution = await resolveUncommittedNpcAction(owner, npcRow, action!.id, actionKey);
        return result;
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const result = await playNpcOnce({ ...owner, db }, npc.id, actionKey);
    const expected = order === "resolution-first" ? "skipped" : "completed";
    expect(result.status).toBe(expected);
    expect(resolution).toEqual(order === "resolution-first" ? { resolution: "no_draw_committed" } : null);
    const replay = await playNpcOnce(owner, npc.id, actionKey);
    expect(replay).toMatchObject({ replayed: true, status: expected, action_id: result.action_id });
    const counts = await runtime.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM fb_draws WHERE tenant_id=? AND user_id=?) AS draws,
      (SELECT COUNT(*) FROM fb_ledger_entries WHERE tenant_id=? AND user_id=? AND kind='spend') AS debits,
      (SELECT COUNT(*) FROM fb_audit_events WHERE tenant_id=? AND action='npc.action_resolved' AND object_id=?) AS audits`)
      .bind(owner.tenant.id, npcRow.user_id, owner.tenant.id, npcRow.user_id, owner.tenant.id, result.action_id).first<{ draws: number; debits: number; audits: number }>();
    expect(counts).toEqual(order === "resolution-first" ? { draws: 0, debits: 0, audits: 1 } : { draws: 1, debits: 1, audits: 0 });
  });

  it("rolls back the resolution when its audit cannot commit", async () => {
    const owner = await ownerWithSession();
    const npc = await createNpc(owner, { name: "Audit rollback", presetKey: "variety_collector" });
    const row = (await getNpc(owner, npc.id)).row;
    await runtime.DB.prepare("INSERT INTO fb_npc_actions (id,tenant_id,npc_id,action,status,idempotency_key,created_at) VALUES (?,?,?,'draw','planned',?,?)")
      .bind("npca_audit_rollback", owner.tenant.id, npc.id, "audit-rollback", nowIso()).run();
    await runtime.DB.prepare("CREATE TRIGGER npc_resolution_audit_fail BEFORE INSERT ON fb_audit_events WHEN NEW.action='npc.action_resolved' BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END").run();
    try {
      await expect(resolveUncommittedNpcAction(owner, row, "npca_audit_rollback", "audit-rollback")).rejects.toThrow();
      const action = await runtime.DB.prepare("SELECT status FROM fb_npc_actions WHERE id='npca_audit_rollback'").first<{ status: string }>();
      expect(action?.status).toBe("planned");
    } finally { await runtime.DB.prepare("DROP TRIGGER npc_resolution_audit_fail").run(); }
  });

  it.each(['planned','failed'])("holds a %s action when only its historical ledger evidence remains", async (status) => {
    const owner = await ownerWithSession();
    const npc = await createNpc(owner, { name: 'Ledger evidence', presetKey: 'variety_collector' });
    const row = (await getNpc(owner, npc.id)).row;
    const key = 'ledger-evidence-key';
    await runtime.DB.prepare("INSERT INTO fb_npc_actions (id,tenant_id,npc_id,action,status,idempotency_key,created_at) VALUES (?,?,?,'draw',?,?,?)").bind('npca_ledger',owner.tenant.id,npc.id,status,key,nowIso()).run();
    await runtime.DB.prepare(`INSERT INTO fb_ledger_entries (id,tenant_id,user_id,kind,amount,balance_after,reference_type,reference_id,description,idempotency_key,metadata_json,actor_type,actor_id,created_at)
      VALUES (?,?,?,'spend',-1,0,'draw','historical-draw','Historical fixture',?,'{}','user',?,?)`)
      .bind('ledger_npc_evidence',owner.tenant.id,row.user_id,`npc:${npc.id}:${key}`,row.user_id,nowIso()).run();
    expect(await reconcileNpcAction(owner,npc.id,key)).toMatchObject({status,resolution:'pending'});
    expect((await runtime.DB.prepare("SELECT status FROM fb_npc_actions WHERE id='npca_ledger'").first<{status:string}>())?.status).toBe(status);
  });

  it("explicitly resolves an evidence-free legacy failure while preserving its prior history", async () => {
    const owner = await ownerWithSession();
    const npc = await createNpc(owner, { name: 'Legacy recovery', presetKey: 'variety_collector' });
    const oldTime = '2020-01-01T00:00:00.000Z';
    await runtime.DB.prepare("INSERT INTO fb_npc_actions (id,tenant_id,npc_id,action,status,reason,idempotency_key,created_at,completed_at,after_json) VALUES (?,?,?,'draw','failed',?,?,?,?,'{}')")
      .bind('npca_legacy_empty',owner.tenant.id,npc.id,'Old failure retained','legacy-empty-key',oldTime,oldTime).run();
    const response=await send(owner,`/api/v1/npcs/${npc.id}/reconcile`,'POST',{actionId:'npca_legacy_empty'});
    expect(response.status).toBe(200);expect(response.body).toMatchObject({status:'skipped',resolution:'no_draw_committed'});
    const action=await runtime.DB.prepare("SELECT status,reason,after_json FROM fb_npc_actions WHERE id='npca_legacy_empty'").first<{status:string;reason:string;after_json:string}>();
    expect(action?.status).toBe('skipped');expect(action?.reason).toBe('Old failure retained');
    expect(JSON.parse(action!.after_json)).toMatchObject({resolution:'no_draw_committed',previous_status:'failed',previous_after_json:'{}',previous_completed_at:oldTime});
    const audit=await runtime.DB.prepare("SELECT metadata_json FROM fb_audit_events WHERE action='npc.action_resolved' AND object_id='npca_legacy_empty'").first<{metadata_json:string}>();
    expect(JSON.parse(audit!.metadata_json)).toMatchObject({previous_status:'failed'});
    expect(await playNpcOnce(owner,npc.id,'legacy-empty-key')).toMatchObject({replayed:true,status:'skipped'});
    expect((await reconcileNpcAction(owner,npc.id,'legacy-empty-key')).status).toBe('skipped');
  });

  it("keeps ambiguous legacy action evidence unresolved", async () => {
    const owner = await ownerWithSession();
    const npc = await createNpc(owner, { name: 'Ambiguous legacy', presetKey: 'variety_collector' });
    await runtime.DB.prepare("INSERT INTO fb_npc_actions (id,tenant_id,npc_id,action,status,idempotency_key,created_at,after_json) VALUES (?,?,?,'draw','failed',?,?,?)")
      .bind('npca_legacy_ambiguous',owner.tenant.id,npc.id,'legacy-ambiguous',nowIso(),'{"prior":"evidence"}').run();
    expect(await reconcileNpcAction(owner,npc.id,'legacy-ambiguous')).toMatchObject({status:'failed',resolution:'pending'});
    expect((await runtime.DB.prepare("SELECT after_json FROM fb_npc_actions WHERE id='npca_legacy_ambiguous'").first<{after_json:string}>())?.after_json).toBe('{"prior":"evidence"}');
  });

  it("requires explicit live authority to reconcile an old planned action and keeps retries idempotent", async () => {
    const owner = await ownerWithSession();
    const npc = await createNpc(owner, { name: "Old action", presetKey: "variety_collector" });
    await runtime.DB.prepare("INSERT INTO fb_npc_actions (id,tenant_id,npc_id,action,status,idempotency_key,created_at) VALUES (?,?,?,'draw','planned',?,?)")
      .bind("npca_old", owner.tenant.id, npc.id, "old-action-key", nowIso()).run();
    const normal = await playNpcOnce(owner, npc.id, "old-action-key");
    expect(normal).toMatchObject({ status: "planned", recovery_pending: true });
    const db = new Proxy(runtime.DB, { get(target, key) {
      if (key === 'batch') return async (statements: Parameters<typeof target.batch>[0]) => {
        await target.prepare("UPDATE fb_sessions SET revoked_at=? WHERE id=?").bind(nowIso(), owner.sessionId).run();
        return target.batch(statements);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    await expect(reconcileNpcAction({ ...owner, db }, npc.id, "old-action-key")).rejects.toMatchObject({ code: 'npc_action_unavailable' });
    expect((await runtime.DB.prepare("SELECT status FROM fb_npc_actions WHERE id='npca_old'").first<{status:string}>())?.status).toBe('planned');
    const live = await ownerWithSession();
    expect(await reconcileNpcAction(live, npc.id, "old-action-key")).toMatchObject({ status: 'skipped', resolution: 'no_draw_committed' });
    expect(await reconcileNpcAction(live, npc.id, "old-action-key")).toMatchObject({ status: 'skipped', resolution: 'no_draw_committed' });
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_audit_events WHERE action='npc.action_resolved' AND object_id='npca_old'").first<{n:number}>())?.n).toBe(1);
    expect(await playNpcOnce(live, npc.id, "old-action-key")).toMatchObject({ replayed: true, status: 'skipped' });
  });

  it.each(['revoke','rotate'])("binds agent reconciliation to its exact live grant and token on %s", async (change) => {
    const owner = await ownerWithSession();
    const npc = await createNpc(owner, { name: "Agent recovery", presetKey: "variety_collector" });
    const grant = await createAgentGrant(owner, { agentName: 'NPC recovery agent', representedUserId: owner.user!.id, scopes: ['npc:read', 'npc:write'], expiresInDays: 1 });
    const resolved = await resolveAgent(owner.db, owner.config, grant.token, owner.tenant);
    const agent: Ctx = { ...owner, ...resolved, agentCredential: resolved.credential, sessionId: null };
    for (const [id, key] of [['npca_agent_ok', 'agent-recover-ok'], ['npca_agent_revoked', 'agent-recover-revoked']])
      await runtime.DB.prepare("INSERT INTO fb_npc_actions (id,tenant_id,npc_id,action,status,idempotency_key,created_at) VALUES (?,?,?,'draw','planned',?,?)")
        .bind(id, owner.tenant.id, npc.id, key, nowIso()).run();
    const response = await send(agent, `/api/v1/npcs/${npc.id}/reconcile`, 'POST', { actionId: 'npca_agent_ok' });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'skipped', resolution: 'no_draw_committed' });
    const db = new Proxy(runtime.DB, { get(target, key) {
      if (key === 'batch') return async (statements: Parameters<typeof target.batch>[0]) => {
        if (change === 'revoke') await target.prepare('UPDATE fb_agent_tokens SET revoked_at=? WHERE id=?').bind(nowIso(), resolved.credential.tokenId).run();
        else await target.prepare('UPDATE fb_agent_tokens SET token_hash=? WHERE id=?').bind('rotated-token-hash', resolved.credential.tokenId).run();
        return target.batch(statements);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    await expect(reconcileNpcAction({ ...agent, db }, npc.id, 'agent-recover-revoked')).rejects.toMatchObject({ code: 'npc_action_unavailable' });
    expect((await runtime.DB.prepare("SELECT status FROM fb_npc_actions WHERE id='npca_agent_revoked'").first<{status:string}>())?.status).toBe('planned');
  });

  it("records skip reasons without spending when funds or daily limits are exhausted", async () => {
    const owner = await ownerWithSession();
    await fixturePool(owner);
    const npc = await createNpc(owner, { name: "Slow Orbit", presetKey: "rookie", startingBalance: 0 });
    await setBalance(owner, (await getNpc(owner, npc.id)).row.user_id, 0);
    await expect(playNpcOnce(owner, npc.id, "npc-broke-001")).rejects.toMatchObject({ code: "npc_insufficient_funds" });
    const actions = await listNpcActions(owner, npc.id);
    expect(actions[0]?.status).toBe("skipped");
    expect(actions[0]?.reason).toContain("costs 80");

    await setBalance(owner, (await getNpc(owner, npc.id)).row.user_id, 1000);
    await setNpcLimits(owner, { maxDrawsPerDay: 1 });
    const first = await playNpcOnce(owner, npc.id, "npc-limit-001");
    expect(first.status).toBe("completed");
    await expect(playNpcOnce(owner, npc.id, "npc-limit-002")).rejects.toMatchObject({ code: "npc_skipped" });
    expect((await getNpc(owner, npc.id)).summary.cards).toBe(1);
  });

  it("pauses, resumes, retires and pauses every NPC on the Bot", async () => {
    const owner = await ownerWithSession();
    await fixturePool(owner);
    const npc = await createNpc(owner, { name: "Kite Runner", presetKey: "gold_hunter" });
    await setNpcStatus(owner, npc.id, "paused");
    await expect(playNpcOnce(owner, npc.id, "npc-paused-001")).rejects.toMatchObject({ code: "npc_skipped" });
    await setNpcStatus(owner, npc.id, "active");
    await setNpcLimits(owner, { pausedAll: true });
    expect((await previewNpcAction(owner, npc.id)).allowed).toBe(false);
    await setNpcLimits(owner, { pausedAll: false });
    const played = await playNpcOnce(owner, npc.id, "npc-resumed-001");
    expect(played.status).toBe("completed");
    await setNpcStatus(owner, npc.id, "retired");
    await expect(playNpcOnce(owner, npc.id, "npc-retired-001")).rejects.toMatchObject({ code: "npc_skipped" });
    await expect(setNpcStatus(owner, npc.id, "active")).rejects.toMatchObject({ code: "npc_retired" });
    const summary = await getNpc(owner, npc.id);
    expect(summary.summary.cards).toBe(1);
    expect(summary.summary.status).toBe("retired");
  });

  it("keeps Bot authority separate from collection scope and cross-Bot ids", async () => {
    const owner = await ownerWithSession();
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const npc = await createNpc(owner, { name: "Scope Guard", presetKey: "casual_explorer" });
    await expect(createNpc(player, { name: "Not Allowed", presetKey: "rookie" })).rejects.toMatchObject({ code: "npc_management_required" });
    await expect(getNpc(await ctxFor("harbour", "harbour.owner@foilbury.test"), npc.id)).rejects.toMatchObject({ code: "npc_not_found" });

    const scoped: typeof owner = {
      ...player,
      user: { ...player.user!, platformRoles: ["global_collection_admin"], globalCollectionScope: { all: true, collectionIds: [] } },
    };
    await expect(createNpc(scoped, { name: "Collection Scope", presetKey: "rookie" })).rejects.toMatchObject({ code: "npc_management_required" });
  });

  it("enforces agent read/write scopes and preserves real records on denial", async () => {
    const owner = await ownerWithSession();
    await fixturePool(owner);
    const npc = await createNpc(owner, { name: "Agent Test", presetKey: "rookie" });
    const readOnly = {
      ...owner,
      actor: { type: "agent" as const, id: "grant_npc_read", representedUserId: owner.user!.id, label: "Read agent" },
      scopes: ["npc:read"],
    };
    await expect(playNpcOnce(readOnly, npc.id, "npc-agent-denied")).rejects.toMatchObject({ code: "insufficient_scope" });
    expect((await getNpc(owner, npc.id)).summary.cards).toBe(0);
    const grant = await createAgentGrant(owner, { agentName: 'NPC writer', representedUserId: owner.user!.id, scopes: ['npc:read','npc:write'], expiresInDays: 1 });
    const principal = await resolveAgent(owner.db, owner.config, grant.token, owner.tenant);
    const write = { ...owner, ...principal, agentCredential: principal.credential, sessionId: null };
    const played = await playNpcOnce(write, npc.id, "npc-agent-allowed");
    expect(played.status).toBe("completed");
  });

  it("exposes exact Bot-scoped HTTP routes and scheduled progression", async () => {
    const owner = await ownerWithSession();
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await fixturePool(owner);
    const denied = await send(player, "/api/v1/npcs/admin");
    expect(denied.status).toBe(403);
    const created = await send(owner, "/api/v1/npcs", "POST", { name: "HTTP Collector", presetKey: "rookie" });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    const admin = await send(owner, "/api/v1/npcs/admin");
    expect(admin.status).toBe(200);
    expect((admin.body.items as Array<{ id: string }>).some((item) => item.id === id)).toBe(true);
    const preview = await send(owner, `/api/v1/npcs/${id}/preview`, "POST", {});
    expect(preview.status).toBe(200);
    expect(preview.body.allowed).toBe(true);
    const unknown = await send(owner, `/api/v1/npcs/${id}/not-a-real-action`, "POST", {});
    expect(unknown.status).toBe(404);
    const played = await send(owner, `/api/v1/npcs/${id}/play`, "POST", { idempotencyKey: "npc-http-play-001" });
    expect(played.status).toBe(200);
    const replay = await send(owner, `/api/v1/npcs/${id}/play`, "POST", { idempotencyKey: "npc-http-play-001" });
    expect(replay.body.replayed).toBe(true);

    const scheduled = await createNpc(owner, { name: "Scheduled Actor", presetKey: "variety_collector", scheduleEnabled: true, intervalMinutes: 60 });
    await runtime.DB.prepare("UPDATE fb_npc_collectors SET last_action_at = ? WHERE id = ?").bind(new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), scheduled.id).run();
    const run = await runScheduledNpcProgression(owner.db, owner.media, owner.config);
    expect(run.ran).toBeGreaterThanOrEqual(1);
    const after = await getNpc(owner, scheduled.id);
    expect(after.summary.actions_count).toBeGreaterThanOrEqual(1);
    expect(after.summary.last_action_at).toBeTruthy();
  });

  it("updates goals, compares against the viewer and runs a bounded batch", async () => {
    const owner = await ownerWithSession();
    await fixturePool(owner);
    const npc = await createNpc(owner, { name: "Batch Friend", presetKey: "completionist" });
    const updated = await updateNpc(owner, npc.id, { goalCollectionId: "col_test_public", intervalMinutes: 120, scheduleEnabled: true });
    expect(updated.goals.collection_id).toBe("col_test_public");
    expect(updated.schedule.interval_minutes).toBe(120);
    const comparison = await compareNpc(owner, npc.id);
    expect(comparison.labels.npc).toContain("NPC");
    expect(comparison.viewer.display_name).toBe(owner.user!.displayName);
    const batch = await runNpcBatch(owner, npc.id, 2);
    expect(batch.requested).toBe(2);
    // Only one eligible card exists in the fixture pool, so the second action
    // may still draw a duplicate; both are real draws and never exceed the cap.
    expect(batch.results.filter((item) => item.status === "completed").length).toBeGreaterThan(0);
    const summary = await getNpc(owner, npc.id);
    expect(summary.summary.actions_count).toBeGreaterThan(0);
    expect(summary.summary.last_action_at).toBeTruthy();
    const after = await runtime.DB
      .prepare("SELECT COUNT(*) AS count FROM fb_npc_actions WHERE tenant_id = ? AND npc_id = ? AND status = 'completed'")
      .bind(owner.tenant.id, npc.id)
      .first<{ count: number }>();
    expect(after?.count ?? 0).toBe(summary.summary.actions_count);
    expect(new Date(summary.summary.last_action_at!).getTime()).toBeLessThanOrEqual(Date.now());
    expect(nowIso()).toBeTruthy();
  });
});
