import { z } from "zod";
import { ApiError, assertCsrf, canManageContent, canManageEconomy, requireRole, requireScope, requireUser, type Ctx, type Role } from "../context";
import { apiErrorResponse, audit, json, pagination, readJson, idempotencyInput } from "../http";
import {
  archiveCard,
  archiveTaxonomyItem,
  bulkSetStatus,
  claimSetCompletion,
  createCard,
  createSet,
  createTaxonomyItem,
  createTopicPolicy,
  getCard,
  getTaxonomy,
  getTenantPublication,
  listCards,
  listSets,
  listTopicPolicies,
  mergeCards,
  publishCatalogue,
  publishSet,
  replaceSetMembership,
  setCardStatus,
  setTopicPolicyActive,
  type TaxonomyKind,
  updateCard,
  updateTenantPublication,
} from "../modules/catalogue";
import {
  createPool,
  executeDraw,
  getPoolDetail,
  getPoolPreview,
  listPools,
  publishPool,
  retirePool,
  updatePool,
} from "../modules/pools";
import {
  claimDailyReward,
  adjustWallet,
  createShareLink,
  getEconomy,
  getLedger,
  getPreferences,
  listAudit,
  backupManifest,
  operationsStatus,
  processOutbox,
  revokeShareLink,
  updateEconomy,
  updatePreferences,
} from "../modules/economy";
import {
  getInstance,
  getInventory,
  getMemberTradeInventory,
  getWishlist,
  listTenantMembers,
  recycleCommit,
  recyclePreview,
  setLocked,
  toggleFavourite,
  toggleWishlist,
} from "../modules/collection";
import {
  acceptTrade,
  cancelTrade,
  createGift,
  createTrade,
  declineTrade,
  expireTrades,
  getTrade,
  listGifts,
  listTrades,
} from "../modules/trades";
import {
  createAgentGrant,
  listAgentGrants,
  listMembers,
  revokeAgentGrant,
} from "../modules/identity";
import {
  claimRenderJob,
  commitImport,
  completeRenderJob,
  createRenderJobs,
  failRenderJob,
  listRenderJobs,
  previewImport,
} from "../modules/imports";
import { getAsset, listAssets, uploadAsset, type AssetKind } from "../modules/assets";
import { getWalletSummary } from "../modules/wallet";
import { adoptGeneration, getGenerationJob, listGenerationJobs, planGeneration, reviewGeneration, submitGeneration } from "../modules/generation";
import { publicCard, publicSet } from "./public";

const idSchema = z.string().min(3).max(80);
const cardBody = z.object({
  slug: z.string().min(1).max(80),
  name: z.string().min(1).max(160),
  subtitle: z.string().max(200).optional(),
  description: z.string().min(1).max(4000),
  logicalId: z.string().max(200).optional(),
  classKey: z.string().max(80).optional(),
  categorySlug: z.string().max(80).optional(),
  rarityKey: z.string().max(80).optional(),
  tags: z.array(z.string().max(80)).max(20).optional(),
});
const cardPatch = z.object({
  expectedVersion: z.number().int().positive(),
  name: z.string().min(1).max(160).optional(),
  subtitle: z.string().max(200).nullable().optional(),
  description: z.string().min(1).max(4000).optional(),
  classKey: z.string().max(80).nullable().optional(),
  categorySlug: z.string().max(80).nullable().optional(),
  rarityKey: z.string().max(80).nullable().optional(),
  tags: z.array(z.string().max(80)).max(20).optional(),
});
const importItemSchema = z.object({
  source: z.string().min(1).max(80),
  sourceRepo: z.string().min(1).max(300),
  sourceCommit: z.string().min(1).max(100),
  sourcePath: z.string().min(1).max(500),
  sourceHash: z.string().min(8).max(128),
  logicalId: z.string().min(1).max(200),
  slug: z.string().min(1).max(80),
  name: z.string().min(1).max(160),
  subtitle: z.string().max(200).optional(),
  description: z.string().min(1).max(4000),
  categorySlug: z.string().max(80).optional(),
  classKey: z.string().max(80).optional(),
  rarityKey: z.string().max(80).optional(),
  tags: z.array(z.string().max(80)).max(20).optional(),
  credit: z.string().max(300).optional(),
  subjectAssetId: idSchema,
  backgroundAssetId: idSchema.optional(),
  variants: z.array(z.object({ material: z.string().max(80), effect: z.string().max(80).nullable().optional() })).min(1).max(20),
  sets: z.array(z.string().max(80)).max(10).optional(),
});
const importManifest = z.object({
  source: z.string().min(1).max(80),
  sourceRepo: z.string().min(1).max(600),
  sourceCommit: z.string().min(1).max(600),
  publish: z.boolean().optional(),
  items: z.array(importItemSchema).min(1).max(60),
});

function ensureContentRead(ctx: Ctx) {
  if (ctx.actor.type === "agent") {
    requireScope(ctx, "content:read");
    if (!["owner", "editor"].includes(ctx.user?.role ?? "")) throw new ApiError(403, "insufficient_role", "The represented member cannot read editorial data.");
    return;
  }
  requireRole(ctx, ["owner", "editor"]);
}

function ensureContentWrite(ctx: Ctx) {
  if (ctx.actor.type === "agent") {
    requireScope(ctx, "content:write");
    if (!["owner", "editor"].includes(ctx.user?.role ?? "")) throw new ApiError(403, "insufficient_role", "The represented member cannot edit content.");
    return;
  }
  requireRole(ctx, ["owner", "editor"]);
}

function ensureEconomyRead(ctx: Ctx) {
  if (ctx.actor.type === "agent") {
    requireScope(ctx, "economy:read");
    if (!["owner", "economy_admin"].includes(ctx.user?.role ?? "")) throw new ApiError(403, "insufficient_role", "The represented member cannot read the economy.");
    return;
  }
  requireRole(ctx, ["owner", "economy_admin"]);
}

function ensureEconomyWrite(ctx: Ctx) {
  if (ctx.actor.type === "agent") {
    requireScope(ctx, "economy:write");
    if (!["owner", "economy_admin"].includes(ctx.user?.role ?? "")) throw new ApiError(403, "insufficient_role", "The represented member cannot edit the economy.");
    return;
  }
  requireRole(ctx, ["owner", "economy_admin"]);
}

function ensureOwner(ctx: Ctx) {
  if (ctx.actor.type === "agent") throw new ApiError(403, "owner_human_required", "This action requires a signed-in human owner.");
  requireRole(ctx, ["owner"]);
}

function ensureOps(ctx: Ctx) {
  if (ctx.actor.type === "agent") {
    requireScope(ctx, "ops:read");
    if (!["owner", "editor", "economy_admin"].includes(ctx.user?.role ?? "")) throw new ApiError(403, "insufficient_role", "The represented member cannot read operations.");
    return;
  }
  requireRole(ctx, ["owner", "editor", "economy_admin"]);
}

function playerWrite(ctx: Ctx) {
  requireUser(ctx);
  if (ctx.actor.type === "agent" && !ctx.scopes?.length) throw new ApiError(403, "insufficient_scope", "The agent grant has no player scopes.");
}

export async function routeApi(request: Request, ctx: Ctx, path: string): Promise<Response> {
  const segments = path.split("/").filter(Boolean);
  const method = request.method.toUpperCase();
  const url = new URL(request.url);
  const isRead = method === "GET" || method === "HEAD";
  if (!isRead) assertCsrf(ctx, request);

  // Public catalogue and pool previews
  if (segments[0] === "catalogue" && segments.length === 1 && method === "GET") {
    const cards = await listCards(ctx, {
      publicOnly: true,
      search: url.searchParams.get("search") ?? undefined,
      category: url.searchParams.get("category") ?? undefined,
      tag: url.searchParams.get("tag") ?? undefined,
      set: url.searchParams.get("set") ?? undefined,
      limit: Number(url.searchParams.get("limit") ?? 100),
    });
    return json({ items: cards.map(publicCard), release: await activeRelease(ctx) });
  }
  if (segments[0] === "cards" && segments[1] && method === "GET") {
    const card = await getCard(ctx, segments[1]);
    if (card.status !== "published") throw new ApiError(404, "card_not_found", "That card is not published.");
    const published = (await listCards(ctx, { publicOnly: true })).find((item) => item.id === card.id);
    if (!published) throw new ApiError(404, "card_not_found", "That card is not in the active catalogue release.");
    return json({ card: publicCard(published) });
  }
  if (segments[0] === "sets" && segments.length === 1 && method === "GET") {
    const sets = (await listSets(ctx, ctx.user?.id)).filter((set) => set.status === "published");
    return json({ items: sets.map(publicSet) });
  }
  if (segments[0] === "pools" && segments.length === 1 && method === "GET") {
    const pools = await listPools(ctx);
    return json({ items: pools.map(({ id, slug, name, description, revision, price, status }) => ({ id, slug, name, description, revision, price, status })) });
  }
  if (segments[0] === "pools" && segments[1] && segments.length === 2 && method === "GET") {
    const preview = await getPoolPreview(ctx, segments[1], url.searchParams.get("channel") ?? undefined);
    return json(publicPoolPreview(preview));
  }

  // Player and agent-authenticated collection workflows
  if (segments[0] === "me" && segments[1] === "preferences" && method === "GET") {
    return json(await getPreferences(ctx));
  }
  if (segments[0] === "me" && segments[1] === "preferences" && method === "PATCH") {
    playerWrite(ctx);
    const body = await readJson(
      request,
      z.object({
        hideTags: z.array(z.string().max(80)).max(30).optional(),
        reducedMotion: z.boolean().optional(),
        soundEnabled: z.boolean().optional(),
        sharingEnabled: z.boolean().optional(),
      }),
    );
    return json(await updatePreferences(ctx, body));
  }
  if (segments[0] === "wallet" && method === "GET") {
    const user = requireUser(ctx);
    return json(await getWalletSummary(ctx.db, ctx.tenant.id, user.id));
  }
  if (segments[0] === "ledger" && method === "GET") {
    const user = requireUser(ctx);
    return json(await getLedger(ctx, user.id, Number(url.searchParams.get("limit") ?? 100)));
  }
  if (segments[0] === "inventory" && method === "GET") {
    playerWrite(ctx);
    return json({
      items: await getInventory(ctx, {
        status: url.searchParams.get("status") ?? undefined,
        search: url.searchParams.get("search") ?? undefined,
        favourite: url.searchParams.get("favourite") === "true",
        setSlug: url.searchParams.get("set") ?? undefined,
        limit: Number(url.searchParams.get("limit") ?? 200),
      }),
    });
  }
  if (segments[0] === "instances" && segments[1] && segments.length === 2 && method === "GET") {
    playerWrite(ctx);
    return json(await getInstance(ctx, segments[1]));
  }
  if (segments[0] === "instances" && segments[1] && segments[2] === "favourite" && method === "POST") {
    playerWrite(ctx);
    const body = await readJson(request, z.object({ favourite: z.boolean() }));
    return json(await toggleFavourite(ctx, segments[1], body.favourite));
  }
  if (segments[0] === "instances" && segments[1] && segments[2] === "lock" && method === "POST") {
    playerWrite(ctx);
    const body = await readJson(request, z.object({ locked: z.boolean() }));
    return json(await setLocked(ctx, segments[1], body.locked));
  }
  if (segments[0] === "members" && segments.length === 1 && method === "GET") {
    playerWrite(ctx);
    return json({ items: await listTenantMembers(ctx) });
  }
  if (segments[0] === "members" && segments[1] && segments[2] === "trade-items" && method === "GET") {
    playerWrite(ctx);
    return json({ items: await getMemberTradeInventory(ctx, segments[1]) });
  }
  if (segments[0] === "wishlist" && method === "GET") {
    playerWrite(ctx);
    return json({ items: await getWishlist(ctx) });
  }
  if (segments[0] === "wishlist" && method === "POST") {
    playerWrite(ctx);
    const body = await readJson(request, z.object({ cardId: idSchema, wanted: z.boolean() }));
    return json(await toggleWishlist(ctx, body.cardId, body.wanted));
  }
  if (segments[0] === "rewards" && segments[1] === "claim" && method === "POST") {
    playerWrite(ctx);
    requireScope(ctx, "reward:claim");
    const body = await readJson(request, z.object({}));
    const idempotency = await idempotencyInput(request, body);
    return json(await claimDailyReward(ctx, idempotency));
  }
  if (segments[0] === "draws" && method === "POST") {
    playerWrite(ctx);
    requireScope(ctx, "draw:execute");
    const body = await readJson(
      request,
      z.object({ pool: z.string().min(1).max(80), expectedRevision: z.number().int().positive(), channelKey: z.string().max(80).optional() }),
    );
    const idempotency = await idempotencyInput(request, body);
    return json(
      await executeDraw(ctx, {
        pool: body.pool,
        expectedRevision: body.expectedRevision,
        channelKey: body.channelKey,
        idempotency,
      }),
    );
  }
  if (segments[0] === "recycle" && segments[1] === "preview" && method === "POST") {
    playerWrite(ctx);
    const body = await readJson(request, z.object({ instanceId: idSchema }));
    return json(await recyclePreview(ctx, body.instanceId));
  }
  if (segments[0] === "recycle" && segments.length === 1 && method === "POST") {
    playerWrite(ctx);
    requireScope(ctx, "recycle:write");
    const body = await readJson(
      request,
      z.object({ instanceId: idSchema, expectedCredit: z.number().int().nonnegative() }),
    );
    const idempotency = await idempotencyInput(request, body);
    return json(
      await recycleCommit(ctx, {
        instanceId: body.instanceId,
        expectedCredit: body.expectedCredit,
        idempotencyKey: idempotency.key,
      }),
    );
  }
  if (segments[0] === "sets" && segments[1] && segments[2] === "claim" && method === "POST") {
    playerWrite(ctx);
    const body = await readJson(request, z.object({}));
    const idempotency = await idempotencyInput(request, body);
    return json(await claimSetCompletion(ctx, segments[1], idempotency.key));
  }
  if (segments[0] === "trades" && method === "GET") {
    playerWrite(ctx);
    return json({ items: await listTrades(ctx) });
  }
  if (segments[0] === "trades" && segments.length === 1 && method === "POST") {
    playerWrite(ctx);
    requireScope(ctx, "trade:write");
    const body = await readJson(
      request,
      z.object({
        recipientEmail: z.string().email().max(320),
        proposerInstanceIds: z.array(idSchema).max(30),
        recipientInstanceIds: z.array(idSchema).max(30),
        expiresInHours: z.number().int().min(1).max(168).optional(),
        note: z.string().max(500).optional(),
      }),
    );
    return json(await createTrade(ctx, body));
  }
  if (segments[0] === "trades" && segments[1] && segments.length === 2 && method === "GET") {
    playerWrite(ctx);
    return json(await getTrade(ctx, segments[1]));
  }
  if (segments[0] === "trades" && segments[1] && ["accept", "decline", "cancel"].includes(segments[2] ?? "") && method === "POST") {
    playerWrite(ctx);
    requireScope(ctx, "trade:write");
    const action = segments[2];
    if (action === "accept") return json(await acceptTrade(ctx, segments[1]));
    if (action === "decline") return json(await declineTrade(ctx, segments[1]));
    return json(await cancelTrade(ctx, segments[1]));
  }
  if (segments[0] === "trades" && segments[1] === "expire" && method === "POST") {
    ensureOps(ctx);
    return json(await expireTrades(ctx));
  }
  if (segments[0] === "gifts" && method === "GET") {
    playerWrite(ctx);
    return json({ items: await listGifts(ctx) });
  }
  if (segments[0] === "gifts" && method === "POST") {
    playerWrite(ctx);
    requireScope(ctx, "trade:write");
    const body = await readJson(
      request,
      z.object({ recipientEmail: z.string().email().max(320), instanceId: idSchema, note: z.string().max(500).optional() }),
    );
    const idempotency = await idempotencyInput(request, body);
    return json(await createGift(ctx, { ...body, idempotencyKey: idempotency.key }));
  }
  if (segments[0] === "shares" && segments.length === 1 && method === "POST") {
    playerWrite(ctx);
    const body = await readJson(request, z.object({ expiresInDays: z.number().int().min(1).max(30).optional() }));
    return json(await createShareLink(ctx, body.expiresInDays));
  }
  if (segments[0] === "shares" && segments[1] && segments[2] === "revoke" && method === "POST") {
    playerWrite(ctx);
    return json(await revokeShareLink(ctx, segments[1]));
  }

  // Content administration
  if (segments[0] === "admin" && segments[1] === "cards" && segments.length === 2 && method === "GET") {
    ensureContentRead(ctx);
    return json({
      items: await listCards(ctx, {
        includeDrafts: true,
        search: url.searchParams.get("search") ?? undefined,
        limit: Number(url.searchParams.get("limit") ?? 200),
      }),
    });
  }
  if (segments[0] === "admin" && segments[1] === "cards" && segments.length === 2 && method === "POST") {
    ensureContentWrite(ctx);
    const body = await readJson(request, cardBody);
    const card = await createCard(ctx, body);
    return json({ card }, 201);
  }
  if (segments[0] === "admin" && segments[1] === "cards" && segments[2] === "bulk" && method === "POST") {
    ensureContentWrite(ctx);
    const body = await readJson(
      request,
      z.object({ ids: z.array(idSchema).max(100), status: z.enum(["draft", "published", "retired"]) }),
    );
    return json(await bulkSetStatus(ctx, body.ids, body.status));
  }
  if (segments[0] === "admin" && segments[1] === "cards" && segments[2] && segments.length === 3) {
    if (method === "PATCH") {
      ensureContentWrite(ctx);
      const body = await readJson(request, cardPatch);
      return json({ card: await updateCard(ctx, segments[2], body) });
    }
    if (method === "DELETE") {
      ensureContentWrite(ctx);
      await archiveCard(ctx, segments[2]);
      return json({ ok: true });
    }
  }
  if (segments[0] === "admin" && segments[1] === "cards" && segments[2] && segments[3] === "status" && method === "POST") {
    ensureContentWrite(ctx);
    const body = await readJson(request, z.object({ status: z.enum(["draft", "published", "retired"]) }));
    return json({ card: await setCardStatus(ctx, segments[2], body.status) });
  }
  if (segments[0] === "admin" && segments[1] === "tenant" && method === "GET") {
    ensureContentRead(ctx);
    return json(await getTenantPublication(ctx));
  }
  if (segments[0] === "admin" && segments[1] === "tenant" && method === "PATCH") {
    ensureContentWrite(ctx);
    const body = await readJson(request, z.object({ publicCatalogue: z.boolean().optional(), blockedTags: z.array(z.string().max(80)).max(50).optional() }));
    return json(await updateTenantPublication(ctx, body));
  }
  if (segments[0] === "admin" && segments[1] === "taxonomy" && method === "GET") {
    ensureContentRead(ctx);
    return json(await getTaxonomy(ctx));
  }
  if (segments[0] === "admin" && segments[1] === "taxonomy" && method === "POST") {
    ensureContentWrite(ctx);
    const body = await readJson(
      request,
      z.object({
        kind: z.enum(["class", "category", "tag", "rarity", "material", "effect"]),
        key: z.string().min(1).max(80),
        name: z.string().min(1).max(160),
        description: z.string().max(1000).optional(),
        parentId: z.string().max(80).optional(),
        config: z.unknown().optional(),
      }),
    );
    return json(await createTaxonomyItem(ctx, body.kind as TaxonomyKind, body), 201);
  }
  if (segments[0] === "admin" && segments[1] === "taxonomy" && segments[2] && segments[3] && method === "DELETE") {
    ensureContentWrite(ctx);
    await archiveTaxonomyItem(ctx, segments[2] as TaxonomyKind, segments[3]);
    return json({ ok: true });
  }
  if (segments[0] === "admin" && segments[1] === "sets" && segments.length === 2 && method === "GET") {
    ensureContentRead(ctx);
    return json({ items: await listSets(ctx) });
  }
  if (segments[0] === "admin" && segments[1] === "sets" && segments.length === 2 && method === "POST") {
    ensureContentWrite(ctx);
    const body = await readJson(
      request,
      z.object({ slug: z.string().min(1).max(80), name: z.string().min(1).max(160), description: z.string().max(2000), rewardAmount: z.number().int().nonnegative() }),
    );
    return json({ set: await createSet(ctx, body) }, 201);
  }
  if (segments[0] === "admin" && segments[1] === "sets" && segments[2] && segments[3] === "members" && method === "PUT") {
    ensureContentWrite(ctx);
    const body = await readJson(request, z.object({ cardIds: z.array(idSchema).max(200) }));
    return json({ set: await replaceSetMembership(ctx, segments[2], body.cardIds) });
  }
  if (segments[0] === "admin" && segments[1] === "sets" && segments[2] && segments[3] === "publish" && method === "POST") {
    ensureContentWrite(ctx);
    return json({ set: await publishSet(ctx, segments[2]) });
  }
  if (segments[0] === "admin" && segments[1] === "catalogue" && segments[2] === "publish" && method === "POST") {
    ensureContentWrite(ctx);
    requireScope(ctx, "catalogue:publish");
    return json(await publishCatalogue(ctx));
  }
  if (segments[0] === "admin" && segments[1] === "catalogue" && segments[2] === "status" && method === "GET") {
    ensureContentRead(ctx);
    return json({ release: await activeRelease(ctx) });
  }

  // Pools
  if (segments[0] === "admin" && segments[1] === "pools" && segments.length === 2 && method === "GET") {
    ensureContentRead(ctx);
    return json({ items: await listPools(ctx, true) });
  }
  if (segments[0] === "admin" && segments[1] === "pools" && segments.length === 2 && method === "POST") {
    ensureContentWrite(ctx);
    const body = await readJson(
      request,
      z.object({
        slug: z.string().min(1).max(80),
        name: z.string().min(1).max(160),
        description: z.string().max(2000),
        price: z.number().int().nonnegative(),
        channelKey: z.string().max(80).optional(),
        entries: z.array(z.object({ variantId: idSchema, weight: z.number().int().positive().max(100000) })).min(1).max(300),
      }),
    );
    return json({ pool: await createPool(ctx, body) }, 201);
  }
  if (segments[0] === "admin" && segments[1] === "pools" && segments[2] && segments.length === 3 && method === "GET") {
    ensureContentRead(ctx);
    return json(await getPoolDetail(ctx, segments[2]));
  }
  if (segments[0] === "admin" && segments[1] === "pools" && segments[2] && segments.length === 3 && method === "PATCH") {
    ensureContentWrite(ctx);
    const body = await readJson(
      request,
      z.object({
        expectedRevision: z.number().int().positive(),
        name: z.string().min(1).max(160).optional(),
        description: z.string().max(2000).optional(),
        price: z.number().int().nonnegative().optional(),
        entries: z.array(z.object({ variantId: idSchema, weight: z.number().int().positive().max(100000) })).min(1).max(300).optional(),
      }),
    );
    return json({ pool: await updatePool(ctx, segments[2], body) });
  }
  if (segments[0] === "admin" && segments[1] === "pools" && segments[2] && segments[3] === "publish" && method === "POST") {
    ensureContentWrite(ctx);
    return json({ pool: await publishPool(ctx, segments[2]) });
  }
  if (segments[0] === "admin" && segments[1] === "pools" && segments[2] && segments[3] === "retire" && method === "POST") {
    ensureContentWrite(ctx);
    await retirePool(ctx, segments[2]);
    return json({ ok: true });
  }

  // Economy and wallet administration
  if (segments[0] === "admin" && segments[1] === "economy" && method === "GET") {
    ensureEconomyRead(ctx);
    return json(await getEconomy(ctx));
  }
  if (segments[0] === "admin" && segments[1] === "economy" && method === "PATCH") {
    ensureEconomyWrite(ctx);
    const body = await readJson(
      request,
      z.object({
        expectedVersion: z.number().int().positive(),
        currencyName: z.string().min(1).max(60).optional(),
        currencySymbol: z.string().min(1).max(8).optional(),
        starterGrant: z.number().int().nonnegative().optional(),
        dailyReward: z.number().int().nonnegative().optional(),
        dailyCooldownSeconds: z.number().int().nonnegative().optional(),
        recycleEnabled: z.boolean().optional(),
        recycleRates: z
          .object({ rarity: z.record(z.string(), z.number().int().nonnegative()), material: z.record(z.string(), z.number().int().nonnegative()) })
          .optional(),
      }),
    );
    return json(await updateEconomy(ctx, body));
  }
  if (segments[0] === "admin" && segments[1] === "wallets" && segments[2] && segments[3] === "adjust" && method === "POST") {
    ensureEconomyWrite(ctx);
    const body = await readJson(
      request,
      z.object({ amount: z.number().int().refine((value) => value !== 0), reason: z.string().min(3).max(500) }),
    );
    const idempotency = await idempotencyInput(request, body);
    return json(await adjustWallet(ctx, { userId: segments[2], amount: body.amount, reason: body.reason, idempotency }));
  }
  if (segments[0] === "admin" && segments[1] === "wallets" && segments[2] && method === "GET" && segments.length === 3) {
    ensureEconomyRead(ctx);
    return json(await getWalletSummary(ctx.db, ctx.tenant.id, segments[2], 100));
  }
  if (segments[0] === "admin" && segments[1] === "audit" && method === "GET") {
    ensureEconomyRead(ctx);
    return json({ items: await listAudit(ctx, Number(url.searchParams.get("limit") ?? 100)) });
  }

  // Agents and members
  if (segments[0] === "admin" && segments[1] === "agents" && method === "GET") {
    ensureOwner(ctx);
    return json({ items: await listAgentGrants(ctx) });
  }
  if (segments[0] === "admin" && segments[1] === "agents" && method === "POST") {
    ensureOwner(ctx);
    const body = await readJson(
      request,
      z.object({
        agentName: z.string().min(1).max(100),
        representedUserId: idSchema,
        scopes: z.array(z.string().max(80)).min(1).max(30),
        expiresInDays: z.number().int().min(1).max(365),
      }),
    );
    return json(await createAgentGrant(ctx, body), 201);
  }
  if (segments[0] === "admin" && segments[1] === "agents" && segments[2] && segments[3] === "revoke" && method === "POST") {
    ensureOwner(ctx);
    await revokeAgentGrant(ctx, segments[2]);
    return json({ ok: true });
  }
  if (segments[0] === "admin" && segments[1] === "members" && method === "GET") {
    ensureOps(ctx);
    return json({ items: await listMembers(ctx) });
  }

  // Assets, imports and render jobs
  if (segments[0] === "admin" && segments[1] === "assets" && segments.length === 2 && method === "GET") {
    ensureContentRead(ctx);
    return json({ items: await listAssets(ctx, (url.searchParams.get("kind") as AssetKind) ?? undefined) });
  }
  if (segments[0] === "admin" && segments[1] === "assets" && segments.length === 2 && method === "POST") {
    ensureContentWrite(ctx);
    requireScope(ctx, "import:write");
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new ApiError(422, "file_required", "Upload an image file.");
    const kind = String(form.get("kind") ?? "subject") as AssetKind;
    if (!["subject", "background", "frame", "material", "effect", "brand"].includes(kind)) {
      throw new ApiError(422, "kind_invalid", "Unsupported asset kind.");
    }
    const asset = await uploadAsset(ctx, {
      kind,
      name: String(form.get("name") ?? file.name ?? "Asset"),
      bytes: new Uint8Array(await file.arrayBuffer()),
      declaredMime: file.type || undefined,
      visibility: "private",
      source: {
        repo: form.get("sourceRepo") ? String(form.get("sourceRepo")) : undefined,
        path: form.get("sourcePath") ? String(form.get("sourcePath")) : undefined,
        commit: form.get("sourceCommit") ? String(form.get("sourceCommit")) : undefined,
        logicalId: form.get("sourceLogicalId") ? String(form.get("sourceLogicalId")) : undefined,
        credit: form.get("credit") ? String(form.get("credit")) : undefined,
      },
    });
    return json({ asset }, 201);
  }
  if (segments[0] === "admin" && segments[1] === "assets" && segments[2] && segments[3] === "bytes" && method === "GET") {
    ensureContentRead(ctx);
    const asset = await getAsset(ctx, segments[2]);
    const { readAsset } = await import("../modules/assets");
    const bytes = await readAsset(ctx.media, asset);
    return new Response(bytes, { headers: { "content-type": asset.mime, "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  }
  if (segments[0] === "admin" && segments[1] === "imports" && segments[2] === "preview" && method === "POST") {
    ensureContentRead(ctx);
    const body = await readJson(request, importManifest);
    return json(await previewImport(ctx, body));
  }
  if (segments[0] === "admin" && segments[1] === "imports" && segments.length === 2 && method === "GET") {
    ensureContentRead(ctx);
    return json({
      runs: await importRuns(ctx),
    });
  }
  if (segments[0] === "admin" && segments[1] === "imports" && segments.length === 2 && method === "POST") {
    ensureContentWrite(ctx);
    requireScope(ctx, "import:write");
    const body = await readJson(request, importManifest);
    return json(await commitImport(ctx, body));
  }
  if (segments[0] === "admin" && segments[1] === "renders" && segments[2] === "queue" && method === "POST") {
    ensureContentWrite(ctx);
    requireScope(ctx, "render:write");
    return json(await createRenderJobs(ctx));
  }
  if (segments[0] === "admin" && segments[1] === "jobs" && method === "GET") {
    ensureOps(ctx);
    return json({ items: await listRenderJobs(ctx, url.searchParams.get("status") ?? undefined) });
  }
  if (segments[0] === "admin" && segments[1] === "jobs" && segments[2] && segments[3] === "claim" && method === "POST") {
    ensureOps(ctx);
    requireScope(ctx, "render:write");
    return json({ job: await claimRenderJob(ctx, segments[2] === "next" ? undefined : segments[2]) });
  }
  if (segments[0] === "admin" && segments[1] === "jobs" && segments[2] && segments[3] === "complete" && method === "POST") {
    ensureOps(ctx);
    requireScope(ctx, "render:write");
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new ApiError(422, "file_required", "Upload the rendered card image.");
    return json(await completeRenderJob(ctx, segments[2], new Uint8Array(await file.arrayBuffer())));
  }
  if (segments[0] === "admin" && segments[1] === "jobs" && segments[2] && segments[3] === "fail" && method === "POST") {
    ensureOps(ctx);
    requireScope(ctx, "render:write");
    const body = await readJson(request, z.object({ message: z.string().min(1).max(500) }));
    return json(await failRenderJob(ctx, segments[2], body.message));
  }
  if (segments[0] === "admin" && segments[1] === "generation" && segments[2] === "plan" && method === "POST") {
    ensureContentWrite(ctx);
    const body = await readJson(request, z.object({ prompt: z.string().min(1).max(4000), model: z.string().min(1).max(100).optional(), count: z.number().int().min(1).max(10).optional() }));
    const idempotency = await idempotencyInput(request, body);
    return json(await planGeneration(ctx, { ...body, idempotencyKey: idempotency.key }), 201);
  }
  if (segments[0] === "admin" && segments[1] === "generation" && segments[2] === "jobs" && segments.length === 3 && method === "GET") {
    ensureContentRead(ctx);
    return json({ items: await listGenerationJobs(ctx) });
  }
  if (segments[0] === "admin" && segments[1] === "generation" && segments[2] === "jobs" && segments[3] && segments.length === 4 && method === "GET") {
    ensureContentRead(ctx);
    return json(await getGenerationJob(ctx, segments[3]));
  }
  if (segments[0] === "admin" && segments[1] === "generation" && segments[2] === "jobs" && segments[3] && segments[4] === "submit" && method === "POST") {
    ensureContentWrite(ctx);
    return json(await submitGeneration(ctx, segments[3]));
  }
  if (segments[0] === "admin" && segments[1] === "generation" && segments[2] === "jobs" && segments[3] && segments[4] === "review" && method === "POST") {
    ensureContentWrite(ctx);
    const body = await readJson(request, z.object({ decision: z.enum(["approve", "reject"]) }));
    return json(await reviewGeneration(ctx, segments[3], body.decision));
  }
  if (segments[0] === "admin" && segments[1] === "generation" && segments[2] === "jobs" && segments[3] && segments[4] === "adopt" && method === "POST") {
    ensureContentWrite(ctx);
    return json(await adoptGeneration(ctx, segments[3]));
  }

  // Topics and operations
  if (segments[0] === "admin" && segments[1] === "topics" && method === "GET") {
    ensureContentRead(ctx);
    return json({ items: await listTopicPolicies(ctx) });
  }
  if (segments[0] === "admin" && segments[1] === "topics" && method === "POST") {
    ensureContentWrite(ctx);
    const body = await readJson(
      request,
      z.object({ channelKey: z.string().min(1).max(80), name: z.string().min(1).max(160), excludeTags: z.array(z.string().max(80)).max(30) }),
    );
    return json({ policy: await createTopicPolicy(ctx, body) }, 201);
  }
  if (segments[0] === "admin" && segments[1] === "topics" && segments[2] && method === "PATCH") {
    ensureContentWrite(ctx);
    const body = await readJson(request, z.object({ active: z.boolean() }));
    await setTopicPolicyActive(ctx, segments[2], body.active);
    return json({ ok: true });
  }
  if (segments[0] === "admin" && segments[1] === "backup" && segments[2] === "manifest" && method === "GET") {
    ensureOps(ctx);
    return json(await backupManifest(ctx));
  }
  if (segments[0] === "admin" && segments[1] === "outbox" && segments[2] === "process" && method === "POST") {
    ensureOps(ctx);
    return json(await processOutbox(ctx));
  }
  if ((segments[0] === "ops" || segments[0] === "admin") && segments[1] === "status" && method === "GET") {
    ensureOps(ctx);
    return json(await operationsStatus(ctx));
  }

  throw new ApiError(404, "not_found", "No matching API route.");
}

function publicPoolPreview(preview: Awaited<ReturnType<typeof getPoolPreview>>) {
  return {
    pool: {
      id: preview.pool.id,
      slug: preview.pool.slug,
      name: preview.pool.name,
      description: preview.pool.description,
      revision: preview.revision,
      price: preview.price,
      status: preview.pool.status,
    },
    revision: preview.revision,
    price: preview.price,
    eligible_count: preview.eligible_count,
    total_weight: preview.total_weight,
    entries: preview.entries.map((entry) => ({
      variant_id: entry.variant_id,
      card_id: entry.card_id,
      card_name: entry.card_name,
      variant_name: entry.variant_name,
      material_key: entry.material_key,
      effect_key: entry.effect_key,
      render_url: entry.render_url,
      weight: entry.weight,
      probability_bps: entry.probability_bps,
      tags: entry.tags,
    })),
    filters: preview.filters,
    pity: preview.pity,
    currency: preview.currency,
    expected_revision: preview.expected_revision,
  };
}

async function activeRelease(ctx: Ctx) {
  const { first } = await import("../db");
  return first<{ id: string; version: number; checksum: string; published_at: string }>(
    ctx.db,
    "SELECT id, version, checksum, published_at FROM fb_catalogue_releases WHERE tenant_id = ? AND status = 'active' ORDER BY version DESC LIMIT 1",
    ctx.tenant.id,
  );
}

async function importRuns(ctx: Ctx) {
  const { all } = await import("../db");
  return all(
    ctx.db,
    "SELECT * FROM fb_import_runs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 50",
    ctx.tenant.id,
  );
}
