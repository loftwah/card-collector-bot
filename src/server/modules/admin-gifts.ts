import { ApiError, requireRecentStrongAuth, type Ctx } from "../context";
import { all, first, nowIso } from "../db";
import { newId } from "../ids";
import { auditStatement, findIdempotent, idempotencyStatement, type IdempotencyInput } from "../http";
import { botForTenant } from "./bots";
import { creditWallet } from "./wallet";
import { assertTransition } from "../state";

export type GiftKind = "foil" | "card" | "opening";
export type GiftScope = "single" | "recipients" | "bot_members" | "platform_members";

export interface GiftInput {
  kind: GiftKind;
  scope: GiftScope;
  userIds?: string[];
  botId?: string | null;
  amount?: number;
  openings?: number;
  cardId?: string | null;
  /** Optional exact published variant for a card gift. */
  variantId?: string | null;
  message?: string | null;
  reason: string;
  idempotency: IdempotencyInput;
}

interface Recipient {
  user_id: string;
  email: string;
  display_name: string;
  tenant_id: string;
  tenant_name: string;
}

const MAX_RECIPIENTS = 500;
const MAX_MESSAGE = 280;

function sanitizeMessage(value: string | null | undefined): string | null {
  if (!value) return null;
  const clean = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/@everyone|@here/gi, "everyone")
    .replace(/<@[!&]?\d+>/g, "a member")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_MESSAGE);
  return clean || null;
}

function assertGiftAuthority(ctx: Ctx, input: GiftInput): { botId: string | null; tenantId: string } {
  const user = ctx.user;
  if (!user) throw new ApiError(401, "authentication_required", "Sign in to send a gift.");
  if (ctx.actor.type === "agent") {
    throw new ApiError(403, "human_required", "A gift needs a signed-in human administrator.");
  }
  requireRecentStrongAuth(ctx, 15);
  if (user.platformAdmin) {
    return { botId: input.botId ?? null, tenantId: ctx.tenant.id };
  }
  if (!["owner", "editor", "economy_admin"].includes(user.role)) {
    throw new ApiError(403, "insufficient_role", "Only a Bot Owner or delegated administrator can send gifts.");
  }
  if (input.scope === "platform_members") {
    throw new ApiError(403, "super_admin_required", "Only the Super Admin can send a platform-wide gift.");
  }
  return { botId: input.botId ?? null, tenantId: ctx.tenant.id };
}

async function resolveRecipients(ctx: Ctx, input: GiftInput, authority: { botId: string | null; tenantId: string }): Promise<Recipient[]> {
  if (input.scope === "single" || input.scope === "recipients") {
    const ids = [...new Set(input.scope === "single" ? (input.userIds ?? []).slice(0, 1) : (input.userIds ?? []))];
    if (!ids.length) throw new ApiError(422, "recipients_required", "Choose at least one recipient.");
    if (ids.length > MAX_RECIPIENTS) throw new ApiError(422, "recipient_limit", `Send to at most ${MAX_RECIPIENTS} people at once.`);
    const rows = await all<Recipient>(
      ctx.db,
      `SELECT DISTINCT u.id AS user_id, u.email, u.display_name, m.tenant_id, t.name AS tenant_name
         FROM fb_users u
         JOIN fb_memberships m ON m.user_id = u.id AND m.status = 'active' AND m.revoked_at IS NULL
         JOIN fb_tenants t ON t.id = m.tenant_id
        WHERE u.id IN (${ids.map(() => "?").join(",")}) AND u.disabled_at IS NULL AND u.is_synthetic = 0
          AND (? = 0 OR m.tenant_id = ?)
        ORDER BY u.display_name`,
      ...ids,
      authority.tenantId,
      authority.tenantId,
    );
    if (rows.length !== ids.length) {
      throw new ApiError(422, "recipient_invalid", "One or more recipients are not active members of this Bot.");
    }
    return rows;
  }
  if (input.scope === "bot_members") {
    const rows = await all<Recipient>(
      ctx.db,
      `SELECT u.id AS user_id, u.email, u.display_name, m.tenant_id, t.name AS tenant_name
         FROM fb_memberships m
         JOIN fb_users u ON u.id = m.user_id AND u.disabled_at IS NULL
         JOIN fb_tenants t ON t.id = m.tenant_id
        WHERE m.tenant_id = ? AND m.status = 'active' AND m.revoked_at IS NULL AND u.is_synthetic = 0
        ORDER BY u.display_name LIMIT ?`,
      authority.tenantId,
      MAX_RECIPIENTS + 1,
    );
    if (rows.length > MAX_RECIPIENTS) {
      throw new ApiError(422, "recipient_limit", `This Bot has more than ${MAX_RECIPIENTS} members. Use a smaller recipient list.`);
    }
    return rows;
  }
  // platform_members: Super Admin only. Deliberate per-tenant membership rows,
  // never a synthetic "all wallets" credit.
  const rows = await all<Recipient>(
    ctx.db,
    `SELECT u.id AS user_id, u.email, u.display_name, m.tenant_id, t.name AS tenant_name
       FROM fb_memberships m
       JOIN fb_users u ON u.id = m.user_id AND u.disabled_at IS NULL
       JOIN fb_tenants t ON t.id = m.tenant_id
      WHERE m.status = 'active' AND m.revoked_at IS NULL
      ORDER BY u.display_name LIMIT ?`,
    MAX_RECIPIENTS + 1,
  );
  if (rows.length > MAX_RECIPIENTS) {
    throw new ApiError(422, "recipient_limit", `Platform gifts are capped at ${MAX_RECIPIENTS} recipients per campaign.`);
  }
  return rows;
}

function validateAmount(ctx: Ctx, input: GiftInput) {
  if (input.kind === "foil") {
    const amount = Math.floor(Number(input.amount ?? 0));
    if (!Number.isInteger(amount) || amount <= 0) throw new ApiError(422, "amount_invalid", "Enter a whole, positive Foil amount.");
    const limit = ctx.user?.platformAdmin ? 10_000 : 1_000;
    if (amount > limit) throw new ApiError(422, "amount_limit", `This gift is limited to ${limit} Foil per recipient.`);
    return { amount, openings: 0 };
  }
  if (input.kind === "opening") {
    const openings = Math.floor(Number(input.openings ?? 1));
    if (!Number.isInteger(openings) || openings < 1 || openings > 20) {
      throw new ApiError(422, "openings_invalid", "Choose between 1 and 20 openings.");
    }
    return { amount: 0, openings };
  }
  if (!input.cardId) throw new ApiError(422, "card_required", "Choose a card for a card gift.");
  return { amount: 0, openings: 0 };
}

export async function previewAdminGift(ctx: Ctx, input: GiftInput) {
  const authority = assertGiftAuthority(ctx, input);
  const recipients = await resolveRecipients(ctx, input, authority);
  const { amount, openings } = validateAmount(ctx, input);
  const pool = await first<{ price: number }>(ctx.db, "SELECT price FROM fb_pools WHERE tenant_id = ? AND slug = 'cabinet-draw' AND status = 'active'", authority.tenantId);
  const price = pool?.price ?? 80;
  const perRecipient = input.kind === "foil" ? amount : input.kind === "opening" ? openings * price : 0;
  return {
    bot_id: authority.botId,
    tenant_id: authority.tenantId,
    kind: input.kind,
    scope: input.scope,
    recipient_count: recipients.length,
    sample: recipients.slice(0, 12).map((row) => ({ user_id: row.user_id, display_name: row.display_name, tenant_name: row.tenant_name })),
    per_recipient_foil: perRecipient,
    total_foil: perRecipient * recipients.length,
    openings_per_recipient: openings,
    standard_opening_price: price,
    message: sanitizeMessage(input.message),
    reason: input.reason.trim().slice(0, 500),
    limits: { max_recipients: MAX_RECIPIENTS, per_recipient_foil: ctx.user?.platformAdmin ? 10_000 : 1_000 },
  };
}

export async function sendAdminGift(ctx: Ctx, input: GiftInput) {
  const authority = assertGiftAuthority(ctx, input);
  if (!input.reason.trim() || input.reason.trim().length < 3) {
    throw new ApiError(422, "reason_required", "Record why this gift is being sent.");
  }
  const replay = await findIdempotent(ctx, "gift.campaign", input.idempotency);
  if (replay) return { ...(replay.response as object), replayed: true };
  const recipients = await resolveRecipients(ctx, input, authority);
  if (!recipients.length) throw new ApiError(422, "recipients_required", "No eligible recipients were found.");
  if (input.kind === "card" && input.variantId) {
    const exact = await first<{ id: string }>(
      ctx.db,
      `SELECT v.id FROM fb_variants v JOIN fb_variant_renders vr ON vr.variant_id = v.id AND vr.status = 'published'
        WHERE v.id = ? AND v.card_id = ? AND v.tenant_id = ? AND v.status = 'published' AND v.archived_at IS NULL`,
      input.variantId,
      input.cardId ?? "",
      ctx.tenant.id,
    );
    if (!exact) throw new ApiError(422, "variant_invalid", "That exact finish is not a published variant of the gift card.");
  }
  const { amount, openings } = validateAmount(ctx, input);
  const message = sanitizeMessage(input.message);
  const campaignId = newId("gftc");
  const now = nowIso();
  const item = { amount, openings, card_id: input.cardId ?? null, variant_id: input.variantId ?? null };
  const expected = recipients.length;
  const response = {
    campaign_id: campaignId,
    kind: input.kind,
    scope: input.scope,
    recipient_count: expected,
    status: "sending",
    message,
    reason: input.reason.trim().slice(0, 500),
  };
  await ctx.db.batch([
    idempotencyStatement(ctx, "gift.campaign", input.idempotency, response),
    ctx.db
      .prepare(
        `INSERT INTO fb_gift_campaigns
          (id, tenant_id, bot_id, created_by, kind, scope, recipient_rule_json, item_json, message, reason,
           status, expected_recipients, sent_count, failed_count, idempotency_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sending', ?, 0, 0, ?, ?, ?)`,
      )
      .bind(
        campaignId,
        authority.tenantId,
        authority.botId,
        ctx.user!.id,
        input.kind,
        input.scope,
        JSON.stringify({ user_ids: input.userIds ?? [] }),
        JSON.stringify(item),
        message,
        input.reason.trim().slice(0, 500),
        expected,
        input.idempotency.key,
        now,
        now,
      ),
    ...recipients.map((recipient) =>
      ctx.db
        .prepare(
          `INSERT INTO fb_gift_awards
            (id, campaign_id, tenant_id, user_id, kind, amount, card_id, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        )
        .bind(newId("gfta"), campaignId, recipient.tenant_id, recipient.user_id, input.kind, amount, input.cardId ?? null, now),
    ),
    auditStatement(ctx, "gift.campaign.created", "gift_campaign", campaignId, {
      kind: input.kind,
      scope: input.scope,
      recipients: expected,
      amount,
      openings,
      card_id: input.cardId ?? null,
    }),
  ]);
  const delivered = await processGiftCampaign(ctx, campaignId);
  return { ...response, ...delivered, replayed: false };
}

export async function processGiftCampaign(ctx: Ctx, campaignId: string) {
  const campaign = await first<{
    id: string;
    tenant_id: string;
    bot_id: string | null;
    created_by: string;
    kind: GiftKind;
    message: string | null;
    item_json: string;
    status: string;
  }>(ctx.db, "SELECT * FROM fb_gift_campaigns WHERE id = ? AND tenant_id = ?", campaignId, ctx.tenant.id);
  if (!campaign) throw new ApiError(404, "campaign_not_found", "Gift campaign not found.");
  // Validate and persist the campaign transition before any recipient effect.
  // A failed/partial campaign must explicitly re-enter `sending`; otherwise a
  // late transition assertion after awards were delivered would return an
  // error even though Foil or cards had already moved.
  if (campaign.status !== "sending") {
    assertTransition("gift_campaign", campaign.status, "sending");
    const moved = await ctx.db
      .prepare(
        "UPDATE fb_gift_campaigns SET status = 'sending', updated_at = ? WHERE id = ? AND tenant_id = ? AND status = ?",
      )
      .bind(nowIso(), campaignId, ctx.tenant.id, campaign.status)
      .run();
    if ((moved.meta?.changes ?? 0) !== 1) {
      throw new ApiError(409, "campaign_not_sending", "Another worker changed this gift campaign. Reload it before resuming.");
    }
    campaign.status = "sending";
  }
  const awards = await all<{
    id: string;
    tenant_id: string;
    user_id: string;
    kind: GiftKind;
    amount: number;
    card_id: string | null;
    status: string;
  }>(
    ctx.db,
    "SELECT id, tenant_id, user_id, kind, amount, card_id, status FROM fb_gift_awards WHERE campaign_id = ? ORDER BY created_at",
    campaignId,
  );
  let sent = 0;
  let failed = 0;
  for (const award of awards) {
    if (award.status === "delivered") {
      sent += 1;
      continue;
    }
    try {
      const receipt = await deliverGiftAward(ctx, campaign, award);
      await ctx.db.batch([
        ctx.db
          .prepare("UPDATE fb_gift_awards SET status = 'delivered', ledger_id = ?, receipt_json = ?, delivered_at = ?, error = NULL WHERE id = ?")
          .bind(receipt.ledgerId ?? null, JSON.stringify(receipt), nowIso(), award.id),
        ctx.db
          .prepare(
            `INSERT INTO fb_outbox (id, tenant_id, topic, payload_json, status, attempts, available_at, created_at)
             VALUES (?, ?, 'gift.received', ?, 'pending', 0, ?, ?)`,
          )
          .bind(newId("obx"), award.tenant_id, JSON.stringify({ gift_award_id: award.id, campaign_id: campaignId, user_id: award.user_id }), nowIso(), nowIso()),
      ]);
      sent += 1;
    } catch (error) {
      failed += 1;
      await ctx.db
        .prepare("UPDATE fb_gift_awards SET status = 'failed', error = ? WHERE id = ?")
        .bind(String(error).slice(0, 500), award.id)
        .run()
        .catch(() => undefined);
    }
  }
  const status = failed === 0 ? "completed" : sent > 0 ? "partial" : "failed";
  assertTransition("gift_campaign", "sending", status);
  // Conditional terminal update. A concurrent worker that already completed or
  // cancelled the campaign must not be overwritten by this late result.
  const finished = await ctx.db
    .prepare(
      "UPDATE fb_gift_campaigns SET status = ?, sent_count = ?, failed_count = ?, updated_at = ?, completed_at = ? WHERE id = ? AND tenant_id = ? AND status = 'sending'",
    )
    .bind(status, sent, failed, nowIso(), nowIso(), campaignId, ctx.tenant.id)
    .run();
  if ((finished.meta?.changes ?? 0) !== 1) {
    throw new ApiError(409, "campaign_not_sending", "The gift campaign was changed by another worker. Inspect the recorded awards before retrying.");
  }
  await auditStatement(ctx, "gift.campaign.processed", "gift_campaign", campaignId, { sent, failed, status }).run();
  return { sent_count: sent, failed_count: failed, status };
}

async function deliverGiftAward(
  ctx: Ctx,
  campaign: { id: string; kind: GiftKind; item_json: string; message: string | null; created_by: string },
  award: { id: string; tenant_id: string; user_id: string; kind: GiftKind; amount: number; card_id: string | null },
): Promise<{ ledgerId?: string; instanceId?: string; serial?: string; description: string; amount?: number }> {
  const item = JSON.parse(campaign.item_json) as { amount?: number; openings?: number; card_id?: string | null; variant_id?: string | null };
  const idempotencyKey = `gift:${campaign.id}:${award.user_id}:${award.id}`;
  if (award.kind === "foil" || award.kind === "opening") {
    const pool = await first<{ price: number }>(
      ctx.db,
      "SELECT price FROM fb_pools WHERE tenant_id = ? AND slug = 'cabinet-draw' AND status = 'active'",
      award.tenant_id,
    );
    const price = pool?.price ?? 80;
    const amount = award.kind === "foil" ? Math.floor(item.amount ?? award.amount) : Math.max(1, Math.floor(item.openings ?? 1)) * price;
    const description =
      award.kind === "foil"
        ? `Gift from ${campaign.created_by === ctx.user?.id ? "the Foilbury team" : "a Foilbury administrator"}`
        : `Gift: ${Math.floor(item.openings ?? 1)} standard opening${Math.floor(item.openings ?? 1) === 1 ? "" : "s"}`;
    const credit = await creditWallet(ctx.db, {
      tenantId: award.tenant_id,
      userId: award.user_id,
      amount,
      kind: "issue",
      description,
      idempotencyKey,
      referenceType: "admin_gift",
      referenceId: campaign.id,
      metadata: { campaign_id: campaign.id, message: campaign.message },
      actorType: "user",
      actorId: campaign.created_by,
    });
    return { ledgerId: credit.ledgerId, amount, description };
  }

  const card = await first<{ id: string; name: string }>(
    ctx.db,
    "SELECT id, name FROM fb_card_definitions WHERE id = ? AND tenant_id = ? AND status = 'published' AND archived_at IS NULL",
    award.card_id ?? item.card_id ?? "",
    ctx.tenant.id,
  );
  if (!card) throw new ApiError(422, "card_invalid", "The gift card is not published.");
  const variant = item.variant_id
    ? await first<{ id: string; name: string }>(
        ctx.db,
        `SELECT v.id, v.name FROM fb_variants v
           JOIN fb_variant_renders vr ON vr.variant_id = v.id AND vr.status = 'published'
          WHERE v.id = ? AND v.card_id = ? AND v.status = 'published' AND v.archived_at IS NULL LIMIT 1`,
        item.variant_id,
        card.id,
      )
    : await first<{ id: string; name: string }>(
        ctx.db,
        `SELECT v.id, v.name FROM fb_variants v
           JOIN fb_variant_renders vr ON vr.variant_id = v.id AND vr.status = 'published'
          WHERE v.card_id = ? AND v.status = 'published' AND v.archived_at IS NULL
          ORDER BY CASE WHEN v.name LIKE '%Plain%' OR v.name LIKE '%Base%' THEN 0 ELSE 1 END, v.name LIMIT 1`,
        card.id,
      );
  if (!variant) throw new ApiError(409, "card_unavailable", "The gift card has no published finish.");
  const existing = await first<{ id: string; serial: string }>(
    ctx.db,
    "SELECT id, serial FROM fb_card_instances WHERE tenant_id = ? AND user_id = ? AND acquired_via = ? LIMIT 1",
    award.tenant_id,
    award.user_id,
    `gift:${campaign.id}`,
  );
  if (existing) return { instanceId: existing.id, serial: existing.serial, description: `Gift: ${card.name}` };
  const instanceId = newId("ins");
  const serial = `FB-G-${newId("s").slice(-6).toUpperCase()}`;
  const now = nowIso();
  try {
    await ctx.db.batch([
      ctx.db
        .prepare(
          `INSERT INTO fb_card_instances
            (id, tenant_id, user_id, card_id, variant_id, serial, acquired_via, acquired_at, status, favourite, locked, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'owned', 0, 0, ?)`,
        )
        .bind(instanceId, award.tenant_id, award.user_id, card.id, variant.id, serial, `gift:${campaign.id}`, now, now),
      ctx.db
        .prepare(
          `INSERT INTO fb_instance_history (id, tenant_id, instance_id, event, from_user_id, to_user_id, reference_type, reference_id, metadata_json, created_at)
           VALUES (?, ?, ?, 'gifted', ?, ?, 'admin_gift', ?, ?, ?)`,
        )
        .bind(newId("ih"), award.tenant_id, instanceId, campaign.created_by, award.user_id, campaign.id, JSON.stringify({ message: campaign.message }), now),
    ]);
  } catch (error) {
    // A concurrent worker may have inserted the one permitted gift instance.
    // Re-read it rather than failing an already-delivered award or inserting a
    // duplicate; the partial unique index is the storage-level guard.
    const raced = await first<{ id: string; serial: string }>(
      ctx.db,
      "SELECT id, serial FROM fb_card_instances WHERE tenant_id = ? AND user_id = ? AND acquired_via = ? LIMIT 1",
      award.tenant_id,
      award.user_id,
      `gift:${campaign.id}`,
    );
    if (raced) return { instanceId: raced.id, serial: raced.serial, description: `Gift: ${card.name} — ${variant.name}` };
    throw error;
  }
  return { instanceId, serial, description: `Gift: ${card.name} — ${variant.name}` };
}

export async function listAdminGiftCampaigns(ctx: Ctx, limit = 50) {
  const user = ctx.user;
  if (!user) throw new ApiError(401, "authentication_required", "Sign in to see gift campaigns.");
  if (!user.platformAdmin && !["owner", "editor", "economy_admin"].includes(user.role)) {
    throw new ApiError(403, "insufficient_role", "Only administrators can see gift campaigns.");
  }
  return all(
    ctx.db,
    `SELECT c.*, u.display_name AS created_by_name,
            (SELECT COUNT(*) FROM fb_gift_awards a WHERE a.campaign_id = c.id AND a.status = 'delivered') AS delivered
       FROM fb_gift_campaigns c JOIN fb_users u ON u.id = c.created_by
      WHERE c.tenant_id = ? ORDER BY c.created_at DESC LIMIT ?`,
    ctx.tenant.id,
    Math.min(200, Math.max(1, limit)),
  );
}

export async function listMyGiftReceipts(ctx: Ctx) {
  const user = ctx.user;
  if (!user) throw new ApiError(401, "authentication_required", "Sign in to see your gifts.");
  const rows = await all<{
    id: string;
    campaign_id: string;
    kind: GiftKind;
    amount: number;
    status: string;
    receipt_json: string;
    created_at: string;
    delivered_at: string;
    message: string | null;
    reason: string;
    campaign_kind: GiftKind;
  }>(
    ctx.db,
    `SELECT a.id, a.campaign_id, a.kind, a.amount, a.status, a.receipt_json, a.created_at, a.delivered_at,
            c.message, c.reason, c.kind AS campaign_kind
       FROM fb_gift_awards a JOIN fb_gift_campaigns c ON c.id = a.campaign_id
      WHERE a.user_id = ? AND a.status = 'delivered'
      ORDER BY a.delivered_at DESC LIMIT 50`,
    user.id,
  );
  return rows.map((row) => {
    let receipt: Record<string, unknown> = {};
    try {
      receipt = JSON.parse(row.receipt_json) as Record<string, unknown>;
    } catch {
      receipt = {};
    }
    return {
      id: row.id,
      campaign_id: row.campaign_id,
      kind: row.campaign_kind,
      amount: Number(receipt.amount ?? row.amount),
      description: String(receipt.description ?? "A gift from Foilbury"),
      message: row.message,
      reason: row.reason,
      delivered_at: row.delivered_at,
      receipt,
    };
  });
}
