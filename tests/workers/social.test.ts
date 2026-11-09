import { describe, expect, it } from "vitest";
import { acceptTrade, createGift, createTrade } from "../../src/server/modules/trades";
import { recycleCommit, recyclePreview } from "../../src/server/modules/collection";
import { createSession } from "../../src/server/modules/identity";
import { resolveSession } from "../../src/server/context";
import { bootstrap, ctxFor, fixturePool, makeInstance, runtime, walletBalance } from "./helpers";

describe("trades, gifts and recycling", () => {
  it("reserves both sides, requires both acceptances, and transfers atomically", async () => {
    await bootstrap();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const fixture = await fixturePool(owner);
    const ownerCard = await makeInstance(owner, owner.user!.id, fixture, "OWNER-TRADE-1");
    const playerCard = await makeInstance(player, player.user!.id, fixture, "PLAYER-TRADE-1");

    const trade = await createTrade(owner, {
      recipientEmail: "player@foilbury.local",
      proposerInstanceIds: [ownerCard],
      recipientInstanceIds: [playerCard],
    });
    expect(trade.status).toBe("open");
    const reserved = await runtime.DB.prepare("SELECT status, reserved_for FROM fb_card_instances WHERE id IN (?, ?)").bind(ownerCard, playerCard).all<{ status: string; reserved_for: string }>();
    expect(reserved.results.every((row) => row.status === "reserved" && row.reserved_for === trade.id)).toBe(true);

    await acceptTrade(player, trade.id);
    const afterFirst = await runtime.DB.prepare("SELECT status FROM fb_trades WHERE id = ?").bind(trade.id).first<{ status: string }>();
    expect(afterFirst?.status).toBe("open");

    const completed = await acceptTrade(owner, trade.id);
    expect(completed.status).toBe("completed");
    const swapped = await runtime.DB.prepare("SELECT id, user_id FROM fb_card_instances WHERE id IN (?, ?)").bind(ownerCard, playerCard).all<{ id: string; user_id: string }>();
    expect(swapped.results.find((row) => row.id === ownerCard)?.user_id).toBe(player.user!.id);
    expect(swapped.results.find((row) => row.id === playerCard)?.user_id).toBe(owner.user!.id);
    const history = await runtime.DB.prepare("SELECT COUNT(*) AS count FROM fb_instance_history WHERE reference_id = ? AND event = 'traded'").bind(trade.id).first<{ count: number }>();
    expect(history?.count).toBe(2);
  });

  it("protects favourites and locked cards, then credits an audited recycle", async () => {
    await bootstrap();
    const base = await ctxFor("cabinet", "owner@foilbury.local");
    const session=await createSession(base.db,base.tenant,base.user!,{authMethod:"magic_link",assurance:"email"});
    const owner={...base,sessionId:(await resolveSession(base.db,session.token))!.sessionId};
    const fixture = await fixturePool(owner);
    const instanceId = await makeInstance(owner, owner.user!.id, fixture, "OWNER-RECYCLE-1");
    await runtime.DB.prepare("UPDATE fb_card_instances SET favourite = 1 WHERE id = ?").bind(instanceId).run();
    await expect(recyclePreview(owner, instanceId)).rejects.toMatchObject({ code: "favourite_protected" });
    await runtime.DB.prepare("UPDATE fb_card_instances SET favourite = 0, locked = 1 WHERE id = ?").bind(instanceId).run();
    await expect(recyclePreview(owner, instanceId)).rejects.toMatchObject({ code: "locked_protected" });
    await runtime.DB.prepare("UPDATE fb_card_instances SET locked = 0 WHERE id = ?").bind(instanceId).run();
    const preview = await recyclePreview(owner, instanceId);
    expect(preview.credit).toBe(10);
    const receipt = await recycleCommit(owner, { instanceId, expectedCredit: preview.credit, idempotencyKey: "recycle-test-1" });
    expect(receipt.credit).toBe(10);
    expect(await walletBalance(owner, owner.user!.id)).toBe(360);
    const status = await runtime.DB.prepare("SELECT status FROM fb_card_instances WHERE id = ?").bind(instanceId).first<{ status: string }>();
    expect(status?.status).toBe("surrendered");
    const history = await runtime.DB.prepare("SELECT event FROM fb_instance_history WHERE instance_id = ?").bind(instanceId).all<{ event: string }>();
    expect(history.results.some((row) => row.event === "recycled")).toBe(true);
  });

  it("labels gifts separately and transfers the card with history", async () => {
    await bootstrap();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const fixture = await fixturePool(owner);
    const instanceId = await makeInstance(owner, owner.user!.id, fixture, "OWNER-GIFT-1");
    const gift = await createGift(owner, { recipientEmail: "player@foilbury.local", instanceId, idempotencyKey: "gift-test-1" });
    const row = await runtime.DB.prepare("SELECT user_id FROM fb_card_instances WHERE id = ?").bind(instanceId).first<{ user_id: string }>();
    expect(row?.user_id).toBe(player.user!.id);
    const history = await runtime.DB.prepare("SELECT event, to_user_id FROM fb_instance_history WHERE instance_id = ?").bind(instanceId).all<{ event: string; to_user_id: string }>();
    expect(history.results.some((event) => event.event === "gifted" && event.to_user_id === player.user!.id)).toBe(true);
    const replay = await createGift(owner, { recipientEmail: "player@foilbury.local", instanceId, idempotencyKey: "gift-test-1" });
    expect(replay.gift_id).toBe(gift.gift_id);
  });
});
