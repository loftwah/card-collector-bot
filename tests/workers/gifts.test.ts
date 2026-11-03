import { describe, expect, it } from "vitest";
import { bootstrap, ctxFor, fixturePool, runtime, walletBalance } from "./helpers";
import { addMembership, createUser, ensureWallet } from "../../src/server/modules/identity";
import { previewAdminGift, sendAdminGift } from "../../src/server/modules/admin-gifts";
import { listMyGiftReceipts } from "../../src/server/modules/admin-gifts";
import { nowIso } from "../../src/server/db";
import { sha256Hex } from "../../src/server/ids";

async function strong(ctx: Awaited<ReturnType<typeof ctxFor>>) {
  // Gift-domain fixtures carry a recent local factor. An Access label alone
  // is deliberately insufficient without a verified, linked Access request.
  return { ...ctx, sessionAssurance: "passkey", sessionAuthTime: nowIso() };
}

async function member(tenantId: string, email: string) {
  const user = await createUser(runtime.DB, { email, displayName: email.split("@")[0]!, password: "a-long-test-password" });
  await addMembership(runtime.DB, tenantId, user.id, "player");
  await ensureWallet(runtime.DB, tenantId, user.id);
  return user;
}

describe("scoped administrator gifts", () => {
  it("delivers an exact published finish when a card gift names the variant", async () => {
    await bootstrap();
    const owner = await strong(await ctxFor("cabinet", "owner@foilbury.local"));
    const fixture = await fixturePool(owner);
    const recipient = await member(owner.tenant.id, "gold.gift@example.com");
    const gold = await runtime.DB.prepare("SELECT id FROM fb_materials WHERE tenant_id = ? AND key = 'gold'").bind(owner.tenant.id).first<{ id: string }>();
    const none = await runtime.DB.prepare("SELECT id FROM fb_effects WHERE tenant_id = ? AND key = 'none'").bind(owner.tenant.id).first<{ id: string }>();
    const now = nowIso();
    await runtime.DB.batch([
      runtime.DB.prepare(
        "INSERT INTO fb_variants (id, tenant_id, card_id, edition_id, material_id, effect_id, name, status, created_at) VALUES ('var_gift_gold', ?, ?, ?, ?, ?, 'Gold', 'published', ?)",
      ).bind(owner.tenant.id, fixture.cardId, fixture.editionId, gold!.id, none!.id, now),
      runtime.DB.prepare(
        "INSERT INTO fb_variant_renders (id, tenant_id, variant_id, recipe_id, asset_id, public_url, width, height, sha256, status, created_at, published_at) VALUES ('vr_gift_gold', ?, 'var_gift_gold', ?, ?, '/media/public/gift-gold', 750, 1050, 'gift-gold-hash', 'published', ?, ?)",
      ).bind(owner.tenant.id, fixture.recipeId, fixture.renderAsset, now, now),
    ]);
    const key = "gift-exact-finish";
    const result = await sendAdminGift(owner, {
      kind: "card",
      scope: "single",
      userIds: [recipient.id],
      cardId: fixture.cardId,
      variantId: "var_gift_gold",
      reason: "Exact-finish gift proof",
      idempotency: { key, digest: await sha256Hex(key) },
    });
    expect(result.status).toBe("completed");
    const instance = await runtime.DB.prepare("SELECT variant_id, serial FROM fb_card_instances WHERE tenant_id = ? AND user_id = ?").bind(owner.tenant.id, recipient.id).first<{ variant_id: string; serial: string }>();
    expect(instance?.variant_id).toBe("var_gift_gold");
    await expect(sendAdminGift(owner, {
      kind: "card",
      scope: "single",
      userIds: [recipient.id],
      cardId: fixture.cardId,
      variantId: "var_not_a_finish",
      reason: "Invalid exact finish",
      idempotency: { key: "gift-bad-finish", digest: await sha256Hex("gift-bad-finish") },
    })).rejects.toMatchObject({ code: "variant_invalid" });
  });

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

