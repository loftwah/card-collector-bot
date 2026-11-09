import type { Ctx } from "../context";
import { all, first } from "../db";
import { countInventory, getInventory, type InventoryRow } from "./collection";
import { listAchievements } from "./achievements";
import { collectionProgress, listCollections, type CollectionSummary } from "./collections";
import { getEconomy } from "./economy";
import { listEligiblePools } from "./pools";
import { getWalletSummary } from "./wallet";

export interface CabinetShelf {
  collection: CollectionSummary;
  ownedSubjects: number;
  ownedCopies: number;
  progress: Awaited<ReturnType<typeof collectionProgress>>;
  cards: InventoryRow[];
  completionPct: number;
  missingSubjects: number;
}

export interface CabinetCloseTarget {
  collection: CollectionSummary;
  ownedSubjects: number;
  totalSubjects: number;
  completionPct: number;
  missingSubjects: number;
}

export interface CabinetView {
  stats: {
    subjects: number;
    copies: number;
    favourites: number;
    badges: number;
    balance: number;
    dailyReward: number;
    dailyReady: boolean;
    nextDailyAt: string | null;
    cheapestCapsule: { name: string; price: number } | null;
  };
  recent: InventoryRow[];
  favourites: InventoryRow[];
  shelves: CabinetShelf[];
  close: CabinetCloseTarget[];
}

/**
 * One read for the cabinet landing surface. The collection shelves are real
 * owned copies; a collection never borrows a card render as its identity.
 */
export async function getCabinet(ctx: Ctx): Promise<CabinetView> {
  const user = ctx.user;
  if (!user) {
    return {
      stats: {
        subjects: 0,
        copies: 0,
        favourites: 0,
        badges: 0,
        balance: 0,
        dailyReward: 0,
        dailyReady: false,
        nextDailyAt: null,
        cheapestCapsule: null,
      },
      recent: [],
      favourites: [],
      shelves: [],
      close: [],
    };
  }

  const [collections, recent, favourites, totalCopies, subjectRow, favouriteCopies, achievements, wallet, economy, pools, lastDaily] =
    await Promise.all([
      listCollections(ctx),
      getInventory(ctx, { limit: 8, status: "owned" }),
      getInventory(ctx, { limit: 6, favourite: true, status: "owned" }),
      countInventory(ctx),
      first<{ subjects: number }>(
        ctx.db,
        "SELECT COUNT(DISTINCT card_id) AS subjects FROM fb_card_instances WHERE tenant_id = ? AND user_id = ? AND status IN ('owned','reserved')",
        ctx.tenant.id,
        user.id,
      ),
      countInventory(ctx, { favourite: true }),
      listAchievements(ctx, user.id),
      getWalletSummary(ctx.db, ctx.tenant.id, user.id, 1),
      getEconomy(ctx),
      listEligiblePools(ctx),
      first<{ created_at: string }>(
        ctx.db,
        "SELECT created_at FROM fb_reward_claims WHERE tenant_id = ? AND user_id = ? AND rule_key = 'daily-allowance' ORDER BY created_at DESC LIMIT 1",
        ctx.tenant.id,
        user.id,
      ),
    ]);

  const ownedCounts = await all<{ collection_id: string; subjects: number; copies: number }>(
    ctx.db,
    `SELECT cc.collection_id,
            COUNT(DISTINCT ci.card_id) AS subjects,
            COUNT(*) AS copies
       FROM fb_collection_cards cc
       JOIN fb_card_instances ci ON ci.card_id = cc.card_id
        AND ci.tenant_id = ? AND ci.user_id = ? AND ci.status IN ('owned','reserved')
       JOIN fb_collections c ON c.id = cc.collection_id AND c.archived_at IS NULL
      GROUP BY cc.collection_id`,
    ctx.tenant.id,
    user.id,
  );
  const counts = new Map(ownedCounts.map((row) => [row.collection_id, row]));
  const ownedCollections = collections
    .filter((collection) => (counts.get(collection.id)?.subjects ?? 0) > 0)
    .map((collection) => ({
      collection,
      ownedSubjects: counts.get(collection.id)?.subjects ?? 0,
      ownedCopies: counts.get(collection.id)?.copies ?? 0,
    }))
    .sort((a, b) => b.ownedSubjects - a.ownedSubjects || a.collection.name.localeCompare(b.collection.name));

  const shelves = await Promise.all(
    ownedCollections.slice(0, 4).map(async (entry): Promise<CabinetShelf> => {
      const [progress, cards] = await Promise.all([
        collectionProgress(ctx, entry.collection.id),
        getInventory(ctx, { collection: entry.collection.slug, limit: 3, status: "owned" }),
      ]);
      const total = Math.max(1, entry.collection.card_count || progress.total_cards);
      return {
        collection: entry.collection,
        ownedSubjects: entry.ownedSubjects,
        ownedCopies: entry.ownedCopies,
        progress,
        cards,
        completionPct: Math.min(100, Math.round((entry.ownedSubjects / total) * 100)),
        missingSubjects: Math.max(0, total - entry.ownedSubjects),
      };
    }),
  );

  const close = ownedCollections
    .filter((entry) => entry.collection.card_count > entry.ownedSubjects)
    .map((entry) => ({
      collection: entry.collection,
      ownedSubjects: entry.ownedSubjects,
      totalSubjects: entry.collection.card_count,
      completionPct: Math.min(100, Math.round((entry.ownedSubjects / Math.max(1, entry.collection.card_count)) * 100)),
      missingSubjects: Math.max(0, entry.collection.card_count - entry.ownedSubjects),
    }))
    .sort((a, b) => b.completionPct - a.completionPct || a.missingSubjects - b.missingSubjects)
    .slice(0, 3);

  const nextDailyAt = lastDaily
    ? new Date(
        new Date(lastDaily.created_at).getTime() + economy.daily_cooldown_seconds * 1000,
      ).toISOString()
    : null;
  const dailyReady = !nextDailyAt || new Date(nextDailyAt).getTime() <= Date.now();
  const cheapest = pools
    .slice()
    .sort((a, b) => a.price - b.price)
    .map((preview) => ({ name: preview.pool.name, price: preview.price }))[0] ?? null;

  return {
    stats: {
      subjects: subjectRow?.subjects ?? 0,
      copies: totalCopies,
      favourites: favouriteCopies,
      badges: achievements.filter((achievement) => achievement.state === "earned").length,
      balance: wallet.balance,
      dailyReward: economy.daily_reward,
      dailyReady,
      nextDailyAt,
      cheapestCapsule: cheapest,
    },
    recent,
    favourites,
    shelves,
    close,
  };
}
