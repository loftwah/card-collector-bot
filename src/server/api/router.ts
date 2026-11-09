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
import { listCardNameAliases, replaceCardNameAliases } from "../modules/card-name-aliases";
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
  readAuthorizedScopedDrawReplay,
  recoverScopedDrawFailure,
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
  recordCardInspection,
  getInventory,
  getMemberTradeInventory,
  getWishlist,
  listTenantMembers,
  recycleCommit,
  cancelRecycle,
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
import { abandonCollectionBrandUpload, approveCollectionBrandRelease, previewCollectionBrandRelease, getAsset, listAssets, uploadAsset, uploadCollectionBrand, type AssetKind } from "../modules/assets";
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
  recordCollectionExploration,
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
  reconcileNpcAction,
  reconcileNpcActionById,
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
  expectedOpeningPrice: z.number().int().positive().optional(),
  expectedPoolRevision: z.number().int().positive().optional(),
  expectedRecipientsDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
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
    if (!ctx.user?.agentBotCapabilities?.includes("content"))
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
    if (!ctx.user?.agentBotCapabilities?.includes("content"))
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
    if (!ctx.user?.agentBotCapabilities?.some((capability) => ["economy", "inventory", "grants"].includes(capability)))
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
    if (!ctx.user?.agentBotCapabilities?.some((capability) => ["economy", "grants"].includes(capability)))
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
    if (!ctx.user?.agentBotCapabilities?.some((capability) => ["content", "economy", "grants"].includes(capability)))
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
  const {requireAllowedInstallationChannel}=await import('../discord/context');
  requireAllowedInstallationChannel(installation,channelId);
  const scope=await resolveDiscordScope(ctx, installation, channelId);
  return {...scope,installationSnapshot:{id:installation.id,revision:Number(installation.configuration_revision ?? 1),botId:installation.bot_id ?? null,channelAllowlist:installation.channel_allowlist_json,collectionAllowlist:installation.collection_allowlist_json ?? null,channelAudience:installation.channel_audience_json ?? null,channelKey:installation.channel_key ?? null}};
}

export async function routeApi(request: Request, ctx: Ctx, path: string): Promise<Response> {
  // The catch-all parameter has no leading slash. Preserve a single trailing
  // slash, but do not collapse empty segments into a different endpoint.
  if (path.startsWith('/') || path.includes('//')) throw new ApiError(404, 'not_found', 'That API endpoint was not found.');
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
    return json({
      collection,
      cards: await listCollectionCards(ctx, collection.id),
      progress: ctx.actor.type === "agent" && !ctx.scopes?.includes("inventory:read")
        ? null : await collectionProgress(ctx, collection.id),
    });
  }
  if (segments[0] === "collections" && segments[1] && segments.length === 3 && segments[2] === "explore" && method === "POST") {
    playerWrite(ctx);
    return json(await recordCollectionExploration(ctx, segments[1]));
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
  if (segments[0] === "cards" && segments[1] && segments.length === 2 && method === "GET") {
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
    const preview = await getPoolPreview(
      ctx,
      segments[1],
      url.searchParams.get("channel") ?? undefined,
      scope ? { scope: poolScopeFromDiscord(scope) } : undefined,
    );
    return json(publicPoolPreview(preview));
  }

  // Player and agent-authenticated collection workflows
  if (segments[0] === "me" && segments[1] === "preferences" && segments.length === 2 && method === "GET") {
    playerWrite(ctx);
    requireScope(ctx, "profile:read");
    return json(await getPreferences(ctx));
  }
  if (segments[0] === "me" && segments[1] === "preferences" && segments.length === 2 && method === "PATCH") {
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
  if (segments[0] === "instances" && segments[1] && segments.length === 3 && segments[2] === "inspect" && method === "POST") {
    playerWrite(ctx);
    return json(await recordCardInspection(ctx, segments[1]));
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
  if (segments[0] === "rewards" && segments[1] === "claim" && segments.length === 2 && method === "POST") {
    playerWrite(ctx);
    requireScope(ctx, "reward:claim");
    const body = await readJson(request, z.object({}));
    const idempotency = await idempotencyInput(request, body);
    return json(await claimDailyReward(ctx, idempotency));
  }
  if (segments[0] === "draws" && segments.length === 1 && method === "POST") {
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
    let scope: Awaited<ReturnType<typeof installationScopeFor>>;
    try {
      if (body.installationId) {
        const replay=await readAuthorizedScopedDrawReplay(ctx,idempotency);
        if (replay) return json(replay);
      }
      scope = await installationScopeFor(ctx, body.installationId ?? null, body.channelId ?? null);
      if (scope?.emptyReason) throw new ApiError(403, "discord_scope_empty", scope.emptyReason);
    } catch (error) {
      if (!body.installationId) throw error;
      return json(await recoverScopedDrawFailure(ctx, idempotency, error));
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
        discordInstallation: scope?.installationSnapshot,
        authorizedReplayOnly: Boolean(scope),
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
  if (segments[0] === 'recycle' && segments[1] === 'cancel' && segments.length === 2 && method === 'POST') {
    playerWrite(ctx);
    requireScope(ctx,'recycle:write');
    const body=await readJson(request,z.object({instanceId:idSchema,expectedCredit:z.number().int().nonnegative()}));
    const idempotency=await idempotencyInput(request,body);
    return json(await cancelRecycle(ctx,{instanceId:body.instanceId,expectedCredit:body.expectedCredit,idempotencyKey:idempotency.key}));
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
    const body = await readJson(request, z.object({ memberReleaseId: idSchema.optional() }));
    const idempotency = await idempotencyInput(request, body);
    if (body.memberReleaseId) {
      const { claimMemberSetCompletion } = await import("../modules/member-set-releases");
      return json(await claimMemberSetCompletion(ctx, segments[1], body.memberReleaseId, idempotency.key));
    }
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
    segments.length === 3 &&
    method === "POST"
  ) {
    playerWrite(ctx);
    requireScope(ctx, "trade:write");
    const action = segments[2];
    if (action === "accept") return json(await acceptTrade(ctx, segments[1]));
    if (action === "decline") return json(await declineTrade(ctx, segments[1]));
    return json(await cancelTrade(ctx, segments[1]));
  }
  if (segments[0] === "trades" && segments[1] === "expire" && segments.length === 2 && method === "POST") {
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
    segments.length === 4 &&
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
  if (segments[0] === "npcs" && segments[1] && segments.length >= 2) {
    const npcId = segments[1];
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
    if (segments.length === 3 && segments[2] === "reconcile" && method === "POST") {
      const body = await readJson(request, z.union([
        z.object({ idempotencyKey: z.string().min(8).max(200) }).strict(),
        z.object({ actionId: z.string().min(1).max(200) }).strict(),
      ]));
      return json('actionId' in body ? await reconcileNpcActionById(ctx, npcId, body.actionId) : await reconcileNpcAction(ctx, npcId, body.idempotencyKey));
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
    segments.length === 3 &&
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
  if (segments[0] === "admin" && segments[1] === "cards" && segments[2] && segments[3] === "aliases" && segments.length === 4) {
    if (method === "GET") return json(await listCardNameAliases(ctx, segments[2]));
    if (method === "PUT") {
      requireRecentStrongAuth(ctx, 30);
      const body = await readJson(request, z.object({ expectedVersion: z.number().int().positive(), aliases: z.array(z.string().max(160)).max(20) }));
      return json(await replaceCardNameAliases(ctx, segments[2], body.expectedVersion, body.aliases));
    }
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
    segments.length === 4 &&
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
  if (segments[0] === "admin" && segments[1] === "recipes" && segments.length === 2 && method === "GET") {
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
    segments.length === 4 &&
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
  if (segments[0] === "admin" && segments[1] === "tenant" && segments.length === 2 && method === "GET") {
    ensureContentRead(ctx);
    return json(await getTenantPublication(ctx));
  }
  if (segments[0] === "admin" && segments[1] === "tenant" && segments.length === 2 && method === "PATCH") {
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
  if (segments[0] === "admin" && segments[1] === "taxonomy" && segments.length === 2 && method === "GET") {
    ensureContentRead(ctx);
    return json(await getTaxonomy(ctx));
  }
  if (segments[0] === "admin" && segments[1] === "taxonomy" && segments.length === 2 && method === "POST") {
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
    segments.length === 4 &&
    method === "DELETE"
  ) {
    ensureContentWrite(ctx);
    await archiveTaxonomyItem(ctx, segments[2] as TaxonomyKind, segments[3]);
    return json({ ok: true });
  }
  if (segments[0] === "platform" && segments[1] === "public-set-review-candidates" && segments.length === 2 && method === "GET") {
    const { listPublicSetReviewCandidates } = await import("../modules/public-set-releases");
    return json(await listPublicSetReviewCandidates(ctx));
  }
  if ((segments[0] === "admin" || segments[0] === "platform") && segments[1] === "sets" && segments[2] && segments[3] === "public-reviews" && segments.length === 4 && method === "GET") {
    const { listPublicSetReviews } = await import("../modules/public-set-releases");
    return json(await listPublicSetReviews(ctx, segments[2]));
  }
  if (segments[0] === "admin" && segments[1] === "sets" && segments[2] && segments[3] === "member-reviews" && segments.length === 4 && method === "GET") {
    const { listMemberSetReviews } = await import("../modules/member-set-releases");
    return json(await listMemberSetReviews(ctx, segments[2]));
  }
  if (segments[0] === "admin" && segments[1] === "sets" && segments[2] && segments[3] === "member-review" && segments.length === 4) {
    const { previewMemberSetRelease, approveMemberSetRelease } = await import("../modules/member-set-releases");
    if (method === "GET") return json(await previewMemberSetRelease(ctx, segments[2]));
    if (method === "POST") {
      const body = await readJson(request, z.object({ snapshotHash: z.string().regex(/^[a-f0-9]{64}$/) }));
      return json(await approveMemberSetRelease(ctx, segments[2], body.snapshotHash), 201);
    }
  }
  if (segments[0] === "admin" && segments[1] === "member-set-releases" && segments[2] && segments[3] === "revoke" && segments.length === 4 && method === "POST") {
    const { revokeMemberSetRelease } = await import("../modules/member-set-releases");
    return json(await revokeMemberSetRelease(ctx, segments[2]));
  }
  if ((segments[0] === "admin" || segments[0] === "platform") && segments[1] === "sets" && segments[2] && segments[3] === "public-review" && segments.length === 4) {
    const { previewPublicSetRelease, approvePublicSetRelease } = await import("../modules/public-set-releases");
    if (method === "GET") return json(await previewPublicSetRelease(ctx, segments[2]));
    if (method === "POST") {
      const body = await readJson(request, z.object({ snapshotHash: z.string().regex(/^[a-f0-9]{64}$/), note: z.string().min(20).max(2000) }));
      return json(await approvePublicSetRelease(ctx, segments[2], body.snapshotHash, body.note), 201);
    }
  }
  if ((segments[0] === "admin" || segments[0] === "platform") && segments[1] === "public-set-releases" && segments[2] && segments[3] === "revoke" && segments.length === 4 && method === "POST") {
    const body = await readJson(request, z.object({ reason: z.string().min(20).max(2000) }));
    const { revokePublicSetRelease } = await import("../modules/public-set-releases");
    return json(await revokePublicSetRelease(ctx, segments[2], body.reason));
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "sets" &&
    segments.length === 2 &&
    method === "GET"
  ) {
    ensureContentRead(ctx);
    const { listManagedSets } = await import("../modules/set-management");
    return json({ items: await listManagedSets(ctx) });
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
    segments.length === 4 &&
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
    segments.length === 4 &&
    method === "POST"
  ) {
    ensureContentWrite(ctx);
    return json({ set: await publishSet(ctx, segments[2]) });
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "catalogue" &&
    segments[2] === "publish" &&
    segments.length === 3 &&
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
    segments.length === 3 &&
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
    segments.length === 4 &&
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
    segments.length === 4 &&
    method === "POST"
  ) {
    ensureContentWrite(ctx);
    await retirePool(ctx, segments[2]);
    return json({ ok: true });
  }

  // Economy and wallet administration
  if (segments[0] === "admin" && segments[1] === "economy" && segments.length === 2 && method === "GET") {
    ensureEconomyRead(ctx);
    return json(await getEconomy(ctx));
  }
  if (segments[0] === "admin" && segments[1] === "economy" && segments.length === 2 && method === "PATCH") {
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
    segments.length === 4 &&
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
  if (segments[0] === "admin" && segments[1] === "audit" && segments.length === 2 && method === "GET") {
    ensureEconomyRead(ctx);
    return json({ items: await listAudit(ctx, Number(url.searchParams.get("limit") ?? 100)) });
  }

  // Agents and members
  if (segments[0] === "admin" && segments[1] === "agents" && segments.length === 2 && method === "GET") {
    ensureOwner(ctx);
    return json({ items: await listAgentGrants(ctx) });
  }
  if (segments[0] === "admin" && segments[1] === "agents" && segments.length === 2 && method === "POST") {
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
    segments.length === 4 &&
    method === "POST"
  ) {
    ensureOwner(ctx);
    await revokeAgentGrant(ctx, segments[2]);
    return json({ ok: true });
  }
  if (segments[0] === "admin" && segments[1] === "members" && segments.length === 2 && method === "GET") {
    if (ctx.actor.type === "agent") requireScope(ctx, "ops:read");
    return json({ items: await listMembers(ctx) });
  }

  // Assets, imports and render jobs
  if (segments[0]==='admin' && segments[1]==='assets' && segments[2]==='uploads' && segments[3]==='abandon' && segments.length===4 && method==='POST') {
    ensureCollectionsWrite(ctx);ensureStepUp(ctx);requireScope(ctx,'import:write');
    const body=await readJson(request,z.object({key:z.string().min(8).max(200),scope:z.enum(['global','bot'])}));
    await abandonCollectionBrandUpload(ctx,body.key,body.scope);
    return json({ok:true});
  }
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
    const collectionScope=form.get('collectionScope');
    if (collectionScope !== null) {
      const uploadKey=request.headers.get('idempotency-key');
      const access=String(form.get('access') ?? 'private');
      if (kind!=='brand' || (collectionScope!=='global' && collectionScope!=='bot') || !uploadKey || !['public','member','private'].includes(access))
        throw new ApiError(422,'brand_upload_invalid','A collection image requires a scope and request key.');
      const asset=await uploadCollectionBrand(ctx,{bytes:new Uint8Array(await file.arrayBuffer()),declaredMime:file.type || undefined,name:String(form.get('name') ?? file.name),role:String(form.get('role') ?? ''),scope:collectionScope,access:access as 'public'|'member'|'private',provenance:String(form.get('provenance') ?? '')},uploadKey);
      return json({asset},201);
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
    segments.length === 4 &&
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
    segments.length === 4 &&
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
    segments.length === 4 &&
    method === "GET"
  ) {
    ensureContentRead(ctx);
    const asset = await getAsset(ctx, segments[2]);
    if (asset.r2_key.startsWith('collection-brand-v1/')) throw new ApiError(404,'asset_not_found','Asset not found.');
    if (asset.r2_key.startsWith('bound-render-stage-v1/')) {
      const { serveAsset } = await import('../../pages/media/asset/[id]');
      return serveAsset(ctx,asset.id);
    }
    const { readAsset } = await import("../modules/assets");
    const bytes = await readAsset(ctx.media, asset, ctx.db);
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
    segments.length === 3 &&
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
    segments.length === 3 &&
    method === "POST"
  ) {
    ensureContentWrite(ctx);
    requireScope(ctx, "render:write");
    const body = await readJson(request, z.object({ force: z.boolean().optional() })).catch(() => ({
      force: false,
    }));
    return json(await createRenderJobs(ctx, { force: Boolean(body?.force) }));
  }
  if (segments[0] === "admin" && segments[1] === "jobs" && segments.length === 2 && method === "GET") {
    ensureOps(ctx);
    return json({ items: await listRenderJobs(ctx, url.searchParams.get("status") ?? undefined) });
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "jobs" &&
    segments[2] &&
    segments[3] === "claim" &&
    segments.length === 4 &&
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
    segments.length === 4 &&
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
    segments.length === 4 &&
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
    segments.length === 3 &&
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
    segments.length === 5 &&
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
    segments.length === 5 &&
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
    segments.length === 5 &&
    method === "POST"
  ) {
    ensureContentWrite(ctx);
    return json(await adoptGeneration(ctx, segments[3]));
  }

  // Topics and operations
  if (segments[0] === "admin" && segments[1] === "topics" && segments.length === 2 && method === "GET") {
    ensureContentRead(ctx);
    return json({ items: await listTopicPolicies(ctx) });
  }
  if (segments[0] === "admin" && segments[1] === "topics" && segments.length === 2 && method === "POST") {
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
  if (segments[0] === "admin" && segments[1] === "topics" && segments[2] && segments.length === 3 && method === "PATCH") {
    ensureContentWrite(ctx);
    const body = await readJson(request, z.object({ active: z.boolean() }));
    await setTopicPolicyActive(ctx, segments[2], body.active);
    return json({ ok: true });
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "backup" &&
    segments[2] === "visible-summary" &&
    segments.length === 3 &&
    method === "GET"
  ) {
    requireScope(ctx,'inventory:read');
    const {visibleOwnerInventorySummary}=await import('../modules/collection');
    return json(await visibleOwnerInventorySummary(ctx));
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "backup" &&
    segments[2] === "manifest" &&
    segments.length === 3 &&
    method === "GET"
  ) {
    requireScope(ctx, 'ops:read');
    return json(await backupManifest(ctx));
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "outbox" &&
    segments[2] === "process" &&
    segments.length === 3 &&
    method === "POST"
  ) {
    ensureOps(ctx);
    return json(await processOutbox(ctx));
  }
  if (
    (segments[0] === "ops" || segments[0] === "admin") &&
    segments[1] === "status" &&
    segments.length === 2 &&
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
  if (segments[0] === "invitations" && segments[1] === "accept" && segments.length === 2 && method === "POST") {
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
    segments.length === 3 &&
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
    if (ctx.actor.type !== 'user' || ctx.actor.id !== ctx.user?.id || ctx.actor.representedUserId !== ctx.user.id)
      throw new ApiError(403, 'owner_required', 'Only the signed-in Bot Owner or Super Admin can do that.');
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
    const existing = await first<{ role: string; capability_revision: number; capabilities_json: string | null; self_grants_enabled: number; grant_limit: number; grant_id: string | null; grant_role: string | null; grant_status: string | null; grant_revoked_at: string | null; grant_capabilities: string | null }>(
      ctx.db,
      `SELECT m.role,m.capability_revision,m.capabilities_json,m.self_grants_enabled,m.grant_limit,ba.id AS grant_id,ba.role AS grant_role,ba.status AS grant_status,ba.revoked_at AS grant_revoked_at,ba.capabilities_json AS grant_capabilities
       FROM fb_memberships m LEFT JOIN fb_bot_admins ba ON ba.bot_id=? AND ba.user_id=m.user_id
       WHERE m.tenant_id=? AND m.user_id=? AND m.status='active' AND m.revoked_at IS NULL`,
      bot.id,
      ctx.tenant.id,
      targetUserId,
    );
    if (!existing) throw new ApiError(404, "admin_not_found", "That Bot Admin was not found.");
    if (existing.role === 'owner') throw new ApiError(422, 'owner_capability_fixed', "The Bot Owner's authority is not edited as a Bot Admin grant.");
    if (existing.grant_id && (existing.grant_role !== 'admin' || existing.grant_status !== 'active' || existing.grant_revoked_at))
      throw new ApiError(409, 'admin_changed', 'This administrator grant is no longer active. Reload the team.');
    const now = nowIso();
    try {
    await ctx.db.batch([
      ctx.db
        .prepare(
          `UPDATE fb_memberships
              SET capabilities_json = ?, self_grants_enabled = ?, grant_limit = ?,
                  capability_revision = capability_revision + 1
            WHERE tenant_id = ? AND user_id = ? AND status = 'active' AND revoked_at IS NULL
              AND role = ? AND role <> 'owner' AND capability_revision = ? AND capabilities_json IS ? AND self_grants_enabled IS ? AND grant_limit IS ?
              AND EXISTS (SELECT 1 FROM fb_users target_user WHERE target_user.id=fb_memberships.user_id AND target_user.disabled_at IS NULL)
              AND EXISTS (SELECT 1 FROM fb_bots b JOIN fb_memberships actor ON actor.tenant_id=b.tenant_id AND actor.user_id=? AND actor.status='active' AND actor.revoked_at IS NULL
                JOIN fb_users u ON u.id=actor.user_id AND u.disabled_at IS NULL
                JOIN fb_sessions s ON s.id=? AND s.user_id=u.id AND s.tenant_id=actor.tenant_id AND s.revoked_at IS NULL
                  AND s.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND s.assurance=? AND s.assurance IN ('passkey','mfa')
                  AND s.auth_time>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 minutes') AND s.auth_time<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
                WHERE b.id=? AND b.tenant_id=? AND b.status='active' AND b.owner_user_id<>?
                  AND ((actor.role='owner' AND b.owner_user_id=u.id) OR (u.platform_admin=1 AND EXISTS (SELECT 1 FROM fb_platform_admins pa WHERE pa.user_id=u.id AND pa.status='active' AND pa.revoked_at IS NULL))))
              AND ((? IS NULL AND NOT EXISTS (SELECT 1 FROM fb_bot_admins ba WHERE ba.bot_id=? AND ba.user_id=?))
                OR EXISTS (SELECT 1 FROM fb_bot_admins ba WHERE ba.id=? AND ba.bot_id=? AND ba.user_id=? AND ba.role IS ? AND ba.status IS ? AND ba.revoked_at IS ? AND ba.capabilities_json IS ?))`,
        )
        .bind(
          JSON.stringify(capabilities),
          body.selfGrantsEnabled ? 1 : 0,
          body.grantLimit,
          ctx.tenant.id,
          targetUserId,
          existing.role,existing.capability_revision,existing.capabilities_json,existing.self_grants_enabled,existing.grant_limit,
          ctx.user!.id,ctx.sessionId,ctx.sessionAssurance,bot.id,ctx.tenant.id,targetUserId,
          existing.grant_id,bot.id,targetUserId,existing.grant_id,bot.id,targetUserId,existing.grant_role,existing.grant_status,existing.grant_revoked_at,existing.grant_capabilities,
        ),
      ctx.db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json('admin_not_found') END"),
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
    } catch (error) {
      if (String(error).includes('malformed JSON')) throw new ApiError(409, "admin_changed", "The team or your access changed. Reload before updating this administrator.");
      throw error;
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
    segments.length === 5 &&
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

  if (segments[0] === "admin" && segments[1] === "local-subject-drafts" && segments.length === 2 && method === "POST") {
    ensureContentWrite(ctx);
    ensureStepUp(ctx);
    const body = await readJson(request, z.object({ recordJson: z.string().max(50000), sha256: z.string().regex(/^[a-f0-9]{64}$/) }));
    const { importLocalSubjectDraft } = await import("../modules/local-subject-import");
    return json(await importLocalSubjectDraft(ctx, body), 201);
  }

  // Collections (global and Bot-scoped)
  if (segments[0] === 'admin' && segments[1] === 'collections' && segments[2] === 'brand-reference-index' && segments[3] === 'reconcile' && segments.length === 4 && method === 'POST') {
    ensureCollectionsWrite(ctx);ensureStepUp(ctx);
    const {reconcileBrandUrlIndex}=await import('../modules/collections');
    const body=await readJson(request,z.object({collectionId:z.string().min(1).max(200).optional()}));
    return json(await reconcileBrandUrlIndex(ctx,body.collectionId));
  }
  if (segments[0] === 'admin' && segments[1] === 'collections' && segments[2] === 'brand-reference-index' && segments[3] === 'rebuild' && segments.length === 4 && method === 'POST') {
    ensureCollectionsWrite(ctx);ensureStepUp(ctx);
    const {startBrandUrlRebuild}=await import('../modules/collections');
    return json(await startBrandUrlRebuild(ctx));
  }
  if (segments[0] === 'admin' && segments[1] === 'collections' && segments[2] === 'brand-reference-index' && segments[3] === 'issues' && segments.length === 4 && method === 'GET') {
    ensureCollectionsWrite(ctx);ensureStepUp(ctx);
    const {listBrandUrlIssues}=await import('../modules/collections');
    return json(await listBrandUrlIssues(ctx));
  }
  if (segments[0] === 'admin' && segments[1] === 'collections' && segments[2] === 'brand-reference-index' && segments[3] === 'clear' && segments.length === 4 && method === 'POST') {
    ensureCollectionsWrite(ctx);ensureStepUp(ctx);
    const body=await readJson(request,z.object({collectionId:z.string().min(1).max(200),slot:z.enum(['logo','banner','back']),collectionVersion:z.number().int().positive()}));
    const {clearBrandUrlIssue}=await import('../modules/collections');
    await clearBrandUrlIssue(ctx,body.collectionId,body.slot,body.collectionVersion);
    return json({ok:true});
  }
  if (segments[0] === 'admin' && segments[1] === 'collections' && segments[2] && segments[3] === 'brand-release' && segments.length === 4 && method === 'GET') {
    ensureCollectionsWrite(ctx);ensureStepUp(ctx);
    const assetId=url.searchParams.get('assetId');
    if (!assetId || assetId.length>200) throw new ApiError(422,'brand_release_invalid','Choose an image to review.');
    return json({review:await previewCollectionBrandRelease(ctx,segments[2],assetId)});
  }
  if (segments[0] === 'admin' && segments[1] === 'collections' && segments[2] && segments[3] === 'brand-release' && segments.length === 4 && method === 'POST') {
    ensureCollectionsWrite(ctx);
    ensureStepUp(ctx);
    const body=await readJson(request,z.object({assetId:z.string().min(1).max(200),collectionVersion:z.number().int().positive(),assetRevision:z.number().int().positive(),objectVersion:z.string().min(1).max(200),sha256:z.string().regex(/^[a-f0-9]{64}$/)}));
    await approveCollectionBrandRelease(ctx,segments[2],body.assetId,body.collectionVersion,body.sha256,body.assetRevision,body.objectVersion);
    return json({ok:true});
  }
  if (segments[0] === "admin" && segments[1] === "collections" && segments[2] && segments[3] === "art-reviews" && segments.length === 4 && method === "POST") {
    const selection = z.object({ id: z.string().min(1).max(100), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
    const body = await readJson(request, z.object({
      decision: z.enum(["approved", "rejected"]), note: z.string().min(20).max(2000),
      mark: selection, cover: selection, back: selection, evidence: selection,
    }));
    const { recordCollectionArtReview } = await import("../modules/collection-art-reviews");
    return json(await recordCollectionArtReview(ctx, segments[2], body), 201);
  }
  if (segments[0] === "admin" && segments[1] === "discord-installations" && segments[2] && segments[3] === "availability" && segments.length === 4 && method === "PATCH") {
    if (ctx.actor.type === "agent") throw new ApiError(403, "human_auth_required", "Server availability changes require a signed-in administrator.");
    requireUser(ctx);
    ensureStepUp(ctx);
    const body = await readJson(request,z.object({revision:z.number().int().positive(),surface:z.literal('game'),enabled:z.boolean()}));
    const {updateDiscordInstallationAvailability}=await import('../modules/discord-installation-settings');
    return json(await updateDiscordInstallationAvailability(ctx,segments[2],body));
  }
  if (segments[0] === "admin" && segments[1] === "discord-installations" && (segments.length === 2 || (segments.length === 3 && method === "PATCH"))) {
    if (method === "GET" && segments.length === 2) {
      if (ctx.actor.type === 'agent') ensureContentRead(ctx);
      else requireUser(ctx);
      const { listDiscordInstallationSettings } = await import("../modules/discord-installation-settings");
      return json(await listDiscordInstallationSettings(ctx));
    }
    if (method === "PATCH" && segments[2]) {
      ensureContentWrite(ctx);
      if (ctx.actor.type === "agent") throw new ApiError(403, "human_auth_required", "Server collection changes require a signed-in administrator with recent strong authentication.");
      ensureStepUp(ctx);
      const body = await readJson(request, z.object({
        revision: z.number().int().positive(),
        collectionIds: z.array(z.string().min(1).max(100)).max(500).nullable(),
      }));
      const { updateDiscordInstallationSettings } = await import("../modules/discord-installation-settings");
      return json(await updateDiscordInstallationSettings(ctx, segments[2], body));
    }
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "collections" &&
    segments[2] === "recovery" && segments[3] && segments.length === 4 && method === "GET"
  ) {
    ensureCollectionsWrite(ctx);
    ensureStepUp(ctx);
    const {recoverCollectionCreation}=await import('../modules/collections');
    return json(await recoverCollectionCreation(ctx,segments[3]));
  }
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
    const idempotency = request.headers.has('idempotency-key') ? await idempotencyInput(request,body) : undefined;
    return json({ collection: await createCollection(ctx, body,idempotency) }, 201);
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
    segments.length === 4 &&
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
    segments.length === 5 &&
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
    segments.length === 4 &&
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
    segments.length === 4 &&
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
    segments.length === 4 &&
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
    segments.length === 4 &&
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
    segments.length === 3 &&
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
  if (segments[0] === "admin" && segments[1] === "gifts" && segments[2] === "cards" && segments.length === 3 && method === "GET") {
    ensureEconomyWrite(ctx);
    const { listGiftCards } = await import('../modules/admin-gifts');
    return json({items:await listGiftCards(ctx)});
  }
  if (segments[0] === "admin" && segments[1] === "gifts" && segments[2] === "recipients" && segments.length === 3 && method === "GET") {
    ensureEconomyWrite(ctx);
    const { listGiftRecipients } = await import('../modules/admin-gifts');
    return json({items:await listGiftRecipients(ctx)});
  }
  if (segments[0] === "admin" && segments[1] === "gifts" && segments[2] === "policy" && segments.length === 3 && method === "GET") {
    ensureEconomyWrite(ctx);
    const { getGiftPolicy } = await import('../modules/admin-gifts');
    return json(await getGiftPolicy(ctx));
  }
  if (
    segments[0] === "admin" &&
    segments[1] === "gifts" &&
    segments[2] === "recovery" &&
    segments[3] && segments.length === 4 && method === "GET"
  ) {
    ensureEconomyWrite(ctx);
    const {recoverAdminGift}=await import('../modules/admin-gifts');
    return json(await recoverAdminGift(ctx,segments[3]));
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
    segments.length === 3 &&
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
    segments.length === 4 &&
    method === "POST"
  ) {
    ensureEconomyWrite(ctx);
    ensureStepUp(ctx);
    return json(await processGiftCampaign(ctx, segments[2]));
  }

  // Platform Administration. Access admission is never treated as a role.
  if (segments[0] === "platform" && segments[1] === "overview" && segments.length === 2 && method === "GET") {
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
  if (segments[0] === "platform" && segments[1] === "accounts" && segments.length === 2 && method === "GET") {
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
  if (segments[0] === "platform" && segments[1] === "people" && segments.length === 2 && method === "GET") {
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
    segments.length === 4 &&
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
  if (segments[0] === "platform" && segments[1] === "installations" && segments[2] && segments.length === 3 && method === "PATCH") {
    requireSuperAdmin(ctx);
    ensureStepUp(ctx);
    const body = await readJson(request, z.object({
      revision: z.number().int().positive(),
      channelAllowlist: z.array(z.string().regex(/^\d{15,22}$/)).max(20).optional(),
      gameEnabled: z.boolean().optional(), active: z.boolean().optional(),
      websiteEnabled: z.boolean().optional(), apiEnabled: z.boolean().optional(),
      publicCatalogueEnabled: z.boolean().optional(), adminGuiEnabled: z.boolean().optional(),
    }).strict());
    if (body.websiteEnabled !== undefined || body.apiEnabled !== undefined || body.publicCatalogueEnabled !== undefined || body.adminGuiEnabled !== undefined)
      throw new ApiError(422,"installation_surface_unavailable","Those interface controls are not yet enforced; no settings were changed.");
    const {updatePlatformInstallation}=await import('../modules/discord-installation-settings');
    return json(await updatePlatformInstallation(ctx,segments[2],{revision:body.revision,channelAllowlist:body.channelAllowlist,gameEnabled:body.gameEnabled,active:body.active}));
  }
  if (
    segments[0] === "platform" &&
    segments[1] === "bots" &&
    segments[2] &&
    segments[3] === "status" &&
    segments.length === 4 &&
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
