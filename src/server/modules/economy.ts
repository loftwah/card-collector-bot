import {
  ApiError,
  canIssueScopedGrant,
  checkRateLimit,
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
import {
  getProfilePresentationOptions,
  parseProfilePresentation,
  profilePresentationVersion,
  profileSharePresentation,
  resolveProfilePresentation,
  validateProfilePresentation,
} from "./profile-presentation";

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
  // Scoped agent credentials do not establish recent human authentication.
  requireRecentStrongAuth(ctx, 30);
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
  if (replay) {
    const settings = await getEconomy(ctx);
    const wallet = await getWalletSummary(ctx.db, ctx.tenant.id, user.id, 1);
    const last = await first<{ created_at: string }>(
      ctx.db,
      "SELECT created_at FROM fb_reward_claims WHERE tenant_id = ? AND user_id = ? AND rule_key = 'daily-allowance' ORDER BY created_at DESC LIMIT 1",
      ctx.tenant.id,
      user.id,
    );
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
  }
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

/** Minimal, Bot-scoped recipient choices for the signed-in Studio grant form. */
export async function listGrantRecipients(ctx: Ctx) {
  const user = ctx.user;
  if (!user || ctx.actor.type !== "user" || !ctx.sessionId)
    throw new ApiError(403, "grant_recipients_unavailable", "Sign in to Studio to choose a recipient.");
  return all<{ id: string; display_name: string }>(ctx.db, `
    SELECT target.id, target.display_name
    FROM fb_users actor JOIN fb_memberships am ON am.user_id=actor.id AND am.tenant_id=?
    JOIN fb_sessions session ON session.user_id=actor.id AND session.tenant_id=am.tenant_id AND session.id=?
    JOIN fb_memberships tm ON tm.tenant_id=am.tenant_id
    JOIN fb_users target ON target.id=tm.user_id
    JOIN fb_wallets w ON w.tenant_id=tm.tenant_id AND w.user_id=target.id
    WHERE actor.id=? AND actor.disabled_at IS NULL AND actor.is_synthetic=0
      AND am.status='active' AND am.revoked_at IS NULL
      AND session.revoked_at IS NULL AND julianday(session.expires_at)>julianday('now')
      AND (am.role='owner' OR (actor.platform_admin=1 AND EXISTS (SELECT 1 FROM fb_platform_admins pa WHERE pa.user_id=actor.id AND pa.status='active' AND pa.revoked_at IS NULL)) OR EXISTS (
        SELECT 1 FROM json_each(CASE WHEN json_valid(am.capabilities_json) THEN am.capabilities_json ELSE '[]' END) cap
        WHERE json_type(CASE WHEN json_valid(am.capabilities_json) THEN am.capabilities_json ELSE '[]' END)='array'
          AND cap.type='text' AND cap.value='grants'))
      AND tm.status='active' AND tm.revoked_at IS NULL AND target.disabled_at IS NULL AND target.is_synthetic=0
      AND (target.id<>actor.id OR am.role='owner' OR (actor.platform_admin=1 AND EXISTS (SELECT 1 FROM fb_platform_admins pa WHERE pa.user_id=actor.id AND pa.status='active' AND pa.revoked_at IS NULL)) OR am.self_grants_enabled=1)
    ORDER BY target.display_name, target.id`,ctx.tenant.id,ctx.sessionId,user.id);
}

export async function adjustWallet(
  ctx: Ctx,
  input: { userId: string; amount: number; reason: string; idempotency: IdempotencyInput },
) {
  try {
    return await adjustWalletGuarded(ctx, input);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503,"grant_outcome_unavailable","The grant outcome could not be confirmed. Retry the same grant or check the ledger.");
  }
}

async function adjustWalletGuarded(
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
  if (ctx.actor.type === "agent") {
    throw new ApiError(403, "strong_auth_required", "Foil adjustments require a human with recent strong authentication. Open Studio and confirm with a passkey, authenticator or Cloudflare Access.");
  }
  // Re-read authority at the mutation boundary. A session or stale form that
  // loaded before a revocation must not keep the removed capability.
  const live = await first<{
    role: CurrentUser["role"];
    capabilities_json: string;
    self_grants_enabled: number;
    grant_limit: number;
    capability_revision: number;
    status: string;
    revoked_at: string | null;
  }>(
    ctx.db,
    `SELECT role, capabilities_json, self_grants_enabled, grant_limit, capability_revision, status, revoked_at
       FROM fb_memberships WHERE tenant_id = ? AND user_id = ?`,
    ctx.tenant.id,
    user.id,
  );
  if (!live || live.status !== "active" || live.revoked_at) {
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
  // Bind the same live actor policy and exact credential to the balance write.
  // A Discord button is not a strong-auth proof; Discord directs humans to Studio.
  let proofSql: string;
  let proofArgs: unknown[];
  if (ctx.actor.type === "user" && ctx.actor.id === user.id && ctx.accessIdentity && ctx.accessStatus === "linked" && ctx.sessionAssurance === "access") {
    proofSql = `? > unixepoch('now') AND EXISTS (SELECT 1 FROM fb_access_identities ai
      WHERE ai.user_id=u.id AND ai.team_domain=? AND ai.subject=? AND ai.revoked_at IS NULL)`;
    proofArgs = [Number(ctx.accessIdentity.payload.exp ?? 0), ctx.config.access.teamDomain, ctx.accessIdentity.subject];
  } else if (ctx.actor.type === "user" && ctx.actor.id === user.id && ctx.sessionId) {
    proofSql = `EXISTS (SELECT 1 FROM fb_sessions sess WHERE sess.id=? AND sess.user_id=u.id
      AND sess.tenant_id=m.tenant_id AND sess.revoked_at IS NULL AND julianday(sess.expires_at)>julianday('now')
      AND sess.assurance IN ('passkey','mfa') AND julianday(sess.auth_time)<=julianday('now')
      AND julianday(sess.auth_time)>=julianday('now','-30 minutes'))`;
    proofArgs = [ctx.sessionId];
  } else {
    throw new ApiError(403, "strong_auth_required", "Foil grants need recent strong authentication. Open Studio and confirm with a passkey, authenticator or Cloudflare Access.");
  }
  const authoritySql = `EXISTS (SELECT 1 FROM fb_users u JOIN fb_memberships m ON m.user_id=u.id
    WHERE u.id=? AND m.tenant_id=? AND u.disabled_at IS NULL AND u.is_synthetic=0 AND u.platform_admin=?
      AND m.status='active' AND m.revoked_at IS NULL AND m.role=?
      AND (u.platform_admin=0 OR m.role='owner' OR EXISTS (SELECT 1 FROM fb_platform_admins pa WHERE pa.user_id=u.id AND pa.status='active' AND pa.revoked_at IS NULL))
      AND COALESCE(m.capabilities_json,'[]')=? AND m.self_grants_enabled=? AND m.grant_limit=? AND m.capability_revision=?
      AND (${proofSql}))`;
  const authorityArgs: unknown[] = [user.id,ctx.tenant.id,user.platformAdmin?1:0,live.role,live.capabilities_json ?? '[]',live.self_grants_enabled,live.grant_limit,live.capability_revision,...proofArgs];
  const targetSql = `EXISTS (SELECT 1 FROM fb_memberships tm JOIN fb_users tu ON tu.id=tm.user_id
    WHERE tm.tenant_id=? AND tm.user_id=? AND tm.status='active' AND tm.revoked_at IS NULL
      AND tu.disabled_at IS NULL AND tu.is_synthetic=0)`;
  const targetArgs = [ctx.tenant.id,input.userId];
  const isCurrent = async () => Boolean(await first<{ok:number}>(ctx.db,
    `SELECT 1 AS ok WHERE ${authoritySql} AND ${targetSql}`,...authorityArgs,...targetArgs));
  if (!await isCurrent()) throw new ApiError(409,"grant_authority_changed","The grant outcome cannot be confirmed with current access. Check the ledger with an authorised administrator.");
  const readReceipt = async () => {
    try {
    const row = await first<{ request_digest: string; response_json: string; status: string }>(ctx.db,
      `SELECT request_digest,response_json,status FROM fb_idempotency_keys
       WHERE tenant_id=? AND actor_type=? AND actor_id=? AND operation='economy.adjust' AND idempotency_key=?
         AND ${authoritySql} AND ${targetSql}`,
      ctx.tenant.id,ctx.actor.type,ctx.actor.id,input.idempotency.key,...authorityArgs,...targetArgs);
    if (!row) return null;
    if (row.request_digest !== input.idempotency.digest) throw new ApiError(409,"idempotency_conflict","This idempotency key was already used with a different request.");
    if (row.status !== 'completed') throw new ApiError(503,"grant_outcome_unavailable","The grant outcome could not be confirmed. Check the ledger before trying again.");
    const receipt=JSON.parse(row.response_json) as Record<string,unknown>;
    if (receipt.user_id !== input.userId || receipt.amount !== input.amount || receipt.reason !== input.reason.trim())
      throw new ApiError(409,"idempotency_conflict","This idempotency key was already used with a different grant.");
    return receipt;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(503,"grant_outcome_unavailable","The grant outcome could not be confirmed. Retry the same grant or check the ledger.");
    }
  };
  const replay = await readReceipt();
  if (replay) return { ...replay, replayed: true };
  const now=nowIso(), ledgerId=newId("led"), idemKey=`adjust:${input.idempotency.key}`;
  try {
    await ctx.db.batch([
      ctx.db.prepare(`INSERT INTO fb_idempotency_keys
        (tenant_id,actor_type,actor_id,operation,idempotency_key,request_digest,status,response_json,created_at)
        VALUES (?,?,?,'economy.adjust',?,?,'in_progress','{}',?)`)
        .bind(ctx.tenant.id,ctx.actor.type,ctx.actor.id,input.idempotency.key,input.idempotency.digest,now),
      ctx.db.prepare(`UPDATE fb_wallets SET balance=balance+?,updated_at=? WHERE tenant_id=? AND user_id=?
        AND balance+?>=0 AND ${authoritySql} AND ${targetSql}`)
        .bind(input.amount,now,ctx.tenant.id,input.userId,input.amount,...authorityArgs,...targetArgs),
      ctx.db.prepare(`SELECT CASE WHEN changes()=1 THEN 1 ELSE json('grant_authority_changed') END`),
      ctx.db.prepare(`INSERT INTO fb_ledger_entries
        (id,tenant_id,user_id,kind,amount,balance_after,reference_type,reference_id,description,idempotency_key,metadata_json,actor_type,actor_id,created_at)
        SELECT ?,?,?,'correction',?,balance,'admin_adjustment',NULL,?,?,?,?,?,? FROM fb_wallets WHERE tenant_id=? AND user_id=?`)
        .bind(ledgerId,ctx.tenant.id,input.userId,input.amount,input.reason.trim(),idemKey,JSON.stringify({reason:input.reason.trim(),actor:ctx.actor.id}),ctx.actor.type,ctx.actor.id,now,ctx.tenant.id,input.userId),
      ctx.db.prepare(`SELECT CASE WHEN changes()=1 THEN 1 ELSE json('grant_ledger_missing') END`),
      ctx.db.prepare(`UPDATE fb_idempotency_keys SET status='completed',response_json=(SELECT json_object(
        'user_id',?,'amount',?,'balance_after',balance,'ledger_id',?,'reason',?) FROM fb_wallets WHERE tenant_id=? AND user_id=?)
        WHERE tenant_id=? AND actor_type=? AND actor_id=? AND operation='economy.adjust' AND idempotency_key=? AND request_digest=?`)
        .bind(input.userId,input.amount,ledgerId,input.reason.trim(),ctx.tenant.id,input.userId,ctx.tenant.id,ctx.actor.type,ctx.actor.id,input.idempotency.key,input.idempotency.digest),
      ctx.db.prepare(`SELECT CASE WHEN changes()=1 THEN 1 ELSE json('grant_receipt_missing') END`),
      auditStatement(ctx,"wallet.adjusted","wallet",input.userId,{amount:input.amount,reason:input.reason.trim(),ledger_id:ledgerId}),
      ctx.db.prepare(`SELECT CASE WHEN changes()=1 THEN 1 ELSE json('grant_audit_missing') END`),
    ]);
  } catch (error) {
    // A batch may have committed even when its response was lost.
    const reconciled = await readReceipt();
    if (reconciled) return { ...reconciled, replayed:true };
    if (String(error).includes('UNIQUE')) {
      if (!await isCurrent()) throw new ApiError(409,"grant_authority_changed","The grant could not be confirmed. Refresh Studio and check access and recipient eligibility.");
      const prior=await readReceipt();
      if (prior) return { ...prior, replayed:true };
      throw new ApiError(409,"idempotency_conflict","This idempotency key was already used for another grant.");
    }
    if (String(error).includes('malformed JSON')) {
      const insufficient = input.amount < 0 && await first<{ok:number}>(ctx.db,
        `SELECT 1 AS ok FROM fb_wallets WHERE tenant_id=? AND user_id=? AND balance+?<0 AND ${authoritySql} AND ${targetSql}`,
        ctx.tenant.id,input.userId,input.amount,...authorityArgs,...targetArgs);
      if (insufficient) throw new ApiError(409,"insufficient_funds","The correction would make this wallet negative.");
      throw new ApiError(409,"grant_authority_changed","The grant outcome cannot be confirmed with current access. Check the ledger with an authorised administrator.");
    }
    throw new ApiError(503,"grant_outcome_unavailable","The grant outcome could not be confirmed. Retry the same grant or check the ledger.");
  }
  const result=await readReceipt();
  if (!result) throw new ApiError(503,"grant_outcome_unavailable","The grant outcome could not be confirmed. Check the ledger before trying again.");
  return { ...result, replayed:false };
}

export async function getLedger(ctx: Ctx, userId: string, limit = 100) {
  if (ctx.user?.role === "player" && ctx.user.id !== userId) {
    throw new ApiError(403, "insufficient_role", "You can only read your own ledger.");
  }
  return getWalletSummary(ctx.db, ctx.tenant.id, userId, Math.min(200, Math.max(1, limit)));
}

const PROFILE_LOOKS = ["quiet", "signal", "binder", "night"] as const;
export type ProfileLook = (typeof PROFILE_LOOKS)[number];

export async function getPreferences(ctx: Ctx) {
  const user = ctx.user;
  if (!user) throw new ApiError(401, "authentication_required", "Sign in to change preferences.");
  const row = await first<{
    hide_tags_json: string;
    hidden_collection_ids_json: string;
    reduced_motion: number;
    sound_enabled: number;
    sharing_enabled: number;
    profile_look: string;
    profile_bio: string;
    profile_presentation_json: string;
    profile_presentation_version: number;
    updated_at: string;
  }>(
    ctx.db,
    "SELECT hide_tags_json, hidden_collection_ids_json, reduced_motion, sound_enabled, sharing_enabled, profile_look, profile_bio, profile_presentation_json, profile_presentation_version, updated_at FROM fb_player_preferences WHERE tenant_id = ? AND user_id = ?",
    ctx.tenant.id,
    user.id,
  );
  return {
    hide_tags: row ? safeStringArray(row.hide_tags_json) : [],
    hidden_collection_ids: row ? safeStringArray(row.hidden_collection_ids_json) : [],
    reduced_motion: Boolean(row?.reduced_motion),
    sound_enabled: Boolean(row?.sound_enabled),
    sharing_enabled: Boolean(row?.sharing_enabled),
    profile_look: (row && PROFILE_LOOKS.includes(row.profile_look as ProfileLook)
      ? row.profile_look
      : "quiet") as ProfileLook,
    profile_bio: row?.profile_bio ?? "",
    profile_presentation: parseProfilePresentation(row?.profile_presentation_json),
    profile_presentation_version: profilePresentationVersion(row),
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
    profileLook?: ProfileLook;
    profileBio?: string;
    profilePresentation?: unknown;
    profilePresentationVersion?: number;
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
  const profileLook = input.profileLook ?? current.profile_look;
  if (!PROFILE_LOOKS.includes(profileLook)) {
    throw new ApiError(422, "profile_look_invalid", "Choose one of the available profile looks.");
  }
  const profileBio = (input.profileBio ?? current.profile_bio).trim();
  if (profileBio.length > 160) {
    throw new ApiError(422, "profile_bio_too_long", "Keep the collector note to 160 characters or fewer.");
  }
  if (
    input.profilePresentationVersion !== undefined &&
    input.profilePresentationVersion !== current.profile_presentation_version
  ) {
    throw new ApiError(
      409,
      "profile_presentation_stale",
      "Your profile changed in another tab. Reload the latest saved composition before saving again.",
      {
        current_version: current.profile_presentation_version,
        current_presentation: current.profile_presentation,
      },
    );
  }
  const profilePresentation = input.profilePresentation
    ? validateProfilePresentation(input.profilePresentation, await getProfilePresentationOptions(ctx))
    : current.profile_presentation;
  const nextProfilePresentationVersion = input.profilePresentation
    ? current.profile_presentation_version + 1
    : current.profile_presentation_version;
  await ctx.db.batch([
    ctx.db
      .prepare(
        `INSERT INTO fb_player_preferences (tenant_id, user_id, hide_tags_json, hidden_collection_ids_json, reduced_motion, sound_enabled, sharing_enabled, profile_look, profile_bio, profile_presentation_json, profile_presentation_version, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, user_id) DO UPDATE SET
           hide_tags_json = excluded.hide_tags_json,
           hidden_collection_ids_json = excluded.hidden_collection_ids_json,
           reduced_motion = excluded.reduced_motion,
           sound_enabled = excluded.sound_enabled,
           sharing_enabled = excluded.sharing_enabled,
           profile_look = excluded.profile_look,
           profile_bio = excluded.profile_bio,
           profile_presentation_json = excluded.profile_presentation_json,
           profile_presentation_version = excluded.profile_presentation_version,
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
        profileLook,
        profileBio,
        JSON.stringify(profilePresentation),
        nextProfilePresentationVersion,
        nowIso(),
      ),
    auditStatement(ctx, "preferences.updated", "preferences", user.id, {
      hide_tags: input.hideTags ?? current.hide_tags,
      hidden_collection_ids: hiddenCollectionIds ?? current.hidden_collection_ids,
      reduced_motion: input.reducedMotion ?? current.reduced_motion,
      sound_enabled: input.soundEnabled ?? current.sound_enabled,
      sharing_enabled: input.sharingEnabled ?? current.sharing_enabled,
      profile_look: profileLook,
      profile_bio_length: profileBio.length,
      profile_presentation: {
        version: nextProfilePresentationVersion,
        portrait: profilePresentation.portrait,
        banner: profilePresentation.banner,
        frame: profilePresentation.frame,
        avatar_decoration: profilePresentation.avatarDecoration,
        name_treatment: profilePresentation.nameTreatment,
        effect: profilePresentation.effect,
        featured: Boolean(profilePresentation.featuredInstanceId),
        favourites: profilePresentation.favouriteInstanceIds.length,
        badges: profilePresentation.badgeIds.length,
      },
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
  let ownerDisplayName = user.displayName;

  if (kind === "card" || kind === "latest") {
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
        ORDER BY CASE c.view_audience WHEN 'public' THEN 0 WHEN 'members' THEN 1 ELSE 2 END
        LIMIT 1`,
      targetId,
      ctx.tenant.id,
      user.id,
    );
    if (!instance) throw new ApiError(404, "instance_not_found", "That copy is not in your collection.");
    audience = instance.collection_audience === "public" && instance.collection_approved_at ? "public" : "member";
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
    const collection = await first<{ id: string; name: string; slug: string; view_audience: string; public_approved_at: string | null; logo_url: string | null; description: string }>(
      ctx.db,
      "SELECT id, name, slug, view_audience, public_approved_at, logo_url, description FROM fb_collections WHERE id = ? AND archived_at IS NULL",
      targetId,
    );
    if (!collection) throw new ApiError(404, "collection_not_found", "That collection does not exist.");
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
    const unlock = await first<{ id: string; achievement_id: string; earned_at: string; name: string; description: string; art_key: string; category: string }>(
      ctx.db,
      `SELECT u.id, u.achievement_id, u.earned_at, d.name, d.description, d.art_key, d.category
         FROM fb_achievement_unlocks u JOIN fb_achievement_definitions d ON d.id = u.achievement_id
        WHERE u.id = ? AND u.tenant_id = ? AND u.user_id = ?`,
      targetId,
      ctx.tenant.id,
      user.id,
    );
    if (!unlock) throw new ApiError(404, "achievement_not_found", "That badge is not in your cabinet.");
    const definitionRow = await first<{ criteria_json: string }>(ctx.db, "SELECT criteria_json FROM fb_achievement_definitions WHERE id = ?", unlock.achievement_id);
    let collectionLogo: string | null = null;
    try {
      const criteria = JSON.parse(definitionRow?.criteria_json ?? "{}") as { collection_id?: string };
      if (criteria.collection_id) {
        const logo = await first<{ logo_url: string | null }>(ctx.db, "SELECT logo_url FROM fb_collections WHERE id = ?", criteria.collection_id);
        collectionLogo = logo?.logo_url ?? null;
      }
    } catch {}
    audience = "member";
    payload = {
      label: "Achievement",
      achievement_id: unlock.achievement_id,
      achievement_name: unlock.name,
      achievement_description: unlock.description,
      art_key: unlock.art_key,
      category: unlock.category,
      earned_at: unlock.earned_at,
      collection_logo_url: collectionLogo,
      audience,
      captured_at: nowIso(),
    };
  } else if (kind === "wishlist") {
    const wishes = await all<{ card_name: string; card_slug: string; target_material_key: string | null; target_effect_key: string | null; variant_name: string | null }>(
      ctx.db,
      `SELECT cd.name AS card_name, cd.slug AS card_slug, w.target_material_key, w.target_effect_key, v.name AS variant_name
         FROM fb_wishlists w JOIN fb_card_definitions cd ON cd.id = w.card_id
         LEFT JOIN fb_variants v ON v.id = w.target_variant_id
        WHERE w.tenant_id = ? AND w.user_id = ? ORDER BY cd.name LIMIT 100`,
      ctx.tenant.id,
      user.id,
    );
    audience = "member";
    payload = {
      label: "Wishlist",
      items: wishes.map((wish) => ({
        card_name: wish.card_name,
        card_slug: wish.card_slug,
        target: wish.variant_name ?? ([wish.target_material_key, wish.target_effect_key].filter(Boolean).join(" · ") || null),
      })),
      audience,
      captured_at: nowIso(),
    };
  } else if (kind === "profile") {
    const [counts, options] = await Promise.all([
      first<{ cards: number; favourites: number }>(
        ctx.db,
        "SELECT COUNT(*) AS cards, COALESCE(SUM(favourite), 0) AS favourites FROM fb_card_instances WHERE tenant_id = ? AND user_id = ? AND status IN ('owned','reserved')",
        ctx.tenant.id,
        user.id,
      ),
      getProfilePresentationOptions(ctx),
    ]);
    const resolved = resolveProfilePresentation(prefs.profile_presentation, options);
    audience = "member";
    payload = {
      label: "Collector profile",
      display_name: user.displayName,
      profile_look: prefs.profile_look,
      profile_bio: prefs.profile_bio,
      cards: counts?.cards ?? 0,
      favourites: counts?.favourites ?? 0,
      favourite_cards: resolved.favourites.map((copy) => ({
        name: copy.cardName,
        variant_name: copy.variantName,
        render_url: copy.renderUrl,
      })),
      badges: resolved.badges.map((badge) => ({
        name: badge.name,
        art_key: badge.artKey,
        category: badge.category,
      })),
      presentation: profileSharePresentation(resolved),
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

  const raw = token("fbshare");
  const { sha256Hex } = await import("../ids");
  const id = newId("shr");
  const now = nowIso();
  const expiresInDays = options.expiresInDays ?? 7;
  const expiresAt = new Date(Date.now() + Math.min(30, Math.max(1, expiresInDays)) * 86400 * 1000).toISOString();
  await ctx.db.batch([
    ctx.db
      .prepare(
        "INSERT INTO fb_share_links (id, tenant_id, user_id, token_hash, status, expires_at, created_at, kind, target_id, payload_json) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)",
      )
      .bind(id, ctx.tenant.id, user.id, await sha256Hex(raw), expiresAt, now, kind, targetId, JSON.stringify(payload)),
    auditStatement(ctx, "share.created", "share_link", id, { kind, target_id: targetId, audience, expires_at: expiresAt }),
  ]);
  return {
    id,
    token: raw,
    url: `${ctx.config.publicOrigin}/s/${raw}`,
    kind,
    audience,
    preview: payload,
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
    let preview: Record<string, unknown> = {};
    try { preview = JSON.parse(row.payload_json) as Record<string, unknown>; } catch { preview = {}; }
    return { ...row, payload_json: undefined, preview };
  });
}
