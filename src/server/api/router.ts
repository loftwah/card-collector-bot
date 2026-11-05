import { z } from "zod";
import { all, first, nowIso } from "../db";
import { newId } from "../ids";
import {
  ApiError,
  assertCsrf,
  canManageContent,
  canManageEconomy,
  canManageGlobalCollection,
  canManageGlobalCollections,
  hasCapability,
  isGlobalCollectionAdmin,
  requireGlobalCollectionManager,
  requireRecentStrongAuth,
  requireRole,
  requireScope,
  requireSuperAdmin,
  requireUser,
  type Ctx,
  type Role,
} from "../context";
import { apiErrorResponse, audit, json, pagination, readJson, idempotencyInput } from "../http";
import {
  archiveCard,
  archiveTaxonomyItem,
  bulkSetStatus,
  claimSetCompletion,
  createCard,
  createEditionForCard,
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
  listEligiblePools,
  publishPool,
  retirePool,
  updatePool,
} from "../modules/pools";
import { poolScopeFromDiscord, resolveDiscordScope } from "../discord/scope";
import type { DiscordInstallation } from "../discord/types";
import {
  claimDailyReward,
  adjustWallet,
  createShareLink,
  getEconomy,
  getLedger,
  getPreferences,
  listAudit,
  listShareLinks,
  backupManifest,
  operationsStatus,
  processOutbox,
  revokeShareLink,
  updateEconomy,
  updatePreferences,
} from "../modules/economy";
import {
  assignPlatformRole,
  listPlatformPeople,
  listPlatformRoleAssignments,
  revokePlatformRole,
  SCOPED_PLATFORM_ROLES,
} from "../modules/platform-roles";
import {
  countInventory,
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
import {
  adoptGeneration,
  getGenerationJob,
  listGenerationJobs,
  planGeneration,
  reviewGeneration,
  submitGeneration,
} from "../modules/generation";
import {
  createPrintProposal,
  getPrintProposal,
  linkApprovedEdition,
  listPrintProposalReviews,
  listPrintProposals,
  printCoverageForCard,
  reviewPrintProposal,
  revisePrintProposal,
  submitPrintProposal,
} from "../modules/prints";
import { publicCard, publicSet } from "./public";
import {
  acceptBotInvitation,
  createBot,
  createBotInvitation,
  listBotAdmins,
  listBotInvitations,
  listBotsForUser,
  revokeBotAdmin,
} from "../modules/bots";
import {
  addCollectionCards,
  createCollection,
  enableCollection,
  getCollection,
  listCollectionCards,
  listCollections,
  listPublicCollections,
  listCollectionViewers,
  setCollectionViewers,
  collectionProgress,
  removeCollectionCard,
  updateCollection,
} from "../modules/collections";
import {
  backfillAchievements,
  createAchievement,
  evaluateAchievements,
  listAchievements,
  recordCollectionExploration,
} from "../modules/achievements";
import {
  listAdminGiftCampaigns,
  listMyGiftReceipts,
  previewAdminGift,
  processGiftCampaign,
  sendAdminGift,
} from "../modules/admin-gifts";
import {
  getMyMemberships,
  joinMainAlbum,
  setMemberStatus,
} from "../modules/membership";
import {
  claimDailyMission,
  getDailyMissions,
} from "../modules/missions";
import {
  compareNpc,
  createNpc,
  createNpcBatch,
  getNpc,
  getNpcAdminOverview,
  listNpcActions,
  listNpcPresets,
  listNpcProfiles,
  listNpcs,
  playNpcOnce,
  previewNpcAction,
  requireNpcManager,
  requireNpcRead,
  runDueNpcs,
  runNpcBatch,
  setNpcLimits,
  setNpcStatus,
  updateNpc,
} from "../modules/npcs";

const idSchema = z.string().min(3).max(80);
const cardBody = z.object({
  slug: z.string().min(1).max(80),
  name: z.string().min(1).max(160),
  subtitle: z.string().max(200).optional(),
  description: z.string().min(1).max(4000),
  bio: z.string().max(2000).optional(),
  bioSafe: z.string().max(2000).optional(),
  spoilerLevel: z.number().int().min(0).max(3).optional(),
  spoilerBio: z.string().max(4000).optional(),
  attributes: z.array(z.record(z.string(), z.unknown())).max(20).optional(),
  sourceRefs: z.array(z.string().max(500)).max(20).optional(),
  reviewStatus: z
    .enum(["unreviewed", "draft", "reviewed", "approved", "rejected", "placeholder"])
    .optional(),
  sourceWork: z.string().max(300).optional(),
  adaptationBoundary: z.string().max(1000).optional(),
  quote: z.string().max(300).optional(),
  logicalId: z.string().max(200).optional(),
  classKey: z.string().max(80).optional(),
  categorySlug: z.string().max(80).optional(),
  collectionSlug: z.string().max(80).optional(),
  rarityKey: z.string().max(80).optional(),
  tags: z.array(z.string().max(80)).max(20).optional(),
});
const cardPatch = z.object({
  expectedVersion: z.number().int().positive(),
  name: z.string().min(1).max(160).optional(),
  subtitle: z.string().max(200).nullable().optional(),
  description: z.string().min(1).max(4000).optional(),
  bio: z.string().max(2000).nullable().optional(),
  quote: z.string().max(300).nullable().optional(),
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
  bio: z.string().max(2000).optional(),
  bioSafe: z.string().max(2000).optional(),
  bioFull: z.string().max(4000).optional(),
  spoilerLevel: z.number().int().min(0).max(3).optional(),
  attributes: z.array(z.record(z.string(), z.unknown())).max(20).optional(),
  sourceRefs: z.array(z.string().max(500)).max(20).optional(),
  reviewStatus: z
    .enum(["unreviewed", "draft", "reviewed", "approved", "rejected", "placeholder"])
    .optional(),
  sourceWork: z.string().max(300).optional(),
  adaptationBoundary: z.string().max(1000).optional(),
  quote: z.string().max(300).optional(),
  categorySlug: z.string().max(80).optional(),
  collectionSlug: z.string().max(80).optional(),
  classKey: z.string().max(80).optional(),
  rarityKey: z.string().max(80).optional(),
  tags: z.array(z.string().max(80)).max(20).optional(),
  credit: z.string().max(300).optional(),
  subjectAssetId: idSchema,
  backgroundAssetId: idSchema.optional(),
  variants: z
    .array(
      z.object({ material: z.string().max(80), effect: z.string().max(80).nullable().optional() }),
    )
    .min(1)
    .max(20),
  sets: z.array(z.string().max(80)).max(10).optional(),
  expectedVersion: z.number().int().positive().optional(),
});
const giftSchema = z.object({
  kind: z.enum(["foil", "card", "opening"]),
  scope: z.enum(["single", "recipients", "bot_members", "platform_members"]),
  userIds: z.array(idSchema).max(500).optional(),
  botId: z.string().min(3).max(80).nullable().optional(),
  amount: z.number().int().positive().max(10000).optional(),
  openings: z.number().int().min(1).max(20).optional(),
  cardId: idSchema.nullable().optional(),
  variantId: idSchema.nullable().optional(),
  message: z.string().max(280).nullable().optional(),
  reason: z.string().min(3).max(500),
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
    if (!["owner", "editor"].includes(ctx.user?.role ?? ""))
      throw new ApiError(
        403,
        "insufficient_role",
        "The represented member cannot read editorial data.",
      );
    return;
  }
  const user = requireUser(ctx);
  if (user.role !== "owner" && !hasCapability(user, "content"))
    throw new ApiError(403, "insufficient_role", "Your Bot role cannot read editorial data.");
}

function ensureContentWrite(ctx: Ctx) {
  if (ctx.actor.type === "agent") {
    requireScope(ctx, "content:write");
    if (!["owner", "editor"].includes(ctx.user?.role ?? ""))
      throw new ApiError(403, "insufficient_role", "The represented member cannot edit content.");
    return;
  }
  const user = requireUser(ctx);
  if (user.role !== "owner" && !hasCapability(user, "content"))
    throw new ApiError(403, "insufficient_role", "Your Bot role cannot edit content.");
}

/**
 * Collection routes have their own authority because a Global Collection Admin
 * is not a Bot role and must not inherit card, economy or platform powers.
 */
function ensureCollectionsRead(ctx: Ctx) {
  if (ctx.user && (ctx.user.platformAdmin || isGlobalCollectionAdmin(ctx.user))) {
    if (ctx.actor.type === "agent") requireScope(ctx, "content:read");
    return;
  }
  ensureContentRead(ctx);
}

function ensureCollectionsWrite(ctx: Ctx) {
  if (ctx.user && (ctx.user.platformAdmin || isGlobalCollectionAdmin(ctx.user))) {
    if (ctx.actor.type === "agent") {
      requireScope(ctx, "content:write");
      if (!canManageGlobalCollections(ctx))
        throw new ApiError(
          403,
          "insufficient_scope",
          "This agent grant cannot change shared collections.",
        );
    }
    return;
  }
  ensureContentWrite(ctx);
}

function ensureStudioCatalogueRead(ctx: Ctx) {
  if (ctx.user && (ctx.user.platformAdmin || isGlobalCollectionAdmin(ctx.user))) {
    if (ctx.actor.type === "agent") requireScope(ctx, "content:read");
    return;
  }
  ensureContentRead(ctx);
}

function ensureEconomyRead(ctx: Ctx) {
  if (ctx.actor.type === "agent") {
    requireScope(ctx, "economy:read");
    if (!["owner", "economy_admin"].includes(ctx.user?.role ?? ""))
      throw new ApiError(
        403,
        "insufficient_role",
        "The represented member cannot read the economy.",
      );
    return;
  }
  const user = requireUser(ctx);
  if (
    user.role !== "owner" &&
    !hasCapability(user, "economy") &&
    !hasCapability(user, "inventory") &&
    !hasCapability(user, "grants")
  ) {
    throw new ApiError(403, "insufficient_role", "Your Bot role cannot read the economy.");
  }
}

function ensureEconomyWrite(ctx: Ctx) {
  if (ctx.actor.type === "agent") {
    requireScope(ctx, "economy:write");
    if (!["owner", "economy_admin"].includes(ctx.user?.role ?? ""))
      throw new ApiError(
        403,
        "insufficient_role",
        "The represented member cannot edit the economy.",
      );
    return;
  }
  const user = requireUser(ctx);
  if (user.role !== "owner" && !hasCapability(user, "economy") && !hasCapability(user, "grants"))
    throw new ApiError(403, "insufficient_role", "Your Bot role cannot edit the economy.");
}

function ensureOwner(ctx: Ctx) {
  if (ctx.actor.type === "agent")
    throw new ApiError(
      403,
      "owner_human_required",
      "This action requires a signed-in human owner.",
    );
  const user = requireUser(ctx);
  if (user.role !== "owner" && !user.platformAdmin)
    throw new ApiError(403, "owner_required", "Only the Bot Owner or Super Admin can do that.");
}

function ensureOps(ctx: Ctx) {
  if (ctx.actor.type === "agent") {
    requireScope(ctx, "ops:read");
    if (!["owner", "editor", "economy_admin"].includes(ctx.user?.role ?? ""))
      throw new ApiError(
        403,
        "insufficient_role",
        "The represented member cannot read operations.",
      );
    return;
  }
  const user = requireUser(ctx);
  if (
    user.role !== "owner" &&
    !hasCapability(user, "content") &&
    !hasCapability(user, "economy") &&
    !hasCapability(user, "grants")
  ) {
    throw new ApiError(403, "insufficient_role", "Your Bot role cannot read operations.");
  }
}

function ensureStepUp(ctx: Ctx): void {
  // Scoped agent credentials are a separate, revocable machine path. They
  // still pass every route-level scope and role check; they cannot impersonate
  // a human for gifts, roles or platform administration.
  if (ctx.actor.type === "agent") return;
  requireRecentStrongAuth(ctx, 30);
}

function playerWrite(ctx: Ctx) {
  requireUser(ctx);
  if (ctx.actor.type === "agent" && !ctx.scopes?.length)
    throw new ApiError(403, "insufficient_scope", "The agent grant has no player scopes.");
}

/**
 * Optional installation scope for headless callers. The installation id is not
 * authority: it must belong to the authenticated tenant, be active and be
 * resolvable by the represented user. A caller that omits it keeps the normal
 * Bot-wide member behaviour.
 */
async function installationScopeFor(
  ctx: Ctx,
  installationId: string | null,
  channelId: string | null,
) {
  if (!installationId) return null;
  const installation = await first<DiscordInstallation>(
    ctx.db,
    `SELECT * FROM fb_discord_installations
      WHERE id = ? AND tenant_id = ? AND active = 1 AND revoked_at IS NULL`,
    installationId,
    ctx.tenant.id,
  );
  if (!installation) {
    throw new ApiError(
      404,
      "discord_installation_missing",
      "That installation is not active for this Bot.",
    );
  }
  if (!installation.game_enabled) {
    throw new ApiError(403, "discord_game_disabled", "Discord gameplay is paused for that installation.");
  }
  return resolveDiscordScope(ctx, installation, channelId);
}

export async function routeApi(request: Request, ctx: Ctx, path: string): Promise<Response> {
  const segments = path.split("/").filter(Boolean);
  const isStudio = segments[0] === "studio";
  if (isStudio) segments[0] = "admin";
  const method = request.method.toUpperCase();
  const url = new URL(request.url);
  const isRead = method === "GET" || method === "HEAD";
  if (!isRead) assertCsrf(ctx, request);

  // Public showcase and member collections
  if (segments[0] === "collections" && segments.length === 1 && method === "GET") {
    const items = ctx.user
      ? (await listCollections(ctx)).filter((item) => item.status === "published")
      : await listPublicCollections(ctx);
    return json({ items });
  }
  if (segments[0] === "collections" && segments[1] && segments.length === 2 && method === "GET") {
    const collection = await getCollection(ctx, segments[1]);
    if (collection.status !== "published")
      throw new ApiError(404, "collection_not_found", "That collection is not published.");
    await recordCollectionExploration(ctx, collection.id);
    return json({
      collection,
      cards: await listCollectionCards(ctx, collection.id),
      progress: await collectionProgress(ctx, collection.id),
    });
  }

  // Public catalogue and pool previews
  if (segments[0] === "catalogue" && segments.length === 1 && method === "GET") {
    const cards = await listCards(ctx, {
      publicOnly: !ctx.user,
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
    if (card.status !== "published")
      throw new ApiError(404, "card_not_found", "That card is not published.");
    const visible = ctx.user
      ? (await listCards(ctx, { viewerScope: true, id: card.id, limit: 1 }))[0]
      : (await listCards(ctx, { publicOnly: true, id: card.id, limit: 1 }))[0];
    if (!visible)
      throw new ApiError(404, "card_not_found", "That card is not available in this album.");
    return json({ card: publicCard(visible) });
  }
  if (segments[0] === "sets" && segments.length === 1 && method === "GET") {
    const sets = (
      await listSets(ctx, ctx.user?.id, ctx.user ? { viewerScope: true } : { publicOnly: true })
    ).filter((set) => set.status === "published");
    return json({ items: sets.map(publicSet) });
  }
  if (segments[0] === "pools" && segments.length === 1 && method === "GET") {
    // Capsule inventory and pricing are member-facing. Anonymous discovery
    // must not enumerate a Bot's pool metadata.
    playerWrite(ctx);
    requireScope(ctx, "inventory:read");
    const scope = await installationScopeFor(
      ctx,
      url.searchParams.get("installation"),
      url.searchParams.get("channel"),
    );
    if (scope?.emptyReason) {
      throw new ApiError(403, "discord_scope_empty", scope.emptyReason);
    }
    // Only pools with real eligible entries for this actor are selectable.
    // Admin/inventory read routes use includeDrafts to inspect all definitions.
    const previews = await listEligiblePools(
      ctx,
      url.searchParams.get("channel") ?? undefined,
      scope ? poolScopeFromDiscord(scope) : undefined,
    );
    return json({
      items: previews.map(({ pool, eligible_count }) => ({
        id: pool.id,
        slug: pool.slug,
        name: pool.name,
        description: pool.description,
        revision: pool.revision,
        price: pool.price,
        status: pool.status,
        eligible_count,
      })),
    });
  }
  if (segments[0] === "pools" && segments[1] && segments.length === 2 && method === "GET") {
    const scope = await installationScopeFor(
      ctx,
      url.searchParams.get("installation"),
      url.searchParams.get("channel"),
    );
    if (scope?.emptyReason) {
      throw new ApiError(403, "discord_scope_empty", scope.emptyReason);
    }
    const preview = await getPoolPreview(
      ctx,
      segments[1],
      url.searchParams.get("channel") ?? undefined,
      scope ? { scope: poolScopeFromDiscord(scope) } : undefined,
    );
    return json(publicPoolPreview(preview));
  }

  // Player and agent-authenticated collection workflows
  if (segments[0] === "me" && segments[1] === "preferences" && method === "GET") {
    playerWrite(ctx);
    requireScope(ctx, "profile:read");
    return json(await getPreferences(ctx));
  }
  if (segments[0] === "me" && segments[1] === "preferences" && method === "PATCH") {
    playerWrite(ctx);
    requireScope(ctx, "profile:write");
    const body = await readJson(
      request,
      z.object({
        hideTags: z.array(z.string().max(80)).max(30).optional(),
        hiddenCollectionIds: z.array(idSchema).max(80).optional(),
        reducedMotion: z.boolean().optional(),
        soundEnabled: z.boolean().optional(),
        sharingEnabled: z.boolean().optional(),
      }),
    );
    return json(await updatePreferences(ctx, body));
  }
  if (segments[0] === "wallet" && segments.length === 1 && method === "GET") {
    const user = requireUser(ctx);
    requireScope(ctx, "economy:read");
    return json(await getWalletSummary(ctx.db, ctx.tenant.id, user.id));
  }
  if (segments[0] === "ledger" && segments.length === 1 && method === "GET") {
    const user = requireUser(ctx);
    requireScope(ctx, "economy:read");
    return json(await getLedger(ctx, user.id, Number(url.searchParams.get("limit") ?? 100)));
  }
  if (segments[0] === "inventory" && segments.length === 1 && method === "GET") {
    playerWrite(ctx);
    requireScope(ctx, "inventory:read");
    const limit = Math.min(120, Math.max(1, Number(url.searchParams.get("limit") ?? 48) || 48));
    const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
    const query = {
      status: url.searchParams.get("status") ?? undefined,
      search: url.searchParams.get("search") ?? undefined,
      favourite: url.searchParams.get("favourite") === "true",
      setSlug: url.searchParams.get("set") ?? undefined,
      collection: url.searchParams.get("collection") ?? undefined,
      limit,
      offset,
    };
    const [items, total] = await Promise.all([
      getInventory(ctx, query),
      countInventory(ctx, query),
    ]);
    return json({ items, total, limit, offset });
  }
  if (segments[0] === "instances" && segments[1] && segments.length === 2 && method === "GET") {
    playerWrite(ctx);
    requireScope(ctx, "inventory:read");
    return json(await getInstance(ctx, segments[1]));
  }
  if (
    segments[0] === "instances" &&
    segments[1] &&
    segments.length === 3 &&
    segments[2] === "favourite" &&
    method === "POST"
  ) {
    playerWrite(ctx);
    requireScope(ctx, "inventory:write");
    const body = await readJson(request, z.object({ favourite: z.boolean() }));
    return json(await toggleFavourite(ctx, segments[1], body.favourite));
  }
  if (segments[0] === "instances" && segments[1] && segments.length === 3 && segments[2] === "lock" && method === "POST") {
    playerWrite(ctx);
    requireScope(ctx, "inventory:write");
    const body = await readJson(request, z.object({ locked: z.boolean() }));
    return json(await setLocked(ctx, segments[1], body.locked));
  }
  if (segments[0] === "members" && segments.length === 1 && method === "GET") {
    playerWrite(ctx);
    requireScope(ctx, "inventory:read");
    return json({ items: await listTenantMembers(ctx) });
  }
  if (
    segments[0] === "members" &&
    segments[1] &&
    segments.length === 3 &&
    segments[2] === "trade-items" &&
    method === "GET"
  ) {
    playerWrite(ctx);
    requireScope(ctx, "inventory:read");
    return json({ items: await getMemberTradeInventory(ctx, segments[1]) });
  }
  if (segments[0] === "wishlist" && segments.length === 1 && method === "GET") {
    playerWrite(ctx);
    requireScope(ctx, "inventory:read");
    return json({ items: await getWishlist(ctx) });
  }
  if (segments[0] === "wishlist" && segments.length === 1 && method === "POST") {
    playerWrite(ctx);
    requireScope(ctx, "inventory:write");
    const body = await readJson(
      request,
      z.object({
        cardId: idSchema,
        wanted: z.boolean(),
        targetVariantId: idSchema.nullable().optional(),
        targetMaterialKey: z.string().max(40).nullable().optional(),
        targetEffectKey: z.string().max(40).nullable().optional(),
      }),
    );
    return json(
      await toggleWishlist(ctx, body.cardId, body.wanted, {
        variantId: body.targetVariantId,
        materialKey: body.targetMaterialKey,
        effectKey: body.targetEffectKey,
      }),
    );
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
      z.object({
        pool: z.string().min(1).max(80),
        expectedRevision: z.number().int().positive(),
        expectedDistribution: z.string().min(16).max(128),
        channelKey: z.string().max(80).optional(),
        installationId: z.string().max(80).optional(),
        channelId: z.string().max(40).optional(),
      }),
    );
    const idempotency = await idempotencyInput(request, body);
    const scope = await installationScopeFor(
      ctx,
      body.installationId ?? null,
      body.channelId ?? null,
    );
    if (scope?.emptyReason) {
      throw new ApiError(403, "discord_scope_empty", scope.emptyReason);
    }
    return json(
      await executeDraw(ctx, {
        pool: body.pool,
        expectedRevision: body.expectedRevision,
        expectedDistribution: body.expectedDistribution,
        // A Discord installation may not have a separate channel_key. The
        // interaction channel is the policy key in that case, and the preview
        // must use the same value or the commit sees a different distribution.
        channelKey: body.channelKey ?? body.channelId,
        scope: scope ? poolScopeFromDiscord(scope) : undefined,
        idempotency,
      }),
    );
  }
  if (segments[0] === "recycle" && segments[1] === "preview" && segments.length === 2 && method === "POST") {
    playerWrite(ctx);
    requireScope(ctx, "inventory:read");
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
  if (segments[0] === "sets" && segments[1] && segments[2] === "claim" && segments.length === 3 && method === "POST") {
    playerWrite(ctx);
    requireScope(ctx, "reward:claim");
    const body = await readJson(request, z.object({}));
    const idempotency = await idempotencyInput(request, body);
    return json(await claimSetCompletion(ctx, segments[1], idempotency.key));
  }
  if (segments[0] === "trades" && segments.length === 1 && method === "GET") {
    playerWrite(ctx);
    requireScope(ctx, "trade:write");
    return json({ items: await listTrades(ctx) });
  }
  if (segments[0] === "trades" && segments.length === 1 && method === "POST") {
    playerWrite(ctx);
    requireScope(ctx, "trade:write");
    const body = await readJson(
      request,
      z.object({
        recipientId: idSchema.optional(),
        recipientEmail: z.string().email().max(320).optional(),
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
    requireScope(ctx, "trade:write");
    return json(await getTrade(ctx, segments[1]));
  }
  if (
    segments[0] === "trades" &&
    segments[1] &&
    ["accept", "decline", "cancel"].includes(segments[2] ?? "") &&
    method === "POST"
  ) {
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
  if (segments[0] === "gifts" && segments.length === 1 && method === "GET") {
    playerWrite(ctx);
    requireScope(ctx, "trade:write");
    return json({ items: await listGifts(ctx) });
  }
  if (segments[0] === "gifts" && segments.length === 1 && method === "POST") {
    playerWrite(ctx);
    requireScope(ctx, "trade:write");
    const body = await readJson(
      request,
      z.object({
        recipientEmail: z.string().email().max(320),
        instanceId: idSchema,
        note: z.string().max(500).optional(),
      }),
    );
    const idempotency = await idempotencyInput(request, body);
    return json(await createGift(ctx, { ...body, idempotencyKey: idempotency.key }));
  }
  if (segments[0] === "me" && segments[1] === "memberships" && segments.length === 2 && method === "GET") {
    playerWrite(ctx);
    requireScope(ctx, "profile:read");
    return json({ items: await getMyMemberships(ctx) });
  }
  if (segments[0] === "me" && segments[1] === "join" && segments.length === 2 && method === "POST") {
    if (ctx.actor.type === "agent") {
      throw new ApiError(403, "human_required", "Album admission is a human decision and cannot be made by an agent grant.");
    }
    return json(await joinMainAlbum(ctx));
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "members" &&
    segments[2] &&
    segments[3] === "status" &&
    method === "POST"
  ) {
    ensureStepUp(ctx);
    const body = await readJson(
      request,
      z.object({
        status: z.enum(["active", "suspended", "revoked"]),
        reason: z.string().min(3).max(500),
      }),
    );
    return json(await setMemberStatus(ctx, segments[2], body.status, body.reason));
  }
  if (segments[0] === "achievements" && segments.length === 1 && method === "GET") {
    playerWrite(ctx);
    requireScope(ctx, "profile:read");
    return json({ items: await listAchievements(ctx) });
  }
  if (segments[0] === "achievements" && segments[1] === "evaluate" && segments.length === 2 && method === "POST") {
    playerWrite(ctx);
    requireScope(ctx, "reward:claim");
    return json(await evaluateAchievements(ctx));
  }
  if (segments[0] === "gifts" && segments[1] === "received" && segments.length === 2 && method === "GET") {
    playerWrite(ctx);
    requireScope(ctx, "trade:write");
    return json({ items: await listMyGiftReceipts(ctx) });
  }
  if (segments[0] === "shares" && segments.length === 1 && method === "GET") {
    playerWrite(ctx);
    requireScope(ctx, "profile:read");
    return json({ items: await listShareLinks(ctx) });
  }
  if (segments[0] === "shares" && segments.length === 1 && method === "POST") {
    playerWrite(ctx);
    requireScope(ctx, "profile:write");
    const body = await readJson(
      request,
      z.object({
        expiresInDays: z.number().int().min(1).max(30).optional(),
        kind: z
          .enum(["card", "collection", "achievement", "wishlist", "latest", "profile"])
          .optional(),
        targetId: idSchema.optional(),
      }),
    );
    return json(await createShareLink(ctx, body));
  }
  if (segments[0] === "shares" && segments[1] && segments[2] === "revoke" && segments.length === 3 && method === "POST") {
    playerWrite(ctx);
    requireScope(ctx, "profile:write");
    return json(await revokeShareLink(ctx, segments[1]));
  }

  // Daily missions: trusted committed events, one claim per mission per UTC day.
  if (segments[0] === "missions" && segments[1] === "daily" && segments.length === 2 && method === "GET") {
    playerWrite(ctx);
    requireScope(ctx, "missions:read");
    return json(await getDailyMissions(ctx));
  }
  if (segments[0] === "missions" && segments[1] === "daily" && segments[2] === "claim" && segments.length === 3 && method === "POST") {
    playerWrite(ctx);
    requireScope(ctx, "missions:claim");
    const body = await readJson(request, z.object({ key: z.string().min(2).max(40) }));
    return json(await claimDailyMission(ctx, body.key, request.headers.get("idempotency-key") ?? undefined));
  }

  // Persistent synthetic NPC collectors. Human-readable lounge views are
  // member-scoped; every mutation is Bot-scoped and capability-checked.
  if (segments[0] === "npcs" && segments.length === 2 && segments[1] === "lounge" && method === "GET") {
    requireNpcRead(ctx);
    return json({ items: await listNpcProfiles(ctx) });
  }
  if (segments[0] === "npcs" && segments.length === 2 && segments[1] === "presets" && method === "GET") {
    requireNpcManager(ctx);
    return json({ items: await listNpcPresets() });
  }
  if (segments[0] === "npcs" && segments.length === 2 && segments[1] === "admin" && method === "GET") {
    return json(await getNpcAdminOverview(ctx));
  }
  if (segments[0] === "npcs" && segments.length === 1 && method === "GET") {
    requireNpcManager(ctx);
    const items = await listNpcs(ctx);
    return json({ items });
  }
  if (segments[0] === "npcs" && segments.length === 1 && method === "POST") {
    requireNpcManager(ctx);
    const body = await readJson(
      request,
      z.object({
        name: z.string().min(2).max(80),
        presetKey: z.string().min(2).max(60),
        bio: z.string().max(500).optional(),
        avatarUrl: z.string().max(500).nullable().optional(),
        goalCollectionId: idSchema.nullable().optional(),
        poolSlug: z.string().max(80).nullable().optional(),
        startingBalance: z.number().int().min(0).max(10000).optional(),
        scheduleEnabled: z.boolean().optional(),
        intervalMinutes: z.number().int().min(15).max(10080).optional(),
      }),
    );
    return json(await createNpc(ctx, body), 201);
  }
  if (segments[0] === "npcs" && segments.length === 2 && segments[1] === "batch" && method === "POST") {
    requireNpcManager(ctx);
    const body = await readJson(
      request,
      z.object({
        presetKeys: z.array(z.string().min(2).max(60)).min(1).max(10),
        prefix: z.string().max(50).optional(),
        goalCollectionId: idSchema.nullable().optional(),
      }),
    );
    return json({ items: await createNpcBatch(ctx, body) }, 201);
  }
  if (segments[0] === "npcs" && segments.length === 2 && segments[1] === "limits" && method === "PATCH") {
    requireNpcManager(ctx);
    const body = await readJson(
      request,
      z.object({
        maxNpcs: z.number().int().min(0).max(100).optional(),
        maxDrawsPerDay: z.number().int().min(0).max(500).optional(),
        pausedAll: z.boolean().optional(),
      }),
    );
    return json(await setNpcLimits(ctx, body));
  }
  if (segments[0] === "npcs" && segments.length === 2 && segments[1] === "run-scheduled" && method === "POST") {
    requireNpcManager(ctx);
    return json(await runDueNpcs(ctx.db, ctx));
  }
  if (segments[0] === "npcs" && segments[1] === "trades" && segments.length === 2 && method === "GET") {
    playerWrite(ctx);
    requireScope(ctx, "trade:write");
    const { listNpcTradeOffers } = await import("../modules/npc-trades");
    return json({items:await listNpcTradeOffers(ctx)});
  }
  if (segments[0] === "npcs" && segments[1] === "trades" && segments[2] && ["confirm","cancel"].includes(segments[3] ?? "") && segments.length === 4 && method === "POST") {
    playerWrite(ctx);
    requireScope(ctx, "trade:write");
    const { confirmNpcTrade, cancelNpcTrade } = await import("../modules/npc-trades");
    return json(await (segments[3] === "confirm" ? confirmNpcTrade(ctx, segments[2]) : cancelNpcTrade(ctx, segments[2])));
  }
  if (segments[0] === "npcs" && segments[1] && segments.length >= 2) {
    const npcId = segments[1];
    if (segments.length === 3 && segments[2] === "trade-preview" && method === "POST") {
      playerWrite(ctx);
      requireScope(ctx, "trade:write");
      const body = await readJson(request, z.object({ offeredInstanceId: idSchema, requestedInstanceId: idSchema }));
      const { previewNpcTrade } = await import("../modules/npc-trade-preview");
      return json(await previewNpcTrade(ctx, npcId, body.offeredInstanceId, body.requestedInstanceId));
    }
    if (segments.length === 3 && segments[2] === "trade-offers" && method === "POST") {
      playerWrite(ctx);
      requireScope(ctx, "trade:write");
      const body = await readJson(request, z.object({ offeredInstanceId: idSchema, requestedInstanceId: idSchema }));
      const key = request.headers.get("idempotency-key")?.trim();
      if (!key) throw new ApiError(400,"idempotency_key_required","Provide an Idempotency-Key header.");
      const { createNpcTradeOffer } = await import("../modules/npc-trades");
      return json(await createNpcTradeOffer(ctx,npcId,body.offeredInstanceId,body.requestedInstanceId,key));
    }
    if (segments.length === 2 && method === "GET") {
      requireNpcRead(ctx);
      return json((await getNpc(ctx, npcId)).summary);
    }
    if (segments.length === 2 && method === "PATCH") {
      requireNpcManager(ctx);
      const body = await readJson(
        request,
        z.object({
          name: z.string().min(2).max(80).optional(),
          bio: z.string().max(500).optional(),
          avatarUrl: z.string().max(500).nullable().optional(),
          presetKey: z.string().min(2).max(60).optional(),
          goalCollectionId: idSchema.nullable().optional(),
          poolSlug: z.string().max(80).nullable().optional(),
          scheduleEnabled: z.boolean().optional(),
          intervalMinutes: z.number().int().min(15).max(10080).optional(),
        }),
      );
      return json(await updateNpc(ctx, npcId, body));
    }
    if (segments.length === 3 && segments[2] === "actions" && method === "GET") {
      return json({ items: await listNpcActions(ctx, npcId) });
    }
    if (segments.length === 3 && segments[2] === "compare" && method === "GET") {
      return json(await compareNpc(ctx, npcId));
    }
    if (segments.length === 3 && segments[2] === "preview" && method === "POST") {
      return json(await previewNpcAction(ctx, npcId));
    }
    if (segments.length === 3 && segments[2] === "play" && method === "POST") {
      const body = await readJson(request, z.object({ idempotencyKey: z.string().min(8).max(200).optional() }).optional());
      return json(await playNpcOnce(ctx, npcId, body?.idempotencyKey));
    }
    if (segments.length === 3 && segments[2] === "run" && method === "POST") {
      const body = await readJson(request, z.object({ count: z.number().int().min(1).max(10).default(1) }));
      return json(await runNpcBatch(ctx, npcId, body.count));
    }
    if (segments.length === 3 && ["pause", "resume", "retire"].includes(segments[2] ?? "") && method === "POST") {
      return json(await setNpcStatus(ctx, npcId, segments[2] === "pause" ? "paused" : segments[2] === "retire" ? "retired" : "active"));
    }
  }

  // Content administration
  if (
    segments[0] === "admin" &&
    segments[1] === "cards" &&
    segments.length === 2 &&
    method === "GET"
  ) {
    if (isStudio) {
      ensureStudioCatalogueRead(ctx);
      if (ctx.user?.platformAdmin || isGlobalCollectionAdmin(ctx.user)) {
        const main = await first<{ id: string; slug: string; name: string }>(
          ctx.db,
          "SELECT id, slug, name FROM fb_tenants WHERE slug = ?",
          ctx.config.tenantSlug,
        );
        const catalogueCtx: Ctx = main ? { ...ctx, tenant: main } : ctx;
        const allCards = await listCards(catalogueCtx, {
          includeDrafts: true,
          search: url.searchParams.get("search") ?? undefined,
          limit: Number(url.searchParams.get("limit") ?? 500),
        });
        const globalIds = await all<{ card_id: string }>(
          ctx.db,
          ctx.user?.globalCollectionScope && !ctx.user.platformAdmin
            ? `SELECT DISTINCT cc.card_id FROM fb_collection_cards cc
                 JOIN fb_collections c ON c.id = cc.collection_id
                WHERE c.scope = 'global' AND c.archived_at IS NULL AND c.id IN (${ctx.user.globalCollectionScope.all ? "SELECT id FROM fb_collections WHERE scope='global'" : ctx.user.globalCollectionScope.collectionIds.map(() => "?").join(",") || "NULL"})`
            : `SELECT DISTINCT cc.card_id FROM fb_collection_cards cc
                 JOIN fb_collections c ON c.id = cc.collection_id
                WHERE c.scope = 'global' AND c.archived_at IS NULL`,
          ...(ctx.user?.globalCollectionScope && !ctx.user.globalCollectionScope.all
            ? ctx.user.globalCollectionScope.collectionIds
            : []),
        );
        const allowed = new Set(globalIds.map((row) => row.card_id));
        return json({ items: allCards.filter((card) => allowed.has(card.id)) });
      }
      return json({
        items: await listCards(ctx, {
          includeDrafts: true,
          search: url.searchParams.get("search") ?? undefined,
          limit: Number(url.searchParams.get("limit") ?? 200),
        }),
      });
    }
    ensureContentRead(ctx);
    return json({
      items: await listCards(ctx, {
        includeDrafts: true,
        search: url.searchParams.get("search") ?? undefined,
        limit: Number(url.searchParams.get("limit") ?? 200),
      }),
    });
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "cards" &&
    segments.length === 2 &&
    method === "POST"
  ) {
    ensureContentWrite(ctx);
    const body = await readJson(request, cardBody);
    const card = await createCard(ctx, body);
    return json({ card }, 201);
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "cards" &&
    segments[2] === "bulk" &&
    method === "POST"
  ) {
    ensureContentWrite(ctx);
    ensureStepUp(ctx);
    const body = await readJson(
      request,
      z.object({
        ids: z.array(idSchema).max(100),
        status: z.enum(["draft", "published", "retired"]),
      }),
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
  if (
    segments[0] === "admin" &&
    segments[1] === "cards" &&
    segments[2] &&
    segments[3] === "editions" &&
    method === "POST"
  ) {
    ensureContentWrite(ctx);
    ensureStepUp(ctx);
    const body = await readJson(
      request,
      z.object({
        name: z.string().min(1).max(160),
        subjectAssetId: idSchema,
        backgroundAssetId: idSchema.nullable().optional(),
        recipeId: idSchema.nullable().optional(),
        materials: z.array(z.string().max(40)).min(1).max(8),
        effects: z.array(z.string().max(40)).max(8).optional(),
        variants: z
          .array(
            z.object({
              material: z.string().max(40),
              effect: z.string().max(40).nullable().optional(),
            }),
          )
          .min(1)
          .max(12)
          .optional(),
        status: z.enum(["draft", "published"]).optional(),
        parentEditionId: idSchema.nullable().optional(),
        composition: z
          .object({
            mode: z.enum(["contain", "fill", "medallion"]).optional(),
            zoom: z.number().min(0.6).max(1.6).optional(),
            offsetX: z.number().min(-20).max(20).optional(),
            offsetY: z.number().min(-20).max(20).optional(),
          })
          .nullable()
          .optional(),
      }),
    );
    return json({ card: await createEditionForCard(ctx, segments[2], body) }, 201);
  }
  // Multi-print proposals. A print is a distinct artwork edition, never a finish
  // rename; approval and edition linking stay separate, audited actions.
  if (
    segments[0] === "admin" &&
    segments[1] === "cards" &&
    segments[2] &&
    segments[3] === "prints" &&
    segments.length === 4
  ) {
    if (method === "GET") {
      ensureContentRead(ctx);
      const [items, coverage] = await Promise.all([
        listPrintProposals(ctx, segments[2]),
        printCoverageForCard(ctx, segments[2]),
      ]);
      return json({ items, coverage });
    }
    if (method === "POST") {
      ensureContentWrite(ctx);
      ensureStepUp(ctx);
      const body = await readJson(
        request,
        z.object({
          printNumber: z.string().min(1).max(8),
          role: z.enum([
            "portrait",
            "action_scene",
            "alternate_art",
            "special_release",
            "ensemble",
            "location",
            "object",
            "other",
          ]),
          title: z.string().min(1).max(160),
          creativeDirection: z.string().min(40).max(4000),
          sourceAssetId: idSchema,
          artworkAssetId: idSchema.nullable().optional(),
          backgroundAssetId: idSchema.nullable().optional(),
          rightsNote: z.string().max(500).nullable().optional(),
          sourceRefs: z.array(z.string().url().max(500)).max(12).optional(),
          provenance: z.record(z.string(), z.unknown()).optional(),
          finishKeys: z.array(z.enum(["plain", "silver", "gold", "holographic"])).max(4).optional(),
          status: z.enum(["draft", "proposed"]).optional(),
        }),
      );
      return json(
        { proposal: await createPrintProposal(ctx, { cardId: segments[2], ...body }) },
        201,
      );
    }
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "prints" &&
    segments[2] &&
    segments.length === 3
  ) {
    if (method === "GET") {
      ensureContentRead(ctx);
      const [proposal, reviews] = await Promise.all([
        getPrintProposal(ctx, segments[2]),
        listPrintProposalReviews(ctx, segments[2]),
      ]);
      return json({ proposal, reviews });
    }
    if (method === "PATCH") {
      ensureContentWrite(ctx);
      ensureStepUp(ctx);
      const body = await readJson(
        request,
        z.object({
          role: z
            .enum([
              "portrait",
              "action_scene",
              "alternate_art",
              "special_release",
              "ensemble",
              "location",
              "object",
              "other",
            ])
            .optional(),
          title: z.string().min(1).max(160).optional(),
          creativeDirection: z.string().min(40).max(4000).optional(),
          sourceAssetId: idSchema.optional(),
          artworkAssetId: idSchema.nullable().optional(),
          backgroundAssetId: idSchema.nullable().optional(),
          rightsNote: z.string().max(500).nullable().optional(),
          sourceRefs: z.array(z.string().url().max(500)).max(12).optional(),
          finishKeys: z.array(z.enum(["plain", "silver", "gold", "holographic"])).max(4).optional(),
          expectedRevision: z.number().int().positive().optional(),
          note: z.string().max(500).optional(),
        }),
      );
      const { expectedRevision, ...input } = body;
      return json({
        proposal: await revisePrintProposal(ctx, segments[2], input, { expectedRevision }),
      });
    }
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "prints" &&
    segments[2] &&
    segments[3] === "submit" &&
    segments.length === 4 &&
    method === "POST"
  ) {
    ensureContentWrite(ctx);
    ensureStepUp(ctx);
    const body = await readJson(
      request,
      z.object({
        expectedRevision: z.number().int().positive().optional(),
        note: z.string().max(500).optional(),
      }),
    );
    return json({
      proposal: await submitPrintProposal(ctx, segments[2], body),
    });
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "prints" &&
    segments[2] &&
    segments[3] === "review" &&
    segments.length === 4 &&
    method === "POST"
  ) {
    ensureContentWrite(ctx);
    ensureStepUp(ctx);
    const body = await readJson(
      request,
      z.object({
        decision: z.enum(["approved", "rejected"]),
        note: z.string().max(1000).optional(),
        expectedRevision: z.number().int().positive().optional(),
      }),
    );
    return json({
      proposal: await reviewPrintProposal(ctx, segments[2], body.decision, body),
    });
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "prints" &&
    segments[2] &&
    segments[3] === "link" &&
    segments.length === 4 &&
    method === "POST"
  ) {
    ensureContentWrite(ctx);
    ensureStepUp(ctx);
    const body = await readJson(
      request,
      z.object({
        editionId: idSchema,
        expectedRevision: z.number().int().positive().optional(),
      }),
    );
    return json({
      proposal: await linkApprovedEdition(ctx, segments[2], body.editionId, {
        expectedRevision: body.expectedRevision,
      }),
    });
  }
  if (segments[0] === "admin" && segments[1] === "recipes" && method === "GET") {
    ensureContentRead(ctx);
    return json({
      items: await all(
        ctx.db,
        "SELECT id, name, version, status, published_at FROM fb_recipes WHERE tenant_id = ? AND status = 'published' ORDER BY version DESC",
        ctx.tenant.id,
      ),
    });
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "cards" &&
    segments[2] &&
    segments[3] === "status" &&
    method === "POST"
  ) {
    ensureContentWrite(ctx);
    ensureStepUp(ctx);
    const body = await readJson(
      request,
      z.object({ status: z.enum(["draft", "published", "retired"]) }),
    );
    return json({ card: await setCardStatus(ctx, segments[2], body.status) });
  }
  if (segments[0] === "admin" && segments[1] === "tenant" && method === "GET") {
    ensureContentRead(ctx);
    return json(await getTenantPublication(ctx));
  }
  if (segments[0] === "admin" && segments[1] === "tenant" && method === "PATCH") {
    ensureContentWrite(ctx);
    const body = await readJson(
      request,
      z.object({
        publicCatalogue: z.boolean().optional(),
        blockedTags: z.array(z.string().max(80)).max(50).optional(),
      }),
    );
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
  if (
    segments[0] === "admin" &&
    segments[1] === "taxonomy" &&
    segments[2] &&
    segments[3] &&
    method === "DELETE"
  ) {
    ensureContentWrite(ctx);
    await archiveTaxonomyItem(ctx, segments[2] as TaxonomyKind, segments[3]);
    return json({ ok: true });
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "sets" &&
    segments.length === 2 &&
    method === "GET"
  ) {
    ensureContentRead(ctx);
    return json({ items: await listSets(ctx) });
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "sets" &&
    segments.length === 2 &&
    method === "POST"
  ) {
    ensureContentWrite(ctx);
    const body = await readJson(
      request,
      z.object({
        slug: z.string().min(1).max(80),
        name: z.string().min(1).max(160),
        description: z.string().max(2000),
        rewardAmount: z.number().int().nonnegative(),
      }),
    );
    return json({ set: await createSet(ctx, body) }, 201);
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "sets" &&
    segments[2] &&
    segments[3] === "members" &&
    method === "PUT"
  ) {
    ensureContentWrite(ctx);
    const body = await readJson(request, z.object({ cardIds: z.array(idSchema).max(200) }));
    return json({ set: await replaceSetMembership(ctx, segments[2], body.cardIds) });
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "sets" &&
    segments[2] &&
    segments[3] === "publish" &&
    method === "POST"
  ) {
    ensureContentWrite(ctx);
    return json({ set: await publishSet(ctx, segments[2]) });
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "catalogue" &&
    segments[2] === "publish" &&
    method === "POST"
  ) {
    ensureContentWrite(ctx);
    ensureStepUp(ctx);
    requireScope(ctx, "catalogue:publish");
    return json(await publishCatalogue(ctx));
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "catalogue" &&
    segments[2] === "status" &&
    method === "GET"
  ) {
    ensureContentRead(ctx);
    return json({ release: await activeRelease(ctx) });
  }

  // Pools
  if (
    segments[0] === "admin" &&
    segments[1] === "pools" &&
    segments.length === 2 &&
    method === "GET"
  ) {
    ensureContentRead(ctx);
    return json({ items: await listPools(ctx, true) });
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "pools" &&
    segments.length === 2 &&
    method === "POST"
  ) {
    ensureContentWrite(ctx);
    const body = await readJson(
      request,
      z.object({
        slug: z.string().min(1).max(80),
        name: z.string().min(1).max(160),
        description: z.string().max(2000),
        price: z.number().int().nonnegative(),
        channelKey: z.string().max(80).optional(),
        entries: z
          .array(z.object({ variantId: idSchema, weight: z.number().int().positive().max(100000) }))
          .min(1)
          .max(300),
      }),
    );
    return json({ pool: await createPool(ctx, body) }, 201);
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "pools" &&
    segments[2] &&
    segments.length === 3 &&
    method === "GET"
  ) {
    ensureContentRead(ctx);
    return json(await getPoolDetail(ctx, segments[2]));
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "pools" &&
    segments[2] &&
    segments.length === 3 &&
    method === "PATCH"
  ) {
    ensureContentWrite(ctx);
    const body = await readJson(
      request,
      z.object({
        expectedRevision: z.number().int().positive(),
        name: z.string().min(1).max(160).optional(),
        description: z.string().max(2000).optional(),
        price: z.number().int().nonnegative().optional(),
        entries: z
          .array(z.object({ variantId: idSchema, weight: z.number().int().positive().max(100000) }))
          .min(1)
          .max(300)
          .optional(),
      }),
    );
    return json({ pool: await updatePool(ctx, segments[2], body) });
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "pools" &&
    segments[2] &&
    segments[3] === "publish" &&
    method === "POST"
  ) {
    ensureContentWrite(ctx);
    return json({ pool: await publishPool(ctx, segments[2]) });
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "pools" &&
    segments[2] &&
    segments[3] === "retire" &&
    method === "POST"
  ) {
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
    ensureStepUp(ctx);
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
          .object({
            rarity: z.record(z.string(), z.number().int().nonnegative()),
            material: z.record(z.string(), z.number().int().nonnegative()),
          })
          .optional(),
      }),
    );
    return json(await updateEconomy(ctx, body));
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "wallets" &&
    segments[2] &&
    segments[3] === "adjust" &&
    method === "POST"
  ) {
    ensureEconomyWrite(ctx);
    ensureStepUp(ctx);
    const body = await readJson(
      request,
      z.object({
        amount: z
          .number()
          .int()
          .refine((value) => value !== 0),
        reason: z.string().min(3).max(500),
      }),
    );
    const idempotency = await idempotencyInput(request, body);
    return json(
      await adjustWallet(ctx, {
        userId: segments[2],
        amount: body.amount,
        reason: body.reason,
        idempotency,
      }),
    );
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "wallets" &&
    segments[2] &&
    method === "GET" &&
    segments.length === 3
  ) {
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
  if (
    segments[0] === "admin" &&
    segments[1] === "agents" &&
    segments[2] &&
    segments[3] === "revoke" &&
    method === "POST"
  ) {
    ensureOwner(ctx);
    await revokeAgentGrant(ctx, segments[2]);
    return json({ ok: true });
  }
  if (segments[0] === "admin" && segments[1] === "members" && method === "GET") {
    ensureOps(ctx);
    return json({ items: await listMembers(ctx) });
  }

  // Assets, imports and render jobs
  if (
    segments[0] === "admin" &&
    segments[1] === "assets" &&
    segments.length === 2 &&
    method === "GET"
  ) {
    ensureCollectionsRead(ctx);
    return json({
      items: await listAssets(ctx, (url.searchParams.get("kind") as AssetKind) ?? undefined),
    });
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "assets" &&
    segments.length === 2 &&
    method === "POST"
  ) {
    ensureCollectionsWrite(ctx);
    ensureStepUp(ctx);
    requireScope(ctx, "import:write");
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new ApiError(422, "file_required", "Upload an image file.");
    const kind = String(form.get("kind") ?? "subject") as AssetKind;
    if (
      ctx.user &&
      isGlobalCollectionAdmin(ctx.user) &&
      !ctx.user.platformAdmin &&
      kind !== "brand"
    ) {
      throw new ApiError(
        403,
        "asset_scope_invalid",
        "A Global Collection Admin can upload collection branding only.",
      );
    }
    if (!["subject", "background", "frame", "material", "effect", "brand"].includes(kind)) {
      throw new ApiError(422, "kind_invalid", "Unsupported asset kind.");
    }
    const asset = await uploadAsset(ctx, {
      kind,
      name: String(form.get("name") ?? file.name ?? "Asset"),
      bytes: new Uint8Array(await file.arrayBuffer()),
      declaredMime: file.type || undefined,
      visibility:
        String(form.get("access") ?? "private") === "public" ? "public_export" : "private",
      accessClassification:
        String(form.get("access") ?? "private") === "public"
          ? "public"
          : String(form.get("access") ?? "private") === "member"
            ? "member"
            : "private",
      role: form.get("role") ? String(form.get("role")) : undefined,
      official: String(form.get("official") ?? "0") === "1",
      reviewStatus: (
        ["unreviewed", "reviewed", "approved", "rejected", "placeholder"] as const
      ).includes(String(form.get("reviewStatus") ?? "") as never)
        ? (String(form.get("reviewStatus")) as
            "unreviewed" | "reviewed" | "approved" | "rejected" | "placeholder")
        : "unreviewed",
      provenance: {
        note: String(
          form.get("provenance") ?? "Original Foilbury interpretation. Not official artwork.",
        ),
      },
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
  if (
    segments[0] === "admin" &&
    segments[1] === "variants" &&
    segments[2] &&
    segments[3] === "back" &&
    method === "POST"
  ) {
    ensureContentWrite(ctx);
    requireScope(ctx, "render:write");
    const form = await request.formData();
    const file = form.get("back");
    if (!(file instanceof File))
      throw new ApiError(422, "file_required", "Upload the rendered card back.");
    const variant = await first<{ recipe_id: string }>(
      ctx.db,
      `SELECT e.recipe_id FROM fb_variants v JOIN fb_artwork_editions e ON e.id = v.edition_id
        WHERE v.id = ? AND v.tenant_id = ?`,
      segments[2],
      ctx.tenant.id,
    );
    if (!variant) throw new ApiError(404, "variant_not_found", "Variant not found.");
    const { createBackRenderAsset } = await import("../modules/assets");
    return json(
      await createBackRenderAsset(ctx, {
        variantId: segments[2],
        recipeId: variant.recipe_id,
        bytes: new Uint8Array(await file.arrayBuffer()),
      }),
      201,
    );
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "assets" &&
    segments[2] &&
    segments[3] === "derivatives" &&
    method === "POST"
  ) {
    ensureContentWrite(ctx);
    requireScope(ctx, "render:write");
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File))
      throw new ApiError(422, "file_required", "Upload the derivative image.");
    const sizeKey = String(form.get("sizeKey") ?? "thumb");
    if (!["thumb", "preview", "detail"].includes(sizeKey))
      throw new ApiError(422, "size_invalid", "Unknown derivative size.");
    const { createDerivative } = await import("../modules/assets");
    return json(
      await createDerivative(ctx, {
        sourceAssetId: segments[2],
        sizeKey: sizeKey as "thumb" | "preview" | "detail",
        bytes: new Uint8Array(await file.arrayBuffer()),
      }),
      201,
    );
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "assets" &&
    segments[2] &&
    segments[3] === "bytes" &&
    method === "GET"
  ) {
    ensureContentRead(ctx);
    const asset = await getAsset(ctx, segments[2]);
    const { readAsset } = await import("../modules/assets");
    const bytes = await readAsset(ctx.media, asset);
    return new Response(bytes, {
      headers: {
        "content-type": asset.mime,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "imports" &&
    segments[2] === "preview" &&
    method === "POST"
  ) {
    ensureContentRead(ctx);
    const body = await readJson(request, importManifest);
    return json(await previewImport(ctx, body));
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "imports" &&
    segments.length === 2 &&
    method === "GET"
  ) {
    ensureContentRead(ctx);
    return json({
      runs: await importRuns(ctx),
    });
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "imports" &&
    segments.length === 2 &&
    method === "POST"
  ) {
    ensureContentWrite(ctx);
    requireScope(ctx, "import:write");
    const body = await readJson(request, importManifest);
    return json(await commitImport(ctx, body));
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "renders" &&
    segments[2] === "queue" &&
    method === "POST"
  ) {
    ensureContentWrite(ctx);
    requireScope(ctx, "render:write");
    const body = await readJson(request, z.object({ force: z.boolean().optional() })).catch(() => ({
      force: false,
    }));
    return json(await createRenderJobs(ctx, { force: Boolean(body?.force) }));
  }
  if (segments[0] === "admin" && segments[1] === "jobs" && method === "GET") {
    ensureOps(ctx);
    return json({ items: await listRenderJobs(ctx, url.searchParams.get("status") ?? undefined) });
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "jobs" &&
    segments[2] &&
    segments[3] === "claim" &&
    method === "POST"
  ) {
    ensureOps(ctx);
    requireScope(ctx, "render:write");
    return json({
      job: await claimRenderJob(ctx, segments[2] === "next" ? undefined : segments[2]),
    });
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "jobs" &&
    segments[2] &&
    segments[3] === "complete" &&
    method === "POST"
  ) {
    ensureOps(ctx);
    requireScope(ctx, "render:write");
    const form = await request.formData();
    const file = form.get("file");
    const back = form.get("back");
    const attempt = Number(form.get("attempt"));
    if (!(file instanceof File))
      throw new ApiError(422, "file_required", "Upload the rendered card image.");
    if (!Number.isInteger(attempt) || attempt < 1) {
      throw new ApiError(422, "attempt_required", "Send the attempt number returned by claim.");
    }
    return json(
      await completeRenderJob(
        ctx,
        segments[2],
        new Uint8Array(await file.arrayBuffer()),
        back instanceof File ? new Uint8Array(await back.arrayBuffer()) : undefined,
        attempt,
      ),
    );
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "jobs" &&
    segments[2] &&
    segments[3] === "fail" &&
    method === "POST"
  ) {
    ensureOps(ctx);
    requireScope(ctx, "render:write");
    const body = await readJson(
      request,
      z.object({
        message: z.string().min(1).max(500),
        attempt: z.number().int().min(1),
      }),
    );
    return json(await failRenderJob(ctx, segments[2], body.message, body.attempt));
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "generation" &&
    segments[2] === "plan" &&
    method === "POST"
  ) {
    ensureContentWrite(ctx);
    const body = await readJson(
      request,
      z.object({
        prompt: z.string().min(1).max(4000),
        model: z.string().min(1).max(100).optional(),
        count: z.number().int().min(1).max(10).optional(),
      }),
    );
    const idempotency = await idempotencyInput(request, body);
    return json(await planGeneration(ctx, { ...body, idempotencyKey: idempotency.key }), 201);
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "generation" &&
    segments[2] === "jobs" &&
    segments.length === 3 &&
    method === "GET"
  ) {
    ensureContentRead(ctx);
    return json({ items: await listGenerationJobs(ctx) });
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "generation" &&
    segments[2] === "jobs" &&
    segments[3] &&
    segments.length === 4 &&
    method === "GET"
  ) {
    ensureContentRead(ctx);
    return json(await getGenerationJob(ctx, segments[3]));
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "generation" &&
    segments[2] === "jobs" &&
    segments[3] &&
    segments[4] === "submit" &&
    method === "POST"
  ) {
    ensureContentWrite(ctx);
    return json(await submitGeneration(ctx, segments[3]));
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "generation" &&
    segments[2] === "jobs" &&
    segments[3] &&
    segments[4] === "review" &&
    method === "POST"
  ) {
    ensureContentWrite(ctx);
    const body = await readJson(request, z.object({ decision: z.enum(["approve", "reject"]) }));
    return json(await reviewGeneration(ctx, segments[3], body.decision));
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "generation" &&
    segments[2] === "jobs" &&
    segments[3] &&
    segments[4] === "adopt" &&
    method === "POST"
  ) {
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
      z.object({
        channelKey: z.string().min(1).max(80),
        name: z.string().min(1).max(160),
        excludeTags: z.array(z.string().max(80)).max(30),
      }),
    );
    return json({ policy: await createTopicPolicy(ctx, body) }, 201);
  }
  if (segments[0] === "admin" && segments[1] === "topics" && segments[2] && method === "PATCH") {
    ensureContentWrite(ctx);
    const body = await readJson(request, z.object({ active: z.boolean() }));
    await setTopicPolicyActive(ctx, segments[2], body.active);
    return json({ ok: true });
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "backup" &&
    segments[2] === "manifest" &&
    method === "GET"
  ) {
    ensureOps(ctx);
    return json(await backupManifest(ctx));
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "outbox" &&
    segments[2] === "process" &&
    method === "POST"
  ) {
    ensureOps(ctx);
    return json(await processOutbox(ctx));
  }
  if (
    (segments[0] === "ops" || segments[0] === "admin") &&
    segments[1] === "status" &&
    method === "GET"
  ) {
    ensureOps(ctx);
    return json(await operationsStatus(ctx));
  }

  // Bots and delegated administration
  if (segments[0] === "bots" && segments.length === 1 && method === "GET") {
    const user = requireUser(ctx);
    return json({ items: await listBotsForUser(ctx.db, user.id) });
  }
  if (segments[0] === "bots" && segments.length === 1 && method === "POST") {
    ensureStepUp(ctx);
    const body = await readJson(
      request,
      z.object({
        name: z.string().min(2).max(80),
        slug: z.string().min(2).max(60).optional(),
        description: z.string().max(500).optional(),
      }),
    );
    const result = await createBot(ctx, body);
    return json(result, result.created ? 201 : 200);
  }
  if (segments[0] === "invitations" && segments[1] === "accept" && method === "POST") {
    const body = await readJson(request, z.object({ token: z.string().min(20).max(300) }));
    return json(await acceptBotInvitation(ctx, body.token));
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "bot" &&
    segments.length === 2 &&
    method === "GET"
  ) {
    ensureOps(ctx);
    const { botForTenant } = await import("../modules/bots");
    const bot = await botForTenant(ctx.db, ctx.tenant.id);
    if (!bot)
      throw new ApiError(404, "bot_not_found", "No Bot is attached to this administration area.");
    return json({
      bot,
      aiArtEnabled: Number(bot.ai_art_enabled ?? 0) === 1,
      admins: await listBotAdmins(ctx, bot.id),
      invitations: await listBotInvitations(ctx, bot.id),
      current_role: ctx.user?.platformAdmin
        ? "Super Admin"
        : ctx.user?.role === "owner"
          ? "Bot Owner"
          : "Bot Admin",
    });
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "bot" &&
    segments.length === 2 &&
    method === "PATCH"
  ) {
    ensureContentWrite(ctx);
    const body = await readJson(
      request,
      z.object({
        aiArtEnabled: z.boolean(),
      }),
    );
    const { botForTenant } = await import("../modules/bots");
    const bot = await botForTenant(ctx.db, ctx.tenant.id);
    if (!bot)
      throw new ApiError(404, "bot_not_found", "No Bot is attached to this administration area.");
    await ctx.db.batch([
      ctx.db
        .prepare("UPDATE fb_bots SET ai_art_enabled = ?, updated_at = ? WHERE id = ? AND tenant_id = ?")
        .bind(body.aiArtEnabled ? 1 : 0, nowIso(), bot.id, ctx.tenant.id),
      ctx.db
        .prepare(
          `INSERT INTO fb_audit_events
            (id, tenant_id, actor_type, actor_id, represented_user_id, action, object_type, object_id, metadata_json, request_id, created_at)
           VALUES (?, ?, ?, ?, ?, 'bot.ai_art.updated', 'bot', ?, ?, ?, ?)`,
        )
        .bind(
          newId("aud"),
          ctx.tenant.id,
          ctx.actor.type,
          ctx.actor.id,
          ctx.actor.representedUserId ?? null,
          bot.id,
          JSON.stringify({ ai_art_enabled: body.aiArtEnabled }),
          ctx.requestId,
          nowIso(),
        ),
    ]);
    return json({ bot: { ...bot, ai_art_enabled: body.aiArtEnabled ? 1 : 0 }, aiArtEnabled: body.aiArtEnabled });
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "bot" &&
    segments[2] === "invitations" &&
    method === "POST"
  ) {
    ensureStepUp(ctx);
    const { botForTenant } = await import("../modules/bots");
    const bot = await botForTenant(ctx.db, ctx.tenant.id);
    if (!bot)
      throw new ApiError(404, "bot_not_found", "No Bot is attached to this administration area.");
    const body = await readJson(
      request,
      z.object({
        email: z.string().email().max(320),
        capabilities: z.array(z.string().max(40)).min(1).max(10),
        expiresInDays: z.number().int().min(1).max(30).optional(),
      }),
    );
    return json(await createBotInvitation(ctx, { botId: bot.id, ...body }), 201);
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "bot" &&
    segments[2] === "admins" &&
    segments[3] &&
    segments.length === 4 &&
    method === "PATCH"
  ) {
    ensureOwner(ctx);
    ensureStepUp(ctx);
    const { botForTenant } = await import("../modules/bots");
    const { validateCapabilities } = await import("../modules/bots");
    const bot = await botForTenant(ctx.db, ctx.tenant.id);
    if (!bot)
      throw new ApiError(404, "bot_not_found", "No Bot is attached to this administration area.");
    const targetUserId = segments[3]!;
    if (targetUserId === bot.owner_user_id) {
      throw new ApiError(422, "owner_capability_fixed", "The Bot Owner's authority is not edited as a Bot Admin grant.");
    }
    const body = await readJson(
      request,
      z.object({
        capabilities: z.array(z.string().max(40)).min(1).max(12),
        selfGrantsEnabled: z.boolean(),
        grantLimit: z.number().int().min(0).max(5000),
        reason: z.string().min(3).max(500),
      }),
    );
    const capabilities = validateCapabilities(body.capabilities);
    if (body.selfGrantsEnabled && !capabilities.includes("grants")) {
      throw new ApiError(
        422,
        "self_grants_requires_grants",
        "Enable the grant capability before enabling self-grants.",
      );
    }
    const existing = await first<{ role: string }>(
      ctx.db,
      "SELECT role FROM fb_memberships WHERE tenant_id = ? AND user_id = ? AND status = 'active'",
      ctx.tenant.id,
      targetUserId,
    );
    if (!existing) throw new ApiError(404, "admin_not_found", "That Bot Admin was not found.");
    const now = nowIso();
    const updated = await ctx.db.batch([
      ctx.db
        .prepare(
          `UPDATE fb_memberships
              SET capabilities_json = ?, self_grants_enabled = ?, grant_limit = ?,
                  capability_revision = capability_revision + 1
            WHERE tenant_id = ? AND user_id = ? AND status = 'active'`,
        )
        .bind(
          JSON.stringify(capabilities),
          body.selfGrantsEnabled ? 1 : 0,
          body.grantLimit,
          ctx.tenant.id,
          targetUserId,
        ),
      ctx.db
        .prepare(
          `UPDATE fb_bot_admins
              SET capabilities_json = ?
            WHERE bot_id = ? AND user_id = ? AND status = 'active'`,
        )
        .bind(JSON.stringify(capabilities), bot.id, targetUserId),
      ctx.db
        .prepare(
          `INSERT INTO fb_audit_events
            (id, tenant_id, actor_type, actor_id, represented_user_id, action, object_type, object_id,
             metadata_json, request_id, created_at)
           VALUES (?, ?, 'user', ?, ?, 'bot.admin.capabilities.updated', 'bot_admin', ?, ?, ?, ?)`,
        )
        .bind(
          newId("aud"),
          ctx.tenant.id,
          ctx.user!.id,
          ctx.user!.id,
          targetUserId,
          JSON.stringify({
            capabilities,
            self_grants_enabled: body.selfGrantsEnabled,
            grant_limit: body.grantLimit,
            reason: body.reason.trim(),
          }),
          ctx.requestId,
          now,
        ),
    ]);
    if ((updated[0]?.meta?.changes ?? 0) !== 1) {
      throw new ApiError(409, "admin_not_found", "That Bot Admin was not updated; reload the team.");
    }
    return json({
      ok: true,
      capabilities,
      self_grants_enabled: body.selfGrantsEnabled,
      grant_limit: body.grantLimit,
    });
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "bot" &&
    segments[2] === "admins" &&
    segments[3] &&
    segments[4] === "revoke" &&
    method === "POST"
  ) {
    ensureStepUp(ctx);
    const { botForTenant } = await import("../modules/bots");
    const bot = await botForTenant(ctx.db, ctx.tenant.id);
    if (!bot)
      throw new ApiError(404, "bot_not_found", "No Bot is attached to this administration area.");
    await revokeBotAdmin(ctx, bot.id, segments[3]!);
    return json({ ok: true });
  }

  // Collections (global and Bot-scoped)
  if (
    segments[0] === "admin" &&
    segments[1] === "collections" &&
    segments.length === 2 &&
    method === "GET"
  ) {
    ensureCollectionsRead(ctx);
    return json({ items: await listCollections(ctx, { includeAll: true }) });
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "collections" &&
    segments.length === 2 &&
    method === "POST"
  ) {
    ensureCollectionsWrite(ctx);
    ensureStepUp(ctx);
    const body = await readJson(
      request,
      z.object({
        name: z.string().min(2).max(120),
        slug: z.string().min(2).max(60).optional(),
        description: z.string().max(1000).optional(),
        scope: z.enum(["global", "bot"]).default("bot"),
        logoUrl: z.string().max(500).optional(),
        bannerUrl: z.string().max(500).optional(),
        backUrl: z.string().max(500).optional(),
        accent: z.string().max(30).optional(),
        status: z.enum(["draft", "published"]).optional(),
        viewAudience: z.enum(["public", "members", "private"]).optional(),
        sourceWork: z.string().max(500).optional(),
        sourceContext: z.string().max(4000).optional(),
        contentAdvisory: z.string().max(1000).optional(),
        featured: z.boolean().optional(),
      }),
    );
    return json({ collection: await createCollection(ctx, body) }, 201);
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "collections" &&
    segments[2] &&
    segments.length === 3 &&
    method === "GET"
  ) {
    ensureCollectionsRead(ctx);
    return json({
      collection: await getCollection(ctx, segments[2]),
      cards: await listCollectionCards(ctx, segments[2]),
    });
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "collections" &&
    segments[2] &&
    segments.length === 3 &&
    method === "PATCH"
  ) {
    ensureCollectionsWrite(ctx);
    ensureStepUp(ctx);
    const body = await readJson(
      request,
      z.object({
        name: z.string().min(2).max(120).optional(),
        description: z.string().max(1000).optional(),
        logoUrl: z.string().max(500).nullable().optional(),
        bannerUrl: z.string().max(500).nullable().optional(),
        backUrl: z.string().max(500).nullable().optional(),
        accent: z.string().max(30).optional(),
        status: z.enum(["draft", "published", "archived"]).optional(),
        sort: z.number().int().min(0).max(10000).optional(),
        viewAudience: z.enum(["public", "members", "private"]).optional(),
        sourceWork: z.string().max(500).nullable().optional(),
        sourceContext: z.string().max(4000).nullable().optional(),
        contentAdvisory: z.string().max(1000).nullable().optional(),
        featured: z.boolean().optional(),
        expectedVersion: z.number().int().positive().optional(),
      }),
    );
    return json({ collection: await updateCollection(ctx, segments[2], body) });
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "collections" &&
    segments[2] &&
    segments[3] === "cards" &&
    method === "POST"
  ) {
    ensureCollectionsWrite(ctx);
    ensureStepUp(ctx);
    const body = await readJson(request, z.object({ cardIds: z.array(idSchema).min(1).max(300) }));
    return json(await addCollectionCards(ctx, segments[2], body.cardIds));
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "collections" &&
    segments[2] &&
    segments[3] === "cards" &&
    segments[4] &&
    method === "DELETE"
  ) {
    ensureCollectionsWrite(ctx);
    ensureStepUp(ctx);
    await removeCollectionCard(ctx, segments[2], segments[4]);
    return json({ ok: true });
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "collections" &&
    segments[2] &&
    segments[3] === "enable" &&
    method === "POST"
  ) {
    ensureContentWrite(ctx);
    ensureStepUp(ctx);
    const body = await readJson(request, z.object({ enabled: z.boolean() }));
    await enableCollection(ctx, segments[2], body.enabled);
    return json({ ok: true });
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "collections" &&
    segments[2] &&
    segments[3] === "viewers" &&
    method === "GET"
  ) {
    ensureCollectionsRead(ctx);
    return json({ items: await listCollectionViewers(ctx, segments[2]) });
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "collections" &&
    segments[2] &&
    segments[3] === "viewers" &&
    method === "POST"
  ) {
    ensureCollectionsWrite(ctx);
    ensureStepUp(ctx);
    const body = await readJson(request, z.object({ userIds: z.array(idSchema).max(500) }));
    return json(await setCollectionViewers(ctx, segments[2], body.userIds));
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "collections" &&
    segments[2] &&
    segments[3] === "progress" &&
    method === "GET"
  ) {
    ensureCollectionsRead(ctx);
    return json(await collectionProgress(ctx, segments[2]));
  }

  // Achievements and administrator gifts
  if (
    segments[0] === "admin" &&
    segments[1] === "achievements" &&
    segments.length === 2 &&
    method === "GET"
  ) {
    ensureContentRead(ctx);
    return json({ items: await listAchievements(ctx, ctx.user?.id) });
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "achievements" &&
    segments[2] === "backfill" &&
    method === "POST"
  ) {
    ensureContentWrite(ctx);
    ensureStepUp(ctx);
    const limit = Math.min(2000, Math.max(1, Number(url.searchParams.get("limit") ?? 500) || 500));
    const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
    return json(await backfillAchievements(ctx, limit, offset));
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "achievements" &&
    segments.length === 2 &&
    method === "POST"
  ) {
    ensureContentWrite(ctx);
    ensureStepUp(ctx);
    const body = await readJson(
      request,
      z.object({
        scope: z.enum(["platform", "bot"]).default("bot"),
        key: z.string().min(2).max(80),
        name: z.string().min(2).max(160),
        description: z.string().min(2).max(500),
        criteria: z.record(z.string(), z.unknown()),
        reward: z.record(z.string(), z.unknown()).optional(),
        visibility: z.enum(["public", "member", "private"]).optional(),
        artKey: z.string().max(80).optional(),
        category: z.string().max(40).optional(),
      }),
    );
    return json({ id: await createAchievement(ctx, body) }, 201);
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "gifts" &&
    segments.length === 2 &&
    method === "GET"
  ) {
    ensureEconomyRead(ctx);
    return json({ items: await listAdminGiftCampaigns(ctx) });
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "gifts" &&
    segments[2] === "preview" &&
    method === "POST"
  ) {
    ensureEconomyWrite(ctx);
    const body = await readJson(request, giftSchema);
    return json(
      await previewAdminGift(ctx, {
        ...body,
        idempotency: { key: "gift-preview", digest: "gift-preview" },
      }),
    );
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "gifts" &&
    segments.length === 2 &&
    method === "POST"
  ) {
    ensureEconomyWrite(ctx);
    ensureStepUp(ctx);
    const body = await readJson(request, giftSchema);
    return json(
      await sendAdminGift(ctx, { ...body, idempotency: await idempotencyInput(request, body) }),
      201,
    );
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "gifts" &&
    segments[2] &&
    segments[3] === "retry" &&
    method === "POST"
  ) {
    ensureEconomyWrite(ctx);
    ensureStepUp(ctx);
    return json(await processGiftCampaign(ctx, segments[2]));
  }

  // Platform Administration. Access admission is never treated as a role.
  if (segments[0] === "platform" && segments[1] === "overview" && method === "GET") {
    requireSuperAdmin(ctx);
    const counts = await first<Record<string, number>>(
      ctx.db,
      `SELECT
      (SELECT COUNT(*) FROM fb_users) AS users,
      (SELECT COUNT(*) FROM fb_bots WHERE status <> 'archived') AS bots,
      (SELECT COUNT(*) FROM fb_tenants) AS tenants,
      (SELECT COUNT(*) FROM fb_discord_installations WHERE active = 1) AS installations,
      (SELECT COUNT(*) FROM fb_card_definitions WHERE archived_at IS NULL) AS cards,
      (SELECT COUNT(*) FROM fb_card_instances WHERE status = 'owned') AS owned_instances,
      (SELECT COUNT(*) FROM fb_ledger_entries) AS ledger_entries,
      (SELECT COUNT(*) FROM fb_platform_admins WHERE status = 'active') AS super_admins,
      (SELECT COUNT(*) FROM fb_platform_role_assignments WHERE status = 'active') AS global_collection_admins,
      (SELECT COUNT(*) FROM fb_bot_invitations WHERE status = 'pending' AND expires_at > datetime('now')) AS pending_invitations`,
    );
    const bots = await all<Record<string, unknown>>(
      ctx.db,
      `SELECT b.id, b.name, b.slug, b.status, b.created_at, t.id AS tenant_id, t.slug AS tenant_slug,
              u.email AS owner_email, u.display_name AS owner_name,
              (SELECT COUNT(*) FROM fb_discord_installations i WHERE i.bot_id = b.id AND i.active = 1) AS installations,
              (SELECT COUNT(*) FROM fb_card_definitions cd WHERE cd.tenant_id = b.tenant_id AND cd.archived_at IS NULL) AS cards
         FROM fb_bots b JOIN fb_tenants t ON t.id = b.tenant_id JOIN fb_users u ON u.id = b.owner_user_id
        ORDER BY b.created_at`,
    );
    const installations = await all<Record<string, unknown>>(
      ctx.db,
      `SELECT i.*, b.name AS bot_name, t.slug AS tenant_slug FROM fb_discord_installations i
         JOIN fb_bots b ON b.id = i.bot_id JOIN fb_tenants t ON t.id = i.tenant_id ORDER BY i.created_at DESC`,
    );
    const access = await all<Record<string, unknown>>(
      ctx.db,
      `SELECT ai.id, ai.email, ai.team_domain, ai.subject, ai.linked_at, ai.last_seen_at, u.id AS user_id, u.display_name
         FROM fb_access_identities ai JOIN fb_users u ON u.id = ai.user_id WHERE ai.revoked_at IS NULL ORDER BY ai.linked_at DESC`,
    );
    const admins = await all<Record<string, unknown>>(
      ctx.db,
      `SELECT pa.user_id, pa.provisioned_at, pa.reason, pa.status, u.email, u.display_name
         FROM fb_platform_admins pa JOIN fb_users u ON u.id = pa.user_id WHERE pa.status = 'active'`,
    );
    const audit = await all<Record<string, unknown>>(
      ctx.db,
      `SELECT id, action, object_type, object_id, actor_type, actor_id, metadata_json, created_at
         FROM fb_audit_events ORDER BY created_at DESC LIMIT 50`,
    );
    return json({ counts, bots, installations, access, admins, audit, current_user: ctx.user });
  }
  if (segments[0] === "platform" && segments[1] === "accounts" && method === "GET") {
    requireSuperAdmin(ctx);
    const accounts = await all<Record<string, unknown>>(
      ctx.db,
      `SELECT u.id, u.email, u.display_name, u.platform_admin, u.email_verified_at, u.created_at, u.disabled_at,
              (SELECT COUNT(*) FROM fb_memberships m WHERE m.user_id = u.id AND m.status = 'active') AS memberships,
              (SELECT COUNT(*) FROM fb_discord_identities d WHERE d.user_id = u.id AND d.revoked_at IS NULL) AS discord_links,
              (SELECT COUNT(*) FROM fb_webauthn_credentials p WHERE p.user_id = u.id) AS passkeys,
              (SELECT COUNT(*) FROM fb_access_identities a WHERE a.user_id = u.id AND a.revoked_at IS NULL) AS access_links
         FROM fb_users u ORDER BY u.created_at`,
    );
    return json({ items: accounts });
  }
  if (segments[0] === "platform" && segments[1] === "people" && method === "GET") {
    requireSuperAdmin(ctx);
    return json({
      items: await listPlatformPeople(ctx, {
        search: url.searchParams.get("search") ?? undefined,
        role: url.searchParams.get("role") ?? undefined,
      }),
      roles: SCOPED_PLATFORM_ROLES,
    });
  }
  if (
    segments[0] === "platform" &&
    segments[1] === "roles" &&
    segments.length === 2 &&
    method === "GET"
  ) {
    requireSuperAdmin(ctx);
    return json({ items: await listPlatformRoleAssignments(ctx) });
  }
  if (
    segments[0] === "platform" &&
    segments[1] === "roles" &&
    segments.length === 2 &&
    method === "POST"
  ) {
    requireSuperAdmin(ctx);
    ensureStepUp(ctx);
    const body = await readJson(
      request,
      z.object({
        userId: idSchema,
        role: z.enum(SCOPED_PLATFORM_ROLES),
        scopes: z
          .object({
            all: z.boolean().optional(),
            collectionIds: z.array(idSchema).max(200).optional(),
          })
          .optional(),
        reason: z.string().min(3).max(500),
      }),
    );
    return json(await assignPlatformRole(ctx, body), 201);
  }
  if (
    segments[0] === "platform" &&
    segments[1] === "roles" &&
    segments[2] &&
    segments[3] === "revoke" &&
    method === "POST"
  ) {
    requireSuperAdmin(ctx);
    ensureStepUp(ctx);
    const body = await readJson(
      request,
      z.object({
        role: z.enum(SCOPED_PLATFORM_ROLES),
        reason: z.string().min(3).max(500),
      }),
    );
    return json(await revokePlatformRole(ctx, segments[2], body.role, body.reason));
  }
  if (
    segments[0] === "platform" &&
    segments[1] === "installations" &&
    segments[2] &&
    method === "PATCH"
  ) {
    requireSuperAdmin(ctx);
    ensureStepUp(ctx);
    const body = await readJson(
      request,
      z.object({
        channelAllowlist: z
          .array(z.string().regex(/^\d{15,22}$/))
          .max(20)
          .optional(),
        gameEnabled: z.boolean().optional(),
        websiteEnabled: z.boolean().optional(),
        apiEnabled: z.boolean().optional(),
        publicCatalogueEnabled: z.boolean().optional(),
        adminGuiEnabled: z.boolean().optional(),
        active: z.boolean().optional(),
      }),
    );
    const installation = await first<{ id: string }>(
      ctx.db,
      "SELECT id FROM fb_discord_installations WHERE id = ?",
      segments[2],
    );
    if (!installation)
      throw new ApiError(404, "installation_not_found", "That installation does not exist.");
    const fields: string[] = [];
    const values: unknown[] = [];
    if (body.channelAllowlist !== undefined) {
      fields.push("channel_allowlist_json = ?");
      values.push(JSON.stringify(body.channelAllowlist));
    }
    for (const key of [
      "gameEnabled",
      "websiteEnabled",
      "apiEnabled",
      "publicCatalogueEnabled",
      "adminGuiEnabled",
      "active",
    ] as const) {
      if (body[key] !== undefined) {
        fields.push(`${key.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase())} = ?`);
        values.push(body[key] ? 1 : 0);
      }
    }
    if (!fields.length) return json({ ok: true });
    fields.push("updated_at = ?");
    values.push(nowIso(), installation.id);
    await ctx.db
      .prepare(`UPDATE fb_discord_installations SET ${fields.join(", ")} WHERE id = ?`)
      .bind(...values)
      .run();
    await ctx.db
      .prepare(
        `INSERT INTO fb_audit_events (id, tenant_id, actor_type, actor_id, represented_user_id, action, object_type, object_id, metadata_json, request_id, created_at)
       VALUES (?, ?, 'user', ?, ?, 'platform.installation.updated', 'discord_installation', ?, ?, ?, ?)`,
      )
      .bind(
        newId("aud"),
        ctx.tenant.id,
        ctx.user!.id,
        ctx.user!.id,
        installation.id,
        JSON.stringify(body),
        ctx.requestId,
        nowIso(),
      )
      .run();
    return json({ ok: true });
  }
  if (
    segments[0] === "platform" &&
    segments[1] === "bots" &&
    segments[2] &&
    segments[3] === "status" &&
    method === "POST"
  ) {
    requireSuperAdmin(ctx);
    ensureStepUp(ctx);
    const body = await readJson(
      request,
      z.object({ status: z.enum(["active", "paused", "archived"]) }),
    );
    const bot = await first<{ id: string; tenant_id: string }>(
      ctx.db,
      "SELECT id, tenant_id FROM fb_bots WHERE id = ?",
      segments[2],
    );
    if (!bot) throw new ApiError(404, "bot_not_found", "That Bot does not exist.");
    await ctx.db
      .prepare("UPDATE fb_bots SET status = ?, updated_at = ? WHERE id = ?")
      .bind(body.status, nowIso(), bot.id)
      .run();
    await ctx.db
      .prepare(
        `INSERT INTO fb_audit_events (id, tenant_id, actor_type, actor_id, represented_user_id, action, object_type, object_id, metadata_json, request_id, created_at)
       VALUES (?, ?, 'user', ?, ?, 'platform.bot.status', 'bot', ?, ?, ?, ?)`,
      )
      .bind(
        newId("aud"),
        bot.tenant_id,
        ctx.user!.id,
        ctx.user!.id,
        bot.id,
        JSON.stringify({ status: body.status }),
        ctx.requestId,
        nowIso(),
      )
      .run();
    return json({ ok: true, status: body.status });
  }
  if (
    segments[0] === "platform" &&
    segments[1] === "collections" &&
    segments.length === 2 &&
    method === "GET"
  ) {
    requireSuperAdmin(ctx);
    const items = (await listCollections(ctx, { includeArchived: true })).filter(
      (collection) => collection.scope === "global",
    );
    return json({ items });
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
      collections: entry.collections,
    })),
    filters: preview.filters,
    pity: preview.pity,
    currency: preview.currency,
    expected_revision: preview.expected_revision,
    distribution_fingerprint: preview.distribution_fingerprint,
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
