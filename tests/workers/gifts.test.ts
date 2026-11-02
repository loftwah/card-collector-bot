import { describe, expect, it } from "vitest";
import { bootstrap, ctxFor, fixturePool, runtime, walletBalance } from "./helpers";
import { addMembership, createUser, ensureWallet } from "../../src/server/modules/identity";
import { previewAdminGift, sendAdminGift } from "../../src/server/modules/admin-gifts";
import { listMyGiftReceipts } from "../../src/server/modules/admin-gifts";
import { nowIso } from "../../src/server/db";

async function strong(ctx: Awaited<ReturnType<typeof ctxFor>>) {
  return { ...ctx, sessionAssurance: "access" };
}

async function member(tenantId: string, email: string) {
  const user = await createUser(runtime.DB, { email, displayName: email.split("@")[0]!, password: "a-long-test-password" });
  await addMembership(runtime.DB, tenantId, user.id, "player");
  await ensureWallet(runtime.DB, tenantId, user.id);
  return user;
}

describe("scoped administrator gifts", () => {
  it("previews, sends and retries a Foil gift without double-crediting", async () => {
    await bootstrap();
    const owner = await strong(await ctxFor("cabinet", "owner@foilbury.local"));
    const recipient = await member(owner.tenant.id, "gift.recipient@example.com");
    const before = await walletBalance(owner, recipient.id);
    const input = {
      kind: "foil" as const,
      scope: "single" as const,
      userIds: [recipient.id],
      amount: 480,
      reason: "Community night thank-you",
      message: "Thanks for being part of the first season.",
      idempotency: { key: "gift-test-1", digest: "gift-digest-1" },
    };
    const preview = await previewAdminGift(owner, input);
    expect(preview.recipient_count).toBe(1);
    expect(preview.per_recipient_foil).toBe(480);
    const sent = await sendAdminGift(owner, input);
    expect(sent.status).toBe("completed");
    expect(sent.sent_count).toBe(1);
    expect(await walletBalance(owner, recipient.id)).toBe(before + 480);
    const replay = await sendAdminGift(owner, input);
    expect(replay.replayed).toBe(true);
    expect(await walletBalance(owner, recipient.id)).toBe(before + 480);
    const ledger = await runtime.DB.prepare("SELECT COUNT(*) AS count FROM fb_ledger_entries WHERE tenant_id = ? AND user_id = ? AND reference_type = 'admin_gift'").bind(owner.tenant.id, recipient.id).first<{ count: number }>();
    expect(ledger?.count).toBe(1);
    const campaign = await runtime.DB.prepare("SELECT status, sent_count FROM fb_gift_campaigns WHERE id = ?").bind(sent.campaign_id).first<{ status: string; sent_count: number }>();
    expect(campaign?.status).toBe("completed");
    expect(campaign?.sent_count).toBe(1);
  });

  it("delivers a card gift as one owned copy with a serial and a receipt", async () => {
    await bootstrap();
    const owner = await strong(await ctxFor("cabinet", "owner@foilbury.local"));
    const fixture = await fixturePool(owner);
    const recipient = await member(owner.tenant.id, "card.gift@example.com");
    const input = {
      kind: "card" as const,
      scope: "single" as const,
      userIds: [recipient.id],
      cardId: fixture.cardId,
      reason: "Prize for the launch quiz",
      idempotency: { key: "gift-card-1", digest: "gift-card-digest" },
    };
    const sent = await sendAdminGift(owner, input);
    expect(sent.sent_count).toBe(1);
    const instance = await runtime.DB.prepare("SELECT id, serial, user_id, acquired_via FROM fb_card_instances WHERE tenant_id = ? AND user_id = ?").bind(owner.tenant.id, recipient.id).first<{ id: string; serial: string; user_id: string; acquired_via: string }>();
    expect(instance?.user_id).toBe(recipient.id);
    expect(instance?.serial).toMatch(/^FB-G-/);
    expect(instance?.acquired_via).toContain("gift:");
    const receiptCtx = await ctxFor("cabinet", "player@foilbury.local");
    const receipts = await listMyGiftReceipts({
      ...receiptCtx,
      user: { ...receiptCtx.user!, id: recipient.id, email: "card.gift@example.com", displayName: "card.gift" },
    });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.kind).toBe("card");
  });

  it("denies a player and enforces the per-recipient limit", async () => {
    await bootstrap();
    const player = await strong(await ctxFor("cabinet", "player@foilbury.local"));
    const recipient = await member(player.tenant.id, "limit.recipient@example.com");
    await expect(
      sendAdminGift(player, {
        kind: "foil",
        scope: "single",
        userIds: [recipient.id],
        amount: 10,
        reason: "Not allowed",
        idempotency: { key: "gift-denied", digest: "denied" },
      }),
    ).rejects.toMatchObject({ code: "insufficient_role" });

    const ownerCtx = await strong(await ctxFor("cabinet", "owner@foilbury.local"));
    const owner = { ...ownerCtx, user: { ...ownerCtx.user!, platformAdmin: false } };
    await expect(
      sendAdminGift(owner, {
        kind: "foil",
        scope: "single",
        userIds: [recipient.id],
        amount: 1001,
        reason: "Too large for a Bot Owner",
        idempotency: { key: "gift-limit", digest: "limit" },
      }),
    ).rejects.toMatchObject({ code: "amount_limit" });
  });

  it("sanitises mass mentions in the gift message", async () => {
    await bootstrap();
    const owner = await strong(await ctxFor("cabinet", "owner@foilbury.local"));
    const recipient = await member(owner.tenant.id, "mention@example.com");
    const preview = await previewAdminGift(owner, {
      kind: "foil",
      scope: "single",
      userIds: [recipient.id],
      amount: 10,
      reason: "Message hygiene",
      message: "@everyone <@123456789012345678> hello",
      idempotency: { key: "gift-message", digest: "message" },
    });
    expect(preview.message).not.toContain("@everyone");
    expect(preview.message).not.toContain("<@");
  });
});
