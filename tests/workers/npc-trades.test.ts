import { describe, expect, it } from "vitest";
import { bootstrap, ctxFor, fixturePool, makeInstance, runtime } from "./helpers";
import { createNpc, setNpcStatus, updateNpc } from "../../src/server/modules/npcs";
import { addMembership, createUser } from "../../src/server/modules/identity";
import {
  cancelNpcTrade,
  confirmNpcTrade,
  createNpcTrade,
  previewNpcTrade,
} from "../../src/server/modules/npc-trades";
import { nowIso } from "../../src/server/db";

async function npcTradeFixture() {
  await bootstrap();
  const owner = await ctxFor("cabinet", "owner@foilbury.local");
  const player = await ctxFor("cabinet", "player@foilbury.local");
  const fixture = await fixturePool(owner);
  const npc = await createNpc(owner, {
    name: "Museum Moth",
    presetKey: "completionist",
    goalCollectionId: "col_test_public",
    startingBalance: 0,
  });
  const npcRow = await runtime.DB.prepare(
    "SELECT user_id FROM fb_npc_collectors WHERE id = ? AND tenant_id = ?",
  )
    .bind(npc.id, owner.tenant.id)
    .first<{ user_id: string }>();
  if (!npcRow) throw new Error("NPC user missing");
  const gold = await runtime.DB.prepare(
    "SELECT m.id AS material_id, e.id AS effect_id FROM fb_materials m, fb_effects e WHERE m.tenant_id = ? AND m.key = 'gold' AND e.tenant_id = ? AND e.key = 'none'",
  )
    .bind(owner.tenant.id, owner.tenant.id)
    .first<{ material_id: string; effect_id: string }>();
  if (!gold) throw new Error("Gold material missing");
  const goldVariant = "var_test_gold";
  await runtime.DB.prepare(
    "INSERT INTO fb_variants (id, tenant_id, card_id, edition_id, material_id, effect_id, name, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'Gold', 'published', ?)",
  )
    .bind(goldVariant, owner.tenant.id, fixture.cardId, fixture.editionId, gold.material_id, gold.effect_id, nowIso())
    .run();
  const npcPlainA = await makeInstance(owner, npcRow.user_id, fixture, "NPC-PLAIN-A");
  const npcPlainB = await makeInstance(owner, npcRow.user_id, fixture, "NPC-PLAIN-B");
  const humanGold = await makeInstance(owner, player.user!.id, { ...fixture, variantId: goldVariant }, "HUMAN-GOLD");
  return { owner, player, fixture, npc, npcUserId: npcRow.user_id, goldVariant, npcPlainA, npcPlainB, humanGold };
}

async function instance(id: string) {
  return runtime.DB.prepare(
    "SELECT id, user_id, status, reserved_for, serial FROM fb_card_instances WHERE id = ?",
  )
    .bind(id)
    .first<{ id: string; user_id: string; status: string; reserved_for: string | null; serial: string }>();
}

describe("human-initiated NPC trading", () => {
  it("accepts a fair exchange, transfers exact copies atomically and preserves serials", async () => {
    const { player, npc, npcUserId, npcPlainA, humanGold, goldVariant } = await npcTradeFixture();
    const preview = await previewNpcTrade(player, {
      npcId: npc.id,
      giveInstanceIds: [humanGold],
      takeInstanceIds: [npcPlainA],
    });
    expect(preview.decision).toBe("accept");
    expect(preview.reason).toContain("accepts");
    expect(preview.wants.new_finishes.length).toBe(1);

    const created = await createNpcTrade(player, {
      npcId: npc.id,
      giveInstanceIds: [humanGold],
      takeInstanceIds: [npcPlainA],
      idempotencyKey: "npc-trade-test-001",
    });
    expect(created.replayed).toBe(false);
    expect((await instance(humanGold))?.status).toBe("reserved");
    expect((await instance(npcPlainA))?.status).toBe("reserved");

    const completed = await confirmNpcTrade(player, created.trade.id);
    expect(completed.trade.status).toBe("completed");
    const humanGoldAfter = await instance(humanGold);
    const npcPlainAfter = await instance(npcPlainA);
    expect(humanGoldAfter).toMatchObject({ user_id: npcUserId, status: "owned", reserved_for: null, serial: "HUMAN-GOLD" });
    expect(npcPlainAfter).toMatchObject({ user_id: player.user!.id, status: "owned", reserved_for: null, serial: "NPC-PLAIN-A" });

    const goldCount = await runtime.DB.prepare(
      "SELECT COUNT(*) AS count FROM fb_card_instances WHERE tenant_id = ? AND user_id = ? AND variant_id = ?",
    )
      .bind(player.tenant.id, npcUserId, goldVariant)
      .first<{ count: number }>();
    expect(goldCount?.count).toBe(1);
  });

  it("declines an offer with no new want and a demand for the NPC's only goal copy", async () => {
    const { owner, player, npc, npcPlainA, npcPlainB, humanGold } = await npcTradeFixture();
    await updateNpc(owner, npc.id, { presetKey: "friendly_collector", goalCollectionId: null });
    const humanPlain = await makeInstance(
      { ...player },
      player.user!.id,
      { cardId: "crd_test_card", variantId: "var_test_variant" },
      "HUMAN-PLAIN",
    );
    const declineNoWant = await previewNpcTrade(player, {
      npcId: npc.id,
      giveInstanceIds: [humanPlain],
      takeInstanceIds: [npcPlainA],
    });
    expect(declineNoWant.decision).toBe("decline");
    expect(declineNoWant.reason).toMatch(/does not add|only goal copy/);

    const oneNpcCopy = await previewNpcTrade(player, {
      npcId: npc.id,
      giveInstanceIds: [humanGold],
      takeInstanceIds: [npcPlainA],
    });
    expect(oneNpcCopy.decision).toBe("accept");
    await runtime.DB.prepare("UPDATE fb_card_instances SET favourite = 1 WHERE id = ?").bind(npcPlainB).run();
    const takeBoth = await previewNpcTrade(player, {
      npcId: npc.id,
      giveInstanceIds: [humanGold],
      takeInstanceIds: [npcPlainA, npcPlainB],
    });
    expect(takeBoth.decision).toBe("decline");
    expect(takeBoth.reason).toMatch(/pinned|fairer|only goal copy/);
  });

  it("cancels without moving ownership, and blocks a paused NPC or disabled collection", async () => {
    const { player, owner, npc, npcPlainA, humanGold } = await npcTradeFixture();
    const created = await createNpcTrade(player, {
      npcId: npc.id,
      giveInstanceIds: [humanGold],
      takeInstanceIds: [npcPlainA],
      idempotencyKey: "npc-trade-cancel-001",
    });
    await cancelNpcTrade(player, created.trade.id);
    expect((await instance(humanGold))?.status).toBe("owned");
    expect((await instance(npcPlainA))?.status).toBe("owned");
    expect((await instance(humanGold))?.user_id).toBe(player.user!.id);

    const second = await createNpcTrade(player, {
      npcId: npc.id,
      giveInstanceIds: [humanGold],
      takeInstanceIds: [npcPlainA],
      idempotencyKey: "npc-trade-paused-001",
    });
    await setNpcStatus(owner, npc.id, "paused");
    await expect(confirmNpcTrade(player, second.trade.id)).rejects.toMatchObject({ code: "npc_trade_unavailable" });
    await cancelNpcTrade(player, second.trade.id);

    await setNpcStatus(owner, npc.id, "active");
    const third = await createNpcTrade(player, {
      npcId: npc.id,
      giveInstanceIds: [humanGold],
      takeInstanceIds: [npcPlainA],
      idempotencyKey: "npc-trade-disabled-001",
    });
    await runtime.DB.prepare("UPDATE fb_bot_collections SET enabled = 0 WHERE collection_id = 'col_test_public'").run();
    await expect(confirmNpcTrade(player, third.trade.id)).rejects.toMatchObject({ code: "npc_trade_unavailable" });
    await cancelNpcTrade(player, third.trade.id);
  });

  it("rejects an expired offer before any ownership change", async () => {
    const { player, npc, npcPlainA, humanGold } = await npcTradeFixture();
    const created = await createNpcTrade(player, {
      npcId: npc.id,
      giveInstanceIds: [humanGold],
      takeInstanceIds: [npcPlainA],
      idempotencyKey: "npc-trade-expired-001",
    });
    await runtime.DB
      .prepare("UPDATE fb_trades SET expires_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 1000).toISOString(), created.trade.id)
      .run();
    await expect(confirmNpcTrade(player, created.trade.id)).rejects.toMatchObject({ code: "trade_expired" });
    // The offer still holds its reservation until cancellation/expiry cleanup,
    // but ownership must not move and no new acceptance may be written.
    expect((await instance(humanGold))).toMatchObject({ user_id: player.user!.id, status: "reserved" });
    expect((await instance(npcPlainA))).toMatchObject({ status: "reserved" });
  });

  it("rejects a stale trade revision without recording a new acceptance or moving copies", async () => {
    const { player, npc, npcPlainA, humanGold } = await npcTradeFixture();
    const created = await createNpcTrade(player, {
      npcId: npc.id,
      giveInstanceIds: [humanGold],
      takeInstanceIds: [npcPlainA],
      idempotencyKey: "npc-trade-stale-revision-001",
    });
    await runtime.DB.prepare("UPDATE fb_trades SET revision = 2 WHERE id = ?").bind(created.trade.id).run();
    await expect(confirmNpcTrade(player, created.trade.id)).rejects.toMatchObject({ code: "trade_revision_stale" });
    const acceptances = await runtime.DB
      .prepare("SELECT revision FROM fb_trade_acceptances WHERE trade_id = ? ORDER BY revision")
      .bind(created.trade.id)
      .all<{ revision: number }>();
    expect(acceptances.results?.map((row) => row.revision)).toEqual([1]);
    expect((await instance(humanGold))).toMatchObject({ user_id: player.user!.id, status: "reserved" });
    expect((await instance(npcPlainA))).toMatchObject({ status: "reserved" });
  });

  it("completes exactly once under two concurrent confirmations", async () => {
    const { player, npc, npcUserId, npcPlainA, humanGold } = await npcTradeFixture();
    const created = await createNpcTrade(player, {
      npcId: npc.id,
      giveInstanceIds: [humanGold],
      takeInstanceIds: [npcPlainA],
      idempotencyKey: "npc-trade-concurrent-001",
    });
    const results = await Promise.allSettled([
      confirmNpcTrade(player, created.trade.id),
      confirmNpcTrade(player, created.trade.id),
    ]);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    for (const result of results) {
      if (result.status === "rejected") {
        expect(["already_accepted", "npc_trade_not_open"]).toContain((result.reason as { code?: string }).code);
      }
    }
    const trade = await runtime.DB
      .prepare("SELECT status, revision FROM fb_trades WHERE id = ?")
      .bind(created.trade.id)
      .first<{ status: string; revision: number }>();
    expect(trade).toMatchObject({ status: "completed", revision: 1 });
    expect((await instance(humanGold))).toMatchObject({ user_id: npcUserId, status: "owned", reserved_for: null });
    expect((await instance(npcPlainA))).toMatchObject({ user_id: player.user!.id, status: "owned", reserved_for: null });
    const history = await runtime.DB
      .prepare("SELECT COUNT(*) AS count FROM fb_instance_history WHERE reference_type = 'trade' AND reference_id = ?")
      .bind(created.trade.id)
      .first<{ count: number }>();
    expect(history?.count).toBe(2);
  });

  it("denies a revoked member and a wrong actor without moving any copy", async () => {
    const { player, owner, npc, npcPlainA, humanGold } = await npcTradeFixture();
    const created = await createNpcTrade(player, {
      npcId: npc.id,
      giveInstanceIds: [humanGold],
      takeInstanceIds: [npcPlainA],
      idempotencyKey: "npc-trade-revoked-001",
    });
    const outsider = await createUser(runtime.DB, {
      email: "npc-outsider@example.com",
      displayName: "NPC Outsider",
      password: "a-long-test-password",
    });
    await addMembership(runtime.DB, owner.tenant.id, outsider.id, "player");
    const outsiderCtx = await ctxFor("cabinet", "npc-outsider@example.com");
    await expect(confirmNpcTrade(outsiderCtx, created.trade.id)).rejects.toMatchObject({ code: "not_your_trade" });
    expect((await instance(humanGold))).toMatchObject({ user_id: player.user!.id, status: "reserved" });

    await runtime.DB
      .prepare("UPDATE fb_memberships SET status = 'revoked', revoked_at = ? WHERE tenant_id = ? AND user_id = ?")
      .bind(nowIso(), owner.tenant.id, player.user!.id)
      .run();
    await expect(confirmNpcTrade(player, created.trade.id)).rejects.toMatchObject({ code: "membership_inactive" });
    expect((await instance(humanGold))).toMatchObject({ user_id: player.user!.id, status: "reserved" });
    expect((await instance(npcPlainA))).toMatchObject({ status: "reserved" });
  });

  it("is idempotent on duplicate create and repeat confirm", async () => {
    const { player, npc, npcUserId, npcPlainA, humanGold } = await npcTradeFixture();
    const first = await createNpcTrade(player, {
      npcId: npc.id,
      giveInstanceIds: [humanGold],
      takeInstanceIds: [npcPlainA],
      idempotencyKey: "npc-trade-replay-001",
    });
    const second = await createNpcTrade(player, {
      npcId: npc.id,
      giveInstanceIds: [humanGold],
      takeInstanceIds: [npcPlainA],
      idempotencyKey: "npc-trade-replay-001",
    });
    expect(second.replayed).toBe(true);
    expect(second.trade.id).toBe(first.trade.id);
    const completed = await confirmNpcTrade(player, first.trade.id);
    const replay = await confirmNpcTrade(player, first.trade.id);
    expect(completed.trade.status).toBe("completed");
    expect(replay.replayed).toBe(true);
    expect((await instance(humanGold))?.user_id).toBe(npcUserId);
  });
});
