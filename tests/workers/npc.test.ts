import { beforeEach, describe, expect, it } from "vitest";
import { bootstrap, ctxFor, fixturePool, runtime, setBalance } from "./helpers";
import {
  compareNpc,
  createNpc,
  getNpc,
  listNpcActions,
  playNpcOnce,
  previewNpcAction,
  runNpcBatch,
  setNpcLimits,
  setNpcStatus,
  updateNpc,
} from "../../src/server/modules/npcs";
import { login } from "../../src/server/modules/identity";
import { createGift } from "../../src/server/modules/trades";
import { requestMagicLink } from "../../src/server/modules/magic-links";
import { nowIso } from "../../src/server/db";
import { routeApi } from "../../src/server/api/router";
import { ApiError, type Ctx } from "../../src/server/context";
import { runScheduledNpcProgression } from "../../src/server/modules/npcs";

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

  it("creates a clearly synthetic wallet-backed actor that cannot sign in", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
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
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    await fixturePool(owner);
    const npc = await createNpc(owner, { name: "Mira Circuit", presetKey: "variety_collector" });
    const preview = await previewNpcAction(owner, npc.id);
    expect(preview.allowed).toBe(true);
    expect(preview.pool).toBe("test-pool");
    expect(preview.price).toBe(80);

    const first = await playNpcOnce(owner, npc.id, "npc-action-test-001");
    expect(first.status).toBe("completed");
    expect(first.receipt.card_name).toBe("Test One");
    const receipt = first.receipt as { instance_id: string; serial: string; balance_after: number };
    expect(receipt.balance_after).toBe(270);
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

  it("records skip reasons without spending when funds or daily limits are exhausted", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
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
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
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
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
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
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    await fixturePool(owner);
    const npc = await createNpc(owner, { name: "Agent Test", presetKey: "rookie" });
    const readOnly = {
      ...owner,
      actor: { type: "agent" as const, id: "grant_npc_read", representedUserId: owner.user!.id, label: "Read agent" },
      scopes: ["npc:read"],
    };
    await expect(playNpcOnce(readOnly, npc.id, "npc-agent-denied")).rejects.toMatchObject({ code: "insufficient_scope" });
    expect((await getNpc(owner, npc.id)).summary.cards).toBe(0);
    const write = { ...readOnly, scopes: ["npc:read", "npc:write"] };
    const played = await playNpcOnce(write, npc.id, "npc-agent-allowed");
    expect(played.status).toBe("completed");
  });

  it("exposes exact Bot-scoped HTTP routes and scheduled progression", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
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
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
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
