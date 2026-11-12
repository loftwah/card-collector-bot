import { ApiError, requireUser, type Ctx } from "../context";
import { all, statement } from "../db";
import { requireActiveMembership } from "./membership";
import { cardVisibilitySql, collectionVisibilitySql, viewerAccess } from "./visibility";

const DAY_MS = 86_400_000;
const DETAIL_LIMIT = 25;

export function progressPeriod(range: string | null, day: string | null, now = new Date()) {
  const days = range === "30" ? 30 : 7;
  const today = Date.parse(now.toISOString().slice(0, 10));
  const start = today - (days - 1) * DAY_MS;
  const iso = (time: number) => new Date(time).toISOString();
  const dates = Array.from({ length: days }, (_, i) => iso(start + i * DAY_MS).slice(0, 10));
  const selected = day && dates.includes(day) ? day : null;
  return { days, dates, start: iso(start), end: iso(today + DAY_MS), selected };
}

type Period = ReturnType<typeof progressPeriod>;

type LedgerEntry = {
  kind: string;
  amount: number;
  balance_after: number;
  created_at: string;
  reference_type: string | null;
  rule_key: string | null;
};

function ledgerCause(entry: LedgerEntry): { label: string; href?: string } {
  switch (entry.reference_type) {
    case "draw":
      return { label: "Capsule opening", href: "/play/draw" };
    case "starter_grant":
    case "welcome_reward":
      return { label: "Starter grant" };
    case "reward":
      if (entry.rule_key === "daily-allowance")
        return { label: "Daily allowance", href: "/play/rewards#daily-allowance" };
      if (entry.rule_key?.startsWith("mission:"))
        return { label: "Mission reward", href: "/play/missions" };
      return { label: "Reward credit" };
    case "achievement":
      return { label: "Achievement reward", href: "/play/achievements" };
    case "set_completion":
      return { label: "Set completion reward", href: "/play/rewards" };
    case "recycle":
      return { label: "Recycled copy", href: "/play/collection" };
    case "admin_gift":
      return { label: "Admin grant" };
    case "admin_adjustment":
      return { label: entry.amount > 0 ? "Admin grant" : "Admin correction" };
    case "gift":
      return { label: "Gift", href: "/play/gifts" };
    case "trade":
      return { label: "Trade", href: "/play/trades" };
  }
  if (entry.kind === "correction") return { label: "Correction" };
  if (entry.kind === "transfer_in") return { label: "Foil received" };
  if (entry.kind === "transfer_out") return { label: "Foil sent" };
  if (entry.kind === "recycle") return { label: "Recycled copy" };
  return {
    label: entry.amount < 0 ? "Foil debit" : entry.amount > 0 ? "Foil credit" : "Foil entry",
  };
}

type OpeningBucket = { day: string; openings: number };
type FoilBucket = { day: string; credited: number; debited: number; count: number };
type Wallet = { balance: number };

async function activity(ctx: Ctx, userId: string, period: Period) {
  const tenantId = ctx.tenant.id;
  const start = [tenantId, userId, period.start, period.end];
  // One indexed scan per range. Read balance, totals and details in one D1
  // batch so a concurrent opening cannot split the wallet and ledger views.
  const [walletResult, openingResult, foilResult, detailResult] = await ctx.db.batch<
    Wallet | OpeningBucket | FoilBucket | LedgerEntry
  >([
    statement(
      ctx.db,
      "SELECT balance FROM fb_wallets WHERE tenant_id = ? AND user_id = ?",
      tenantId,
      userId,
    ),
    statement(
      ctx.db,
      `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS openings
       FROM fb_draws WHERE tenant_id = ? AND user_id = ? AND created_at >= ? AND created_at < ?
       GROUP BY 1`,
      ...start,
    ),
    statement(
      ctx.db,
      `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS count,
              SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS credited,
              SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) AS debited
       FROM fb_ledger_entries WHERE tenant_id = ? AND user_id = ? AND created_at >= ? AND created_at < ?
       GROUP BY 1`,
      ...start,
    ),
    // When no day was requested, pick the latest day with a Foil entry, then
    // the latest opening, then today. This also keeps today's zeros visible.
    statement(
      ctx.db,
      `WITH bounds AS (
         SELECT COALESCE(?, substr((
           SELECT created_at FROM fb_ledger_entries
            WHERE tenant_id = ? AND user_id = ? AND created_at >= ? AND created_at < ?
            ORDER BY created_at DESC LIMIT 1
         ), 1, 10), substr((
           SELECT created_at FROM fb_draws
            WHERE tenant_id = ? AND user_id = ? AND created_at >= ? AND created_at < ?
            ORDER BY created_at DESC LIMIT 1
         ), 1, 10), ?) AS day
       )
       SELECT l.kind, l.amount, l.balance_after, l.created_at, l.reference_type, r.rule_key
         FROM bounds JOIN fb_ledger_entries l
           ON l.tenant_id = ? AND l.user_id = ?
          AND l.created_at >= (bounds.day || 'T00:00:00.000Z')
          AND l.created_at < (date(bounds.day, '+1 day') || 'T00:00:00.000Z')
         LEFT JOIN fb_reward_claims r ON l.reference_type = 'reward' AND r.id = l.reference_id
                                      AND r.tenant_id = l.tenant_id AND r.user_id = l.user_id
        ORDER BY l.created_at DESC, l.rowid DESC LIMIT ?`,
      period.selected,
      ...start,
      ...start,
      period.dates.at(-1),
      tenantId,
      userId,
      DETAIL_LIMIT,
    ),
  ]);
  if (
    !walletResult?.success ||
    !openingResult?.success ||
    !foilResult?.success ||
    !detailResult?.success
  ) {
    throw new ApiError(503, "activity_unavailable", "Could not read all activity.");
  }
  const wallet = (walletResult.results as Wallet[])[0];
  if (!wallet)
    throw new ApiError(404, "wallet_not_found", "This member has no wallet in this Bot.");
  const openings = new Map(
    (openingResult.results as OpeningBucket[]).map((row) => [row.day, row.openings]),
  );
  const foil = new Map((foilResult.results as FoilBucket[]).map((row) => [row.day, row]));
  const buckets = period.dates.map((day) => ({
    day,
    openings: openings.get(day) ?? 0,
    credited: foil.get(day)?.credited ?? 0,
    debited: foil.get(day)?.debited ?? 0,
    count: foil.get(day)?.count ?? 0,
  }));
  const selected =
    period.selected ??
    buckets.findLast((d) => d.count)?.day ??
    buckets.findLast((d) => d.openings)?.day ??
    period.dates[period.days - 1];
  return {
    balance: wallet.balance,
    buckets,
    selected,
    entries: (detailResult.results as LedgerEntry[]).map((entry) => ({
      ...ledgerCause(entry),
      amount: entry.amount,
      balance: entry.balance_after,
      time: entry.created_at,
    })),
  };
}

type Binder = {
  id: string;
  slug: string;
  name: string;
  logo_url: string | null;
  owned: number;
  total: number;
};

async function startedBinders(ctx: Ctx, userId: string) {
  const access = await viewerAccess(ctx);
  const collection = collectionVisibilitySql(access);
  const card = cardVisibilitySql(access);
  return all<Binder>(
    ctx.db,
    `WITH owned AS (
         SELECT DISTINCT card_id FROM fb_card_instances
          WHERE tenant_id = ? AND user_id = ? AND status IN ('owned','reserved')
       ),
       started AS (
         SELECT DISTINCT cc.collection_id FROM owned
         JOIN fb_collection_cards cc ON cc.card_id = owned.card_id
       )
       SELECT c.id, c.slug, c.name, c.logo_url, COUNT(owned.card_id) AS owned, COUNT(*) AS total
         FROM started
         JOIN fb_collections c ON c.id = started.collection_id
         JOIN fb_collection_cards cc ON cc.collection_id = c.id
         JOIN fb_card_definitions cd ON cd.id = cc.card_id
         LEFT JOIN owned ON owned.card_id = cd.id
        WHERE cd.status = 'published' AND cd.archived_at IS NULL
          AND (${collection.sql}) AND (${card.sql})
        GROUP BY c.id HAVING COUNT(owned.card_id) > 0
        ORDER BY (owned = total), 1.0 * owned / total DESC, (total - owned), c.slug, c.id
        LIMIT 3`,
    ctx.tenant.id,
    userId,
    ...collection.params,
    ...card.params,
  );
}

/** Use the authenticated account and current Bot; never accept a subject selector. */
export async function getCollectorProgress(ctx: Ctx, period: Period) {
  const user = requireUser(ctx);
  if (ctx.actor.type !== "user")
    throw new ApiError(403, "player_session_required", "Sign in to see your progress.");
  await requireActiveMembership(ctx);
  const [walletActivity, binders] = await Promise.allSettled([
    activity(ctx, user.id, period),
    startedBinders(ctx, user.id),
  ]);
  // A revoked membership must not receive data assembled while it was active.
  await requireActiveMembership(ctx);
  return {
    activity: walletActivity.status === "fulfilled" ? walletActivity.value : null,
    binders: binders.status === "fulfilled" ? binders.value : null,
  };
}
