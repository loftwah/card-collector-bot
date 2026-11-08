import { ApiError, type Ctx } from "../context";
import { all, first, nowIso } from "../db";
import { newId, sha256Hex } from "../ids";
import { auditStatement } from "../http";
import { canViewCollection } from "./visibility";
import { acceptTrade, cancelTrade, getTrade } from "./trades";
import { requireActiveMembership } from "./membership";

interface NpcTradeRow {
  id: string;
  tenant_id: string;
  bot_id: string | null;
  user_id: string;
  slug: string;
  name: string;
  preset_key: string;
  status: "active" | "paused" | "retired";
  goals_json: string;
  config_json: string;
  avatar_url: string | null;
  bio: string;
}

interface TradeCopy {
  id: string;
  user_id: string;
  card_id: string;
  card_name: string;
  variant_id: string;
  variant_name: string;
  material_key: string;
  effect_key: string | null;
  serial: string;
  render_url: string | null;
  favourite: number;
  locked: number;
  status: string;
  collection_id: string | null;
  collection_name: string | null;
}

export interface NpcTradePreview {
  npc: {
    id: string;
    name: string;
    slug: string;
    preset: string;
    status: string;
    bio: string;
    avatar_url: string | null;
  };
  decision: "accept" | "decline";
  reason: string;
  give: TradeCopy[];
  take: TradeCopy[];
  wants: {
    new_subjects: string[];
    new_finishes: string[];
    goal_collection: string | null;
    preset_goal: string;
    wishlist: string[];
  };
  spare: Array<{ instance_id: string; card_name: string; serial: string; spare: boolean; reason: string }>;
  expires_in_hours: number;
}

function safeJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function uniqueIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0))];
}

function inputIds(ctx: Ctx, value: unknown, label: string): string[] {
  const ids = uniqueIds(value);
  if (ids.length < 1 || ids.length > 5) {
    throw new ApiError(422, "npc_trade_size", `Choose between 1 and 5 ${label} copies.`);
  }
  return ids;
}

async function loadNpc(ctx: Ctx, npcId: string): Promise<NpcTradeRow> {
  const npc = await first<NpcTradeRow>(
    ctx.db,
    "SELECT id, tenant_id, bot_id, user_id, slug, name, preset_key, status, goals_json, config_json, avatar_url, bio FROM fb_npc_collectors WHERE id = ? AND tenant_id = ?",
    npcId,
    ctx.tenant.id,
  );
  if (!npc) throw new ApiError(404, "npc_not_found", "That NPC collector does not exist in this Bot.");
  if (npc.status !== "active") throw new ApiError(409, "npc_trade_unavailable", `This NPC is ${npc.status} and is not trading.`);
  return npc;
}

async function assertNpcAvailable(ctx: Ctx, npc: NpcTradeRow) {
  const bot = await first<{ id: string; status: string }>(
    ctx.db,
    "SELECT id, status FROM fb_bots WHERE tenant_id = ? AND id = ?",
    ctx.tenant.id,
    npc.bot_id,
  );
  if (!bot || bot.status !== "active") {
    throw new ApiError(409, "npc_trade_unavailable", "The Bot is paused or archived; NPC trading is unavailable.");
  }
  const limits = await first<{ paused_all: number }>(
    ctx.db,
    "SELECT paused_all FROM fb_npc_limits WHERE tenant_id = ?",
    ctx.tenant.id,
  );
  if (limits?.paused_all) throw new ApiError(409, "npc_trade_unavailable", "All NPC progression is paused for this Bot.");
  return bot;
}

async function primaryCollection(ctx: Ctx, cardId: string) {
  return first<{ id: string; name: string; status: string; archived_at: string | null }>(
    ctx.db,
    `SELECT c.id, c.name, c.status, c.archived_at
       FROM fb_collection_cards cc JOIN fb_collections c ON c.id = cc.collection_id
      WHERE cc.tenant_id = ? AND cc.card_id = ?
      ORDER BY CASE c.scope WHEN 'global' THEN 0 ELSE 1 END, c.name LIMIT 1`,
    ctx.tenant.id,
    cardId,
  );
}

async function copiesFor(
  ctx: Ctx,
  userId: string,
  ids: string[],
  botId: string,
): Promise<TradeCopy[]> {
  if (!ids.length) return [];
  const rows = await all<TradeCopy>(
    ctx.db,
    `SELECT ci.id, ci.user_id, ci.card_id, cd.name AS card_name, ci.variant_id, v.name AS variant_name,
            m.key AS material_key, fx.key AS effect_key, ci.serial, ci.favourite, ci.locked, ci.status,
            ('/media/render/' || vr.asset_id) AS render_url,
            NULL AS collection_id, NULL AS collection_name
       FROM fb_card_instances ci
       JOIN fb_card_definitions cd ON cd.id = ci.card_id AND cd.tenant_id = ci.tenant_id
       JOIN fb_variants v ON v.id = ci.variant_id AND v.tenant_id = ci.tenant_id
       JOIN fb_materials m ON m.id = v.material_id
       LEFT JOIN fb_effects fx ON fx.id = v.effect_id
       LEFT JOIN fb_variant_renders vr ON vr.variant_id = v.id AND vr.tenant_id = ci.tenant_id AND vr.status = 'published'
      WHERE ci.tenant_id = ? AND ci.user_id = ? AND ci.id IN (${ids.map(() => "?").join(",")})
      ORDER BY cd.name, ci.serial`,
    ctx.tenant.id,
    userId,
    ...ids,
  );
  const found = new Map(rows.map((row) => [row.id, row]));
  for (const id of ids) {
    const row = found.get(id);
    if (!row) throw new ApiError(404, "trade_copy_not_found", "One of the selected copies is not in that collection.");
    if (row.status !== "owned" || row.locked) {
      throw new ApiError(409, "trade_copy_unavailable", `${row.card_name} ${row.serial} is locked, reserved or not owned.`);
    }
    const collection = await primaryCollection(ctx, row.card_id);
    if (!collection || collection.status !== "published" || collection.archived_at) {
      throw new ApiError(409, "trade_collection_unavailable", `${row.card_name} is not in a published collection.`);
    }
    if (!(await canViewCollection(ctx, collection.id))) {
      throw new ApiError(403, "trade_collection_forbidden", `${row.card_name} is not available to this member.`);
    }
    const enabled = await first<{ enabled: number }>(
      ctx.db,
      "SELECT enabled FROM fb_bot_collections WHERE bot_id = ? AND collection_id = ?",
      botId,
      collection.id,
    );
    if (!enabled?.enabled) {
      throw new ApiError(409, "trade_collection_disabled", `${row.card_name}'s collection is disabled for this Bot.`);
    }
    row.collection_id = collection.id;
    row.collection_name = collection.name;
  }
  return ids.map((id) => found.get(id)!);
}

async function npcInventory(ctx: Ctx, npc: NpcTradeRow) {
  return all<TradeCopy>(
    ctx.db,
    `SELECT ci.id, ci.user_id, ci.card_id, cd.name AS card_name, ci.variant_id, v.name AS variant_name,
            m.key AS material_key, fx.key AS effect_key, ci.serial, ci.favourite, ci.locked, ci.status,
            ('/media/render/' || vr.asset_id) AS render_url,
            NULL AS collection_id, NULL AS collection_name
       FROM fb_card_instances ci
       JOIN fb_card_definitions cd ON cd.id = ci.card_id AND cd.tenant_id = ci.tenant_id
       JOIN fb_variants v ON v.id = ci.variant_id AND v.tenant_id = ci.tenant_id
       JOIN fb_materials m ON m.id = v.material_id
       LEFT JOIN fb_effects fx ON fx.id = v.effect_id
       LEFT JOIN fb_variant_renders vr ON vr.variant_id = v.id AND vr.tenant_id = ci.tenant_id AND vr.status = 'published'
      WHERE ci.tenant_id = ? AND ci.user_id = ? AND ci.status = 'owned'
      ORDER BY cd.name, ci.serial`,
    ctx.tenant.id,
    npc.user_id,
  );
}

async function wishlists(ctx: Ctx, npc: NpcTradeRow) {
  return all<{ card_id: string; card_name: string }>(
    ctx.db,
    `SELECT w.card_id, cd.name AS card_name FROM fb_wishlists w
       JOIN fb_card_definitions cd ON cd.id = w.card_id
      WHERE w.tenant_id = ? AND w.user_id = ? ORDER BY cd.name`,
    ctx.tenant.id,
    npc.user_id,
  );
}

function finishKey(material: string, effect: string | null) {
  return `${material}:${effect ?? "none"}`;
}

async function evaluate(
  ctx: Ctx,
  npc: NpcTradeRow,
  give: TradeCopy[],
  take: TradeCopy[],
): Promise<NpcTradePreview> {
  const goals = safeJson<{ collection_id?: string | null; preset_goal?: string }>(npc.goals_json, {});
  const inventory = await npcInventory(ctx, npc);
  const wishlist = await wishlists(ctx, npc);
  const ownedCards = new Set(inventory.map((copy) => copy.card_id));
  const ownedFinishes = new Set(inventory.map((copy) => `${copy.card_id}:${finishKey(copy.material_key, copy.effect_key)}`));
  const copyCount = new Map<string, number>();
  for (const copy of inventory) copyCount.set(copy.card_id, (copyCount.get(copy.card_id) ?? 0) + 1);
  const newSubjects: string[] = [];
  const newFinishes: string[] = [];
  const wishHits: string[] = [];
  let wantScore = 0;
  for (const copy of give) {
    const isNewSubject = !ownedCards.has(copy.card_id);
    const isNewFinish = !ownedFinishes.has(`${copy.card_id}:${finishKey(copy.material_key, copy.effect_key)}`);
    const goalMatch = Boolean(goals.collection_id && copy.collection_id === goals.collection_id);
    const presetMatch =
      (goals.preset_goal === "gold" || npc.preset_key === "gold_hunter") && copy.material_key === "gold";
    const holoMatch =
      (goals.preset_goal === "holographic" || npc.preset_key === "holo_hunter") &&
      (copy.effect_key === "holographic" || copy.effect_key === "holo");
    const wish = wishlist.some((item) => item.card_id === copy.card_id);
    if (isNewSubject) {
      newSubjects.push(copy.card_name);
      wantScore += 2;
    }
    if (isNewFinish) {
      newFinishes.push(`${copy.card_name} · ${copy.variant_name}`);
      wantScore += 1;
    }
    if (goalMatch) wantScore += 1;
    if (presetMatch || holoMatch) wantScore += 1;
    if (wish) {
      wishHits.push(copy.card_name);
      wantScore += 1;
    }
  }
  const spare = take.map((copy) => {
    const count = copyCount.get(copy.card_id) ?? 0;
    const goalMatch = Boolean(goals.collection_id && copy.collection_id === goals.collection_id);
    const presetMatch =
      (goals.preset_goal === "gold" || npc.preset_key === "gold_hunter") && copy.material_key === "gold";
    const holoMatch =
      (goals.preset_goal === "holographic" || npc.preset_key === "holo_hunter") &&
      (copy.effect_key === "holographic" || copy.effect_key === "holo");
    if (copy.locked || copy.status !== "owned") {
      return { instance_id: copy.id, card_name: copy.card_name, serial: copy.serial, spare: false, reason: "locked or unavailable" };
    }
    if (copy.favourite) {
      return { instance_id: copy.id, card_name: copy.card_name, serial: copy.serial, spare: false, reason: "the NPC pinned this copy" };
    }
    if (count <= 1 && (goalMatch || presetMatch || holoMatch)) {
      return { instance_id: copy.id, card_name: copy.card_name, serial: copy.serial, spare: false, reason: "the NPC's only goal copy" };
    }
    if (count <= 1) {
      return { instance_id: copy.id, card_name: copy.card_name, serial: copy.serial, spare: true, reason: "single non-goal copy" };
    }
    return { instance_id: copy.id, card_name: copy.card_name, serial: copy.serial, spare: true, reason: "duplicate copy" };
  });
  const blocked = spare.find((item) => !item.spare);
  let decision: "accept" | "decline" = "accept";
  let reason = "";
  if (blocked) {
    decision = "decline";
    reason = `The collector cannot spare ${blocked.card_name} ${blocked.serial}: ${blocked.reason}.`;
  } else if (wantScore <= 0) {
    decision = "decline";
    reason = "The offer does not add a new subject, finish, goal card or wishlist card.";
  } else if (wantScore < take.length) {
    decision = "decline";
    reason = `The offer adds ${wantScore} want${wantScore === 1 ? "" : "s"} but requests ${take.length} copies; the collector wants a fairer exchange.`;
  } else {
    reason = `The collector accepts: the offer adds ${wantScore} want${wantScore === 1 ? "" : "s"} and every requested copy is spare.`;
  }
  return {
    npc: {
      id: npc.id,
      name: npc.name,
      slug: npc.slug,
      preset: npc.preset_key,
      status: npc.status,
      bio: npc.bio,
      avatar_url: npc.avatar_url,
    },
    decision,
    reason,
    give,
    take,
    wants: {
      new_subjects: newSubjects,
      new_finishes: newFinishes,
      goal_collection: goals.collection_id ?? null,
      preset_goal: goals.preset_goal ?? npc.preset_key,
      wishlist: wishHits,
    },
    spare,
    expires_in_hours: 48,
  };
}

export async function npcTradeOffers(
  ctx: Ctx,
  npcId: string,
  options?: { allowedCardIds?: Set<string> },
) {
  await requireActiveMembership(ctx);
  const npc = await loadNpc(ctx, npcId);
  await assertNpcAvailable(ctx, npc);
  const inventory = await npcInventory(ctx, npc);
  const goals = safeJson<{ collection_id?: string | null; preset_goal?: string }>(npc.goals_json, {});
  const wishlist = await wishlists(ctx, npc);
  const copies = [];
  for (const copy of inventory) {
    if (options?.allowedCardIds && !options.allowedCardIds.has(copy.card_id)) continue;
    const collection = await primaryCollection(ctx, copy.card_id);
    if (!collection) continue;
    if (!(await canViewCollection(ctx, collection.id))) continue;
    const enabled = await first<{ enabled: number }>(
      ctx.db,
      "SELECT enabled FROM fb_bot_collections WHERE bot_id = ? AND collection_id = ?",
      npc.bot_id,
      collection.id,
    );
    if (!enabled?.enabled) continue;
    copy.collection_id = collection.id;
    copy.collection_name = collection.name;
    copies.push(copy);
  }
  const goalCards = all<{ id: string; name: string }>(
    ctx.db,
    goals.collection_id
      ? `SELECT cd.id, cd.name FROM fb_collection_cards cc JOIN fb_card_definitions cd ON cd.id = cc.card_id
          WHERE cc.collection_id = ? AND cd.status = 'published' AND cd.archived_at IS NULL ORDER BY cd.name`
      : `SELECT cd.id, cd.name FROM fb_card_definitions cd WHERE cd.tenant_id = ? AND cd.status = 'published' AND cd.archived_at IS NULL ORDER BY cd.name`,
    goals.collection_id ?? ctx.tenant.id,
  );
  const goalRows = await goalCards;
  const ownedCards = new Set(inventory.map((copy) => copy.card_id));
  return {
    npc: {
      id: npc.id,
      name: npc.name,
      slug: npc.slug,
      preset: npc.preset_key,
      status: npc.status,
      bio: npc.bio,
      avatar_url: npc.avatar_url,
      synthetic_label: "NPC · synthetic collector",
    },
    copies,
    wants: {
      goal_collection: goals.collection_id ?? null,
      preset_goal: goals.preset_goal ?? npc.preset_key,
      missing_subjects: goalRows.filter((card) => !ownedCards.has(card.id)).map((card) => card.name),
      wishlist: wishlist.map((item) => item.card_name),
    },
  };
}

export async function previewNpcTrade(
  ctx: Ctx,
  input: { npcId: string; giveInstanceIds?: unknown; takeInstanceIds?: unknown },
): Promise<NpcTradePreview> {
  const user = ctx.user;
  if (!user) throw new ApiError(401, "authentication_required", "Sign in to trade with a collector.");
  await requireActiveMembership(ctx);
  if (user.synthetic) throw new ApiError(403, "synthetic_trade_blocked", "NPC collectors cannot initiate human trades.");
  const npc = await loadNpc(ctx, input.npcId);
  await assertNpcAvailable(ctx, npc);
  const giveIds = inputIds(ctx, input.giveInstanceIds, "offered");
  const takeIds = inputIds(ctx, input.takeInstanceIds, "requested");
  if (giveIds.some((id) => takeIds.includes(id))) throw new ApiError(422, "npc_trade_duplicate", "A copy cannot be on both sides.");
  const give = await copiesFor(ctx, user.id, giveIds, npc.bot_id!);
  const take = await copiesFor(ctx, npc.user_id, takeIds, npc.bot_id!);
  return evaluate(ctx, npc, give, take);
}

export async function createNpcTrade(
  ctx: Ctx,
  input: { npcId: string; giveInstanceIds?: unknown; takeInstanceIds?: unknown; idempotencyKey?: string },
) {
  const user = ctx.user;
  if (!user) throw new ApiError(401, "authentication_required", "Sign in to trade with a collector.");
  await requireActiveMembership(ctx);
  const npc = await loadNpc(ctx, input.npcId);
  await assertNpcAvailable(ctx, npc);
  const digest = (await sha256Hex(JSON.stringify({ npc: input.npcId, give: input.giveInstanceIds, take: input.takeInstanceIds }))).slice(0, 32);
  const key = input.idempotencyKey?.trim() || `npc-trade:${user.id}:${digest}`;
  const existing = await first<{ id: string }>(
    ctx.db,
    "SELECT id FROM fb_trades WHERE tenant_id = ? AND idempotency_key = ?",
    ctx.tenant.id,
    key,
  );
  if (existing) {
    const detail = await getNpcTrade(ctx, existing.id);
    return { replayed: true, trade: detail.trade, decision: detail.decision };
  }
  const preview = await previewNpcTrade(ctx, input);
  if (preview.decision !== "accept") {
    throw new ApiError(409, "npc_trade_declined", preview.reason, { decision: preview });
  }
  const tradeId = newId("trd");
  const now = nowIso();
  const expiresAt = new Date(Date.now() + preview.expires_in_hours * 3600 * 1000).toISOString();
  const statements = [
    ctx.db
      .prepare(
        "INSERT INTO fb_trades (id, tenant_id, proposer_id, recipient_id, status, revision, expires_at, created_at, updated_at, idempotency_key) VALUES (?, ?, ?, ?, 'open', 1, ?, ?, ?, ?)",
      )
      .bind(tradeId, ctx.tenant.id, user.id, npc.user_id, expiresAt, now, now, key),
    ...preview.give.map((copy) =>
      ctx.db
        .prepare("INSERT INTO fb_trade_items (id, tenant_id, trade_id, side, instance_id, created_at) VALUES (?, ?, ?, 'proposer', ?, ?)")
        .bind(newId("tri"), ctx.tenant.id, tradeId, copy.id, now),
    ),
    ...preview.take.map((copy) =>
      ctx.db
        .prepare("INSERT INTO fb_trade_items (id, tenant_id, trade_id, side, instance_id, created_at) VALUES (?, ?, ?, 'recipient', ?, ?)")
        .bind(newId("tri"), ctx.tenant.id, tradeId, copy.id, now),
    ),
    ctx.db
      .prepare("INSERT INTO fb_trade_acceptances (tenant_id, trade_id, revision, user_id, accepted_at) VALUES (?, ?, 1, ?, ?)")
      .bind(ctx.tenant.id, tradeId, npc.user_id, now),
    ctx.db
      .prepare(
        "INSERT INTO fb_npc_trade_decisions (tenant_id, trade_id, npc_id, decision, reason, wants_json, spare_json, created_at) VALUES (?, ?, ?, 'accept', ?, ?, ?, ?)",
      )
      .bind(
        ctx.tenant.id,
        tradeId,
        preview.npc.id,
        preview.reason,
        JSON.stringify(preview.wants),
        JSON.stringify(preview.spare),
        now,
      ),
    auditStatement(ctx, "npc_trade.created", "trade", tradeId, {
      npc_id: preview.npc.id,
      give: preview.give.map((copy) => copy.serial),
      take: preview.take.map((copy) => copy.serial),
      reason: preview.reason,
    }),
  ];
  try {
    await ctx.db.batch(statements);
  } catch (error) {
    const message = String(error);
    if (message.includes("trade_item_unavailable")) {
      throw new ApiError(409, "trade_copy_unavailable", "A selected copy changed before the offer was created. Nothing was reserved.");
    }
    if (message.includes("UNIQUE")) throw new ApiError(409, "npc_trade_duplicate", "That exact offer was already created.");
    throw error;
  }
  return { replayed: false, trade: await getTrade(ctx, tradeId), decision: preview };
}

async function npcTradeRow(ctx: Ctx, tradeId: string) {
  return first<{
    trade_id: string;
    npc_id: string;
    decision: string;
    reason: string;
    wants_json: string;
    spare_json: string;
    proposer_id: string;
    recipient_id: string;
    status: string;
    npc_user_id: string;
    npc_name: string;
  }>(
    ctx.db,
    `SELECT d.trade_id, d.npc_id, d.decision, d.reason, d.wants_json, d.spare_json,
            t.proposer_id, t.recipient_id, t.status, n.user_id AS npc_user_id, n.name AS npc_name
       FROM fb_npc_trade_decisions d JOIN fb_trades t ON t.id = d.trade_id
       JOIN fb_npc_collectors n ON n.id = d.npc_id
      WHERE d.tenant_id = ? AND d.trade_id = ? AND t.tenant_id = ?`,
    ctx.tenant.id,
    tradeId,
    ctx.tenant.id,
  );
}

export async function getNpcTrade(ctx: Ctx, tradeId: string) {
  await requireActiveMembership(ctx);
  const row = await npcTradeRow(ctx, tradeId);
  if (!row) throw new ApiError(404, "npc_trade_not_found", "NPC trade not found.");
  return {
    trade: await getTrade(ctx, tradeId),
    decision: {
      decision: row.decision,
      reason: row.reason,
      wants: safeJson(row.wants_json, {}),
      spare: safeJson(row.spare_json, []),
      npc_id: row.npc_id,
      npc_name: row.npc_name,
    },
  };
}

export async function confirmNpcTrade(ctx: Ctx, tradeId: string) {
  const user = ctx.user;
  if (!user) throw new ApiError(401, "authentication_required", "Sign in to confirm the exchange.");
  await requireActiveMembership(ctx);
  const row = await npcTradeRow(ctx, tradeId);
  if (!row) throw new ApiError(404, "npc_trade_not_found", "NPC trade not found.");
  if (row.proposer_id !== user.id) throw new ApiError(403, "not_your_trade", "Only the proposing member can confirm this exchange.");
  if (row.status === "completed") {
    return { replayed: true, ...(await getNpcTrade(ctx, tradeId)) };
  }
  if (row.status !== "open") throw new ApiError(409, "npc_trade_not_open", `This trade is ${row.status}.`);
  const npc = await first<NpcTradeRow>(
    ctx.db,
    "SELECT id, tenant_id, bot_id, user_id, slug, name, preset_key, status, goals_json, config_json, avatar_url, bio FROM fb_npc_collectors WHERE id = ? AND tenant_id = ?",
    row.npc_id,
    ctx.tenant.id,
  );
  if (!npc) throw new ApiError(404, "npc_not_found", "The NPC collector no longer exists.");
  if (npc.status !== "active") throw new ApiError(409, "npc_trade_unavailable", `This NPC is ${npc.status} and is not trading.`);
  await assertNpcAvailable(ctx, npc);
  const bot = await first<{ id: string }>(ctx.db, "SELECT id FROM fb_bots WHERE tenant_id = ? AND id = ?", ctx.tenant.id, npc.bot_id);
  const trade = await getTrade(ctx, tradeId);
  for (const item of trade.items) {
    const copy = await first<{ card_id: string; card_name: string }>(
      ctx.db,
      `SELECT ci.card_id, cd.name AS card_name FROM fb_card_instances ci JOIN fb_card_definitions cd ON cd.id = ci.card_id WHERE ci.id = ? AND ci.tenant_id = ?`,
      item.instance_id,
      ctx.tenant.id,
    );
    if (!copy) throw new ApiError(409, "npc_trade_unavailable", "A copy in this trade no longer exists.");
    const collection = await primaryCollection(ctx, copy.card_id);
    if (!collection || collection.status !== "published" || collection.archived_at) {
      throw new ApiError(409, "npc_trade_unavailable", `${copy.card_name} is no longer in a published collection.`);
    }
    const enabled = await first<{ enabled: number }>(
      ctx.db,
      "SELECT enabled FROM fb_bot_collections WHERE bot_id = ? AND collection_id = ?",
      bot?.id ?? npc.bot_id,
      collection.id,
    );
    if (!enabled?.enabled) {
      throw new ApiError(409, "npc_trade_unavailable", `${copy.card_name}'s collection is disabled for this Bot.`);
    }
  }
  const completed = await acceptTrade(ctx, tradeId);
  return { replayed: false, ...(await getNpcTrade(ctx, tradeId)), trade: completed };
}

export async function cancelNpcTrade(ctx: Ctx, tradeId: string) {
  const user = ctx.user;
  if (!user) throw new ApiError(401, "authentication_required", "Sign in to cancel the exchange.");
  await requireActiveMembership(ctx);
  const row = await npcTradeRow(ctx, tradeId);
  if (!row) throw new ApiError(404, "npc_trade_not_found", "NPC trade not found.");
  if (row.proposer_id !== user.id) throw new ApiError(403, "not_your_trade", "Only the proposing member can cancel this exchange.");
  if (row.status !== "open") throw new ApiError(409, "npc_trade_not_open", `This trade is ${row.status}.`);
  const trade = await cancelTrade(ctx, tradeId);
  return { trade, decision: (await getNpcTrade(ctx, tradeId)).decision };
}

export async function listNpcTrades(ctx: Ctx) {
  const user = ctx.user;
  if (!user) throw new ApiError(401, "authentication_required", "Sign in to see NPC trades.");
  await requireActiveMembership(ctx);
  const rows = await all<{
    id: string;
    status: string;
    revision: number;
    expires_at: string;
    updated_at: string;
    npc_name: string;
    item_count: number;
    reason: string;
    decision: string;
  }>(
    ctx.db,
    `SELECT t.id, t.status, t.revision, t.expires_at, t.updated_at, n.name AS npc_name,
            (SELECT COUNT(*) FROM fb_trade_items ti WHERE ti.trade_id = t.id) AS item_count,
            d.reason, d.decision
       FROM fb_trades t JOIN fb_npc_trade_decisions d ON d.trade_id = t.id
       JOIN fb_npc_collectors n ON n.id = d.npc_id
      WHERE t.tenant_id = ? AND t.proposer_id = ?
      ORDER BY t.updated_at DESC LIMIT 50`,
    ctx.tenant.id,
    user.id,
  );
  return rows;
}
