import type { D1Database } from "@cloudflare/workers-types";
import { ApiError, hasCapability, type Ctx, type CurrentUser } from "../context";
import { all, first, nowIso } from "../db";
import { newId, sha256Hex } from "../ids";
import { creditWallet } from "./wallet";
import { addMembership, ensureWallet } from "./identity";
import { executeDraw, getPoolPreview, listPools, type PoolPreview } from "./pools";

export interface NpcPreset {
  key: string;
  label: string;
  description: string;
  behaviour: string;
  goal: "new_subjects" | "complete_collection" | "gold" | "holographic" | "variety" | "friendly" | "rookie" | "rival";
}

export const NPC_PRESETS: NpcPreset[] = [
  { key: "casual_explorer", label: "Casual Explorer", description: "Occasional draws across whatever the Bot has enabled.", behaviour: "Chooses an affordable capsule and never exceeds the ordinary odds.", goal: "new_subjects" },
  { key: "completionist", label: "Completionist", description: "Pursues missing subjects in a named collection.", behaviour: "Prefers capsules containing an unowned subject from the chosen focus collection.", goal: "complete_collection" },
  { key: "gold_hunter", label: "Gold Hunter", description: "Pursues the all-Gold goal without better draw odds.", behaviour: "Prefers a capsule with an unowned Gold finish in the focus collection.", goal: "gold" },
  { key: "holo_hunter", label: "Holographic Hunter", description: "Pursues Holographic mastery through ordinary eligible pools.", behaviour: "Prefers a capsule with an unowned Holographic finish.", goal: "holographic" },
  { key: "variety_collector", label: "Variety Collector", description: "Prefers new subjects and collections over duplicates.", behaviour: "Scores capsules by the number of subjects the NPC does not own.", goal: "variety" },
  { key: "friendly_collector", label: "Friendly Collector", description: "Enjoys displaying favourites; no automated human contact.", behaviour: "Draws at the cheapest ordinary price and pins favourites for its profile.", goal: "friendly" },
  { key: "rookie", label: "Rookie", description: "Starts with little progression and is ideal for a first-run demo.", behaviour: "Chooses the cheapest eligible capsule.", goal: "rookie" },
  { key: "established_rival", label: "Established Rival", description: "An accumulated, auditable collection history — never an invented biography.", behaviour: "Uses the same economy, preferring the focus collection.", goal: "rival" },
];

const DEFAULT_LIMITS = { max_npcs: 20, max_draws_per_day: 40, paused_all: 0 };

interface NpcRow {
  id: string;
  tenant_id: string;
  bot_id: string | null;
  user_id: string;
  slug: string;
  name: string;
  preset_key: string;
  preset_version: number;
  avatar_url: string | null;
  bio: string;
  status: "active" | "paused" | "retired";
  goals_json: string;
  config_json: string;
  schedule_json: string;
  actions_count: number;
  last_action_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  retired_at: string | null;
}

export function requireNpcRead(ctx: Ctx): CurrentUser {
  const user = ctx.user;
  if (!user) throw new ApiError(401, "authentication_required", "Sign in to inspect collectors.");
  if (ctx.actor.type === "agent" && !ctx.scopes?.includes("npc:read")) {
    throw new ApiError(403, "insufficient_scope", "The agent grant does not include npc:read.");
  }
  return user;
}

export function requireNpcManager(ctx: Ctx): CurrentUser {
  const user = requireNpcRead(ctx);
  if (ctx.actor.type === "agent" && !ctx.scopes?.includes("npc:write")) {
    throw new ApiError(403, "insufficient_scope", "The agent grant does not include npc:write.");
  }
  if (!user.platformAdmin && !hasCapability(user, "npc.manage")) {
    throw new ApiError(403, "npc_management_required", "Your role does not include NPC collector management.");
  }
  return user;
}

async function botForTenant(db: D1Database, tenantId: string) {
  return first<{ id: string; name: string; status: string }>(db, "SELECT id, name, status FROM fb_bots WHERE tenant_id = ?", tenantId);
}

async function limitsFor(db: D1Database, tenantId: string) {
  const row = await first<{ max_npcs: number; max_draws_per_day: number; paused_all: number }>(
    db,
    "SELECT max_npcs, max_draws_per_day, paused_all FROM fb_npc_limits WHERE tenant_id = ?",
    tenantId,
  );
  return row ?? DEFAULT_LIMITS;
}

function safeJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function safeUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) return trimmed;
  if (/^https:\/\//i.test(trimmed)) return trimmed;
  return null;
}

function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || newId("npc");
}

function npcUser(npc: NpcRow): CurrentUser {
  return {
    id: npc.user_id,
    email: `npc.${npc.id}@synthetic.invalid`,
    displayName: npc.name,
    role: "player",
    platformAdmin: false,
    capabilities: [],
    synthetic: true,
  };
}

function npcContext(ctx: Ctx, npc: NpcRow): Ctx {
  return {
    ...ctx,
    user: npcUser(npc),
    actor: {
      type: "user",
      id: npc.user_id,
      representedUserId: npc.user_id,
      label: `NPC ${npc.name}`,
    },
    scopes: null,
    csrfToken: "",
    sessionId: null,
    sessionAssurance: null,
    sessionAuthTime: null,
  };
}

export async function listNpcs(ctx: Ctx) {
  const rows = await all<NpcRow>(
    ctx.db,
    "SELECT * FROM fb_npc_collectors WHERE tenant_id = ? ORDER BY status = 'active' DESC, name",
    ctx.tenant.id,
  );
  const [limits, bot] = await Promise.all([limitsFor(ctx.db, ctx.tenant.id), botForTenant(ctx.db, ctx.tenant.id)]);
  return Promise.all(rows.map(async (row) => ({ ...(await npcSummary(ctx, row)), limits, bot_status: bot?.status ?? "missing" })));
}

async function npcSummary(ctx: Ctx, npc: NpcRow) {
  const [inventory, balance] = await Promise.all([
    first<{ cards: number; subjects: number; gold: number; holo: number }>(
      ctx.db,
      `SELECT COUNT(*) AS cards,
              COUNT(DISTINCT ci.card_id) AS subjects,
              SUM(CASE WHEN m.key = 'gold' THEN 1 ELSE 0 END) AS gold,
              SUM(CASE WHEN e.key IN ('holographic','holo') THEN 1 ELSE 0 END) AS holo
         FROM fb_card_instances ci
         JOIN fb_variants v ON v.id = ci.variant_id
         JOIN fb_materials m ON m.id = v.material_id
         LEFT JOIN fb_effects e ON e.id = v.effect_id
        WHERE ci.tenant_id = ? AND ci.user_id = ? AND ci.status IN ('owned','reserved')`,
      ctx.tenant.id,
      npc.user_id,
    ),
    first<{ balance: number }>(ctx.db, "SELECT balance FROM fb_wallets WHERE tenant_id = ? AND user_id = ?", ctx.tenant.id, npc.user_id),
  ]);
  const preset = NPC_PRESETS.find((item) => item.key === npc.preset_key) ?? NPC_PRESETS[0]!;
  return {
    id: npc.id,
    name: npc.name,
    slug: npc.slug,
    preset_key: npc.preset_key,
    preset_label: preset.label,
    preset_version: npc.preset_version,
    avatar_url: npc.avatar_url,
    bio: npc.bio,
    status: npc.status,
    goals: safeJson(npc.goals_json, {}),
    config: safeJson(npc.config_json, {}),
    schedule: safeJson(npc.schedule_json, { enabled: false, interval_minutes: 1440 }),
    actions_count: npc.actions_count,
    last_action_at: npc.last_action_at,
    created_at: npc.created_at,
    retired_at: npc.retired_at,
    synthetic_label: "NPC · synthetic collector",
    cards: inventory?.cards ?? 0,
    subjects: inventory?.subjects ?? 0,
    gold: inventory?.gold ?? 0,
    holographic: inventory?.holo ?? 0,
    balance: balance?.balance ?? 0,
  };
}

export async function getNpc(ctx: Ctx, id: string) {
  const npc = await first<NpcRow>(ctx.db, "SELECT * FROM fb_npc_collectors WHERE id = ? AND tenant_id = ?", id, ctx.tenant.id);
  if (!npc) throw new ApiError(404, "npc_not_found", "That NPC collector does not exist in this Bot.");
  return { row: npc, summary: await npcSummary(ctx, npc) };
}

export async function listNpcPresets() {
  return NPC_PRESETS;
}

export async function createNpc(
  ctx: Ctx,
  input: {
    name: string;
    presetKey: string;
    bio?: string;
    avatarUrl?: string | null;
    goalCollectionId?: string | null;
    poolSlug?: string | null;
    startingBalance?: number;
    scheduleEnabled?: boolean;
    intervalMinutes?: number;
  },
) {
  requireNpcManager(ctx);
  const preset = NPC_PRESETS.find((item) => item.key === input.presetKey);
  if (!preset) throw new ApiError(422, "npc_preset_invalid", "Choose a supported NPC preset.");
  const bot = await botForTenant(ctx.db, ctx.tenant.id);
  if (!bot) throw new ApiError(409, "npc_bot_missing", "This installation has no Bot record.");
  if (bot.status !== "active") throw new ApiError(409, "npc_bot_inactive", "The Bot is paused or archived; NPCs cannot act.");
  const limits = await limitsFor(ctx.db, ctx.tenant.id);
  const count = await first<{ count: number }>(ctx.db, "SELECT COUNT(*) AS count FROM fb_npc_collectors WHERE tenant_id = ? AND status <> 'retired'", ctx.tenant.id);
  if ((count?.count ?? 0) >= limits.max_npcs) throw new ApiError(409, "npc_limit", `This Bot already has the maximum of ${limits.max_npcs} active NPC collectors.`);

  const name = input.name.trim().slice(0, 80);
  if (name.length < 2) throw new ApiError(422, "npc_name_required", "Give the NPC a display name.");
  const id = newId("npc");
  const userId = newId("usr");
  const now = nowIso();
  let slug = slugify(name);
  const slugTaken = await first<{ id: string }>(ctx.db, "SELECT id FROM fb_npc_collectors WHERE tenant_id = ? AND slug = ?", ctx.tenant.id, slug);
  if (slugTaken) slug = `${slug}-${id.slice(-5).toLowerCase()}`;
  const email = `npc.${id}@synthetic.invalid`;
  const goals = {
    collection_id: input.goalCollectionId ?? null,
    pool_slug: input.poolSlug ?? null,
    preset_goal: preset.goal,
    target_subjects: 0,
    last_progress: null,
  };
  await ctx.db.batch([
    ctx.db
      .prepare(
        "INSERT INTO fb_users (id, email, display_name, password_hash, platform_admin, created_at, is_synthetic, synthetic_kind) VALUES (?, ?, ?, ?, 0, ?, 1, 'npc')",
      )
      .bind(userId, email, name, await sha256Hex(`synthetic:${id}:${now}`), now),
    ctx.db
      .prepare(
        "INSERT INTO fb_npc_collectors (id, tenant_id, bot_id, user_id, slug, name, preset_key, preset_version, avatar_url, bio, status, goals_json, config_json, schedule_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'active', ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        id,
        ctx.tenant.id,
        bot.id,
        userId,
        slug,
        name,
        preset.key,
        safeUrl(input.avatarUrl),
        (input.bio ?? preset.description).trim().slice(0, 500),
        JSON.stringify(goals),
        JSON.stringify({ pool_slug: input.poolSlug ?? null }),
        JSON.stringify({ enabled: Boolean(input.scheduleEnabled), interval_minutes: Math.max(15, Math.min(10080, input.intervalMinutes ?? 1440)) }),
        ctx.user!.id,
        now,
        now,
      ),
    ctx.db
      .prepare("INSERT INTO fb_npc_limits (tenant_id, updated_at) VALUES (?, ?) ON CONFLICT(tenant_id) DO NOTHING")
      .bind(ctx.tenant.id, now),
  ]);
  await addMembership(ctx.db, ctx.tenant.id, userId, "player", { acceptedAt: now });
  await ensureWallet(ctx.db, ctx.tenant.id, userId);
  const economy = await first<{ starter_grant: number }>(ctx.db, "SELECT starter_grant FROM fb_economy_settings WHERE tenant_id = ?", ctx.tenant.id);
  const starting = Math.max(0, Math.min(10000, input.startingBalance ?? economy?.starter_grant ?? 800));
  if (starting > 0) {
    await creditWallet(ctx.db, {
      tenantId: ctx.tenant.id,
      userId,
      amount: starting,
      kind: "issue",
      description: `Founding allowance for NPC ${name}`,
      idempotencyKey: `npc-welcome:${id}`,
      referenceType: "npc",
      referenceId: id,
      actorType: "user",
      actorId: ctx.user!.id,
      metadata: { synthetic: true },
    });
  }
  await ctx.db
    .prepare(
      "INSERT INTO fb_audit_events (id, tenant_id, actor_type, actor_id, represented_user_id, action, object_type, object_id, metadata_json, request_id, created_at) VALUES (?, ?, 'user', ?, ?, 'npc.created', 'npc', ?, ?, ?, ?)",
    )
    .bind(newId("aud"), ctx.tenant.id, ctx.user!.id, ctx.user!.id, id, JSON.stringify({ preset: preset.key, starting_balance: starting }), ctx.requestId, now)
    .run();
  return (await getNpc(ctx, id)).summary;
}

export async function createNpcBatch(ctx: Ctx, input: { presetKeys: string[]; prefix?: string; goalCollectionId?: string | null }) {
  requireNpcManager(ctx);
  if (input.presetKeys.length === 0 || input.presetKeys.length > 10) throw new ApiError(422, "npc_batch_size", "Create between 1 and 10 NPCs at a time.");
  const created = [];
  for (const presetKey of input.presetKeys) {
    const preset = NPC_PRESETS.find((item) => item.key === presetKey);
    if (!preset) throw new ApiError(422, "npc_preset_invalid", `Unknown preset: ${presetKey}`);
    created.push(await createNpc(ctx, { name: `${input.prefix?.trim() || preset.label} ${created.length + 1}`, presetKey, goalCollectionId: input.goalCollectionId }));
  }
  return created;
}

export async function updateNpc(
  ctx: Ctx,
  id: string,
  input: {
    name?: string;
    bio?: string;
    avatarUrl?: string | null;
    presetKey?: string;
    goalCollectionId?: string | null;
    poolSlug?: string | null;
    scheduleEnabled?: boolean;
    intervalMinutes?: number;
  },
) {
  requireNpcManager(ctx);
  const { row } = await getNpc(ctx, id);
  if (row.status === "retired") throw new ApiError(409, "npc_retired", "A retired NPC cannot be edited. Create a new collector instead.");
  if (input.presetKey && !NPC_PRESETS.some((preset) => preset.key === input.presetKey)) throw new ApiError(422, "npc_preset_invalid", "Choose a supported NPC preset.");
  const goals = safeJson<Record<string, unknown>>(row.goals_json, {});
  if (input.goalCollectionId !== undefined) goals.collection_id = input.goalCollectionId;
  if (input.poolSlug !== undefined) goals.pool_slug = input.poolSlug;
  const schedule = safeJson<Record<string, unknown>>(row.schedule_json, { enabled: false, interval_minutes: 1440 });
  if (input.scheduleEnabled !== undefined) schedule.enabled = input.scheduleEnabled;
  if (input.intervalMinutes !== undefined) schedule.interval_minutes = Math.max(15, Math.min(10080, input.intervalMinutes));
  await ctx.db
    .prepare(
      "UPDATE fb_npc_collectors SET name = COALESCE(?, name), bio = COALESCE(?, bio), avatar_url = ?, preset_key = COALESCE(?, preset_key), goals_json = ?, config_json = ?, schedule_json = ?, updated_at = ? WHERE id = ? AND tenant_id = ?",
    )
    .bind(
      input.name?.trim().slice(0, 80) || null,
      input.bio?.trim().slice(0, 500) || null,
      input.avatarUrl === undefined ? row.avatar_url : safeUrl(input.avatarUrl),
      input.presetKey ?? null,
      JSON.stringify(goals),
      JSON.stringify({ ...safeJson<Record<string, unknown>>(row.config_json, {}), pool_slug: goals.pool_slug ?? null }),
      JSON.stringify(schedule),
      nowIso(),
      id,
      ctx.tenant.id,
    )
    .run();
  return (await getNpc(ctx, id)).summary;
}

export async function setNpcStatus(ctx: Ctx, id: string, status: "active" | "paused" | "retired") {
  requireNpcManager(ctx);
  const { row } = await getNpc(ctx, id);
  if (row.status === "retired" && status !== "retired") throw new ApiError(409, "npc_retired", "A retired NPC cannot resume.");
  const now = nowIso();
  await ctx.db
    .prepare("UPDATE fb_npc_collectors SET status = ?, retired_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?")
    .bind(status, status === "retired" ? now : row.retired_at, now, id, ctx.tenant.id)
    .run();
  await ctx.db
    .prepare(
      "INSERT INTO fb_audit_events (id, tenant_id, actor_type, actor_id, represented_user_id, action, object_type, object_id, metadata_json, request_id, created_at) VALUES (?, ?, 'user', ?, ?, ?, 'npc', ?, '{}', ?, ?)",
    )
    .bind(newId("aud"), ctx.tenant.id, ctx.user!.id, ctx.user!.id, `npc.${status}`, id, ctx.requestId, now)
    .run();
  return (await getNpc(ctx, id)).summary;
}

export async function setNpcLimits(ctx: Ctx, input: { maxNpcs?: number; maxDrawsPerDay?: number; pausedAll?: boolean }) {
  requireNpcManager(ctx);
  await ctx.db
    .prepare(
      `INSERT INTO fb_npc_limits (tenant_id, max_npcs, max_draws_per_day, paused_all, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id) DO UPDATE SET max_npcs = excluded.max_npcs, max_draws_per_day = excluded.max_draws_per_day, paused_all = excluded.paused_all, updated_at = excluded.updated_at`,
    )
    .bind(
      ctx.tenant.id,
      Math.max(0, Math.min(100, input.maxNpcs ?? (await limitsFor(ctx.db, ctx.tenant.id)).max_npcs)),
      Math.max(0, Math.min(500, input.maxDrawsPerDay ?? (await limitsFor(ctx.db, ctx.tenant.id)).max_draws_per_day)),
      (input.pausedAll ?? Boolean((await limitsFor(ctx.db, ctx.tenant.id)).paused_all)) ? 1 : 0,
      nowIso(),
    )
    .run();
  return limitsFor(ctx.db, ctx.tenant.id);
}

interface OwnedFinish {
  card_id: string;
  material_key: string;
  effect_key: string | null;
}

async function choosePool(ctx: Ctx, npc: NpcRow): Promise<{ preview: PoolPreview; reason: string } | { preview: null; reason: string }> {
  const goals = safeJson<{ collection_id?: string | null; pool_slug?: string | null }>(npc.goals_json, {});
  const pools = await listPools(npcContext(ctx, npc));
  if (pools.length === 0) return { preview: null, reason: "The Bot has no active capsule pool." };
  const owned = await all<OwnedFinish>(
    ctx.db,
    `SELECT ci.card_id, m.key AS material_key, e.key AS effect_key
       FROM fb_card_instances ci JOIN fb_variants v ON v.id = ci.variant_id
       JOIN fb_materials m ON m.id = v.material_id LEFT JOIN fb_effects e ON e.id = v.effect_id
      WHERE ci.tenant_id = ? AND ci.user_id = ? AND ci.status IN ('owned','reserved')`,
    ctx.tenant.id,
    npc.user_id,
  );
  const ownedCards = new Set(owned.map((item) => item.card_id));
  const ownedGold = new Set(owned.filter((item) => item.material_key === "gold").map((item) => item.card_id));
  const ownedHolo = new Set(owned.filter((item) => ["holographic", "holo"].includes(item.effect_key ?? "")).map((item) => item.card_id));
  const npcCtx = npcContext(ctx, npc);
  const candidates: Array<{ preview: PoolPreview; score: number; reason: string }> = [];
  for (const pool of pools) {
    if (goals.pool_slug && pool.slug !== goals.pool_slug) continue;
    let preview: PoolPreview;
    try {
      preview = await getPoolPreview(npcCtx, pool.slug);
    } catch {
      continue;
    }
    if (preview.eligible_count === 0) continue;
    const focus = goals.collection_id
      ? preview.entries.filter((entry) => entry.collections.some((collection) => collection.id === goals.collection_id))
      : preview.entries;
    let score = 0;
    let reason = "";
    switch (npc.preset_key) {
      case "completionist":
        score = focus.filter((entry) => !ownedCards.has(entry.card_id)).length;
        reason = "missing subjects in the focus collection";
        break;
      case "gold_hunter":
        score = focus.filter((entry) => entry.material_key === "gold" && !ownedGold.has(entry.card_id)).length;
        reason = "missing Gold finishes";
        break;
      case "holo_hunter":
        score = focus.filter((entry) => ["holographic", "holo"].includes(entry.effect_key ?? "") && !ownedHolo.has(entry.card_id)).length;
        reason = "missing Holographic finishes";
        break;
      case "variety_collector":
        score = preview.entries.filter((entry) => !ownedCards.has(entry.card_id)).length;
        reason = "new subjects";
        break;
      case "friendly_collector":
      case "rookie":
        score = 1000 - preview.price;
        reason = "a comfortable ordinary price";
        break;
      case "established_rival":
        score = focus.length;
        reason = "focus-collection depth";
        break;
      default:
        score = 1;
        reason = "an affordable ordinary capsule";
    }
    candidates.push({ preview, score, reason });
  }
  if (candidates.length === 0) return { preview: null, reason: goals.pool_slug ? `The configured pool ${goals.pool_slug} has no eligible cards right now.` : "No active capsule pool has eligible cards." };
  candidates.sort((left, right) => right.score - left.score || left.preview.price - right.preview.price || left.preview.pool.slug.localeCompare(right.preview.pool.slug));
  return { preview: candidates[0]!.preview, reason: candidates[0]!.reason };
}

async function drawsToday(ctx: Ctx): Promise<number> {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const row = await first<{ count: number }>(
    ctx.db,
    "SELECT COUNT(*) AS count FROM fb_npc_actions WHERE tenant_id = ? AND action = 'draw' AND status IN ('planned','failed','completed') AND created_at >= ?",
    ctx.tenant.id,
    start.toISOString(),
  );
  return row?.count ?? 0;
}

async function gate(ctx: Ctx, npc: NpcRow) {
  const bot = await botForTenant(ctx.db, ctx.tenant.id);
  if (!bot || bot.status !== "active") return { ok: false as const, reason: "The Bot is paused or archived." };
  if (npc.status !== "active") return { ok: false as const, reason: `This NPC is ${npc.status}.` };
  const pending = await first<{ id: string }>(ctx.db, "SELECT id FROM fb_npc_actions WHERE tenant_id = ? AND npc_id = ? AND status IN ('planned','failed') LIMIT 1", ctx.tenant.id, npc.id);
  if (pending) return { ok: false as const, pending: true as const, reason: "A previous NPC action needs reconciliation before another can start." };
  const limits = await limitsFor(ctx.db, ctx.tenant.id);
  if (limits.paused_all) return { ok: false as const, reason: "All NPC progression is paused for this Bot." };
  if ((await drawsToday(ctx)) >= limits.max_draws_per_day) return { ok: false as const, reason: `The daily NPC draw limit (${limits.max_draws_per_day}) is reached.` };
  return { ok: true as const };
}

export async function previewNpcAction(ctx: Ctx, id: string) {
  requireNpcRead(ctx);
  const { row } = await getNpc(ctx, id);
  const allowed = await gate(ctx, row);
  if (!allowed.ok) return { npc_id: id, allowed: false, reason: allowed.reason, pool: null };
  const choice = await choosePool(ctx, row);
  if (!choice.preview) return { npc_id: id, allowed: false, reason: choice.reason, pool: null };
  const npcCtx = npcContext(ctx, row);
  const wallet = await first<{ balance: number }>(ctx.db, "SELECT balance FROM fb_wallets WHERE tenant_id = ? AND user_id = ?", ctx.tenant.id, row.user_id);
  const balance = wallet?.balance ?? 0;
  if (balance < choice.preview.price) {
    return { npc_id: id, allowed: false, reason: `The NPC has ${balance} Foil but this capsule costs ${choice.preview.price}.`, pool: choice.preview.pool.slug };
  }
  const preview = await getPoolPreview(npcCtx, choice.preview.pool.slug);
  return {
    npc_id: id,
    allowed: true,
    reason: choice.reason,
    pool: choice.preview.pool.slug,
    pool_name: choice.preview.pool.name,
    price: preview.price,
    eligible_count: preview.eligible_count,
    distribution_fingerprint: preview.distribution_fingerprint,
    revision: preview.revision,
    balance,
  };
}

async function finishNpcReceipt(ctx: Ctx, npc: NpcRow, actionId: string, receipt: Record<string, unknown>) {
  if (typeof receipt.draw_id !== "string" || typeof receipt.instance_id !== "string") throw new ApiError(409, "npc_receipt_invalid", "The draw receipt needs operator reconciliation.");
  const after = {
    balance: receipt.balance_after, balance_after: receipt.balance_after,
    balance_after_debit: receipt.balance_after_debit, credits_total: receipt.credits_total,
    achievement_credits: receipt.achievement_credits, card_name: receipt.card_name,
    variant_name: receipt.variant_name, serial: receipt.serial, instance_id: receipt.instance_id,
    new_subject: receipt.new_subject, new_finish: receipt.new_finish, achievements: receipt.achievements,
    pool_revision: receipt.pool_revision, distribution_fingerprint: receipt.distribution_fingerprint,
    settlement_pending: receipt.settlement_pending ?? (receipt.balance_after === undefined),
  };
  const now = nowIso();
  const authority = resolutionAuthority(ctx, true);
  await ctx.db.batch([
    ctx.db.prepare(`UPDATE fb_npc_actions SET status = 'completed', draw_id = ?, instance_id = ?, after_json = ?, completed_at = ? WHERE id = ? AND tenant_id = ? AND npc_id = ? AND status IN ('planned','failed')
      AND EXISTS (SELECT 1 FROM fb_draws d WHERE d.id=? AND d.instance_id=? AND d.tenant_id=? AND d.user_id=? AND d.idempotency_key='npc:' || ? || ':' || fb_npc_actions.idempotency_key) AND ${authority.sql}`)
      .bind(receipt.draw_id, receipt.instance_id, JSON.stringify(after), now, actionId, ctx.tenant.id, npc.id, receipt.draw_id, receipt.instance_id, ctx.tenant.id, npc.user_id, npc.id, ...authority.args),
    ctx.db.prepare("UPDATE fb_npc_collectors SET actions_count = actions_count + 1, last_action_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ? AND changes() = 1")
      .bind(now, now, npc.id, ctx.tenant.id),
  ]);
  const saved = await first<{ status: string; after_json: string }>(ctx.db, `SELECT status, after_json FROM fb_npc_actions WHERE id = ? AND tenant_id = ? AND npc_id = ? AND ${authority.sql}`, actionId, ctx.tenant.id, npc.id, ...authority.args);
  if (saved?.status !== "completed") throw new ApiError(409, "npc_recovery_pending", "The NPC draw needs reconciliation; do not start another action.");
  return safeJson<Record<string, unknown>>(saved.after_json, {});
}

async function recoverNpcReceipt(ctx: Ctx, npc: NpcRow, actionId: string, key: string) {
  const drawKey = `npc:${npc.id}:${key}`;
  const authority = resolutionAuthority(ctx, true);
  const draw = await first<{ id: string; instance_id: string; receipt_json: string; settled_json: string | null }>(ctx.db,
    `SELECT d.id, d.instance_id, d.receipt_json, i.response_json AS settled_json FROM fb_draws d
       LEFT JOIN fb_idempotency_keys i ON i.tenant_id = d.tenant_id AND i.actor_type = 'user' AND i.actor_id = d.user_id AND i.operation = 'draw.execute' AND i.idempotency_key = d.idempotency_key
      WHERE d.tenant_id = ? AND d.user_id = ? AND d.idempotency_key = ? AND ${authority.sql}`, ctx.tenant.id, npc.user_id, drawKey, ...authority.args);
  if (!draw) return null;
  const settled = safeJson<Record<string, unknown>>(draw.settled_json ?? "", {});
  const raw = safeJson<Record<string, unknown>>(draw.receipt_json, {});
  const receipt = settled.draw_id === draw.id && settled.instance_id === draw.instance_id ? settled : raw;
  if (receipt.draw_id !== draw.id || receipt.instance_id !== draw.instance_id) throw new ApiError(409, "npc_receipt_invalid", "The draw receipt needs operator reconciliation.");
  return finishNpcReceipt(ctx, npc, actionId, receipt);
}

// The draw batch requires this action to remain planned. D1 serializes this
// conditional update with that batch: whichever commits first determines whether
// the action is skipped or its real draw receipt must be recovered.
function resolutionAuthority(ctx: Ctx, allowCron = false) {
  const user = ctx.user;
  if (!user || ctx.actor.representedUserId !== user.id || (ctx.actor.type === 'user' && ctx.actor.id !== user.id)) return { sql: '0', args: [] };
  const access = ctx.sessionAssurance === 'access' && ctx.accessStatus === 'linked' ? ctx.accessIdentity : null;
  const array = (column: string) => `CASE WHEN json_valid(${column}) AND json_type(${column})='array' THEN ${column} ELSE '[]' END`;
  return { sql: `EXISTS (SELECT 1 FROM fb_memberships m JOIN fb_users u ON u.id=m.user_id AND u.disabled_at IS NULL AND u.is_synthetic=0
    JOIN fb_bots b ON b.tenant_id=m.tenant_id AND b.status='active' LEFT JOIN fb_bot_admins ba ON ba.bot_id=b.id AND ba.user_id=u.id
    WHERE m.tenant_id=? AND m.user_id=? AND m.status='active' AND m.revoked_at IS NULL AND (
      (m.role='owner' AND b.owner_user_id=u.id) OR (u.platform_admin=1 AND EXISTS (SELECT 1 FROM fb_platform_admins pa WHERE pa.user_id=u.id AND pa.status='active' AND pa.revoked_at IS NULL)) OR
      (m.role<>'owner' AND EXISTS (SELECT 1 FROM json_each(${array('m.capabilities_json')}) WHERE value='npc.manage' AND type='text')
        AND NOT EXISTS (SELECT 1 FROM json_each(${array('m.capabilities_json')}) WHERE type<>'text') AND (ba.id IS NULL OR
          (ba.role='admin' AND ba.status='active' AND ba.revoked_at IS NULL AND EXISTS (SELECT 1 FROM json_each(${array('ba.capabilities_json')}) WHERE value='npc.manage' AND type='text') AND NOT EXISTS (SELECT 1 FROM json_each(${array('ba.capabilities_json')}) WHERE type<>'text')))))
    AND ((?='user' AND (EXISTS (SELECT 1 FROM fb_sessions s WHERE s.id=? AND s.user_id=u.id AND s.tenant_id=m.tenant_id AND s.revoked_at IS NULL AND s.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      OR (?='access' AND ?>unixepoch('now') AND EXISTS (SELECT 1 FROM fb_access_identities ai WHERE ai.user_id=u.id AND ai.team_domain=? AND ai.subject=? AND ai.email=? AND ai.revoked_at IS NULL) AND u.email=? COLLATE NOCASE)
      OR EXISTS (SELECT 1 FROM fb_discord_identities d WHERE d.tenant_id=m.tenant_id AND d.user_id=u.id AND d.discord_user_id=? AND d.revoked_at IS NULL)))
      OR (?='agent' AND EXISTS (SELECT 1 FROM fb_agent_tokens t JOIN fb_agent_grants g ON g.id=t.grant_id WHERE t.id=? AND g.id=? AND t.token_hash=? AND t.token_hash<>'' AND t.revoked_at IS NULL AND g.agent_id=? AND g.represented_user_id=u.id AND g.tenant_id=m.tenant_id AND g.status='active' AND g.revoked_at IS NULL AND g.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
        AND json_valid(g.scopes_json) AND json_type(g.scopes_json)='array' AND NOT EXISTS (SELECT 1 FROM json_each(${array('g.scopes_json')}) WHERE type<>'text') AND EXISTS (SELECT 1 FROM json_each(${array('g.scopes_json')}) WHERE value='npc:write') AND EXISTS (SELECT 1 FROM json_each(${array('g.scopes_json')}) WHERE value='npc:read')))
      OR (?=1 AND ?='system' AND ?='cron:npc' AND ?='cron:npc' AND m.role='owner' AND b.owner_user_id=u.id)))`,
    args: [ctx.tenant.id,user.id,ctx.actor.type,ctx.sessionId,ctx.sessionAssurance,access?.payload.exp ?? 0,ctx.config.access.teamDomain,access?.subject ?? '',access?.email ?? '',access?.email ?? '',ctx.discordPrincipal?.discordUserId ?? '',ctx.actor.type,ctx.agentCredential?.tokenId ?? '',ctx.agentCredential?.grantId ?? '',ctx.agentCredential?.verifiedTokenHash ?? '',ctx.actor.id,allowCron ? 1 : 0,ctx.actor.type,ctx.actor.id,ctx.clientKey] };
}

export async function resolveUncommittedNpcAction(ctx: Ctx, npc: NpcRow, actionId: string, key: string, previousStatus: 'planned' | 'failed' = 'planned') {
  const drawKey = `npc:${npc.id}:${key}`;
  const resolution = previousStatus === 'failed' ? { resolution: "no_draw_committed", previous_status: 'failed' } : { resolution: "no_draw_committed" };
  const now = nowIso();
  const authority = resolutionAuthority(ctx);
  const results = await ctx.db.batch([
    ctx.db.prepare(`UPDATE fb_npc_actions SET status='skipped', after_json=CASE WHEN status='failed' THEN json_set(?, '$.previous_after_json', after_json, '$.previous_completed_at', completed_at) ELSE ? END, completed_at=?
    WHERE id=? AND tenant_id=? AND npc_id=? AND action='draw' AND status=? AND idempotency_key=?
      AND draw_id IS NULL AND instance_id IS NULL AND (status<>'failed' OR after_json='{}')
      AND NOT EXISTS (SELECT 1 FROM fb_draws WHERE tenant_id=? AND user_id=? AND idempotency_key=?)
      AND NOT EXISTS (SELECT 1 FROM fb_ledger_entries WHERE tenant_id=? AND user_id=? AND idempotency_key=?)
      AND NOT EXISTS (SELECT 1 FROM fb_idempotency_keys WHERE tenant_id=? AND actor_type='user' AND actor_id=? AND operation='draw.execute' AND idempotency_key=?) AND ${authority.sql}`)
      .bind(JSON.stringify(resolution), JSON.stringify(resolution), now, actionId, ctx.tenant.id, npc.id, previousStatus, key,
        ctx.tenant.id, npc.user_id, drawKey, ctx.tenant.id, npc.user_id, drawKey, ctx.tenant.id, npc.user_id, drawKey, ...authority.args),
    ctx.db.prepare(`INSERT INTO fb_audit_events (id,tenant_id,actor_type,actor_id,represented_user_id,action,object_type,object_id,metadata_json,request_id,created_at)
      SELECT ?,?,?,?,?, 'npc.action_resolved', 'npc_action', ?,?,?,? WHERE changes()=1`)
      .bind(newId("aud"), ctx.tenant.id, ctx.actor.type, ctx.actor.id, ctx.actor.representedUserId, actionId, JSON.stringify(resolution), ctx.requestId, now),
  ]);
  return results[0]?.meta.changes === 1 ? resolution : null;
}

/** Explicitly resolve a pending action only when its draw has not committed. */
export async function reconcileNpcAction(ctx: Ctx, id: string, key: string) {
  requireNpcManager(ctx);
  const { row } = await getNpc(ctx, id);
  const authority = resolutionAuthority(ctx);
  const read = () => first<{ id: string; status: string; after_json: string }>(ctx.db,
    `SELECT id,status,after_json FROM fb_npc_actions WHERE tenant_id=? AND npc_id=? AND idempotency_key=? AND ${authority.sql}`,
    ctx.tenant.id, id, key, ...authority.args);
  const action = await read();
  if (!action) throw new ApiError(404, 'npc_action_unavailable', 'This action is unavailable or your access changed.');
  if (action.status === 'planned' || action.status === 'failed') await resolveUncommittedNpcAction(ctx, row, action.id, key, action.status);
  const current = await read();
  if (!current) throw new ApiError(404, 'npc_action_unavailable', 'This action is unavailable or your access changed.');
  const resolution = safeJson<Record<string, unknown>>(current.after_json, {});
  if (current.status === 'skipped' && resolution.resolution === 'no_draw_committed')
    return { action_id: current.id, status: 'skipped', resolution: 'no_draw_committed' };
  if (current.status === 'completed') return { action_id: current.id, status: 'completed', resolution: 'draw_recorded' };
  return { action_id: current.id, status: current.status, resolution: 'pending', message: 'A draw may have committed. The receipt still needs reconciliation; no second draw was started.' };
}

export async function reconcileNpcActionById(ctx: Ctx, id: string, actionId: string) {
  requireNpcManager(ctx);
  const authority = resolutionAuthority(ctx);
  const action = await first<{ idempotency_key: string }>(ctx.db,
    `SELECT idempotency_key FROM fb_npc_actions WHERE id=? AND tenant_id=? AND npc_id=? AND ${authority.sql}`,
    actionId, ctx.tenant.id, id, ...authority.args);
  if (!action) throw new ApiError(404, 'npc_action_unavailable', 'This action is unavailable or your access changed.');
  return reconcileNpcAction(ctx, id, action.idempotency_key);
}

export async function playNpcOnce(ctx: Ctx, id: string, idempotencyKey?: string) {
  requireNpcManager(ctx);
  const authority = resolutionAuthority(ctx, true);
  if (!await first<{ ok: number }>(ctx.db, `SELECT 1 AS ok WHERE ${authority.sql}`, ...authority.args))
    throw new ApiError(403, "npc_management_changed", "Your NPC management access or session changed.");
  const { row } = await getNpc(ctx, id);
  const key = idempotencyKey?.trim() || `npc-${id}-${newId("act")}`;
  const existing = await first<{ id: string; npc_id: string; status: string; after_json: string }>(
    ctx.db,
    `SELECT id, npc_id, status, after_json FROM fb_npc_actions WHERE tenant_id = ? AND idempotency_key = ? AND ${authority.sql}`,
    ctx.tenant.id,
    key,
    ...authority.args,
  );
  if (existing) {
    if (existing.npc_id !== id) throw new ApiError(409, "npc_idempotency_conflict", "This action key belongs to another collector.");
    if (["planned", "failed"].includes(existing.status)) {
      const recovered = await recoverNpcReceipt(ctx, row, existing.id, key);
      if (recovered) return { replayed: true, action_id: existing.id, status: "completed", receipt: recovered };
      return { replayed: true, action_id: existing.id, status: existing.status, receipt: {}, recovery_pending: true };
    }
    return { replayed: true, action_id: existing.id, status: existing.status, receipt: safeJson<Record<string, unknown>>(existing.after_json, {}) };
  }
  const allowed = await gate(ctx, row);
  const actionId = newId("npca");
  const now = nowIso();
  if (!allowed.ok) {
    if ("pending" in allowed) {
      const duplicate = await first<{ id: string }>(ctx.db, "SELECT id FROM fb_npc_actions WHERE tenant_id = ? AND idempotency_key = ?", ctx.tenant.id, key);
      if (duplicate) return playNpcOnce(ctx, id, key);
      throw new ApiError(409, "npc_recovery_pending", allowed.reason);
    }
    await ctx.db
      .prepare("INSERT INTO fb_npc_actions (id, tenant_id, npc_id, action, status, reason, idempotency_key, created_at) VALUES (?, ?, ?, 'draw', 'skipped', ?, ?, ?)")
      .bind(actionId, ctx.tenant.id, id, allowed.reason, key, now)
      .run();
    throw new ApiError(409, "npc_skipped", allowed.reason, { action_id: actionId });
  }
  const choice = await choosePool(ctx, row);
  if (!choice.preview) {
    await ctx.db
      .prepare("INSERT INTO fb_npc_actions (id, tenant_id, npc_id, action, status, reason, idempotency_key, created_at) VALUES (?, ?, ?, 'draw', 'skipped', ?, ?, ?)")
      .bind(actionId, ctx.tenant.id, id, choice.reason, key, now)
      .run();
    throw new ApiError(409, "npc_no_pool", choice.reason, { action_id: actionId });
  }
  const npcCtx = npcContext(ctx, row);
  const preview = await getPoolPreview(npcCtx, choice.preview.pool.slug);
  const wallet = await first<{ balance: number }>(ctx.db, "SELECT balance FROM fb_wallets WHERE tenant_id = ? AND user_id = ?", ctx.tenant.id, row.user_id);
  const before = { balance: wallet?.balance ?? 0, actions_count: row.actions_count, goals: safeJson(row.goals_json, {}) };
  if ((wallet?.balance ?? 0) < preview.price) {
    const reason = `The NPC has ${wallet?.balance ?? 0} Foil but this capsule costs ${preview.price}.`;
    await ctx.db
      .prepare("INSERT INTO fb_npc_actions (id, tenant_id, npc_id, action, status, reason, pool_slug, idempotency_key, before_json, created_at) VALUES (?, ?, ?, 'draw', 'skipped', ?, ?, ?, ?, ?)")
      .bind(actionId, ctx.tenant.id, id, reason, preview.pool.slug, key, JSON.stringify(before), now)
      .run();
    throw new ApiError(409, "npc_insufficient_funds", reason, { action_id: actionId });
  }
  let planned;
  try {
    planned = await ctx.db
      .prepare(
        `INSERT INTO fb_npc_actions (id, tenant_id, npc_id, action, status, reason, pool_slug, amount, idempotency_key, before_json, created_at)
         SELECT ?, ?, ?, 'draw', 'planned', ?, ?, ?, ?, ?, ? WHERE NOT EXISTS
           (SELECT 1 FROM fb_npc_actions WHERE tenant_id = ? AND npc_id = ? AND status IN ('planned','failed'))
           AND EXISTS (SELECT 1 FROM fb_npc_collectors n JOIN fb_bots b ON b.id = n.bot_id AND b.tenant_id = n.tenant_id
             WHERE n.id = ? AND n.tenant_id = ? AND n.status = 'active' AND b.status = 'active')
           AND COALESCE((SELECT paused_all FROM fb_npc_limits WHERE tenant_id = ?), 0) = 0
           AND (SELECT COUNT(*) FROM fb_npc_actions WHERE tenant_id = ? AND action = 'draw'
             AND status IN ('planned','failed','completed') AND created_at >= strftime('%Y-%m-%dT00:00:00.000Z','now'))
             < COALESCE((SELECT max_draws_per_day FROM fb_npc_limits WHERE tenant_id = ?), 40)`,
      )
      .bind(actionId, ctx.tenant.id, id, choice.reason, preview.pool.slug, preview.price, key, JSON.stringify(before), now, ctx.tenant.id, id, id, ctx.tenant.id, ctx.tenant.id, ctx.tenant.id, ctx.tenant.id)
      .run();
  } catch (error) {
    const duplicate = await first<{ id: string }>(ctx.db, "SELECT id FROM fb_npc_actions WHERE tenant_id = ? AND idempotency_key = ?", ctx.tenant.id, key);
    if (duplicate) return playNpcOnce(ctx, id, key);
    throw error;
  }
  if (planned.meta.changes !== 1) {
    const duplicate = await first<{ id: string }>(ctx.db, "SELECT id FROM fb_npc_actions WHERE tenant_id = ? AND idempotency_key = ?", ctx.tenant.id, key);
    if (duplicate) return playNpcOnce(ctx, id, key);
    throw new ApiError(409, "npc_recovery_pending", "A previous NPC action needs reconciliation before another can start.");
  }
  try {
    const receipt = await executeDraw(npcCtx, {
      pool: preview.pool.slug,
      expectedRevision: preview.revision,
      expectedDistribution: preview.distribution_fingerprint,
      npcActionId: actionId,
      idempotency: { key: `npc:${id}:${key}`, digest: await sha256Hex(`npc:${id}:${key}`) },
    });
    if (!("instance_id" in receipt)) {
      throw new Error("The idempotent draw replay did not include its original receipt.");
    }
    const after = await finishNpcReceipt(ctx, row, actionId, receipt);
    return { replayed: false, action_id: actionId, status: "completed", receipt: after };
  } catch (error) {
    const recovered = await recoverNpcReceipt(ctx, row, actionId, key).catch(() => null);
    if (recovered) return { replayed: false, action_id: actionId, status: "completed", receipt: recovered };
    const resolved = await resolveUncommittedNpcAction(ctx, row, actionId, key).catch(() => null);
    if (resolved) return { replayed: false, action_id: actionId, status: "skipped", receipt: resolved };
    // A concurrent draw may have won the transaction race; recover it before
    // reporting uncertainty. Legacy failed actions remain pending.
    const raced = await recoverNpcReceipt(ctx, row, actionId, key).catch(() => null);
    if (raced) return { replayed: false, action_id: actionId, status: "completed", receipt: raced };
    const saved = await first<{ status: string; after_json: string }>(ctx.db,
      `SELECT status,after_json FROM fb_npc_actions WHERE id=? AND tenant_id=? AND npc_id=? AND idempotency_key=? AND ${authority.sql}`, actionId, ctx.tenant.id, id, key, ...authority.args).catch(() => null);
    const savedResolution = safeJson<Record<string, unknown>>(saved?.after_json ?? "", {});
    if (saved?.status === "skipped" && savedResolution.resolution === "no_draw_committed")
      return { replayed: true, action_id: actionId, status: "skipped", receipt: savedResolution };
    throw new ApiError(503, "npc_recovery_pending", "The NPC action outcome needs reconciliation. Do not start another action.", { action_id: actionId });
  }
}

export async function runNpcBatch(ctx: Ctx, id: string, count: number) {
  requireNpcManager(ctx);
  const bounded = Math.max(1, Math.min(10, count));
  const results = [];
  for (let index = 0; index < bounded; index += 1) {
    try {
      results.push(await playNpcOnce(ctx, id, `npc-batch-${id}-${Date.now()}-${index}`));
    } catch (error) {
      results.push({ status: "failed", error: error instanceof ApiError && error.code === "npc_recovery_pending" ? "The action needs reconciliation." : "The action could not be completed." });
      break;
    }
  }
  return { requested: bounded, results };
}

export async function listNpcActions(ctx: Ctx, id: string) {
  requireNpcRead(ctx);
  await getNpc(ctx, id);
  const rows = await all<{
    id: string;
    action: string;
    status: string;
    reason: string | null;
    pool_slug: string | null;
    draw_id: string | null;
    instance_id: string | null;
    amount: number;
    before_json: string;
    after_json: string;
    created_at: string;
    completed_at: string | null;
  }>(
    ctx.db,
    "SELECT id, action, status, reason, pool_slug, draw_id, instance_id, amount, before_json, after_json, created_at, completed_at FROM fb_npc_actions WHERE tenant_id = ? AND npc_id = ? ORDER BY created_at DESC LIMIT 100",
    ctx.tenant.id,
    id,
  );
  return rows.map((row) => ({
    ...row,
    before: safeJson(row.before_json, {}),
    after: safeJson(row.after_json, {}),
    before_json: undefined,
    after_json: undefined,
  }));
}

export async function listNpcProfiles(ctx: Ctx) {
  requireNpcRead(ctx);
  const rows = await all<NpcRow>(ctx.db, "SELECT * FROM fb_npc_collectors WHERE tenant_id = ? AND status <> 'retired' ORDER BY name", ctx.tenant.id);
  return Promise.all(rows.map((row) => npcSummary(ctx, row)));
}

export async function compareNpc(ctx: Ctx, id: string) {
  requireNpcRead(ctx);
  const { row, summary } = await getNpc(ctx, id);
  const user = ctx.user!;
  const [viewer, npcCards] = await Promise.all([
    first<{ cards: number; subjects: number; gold: number; holo: number }>(
      ctx.db,
      `SELECT COUNT(*) AS cards, COUNT(DISTINCT ci.card_id) AS subjects,
              SUM(CASE WHEN m.key = 'gold' THEN 1 ELSE 0 END) AS gold,
              SUM(CASE WHEN e.key IN ('holographic','holo') THEN 1 ELSE 0 END) AS holo
         FROM fb_card_instances ci JOIN fb_variants v ON v.id = ci.variant_id
         JOIN fb_materials m ON m.id = v.material_id LEFT JOIN fb_effects e ON e.id = v.effect_id
        WHERE ci.tenant_id = ? AND ci.user_id = ? AND ci.status IN ('owned','reserved')`,
      ctx.tenant.id,
      user.id,
    ),
    all<{ card_name: string; variant_name: string; serial: string; render_url: string | null }>(
      ctx.db,
      `SELECT cd.name AS card_name, v.name AS variant_name, ci.serial,
              (SELECT vr.public_url FROM fb_variant_renders vr WHERE vr.variant_id = v.id AND vr.status = 'published' LIMIT 1) AS render_url
         FROM fb_card_instances ci JOIN fb_card_definitions cd ON cd.id = ci.card_id
         JOIN fb_variants v ON v.id = ci.variant_id
        WHERE ci.tenant_id = ? AND ci.user_id = ? AND ci.status = 'owned' ORDER BY ci.acquired_at DESC LIMIT 6`,
      ctx.tenant.id,
      row.user_id,
    ),
  ]);
  return {
    npc: summary,
    viewer: { display_name: user.displayName, cards: viewer?.cards ?? 0, subjects: viewer?.subjects ?? 0, gold: viewer?.gold ?? 0, holographic: viewer?.holo ?? 0 },
    npc_cards: npcCards,
    labels: { npc: "NPC · synthetic collector", viewer: "Human member" },
  };
}

export async function runDueNpcs(db: D1Database, ctx: Ctx) {
  const limits = await limitsFor(db, ctx.tenant.id);
  if (limits.paused_all) return { ran: 0, failed: 0, paused: true };
  const rows = await all<NpcRow>(
    db,
    "SELECT * FROM fb_npc_collectors WHERE tenant_id = ? AND status = 'active' ORDER BY last_action_at IS NOT NULL, last_action_at",
    ctx.tenant.id,
  );
  const now = Date.now();
  let ran = 0;
  let failed = 0;
  for (const row of rows) {
    const schedule = safeJson<{ enabled?: boolean; interval_minutes?: number }>(row.schedule_json, {});
    if (!schedule.enabled) continue;
    const interval = Math.max(15, Number(schedule.interval_minutes ?? 1440)) * 60_000;
    if (row.last_action_at && now - new Date(row.last_action_at).getTime() < interval) continue;
    try {
      const outcome = await playNpcOnce(ctx, row.id, `npc-scheduled-${row.id}-${new Date().toISOString().slice(0, 13)}`);
      if (outcome.status === "completed") ran += 1;
      else if ("recovery_pending" in outcome && outcome.recovery_pending) failed += 1;
    } catch (error) {
      // The action row records the reason; scheduled progression continues with
      // the next eligible NPC and never retries an unbounded loop.
      if (!(error instanceof ApiError) || !["npc_skipped", "npc_no_pool", "npc_insufficient_funds"].includes(error.code)) failed += 1;
    }
    if (ran >= 10) break;
  }
  return { ran, failed, paused: false };
}

/**
 * Scheduled progression uses the same bounded action path as the Admin UI.
 * It runs for at most ten NPCs per Bot per invocation and never creates a
 * second economy or a daemon. The Worker cron calls this after EmDash's own
 * scheduled handler.
 */
export async function runScheduledNpcProgression(
  db: D1Database,
  media: Ctx["media"],
  config: Ctx["config"],
  options?: { run?: typeof runDueNpcs; correlationId?: string },
): Promise<{ tenants: number; ran: number; failed: number }> {
  const tenants = await all<{ id: string; slug: string; name: string }>(
    db,
    `SELECT DISTINCT t.id, t.slug, t.name
       FROM fb_tenants t JOIN fb_npc_collectors n ON n.tenant_id = t.id
      WHERE n.status = 'active'`,
  );
  let ran = 0;
  let failed = 0;
  for (const tenant of tenants) {
    try {
    const owner = await first<{
      id: string;
      email: string;
      display_name: string;
      role: "owner" | "editor" | "economy_admin" | "player";
      capabilities_json: string;
      platform_admin: number;
    }>(
      db,
      `SELECT u.id, u.email, u.display_name, m.role, m.capabilities_json, u.platform_admin
         FROM fb_bots b JOIN fb_memberships m ON m.user_id = b.owner_user_id AND m.tenant_id = b.tenant_id AND m.status = 'active'
         JOIN fb_users u ON u.id = b.owner_user_id
        WHERE b.tenant_id = ? AND b.status = 'active' LIMIT 1`,
      tenant.id,
    );
    if (!owner) throw new Error("active_bot_owner_missing");
    let capabilities: string[] = [];
    try {
      const parsed = JSON.parse(owner.capabilities_json) as unknown;
      if (Array.isArray(parsed)) capabilities = parsed.filter((item): item is string => typeof item === "string");
    } catch {
      capabilities = [];
    }
    const ctx: Ctx = {
      db,
      media,
      config,
      requestId: `cron:npc:${tenant.id}:${new Date().toISOString()}`,
      clientKey: "cron:npc",
      tenant,
      user: {
        id: owner.id,
        email: owner.email,
        displayName: owner.display_name,
        role: owner.role,
        platformAdmin: Boolean(owner.platform_admin),
        capabilities,
      },
      actor: { type: "system", id: "cron:npc", representedUserId: owner.id, label: "Scheduled NPC progression" },
      scopes: null,
      sessionId: null,
      csrfToken: "",
      sessionAssurance: null,
      sessionAuthTime: null,
      accessIdentity: null,
      accessStatus: null,
    };
      const result = await (options?.run ?? runDueNpcs)(db, ctx);
      ran += result.ran;
      if (result.failed) failed += 1;
    } catch {
      failed += 1;
      console.error(JSON.stringify({ level: "error", event_code: "scheduled.npc.tenant_failed", correlation_id: options?.correlationId && /^scheduled:run:[0-9a-f-]{36}$/.test(options.correlationId) ? options.correlationId : "scheduled:npc", tenant_ref: /^[a-zA-Z0-9_-]{1,80}$/.test(tenant.id) ? tenant.id : "unknown", occurred_at: new Date().toISOString(), error: "operation_failed" }));
    }
  }
  return { tenants: tenants.length, ran, failed };
}

export async function getNpcAdminOverview(ctx: Ctx) {
  requireNpcManager(ctx);
  const [items, limits, actions] = await Promise.all([
    listNpcs(ctx),
    limitsFor(ctx.db, ctx.tenant.id),
    all<{ status: string; count: number }>(
      ctx.db,
      "SELECT status, COUNT(*) AS count FROM fb_npc_actions WHERE tenant_id = ? GROUP BY status",
      ctx.tenant.id,
    ),
  ]);
  return {
    items,
    presets: NPC_PRESETS,
    limits,
    action_counts: Object.fromEntries(actions.map((row) => [row.status, row.count])),
    cap: { max_batch: 10, synthetic_label: "NPC · synthetic collector" },
  };
}
