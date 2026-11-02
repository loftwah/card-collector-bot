import { ApiError, type Ctx } from "../context";
import { all, first, nowIso } from "../db";
import { newId, token } from "../ids";
import { auditStatement, findIdempotent, idempotencyStatement, type IdempotencyInput } from "../http";
import { getWalletSummary, correctWallet } from "./wallet";
import { checkRateLimit } from "../context";
import { nextDailyEligibleAt } from "./daily-time";

export interface EconomySettings {
  currency_name: string;
  currency_symbol: string;
  starter_grant: number;
  daily_reward: number;
  daily_cooldown_seconds: number;
  recycle_enabled: number;
  recycle_rates_json: string;
  version: number;
  updated_at: string;
  updated_by: string;
}

export async function getEconomy(ctx: Ctx): Promise<EconomySettings> {
  const row = await first<EconomySettings>(
    ctx.db,
    "SELECT * FROM fb_economy_settings WHERE tenant_id = ?",
    ctx.tenant.id,
  );
  if (!row) throw new ApiError(503, "economy_not_configured", "The cabinet economy is not configured.");
  return row;
}

export async function updateEconomy(
  ctx: Ctx,
  input: {
    expectedVersion: number;
    currencyName?: string;
    currencySymbol?: string;
    starterGrant?: number;
    dailyReward?: number;
    dailyCooldownSeconds?: number;
    recycleEnabled?: boolean;
    recycleRates?: { rarity: Record<string, number>; material: Record<string, number> };
  },
): Promise<EconomySettings> {
  const current = await getEconomy(ctx);
  if (current.version !== input.expectedVersion) {
    throw new ApiError(409, "stale_write", "Economy settings changed since you opened them.", {
      current_version: current.version,
    });
  }
  if (input.dailyReward !== undefined && (!Number.isInteger(input.dailyReward) || input.dailyReward < 0)) {
    throw new ApiError(422, "daily_reward_invalid", "Daily reward must be a non-negative integer.");
  }
  if (
    input.dailyCooldownSeconds !== undefined &&
    (!Number.isInteger(input.dailyCooldownSeconds) || input.dailyCooldownSeconds < 0)
  ) {
    throw new ApiError(422, "cooldown_invalid", "Cooldown must be a non-negative whole number of seconds.");
  }
  if (input.starterGrant !== undefined && (!Number.isInteger(input.starterGrant) || input.starterGrant < 0)) {
    throw new ApiError(422, "starter_grant_invalid", "Starter grant must be a non-negative integer.");
  }
  const nextVersion = current.version + 1;
  await ctx.db.batch([
    ctx.db
      .prepare(
        `UPDATE fb_economy_settings SET
          currency_name = COALESCE(?, currency_name),
          currency_symbol = COALESCE(?, currency_symbol),
          starter_grant = COALESCE(?, starter_grant),
          daily_reward = COALESCE(?, daily_reward),
          daily_cooldown_seconds = COALESCE(?, daily_cooldown_seconds),
          recycle_enabled = COALESCE(?, recycle_enabled),
          recycle_rates_json = COALESCE(?, recycle_rates_json),
          version = ?, updated_at = ?, updated_by = ?
         WHERE tenant_id = ? AND version = ?`,
      )
      .bind(
        input.currencyName?.trim() || null,
        input.currencySymbol?.trim() || null,
        input.starterGrant ?? null,
        input.dailyReward ?? null,
        input.dailyCooldownSeconds ?? null,
        input.recycleEnabled === undefined ? null : input.recycleEnabled ? 1 : 0,
        input.recycleRates ? JSON.stringify(input.recycleRates) : null,
        nextVersion,
        nowIso(),
        ctx.actor.id,
        ctx.tenant.id,
        current.version,
      ),
    auditStatement(ctx, "economy.updated", "economy", ctx.tenant.id, {
      version: nextVersion,
      daily_reward: input.dailyReward ?? current.daily_reward,
      cooldown_seconds: input.dailyCooldownSeconds ?? current.daily_cooldown_seconds,
    }),
  ]);
  return getEconomy(ctx);
}

export async function claimDailyReward(ctx: Ctx, idempotency: IdempotencyInput) {
  const user = ctx.user;
  if (!user) throw new ApiError(401, "authentication_required", "Sign in to claim your allowance.");
  const replay = await findIdempotent(ctx, "reward.claim", idempotency);
  if (replay) return { ...(replay.response as object), replayed: true };
  const settings = await getEconomy(ctx);
  if (settings.daily_reward <= 0) throw new ApiError(409, "reward_disabled", "The daily allowance is disabled.");
  await checkRateLimit(ctx.db, `reward:${ctx.tenant.id}:${user.id}`, 12, 3600);
  const now = new Date();
  const periodKey = `daily:${now.toISOString().slice(0, 10)}`;
  const claimId = newId("rwd");
  const response = {
    claim_id: claimId,
    amount: settings.daily_reward,
    currency: { name: settings.currency_name, symbol: settings.currency_symbol },
    rule_key: "daily-allowance",
    rule_version: settings.version,
    period_key: periodKey,
    claimed_at: now.toISOString(),
  };
  try {
    await ctx.db.batch([
      idempotencyStatement(ctx, "reward.claim", idempotency, response),
      ctx.db
        .prepare(
          "INSERT INTO fb_reward_claims (id, tenant_id, user_id, rule_key, rule_version, period_key, amount, created_at, idempotency_key) VALUES (?, ?, ?, 'daily-allowance', ?, ?, ?, ?, ?)",
        )
        .bind(claimId, ctx.tenant.id, user.id, settings.version, periodKey, settings.daily_reward, now.toISOString(), idempotency.key),
      auditStatement(ctx, "reward.claimed", "reward_claim", claimId, {
        amount: settings.daily_reward,
        rule_version: settings.version,
        period_key: periodKey,
      }),
    ]);
  } catch (error) {
    const message = String(error);
    if (message.includes("UNIQUE") && message.includes("fb_idempotency_keys")) {
      const existing = await findIdempotent(ctx, "reward.claim", idempotency);
      if (existing) return { ...(existing.response as object), replayed: true };
    }
    if (message.includes("reward_cooldown") || message.includes("UNIQUE")) {
      const last = await first<{ created_at: string }>(
        ctx.db,
        "SELECT created_at FROM fb_reward_claims WHERE tenant_id = ? AND user_id = ? AND rule_key = 'daily-allowance' ORDER BY created_at DESC LIMIT 1",
        ctx.tenant.id,
        user.id,
      );
      const next =
        last && settings.daily_cooldown_seconds > 0
          ? nextDailyEligibleAt(now, settings.daily_cooldown_seconds, last.created_at)
          : null;
      throw new ApiError(409, "reward_cooldown", "Your next allowance is not ready yet.", {
        next_eligible_at: next,
        cooldown_seconds: settings.daily_cooldown_seconds,
      });
    }
    throw error;
  }
  const wallet = await getWalletSummary(ctx.db, ctx.tenant.id, user.id, 1);
  return {
    ...response,
    balance_after: wallet.balance,
    next_eligible_at: nextDailyEligibleAt(now, settings.daily_cooldown_seconds),
    replayed: false,
  };
}

export async function adjustWallet(
  ctx: Ctx,
  input: {
    userId: string;
    amount: number;
    reason: string;
    idempotency: IdempotencyInput;
  },
) {
  const actorRole = ctx.user?.role;
  if (ctx.actor.type === "agent") {
    if (!ctx.scopes?.includes("economy:grant")) {
      throw new ApiError(403, "insufficient_scope", "The agent grant does not include economy:grant.");
    }
    if (!["owner", "economy_admin"].includes(actorRole ?? "")) {
      throw new ApiError(403, "insufficient_role", "The represented user cannot adjust wallets.");
    }
    if (Math.abs(input.amount) > 500) {
      throw new ApiError(403, "adjustment_limit", "Agents may adjust at most 500 Foil per command.");
    }
  } else if (actorRole === "economy_admin") {
    if (Math.abs(input.amount) > 5000) throw new ApiError(403, "adjustment_limit", "Economy administrators may adjust at most 5,000 Foil per command.");
  } else if (actorRole !== "owner") {
    throw new ApiError(403, "insufficient_role", "Only the owner or an economy administrator can adjust wallets.");
  } else if (Math.abs(input.amount) > 50000) {
    throw new ApiError(403, "adjustment_limit", "Owner adjustments are limited to 50,000 Foil per command.");
  }
  if (!Number.isInteger(input.amount) || input.amount === 0) {
    throw new ApiError(422, "amount_invalid", "Adjustment amount must be a non-zero integer.");
  }
  if (!input.reason.trim() || input.reason.trim().length < 3) {
    throw new ApiError(422, "reason_required", "Record a reason for this adjustment.");
  }
  const replay = await findIdempotent(ctx, "economy.adjust", input.idempotency);
  if (replay) return { ...(replay.response as object), replayed: true };
  const member = await first<{ user_id: string }>(
    ctx.db,
    "SELECT user_id FROM fb_memberships WHERE tenant_id = ? AND user_id = ?",
    ctx.tenant.id,
    input.userId,
  );
  if (!member) throw new ApiError(404, "member_not_found", "That user is not a member of this tenant.");
  const result = await correctWallet(ctx.db, {
    tenantId: ctx.tenant.id,
    userId: input.userId,
    amount: input.amount,
    description: input.reason.trim(),
    idempotencyKey: `adjust:${input.idempotency.key}`,
    referenceType: "admin_adjustment",
    metadata: { reason: input.reason.trim(), actor: ctx.actor.id },
    actorType: ctx.actor.type,
    actorId: ctx.actor.id,
  });
  const response = {
    user_id: input.userId,
    amount: input.amount,
    balance_after: result.balance,
    ledger_id: result.ledgerId,
    reason: input.reason.trim(),
  };
  await ctx.db.batch([
    idempotencyStatement(ctx, "economy.adjust", input.idempotency, response),
    auditStatement(ctx, "wallet.adjusted", "wallet", input.userId, {
      amount: input.amount,
      reason: input.reason.trim(),
      ledger_id: result.ledgerId,
    }),
  ]);
  return { ...response, replayed: false };
}

export async function getLedger(ctx: Ctx, userId: string, limit = 100) {
  if (ctx.user?.role === "player" && ctx.user.id !== userId) {
    throw new ApiError(403, "insufficient_role", "You can only read your own ledger.");
  }
  return getWalletSummary(ctx.db, ctx.tenant.id, userId, Math.min(200, Math.max(1, limit)));
}

export async function getPreferences(ctx: Ctx) {
  const user = ctx.user;
  if (!user) throw new ApiError(401, "authentication_required", "Sign in to change preferences.");
  const row = await first<{
    hide_tags_json: string;
    reduced_motion: number;
    sound_enabled: number;
    sharing_enabled: number;
    updated_at: string;
  }>(
    ctx.db,
    "SELECT hide_tags_json, reduced_motion, sound_enabled, sharing_enabled, updated_at FROM fb_player_preferences WHERE tenant_id = ? AND user_id = ?",
    ctx.tenant.id,
    user.id,
  );
  return {
    hide_tags: row ? (JSON.parse(row.hide_tags_json) as string[]) : [],
    reduced_motion: Boolean(row?.reduced_motion),
    sound_enabled: Boolean(row?.sound_enabled),
    sharing_enabled: Boolean(row?.sharing_enabled),
    updated_at: row?.updated_at ?? null,
  };
}

export async function updatePreferences(
  ctx: Ctx,
  input: { hideTags?: string[]; reducedMotion?: boolean; soundEnabled?: boolean; sharingEnabled?: boolean },
) {
  const user = ctx.user;
  if (!user) throw new ApiError(401, "authentication_required", "Sign in to change preferences.");
  if (input.hideTags) {
    const unique = [...new Set(input.hideTags)];
    if (unique.length) {
      const found = await all<{ slug: string }>(
        ctx.db,
        `SELECT slug FROM fb_tags WHERE tenant_id = ? AND slug IN (${unique.map(() => "?").join(",")}) AND archived_at IS NULL`,
        ctx.tenant.id,
        ...unique,
      );
      if (found.length !== unique.length) throw new ApiError(422, "tag_invalid", "One or more preference tags are unknown.");
    }
  }
  const current = await getPreferences(ctx);
  await ctx.db.batch([
    ctx.db
      .prepare(
        `INSERT INTO fb_player_preferences (tenant_id, user_id, hide_tags_json, reduced_motion, sound_enabled, sharing_enabled, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, user_id) DO UPDATE SET
           hide_tags_json = excluded.hide_tags_json,
           reduced_motion = excluded.reduced_motion,
           sound_enabled = excluded.sound_enabled,
           sharing_enabled = excluded.sharing_enabled,
           updated_at = excluded.updated_at`,
      )
      .bind(
        ctx.tenant.id,
        user.id,
        JSON.stringify(input.hideTags ?? current.hide_tags),
        (input.reducedMotion ?? current.reduced_motion) ? 1 : 0,
        (input.soundEnabled ?? current.sound_enabled) ? 1 : 0,
        (input.sharingEnabled ?? current.sharing_enabled) ? 1 : 0,
        nowIso(),
      ),
    auditStatement(ctx, "preferences.updated", "preferences", user.id, {
      hide_tags: input.hideTags ?? current.hide_tags,
      reduced_motion: input.reducedMotion ?? current.reduced_motion,
      sound_enabled: input.soundEnabled ?? current.sound_enabled,
      sharing_enabled: input.sharingEnabled ?? current.sharing_enabled,
    }),
  ]);
  return getPreferences(ctx);
}

export async function listAudit(ctx: Ctx, limit = 100) {
  return all<{
    id: string;
    actor_type: string;
    actor_id: string;
    represented_user_id: string | null;
    action: string;
    object_type: string;
    object_id: string;
    metadata_json: string;
    request_id: string | null;
    created_at: string;
  }>(
    ctx.db,
    "SELECT * FROM fb_audit_events WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?",
    ctx.tenant.id,
    Math.min(200, Math.max(1, limit)),
  );
}

export async function operationsStatus(ctx: Ctx) {
  const counts = await Promise.all([
    first<{ count: number }>(ctx.db, "SELECT COUNT(*) AS count FROM fb_card_definitions WHERE tenant_id = ?", ctx.tenant.id),
    first<{ count: number }>(ctx.db, "SELECT COUNT(*) AS count FROM fb_variants WHERE tenant_id = ?", ctx.tenant.id),
    first<{ count: number }>(ctx.db, "SELECT COUNT(*) AS count FROM fb_card_instances WHERE tenant_id = ?", ctx.tenant.id),
    first<{ count: number }>(ctx.db, "SELECT COUNT(*) AS count FROM fb_ledger_entries WHERE tenant_id = ?", ctx.tenant.id),
    first<{ count: number }>(ctx.db, "SELECT COUNT(*) AS count FROM fb_jobs WHERE tenant_id = ? AND status = 'pending'", ctx.tenant.id),
    first<{ count: number }>(ctx.db, "SELECT COUNT(*) AS count FROM fb_outbox WHERE tenant_id = ? AND status = 'pending'", ctx.tenant.id),
    first<{ count: number }>(ctx.db, "SELECT COUNT(*) AS count FROM fb_import_runs WHERE tenant_id = ?", ctx.tenant.id),
    first<{ count: number }>(ctx.db, "SELECT COUNT(*) AS count FROM fb_tenants"),
    first<{ count: number }>(ctx.db, "SELECT COUNT(*) AS count FROM fb_catalogue_releases WHERE tenant_id = ? AND status = 'active'", ctx.tenant.id),
    first<{ count: number }>(ctx.db, "SELECT COUNT(*) AS count FROM fb_memberships WHERE tenant_id = ?", ctx.tenant.id),
  ]);
  const release = await first<{ version: number; checksum: string; published_at: string }>(
    ctx.db,
    "SELECT version, checksum, published_at FROM fb_catalogue_releases WHERE tenant_id = ? AND status = 'active' ORDER BY version DESC LIMIT 1",
    ctx.tenant.id,
  );
  return {
    tenant: ctx.tenant,
    accounts: { members: counts[9]?.count ?? 0 },
    counts: {
      cards: counts[0]?.count ?? 0,
      variants: counts[1]?.count ?? 0,
      instances: counts[2]?.count ?? 0,
      ledger_entries: counts[3]?.count ?? 0,
      pending_jobs: counts[4]?.count ?? 0,
      pending_outbox: counts[5]?.count ?? 0,
      import_runs: counts[6]?.count ?? 0,
      tenants: counts[7]?.count ?? 0,
      active_releases: counts[8]?.count ?? 0,
    },
    release,
    providers: ctx.config.providers,
    discord: {
      status: ctx.config.providers.discordApplication ? "interactions_ready" : "disabled",
      connected: Boolean(ctx.config.providers.discordApplication),
      reason: ctx.config.providers.discordApplication
        ? "Signed HTTP interactions are implemented; guild installations and channel allowlists are authoritative."
        : "The Discord application ID and public key are not configured.",
    },
    email: {
      status: ctx.config.providers.resend ? "live_configured" : "outbox_only",
      sends: (await first<{ count: number }>(ctx.db, "SELECT COUNT(*) AS count FROM fb_magic_links"))?.count ?? 0,
    },
    access: { status: ctx.config.providers.cloudflareAccess ? "edge_and_jwt" : "not_configured" },
    generation: { status: "not_run", billed_cost_micros: 0, reason: "No recorded generation ceiling; supplied and designed assets only." },
    time: { now_utc: nowIso() },
  };
}

export async function createShareLink(ctx: Ctx, expiresInDays = 7) {
  const user = ctx.user;
  if (!user) throw new ApiError(401, "authentication_required", "Sign in to share your cabinet.");
  const prefs = await getPreferences(ctx);
  if (!prefs.sharing_enabled) {
    throw new ApiError(409, "sharing_disabled", "Enable explicit sharing in preferences before creating a public link.");
  }
  const raw = token("fbshare");
  const { sha256Hex } = await import("../ids");
  const id = newId("shr");
  const now = nowIso();
  const expiresAt = new Date(Date.now() + Math.min(30, Math.max(1, expiresInDays)) * 86400 * 1000).toISOString();
  await ctx.db.batch([
    ctx.db
      .prepare(
        "INSERT INTO fb_share_links (id, tenant_id, user_id, token_hash, status, expires_at, created_at) VALUES (?, ?, ?, ?, 'active', ?, ?)",
      )
      .bind(id, ctx.tenant.id, user.id, await sha256Hex(raw), expiresAt, now),
    auditStatement(ctx, "share.created", "share_link", id, { expires_at: expiresAt }),
  ]);
  return { id, token: raw, url: `${ctx.config.publicOrigin}/s/${raw}`, expires_at: expiresAt };
}

/**
 * Local outbox drain. It never sends email or Discord messages; render and
 * trade receipts are marked delivered locally, external topics are suppressed
 * so a future adapter can pick them up deliberately.
 */
export async function processOutbox(ctx: Ctx) {
  const pending = await all<{ id: string; topic: string }>(
    ctx.db,
    "SELECT id, topic FROM fb_outbox WHERE tenant_id = ? AND status = 'pending' AND available_at <= ? ORDER BY created_at LIMIT 500",
    ctx.tenant.id,
    nowIso(),
  );
  let delivered = 0;
  let suppressed = 0;
  for (const row of pending) {
    const local = row.topic.startsWith("render.") || row.topic.startsWith("trade.") || row.topic.startsWith("gift.");
    await ctx.db.batch([
      ctx.db
        .prepare("UPDATE fb_outbox SET status = ?, attempts = attempts + 1, delivered_at = ?, last_error = NULL WHERE id = ? AND tenant_id = ?")
        .bind(local ? "delivered" : "failed", nowIso(), row.id, ctx.tenant.id),
      ctx.db
        .prepare(
          "INSERT INTO fb_notification_deliveries (id, tenant_id, outbox_id, destination_type, status, attempts, last_error, created_at, sent_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)",
        )
        .bind(
          newId("ntf"),
          ctx.tenant.id,
          row.id,
          local ? "local" : "deferred",
          local ? "sent" : "suppressed",
          local ? null : "External delivery is disabled in this phase.",
          nowIso(),
          local ? nowIso() : null,
        ),
    ]);
    if (local) delivered++;
    else suppressed++;
  }
  await auditStatement(ctx, "outbox.processed", "outbox", ctx.tenant.id, { delivered, suppressed }).run();
  return { delivered, suppressed, pending: pending.length };
}

export async function backupManifest(ctx: Ctx) {
  const [schema, cards, variants, instances, ledger, wallets, assets, balance, release] = await Promise.all([
    first<{ value: string }>(ctx.db, "SELECT value FROM fb_schema_meta WHERE key = 'domain_schema_version'"),
    first<{ count: number }>(ctx.db, "SELECT COUNT(*) AS count FROM fb_card_definitions WHERE tenant_id = ?", ctx.tenant.id),
    first<{ count: number }>(ctx.db, "SELECT COUNT(*) AS count FROM fb_variants WHERE tenant_id = ?", ctx.tenant.id),
    first<{ count: number }>(ctx.db, "SELECT COUNT(*) AS count FROM fb_card_instances WHERE tenant_id = ?", ctx.tenant.id),
    first<{ count: number }>(ctx.db, "SELECT COUNT(*) AS count FROM fb_ledger_entries WHERE tenant_id = ?", ctx.tenant.id),
    first<{ count: number }>(ctx.db, "SELECT COUNT(*) AS count FROM fb_wallets WHERE tenant_id = ?", ctx.tenant.id),
    first<{ count: number; bytes: number }>(ctx.db, "SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes FROM fb_assets WHERE tenant_id = ?", ctx.tenant.id),
    first<{ total: number }>(ctx.db, "SELECT COALESCE(SUM(balance), 0) AS total FROM fb_wallets WHERE tenant_id = ?", ctx.tenant.id),
    first<{ version: number; checksum: string; published_at: string }>(ctx.db, "SELECT version, checksum, published_at FROM fb_catalogue_releases WHERE tenant_id = ? AND status = 'active' ORDER BY version DESC LIMIT 1", ctx.tenant.id),
  ]);
  return {
    schemaVersion: schema?.value ?? "unknown",
    tenant: ctx.tenant.slug,
    counts: {
      cards: cards?.count ?? 0,
      variants: variants?.count ?? 0,
      instances: instances?.count ?? 0,
      ledger: ledger?.count ?? 0,
      wallets: wallets?.count ?? 0,
      assets: assets?.count ?? 0,
      assetBytes: assets?.bytes ?? 0,
    },
    walletTotal: balance?.total ?? 0,
    release: release ?? null,
    generatedAt: nowIso(),
  };
}

export async function revokeShareLink(ctx: Ctx, id: string) {
  const user = ctx.user;
  if (!user) throw new ApiError(401, "authentication_required", "Sign in to revoke a share.");
  const link = await first<{ id: string }>(ctx.db, "SELECT id FROM fb_share_links WHERE id = ? AND tenant_id = ? AND user_id = ?", id, ctx.tenant.id, user.id);
  if (!link) throw new ApiError(404, "share_not_found", "Share link not found.");
  await ctx.db.batch([
    ctx.db.prepare("UPDATE fb_share_links SET status = 'revoked', revoked_at = ? WHERE id = ? AND tenant_id = ? AND user_id = ?").bind(nowIso(), id, ctx.tenant.id, user.id),
    auditStatement(ctx, "share.revoked", "share_link", id),
  ]);
  return { id, status: "revoked" };
}
