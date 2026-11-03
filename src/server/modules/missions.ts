import { ApiError, checkRateLimit, type Ctx } from "../context";
import { all, first, nowIso } from "../db";
import { newId } from "../ids";
import { auditStatement } from "../http";

export interface MissionDefinition {
  key: string;
  version: number;
  title: string;
  description: string;
  eventTypes: string[];
  target: number;
  reward: number;
  href: string;
  action: string;
}

/**
 * A deliberately small, curated catalogue. Definitions are code-versioned; the
 * period/definition version is snapshotted into the claim key so a later deploy
 * cannot move the goalposts for an in-flight day. No generative prompts and no
 * new economy service.
 */
export const DAILY_MISSION_CATALOGUE: MissionDefinition[] = [
  {
    key: "explore",
    version: 1,
    title: "Visit a world",
    description: "Open any collection you can access and look around.",
    eventTypes: ["collection.explored"],
    target: 1,
    reward: 60,
    href: "/play/collections",
    action: "Browse worlds",
  },
  {
    key: "inspect",
    version: 1,
    title: "Inspect a card",
    description: "Open one of your cards and look at both faces.",
    eventTypes: ["card.inspected"],
    target: 1,
    reward: 60,
    href: "/play/collection",
    action: "Open my cards",
  },
  {
    key: "open",
    version: 1,
    title: "Open a capsule",
    description: "Complete one intentional eligible opening at the ordinary price.",
    eventTypes: ["card.drawn"],
    target: 1,
    reward: 60,
    href: "/play/draw",
    action: "Open a capsule",
  },
  {
    key: "favourite",
    version: 1,
    title: "Choose a favourite",
    description: "Mark one card you want to keep close.",
    eventTypes: ["card.favourited"],
    target: 1,
    reward: 40,
    href: "/play/collection",
    action: "Choose a favourite",
  },
];

export const DAILY_MISSION_CAP = 180;

export function utcDayKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function nextUtcReset(date = new Date()): string {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1, 0, 0, 0, 0),
  ).toISOString();
}

function periodKey(date = new Date()): string {
  return `mission:${utcDayKey(date)}`;
}

function periodStart(date = new Date()): string {
  return `${utcDayKey(date)}T00:00:00.000Z`;
}

export interface DailyMissionState {
  period_key: string;
  day: string;
  reset_at: string;
  reset_local: string;
  cap: number;
  earned_today: number;
  missions: Array<
    MissionDefinition & {
      progress: number;
      complete: boolean;
      claimed: boolean;
      claimable: boolean;
      claimed_at: string | null;
    }
  >;
}

async function inventorySummary(ctx: Ctx, userId: string) {
  const [owned, balance, cheapest] = await Promise.all([
    first<{ cards: number }>(
      ctx.db,
      "SELECT COUNT(DISTINCT card_id) AS cards FROM fb_card_instances WHERE tenant_id = ? AND user_id = ? AND status IN ('owned','reserved')",
      ctx.tenant.id,
      userId,
    ),
    first<{ balance: number }>(
      ctx.db,
      "SELECT balance FROM fb_wallets WHERE tenant_id = ? AND user_id = ?",
      ctx.tenant.id,
      userId,
    ),
    first<{ price: number }>(
      ctx.db,
      "SELECT MIN(price) AS price FROM fb_pools WHERE tenant_id = ? AND status = 'active'",
      ctx.tenant.id,
    ),
  ]);
  return {
    cards: owned?.cards ?? 0,
    balance: balance?.balance ?? 0,
    cheapestPrice: cheapest?.price ?? 80,
  };
}

function selectedKeys(input: { cards: number; balance: number; cheapestPrice: number }): string[] {
  const keys = ["explore"];
  if (input.cards > 0) keys.push("inspect");
  if (input.balance >= input.cheapestPrice) keys.push("open");
  if (keys.length < 3 && input.cards > 0) keys.push("favourite");
  if (keys.length < 3 && input.balance >= input.cheapestPrice) keys.push("open");
  return [...new Set(keys)].slice(0, 3);
}

export async function getDailyMissions(ctx: Ctx): Promise<DailyMissionState> {
  const user = ctx.user;
  if (!user) throw new ApiError(401, "authentication_required", "Sign in to see today's missions.");
  if (user.synthetic) throw new ApiError(403, "synthetic_mission_blocked", "NPC collectors do not receive human daily missions.");
  const now = new Date();
  const day = utcDayKey(now);
  const pkey = periodKey(now);
  const start = periodStart(now);
  const summary = await inventorySummary(ctx, user.id);
  const keys = selectedKeys(summary);
  let assigned = await all<{
    mission_key: string;
    version: number;
    target: number;
    reward: number;
    definition_json: string;
  }>(
    ctx.db,
    "SELECT mission_key, version, target, reward, definition_json FROM fb_mission_assignments WHERE tenant_id = ? AND user_id = ? AND period_key = ? ORDER BY mission_key",
    ctx.tenant.id,
    user.id,
    pkey,
  );
  if (assigned.length === 0) {
    const chosen = keys
      .map((key) => DAILY_MISSION_CATALOGUE.find((mission) => mission.key === key))
      .filter((mission): mission is MissionDefinition => Boolean(mission));
    const now = nowIso();
    await ctx.db.batch(
      chosen.map((mission) =>
        ctx.db
          .prepare(
            `INSERT INTO fb_mission_assignments
              (tenant_id, user_id, period_key, mission_key, version, target, reward, definition_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(tenant_id, user_id, period_key, mission_key) DO NOTHING`,
          )
          .bind(
            ctx.tenant.id,
            user.id,
            pkey,
            mission.key,
            mission.version,
            mission.target,
            mission.reward,
            JSON.stringify(mission),
            now,
          ),
      ),
    );
    assigned = await all<{
      mission_key: string;
      version: number;
      target: number;
      reward: number;
      definition_json: string;
    }>(
      ctx.db,
      "SELECT mission_key, version, target, reward, definition_json FROM fb_mission_assignments WHERE tenant_id = ? AND user_id = ? AND period_key = ? ORDER BY mission_key",
      ctx.tenant.id,
      user.id,
      pkey,
    );
  }
  const definitions = assigned
    .map((row) => {
      try {
        const parsed = JSON.parse(row.definition_json) as MissionDefinition;
        return { ...parsed, version: row.version, target: row.target, reward: row.reward };
      } catch {
        return null;
      }
    })
    .filter((mission): mission is MissionDefinition => Boolean(mission));
  const eventTypes = [...new Set(definitions.flatMap((mission) => mission.eventTypes))];
  const [events, claims] = await Promise.all([
    eventTypes.length
      ? ctx.db
          .prepare(
            `SELECT event_type, COUNT(*) AS count FROM fb_domain_events
              WHERE tenant_id = ? AND user_id = ? AND created_at >= ? AND event_type IN (${eventTypes.map(() => "?").join(",")})
              GROUP BY event_type`,
          )
          .bind(ctx.tenant.id, user.id, start, ...eventTypes)
          .all<{ event_type: string; count: number }>()
          .then((result) => result.results ?? [])
      : Promise.resolve([]),
    ctx.db
      .prepare(
        "SELECT rule_key, amount, created_at FROM fb_reward_claims WHERE tenant_id = ? AND user_id = ? AND period_key = ? AND rule_key LIKE 'mission:%'",
      )
      .bind(ctx.tenant.id, user.id, pkey)
      .all<{ rule_key: string; amount: number; created_at: string }>()
      .then((result) => result.results ?? []),
  ]);
  const progress = new Map(events.map((row) => [row.event_type, row.count]));
  const claimMap = new Map(claims.map((row) => [row.rule_key, row]));
  const missions = definitions.map((mission) => {
    const count = Math.max(...mission.eventTypes.map((eventType) => progress.get(eventType) ?? 0));
    const progressValue = Math.min(mission.target, count);
    const claim = claimMap.get(`${pkey}:${mission.key}`);
    return {
      ...mission,
      progress: progressValue,
      complete: progressValue >= mission.target,
      claimed: Boolean(claim),
      claimable: progressValue >= mission.target && !claim,
      claimed_at: claim?.created_at ?? null,
    };
  });
  return {
    period_key: pkey,
    day,
    reset_at: nextUtcReset(now),
    reset_local: `${new Intl.DateTimeFormat("en-AU", {
      timeZone: "Australia/Melbourne",
      dateStyle: "full",
      timeStyle: "short",
    }).format(new Date(nextUtcReset(now)))} Melbourne time`,
    cap: DAILY_MISSION_CAP,
    earned_today: claims.reduce((sum, row) => sum + row.amount, 0),
    missions,
  };
}

export async function claimDailyMission(ctx: Ctx, key: string, idempotencyKey?: string) {
  const user = ctx.user;
  if (!user) throw new ApiError(401, "authentication_required", "Sign in to claim a mission.");
  if (user.synthetic) throw new ApiError(403, "synthetic_mission_blocked", "NPC collectors do not receive human daily missions.");
  await checkRateLimit(ctx.db, `mission-claim:${ctx.tenant.id}:${user.id}`, 20, 3600);
  const state = await getDailyMissions(ctx);
  const mission = state.missions.find((item) => item.key === key);
  if (!mission) throw new ApiError(404, "mission_not_assigned", "That mission is not part of today's assignment.");
  const existing = await first<{ id: string; amount: number; created_at: string }>(
    ctx.db,
    "SELECT id, amount, created_at FROM fb_reward_claims WHERE tenant_id = ? AND user_id = ? AND rule_key = ? AND period_key = ?",
    ctx.tenant.id,
    user.id,
    `${state.period_key}:${mission.key}`,
    state.period_key,
  );
  if (existing) {
    const wallet = await first<{ balance: number }>(
      ctx.db,
      "SELECT balance FROM fb_wallets WHERE tenant_id = ? AND user_id = ?",
      ctx.tenant.id,
      user.id,
    );
    return {
      replayed: true,
      claim_id: existing.id,
      amount: existing.amount,
      balance_after: wallet?.balance ?? 0,
      period_key: state.period_key,
      mission_key: mission.key,
      claimed_at: existing.created_at,
    };
  }
  if (!mission.complete) {
    throw new ApiError(409, "mission_incomplete", "That mission is not complete yet. Nothing was credited.", {
      progress: mission.progress,
      target: mission.target,
    });
  }
  const claimId = newId("rwd");
  const now = nowIso();
  try {
    await ctx.db.batch([
      ctx.db
        .prepare(
          "INSERT INTO fb_reward_claims (id, tenant_id, user_id, rule_key, rule_version, period_key, amount, created_at, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(claimId, ctx.tenant.id, user.id, `${state.period_key}:${mission.key}`, mission.version, state.period_key, mission.reward, now, `mission:${state.period_key}:${mission.key}`),
      auditStatement(ctx, "mission.claimed", "daily_mission", mission.key, {
        amount: mission.reward,
        period_key: state.period_key,
        version: mission.version,
      }),
    ]);
  } catch (error) {
    if (String(error).includes("UNIQUE") || String(error).includes("reward_cooldown")) {
      const replay = await first<{ id: string; amount: number; created_at: string }>(
        ctx.db,
        "SELECT id, amount, created_at FROM fb_reward_claims WHERE tenant_id = ? AND user_id = ? AND rule_key = ? AND period_key = ?",
        ctx.tenant.id,
        user.id,
        `${state.period_key}:${mission.key}`,
        state.period_key,
      );
      if (replay) {
        const replayWallet = await first<{ balance: number }>(
          ctx.db,
          "SELECT balance FROM fb_wallets WHERE tenant_id = ? AND user_id = ?",
          ctx.tenant.id,
          user.id,
        );
        return {
          replayed: true,
          claim_id: replay.id,
          amount: replay.amount,
          balance_after: replayWallet?.balance ?? 0,
          period_key: state.period_key,
          mission_key: mission.key,
          claimed_at: replay.created_at,
        };
      }
    }
    throw error;
  }
  const wallet = await first<{ balance: number }>(
    ctx.db,
    "SELECT balance FROM fb_wallets WHERE tenant_id = ? AND user_id = ?",
    ctx.tenant.id,
    user.id,
  );
  return {
    replayed: false,
    claim_id: claimId,
    amount: mission.reward,
    balance_after: wallet?.balance ?? 0,
    currency: { name: "Foil", symbol: "✦" },
    period_key: state.period_key,
    mission_key: mission.key,
    claimed_at: now,
  };
}

/**
 * A deliberate once-per-UTC-day interaction event. This is not a wallet award
 * and cannot be claimed in the same request; it only advances a mission.
 */
export async function recordDailyInteraction(
  ctx: Ctx,
  eventType: "card.inspected" | "card.favourited",
  objectId: string,
): Promise<void> {
  const user = ctx.user;
  if (!user || ctx.actor.type !== "user" || user.synthetic) return;
  const { recordDomainEvent } = await import("./achievements");
  await recordDomainEvent(ctx, {
    type: eventType,
    objectType: "card",
    objectId,
    dedupeKey: `${eventType}:${user.id}:${utcDayKey()}`,
    userId: user.id,
  });
}
