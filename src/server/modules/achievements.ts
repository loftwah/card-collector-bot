import { ApiError, requireSuperAdminContent, type Ctx } from "../context";
import { all, first, nowIso } from "../db";
import { newId } from "../ids";
import { auditStatement } from "../http";
import { creditWallet } from "./wallet";
import { visibleCollectionIds } from "./visibility";

export interface AchievementDefinition {
  id: string;
  scope: "platform" | "bot";
  tenant_id: string | null;
  key: string;
  version: number;
  name: string;
  description: string;
  criteria_json: string;
  reward_json: string;
  visibility: "public" | "member" | "private";
  art_key: string;
  category: string;
  sort: number;
  status: string;
}

export interface AchievementProgress {
  progress: number;
  target: number;
  state: "locked" | "in_progress" | "earned";
}

export interface AchievementView extends AchievementDefinition {
  progress: number;
  target: number;
  state: "locked" | "in_progress" | "earned";
  earned_at: string | null;
  reward_amount: number;
  reward_state: string | null;
  notification_state: string | null;
  criteria: Record<string, unknown>;
  reward: Record<string, unknown>;
}

interface UnlockRewardRow {
  id: string;
  user_id: string;
  achievement_id: string;
  achievement_version: number;
  reward_state: string;
  reward_amount: number;
  reward_ledger_id: string | null;
  notification_state: string;
}

/**
 * Durable reward/notification fulfilment for one unlock. Safe to call on every
 * evaluation: the ledger idempotency key is the authority for an uncertain
 * credit, and the outbox lookup prevents a second notification. A failure is
 * recorded and retried by the next evaluation or backfill.
 */
async function fulfilAchievementReward(
  ctx: Ctx,
  unlock: UnlockRewardRow,
  definition: AchievementDefinition,
): Promise<{ rewardState: string; notificationState: string }> {
  let rewardState = unlock.reward_state;
  let rewardLedgerId = unlock.reward_ledger_id;
  const idempotencyKey = `achievement:${unlock.achievement_id}:${unlock.achievement_version}:${unlock.user_id}`;
  if (unlock.reward_amount > 0 && rewardState !== "granted") {
    const previous = await first<{ id: string }>(
      ctx.db,
      "SELECT id FROM fb_ledger_entries WHERE tenant_id = ? AND user_id = ? AND idempotency_key = ?",
      ctx.tenant.id,
      unlock.user_id,
      idempotencyKey,
    );
    if (previous) {
      rewardState = "granted";
      rewardLedgerId = previous.id;
    } else {
      try {
        const credit = await creditWallet(ctx.db, {
          tenantId: ctx.tenant.id,
          userId: unlock.user_id,
          amount: unlock.reward_amount,
          kind: "issue",
          description: `Achievement: ${definition.name}`,
          idempotencyKey,
          referenceType: "achievement",
          referenceId: unlock.id,
          metadata: { achievement_key: definition.key, achievement_version: definition.version },
          actorType: "system",
          actorId: "achievements",
        });
        rewardState = "granted";
        rewardLedgerId = credit.ledgerId;
      } catch (error) {
        await ctx.db
          .prepare(
            "UPDATE fb_achievement_unlocks SET reward_state = 'failed', reward_ledger_id = NULL WHERE id = ? AND tenant_id = ?",
          )
          .bind(unlock.id, ctx.tenant.id)
          .run()
          .catch(() => undefined);
        console.error(
          JSON.stringify({
            level: "error",
            message: "achievement reward failed",
            achievement: definition.key,
            unlock: unlock.id,
            error: String(error),
          }),
        );
        return { rewardState: "failed", notificationState: unlock.notification_state };
      }
    }
  } else if (unlock.reward_amount <= 0) {
    rewardState = "none";
  }

  let notificationState = unlock.notification_state;
  if (notificationState === "pending") {
    const outbox = await first<{ id: string; status: string }>(
      ctx.db,
      `SELECT id, status FROM fb_outbox
        WHERE tenant_id = ? AND topic = 'achievement.earned'
          AND json_extract(payload_json, '$.unlock_id') = ?
        ORDER BY created_at DESC LIMIT 1`,
      ctx.tenant.id,
      unlock.id,
    );
    if (!outbox) {
      await ctx.db
        .prepare(
          `INSERT INTO fb_outbox (id, tenant_id, topic, payload_json, status, attempts, available_at, created_at)
           VALUES (?, ?, 'achievement.earned', ?, 'pending', 0, ?, ?)`,
        )
        .bind(
          newId("obx"),
          ctx.tenant.id,
          JSON.stringify({
            unlock_id: unlock.id,
            user_id: unlock.user_id,
            achievement_id: unlock.achievement_id,
          }),
          nowIso(),
          nowIso(),
        )
        .run();
    } else if (outbox.status === "failed") {
      await ctx.db
        .prepare(
          "UPDATE fb_outbox SET status = 'pending', attempts = 0, available_at = ?, last_error = NULL WHERE id = ? AND tenant_id = ?",
        )
        .bind(nowIso(), outbox.id, ctx.tenant.id)
        .run();
    } else if (outbox.status === "delivered") {
      notificationState = "sent";
    }
  }

  await ctx.db
    .prepare(
      "UPDATE fb_achievement_unlocks SET reward_state = ?, reward_ledger_id = ?, notification_state = ? WHERE id = ? AND tenant_id = ?",
    )
    .bind(rewardState, rewardLedgerId, notificationState, unlock.id, ctx.tenant.id)
    .run();
  return { rewardState, notificationState };
}

export function finishKey(
  material: string,
  effect: string | null | undefined,
): "plain" | "silver" | "gold" | "holographic" | "other" {
  if (effect === "holographic" || material === "diamond") return "holographic";
  if (material === "silver") return "silver";
  if (material === "gold") return "gold";
  if (material === "plain") return "plain";
  return "other";
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function criteriaTarget(criteria: Record<string, unknown>): number {
  const target = Number(criteria.target ?? 1);
  return Number.isFinite(target) && target > 0 ? Math.floor(target) : 1;
}

/**
 * Computes progress from committed inventory and events. Milestones use
 * lifetime copies (traded or recycled copies still count as "ever collected");
 * collection completion is evaluated against the release roster recorded in
 * the definition, so adding later cards cannot revoke an earned version.
 */
export async function evaluateAchievements(
  ctx: Ctx,
  input: { userId?: string; eventId?: string; notify?: boolean } = {},
): Promise<{ evaluated: number; unlocked: AchievementView[] }> {
  const user = ctx.user;
  const userId = input.userId ?? user?.id;
  if (!userId)
    throw new ApiError(401, "authentication_required", "Sign in to evaluate achievements.");
  if (
    input.userId &&
    input.userId !== user?.id &&
    !user?.platformAdmin &&
    !["owner", "editor"].includes(user?.role ?? "")
  ) {
    throw new ApiError(
      403,
      "insufficient_role",
      "You cannot evaluate another member's achievements.",
    );
  }

  const definitions = await all<AchievementDefinition>(
    ctx.db,
    `SELECT * FROM fb_achievement_definitions
      WHERE status = 'active' AND archived_at IS NULL AND (scope = 'platform' OR (scope = 'bot' AND tenant_id = ?))
      ORDER BY sort, name`,
    ctx.tenant.id,
  );

  const [uniqueCards, owned, finishRows, explored] = await Promise.all([
    first<{ count: number }>(
      ctx.db,
      "SELECT COUNT(DISTINCT card_id) AS count FROM fb_card_instances WHERE tenant_id = ? AND user_id = ?",
      ctx.tenant.id,
      userId,
    ),
    all<{ card_id: string; material_key: string; effect_key: string | null }>(
      ctx.db,
      `SELECT ci.card_id, m.key AS material_key, fx.key AS effect_key
         FROM fb_card_instances ci
         JOIN fb_variants v ON v.id = ci.variant_id
         JOIN fb_materials m ON m.id = v.material_id
         LEFT JOIN fb_effects fx ON fx.id = v.effect_id
        WHERE ci.tenant_id = ? AND ci.user_id = ?`,
      ctx.tenant.id,
      userId,
    ),
    all<{ card_id: string; material_key: string; effect_key: string | null }>(
      ctx.db,
      `SELECT ci.card_id, m.key AS material_key, fx.key AS effect_key
         FROM fb_card_instances ci
         JOIN fb_variants v ON v.id = ci.variant_id
         JOIN fb_materials m ON m.id = v.material_id
         LEFT JOIN fb_effects fx ON fx.id = v.effect_id
        WHERE ci.tenant_id = ? AND ci.user_id = ? AND ci.status IN ('owned','reserved')`,
      ctx.tenant.id,
      userId,
    ),
    first<{ count: number }>(
      ctx.db,
      `SELECT COUNT(DISTINCT object_id) AS count FROM fb_domain_events
        WHERE tenant_id = ? AND user_id = ? AND event_type = 'collection.explored'`,
      ctx.tenant.id,
      userId,
    ),
  ]);

  const finishByCard = new Map<string, Set<string>>();
  for (const row of finishRows) {
    const key = finishKey(row.material_key, row.effect_key);
    if (!finishByCard.has(row.card_id)) finishByCard.set(row.card_id, new Set());
    finishByCard.get(row.card_id)!.add(key);
  }

  const collectionCounts = new Map<string, number>();
  const collectionCards = await all<{ collection_id: string; card_id: string }>(
    ctx.db,
    `SELECT DISTINCT cc.collection_id, ci.card_id
       FROM fb_card_instances ci
       JOIN fb_collection_cards cc ON cc.card_id = ci.card_id
      WHERE ci.tenant_id = ? AND ci.user_id = ?`,
    ctx.tenant.id,
    userId,
  );
  for (const row of collectionCards) {
    collectionCounts.set(row.collection_id, (collectionCounts.get(row.collection_id) ?? 0) + 1);
  }

  const unlocked: AchievementView[] = [];
  for (const definition of definitions) {
    const criteria = parseJson<Record<string, unknown>>(definition.criteria_json, {});
    const reward = parseJson<Record<string, unknown>>(definition.reward_json, {});
    const type = String(criteria.type ?? "");
    let progress = 0;
    let target = criteriaTarget(criteria);
    if (type === "unique_cards") {
      progress = uniqueCards?.count ?? 0;
    } else if (type === "finish_first") {
      const materials = Array.isArray(criteria.materials) ? (criteria.materials as string[]) : [];
      progress = owned.some((row) => {
        const key = finishKey(row.material_key, row.effect_key);
        return materials.some((material) => key === finishKey(material, null));
      })
        ? 1
        : 0;
      target = 1;
    } else if (type === "finish_set") {
      let complete = 0;
      for (const set of finishByCard.values()) {
        if (set.has("plain") && set.has("silver") && set.has("gold") && set.has("holographic"))
          complete += 1;
      }
      progress = complete;
      target = 1;
    } else if (type === "collection_complete") {
      const collectionId = String(criteria.collection_id ?? "");
      const roster = Array.isArray(criteria.roster_card_ids)
        ? criteria.roster_card_ids.map((id) => String(id)).filter(Boolean)
        : [];
      if (roster.length) {
        // The definition carries the release roster snapshot. Adding or removing
        // a card in the live collection cannot move this version's boundary.
        const ownedCards = new Set(owned.map((row) => row.card_id));
        progress = roster.filter((id) => ownedCards.has(id)).length;
        target = roster.length;
      } else {
        const recordedTarget = Number(criteria.target ?? 0);
        target = recordedTarget > 0 ? recordedTarget : criteriaTarget(criteria);
        progress = collectionCounts.get(collectionId) ?? 0;
      }
    } else if (type === "collection_unique") {
      const collectionId = String(criteria.collection_id ?? "");
      const roster = Array.isArray(criteria.roster_card_ids)
        ? criteria.roster_card_ids.map((id) => String(id)).filter(Boolean)
        : [];
      if (roster.length) {
        const ownedCards = new Set(owned.map((row) => row.card_id));
        progress = roster.filter((id) => ownedCards.has(id)).length;
      } else {
        progress = collectionCounts.get(collectionId) ?? 0;
      }
    } else if (type === "explore_collections") {
      progress = explored?.count ?? 0;
    } else if (type === "gift_received") {
      const row = await first<{ count: number }>(
        ctx.db,
        "SELECT COUNT(*) AS count FROM fb_gift_awards WHERE tenant_id = ? AND user_id = ? AND status = 'delivered'",
        ctx.tenant.id,
        userId,
      );
      progress = row?.count ?? 0;
      target = 1;
    } else {
      continue;
    }

    const state: AchievementProgress["state"] =
      progress >= target ? "earned" : progress > 0 ? "in_progress" : "locked";
    const now = nowIso();
    await ctx.db
      .prepare(
        `INSERT INTO fb_achievement_progress (tenant_id, user_id, achievement_id, achievement_version, progress, target, state, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, user_id, achievement_id, achievement_version) DO UPDATE SET
           progress = MAX(fb_achievement_progress.progress, excluded.progress),
           target = excluded.target,
           state = CASE WHEN fb_achievement_progress.state = 'earned' THEN 'earned' ELSE excluded.state END,
           updated_at = excluded.updated_at`,
      )
      .bind(ctx.tenant.id, userId, definition.id, definition.version, progress, target, state, now)
      .run();

    const existing = await first<{
      id: string;
      user_id: string;
      achievement_id: string;
      achievement_version: number;
      earned_at: string;
      reward_state: string;
      reward_amount: number;
      reward_ledger_id: string | null;
      notification_state: string;
    }>(
      ctx.db,
      "SELECT id, user_id, achievement_id, achievement_version, earned_at, reward_state, reward_amount, reward_ledger_id, notification_state FROM fb_achievement_unlocks WHERE tenant_id = ? AND user_id = ? AND achievement_id = ? AND achievement_version = ?",
      ctx.tenant.id,
      userId,
      definition.id,
      definition.version,
    );
    if (existing) {
      // An entitlement is permanent once earned. Fulfilment is retried even if
      // the player has since traded, recycled or lost the qualifying card.
      const fulfilled = await fulfilAchievementReward(ctx, existing, definition);
      unlocked.push(
        toView(
          definition,
          criteria,
          reward,
          { progress: Math.max(progress, target), target, state: "earned" },
          existing.earned_at,
          existing.reward_amount,
          fulfilled.rewardState,
          fulfilled.notificationState,
        ),
      );
      continue;
    }

    if (state !== "earned") continue;

    const unlockId = newId("unl");
    const rewardAmount = Math.max(0, Math.floor(Number(reward.foil ?? 0)));
    try {
      await ctx.db
        .prepare(
          `INSERT INTO fb_achievement_unlocks
            (id, tenant_id, user_id, achievement_id, achievement_version, event_id, earned_at, reward_state, reward_amount, notification_state, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        )
        .bind(
          unlockId,
          ctx.tenant.id,
          userId,
          definition.id,
          definition.version,
          input.eventId ?? null,
          now,
          rewardAmount > 0 ? "pending" : "none",
          rewardAmount,
          now,
        )
        .run();
    } catch (error) {
      if (!String(error).includes("UNIQUE")) throw error;
      continue;
    }

    const fulfilled = await fulfilAchievementReward(
      ctx,
      {
        id: unlockId,
        user_id: userId,
        achievement_id: definition.id,
        achievement_version: definition.version,
        reward_state: rewardAmount > 0 ? "pending" : "none",
        reward_amount: rewardAmount,
        reward_ledger_id: null,
        notification_state: input.notify === false ? "suppressed" : "pending",
      },
      definition,
    );
    await ctx.db.batch([
      auditStatement(ctx, "achievement.earned", "achievement_unlock", unlockId, {
        achievement_id: definition.id,
        achievement_key: definition.key,
        version: definition.version,
        reward_amount: rewardAmount,
        reward_state: fulfilled.rewardState,
        notification_state: fulfilled.notificationState,
      }),
    ]);
    unlocked.push(
      toView(
        definition,
        criteria,
        reward,
        { progress, target, state },
        now,
        rewardAmount,
        fulfilled.rewardState,
        fulfilled.notificationState,
      ),
    );
  }

  return { evaluated: definitions.length, unlocked };
}

function toView(
  definition: AchievementDefinition,
  criteria: Record<string, unknown>,
  reward: Record<string, unknown>,
  progress: AchievementProgress,
  earnedAt: string | null,
  rewardAmount: number,
  rewardState: string | null,
  notificationState: string | null,
): AchievementView {
  return {
    ...definition,
    criteria,
    reward,
    progress: progress.progress,
    target: progress.target,
    state: progress.state,
    earned_at: earnedAt,
    reward_amount: rewardAmount,
    reward_state: rewardState,
    notification_state: notificationState,
  };
}

export async function listAchievements(ctx: Ctx, userId?: string): Promise<AchievementView[]> {
  const targetUserId = userId ?? ctx.user?.id ?? null;
  const definitions = await all<AchievementDefinition>(
    ctx.db,
    `SELECT * FROM fb_achievement_definitions
      WHERE status = 'active' AND archived_at IS NULL AND (scope = 'platform' OR (scope = 'bot' AND tenant_id = ?))
      ORDER BY sort, name`,
    ctx.tenant.id,
  );
  // Achievement names, criteria and progress must not reveal a collection the
  // viewer cannot enter. Collection-linked definitions inherit that
  // collection's audience; anonymous viewers never receive member-only badges.
  const visibleCollections = await visibleCollectionIds(ctx);
  const visible = definitions.filter((definition) => {
    const criteria = parseJson<Record<string, unknown>>(definition.criteria_json, {});
    const collectionId = typeof criteria.collection_id === "string" ? criteria.collection_id : "";
    if (collectionId && !visibleCollections.has(collectionId)) return false;
    if (definition.visibility === "private") {
      return targetUserId === ctx.user?.id || Boolean(ctx.user?.platformAdmin);
    }
    if (definition.visibility === "public") return true;
    return Boolean(ctx.user);
  });
  if (!targetUserId) {
    return visible.map((definition) => {
      const criteria = parseJson<Record<string, unknown>>(definition.criteria_json, {});
      const reward = parseJson<Record<string, unknown>>(definition.reward_json, {});
      return toView(
        definition,
        criteria,
        reward,
        { progress: 0, target: criteriaTarget(criteria), state: "locked" },
        null,
        0,
        null,
        null,
      );
    });
  }
  const progressRows = await all<{
    achievement_id: string;
    achievement_version: number;
    progress: number;
    target: number;
    state: "locked" | "in_progress" | "earned";
  }>(
    ctx.db,
    "SELECT achievement_id, achievement_version, progress, target, state FROM fb_achievement_progress WHERE tenant_id = ? AND user_id = ?",
    ctx.tenant.id,
    targetUserId,
  );
  const unlocks = await all<{
    achievement_id: string;
    achievement_version: number;
    earned_at: string;
    reward_state: string;
    reward_amount: number;
    notification_state: string;
  }>(
    ctx.db,
    "SELECT achievement_id, achievement_version, earned_at, reward_state, reward_amount, notification_state FROM fb_achievement_unlocks WHERE tenant_id = ? AND user_id = ?",
    ctx.tenant.id,
    targetUserId,
  );
  const progressMap = new Map(
    progressRows.map((row) => [`${row.achievement_id}:${row.achievement_version}`, row]),
  );
  const unlockMap = new Map(
    unlocks.map((row) => [`${row.achievement_id}:${row.achievement_version}`, row]),
  );
  return visible.map((definition) => {
    const criteria = parseJson<Record<string, unknown>>(definition.criteria_json, {});
    const reward = parseJson<Record<string, unknown>>(definition.reward_json, {});
    const key = `${definition.id}:${definition.version}`;
    const progress = progressMap.get(key);
    const unlock = unlockMap.get(key);
    return toView(
      definition,
      criteria,
      reward,
      {
        progress: progress?.progress ?? 0,
        target: progress?.target ?? criteriaTarget(criteria),
        state: unlock ? "earned" : (progress?.state ?? "locked"),
      },
      unlock?.earned_at ?? null,
      unlock?.reward_amount ?? 0,
      unlock?.reward_state ?? null,
      unlock?.notification_state ?? null,
    );
  });
}

export async function recordCollectionExploration(ctx: Ctx, collectionId: string): Promise<void> {
  const user = ctx.user;
  if (!user) return;
  const now = nowIso();
  await ctx.db
    .prepare(
      `INSERT INTO fb_domain_events (id, tenant_id, user_id, event_type, object_type, object_id, dedupe_key, payload_json, created_at)
       VALUES (?, ?, ?, 'collection.explored', 'collection', ?, ?, '{}', ?)
       ON CONFLICT(tenant_id, dedupe_key) DO NOTHING`,
    )
    .bind(
      newId("evt"),
      ctx.tenant.id,
      user.id,
      collectionId,
      `explore:${user.id}:${collectionId}`,
      now,
    )
    .run()
    .catch(() => undefined);
}

export async function recordDomainEvent(
  ctx: Ctx,
  input: {
    type: string;
    objectType: string;
    objectId: string;
    dedupeKey: string;
    userId?: string | null;
    payload?: Record<string, unknown>;
  },
): Promise<string> {
  const id = newId("evt");
  await ctx.db
    .prepare(
      `INSERT INTO fb_domain_events (id, tenant_id, user_id, event_type, object_type, object_id, dedupe_key, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, dedupe_key) DO NOTHING`,
    )
    .bind(
      id,
      ctx.tenant.id,
      input.userId ?? ctx.user?.id ?? null,
      input.type,
      input.objectType,
      input.objectId,
      input.dedupeKey,
      JSON.stringify(input.payload ?? {}),
      nowIso(),
    )
    .run();
  const row = await first<{ id: string }>(
    ctx.db,
    "SELECT id FROM fb_domain_events WHERE tenant_id = ? AND dedupe_key = ?",
    ctx.tenant.id,
    input.dedupeKey,
  );
  return row?.id ?? id;
}

export async function createAchievement(
  ctx: Ctx,
  input: {
    scope: "platform" | "bot";
    key: string;
    name: string;
    description: string;
    criteria: Record<string, unknown>;
    reward?: Record<string, unknown>;
    visibility?: "public" | "member" | "private";
    artKey?: string;
    category?: string;
  },
) {
  const user = ctx.user!;
  if (input.scope === "platform") {
    requireSuperAdminContent(ctx);
  }
  if (input.scope === "bot" && user.role !== "owner" && !["owner", "editor"].includes(user.role)) {
    throw new ApiError(
      403,
      "insufficient_role",
      "Only the Bot Owner or an editor can create Bot achievements.",
    );
  }
  const now = nowIso();
  const id = newId("ach");
  const version =
    (
      await first<{ version: number }>(
        ctx.db,
        "SELECT COALESCE(MAX(version), 0) + 1 AS version FROM fb_achievement_definitions WHERE scope = ? AND COALESCE(tenant_id, '') = ? AND key = ?",
        input.scope,
        input.scope === "platform" ? "" : ctx.tenant.id,
        input.key,
      )
    )?.version ?? 1;
  await ctx.db
    .prepare(
      `INSERT INTO fb_achievement_definitions
        (id, scope, tenant_id, key, version, name, description, criteria_json, reward_json, visibility, art_key, category, sort, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 999, 'active', ?, ?, ?)`,
    )
    .bind(
      id,
      input.scope,
      input.scope === "bot" ? ctx.tenant.id : null,
      input.key,
      version,
      input.name,
      input.description,
      JSON.stringify(input.criteria),
      JSON.stringify(input.reward ?? {}),
      input.visibility ?? "member",
      input.artKey ?? "medal-generic",
      input.category ?? "collection",
      user.id,
      now,
      now,
    )
    .run();
  await auditStatement(ctx, "achievement.created", "achievement", id, {
    key: input.key,
    version,
  }).run();
  return id;
}

/**
 * Resumable, idempotent backfill. Every unlock and reward credit is unique, so
 * running this again after a crash cannot double-award. Backfills suppress
 * notification spam; earned dates are the evaluation time.
 */
export async function backfillAchievements(ctx: Ctx, limit = 500, offset = 0) {
  const pageSize = Math.min(2000, Math.max(1, limit));
  const start = Math.max(0, offset);
  const users = await all<{ user_id: string }>(
    ctx.db,
    `SELECT DISTINCT user_id FROM fb_memberships
      WHERE tenant_id = ? AND status = 'active' AND revoked_at IS NULL
      ORDER BY user_id LIMIT ? OFFSET ?`,
    ctx.tenant.id,
    pageSize,
    start,
  );
  let evaluated = 0;
  let unlocked = 0;
  for (const user of users) {
    const result = await evaluateAchievements(ctx, { userId: user.user_id, notify: false });
    evaluated += result.evaluated;
    unlocked += result.unlocked.length;
  }
  // The caller advances `next_offset` until `done`; this prevents a repeated
  // first-page backfill from silently leaving later members unevaluated.
  return {
    members: users.length,
    evaluated,
    unlocked,
    offset: start,
    next_offset: start + users.length,
    done: users.length < pageSize,
  };
}
