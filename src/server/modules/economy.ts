import {
  ApiError,
  canIssueScopedGrant,
  checkRateLimit,
  requireScope,
  requireRecentStrongAuth,
  type Ctx,
  type CurrentUser,
} from "../context";
import { all, first, nowIso } from "../db";
import { newId, token } from "../ids";
import { auditStatement, findIdempotent, idempotencyStatement, type IdempotencyInput } from "../http";
import { getWalletSummary } from "./wallet";
import { nextDailyEligibleAt } from "./daily-time";
import { listCollections } from "./collections";
import { DRAW_EPOCH_TRIGGER_CHECK, DRAW_EPOCH_TRIGGER_DATA, readDrawScopeEpoch } from './draw-scope-epoch';

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
  if (ctx.actor.representedUserId !== user.id || (ctx.actor.type === 'user' && ctx.actor.id !== user.id))
    throw new ApiError(403, 'reward_access_changed', 'Your allowance access changed. Sign in again.');
  const access = ctx.sessionAssurance === 'access' && ctx.accessStatus === 'linked' ? ctx.accessIdentity : null;
  const livePrincipal = `EXISTS (SELECT 1 FROM fb_memberships m JOIN fb_users u ON u.id=m.user_id AND u.disabled_at IS NULL
    JOIN fb_bots b ON b.tenant_id=m.tenant_id AND b.status='active'
    WHERE m.tenant_id=? AND m.user_id=? AND m.status='active' AND m.revoked_at IS NULL AND (
      (?='user' AND (EXISTS (SELECT 1 FROM fb_sessions s WHERE s.id=? AND s.user_id=u.id AND s.tenant_id=m.tenant_id AND s.revoked_at IS NULL AND s.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        OR (?='access' AND ?>unixepoch('now') AND EXISTS (SELECT 1 FROM fb_access_identities ai WHERE ai.user_id=u.id AND ai.team_domain=? AND ai.subject=? AND ai.email=? AND ai.revoked_at IS NULL) AND u.email=? COLLATE NOCASE)
        OR EXISTS (SELECT 1 FROM fb_discord_identities d WHERE d.tenant_id=m.tenant_id AND d.user_id=u.id AND d.discord_user_id=? AND d.revoked_at IS NULL)))
      OR (?='agent' AND EXISTS (SELECT 1 FROM fb_agent_tokens t JOIN fb_agent_grants g ON g.id=t.grant_id
        WHERE t.id=? AND t.token_hash=? AND t.token_hash<>'' AND t.revoked_at IS NULL AND g.id=? AND g.agent_id=? AND g.represented_user_id=u.id AND g.tenant_id=m.tenant_id
          AND g.status='active' AND g.revoked_at IS NULL AND g.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
          AND json_type(CASE WHEN json_valid(g.scopes_json) THEN g.scopes_json ELSE 'null' END)='array'
          AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(g.scopes_json) THEN g.scopes_json ELSE '[]' END) WHERE type<>'text')
          AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(g.scopes_json) THEN g.scopes_json ELSE '[]' END) WHERE value='reward:claim')))))`;
  const principalArgs = [ctx.tenant.id,user.id,ctx.actor.type,ctx.sessionId,ctx.sessionAssurance,access?.payload.exp ?? 0,ctx.config.access.teamDomain,access?.subject ?? '',access?.email ?? '',access?.email ?? '',ctx.discordPrincipal?.discordUserId ?? '',ctx.actor.type,ctx.agentCredential?.tokenId ?? '',ctx.agentCredential?.verifiedTokenHash ?? '',ctx.agentCredential?.grantId ?? '',ctx.actor.id];
  const checkPrincipal = async () => {
    if (!await first<{ok:number}>(ctx.db, `SELECT 1 AS ok WHERE ${livePrincipal}`, ...principalArgs))
      throw new ApiError(403, 'reward_access_changed', 'Your allowance access changed. Sign in again.');
  };
  await checkPrincipal();
  const replayReceipt = async (replay: { response: unknown }) => {
    const settings = await getEconomy(ctx);
    const wallet = await getWalletSummary(ctx.db, ctx.tenant.id, user.id, 1);
    const last = await first<{ created_at: string }>(
      ctx.db,
      "SELECT created_at FROM fb_reward_claims WHERE tenant_id = ? AND user_id = ? AND rule_key = 'daily-allowance' ORDER BY created_at DESC LIMIT 1",
      ctx.tenant.id,
      user.id,
    );
    await checkPrincipal();
    return {
      ...(replay.response as object),
      balance_after: wallet.balance,
      next_eligible_at: nextDailyEligibleAt(
        new Date(),
        settings.daily_cooldown_seconds,
        last?.created_at,
      ),
      replayed: true,
    };
  };
  const replay = await findIdempotent(ctx, "reward.claim", idempotency);
  if (replay) return replayReceipt(replay);
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
      ctx.db.prepare(`SELECT CASE WHEN ${livePrincipal} AND strftime('%Y-%m-%d','now')=? AND EXISTS (SELECT 1 FROM fb_economy_settings e WHERE e.tenant_id=? AND e.version=? AND e.daily_reward=? AND e.daily_cooldown_seconds=? AND e.daily_reward>0) THEN 1 ELSE json('daily_guard') END`)
        .bind(...principalArgs,now.toISOString().slice(0,10),ctx.tenant.id,settings.version,settings.daily_reward,settings.daily_cooldown_seconds),
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
    if (message.includes('malformed JSON')) throw new ApiError(409, 'reward_changed', 'Your access or allowance changed. Refresh before trying again.');
    if (message.includes("UNIQUE") && message.includes("fb_idempotency_keys")) {
      const existing = await findIdempotent(ctx, "reward.claim", idempotency);
      if (existing) return replayReceipt(existing);
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
  await checkPrincipal();
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
  const user = ctx.user;
  if (!user) throw new ApiError(401, "authentication_required", "Sign in first.");
  if (ctx.actor.type !== "user") throw new ApiError(403, "human_strong_auth_required", "Foil adjustments require a signed-in human with recent strong authentication.");
  if (ctx.actor.id !== user.id || ctx.actor.representedUserId !== user.id) throw new ApiError(403, "session_required", "Sign in with strong authentication before adjusting Foil.");
  if (!ctx.sessionId || ctx.sessionAssurance === "access") throw new ApiError(403, "session_required", "Open Studio on the web and confirm with a passkey or authenticator before adjusting Foil.");
  requireRecentStrongAuth(ctx, 30);
  // Re-read authority at the mutation boundary. A session or stale form that
  // loaded before a revocation must not keep the removed capability.
  const live = await first<{
    role: CurrentUser["role"];
    capabilities_json: string;
    self_grants_enabled: number;
    grant_limit: number;
    capability_revision: number;
    status: string;
  }>(
    ctx.db,
    `SELECT role, capabilities_json, self_grants_enabled, grant_limit, capability_revision, status
       FROM fb_memberships WHERE tenant_id = ? AND user_id = ?`,
    ctx.tenant.id,
    user.id,
  );
  if (!live || live.status !== "active") {
    throw new ApiError(403, "membership_revoked", "This membership is no longer active.");
  }
  let liveCapabilities: string[] = [];
  try {
    const parsed = JSON.parse(live.capabilities_json ?? "[]") as unknown;
    if (Array.isArray(parsed)) {
      liveCapabilities = parsed.filter((item): item is string => typeof item === "string");
    }
  } catch {
    liveCapabilities = [];
  }
  const liveUser = {
    ...user,
    role: live.role,
    capabilities: liveCapabilities,
    selfGrantsEnabled: Boolean(live.self_grants_enabled),
    grantLimit: Number(live.grant_limit ?? 0),
    capabilityRevision: Number(live.capability_revision ?? 1),
  };
  const ownerLike = liveUser.role === "owner" || liveUser.platformAdmin;
  if (ownerLike) {
    if (Math.abs(input.amount) > 50000) {
      throw new ApiError(403, "adjustment_limit", "Owner adjustments are limited to 50,000 Foil per command.");
    }
  } else {
    const policy = canIssueScopedGrant(liveUser, {
      targetUserId: input.userId,
      amount: input.amount,
    });
    if (!policy.allowed) throw new ApiError(403, policy.code, policy.message);
  }
  if (!Number.isInteger(input.amount) || input.amount === 0) {
    throw new ApiError(422, "amount_invalid", "Adjustment amount must be a non-zero integer.");
  }
  if (!input.reason.trim() || input.reason.trim().length < 3) {
    throw new ApiError(422, "reason_required", "Record a reason for this adjustment.");
  }
  const member = await first<{ user_id: string }>(
    ctx.db,
    "SELECT user_id FROM fb_memberships WHERE tenant_id = ? AND user_id = ? AND status = 'active' AND revoked_at IS NULL",
    ctx.tenant.id,
    input.userId,
  );
  if (!member) throw new ApiError(404, "member_not_found", "That user is not a member of this tenant.");
  const authority = `EXISTS (SELECT 1 FROM fb_memberships m JOIN fb_users u ON u.id = m.user_id
        JOIN fb_bots b ON b.tenant_id = m.tenant_id AND b.status = 'active'
        LEFT JOIN fb_bot_admins ba ON ba.bot_id = b.id AND ba.user_id = m.user_id
        WHERE m.tenant_id = ? AND m.user_id = ? AND m.status = 'active' AND m.revoked_at IS NULL AND u.disabled_at IS NULL
          AND (? IN ('passkey','mfa') AND EXISTS (SELECT 1 FROM fb_sessions s WHERE s.id = ? AND s.user_id = m.user_id AND s.tenant_id = m.tenant_id AND s.revoked_at IS NULL AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now') AND s.assurance = ? AND s.auth_time >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 minutes') AND s.auth_time <= strftime('%Y-%m-%dT%H:%M:%fZ','now')))
          AND m.role = ? AND m.capabilities_json = ? AND m.self_grants_enabled = ? AND m.grant_limit = ? AND m.capability_revision = ?
          AND ((m.role = 'owner' AND b.owner_user_id = u.id)
            OR (u.platform_admin = 1 AND EXISTS (SELECT 1 FROM fb_platform_admins pa WHERE pa.user_id = u.id AND pa.status = 'active' AND pa.revoked_at IS NULL))
            OR (m.role <> 'owner' AND ? > 0 AND ? <= m.grant_limit AND (? <> u.id OR m.self_grants_enabled = 1)
              AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(m.capabilities_json) THEN m.capabilities_json ELSE '[]' END) WHERE value = 'grants')
              AND (ba.id IS NULL OR (ba.status = 'active' AND ba.revoked_at IS NULL AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(ba.capabilities_json) THEN ba.capabilities_json ELSE '[]' END) WHERE value = 'grants'))))))`;
  const authorityArgs = [ctx.tenant.id, user.id, ctx.sessionAssurance, ctx.sessionId, ctx.sessionAssurance, live.role, live.capabilities_json,
      live.self_grants_enabled, live.grant_limit, live.capability_revision, input.amount, input.amount, input.userId];
  const authorized = await first<{ ok: number }>(ctx.db, `SELECT ${authority} AS ok`, ...authorityArgs);
  if (!authorized?.ok) throw new ApiError(403, "adjustment_forbidden", "The session or grant is no longer authorized. Sign in or ask the Bot Owner.");
  const authorizedReceipt = async () => {
    const row = await first<{request_digest:string;response_json:string}>(ctx.db,
      `SELECT request_digest,response_json FROM fb_idempotency_keys WHERE tenant_id=? AND actor_type='user' AND actor_id=? AND operation='economy.adjust' AND idempotency_key=? AND ${authority}`,
      ctx.tenant.id,user.id,input.idempotency.key,...authorityArgs);
    if (!row) return null;
    if (row.request_digest !== input.idempotency.digest) throw new ApiError(409,"idempotency_conflict","This idempotency key was already used with a different request.");
    return {response:JSON.parse(row.response_json)};
  };
  const replay = await authorizedReceipt();
  if (replay) return { ...(replay.response as object), replayed: true };
  const ledgerId = newId("led");
  const now = nowIso();
  const update = ctx.db.prepare(`UPDATE fb_wallets SET balance = balance + ?, updated_at = ?
    WHERE tenant_id = ? AND user_id = ? AND balance + ? >= 0
      AND EXISTS (SELECT 1 FROM fb_memberships target JOIN fb_users tu ON tu.id = target.user_id WHERE target.tenant_id = ? AND target.user_id = ? AND target.status = 'active' AND target.revoked_at IS NULL AND tu.disabled_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM fb_idempotency_keys WHERE tenant_id = ? AND actor_type = 'user' AND actor_id = ? AND operation = 'economy.adjust' AND idempotency_key = ?)
      AND NOT EXISTS (SELECT 1 FROM fb_ledger_entries WHERE tenant_id = ? AND user_id = ? AND idempotency_key = ?)
      AND ${authority}`)
    .bind(input.amount, now, ctx.tenant.id, input.userId, input.amount, ctx.tenant.id, input.userId,
      ctx.tenant.id, user.id, input.idempotency.key, ctx.tenant.id, input.userId, `adjust:${input.idempotency.key}`, ...authorityArgs);
  const ledger = ctx.db.prepare(`INSERT INTO fb_ledger_entries (id, tenant_id, user_id, kind, amount, balance_after, reference_type, description, idempotency_key, metadata_json, actor_type, actor_id, created_at)
    SELECT ?, ?, ?, 'correction', ?, balance, 'admin_adjustment', ?, ?, ?, 'user', ?, ? FROM fb_wallets WHERE tenant_id = ? AND user_id = ? AND changes() = 1`)
    .bind(ledgerId, ctx.tenant.id, input.userId, input.amount, input.reason.trim(), `adjust:${input.idempotency.key}`, JSON.stringify({ reason: input.reason.trim(), actor: user.id }), user.id, now, ctx.tenant.id, input.userId);
  const idem = ctx.db.prepare(`INSERT INTO fb_idempotency_keys (tenant_id, actor_type, actor_id, operation, idempotency_key, request_digest, status, response_json, created_at)
    SELECT ?, 'user', ?, 'economy.adjust', ?, ?, 'completed', json_object('user_id', ?, 'amount', ?, 'balance_after', balance_after, 'ledger_id', id, 'reason', ?), ? FROM fb_ledger_entries WHERE id = ? AND tenant_id = ?`)
    .bind(ctx.tenant.id, user.id, input.idempotency.key, input.idempotency.digest, input.userId, input.amount, input.reason.trim(), now, ledgerId, ctx.tenant.id);
  const audit = ctx.db.prepare(`INSERT INTO fb_audit_events (id, tenant_id, actor_type, actor_id, represented_user_id, action, object_type, object_id, metadata_json, request_id, created_at)
    SELECT ?, ?, 'user', ?, ?, 'wallet.adjusted', 'wallet', ?, json_object('amount', ?, 'reason', ?, 'ledger_id', id, 'balance_before', balance_after - ?, 'balance_after', balance_after), ?, ? FROM fb_ledger_entries WHERE id = ? AND tenant_id = ?`)
    .bind(newId("aud"), ctx.tenant.id, user.id, user.id, input.userId, input.amount, input.reason.trim(), input.amount, ctx.requestId, now, ledgerId, ctx.tenant.id);
  const [updated] = await ctx.db.batch([update, ledger, idem, audit]);
  if (updated?.meta.changes !== 1) {
    const stillAuthorized = await first<{ ok: number }>(ctx.db, `SELECT ${authority} AS ok`, ...authorityArgs);
    if (!stillAuthorized?.ok) throw new ApiError(409, "adjustment_not_applied", "The permission or session changed. Reload before trying again.");
    const prior = await authorizedReceipt();
    if (prior) return { ...(prior.response as object), replayed: true };
    throw new ApiError(409, "adjustment_not_applied", "The balance, permission or session changed. Reload before trying again.");
  }
  let saved: Awaited<ReturnType<typeof authorizedReceipt>> = null;
  try { saved = await authorizedReceipt(); } catch { /* The write already committed; do not present a read failure as a failed adjustment. */ }
  if (!saved) throw new ApiError(503, "adjustment_receipt_missing", "The adjustment was applied, but its receipt is unavailable. Restore access and retry with the same idempotency key.");
  return { ...(saved.response as object), replayed: false };
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
    hidden_collection_ids_json: string;
    reduced_motion: number;
    sound_enabled: number;
    sharing_enabled: number;
    updated_at: string;
  }>(
    ctx.db,
    "SELECT hide_tags_json, hidden_collection_ids_json, reduced_motion, sound_enabled, sharing_enabled, updated_at FROM fb_player_preferences WHERE tenant_id = ? AND user_id = ?",
    ctx.tenant.id,
    user.id,
  );
  return {
    hide_tags: row ? safeStringArray(row.hide_tags_json) : [],
    hidden_collection_ids: row ? safeStringArray(row.hidden_collection_ids_json) : [],
    reduced_motion: Boolean(row?.reduced_motion),
    sound_enabled: Boolean(row?.sound_enabled),
    sharing_enabled: Boolean(row?.sharing_enabled),
    updated_at: row?.updated_at ?? null,
  };
}

function safeStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export async function updatePreferences(
  ctx: Ctx,
  input: {
    hideTags?: string[];
    hiddenCollectionIds?: string[];
    reducedMotion?: boolean;
    soundEnabled?: boolean;
    sharingEnabled?: boolean;
  },
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
  let hiddenCollectionIds = input.hiddenCollectionIds;
  if (hiddenCollectionIds) {
    hiddenCollectionIds = [...new Set(hiddenCollectionIds)];
    if (hiddenCollectionIds.length) {
      const visible = new Set((await listCollections(ctx)).map((collection) => collection.id));
      const unknown = hiddenCollectionIds.filter((id) => !visible.has(id));
      if (unknown.length) {
        throw new ApiError(422, "collection_invalid", "One or more collections are not available to this account.");
      }
    }
  }
  const current = await getPreferences(ctx);
  await ctx.db.batch([
    ctx.db
      .prepare(
        `INSERT INTO fb_player_preferences (tenant_id, user_id, hide_tags_json, hidden_collection_ids_json, reduced_motion, sound_enabled, sharing_enabled, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, user_id) DO UPDATE SET
           hide_tags_json = excluded.hide_tags_json,
           hidden_collection_ids_json = excluded.hidden_collection_ids_json,
           reduced_motion = excluded.reduced_motion,
           sound_enabled = excluded.sound_enabled,
           sharing_enabled = excluded.sharing_enabled,
           updated_at = excluded.updated_at`,
      )
      .bind(
        ctx.tenant.id,
        user.id,
        JSON.stringify(input.hideTags ?? current.hide_tags),
        JSON.stringify(hiddenCollectionIds ?? current.hidden_collection_ids),
        (input.reducedMotion ?? current.reduced_motion) ? 1 : 0,
        (input.soundEnabled ?? current.sound_enabled) ? 1 : 0,
        (input.sharingEnabled ?? current.sharing_enabled) ? 1 : 0,
        nowIso(),
      ),
    auditStatement(ctx, "preferences.updated", "preferences", user.id, {
      hide_tags: input.hideTags ?? current.hide_tags,
      hidden_collection_ids: hiddenCollectionIds ?? current.hidden_collection_ids,
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
  const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const delivery = await first<{
    total: number;
    completed: number;
    failed: number;
    delivery_failures: number;
    stuck: number;
    last_success: string | null;
    last_failure: string | null;
  }>(
    ctx.db,
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(status = 'completed'), 0) AS completed,
            COALESCE(SUM(status = 'failed'), 0) AS failed,
            COALESCE(SUM(error_code IN ('delivery_failed', 'public_delivery_failed')), 0) AS delivery_failures,
            COALESCE(SUM(status = 'processing' AND created_at < ?), 0) AS stuck,
            MAX(CASE WHEN status = 'completed' AND (error_code IS NULL OR error_code NOT IN ('delivery_failed', 'public_delivery_failed')) THEN completed_at END) AS last_success,
            MAX(CASE WHEN status = 'failed' OR error_code IN ('delivery_failed', 'public_delivery_failed') THEN completed_at END) AS last_failure
       FROM fb_discord_interactions
      WHERE created_at >= ?`,
    new Date(Date.now() - 10 * 60_000).toISOString(),
    since,
  );
  const deliveryState: "healthy" | "degraded" | "unavailable" | "configured_unverified" =
    !ctx.config.providers.discordApplication
      ? "unavailable"
      : !delivery || delivery.total === 0
        ? "configured_unverified"
        : (delivery.stuck ?? 0) > 0 ||
            ((delivery.delivery_failures ?? 0) > 0 &&
              (!delivery.last_success ||
                (delivery.last_failure !== null && delivery.last_failure > delivery.last_success)))
          ? "degraded"
          : (delivery.completed ?? 0) === 0 && (delivery.failed ?? 0) > 0
            ? "unavailable"
            : "healthy";
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
      status: deliveryState,
      connected: Boolean(ctx.config.providers.discordApplication),
      configured: Boolean(ctx.config.providers.discordApplication),
      recent: {
        window_hours: 24,
        total: delivery?.total ?? 0,
        completed: delivery?.completed ?? 0,
        failed: delivery?.failed ?? 0,
        delivery_failures: delivery?.delivery_failures ?? 0,
        stuck_processing: delivery?.stuck ?? 0,
        last_success_at: delivery?.last_success ?? null,
        last_failure_at: delivery?.last_failure ?? null,
      },
      reason:
        deliveryState === "healthy"
          ? "Recent interactions reached a terminal delivery state without a newer delivery failure."
          : deliveryState === "degraded"
            ? "Recent delivery failures or stuck interactions need inspection; committed receipts remain in the cabinet."
            : deliveryState === "unavailable"
              ? "The application is not configured, or only failed interactions were recorded."
              : "Credentials are present but no interaction has been verified in the last 24 hours. This is not a green health claim.",
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

export type ShareKind = "cabinet" | "card" | "collection" | "achievement" | "wishlist" | "latest" | "profile";

export async function createShareLink(
  ctx: Ctx,
  input: number | { expiresInDays?: number; kind?: ShareKind; targetId?: string } = 7,
) {
  const options = typeof input === "number" ? { expiresInDays: input } : input;
  const user = ctx.user;
  if (!user) throw new ApiError(401, "authentication_required", "Sign in to share your cabinet.");
  const { liveViewerContext } = await import("./live-viewer");
  const sharer = await liveViewerContext(ctx, user.id);
  if (!sharer) throw new ApiError(403, "membership_revoked", "Your membership is no longer active.");
  const prefs = await getPreferences(ctx);
  if (!prefs.sharing_enabled) {
    throw new ApiError(409, "sharing_disabled", "Enable explicit sharing in preferences before creating a public link.");
  }
  const kind = options.kind;
  const targetId = options.targetId ?? null;
  if (!kind) {
    throw new ApiError(422, "share_target_required", "Choose one exact card, collection, badge, wishlist or profile to share.");
  }
  if (kind === "cabinet") {
    throw new ApiError(
      422,
      "share_kind_retired",
      "Whole-cabinet links are retired. Share one exact card, collection, badge, wishlist or profile instead.",
    );
  }
  if (!["wishlist", "profile"].includes(kind) && !targetId) {
    throw new ApiError(422, "share_target_required", "Choose the exact object to share.");
  }
  let audience: "public" | "member" | "private" = "private";
  let payload: Record<string, unknown> = { label: "Cabinet snapshot" };
  let wishlistSnapshot: {global_epoch:number;tenant_epoch:number;user_epoch:number;wishes:string} | null=null;
  let cardSnapshot: {global_epoch:number;tenant_epoch:number;user_epoch:number;instanceId:string;cardId:string;variantId:string;serial:string;backUrl:string|null} | null=null;
  let collectionSnapshot: {global_epoch:number;tenant_epoch:number;user_epoch:number} | null=null;
  let profileSnapshot: {global_epoch:number;tenant_epoch:number;user_epoch:number;pins:string} | null=null;
  let achievementSnapshot: {global_epoch:number;tenant_epoch:number;user_epoch:number;achievementId:string;version:number;earnedAt:string;criteria:string;visibility:string} | null=null;

  if (kind === "card" || kind === "latest") {
    requireScope(ctx,'inventory:read');
    const epoch=await readDrawScopeEpoch(ctx);
    if (!epoch) throw new ApiError(503,'share_temporarily_unavailable','Card sharing is temporarily unavailable.');
    const instance = await first<{
      id: string; card_id: string; variant_id: string; card_name: string; card_slug: string; subtitle: string | null;
      variant_name: string; material_key: string; effect_key: string | null; serial: string; collection_id: string | null;
      collection_name: string | null; collection_audience: string | null; collection_approved_at: string | null;
      render_url: string | null; back_url: string | null;
    }>(
      ctx.db,
      `SELECT ci.id, ci.card_id, ci.variant_id, cd.name AS card_name, cd.slug AS card_slug, cd.subtitle,
              v.name AS variant_name, m.key AS material_key, fx.key AS effect_key, ci.serial,
              c.id AS collection_id, c.name AS collection_name, c.view_audience AS collection_audience, c.public_approved_at AS collection_approved_at,
              (SELECT vr.public_url FROM fb_variant_renders vr WHERE vr.variant_id = v.id AND vr.status = 'published' LIMIT 1) AS render_url,
              (SELECT ('/media/back/' || ba.asset_id) FROM fb_variant_back_renders ba WHERE ba.variant_id = v.id AND ba.status = 'published' LIMIT 1) AS back_url
         FROM fb_card_instances ci
         JOIN fb_card_definitions cd ON cd.id = ci.card_id AND cd.tenant_id = ci.tenant_id
         JOIN fb_variants v ON v.id = ci.variant_id AND v.tenant_id = ci.tenant_id
         JOIN fb_materials m ON m.id = v.material_id
         LEFT JOIN fb_effects fx ON fx.id = v.effect_id
         LEFT JOIN fb_collection_cards cc ON cc.card_id = ci.card_id
         LEFT JOIN fb_collections c ON c.id = cc.collection_id
        WHERE ci.id = ? AND ci.tenant_id = ? AND ci.user_id = ? AND ci.status IN ('owned','reserved')
          AND cd.status='published' AND cd.archived_at IS NULL AND v.status='published' AND v.archived_at IS NULL
        ORDER BY CASE c.view_audience WHEN 'public' THEN 0 WHEN 'members' THEN 1 ELSE 2 END
        LIMIT 1`,
      targetId,
      ctx.tenant.id,
      user.id,
    );
    if (!instance) throw new ApiError(404, "instance_not_found", "That copy is not in your collection.");
    const { canViewCard, effectiveCardAudience } = await import("./visibility");
    if (!(await canViewCard(sharer, instance.card_id, { liveContentAdmin: true }))) throw new ApiError(404, "instance_not_found", "That copy is not available to share.");
    cardSnapshot={global_epoch:epoch.global,tenant_epoch:epoch.tenant,user_epoch:epoch.user,instanceId:instance.id,cardId:instance.card_id,variantId:instance.variant_id,serial:instance.serial,backUrl:instance.back_url};
    const currentAudience = await effectiveCardAudience(ctx, instance.card_id);
    audience = currentAudience === "public" ? "public" : currentAudience === "members" ? "member" : "private";
    payload = {
      label: kind === "latest" ? "Latest pull" : "Card",
      card_id: instance.card_id,
      card_name: instance.card_name,
      card_slug: instance.card_slug,
      subtitle: instance.subtitle,
      variant_name: instance.variant_name,
      finish: instance.effect_key && instance.effect_key !== "none" ? `${instance.material_key} · ${instance.effect_key}` : instance.variant_name,
      serial: instance.serial,
      collection_id: instance.collection_id,
      collection_name: instance.collection_name,
      render_url: instance.render_url,
      back_url: instance.back_url,
      audience,
      captured_at: nowIso(),
    };
  } else if (kind === "collection") {
    const epoch=await readDrawScopeEpoch(ctx);
    if (!epoch) throw new ApiError(503,'share_temporarily_unavailable','Collection sharing is temporarily unavailable.');
    collectionSnapshot={global_epoch:epoch.global,tenant_epoch:epoch.tenant,user_epoch:epoch.user};
    const collection = await first<{ id: string; name: string; slug: string; view_audience: string; public_approved_at: string | null; logo_url: string | null; description: string }>(
      ctx.db,
      "SELECT id, name, slug, view_audience, public_approved_at, logo_url, description FROM fb_collections WHERE id = ? AND status = 'published' AND archived_at IS NULL",
      targetId,
    );
    if (!collection) throw new ApiError(404, "collection_not_found", "That collection does not exist.");
    const { canViewCollection } = await import("./visibility");
    if (!(await canViewCollection(sharer, collection.id, { liveContentAdmin: true }))) throw new ApiError(404, "collection_not_found", "That collection does not exist.");
    audience = collection.view_audience === "public" && collection.public_approved_at ? "public" : "member";
    payload = {
      label: "Collection",
      collection_id: collection.id,
      collection_name: collection.name,
      collection_slug: collection.slug,
      logo_url: collection.logo_url,
      description: collection.description,
      audience,
      captured_at: nowIso(),
    };
  } else if (kind === "achievement") {
    const epoch=await readDrawScopeEpoch(ctx);
    if (!epoch) throw new ApiError(503,'share_temporarily_unavailable','Achievement sharing is temporarily unavailable.');
    const { authorizedAchievementShare } = await import("./achievement-share");
    const achievement = await authorizedAchievementShare(sharer, sharer, targetId!);
    if (!achievement) throw new ApiError(409, "achievement_share_unavailable", "This badge cannot be shared until its collection and roster can be verified.");
    achievementSnapshot={global_epoch:epoch.global,tenant_epoch:epoch.tenant,user_epoch:epoch.user,...achievement.fence};
    audience = "member";
    payload = { ...achievement.payload, achievement_version: 1, achievement_id: achievement.achievementId, criteria_hash: achievement.criteriaHash, captured_at: nowIso() };
  } else if (kind === "profile") {
    const epoch=await readDrawScopeEpoch(ctx);
    if (!epoch) throw new ApiError(503,'share_temporarily_unavailable','Profile sharing is temporarily unavailable.');
    const { getProfileFavouriteInventory } = await import("./collection");
    const { canViewCard } = await import("./visibility");
    const pinned = await getProfileFavouriteInventory(sharer);
    const favouriteCards: Array<Record<string, unknown>> = [];
    const pins: string[][] = [];
    for (const item of pinned) {
      if (favouriteCards.length >= 8) break;
      const published = await first<{ id: string }>(ctx.db, "SELECT id FROM fb_card_definitions WHERE id = ? AND tenant_id = ? AND status = 'published' AND archived_at IS NULL", item.card_id, ctx.tenant.id);
      if (!published || !(await canViewCard(sharer, item.card_id, { liveContentAdmin: true }))) continue;
      favouriteCards.push({ card_id: item.card_id, name: item.card_name, variant_name: item.variant_name, render_url: item.render_url });
      pins.push([item.id,item.card_id,item.variant_id]);
    }
    profileSnapshot={global_epoch:epoch.global,tenant_epoch:epoch.tenant,user_epoch:epoch.user,pins:JSON.stringify(pins)};
    audience = "member";
    payload = { label: "Pinned cards", profile_version: 1, favourite_cards: favouriteCards, audience, captured_at: nowIso() };
  } else if (kind === "wishlist") {
    requireScope(ctx, 'inventory:read');
    try { wishlistSnapshot=await first(ctx.db,`SELECT g.revision AS global_epoch,
      COALESCE((SELECT revision FROM fb_draw_scope_tenant_epochs WHERE tenant_id=?),0) AS tenant_epoch,
      COALESCE((SELECT revision FROM fb_draw_scope_user_epochs WHERE user_id=?),0) AS user_epoch,
      (SELECT json_group_array(json_array(card_id,target_material_key,target_effect_key,target_variant_id,created_at)) FROM
        (SELECT card_id,target_material_key,target_effect_key,target_variant_id,created_at FROM fb_wishlists WHERE tenant_id=? AND user_id=? ORDER BY card_id)) AS wishes
      FROM fb_draw_scope_global_epoch g WHERE g.id=1 AND ${DRAW_EPOCH_TRIGGER_CHECK}`,ctx.tenant.id,user.id,ctx.tenant.id,user.id,DRAW_EPOCH_TRIGGER_DATA);
    } catch(error) {
      if (!/no such table: fb_draw_scope_(?:global_epoch|tenant_epochs|user_epochs)\b/.test(String(error))) throw error;
    }
    if (!wishlistSnapshot) throw new ApiError(503,'share_temporarily_unavailable','Wishlist sharing is temporarily unavailable.');
    const { getWishlist } = await import("./collection");
    const wishes = (await getWishlist(ctx)).slice(0, 100);
    audience = "member";
    payload = {
      label: "Wishlist",
      items: wishes.map((wish) => ({
        card_id: wish.card_id,
        card_name: wish.name,
        card_slug: wish.slug,
        target: wish.target_variant_id || wish.target_material_key || wish.target_effect_key ? "Selected finish" : null,
      })),
      audience,
      captured_at: nowIso(),
    };
  } else {
    const counts = await first<{ cards: number; favourites: number }>(
      ctx.db,
      `SELECT COUNT(*) AS cards, COALESCE(SUM(favourite), 0) AS favourites FROM fb_card_instances WHERE tenant_id = ? AND user_id = ? AND status IN ('owned','reserved')`,
      ctx.tenant.id,
      user.id,
    );
    payload = { label: "Cabinet", cards: counts?.cards ?? 0, favourites: counts?.favourites ?? 0, audience: "private", captured_at: nowIso() };
  }

  const currentOwner = await first<{display_name:string}>(ctx.db,
    "SELECT display_name FROM fb_users WHERE id=? AND disabled_at IS NULL",user.id);
  if (!currentOwner) throw new ApiError(409,'share_access_changed','Your sharing access changed. Sign in again.');
  const ownerDisplayName = currentOwner.display_name;
  const raw = token("fbshare");
  const { sha256Hex } = await import("../ids");
  const id = newId("shr");
  const now = nowIso();
  const expiresInDays = options.expiresInDays ?? 7;
  const expiresAt = new Date(Date.now() + Math.min(30, Math.max(1, expiresInDays)) * 86400 * 1000).toISOString();
  const hash=await sha256Hex(raw);
  if (kind==='wishlist') {
    const {wishlistShareFence}=await import('./collection');
    const fence=wishlistShareFence(ctx,wishlistSnapshot!);
    const results=await ctx.db.batch([
      ctx.db.prepare(`INSERT INTO fb_share_links (id,tenant_id,user_id,token_hash,status,expires_at,created_at,kind,target_id,payload_json)
        SELECT ?,?,?,?,'active',?,?,?,?,? WHERE ${fence.sql}`)
        .bind(id,ctx.tenant.id,user.id,hash,expiresAt,now,kind,targetId,JSON.stringify(payload),...fence.args),
      ctx.db.prepare(`INSERT INTO fb_audit_events(id,tenant_id,actor_type,actor_id,represented_user_id,action,object_type,object_id,metadata_json,request_id,created_at)
        SELECT ?,?,?,?,?,'share.created','share_link',?,?,?,? WHERE changes()=1`)
        .bind(newId('aud'),ctx.tenant.id,ctx.actor.type,ctx.actor.id,ctx.actor.representedUserId,id,JSON.stringify({kind,target_id:targetId,audience,expires_at:expiresAt}),ctx.requestId,now),
    ]);
    if (results[0]?.meta.changes!==1) throw new ApiError(409,'share_access_changed','Your wishlist or access changed. Review it and try again.');
  } else if (cardSnapshot) {
    const {sharePrincipalEpochFence}=await import('./collection');
    const fence=sharePrincipalEpochFence(ctx,cardSnapshot);
    const results=await ctx.db.batch([
      ctx.db.prepare(`INSERT INTO fb_share_links (id,tenant_id,user_id,token_hash,status,expires_at,created_at,kind,target_id,payload_json)
        SELECT ?,?,?,?,'active',?,?,?,?,? WHERE ${fence.sql}
          AND EXISTS (SELECT 1 FROM fb_card_instances ci JOIN fb_card_definitions cd ON cd.id=ci.card_id AND cd.tenant_id=ci.tenant_id
            JOIN fb_variants v ON v.id=ci.variant_id AND v.tenant_id=ci.tenant_id AND v.card_id=ci.card_id
            WHERE ci.id=? AND ci.tenant_id=? AND ci.user_id=? AND ci.card_id=? AND ci.variant_id=? AND ci.serial=? AND ci.status IN ('owned','reserved')
              AND cd.status='published' AND cd.archived_at IS NULL AND v.status='published' AND v.archived_at IS NULL
              AND (SELECT '/media/back/' || br.asset_id FROM fb_variant_back_renders br WHERE br.variant_id=v.id AND br.status='published' LIMIT 1) IS ?)
        RETURNING id`)
        .bind(id,ctx.tenant.id,user.id,hash,expiresAt,now,kind,targetId,JSON.stringify(payload),...fence.args,cardSnapshot.instanceId,ctx.tenant.id,user.id,cardSnapshot.cardId,cardSnapshot.variantId,cardSnapshot.serial,cardSnapshot.backUrl),
      ctx.db.prepare(`INSERT INTO fb_audit_events(id,tenant_id,actor_type,actor_id,represented_user_id,action,object_type,object_id,metadata_json,request_id,created_at)
        SELECT ?,?,?,?,?,'share.created','share_link',?,?,?,? WHERE changes()=1`)
        .bind(newId('aud'),ctx.tenant.id,ctx.actor.type,ctx.actor.id,ctx.actor.representedUserId,id,JSON.stringify({kind,target_id:targetId,audience,expires_at:expiresAt}),ctx.requestId,now),
    ]);
    if (results[0]?.results?.length!==1) throw new ApiError(409,'share_access_changed','The card or your access changed. Review it and try again.');
  } else if (collectionSnapshot || profileSnapshot || achievementSnapshot) {
    const {sharePrincipalEpochFence}=await import('./collection');
    const fence=sharePrincipalEpochFence(ctx,(collectionSnapshot || profileSnapshot || achievementSnapshot)!,false);
    const results=await ctx.db.batch([
      ctx.db.prepare(`INSERT INTO fb_share_links (id,tenant_id,user_id,token_hash,status,expires_at,created_at,kind,target_id,payload_json)
        SELECT ?,?,?,?,'active',?,?,?,?,? WHERE ${fence.sql}
          AND NOT EXISTS (SELECT 1 FROM json_each(?) p WHERE NOT EXISTS (SELECT 1 FROM fb_card_instances ci
            WHERE ci.id=json_extract(p.value,'$[0]') AND ci.card_id=json_extract(p.value,'$[1]') AND ci.variant_id=json_extract(p.value,'$[2]')
              AND ci.tenant_id=? AND ci.user_id=? AND ci.status IN ('owned','reserved') AND ci.favourite=1))
          AND (?<>'achievement' OR EXISTS (SELECT 1 FROM fb_achievement_unlocks u JOIN fb_achievement_definitions d ON d.id=u.achievement_id AND d.version=u.achievement_version
            WHERE u.id=? AND u.tenant_id=? AND u.user_id=? AND u.achievement_id=? AND u.achievement_version=? AND u.earned_at=?
              AND d.status='active' AND d.archived_at IS NULL AND (d.scope='platform' OR (d.scope='bot' AND d.tenant_id=?)) AND d.criteria_json=? AND d.visibility=?)) RETURNING id`)
        .bind(id,ctx.tenant.id,user.id,hash,expiresAt,now,kind,targetId,JSON.stringify(payload),...fence.args,profileSnapshot?.pins ?? '[]',ctx.tenant.id,user.id,
          kind,targetId,ctx.tenant.id,user.id,achievementSnapshot?.achievementId ?? '',achievementSnapshot?.version ?? -1,achievementSnapshot?.earnedAt ?? '',ctx.tenant.id,achievementSnapshot?.criteria ?? '',achievementSnapshot?.visibility ?? ''),
      ctx.db.prepare(`INSERT INTO fb_audit_events(id,tenant_id,actor_type,actor_id,represented_user_id,action,object_type,object_id,metadata_json,request_id,created_at)
        SELECT ?,?,?,?,?,'share.created','share_link',?,?,?,? WHERE changes()=1`)
        .bind(newId('aud'),ctx.tenant.id,ctx.actor.type,ctx.actor.id,ctx.actor.representedUserId,id,JSON.stringify({kind,target_id:targetId,audience,expires_at:expiresAt}),ctx.requestId,now),
    ]);
    if (results[0]?.results?.length!==1) throw new ApiError(409,'share_access_changed','Your selection or access changed. Review it and try again.');
  } else {
    await ctx.db.batch([
      ctx.db.prepare("INSERT INTO fb_share_links (id, tenant_id, user_id, token_hash, status, expires_at, created_at, kind, target_id, payload_json) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)")
        .bind(id,ctx.tenant.id,user.id,hash,expiresAt,now,kind,targetId,JSON.stringify(payload)),
      auditStatement(ctx,"share.created","share_link",id,{kind,target_id:targetId,audience,expires_at:expiresAt}),
    ]);
  }
  return {
    id,
    token: raw,
    url: `${ctx.config.publicOrigin}/s/${raw}`,
    kind,
    audience,
    preview: kind === "wishlist" ? { ...payload, items: (payload.items as Array<Record<string, unknown>>).map(({ card_id: _cardId, ...item }) => item) } : kind === "profile" ? { ...payload, favourite_cards: (payload.favourite_cards as Array<Record<string, unknown>>).map(({ card_id: _cardId, ...item }) => item) } : kind === "achievement" ? (({ achievement_id: _id, criteria_hash: _hash, ...safe }) => safe)(payload) : payload,
    owner_display_name: ownerDisplayName,
    expires_at: expiresAt,
  };
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
  const user=ctx.user;
  if (!user || ctx.actor.type!=='user' || ctx.actor.id!==user.id || ctx.actor.representedUserId!==user.id)
    throw new ApiError(403,'backup_access_changed','A signed-in Super Admin is required.');
  const principal=JSON.stringify({tenant:ctx.tenant.id,user:user.id,session:ctx.sessionId,assurance:ctx.sessionAssurance});
  const row=await first<{schema_version:string|null;cards:number;variants:number;instances:number;ledger:number;wallets:number;assets:number;asset_bytes:number;wallet_total:number;release_json:string|null}>(ctx.db,`/* backup:manifest */ WITH x AS (SELECT json(?) p)
    SELECT (SELECT value FROM fb_schema_meta WHERE key='domain_schema_version') AS schema_version,
      (SELECT COUNT(*) FROM fb_card_definitions WHERE tenant_id=json_extract(x.p,'$.tenant')) AS cards,
      (SELECT COUNT(*) FROM fb_variants WHERE tenant_id=json_extract(x.p,'$.tenant')) AS variants,
      (SELECT COUNT(*) FROM fb_card_instances WHERE tenant_id=json_extract(x.p,'$.tenant')) AS instances,
      (SELECT COUNT(*) FROM fb_ledger_entries WHERE tenant_id=json_extract(x.p,'$.tenant')) AS ledger,
      (SELECT COUNT(*) FROM fb_wallets WHERE tenant_id=json_extract(x.p,'$.tenant')) AS wallets,
      (SELECT COUNT(*) FROM fb_assets WHERE tenant_id=json_extract(x.p,'$.tenant')) AS assets,
      (SELECT COALESCE(SUM(bytes),0) FROM fb_assets WHERE tenant_id=json_extract(x.p,'$.tenant')) AS asset_bytes,
      (SELECT COALESCE(SUM(balance),0) FROM fb_wallets WHERE tenant_id=json_extract(x.p,'$.tenant')) AS wallet_total,
      (SELECT json_object('version',version,'checksum',checksum,'published_at',published_at) FROM fb_catalogue_releases WHERE tenant_id=json_extract(x.p,'$.tenant') AND status='active' ORDER BY version DESC LIMIT 1) AS release_json
      FROM x WHERE EXISTS (SELECT 1 FROM fb_memberships m JOIN fb_users u ON u.id=m.user_id AND u.disabled_at IS NULL
        JOIN fb_bots b ON b.tenant_id=m.tenant_id AND b.status='active'
        JOIN fb_sessions s ON s.id=json_extract(x.p,'$.session') AND s.user_id=u.id AND s.tenant_id=m.tenant_id AND s.revoked_at IS NULL
          AND s.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND s.assurance=json_extract(x.p,'$.assurance') AND s.assurance IN ('passkey','mfa')
          AND s.auth_time>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 minutes') AND s.auth_time<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE m.tenant_id=json_extract(x.p,'$.tenant') AND m.user_id=json_extract(x.p,'$.user') AND m.status='active' AND m.revoked_at IS NULL
        AND u.platform_admin=1 AND EXISTS (SELECT 1 FROM fb_platform_admins pa WHERE pa.user_id=u.id AND pa.status='active' AND pa.revoked_at IS NULL))`,principal);
  if (!row) throw new ApiError(403,'backup_access_changed','Your Super Admin access or recent sign-in changed.');
  return {schemaVersion:row.schema_version ?? 'unknown',tenant:ctx.tenant.slug,counts:{cards:row.cards,variants:row.variants,instances:row.instances,ledger:row.ledger,wallets:row.wallets,assets:row.assets,assetBytes:row.asset_bytes},walletTotal:row.wallet_total,release:row.release_json ? JSON.parse(row.release_json) : null,generatedAt:nowIso()};
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

export async function listShareLinks(ctx: Ctx) {
  const user = ctx.user;
  if (!user) throw new ApiError(401, "authentication_required", "Sign in to review your shares.");
  const rows = await all<{ id: string; kind: string; target_id: string | null; status: string; created_at: string; expires_at: string; payload_json: string }>(
    ctx.db,
    "SELECT id, kind, target_id, status, created_at, expires_at, payload_json FROM fb_share_links WHERE tenant_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 100",
    ctx.tenant.id,
    user.id,
  );
  return rows.map((row) => {
    // Historical snapshot metadata may no longer be visible to its creator.
    // Management needs kind, status and expiry, not the captured content.
    return { ...row, payload_json: undefined, preview: {} };
  });
}
