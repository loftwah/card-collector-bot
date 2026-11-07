import { ApiError, type Ctx } from "../context";
import { all, first, nowIso } from "../db";
import { newId } from "../ids";
import { auditStatement } from "../http";

export async function createTrade(
  ctx: Ctx,
  input: {
    recipientId?: string;
    /** Retained for explicit-address compatibility; directory discovery no longer exposes it. */
    recipientEmail?: string;
    proposerInstanceIds: string[];
    recipientInstanceIds: string[];
    expiresInHours?: number;
    note?: string;
  },
) {
  const user = ctx.user!;
  if (user.synthetic) throw new ApiError(403, "synthetic_transfer_blocked", "NPC collectors cannot trade with human members.");
  if (!input.recipientId && !input.recipientEmail) {
    throw new ApiError(422, "recipient_required", "Choose the member who receives this offer.");
  }
  const recipient = input.recipientId
    ? await first<{ id: string; display_name: string; email: string }>(
        ctx.db,
        `SELECT u.id, u.display_name, u.email FROM fb_users u JOIN fb_memberships m ON m.user_id = u.id
          WHERE u.id = ? AND m.tenant_id = ? AND m.status = 'active' AND u.disabled_at IS NULL AND u.is_synthetic = 0`,
        input.recipientId,
        ctx.tenant.id,
      )
    : await first<{ id: string; display_name: string; email: string }>(
        ctx.db,
        `SELECT u.id, u.display_name, u.email FROM fb_users u JOIN fb_memberships m ON m.user_id = u.id
          WHERE u.email = ? AND m.tenant_id = ? AND m.status = 'active' AND u.disabled_at IS NULL AND u.is_synthetic = 0`,
        input.recipientEmail!.trim().toLowerCase(),
        ctx.tenant.id,
      );
  if (!recipient) throw new ApiError(404, "recipient_not_found", "That member is not an active member of this cabinet.");
  if (recipient.id === user.id) throw new ApiError(422, "self_trade", "A trade needs a different member on each side.");
  if (input.proposerInstanceIds.length + input.recipientInstanceIds.length === 0) {
    throw new ApiError(422, "trade_empty", "Add at least one card to the offer.");
  }
  if (input.proposerInstanceIds.length > 30 || input.recipientInstanceIds.length > 30) {
    throw new ApiError(422, "trade_limit", "A trade can include at most 30 cards per side.");
  }
  const tradeId = newId("trd");
  const now = nowIso();
  const expiresAt = new Date(Date.now() + Math.min(168, Math.max(1, input.expiresInHours ?? 48)) * 3600 * 1000).toISOString();
  const statements = [
    ctx.db
      .prepare(
        "INSERT INTO fb_trades (id, tenant_id, proposer_id, recipient_id, status, revision, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'open', 1, ?, ?, ?)",
      )
      .bind(tradeId, ctx.tenant.id, user.id, recipient.id, expiresAt, now, now),
    ...input.proposerInstanceIds.map((instanceId) =>
      ctx.db
        .prepare("INSERT INTO fb_trade_items (id, tenant_id, trade_id, side, instance_id, created_at) VALUES (?, ?, ?, 'proposer', ?, ?)")
        .bind(newId("tri"), ctx.tenant.id, tradeId, instanceId, now),
    ),
    ...input.recipientInstanceIds.map((instanceId) =>
      ctx.db
        .prepare("INSERT INTO fb_trade_items (id, tenant_id, trade_id, side, instance_id, created_at) VALUES (?, ?, ?, 'recipient', ?, ?)")
        .bind(newId("tri"), ctx.tenant.id, tradeId, instanceId, now),
    ),
    auditStatement(ctx, "trade.created", "trade", tradeId, {
      recipient_id: recipient.id,
      proposer_cards: input.proposerInstanceIds.length,
      recipient_cards: input.recipientInstanceIds.length,
      expires_at: expiresAt,
    }),
  ];
  try {
    await ctx.db.batch(statements);
  } catch (error) {
    const message = String(error);
    if (message.includes("trade_item_unavailable")) {
      throw new ApiError(409, "trade_item_unavailable", "One or more cards are no longer available to offer. Nothing was reserved.");
    }
    if (message.includes("UNIQUE")) throw new ApiError(409, "trade_duplicate", "A card was listed twice in the offer.");
    throw error;
  }
  return getTrade(ctx, tradeId);
}

export async function getTrade(ctx: Ctx, tradeId: string) {
  const user = ctx.user!;
  const trade = await first<{
    id: string;
    proposer_id: string;
    recipient_id: string;
    status: string;
    revision: number;
    expires_at: string;
    created_at: string;
    updated_at: string;
    completed_at: string | null;
    proposer_name: string;
    recipient_name: string;
  }>(
    ctx.db,
    `SELECT t.*, p.display_name AS proposer_name, r.display_name AS recipient_name
       FROM fb_trades t JOIN fb_users p ON p.id = t.proposer_id JOIN fb_users r ON r.id = t.recipient_id
      WHERE t.id = ? AND t.tenant_id = ? AND (t.proposer_id = ? OR t.recipient_id = ?)`,
    tradeId,
    ctx.tenant.id,
    user.id,
    user.id,
  );
  if (!trade) throw new ApiError(404, "trade_not_found", "Trade not found.");
  const items = await all<{
    id: string;
    side: string;
    instance_id: string;
    card_name: string;
    variant_name: string;
    serial: string;
    render_url: string | null;
  }>(
    ctx.db,
    `SELECT ti.id, ti.side, ti.instance_id, cd.name AS card_name, v.name AS variant_name, ci.serial, ('/media/render/' || vr.asset_id) AS render_url
       FROM fb_trade_items ti JOIN fb_card_instances ci ON ci.id = ti.instance_id
       JOIN fb_card_definitions cd ON cd.id = ci.card_id JOIN fb_variants v ON v.id = ci.variant_id
       LEFT JOIN fb_variant_renders vr ON vr.variant_id = v.id AND vr.tenant_id = ti.tenant_id AND vr.status = 'published'
      WHERE ti.trade_id = ? AND ti.tenant_id = ? ORDER BY ti.side, cd.name`,
    tradeId,
    ctx.tenant.id,
  );
  const acceptances = await all<{ user_id: string; revision: number; accepted_at: string }>(
    ctx.db,
    "SELECT user_id, revision, accepted_at FROM fb_trade_acceptances WHERE trade_id = ? AND tenant_id = ?",
    tradeId,
    ctx.tenant.id,
  );
  return { ...trade, items, acceptances };
}

export async function listTrades(ctx: Ctx) {
  const user = ctx.user!;
  return all<{
    id: string;
    proposer_id: string;
    recipient_id: string;
    status: string;
    revision: number;
    expires_at: string;
    updated_at: string;
    proposer_name: string;
    recipient_name: string;
    item_count: number;
  }>(
    ctx.db,
    `SELECT t.id, t.proposer_id, t.recipient_id, t.status, t.revision, t.expires_at, t.updated_at,
            p.display_name AS proposer_name, r.display_name AS recipient_name,
            (SELECT COUNT(*) FROM fb_trade_items ti WHERE ti.trade_id = t.id) AS item_count
       FROM fb_trades t JOIN fb_users p ON p.id = t.proposer_id JOIN fb_users r ON r.id = t.recipient_id
      WHERE t.tenant_id = ? AND (t.proposer_id = ? OR t.recipient_id = ?)
      ORDER BY t.updated_at DESC LIMIT 100`,
    ctx.tenant.id,
    user.id,
    user.id,
  );
}

export async function acceptTrade(ctx: Ctx, tradeId: string) {
  const user = ctx.user!;
  const trade = await getTrade(ctx, tradeId);
  if (trade.status !== "open") throw new ApiError(409, "trade_not_open", `This trade is ${trade.status}.`);
  if (new Date(trade.expires_at) <= new Date()) throw new ApiError(409, "trade_expired", "This trade has expired.");
  const side = user.id === trade.proposer_id ? "proposer" : "recipient";
  const other = side === "proposer" ? trade.recipient_id : trade.proposer_id;
  if (user.id !== trade.proposer_id && user.id !== trade.recipient_id) throw new ApiError(403, "not_a_party", "You are not a party to this trade.");
  const npc = await first<{ id: string; status: string; bot_id: string | null }>(
    ctx.db,
    "SELECT id, status, bot_id FROM fb_npc_collectors WHERE tenant_id = ? AND user_id = ?",
    ctx.tenant.id,
    trade.recipient_id,
  );
  if (npc) {
    const bot = await first<{ id: string; status: string }>(
      ctx.db,
      "SELECT id, status FROM fb_bots WHERE tenant_id = ? AND id = ?",
      ctx.tenant.id,
      npc.bot_id,
    );
    if (npc.status !== "active" || !bot || bot.status !== "active") {
      throw new ApiError(409, "npc_trade_unavailable", "The NPC collector or its Bot is paused; nothing was transferred.");
    }
    const availability = await all<{ card_name: string; enabled_count: number }>(
      ctx.db,
      `SELECT cd.name AS card_name,
              SUM(CASE WHEN bc.enabled = 1 AND c.status = 'published' AND c.archived_at IS NULL THEN 1 ELSE 0 END) AS enabled_count
         FROM fb_trade_items ti
         JOIN fb_card_instances ci ON ci.id = ti.instance_id AND ci.tenant_id = ti.tenant_id
         JOIN fb_card_definitions cd ON cd.id = ci.card_id
         JOIN fb_collection_cards cc ON cc.card_id = ci.card_id
         JOIN fb_collections c ON c.id = cc.collection_id
         LEFT JOIN fb_bot_collections bc ON bc.bot_id = ? AND bc.collection_id = c.id
        WHERE ti.trade_id = ? AND ti.tenant_id = ?
        GROUP BY ci.card_id, cd.name`,
      bot.id,
      trade.id,
      ctx.tenant.id,
    );
    const disabled = availability.find((row) => Number(row.enabled_count) === 0);
    if (disabled) {
      throw new ApiError(409, "npc_trade_unavailable", `${disabled.card_name}'s collection is disabled for this Bot; nothing was transferred.`);
    }
  }
  const existing = await first<{ user_id: string }>(
    ctx.db,
    "SELECT user_id FROM fb_trade_acceptances WHERE trade_id = ? AND tenant_id = ? AND revision = ? AND user_id = ?",
    trade.id,
    ctx.tenant.id,
    trade.revision,
    user.id,
  );
  if (existing) throw new ApiError(409, "already_accepted", "You already accepted this revision.");
  const bothAccepted = (await all<{ user_id: string }>(
    ctx.db,
    "SELECT user_id FROM fb_trade_acceptances WHERE trade_id = ? AND tenant_id = ? AND revision = ?",
    trade.id,
    ctx.tenant.id,
    trade.revision,
  )).length >= 1;
  const now = nowIso();
  const complete = bothAccepted; // The new acceptance is the second one when one already exists.
  const statements = [
    ctx.db
      .prepare("INSERT INTO fb_trade_acceptances (tenant_id, trade_id, revision, user_id, accepted_at) VALUES (?, ?, ?, ?, ?)")
      .bind(ctx.tenant.id, trade.id, trade.revision, user.id, now),
  ];
  if (complete) {
    statements.push(
      ctx.db
        .prepare("UPDATE fb_trades SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ? AND status = 'open' AND revision = ?")
        .bind(now, now, trade.id, ctx.tenant.id, trade.revision),
    );
    statements.push(
      ...trade.items.map((item) =>
        ctx.db
          .prepare(
            "UPDATE fb_card_instances SET user_id = ?, status = 'owned', reserved_for = NULL, updated_at = ? WHERE id = ? AND tenant_id = ? AND status = 'reserved' AND reserved_for = ?",
          )
          .bind(item.side === "proposer" ? trade.recipient_id : trade.proposer_id, now, item.instance_id, ctx.tenant.id, trade.id),
      ),
    );
    statements.push(
      ...trade.items.map((item) =>
        ctx.db
          .prepare(
            "INSERT INTO fb_instance_history (id, tenant_id, instance_id, event, from_user_id, to_user_id, reference_type, reference_id, metadata_json, created_at) VALUES (?, ?, ?, 'traded', ?, ?, 'trade', ?, ?, ?)",
          )
          .bind(
            newId("ih"),
            ctx.tenant.id,
            item.instance_id,
            item.side === "proposer" ? trade.proposer_id : trade.recipient_id,
            item.side === "proposer" ? trade.recipient_id : trade.proposer_id,
            trade.id,
            JSON.stringify({ revision: trade.revision }),
            now,
          ),
      ),
    );
    statements.push(
      ctx.db
        .prepare(
          "INSERT INTO fb_outbox (id, tenant_id, topic, payload_json, status, attempts, available_at, created_at) VALUES (?, ?, 'trade.completed', ?, 'pending', 0, ?, ?)",
        )
        .bind(newId("out"), ctx.tenant.id, JSON.stringify({ trade_id: trade.id, revision: trade.revision }), now, now),
    );
  }
  statements.push(
    auditStatement(ctx, complete ? "trade.completed" : "trade.accepted", "trade", trade.id, { revision: trade.revision }),
  );
  try {
    await ctx.db.batch(statements);
  } catch (error) {
    const message = String(error);
    if (message.includes("trade_not_ready") || message.includes("trade_item_invalid")) {
      throw new ApiError(409, "trade_not_ready", "The trade could not be completed because a card or acceptance changed. Nothing was transferred.");
    }
    throw error;
  }
  return getTrade(ctx, trade.id);
}

export async function declineTrade(ctx: Ctx, tradeId: string) {
  const user = ctx.user!;
  const trade = await getTrade(ctx, tradeId);
  if (trade.recipient_id !== user.id) throw new ApiError(403, "recipient_required", "Only the recipient can decline this offer.");
  if (trade.status !== "open") throw new ApiError(409, "trade_not_open", "This trade is no longer open.");
  await releaseTrade(ctx, trade.id, "declined", user.id);
  return getTrade(ctx, trade.id);
}

export async function cancelTrade(ctx: Ctx, tradeId: string) {
  const user = ctx.user!;
  const trade = await getTrade(ctx, tradeId);
  if (trade.proposer_id !== user.id) throw new ApiError(403, "proposer_required", "Only the proposer can cancel this offer.");
  if (trade.status !== "open") throw new ApiError(409, "trade_not_open", "This trade is no longer open.");
  await releaseTrade(ctx, trade.id, "cancelled", user.id);
  return getTrade(ctx, trade.id);
}

async function releaseTrade(ctx: Ctx, tradeId: string, status: "declined" | "cancelled" | "expired", actorId: string) {
  const now = nowIso();
  await ctx.db.batch([
    ctx.db
      .prepare("UPDATE fb_trades SET status = ?, updated_at = ? WHERE id = ? AND tenant_id = ? AND status = 'open'")
      .bind(status, now, tradeId, ctx.tenant.id),
    ctx.db
      .prepare(
        "UPDATE fb_card_instances SET status = 'owned', reserved_for = NULL, updated_at = ? WHERE tenant_id = ? AND reserved_for = ? AND status = 'reserved'",
      )
      .bind(now, ctx.tenant.id, tradeId),
    auditStatement(ctx, `trade.${status}`, "trade", tradeId, { actor_id: actorId }),
  ]);
}

export async function expireTrades(ctx: Ctx) {
  const expired = await all<{ id: string }>(
    ctx.db,
    "SELECT id FROM fb_trades WHERE tenant_id = ? AND status = 'open' AND expires_at <= ?",
    ctx.tenant.id,
    nowIso(),
  );
  for (const trade of expired) await releaseTrade(ctx, trade.id, "expired", "system");
  return { expired: expired.length };
}

export async function createGift(
  ctx: Ctx,
  input: { recipientEmail: string; instanceId: string; idempotencyKey: string; note?: string },
) {
  const user = ctx.user!;
  if (user.synthetic) throw new ApiError(403, "synthetic_transfer_blocked", "NPC collectors cannot gift cards to human members.");
  const recipient = await first<{ id: string }>(
    ctx.db,
    `SELECT u.id FROM fb_users u JOIN fb_memberships m ON m.user_id = u.id WHERE u.email = ? AND m.tenant_id = ? AND u.is_synthetic = 0`,
    input.recipientEmail.trim().toLowerCase(),
    ctx.tenant.id,
  );
  if (!recipient) throw new ApiError(404, "recipient_not_found", "That member is not in this cabinet.");
  if (recipient.id === user.id) throw new ApiError(422, "self_gift", "Choose another member for a gift.");
  const existing = await first<{ id: string }>(
    ctx.db,
    "SELECT id FROM fb_gifts WHERE tenant_id = ? AND sender_id = ? AND idempotency_key = ?",
    ctx.tenant.id,
    user.id,
    input.idempotencyKey,
  );
  if (existing) return { gift_id: existing.id, replayed: true };
  const giftId = newId("gft");
  const now = nowIso();
  try {
    await ctx.db.batch([
      ctx.db
        .prepare(
          "INSERT INTO fb_gifts (id, tenant_id, sender_id, recipient_id, instance_id, status, created_at, completed_at, idempotency_key) VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?)",
        )
        .bind(giftId, ctx.tenant.id, user.id, recipient.id, input.instanceId, now, now, input.idempotencyKey),
      ctx.db
        .prepare(
          "INSERT INTO fb_outbox (id, tenant_id, topic, payload_json, status, attempts, available_at, created_at) VALUES (?, ?, 'gift.completed', ?, 'pending', 0, ?, ?)",
        )
        .bind(newId("out"), ctx.tenant.id, JSON.stringify({ gift_id: giftId }), now, now),
      auditStatement(ctx, "gift.completed", "gift", giftId, { recipient_id: recipient.id, instance_id: input.instanceId }),
    ]);
  } catch (error) {
    const message = String(error);
    if (message.includes("gift_item_unavailable")) {
      throw new ApiError(409, "gift_item_unavailable", "That card is no longer available to gift. Nothing was transferred.");
    }
    if (message.includes("UNIQUE")) throw new ApiError(409, "gift_conflict", "This gift request was already processed.");
    throw error;
  }
  return { gift_id: giftId, instance_id: input.instanceId, recipient_id: recipient.id };
}

export async function listGifts(ctx: Ctx) {
  const user = ctx.user!;
  return all<{ id: string; status: string; created_at: string; completed_at: string | null; recipient_name: string; card_name: string }>(
    ctx.db,
    `SELECT g.id, g.status, g.created_at, g.completed_at, u.display_name AS recipient_name, cd.name AS card_name
       FROM fb_gifts g JOIN fb_users u ON u.id = g.recipient_id JOIN fb_card_instances ci ON ci.id = g.instance_id
       JOIN fb_card_definitions cd ON cd.id = ci.card_id
      WHERE g.tenant_id = ? AND g.sender_id = ? ORDER BY g.created_at DESC LIMIT 100`,
    ctx.tenant.id,
    user.id,
  );
}
