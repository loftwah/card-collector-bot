import { beforeEach, describe, expect, it } from "vitest";
import { bootstrap, ctxFor, fixturePool, makeInstance, runtime, setBalance, walletBalance } from "./helpers";
import { claimDailyMission, getDailyMissions, recordDailyInteraction, utcDayKey } from "../../src/server/modules/missions";
import { recordCollectionExploration } from "../../src/server/modules/achievements";
import { createNpc } from "../../src/server/modules/npcs";
import { routeApi } from "../../src/server/api/router";
import { ApiError, type Ctx } from "../../src/server/context";

async function seedOwnedCard(player: Ctx) {
  const fixture = await fixturePool(player);
  await makeInstance(player, player.user!.id, fixture, `MISSION-${Math.random().toString(36).slice(2, 10)}`);
  return fixture;
}

function backdateEvent(userId: string, tenantId: string, eventType: string, iso: string) {
  return runtime.DB.prepare(
    `INSERT INTO fb_domain_events (id, tenant_id, user_id, event_type, object_type, object_id, dedupe_key, payload_json, created_at)
     VALUES (?, ?, ?, ?, 'test', 'test', ?, '{}', ?)`,
  )
    .bind(`evt_${Math.random().toString(36).slice(2)}`, tenantId, userId, eventType, `backdate:${eventType}:${Math.random()}`, iso)
    .run();
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

describe("daily missions", () => {
  beforeEach(async () => {
    await bootstrap();
  });

  it("assigns a short, stable set with real progress and reset data", async () => {
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await seedOwnedCard(player);
    const state = await getDailyMissions(player);
    expect(state.missions.map((mission) => mission.key)).toEqual(["explore", "inspect", "open"]);
    expect(state.cap).toBe(180);
    expect(state.day).toBe(utcDayKey());
    expect(state.reset_local).toMatch(/Melbourne|AEDT|AEST/i);
    expect(state.reset_at.endsWith("T00:00:00.000Z")).toBe(true);
    expect(state.missions.every((mission) => mission.progress === 0 && !mission.complete && !mission.claimed)).toBe(true);
  });

  it("does not credit an incomplete mission and does credit one completed mission exactly once", async () => {
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await seedOwnedCard(player);
    const before = await walletBalance(player, player.user!.id);
    await expect(claimDailyMission(player, "explore")).rejects.toMatchObject({ code: "mission_incomplete" });
    expect(await walletBalance(player, player.user!.id)).toBe(before);

    await recordCollectionExploration(player, "col_test_public");
    const ready = await getDailyMissions(player);
    const explore = ready.missions.find((mission) => mission.key === "explore")!;
    expect(explore.complete).toBe(true);
    expect(explore.claimable).toBe(true);
    const first = await claimDailyMission(player, "explore", "mission-test-1");
    expect(first.amount).toBe(60);
    expect(first.replayed).toBe(false);
    expect(await walletBalance(player, player.user!.id)).toBe(before + 60);
    const replay = await claimDailyMission(player, "explore", "mission-test-1");
    expect(replay.replayed).toBe(true);
    expect(replay.claim_id).toBe(first.claim_id);
    expect(await walletBalance(player, player.user!.id)).toBe(before + 60);
    const claims = await runtime.DB
      .prepare("SELECT COUNT(*) AS count FROM fb_reward_claims WHERE tenant_id = ? AND user_id = ? AND rule_key = ?")
      .bind(player.tenant.id, player.user!.id, `${ready.period_key}:explore`)
      .first<{ count: number }>();
    expect(claims?.count).toBe(1);
    const ledger = await runtime.DB
      .prepare("SELECT description, amount FROM fb_ledger_entries WHERE tenant_id = ? AND user_id = ? AND idempotency_key = ?")
      .bind(player.tenant.id, player.user!.id, `mission:${ready.period_key}:explore`)
      .first<{ description: string; amount: number }>();
    expect(ledger).toMatchObject({ description: "Daily mission reward", amount: 60 });
  });

  it("is safe under concurrent claims", async () => {
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await seedOwnedCard(player);
    await recordCollectionExploration(player, "col_test_public");
    const before = await walletBalance(player, player.user!.id);
    const results = await Promise.allSettled([
      claimDailyMission(player, "explore", "mission-race-a"),
      claimDailyMission(player, "explore", "mission-race-b"),
    ]);
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect(await walletBalance(player, player.user!.id)).toBe(before + 60);
    const claims = await runtime.DB
      .prepare("SELECT COUNT(DISTINCT rule_key || period_key) AS count FROM fb_reward_claims WHERE tenant_id = ? AND user_id = ? AND rule_key LIKE '%:explore'")
      .bind(player.tenant.id, player.user!.id)
      .first<{ count: number }>();
    expect(claims?.count).toBe(1);
  });

  it("counts a deliberate inspect/favourite once per day, not on every reload or toggle", async () => {
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const fixture = await seedOwnedCard(player);
    await setBalance(player, player.user!.id, 0);
    await recordDailyInteraction(player, "card.inspected", fixture.cardId);
    await recordDailyInteraction(player, "card.inspected", fixture.cardId);
    await recordDailyInteraction(player, "card.favourited", fixture.cardId);
    await recordDailyInteraction(player, "card.favourited", fixture.cardId);
    const state = await getDailyMissions(player);
    expect(state.missions.find((mission) => mission.key === "inspect")?.progress).toBe(1);
    expect(state.missions.find((mission) => mission.key === "favourite")?.progress).toBe(1);
    const events = await runtime.DB
      .prepare("SELECT event_type, COUNT(*) AS count FROM fb_domain_events WHERE user_id = ? AND event_type IN ('card.inspected','card.favourited') GROUP BY event_type")
      .bind(player.user!.id)
      .all<{ event_type: string; count: number }>();
    expect(events.results.find((row) => row.event_type === "card.inspected")?.count).toBe(1);
    expect(events.results.find((row) => row.event_type === "card.favourited")?.count).toBe(1);
  });

  it("keeps the day's assignment stable when the balance changes", async () => {
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await seedOwnedCard(player);
    const before = await getDailyMissions(player);
    expect(before.missions.map((mission) => mission.key)).toContain("open");
    await setBalance(player, player.user!.id, 0);
    const after = await getDailyMissions(player);
    expect(after.missions.map((mission) => mission.key)).toEqual(before.missions.map((mission) => mission.key));
    expect(after.missions.find((mission) => mission.key === "open")?.version).toBe(1);
  });

  it("gives fewer missions when the player has no cards or funds", async () => {
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await setBalance(player, player.user!.id, 0);
    const state = await getDailyMissions(player);
    expect(state.missions.map((mission) => mission.key)).toEqual(["explore"]);
    expect(state.missions[0]?.claimed).toBe(false);
  });

  it("does not carry yesterday's progress into today", async () => {
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await seedOwnedCard(player);
    const yesterday = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
    await backdateEvent(player.user!.id, player.tenant.id, "collection.explored", yesterday);
    await backdateEvent(player.user!.id, player.tenant.id, "card.inspected", yesterday);
    const state = await getDailyMissions(player);
    expect(state.missions.find((mission) => mission.key === "explore")?.progress).toBe(0);
    expect(state.missions.find((mission) => mission.key === "inspect")?.progress).toBe(0);
  });

  it("rejects synthetic NPCs from the human mission loop", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const npc = await createNpc(owner, { name: "Missionless NPC", presetKey: "rookie" });
    const npcUser = await runtime.DB
      .prepare("SELECT u.id, u.email, u.display_name FROM fb_users u JOIN fb_npc_collectors n ON n.user_id = u.id WHERE n.id = ?")
      .bind(npc.id)
      .first<{ id: string; email: string; display_name: string }>();
    const npcCtx: Ctx = {
      ...owner,
      user: { id: npcUser!.id, email: npcUser!.email, displayName: npcUser!.display_name, role: "player", platformAdmin: false, capabilities: [], synthetic: true },
      actor: { type: "user", id: npcUser!.id, representedUserId: npcUser!.id, label: `NPC ${npcUser!.display_name}` },
    };
    await expect(getDailyMissions(npcCtx)).rejects.toMatchObject({ code: "synthetic_mission_blocked" });
  });

  it("enforces named read and claim scopes through the real router", async () => {
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await seedOwnedCard(player);
    await recordCollectionExploration(player, "col_test_public");
    const readOnly: Ctx = { ...player, actor: { type: "agent", id: "grant_mission_read", representedUserId: player.user!.id, label: "Mission reader" }, scopes: ["missions:read"] };
    expect((await send(readOnly, "/api/v1/missions/daily")).status).toBe(200);
    expect((await send(readOnly, "/api/v1/missions/daily/claim", "POST", { key: "explore" })).status).toBe(403);
    const claimer: Ctx = { ...readOnly, scopes: ["missions:read", "missions:claim"] };
    const claimed = await send(claimer, "/api/v1/missions/daily/claim", "POST", { key: "explore" });
    expect(claimed.status).toBe(200);
    expect(claimed.body.amount).toBe(60);
    const unknown = await send(claimer, "/api/v1/missions/daily/claim", "POST", { key: "not_assigned" });
    expect(unknown.status).toBe(404);
  });
});
