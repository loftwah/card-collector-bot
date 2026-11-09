import { ApiError, checkRateLimit, type Ctx } from "../context";
import { all, first, nowIso } from "../db";
import { newId } from "../ids";
import { auditStatement } from "../http";
import { liveHumanCollectionSelection } from "./discord-installation-settings";

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
    description: "Explore a world you can access, then record your visit.",
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
  currency_symbol: string;
  missions: Array<
    MissionDefinition & {
      progress: number;
      complete: boolean;
      claimed: boolean;
      claimable: boolean;
      cap_reached: boolean;
      claimed_at: string | null;
    }
  >;
}

async function inventorySummary(ctx: Ctx, userId: string, authority: ReturnType<typeof missionClaimAuthority>) {
  const [owned, balance, cheapest] = await Promise.all([
    first<{ cards: number }>(
      ctx.db,
      `SELECT COUNT(DISTINCT card_id) AS cards FROM fb_card_instances WHERE tenant_id = ? AND user_id = ? AND status IN ('owned','reserved') AND ${authority.sql}`,
      ctx.tenant.id,
      userId,
      ...authority.args,
    ),
    first<{ balance: number }>(
      ctx.db,
      `SELECT balance FROM fb_wallets WHERE tenant_id = ? AND user_id = ? AND ${authority.sql}`,
      ctx.tenant.id,
      userId,
      ...authority.args,
    ),
    first<{ price: number }>(
      ctx.db,
      `SELECT MIN(price) AS price FROM fb_pools WHERE tenant_id = ? AND status = 'active' AND ${authority.sql}`,
      ctx.tenant.id,
      ...authority.args,
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

export async function getDailyMissions(ctx: Ctx, scope: 'missions:read'|'missions:claim' = 'missions:read'): Promise<DailyMissionState> {
  const user = ctx.user;
  if (!user) throw new ApiError(401, "authentication_required", "Sign in to see today's missions.");
  if (user.synthetic) throw new ApiError(403, "synthetic_mission_blocked", "NPC collectors do not receive human daily missions.");
  const authority=missionClaimAuthority(ctx,scope);
  if (!await first<{ok:number}>(ctx.db,`SELECT 1 AS ok WHERE ${authority.sql}`,...authority.args))
    throw new ApiError(403,'mission_access_changed','Your mission access changed. Sign in again.');
  const now = new Date();
  const day = utcDayKey(now);
  const pkey = periodKey(now);
  const start = periodStart(now);
  const summary = await inventorySummary(ctx, user.id, authority);
  const keys = selectedKeys(summary);
  let assigned = await all<{
    mission_key: string;
    version: number;
    target: number;
    reward: number;
    definition_json: string;
  }>(
    ctx.db,
    `SELECT mission_key, version, target, reward, definition_json FROM fb_mission_assignments WHERE tenant_id = ? AND user_id = ? AND period_key = ? AND ${authority.sql} ORDER BY mission_key`,
    ctx.tenant.id,
    user.id,
    pkey,
    ...authority.args,
  );
  if (assigned.length === 0) {
    const chosen = keys
      .map((key) => DAILY_MISSION_CATALOGUE.find((mission) => mission.key === key))
      .filter((mission): mission is MissionDefinition => Boolean(mission));
    const now = nowIso();
    // Select the whole first assignment in one statement. Per-key conflicts
    // can merge two different concurrent choices and exceed the daily cap.
    await ctx.db.batch([
      ctx.db.prepare(`INSERT INTO fb_mission_assignments
        (tenant_id,user_id,period_key,mission_key,version,target,reward,definition_json,created_at)
        SELECT ?,?,?,json_extract(value,'$.key'),json_extract(value,'$.version'),json_extract(value,'$.target'),
          json_extract(value,'$.reward'),json(value),? FROM json_each(?)
        WHERE NOT EXISTS (SELECT 1 FROM fb_mission_assignments WHERE tenant_id=? AND user_id=? AND period_key=?) AND ${authority.sql}`)
        .bind(ctx.tenant.id,user.id,pkey,now,JSON.stringify(chosen),ctx.tenant.id,user.id,pkey,...authority.args),
    ]);
    assigned = await all<{
      mission_key: string;
      version: number;
      target: number;
      reward: number;
      definition_json: string;
    }>(
      ctx.db,
      `SELECT mission_key, version, target, reward, definition_json FROM fb_mission_assignments WHERE tenant_id = ? AND user_id = ? AND period_key = ? AND ${authority.sql} ORDER BY mission_key`,
      ctx.tenant.id,
      user.id,
      pkey,
      ...authority.args,
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
  const economy = await first<{ currency_symbol: string }>(
    ctx.db,
    `SELECT currency_symbol FROM fb_economy_settings WHERE tenant_id = ? AND ${authority.sql}`,
    ctx.tenant.id,
    ...authority.args,
  );
  const [events, claims] = await Promise.all([
    eventTypes.length
      ? ctx.db
          .prepare(
            `SELECT event_type, COUNT(*) AS count FROM fb_domain_events
              WHERE tenant_id = ? AND user_id = ? AND created_at >= ? AND event_type IN (${eventTypes.map(() => "?").join(",")}) AND ${authority.sql}
              GROUP BY event_type`,
          )
          .bind(ctx.tenant.id, user.id, start, ...eventTypes, ...authority.args)
          .all<{ event_type: string; count: number }>()
          .then((result) => result.results ?? [])
      : Promise.resolve([]),
    ctx.db
      .prepare(
        `SELECT rule_key, amount, created_at FROM fb_reward_claims WHERE tenant_id = ? AND user_id = ? AND period_key = ? AND rule_key LIKE 'mission:%' AND ${authority.sql}`,
      )
      .bind(ctx.tenant.id, user.id, pkey, ...authority.args)
      .all<{ rule_key: string; amount: number; created_at: string }>()
      .then((result) => result.results ?? []),
  ]);
  if (!await first<{ok:number}>(ctx.db,`SELECT 1 AS ok WHERE ${authority.sql}`,...authority.args))
    throw new ApiError(403,'mission_access_changed','Your mission access changed. Sign in again.');
  const progress = new Map(events.map((row) => [row.event_type, row.count]));
  const claimMap = new Map(claims.map((row) => [row.rule_key, row]));
  const earnedToday = claims.reduce((sum, row) => sum + row.amount, 0);
  const missions = definitions.map((mission) => {
    const count = Math.max(...mission.eventTypes.map((eventType) => progress.get(eventType) ?? 0));
    const progressValue = Math.min(mission.target, count);
    const claim = claimMap.get(`${pkey}:${mission.key}`);
    return {
      ...mission,
      progress: progressValue,
      complete: progressValue >= mission.target,
      claimed: Boolean(claim),
      claimable: progressValue >= mission.target && !claim && earnedToday + mission.reward <= DAILY_MISSION_CAP,
      cap_reached: !claim && earnedToday + mission.reward > DAILY_MISSION_CAP,
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
    earned_today: earnedToday,
    currency_symbol: economy?.currency_symbol ?? "✦",
    missions,
  };
}

function missionClaimAuthority(ctx: Ctx, scope: 'missions:read'|'missions:claim' = 'missions:claim') {
  const user=ctx.user;
  if (!user || ctx.actor.representedUserId!==user.id || (ctx.actor.type==='user' && ctx.actor.id!==user.id))
    throw new ApiError(403,'mission_access_changed','Your mission access changed. Sign in again.');
  const access=ctx.sessionAssurance==='access' && ctx.accessStatus==='linked' ? ctx.accessIdentity : null;
  return {sql:`EXISTS (SELECT 1 FROM fb_memberships m JOIN fb_users u ON u.id=m.user_id AND u.disabled_at IS NULL AND u.is_synthetic=0
    JOIN fb_bots b ON b.tenant_id=m.tenant_id AND b.status='active'
    WHERE m.tenant_id=? AND m.user_id=? AND m.status='active' AND m.revoked_at IS NULL AND (
      (?='user' AND (EXISTS (SELECT 1 FROM fb_sessions s WHERE s.id=? AND s.user_id=u.id AND s.tenant_id=m.tenant_id AND s.revoked_at IS NULL AND s.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        OR (?='access' AND ?>unixepoch('now') AND EXISTS (SELECT 1 FROM fb_access_identities ai WHERE ai.user_id=u.id AND ai.team_domain=? AND ai.subject=? AND ai.email=? AND ai.revoked_at IS NULL) AND u.email=? COLLATE NOCASE)))
      OR (?='user' AND EXISTS (SELECT 1 FROM fb_discord_identities d WHERE d.tenant_id=m.tenant_id AND d.user_id=u.id AND d.discord_user_id=? AND d.revoked_at IS NULL))
      OR (?='agent' AND EXISTS (SELECT 1 FROM fb_agent_tokens t JOIN fb_agent_grants g ON g.id=t.grant_id WHERE t.id=? AND g.id=? AND t.revoked_at IS NULL AND g.agent_id=? AND g.represented_user_id=u.id AND g.tenant_id=m.tenant_id AND g.status='active' AND g.revoked_at IS NULL AND g.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
        AND json_type(CASE WHEN json_valid(g.scopes_json) THEN g.scopes_json ELSE 'null' END)='array' AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(g.scopes_json) THEN g.scopes_json ELSE '[]' END) WHERE type<>'text')
        AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(g.scopes_json) THEN g.scopes_json ELSE '[]' END) WHERE value=?)))))`,
    args:[ctx.tenant.id,user.id,ctx.actor.type,ctx.sessionId,ctx.sessionAssurance,access?.payload.exp ?? 0,ctx.config.access.teamDomain,access?.subject ?? '',access?.email ?? '',access?.email ?? '',ctx.actor.type,ctx.discordPrincipal?.discordUserId ?? '',ctx.actor.type,ctx.agentCredential?.tokenId ?? '',ctx.agentCredential?.grantId ?? '',ctx.actor.id,scope]};
}

/** Record an intentional world visit with live viewer and principal checks. */
export async function recordCollectionExploration(ctx: Ctx, collectionId: string) {
  if (!ctx.user || ctx.user.synthetic || ctx.actor.type !== 'user' || ctx.actor.id !== ctx.user.id || ctx.actor.representedUserId !== ctx.user.id)
    throw new ApiError(403,'exploration_unavailable','Sign in as a member to record a world visit.');
  const authority=missionClaimAuthority(ctx,'missions:read');
  const visible=liveHumanCollectionSelection(ctx,collectionId);
  const keyPrefix=`explore:${ctx.user.id}:${collectionId}:`;
  const result=await ctx.db.prepare(`INSERT OR IGNORE INTO fb_domain_events (id,tenant_id,user_id,event_type,object_type,object_id,dedupe_key,payload_json,created_at)
    SELECT ?,?,?,'collection.explored','collection',?,? || strftime('%Y-%m-%d','now'),'{}',strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE EXISTS (SELECT 1 FROM fb_collections WHERE id=? AND status='published' AND archived_at IS NULL) AND ${authority.sql} AND ${visible.sql}`)
    .bind(newId('evt'),ctx.tenant.id,ctx.user.id,collectionId,keyPrefix,collectionId,...authority.args,...visible.args).run();
  const current=await first<{ok:number}>(ctx.db,`SELECT 1 AS ok WHERE EXISTS (SELECT 1 FROM fb_collections WHERE id=? AND status='published' AND archived_at IS NULL) AND ${authority.sql} AND ${visible.sql}`,
    collectionId,...authority.args,...visible.args);
  if (!current) throw new ApiError(404,'collection_not_found','That collection is not available.');
  return {recorded:result.meta.changes===1,already_recorded:result.meta.changes===0};
}

export async function claimDailyMission(ctx: Ctx, key: string, idempotencyKey?: string) {
  const user = ctx.user;
  if (!user) throw new ApiError(401, "authentication_required", "Sign in to claim a mission.");
  if (user.synthetic) throw new ApiError(403, "synthetic_mission_blocked", "NPC collectors do not receive human daily missions.");
  const authority=missionClaimAuthority(ctx);
  if (!await first<{ok:number}>(ctx.db,`SELECT 1 AS ok WHERE ${authority.sql}`,...authority.args))
    throw new ApiError(403,'mission_access_changed','Your mission access changed. Sign in again.');
  await checkRateLimit(ctx.db, `mission-claim:${ctx.tenant.id}:${user.id}`, 20, 3600);
  const state = await getDailyMissions(ctx,'missions:claim');
  const mission = state.missions.find((item) => item.key === key);
  if (!mission) throw new ApiError(404, "mission_not_assigned", "That mission is not part of today's assignment.");
  const readReceipt=()=>first<{ id: string; amount: number; created_at: string; balance: number }>(
    ctx.db,
    `SELECT r.id,r.amount,r.created_at,COALESCE(w.balance,0) AS balance FROM fb_reward_claims r LEFT JOIN fb_wallets w ON w.tenant_id=r.tenant_id AND w.user_id=r.user_id WHERE r.tenant_id = ? AND r.user_id = ? AND r.rule_key = ? AND r.period_key = ? AND ${authority.sql}`,
    ctx.tenant.id,
    user.id,
    `${state.period_key}:${mission.key}`,
    state.period_key,
    ...authority.args,
  );
  const existing = await readReceipt();
  if (existing) {
    return {
      replayed: true,
      claim_id: existing.id,
      amount: existing.amount,
      balance_after: existing.balance,
      period_key: state.period_key,
      mission_key: mission.key,
      claimed_at: existing.created_at,
    };
  }
  if (!await first<{ok:number}>(ctx.db,`SELECT 1 AS ok WHERE ${authority.sql}`,...authority.args))
    throw new ApiError(403,'mission_access_changed','Your mission access changed. Sign in again.');
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
          `INSERT INTO fb_reward_claims (id, tenant_id, user_id, rule_key, rule_version, period_key, amount, created_at, idempotency_key)
           SELECT ?,?,?,?,?,?,?,?,? WHERE COALESCE((SELECT SUM(amount) FROM fb_reward_claims
             WHERE tenant_id=? AND user_id=? AND period_key=? AND rule_key LIKE 'mission:%'),0)+?<=? AND ${authority.sql}`,
        )
        .bind(claimId, ctx.tenant.id, user.id, `${state.period_key}:${mission.key}`, mission.version, state.period_key, mission.reward, now, `mission:${state.period_key}:${mission.key}`,
          ctx.tenant.id,user.id,state.period_key,mission.reward,DAILY_MISSION_CAP,...authority.args),
      ctx.db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json('mission_cap_reached') END"),
      auditStatement(ctx, "mission.claimed", "daily_mission", mission.key, {
        amount: mission.reward,
        period_key: state.period_key,
        version: mission.version,
      }),
    ]);
  } catch (error) {
    if (String(error).includes("UNIQUE") || String(error).includes("reward_cooldown") || String(error).includes('malformed JSON')) {
      const replay = await readReceipt();
      if (replay) {
        return {
          replayed: true,
          claim_id: replay.id,
          amount: replay.amount,
          balance_after: replay.balance,
          period_key: state.period_key,
          mission_key: mission.key,
          claimed_at: replay.created_at,
        };
      }
      if (!await first<{ok:number}>(ctx.db,`SELECT 1 AS ok WHERE ${authority.sql}`,...authority.args))
        throw new ApiError(403,'mission_access_changed','Your mission access changed. Sign in again.');
    }
    if (String(error).includes('malformed JSON')) {
      const total=await first<{amount:number}>(ctx.db,`SELECT COALESCE(SUM(amount),0) AS amount FROM fb_reward_claims WHERE tenant_id=? AND user_id=? AND period_key=? AND rule_key LIKE 'mission:%'`,ctx.tenant.id,user.id,state.period_key);
      if (Number(total?.amount ?? 0)+mission.reward>DAILY_MISSION_CAP)
        throw new ApiError(409,'mission_daily_cap','The daily mission reward limit has been reached.');
    }
    throw error;
  }
  let committed:Awaited<ReturnType<typeof readReceipt>>;
  try { committed=await readReceipt(); } catch { committed=null; }
  if (!committed) throw new ApiError(503,'mission_receipt_unavailable','The mission may already have been credited. Sign in again and retry this same mission before doing anything else.');
  return {
    replayed: false,
    claim_id: claimId,
    amount: mission.reward,
    balance_after: committed.balance,
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
