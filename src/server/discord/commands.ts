import { ApiError, type Ctx } from "../context";
import { first, nowIso } from "../db";
import { auditStatement } from "../http";
import { newId, sha256Hex } from "../ids";
import { getInventory } from "../modules/collection";
import { displayFinish, printTitle as editionPrintTitle } from "../../lib/utils";
import { claimDailyReward, getEconomy, getPreferences } from "../modules/economy";
import {
  getProfilePresentationOptions,
  resolveProfilePresentation,
} from "../modules/profile-presentation";
import {
  accountAvatarViewFor,
  defaultAvatarPng,
  memberMediaById,
  renditionForSize,
} from "../modules/account-avatar";
import { getWalletSummary } from "../modules/wallet";
import { getCard, listCards } from "../modules/catalogue";
import {
  collectionProgress,
  getCollection,
  listCollectionCards,
  listCollections,
} from "../modules/collections";
import { executeDraw, getPoolPreview, listEligiblePools, listPools } from "../modules/pools";
import { finishKey, listAchievements } from "../modules/achievements";
import { compareNpc, getNpc, listNpcProfiles } from "../modules/npcs";
import {
  cancelNpcTrade,
  confirmNpcTrade,
  createNpcTrade,
  npcTradeOffers,
  previewNpcTrade,
} from "../modules/npc-trades";
import { claimDailyMission, getDailyMissions } from "../modules/missions";
import {
  DISCORD_PALETTE,
  achievementsOverviewMessage,
  cabinetSummaryMessage,
  capsulePickerMessage,
  cardFaceMessage,
  dailyClaimMessage,
  formatDiscordTimestamp,
  missionProgressMessage,
  profileMessage,
  revealReceiptMessage,
  sealedRevealMessage,
  stateFromError,
  welcomeMessage,
  type Audience,
  type CollectionArtInput,
} from "./presentation";
import {
  drawIdempotencyKey,
  drawReceiptFromResult,
  recoverDrawReceipt,
  recordInteractionReceipt,
  type DiscordReceipt,
} from "./receipts";
import { audienceRank, canViewCard, effectiveCardAudience } from "../modules/visibility";
import { HELP_TEXT } from "./command-definitions";
import { channelAudienceFor, isBotAdmin, requireBotAdmin } from "./context";
import {
  assertCardInDiscordScope,
  discordScopeCardIds,
  isAiEditionOrigin,
  poolScopeFromDiscord,
  rankDiscordAlbums,
  resolveDiscordScope,
  type DiscordScope,
} from "./scope";
import type {
  DiscordCallback,
  DiscordComponent,
  DiscordEmbed,
  DiscordInstallation,
  DiscordInteraction,
  DiscordMessage,
  DiscordOption,
} from "./types";

interface DrawReceipt {
  draw_id: string;
  instance_id: string;
  card_id: string;
  variant_id: string;
  card_name: string;
  edition_name: string | null;
  variant_name: string;
  material_key: string;
  effect_key: string | null;
  render_url: string | null;
  serial: string;
  pool_name: string;
  pool_slug?: string;
  price: number;
  currency: { name: string; symbol: string };
  balance_after: number;
  balance_after_debit?: number;
  current_balance?: number;
  credits_total?: number;
  achievement_credits?: Array<{ id: string; name: string; amount: number }>;
  settlement_status?: "settled" | "pending";
  settlement_pending?: boolean;
  probability_bps: number;
  new_subject?: boolean;
  new_finish?: boolean;
  owned_copies?: number;
  drawn_at: string;
  replayed: boolean;
}

interface DailyReceipt {
  amount: number;
  currency: { name: string; symbol: string };
  balance_after: number;
  next_eligible_at: string;
  replayed: boolean;
}

const RARITY_COLORS: Record<string, number> = {
  common: DISCORD_PALETTE.muted,
  uncommon: DISCORD_PALETTE.success,
  rare: DISCORD_PALETTE.action,
  cabinet_rare: DISCORD_PALETTE.focus,
  legendary: DISCORD_PALETTE.warning,
};

const SURFACE_COLUMNS: Record<string, string> = {
  game: "game_enabled",
  website: "website_enabled",
  api: "api_enabled",
  catalogue: "public_catalogue_enabled",
  admin: "admin_gui_enabled",
};

function absoluteUrl(origin: string, value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  if (/^https?:\/\//i.test(value)) return value;
  return `${origin.replace(/\/$/, "")}${value.startsWith("/") ? "" : "/"}${value}`;
}

function colorFor(rarityKey: string | null | undefined): number {
  return RARITY_COLORS[rarityKey ?? "common"] ?? DISCORD_PALETTE.muted;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function components(
  rows: DiscordComponent[][],
): Array<{ type: number; components: DiscordComponent[] }> {
  const seen = new Set<string>();
  return rows
    .map((row) =>
      row.filter((component) => {
        if (!component.custom_id) return true;
        if (seen.has(component.custom_id)) return false;
        seen.add(component.custom_id);
        return true;
      }),
    )
    .filter((row) => row.length > 0)
    .map((row) => ({ type: 1, components: row }));
}

function button(label: string, customId: string, style = 2): DiscordComponent {
  return { type: 2, style, label: label.slice(0, 80), custom_id: customId.slice(0, 100) };
}

function callback(message: DiscordMessage, ephemeral = false): DiscordCallback {
  return {
    type: 4,
    data: {
      ...message,
      allowed_mentions: { parse: [] },
      ...(ephemeral ? { flags: 64 } : {}),
    },
  };
}

function errorCallback(error: unknown, _ephemeral = true): DiscordCallback {
  const apiError = error instanceof ApiError ? error : null;
  if (apiError && ["draw_outcome_unavailable", "unknown_commit_outcome"].includes(apiError.code)) {
    return callback(
      {
        content:
          "This opening may have completed. Check your collection and wallet before opening another capsule.",
        allowed_mentions: { parse: [] },
      },
      true,
    );
  }
  const nextEligibleAt =
    apiError?.details && typeof apiError.details.next_eligible_at === "string"
      ? apiError.details.next_eligible_at
      : null;
  const nextStep =
    apiError?.code === "reward_cooldown" && nextEligibleAt
      ? `Come back ${formatDiscordTimestamp(nextEligibleAt)} or open a capsule you can afford.`
      : apiError?.code === "insufficient_funds"
        ? "Claim the daily allowance with /foilbury daily, or choose a cheaper capsule from /foilbury packs."
        : apiError?.code === "empty_pool"
          ? "Try /foilbury packs, or check your collection preferences on the website."
          : undefined;
  return stateFromError({
    code: apiError?.code,
    ...(apiError &&
    ["empty_pool", "stale_scope", "scope_empty", "card_outside_scope"].includes(apiError.code)
      ? { message: apiError.message }
      : {}),
    ...(nextStep ? { nextStep } : {}),
  });
}

function parseCommand(data: DiscordInteraction["data"]): {
  subcommand: string;
  values: Record<string, string | number | boolean>;
} {
  if (!data?.name)
    throw new ApiError(400, "discord_command_missing", "This interaction has no command name.");
  if (data.name !== "foilbury")
    throw new ApiError(404, "discord_command_unknown", "Unknown Foilbury command.");
  const top = data.options?.find((option) => option.type === 1 || option.type === 2);
  if (!top) throw new ApiError(400, "discord_subcommand_missing", "Choose a Foilbury subcommand.");
  let subcommand = top.name;
  let options: DiscordOption[] = top.options ?? [];
  if (top.type === 2) {
    const inner = options.find((option) => option.type === 1);
    if (!inner)
      throw new ApiError(400, "discord_subcommand_missing", "Choose an admin subcommand.");
    subcommand = `${top.name}:${inner.name}`;
    options = inner.options ?? [];
  }
  const values: Record<string, string | number | boolean> = {};
  for (const option of options) {
    if (option.type === 1 || option.type === 2) continue;
    if (option.value !== undefined) values[option.name] = option.value;
  }
  return { subcommand, values };
}

function poolName(values: Record<string, string | number | boolean>): string | undefined {
  const value = values.pool;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function validatePoolSlug(value: string): string {
  if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(value)) {
    throw new ApiError(422, "pool_invalid", "That pool name is not valid.");
  }
  return value;
}

export type DiscordOpenPreparation =
  | { kind: "respond"; callback: DiscordCallback }
  | {
      kind: "draw";
      poolSlug: string;
      expectedRevision: number;
      expectedDistribution: string;
      channelKey?: string;
      /** The exact server scope and digest the player approved. */
      scope: DiscordScope;
      scopeDigest: string;
      idempotency: { key: string; digest: string };
    };

export async function prepareDiscordDraw(
  ctx: Ctx,
  interaction: DiscordInteraction,
  installation: DiscordInstallation,
  requestedPool: string | undefined,
  idempotencyKey: string,
  providedScope?: DiscordScope,
): Promise<DiscordOpenPreparation> {
  const scope =
    providedScope ?? (await resolveDiscordScope(ctx, installation, interaction.channel_id ?? null));
  if (scope.emptyReason) {
    return { kind: "respond", callback: scopeFailureMessage(scope) };
  }
  const poolSlug = validatePoolSlug(requestedPool ?? "cabinet-draw");
  const poolScope = poolScopeFromDiscord(scope);
  const preview = await getPoolPreview(ctx, poolSlug, installation.channel_key ?? undefined, {
    scope: poolScope,
  });
  if (preview.eligible_count === 0) {
    if (!requestedPool) {
      // The default capsule can be empty because a collection was disabled or
      // the member hid every world. Present real alternatives and their price
      // instead of a dead end; opening still requires an explicit press.
      const choices = (
        await listEligiblePools(ctx, installation.channel_key ?? undefined, poolScope)
      ).slice(0, 8);
      if (choices.length) {
        choices.sort(
          (left, right) =>
            left.price - right.price || left.pool.name.localeCompare(right.pool.name),
        );
        const wallet = await getWalletSummary(ctx.db, ctx.tenant.id, ctx.user!.id, 1);
        return {
          kind: "respond",
          callback: capsulePickerMessage({
            scopeName: ctx.tenant.name,
            currencySymbol: wallet.currencySymbol,
            balance: wallet.balance,
            capsules: choices.map((preview) => ({
              slug: preview.pool.slug,
              name: preview.pool.name,
              price: preview.price,
              eligibleCount: preview.eligible_count,
            })),
            packsCustomId: "foilbury:packs",
            browseUrl: absoluteUrl(ctx.config.publicOrigin, "/play/draw"),
          }),
        };
      }
    }
    throw new ApiError(
      409,
      "empty_pool",
      `${preview.filters.empty_reason ?? "This pool has no eligible cards right now."} Nothing was charged. Try /foilbury packs, or check your collection preferences.`,
    );
  }
  const digest = await sha256Hex(
    `discord-open:${ctx.tenant.id}:${ctx.user!.id}:${poolSlug}:${interaction.id}`,
  );
  return {
    kind: "draw",
    poolSlug,
    expectedRevision: preview.revision,
    expectedDistribution: preview.distribution_fingerprint,
    channelKey: installation.channel_key ?? undefined,
    scope,
    scopeDigest: scope.digest,
    idempotency: { key: idempotencyKey, digest },
  };
}

/**
 * A committed draw is acknowledged face-down. The opening message carries no
 * result text, serial, finish, render filename or result-specific media; the
 * player chooses when to reveal it. The draw itself is already committed, so a
 * lost reveal interaction can never lose the card or charge twice.
 */
export async function presentDiscordDraw(
  ctx: Ctx,
  interaction: DiscordInteraction,
  _installation: DiscordInstallation,
  result: DrawReceipt,
  _poolSlug: string,
  _scope?: DiscordScope,
): Promise<DiscordCallback> {
  const backUrl = absoluteUrl(ctx.config.publicOrigin, "/brand/card-back.webp");
  if (!backUrl) {
    throw new ApiError(
      500,
      "presentation_missing",
      "The sealed card back could not be resolved. The draw is committed; open your collection to see the card.",
    );
  }
  return sealedRevealMessage({
    pool_name: result.pool_name,
    price: result.price,
    currency_symbol: result.currency.symbol,
    back_url: backUrl,
    reveal_custom_id: `foilbury:reveal:${interaction.id}`,
    collection_custom_id: "foilbury:collection",
    album_url: absoluteUrl(ctx.config.publicOrigin, "/play/collection"),
    scope_name: ctx.tenant.name,
  });
}

type RevealSource = DrawReceipt | DiscordReceipt;

async function wishlistHit(
  ctx: Ctx,
  source: RevealSource,
  material: string,
  effect: string | null,
) {
  const row = await first<{ hit: number }>(
    ctx.db,
    `SELECT 1 AS hit FROM fb_wishlists w
      WHERE w.tenant_id = ? AND w.user_id = ? AND w.card_id = ?
        AND (w.target_variant_id IS NULL OR w.target_variant_id = ?)
        AND (w.target_material_key IS NULL OR w.target_material_key = ?)
        AND (w.target_effect_key IS NULL OR w.target_effect_key = ?)
      LIMIT 1`,
    ctx.tenant.id,
    ctx.user!.id,
    source.card_id,
    source.variant_id,
    material,
    effect,
  );
  return Boolean(row?.hit);
}

async function collectionSnapshotForCard(ctx: Ctx, cardId: string) {
  return first<{ name: string; total: number; owned: number }>(
    ctx.db,
    `SELECT c.name,
            (SELECT COUNT(*) FROM fb_collection_cards cc2 WHERE cc2.collection_id = c.id) AS total,
            (SELECT COUNT(DISTINCT ci.card_id)
               FROM fb_card_instances ci
               JOIN fb_collection_cards cc3
                 ON cc3.card_id = ci.card_id AND cc3.collection_id = c.id
              WHERE ci.tenant_id = ? AND ci.user_id = ? AND ci.status = 'owned') AS owned
       FROM fb_collection_cards cc
       JOIN fb_collections c ON c.id = cc.collection_id
      WHERE cc.card_id = ? AND cc.tenant_id = ? AND c.archived_at IS NULL
      ORDER BY c.sort, c.name
      LIMIT 1`,
    ctx.tenant.id,
    ctx.user!.id,
    cardId,
    ctx.tenant.id,
  );
}

/**
 * Build the private result for an already committed draw. This is deliberately
 * separate from the commit, and separate from the sealed acknowledgement, so a
 * presentation failure can recover from the persisted receipt without ever
 * calling the draw service again.
 */
async function presentDiscordReveal(
  ctx: Ctx,
  interaction: DiscordInteraction,
  installation: DiscordInstallation,
  source: RevealSource,
  scope?: DiscordScope,
): Promise<DiscordCallback> {
  const render = await first<{ width: number; height: number; r2_key: string; mime: string }>(
    ctx.db,
    `SELECT vr.width, vr.height, a.r2_key, a.mime
       FROM fb_variant_renders vr JOIN fb_assets a ON a.id = vr.asset_id AND a.tenant_id = vr.tenant_id
      WHERE vr.tenant_id = ? AND vr.variant_id = ? AND vr.status = 'published' LIMIT 1`,
    ctx.tenant.id,
    source.variant_id,
  ).catch(() => null);
  const variant = await first<{ material_key: string; effect_key: string | null }>(
    ctx.db,
    "SELECT material_key, effect_key FROM fb_variants WHERE tenant_id = ? AND id = ?",
    ctx.tenant.id,
    source.variant_id,
  ).catch(() => null);
  const material =
    variant?.material_key ??
    ("material_key" in source && source.material_key ? source.material_key : "paper");
  const effect =
    variant?.effect_key ?? ("effect_key" in source ? (source.effect_key ?? null) : null);
  const [rarityName, cardAudience, wished, collection] = await Promise.all([
    cardRarity(ctx, source.card_id).catch(() => null),
    // Audience lookup failure must fail closed: no share control and a private
    // reveal. The draw itself is already committed and safe in the cabinet.
    effectiveCardAudience(ctx, source.card_id).catch(() => "private" as const),
    wishlistHit(ctx, source, material, effect).catch(() => false),
    collectionSnapshotForCard(ctx, source.card_id).catch(() => null),
  ]);
  const channelAudience = channelAudienceFor(installation, interaction.channel_id);
  const inScope = scope
    ? await assertCardInDiscordScope(ctx, scope, source.card_id)
        .then(() => true)
        .catch(() => false)
    : true;
  const shareInChannel =
    inScope &&
    cardAudience !== "private" &&
    audienceRank(channelAudience) >= audienceRank(cardAudience);
  const symbol = "currency" in source ? source.currency.symbol : source.currency_symbol;
  return revealReceiptMessage({
    card_id: source.card_id,
    variant_id: source.variant_id,
    card_name: source.card_name,
    variant_name: source.variant_name,
    material_key: material,
    effect_key: effect,
    render_url: "render_url" in source ? source.render_url : null,
    serial: source.serial,
    pool_name: source.pool_name,
    price: source.price,
    currency: { name: "Foil", symbol },
    balance_after: source.balance_after,
    balance_after_debit: source.balance_after_debit,
    credits_total: source.credits_total,
    achievement_credits: source.achievement_credits,
    probability_bps: source.probability_bps ?? 0,
    new_subject: source.new_subject,
    new_finish: source.new_finish,
    owned_copies: source.owned_copies,
    wishlist_hit: wished,
    collection_name: collection?.name ?? null,
    collection_owned: collection?.owned,
    collection_total: collection?.total,
    settlement_pending: source.settlement_pending === true,
    drawn_at: source.drawn_at,
    replayed: source.replayed,
    rarity_name: rarityName,
    scope_name: ctx.tenant.name,
    audience: cardAudience,
    channel_audience: channelAudience,
    channel_approved: shareInChannel,
    force_private: true,
    render: render?.r2_key
      ? {
          r2Key: render.r2_key,
          mime: render.mime,
          width: render.width,
          height: render.height,
        }
      : null,
    open_custom_id: `foilbury:open:${source.pool_slug || "cabinet-draw"}`,
    collection_custom_id: "foilbury:collection",
    tour_custom_id: "foilbury:tour:progress",
    album_url: absoluteUrl(ctx.config.publicOrigin, "/play/collection"),
    public_origin: ctx.config.publicOrigin,
    share_custom_id: shareInChannel ? `foilbury:tourshare:card:${source.instance_id}` : undefined,
  });
}

/**
 * Reveal a committed draw from its original interaction. Recovering the
 * receipt is read-only: no new draw, debit or copy can be produced here.
 */
async function revealCommittedDraw(
  ctx: Ctx,
  interaction: DiscordInteraction,
  installation: DiscordInstallation,
  originalInteractionId: string,
): Promise<DiscordCallback> {
  const receipt = await recoverDrawReceipt(ctx.db, {
    tenantId: ctx.tenant.id,
    userId: ctx.user!.id,
    interactionId: originalInteractionId,
  });
  if (!receipt) {
    throw new ApiError(
      404,
      "receipt_not_found",
      "No committed draw receipt could be found for that reveal. Nothing new was charged; open the cabinet to inspect your cards.",
    );
  }
  const scope = await resolveDiscordScope(ctx, installation, interaction.channel_id ?? null);
  return presentDiscordReveal(ctx, interaction, installation, receipt, scope);
}

async function openCard(
  ctx: Ctx,
  interaction: DiscordInteraction,
  installation: DiscordInstallation,
  requestedPool: string | undefined,
  idempotencyKey: string,
  providedScope?: DiscordScope,
): Promise<DiscordCallback> {
  const scope =
    providedScope ?? (await resolveDiscordScope(ctx, installation, interaction.channel_id ?? null));
  if (scope.emptyReason) return scopeFailureMessage(scope);
  const prepared = await prepareDiscordDraw(
    ctx,
    interaction,
    installation,
    requestedPool,
    idempotencyKey,
    scope,
  );
  if (prepared.kind === "respond") return prepared.callback;
  const result = (await executeDraw(ctx, {
    pool: prepared.poolSlug,
    expectedRevision: prepared.expectedRevision,
    expectedDistribution: prepared.expectedDistribution,
    channelKey: prepared.channelKey,
    scope: poolScopeFromDiscord(scope),
    idempotency: prepared.idempotency,
  })) as unknown as DrawReceipt;

  // Persist the domain result before any presentation lookup. If a render or
  // Discord call fails from here on, the handler can retrieve this exact
  // receipt and tell the player the draw completed. It must never trigger a
  // second draw or claim that nothing changed.
  await recordInteractionReceipt(ctx.db, interaction.id, drawReceiptFromResult(result));
  return presentDiscordDraw(ctx, interaction, installation, result, prepared.poolSlug, scope);
}

/**
 * Re-send the exact receipt that was committed by an earlier interaction. This
 * never calls executeDraw, so a delivery retry cannot spend again or roll a new
 * card. The original interaction ID is part of the signed component and is
 * resolved against the durable interaction record.
 */
async function redeliverReceipt(
  ctx: Ctx,
  interaction: DiscordInteraction,
  installation: DiscordInstallation,
  originalInteractionId: string,
): Promise<DiscordCallback> {
  const receipt = await recoverDrawReceipt(ctx.db, {
    tenantId: ctx.tenant.id,
    userId: ctx.user!.id,
    interactionId: originalInteractionId,
  });
  if (!receipt) {
    throw new ApiError(
      404,
      "receipt_not_found",
      "No committed draw receipt could be found for that button. Nothing new was charged; open the cabinet to inspect your cards.",
    );
  }
  const scope = await resolveDiscordScope(ctx, installation, interaction.channel_id ?? null);
  return presentDiscordReveal(
    ctx,
    interaction,
    installation,
    { ...receipt, replayed: true },
    scope,
  );
}

async function cardRarity(ctx: Ctx, cardId: string): Promise<string | null> {
  const row = await first<{ name: string }>(
    ctx.db,
    `SELECT r.name FROM fb_card_definitions cd JOIN fb_rarities r ON r.id = cd.rarity_id WHERE cd.tenant_id = ? AND cd.id = ?`,
    ctx.tenant.id,
    cardId,
  );
  return row?.name ?? null;
}

async function daily(ctx: Ctx, interaction: DiscordInteraction): Promise<DiscordCallback> {
  const digest = await sha256Hex(
    `discord-daily:${ctx.tenant.id}:${ctx.user!.id}:${interaction.id}`,
  );
  const result = (await claimDailyReward(ctx, {
    key: `discord:${interaction.id}:daily`,
    digest,
  })) as unknown as DailyReceipt;
  return dailyClaimMessage({
    amount: result.amount,
    currencySymbol: result.currency.symbol,
    balanceAfter: result.balance_after,
    nextEligibleAt: result.next_eligible_at,
    replayed: result.replayed,
    scopeName: ctx.tenant.name,
    openCustomId: "foilbury:open:cabinet-draw",
    packsCustomId: "foilbury:packs",
  });
}

async function collectionArtFor(
  ctx: Ctx,
  url: string | null | undefined,
  kind: "banner" | "logo",
): Promise<CollectionArtInput | null> {
  if (!url) return null;
  if (url.startsWith("/media/asset/")) {
    const assetId = url.slice("/media/asset/".length);
    const asset = await first<{
      r2_key: string;
      mime: string;
      width: number | null;
      height: number | null;
    }>(
      ctx.db,
      "SELECT r2_key, mime, width, height FROM fb_assets WHERE id = ? AND tenant_id = ?",
      assetId,
      ctx.tenant.id,
    );
    if (!asset) return null;
    return {
      attachment: { r2Key: asset.r2_key, mime: asset.mime },
      width: asset.width ?? undefined,
      height: asset.height ?? undefined,
    };
  }
  if (/^https?:\/\//i.test(url)) {
    return { url, width: kind === "banner" ? 1600 : 512, height: kind === "banner" ? 900 : 512 };
  }
  const absolute = absoluteUrl(ctx.config.publicOrigin, url);
  return absolute
    ? { url: absolute, width: kind === "banner" ? 1600 : 512, height: kind === "banner" ? 900 : 512 }
    : null;
}

async function collection(
  ctx: Ctx,
  installation: DiscordInstallation,
  providedScope?: DiscordScope,
  channelId?: string | null,
): Promise<DiscordCallback> {
  const scope =
    providedScope ??
    (await resolveDiscordScope(ctx, installation, channelId ?? installation.channel_key ?? null));
  const scopedCardIds = await discordScopeCardIds(ctx, scope);
  const allInventory = await getInventory(ctx, { limit: 500 });
  const inventory = allInventory.filter(
    (item) =>
      scopedCardIds.has(item.card_id) &&
      (scope.aiArtEnabled || !isAiEditionOrigin(item.subject_origin)),
  );
  const hidden = allInventory.length - inventory.length;
  const wallet = await getWalletSummary(ctx.db, ctx.tenant.id, ctx.user!.id, 1);
  const featuredItem = inventory[0] ?? null;
  const featuredCollectionRow = featuredItem?.collection_id
    ? await first<{
        id: string;
        name: string;
        banner_url: string | null;
        logo_url: string | null;
        view_audience: string;
      }>(
        ctx.db,
        "SELECT id, name, banner_url, logo_url, view_audience FROM fb_collections WHERE id = ? AND archived_at IS NULL",
        featuredItem.collection_id,
      )
    : null;
  const featuredProgress = featuredCollectionRow
    ? await collectionProgress(ctx, featuredCollectionRow.id)
    : null;
  const featuredBanner = await collectionArtFor(ctx, featuredCollectionRow?.banner_url, "banner");
  const featuredLogo = await collectionArtFor(ctx, featuredCollectionRow?.logo_url, "logo");
  const featuredCollection =
    featuredCollectionRow && featuredProgress
      ? {
          name: featuredCollectionRow.name,
          owned: featuredProgress.owned_cards,
          total: featuredProgress.total_cards,
          audience: featuredCollectionRow.view_audience as Audience,
          banner: featuredBanner,
          logo: featuredLogo,
        }
      : null;
  const scopeNotice =
    hidden > 0
      ? `${hidden} historical ${hidden === 1 ? "copy is" : "copies are"} outside this server's current collection or AI-artwork scope. They remain owned and are visible in the signed-in website cabinet; they are not available to draw or share here.`
      : null;
  if (inventory.length === 0) {
    return cabinetSummaryMessage({
      scopeName: ctx.tenant.name,
      currencySymbol: wallet.currencySymbol,
      balance: wallet.balance,
      owned: 0,
      unique: 0,
      duplicates: 0,
      items: [],
      albumUrl: absoluteUrl(ctx.config.publicOrigin, "/play/collection")!,
      openCustomId: "foilbury:open:cabinet-draw",
      packsCustomId: "foilbury:packs",
      ...(featuredCollection ? { featuredCollection } : {}),
      ...(scopeNotice ? { scopeNotice } : {}),
    });
  }
  const counts = new Map<string, number>();
  for (const item of inventory) counts.set(item.card_id, (counts.get(item.card_id) ?? 0) + 1);
  const duplicates = [...counts.values()].filter((count) => count > 1).length;
  return cabinetSummaryMessage({
    scopeName: ctx.tenant.name,
    currencySymbol: wallet.currencySymbol,
    balance: wallet.balance,
    owned: inventory.length,
    unique: counts.size,
    duplicates,
    items: inventory.slice(0, 8).map((item) => ({
      name: item.card_name,
      print: editionPrintTitle(item.edition_name),
      variant: displayFinish(item.variant_name, item.material_key, item.effect_key),
      rarity: item.rarity_name,
      serial: item.serial,
    })),
    albumUrl: absoluteUrl(ctx.config.publicOrigin, "/play/collection")!,
    openCustomId: "foilbury:open:cabinet-draw",
    packsCustomId: "foilbury:packs",
    ...(featuredCollection ? { featuredCollection } : {}),
    ...(scopeNotice ? { scopeNotice } : {}),
  });
}

async function card(
  ctx: Ctx,
  query: string,
  installation: DiscordInstallation,
  providedScope?: DiscordScope,
  channelId?: string | null,
): Promise<DiscordCallback> {
  const scope =
    providedScope ??
    (await resolveDiscordScope(ctx, installation, channelId ?? installation.channel_key ?? null));
  if (scope.emptyReason) return scopeFailureMessage(scope);
  let found: Awaited<ReturnType<typeof getCard>> | null = null;
  try {
    found = await getCard(ctx, query, { includeAi: scope.aiArtEnabled });
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== "card_not_found") throw error;
    const matches = await listCards(ctx, {
      search: query,
      limit: 5,
      includeAi: scope.aiArtEnabled,
    });
    found = matches[0] ?? null;
    if (!found) throw error;
  }
  await assertCardInDiscordScope(ctx, scope, found.id);
  if (found.status !== "published" || found.archived_at) {
    if (!isBotAdmin(ctx.user!))
      throw new ApiError(
        404,
        "card_not_found",
        "That card is not available in the public catalogue.",
      );
  }
  const versions = renderedCardVersions(found);
  const imageVersion = versions[0];
  const imageVariant = imageVersion?.variant;
  const render = imageVariant
    ? await first<{ width: number; height: number; r2_key: string; mime: string }>(
        ctx.db,
        `SELECT vr.width, vr.height, a.r2_key, a.mime FROM fb_variant_renders vr
           JOIN fb_assets a ON a.id = vr.asset_id AND a.tenant_id = vr.tenant_id
          WHERE vr.tenant_id = ? AND vr.variant_id = ? AND vr.status = 'published' LIMIT 1`,
        ctx.tenant.id,
        imageVariant.id,
      )
    : null;
  if (!imageVariant || !render) {
    throw new ApiError(
      404,
      "render_missing",
      "That card has no finished render yet. Viewing never spends Foil or awards a copy.",
    );
  }
  return cardFaceMessage({
    cardName: found.name,
    printName: imageVersion.printName,
    variantName: imageVariant.name,
    materialKey: imageVariant.material_key ?? "plain",
    effectKey: imageVariant.effect_key ?? null,
    side: "front",
    description: truncate(found.description, 1500),
    collectionName: found.collections[0]?.name ?? "Cabinet",
    source: found.source_work ?? found.sets[0]?.name ?? "Foilbury",
    rarityName: found.rarity?.name ?? null,
    render: {
      r2Key: render.r2_key,
      mime: render.mime,
      width: render.width,
      height: render.height,
    },
    swapCustomId: imageVariant.back_render_url
      ? `foilbury:card:${found.id}:${imageVariant.id}:back`
      : undefined,
    detailsCustomId: `foilbury:card:${found.id}:${imageVariant.id}:details`,
    nextVersionCustomId: versions[1]
      ? `foilbury:card:${found.id}:${versions[1].variant.id}:front`
      : undefined,
    albumUrl: absoluteUrl(ctx.config.publicOrigin, "/play/collection")!,
  });
}

function renderedCardVersions(card: Awaited<ReturnType<typeof getCard>>) {
  // Catalogue editions arrive oldest first. Start with the latest print,
  // while explicit controls continue to resolve their exact variant.
  return [...card.editions]
    .reverse()
    .filter((edition) => edition.status === "published")
    .flatMap((edition) =>
      edition.variants
        .filter((variant) => variant.status === "published" && variant.render_url)
        .map((variant) => ({ variant, printName: editionPrintTitle(edition.name) })),
    );
}

async function cardFace(
  ctx: Ctx,
  cardId: string,
  variantId: string | null,
  side: "front" | "back",
  installation: DiscordInstallation,
  providedScope?: DiscordScope,
  channelId?: string | null,
): Promise<DiscordCallback> {
  const scope =
    providedScope ??
    (await resolveDiscordScope(ctx, installation, channelId ?? installation.channel_key ?? null));
  await assertCardInDiscordScope(ctx, scope, cardId);
  const found = await getCard(ctx, cardId, { includeAi: scope.aiArtEnabled });
  if (found.status !== "published")
    throw new ApiError(404, "card_not_found", "That card is not published.");
  const versions = renderedCardVersions(found);
  const index = variantId ? versions.findIndex((item) => item.variant.id === variantId) : 0;
  const version = versions[index];
  if (!version)
    throw new ApiError(
      404,
      "render_missing",
      "That version is no longer available here. Run /foilbury card to browse available versions.",
    );
  const { variant, printName } = version;
  const next = versions.length > 1 ? versions[(index + 1) % versions.length] : undefined;
  const render = await first<{ width: number; height: number; r2_key: string; mime: string }>(
    ctx.db,
    side === "front"
      ? `SELECT vr.width, vr.height, a.r2_key, a.mime FROM fb_variant_renders vr
           JOIN fb_assets a ON a.id = vr.asset_id AND a.tenant_id = vr.tenant_id
          WHERE vr.tenant_id = ? AND vr.variant_id = ? AND vr.status = 'published' LIMIT 1`
      : `SELECT br.width, br.height, a.r2_key, a.mime FROM fb_variant_back_renders br
           JOIN fb_assets a ON a.id = br.asset_id AND a.tenant_id = br.tenant_id
          WHERE br.tenant_id = ? AND br.variant_id = ? AND br.status = 'published' LIMIT 1`,
    ctx.tenant.id,
    variant.id,
  );
  if (!render)
    throw new ApiError(404, "render_missing", `That card has no finished ${side} render yet.`);
  const collection = found.collections[0];
  return cardFaceMessage({
    cardName: found.name,
    printName,
    variantName: variant.name,
    materialKey: variant.material_key ?? "plain",
    effectKey: variant.effect_key ?? null,
    side,
    description: truncate(
      side === "front" ? found.description : (found.bio_safe ?? found.bio ?? found.description),
      1500,
    ),
    collectionName: collection?.name ?? "Cabinet",
    source: found.source_work ?? found.sets[0]?.name ?? "Foilbury",
    rarityName: found.rarity?.name ?? null,
    render: {
      r2Key: render.r2_key,
      mime: render.mime,
      width: render.width,
      height: render.height,
    },
    swapCustomId: side === "back" || variant.back_render_url
      ? `foilbury:card:${found.id}:${variant.id}:${side === "front" ? "back" : "front"}`
      : undefined,
    detailsCustomId: `foilbury:card:${found.id}:${variant.id}:details`,
    nextVersionCustomId: next ? `foilbury:card:${found.id}:${next.variant.id}:front` : undefined,
    albumUrl: absoluteUrl(ctx.config.publicOrigin, "/play/collection")!,
  });
}

async function cardDetails(
  ctx: Ctx,
  cardId: string,
  installation: DiscordInstallation,
  providedScope?: DiscordScope,
  channelId?: string | null,
): Promise<DiscordCallback> {
  const scope =
    providedScope ??
    (await resolveDiscordScope(ctx, installation, channelId ?? installation.channel_key ?? null));
  await assertCardInDiscordScope(ctx, scope, cardId);
  const found = await getCard(ctx, cardId, { includeAi: scope.aiArtEnabled });
  const owned = await first<{ copies: number; finishes: number; serials: string | null }>(
    ctx.db,
    `SELECT COUNT(*) AS copies, COUNT(DISTINCT material.key) AS finishes,
            GROUP_CONCAT(ci.serial, ', ') AS serials
       FROM fb_card_instances ci
       JOIN fb_variants v ON v.id = ci.variant_id
       JOIN fb_materials material ON material.id = v.material_id
      WHERE ci.tenant_id = ? AND ci.user_id = ? AND ci.card_id = ? AND ci.status IN ('owned','reserved')`,
    ctx.tenant.id,
    ctx.user!.id,
    found.id,
  );
  const attributes = (() => {
    try {
      return JSON.parse(found.attributes_json ?? "[]") as Array<{ label?: string; value?: string }>;
    } catch {
      return [];
    }
  })();
  const origins = [
    ...new Set(
      found.editions.map((edition) =>
        String((edition as unknown as { subject_origin?: string }).subject_origin ?? "unknown"),
      ),
    ),
  ];
  const aiOrigins = origins.filter(
    (origin) => origin === "ai_assisted" || origin === "ai_generated",
  );
  const artworkLabel =
    aiOrigins.length === 0
      ? origins.includes("sourced")
        ? "Sourced character reference; card design and finishes are Foilbury originals. Not AI-generated."
        : "Foilbury original artwork."
      : aiOrigins.length === origins.length
        ? "AI-assisted print, reviewed; not official artwork. This Bot includes AI-assisted artwork."
        : "Mixed editions: sourced/original and AI-assisted prints. The label on each print identifies its origin.";
  return callback(
    {
      embeds: [
        {
          title: `${found.name} · details`,
          description: truncate(found.bio_safe ?? found.bio ?? found.description, 1800),
          color: colorFor(found.rarity?.key),
          fields: [
            { name: "Collection", value: found.collections[0]?.name ?? "Cabinet", inline: true },
            { name: "Source", value: found.source_work ?? "Foilbury", inline: true },
            { name: "Rarity", value: found.rarity?.name ?? "Unclassified", inline: true },
            { name: "Artwork", value: artworkLabel, inline: false },
            ...attributes.slice(0, 5).map((attr) => ({
              name: attr.label ?? "Detail",
              value: attr.value ?? "—",
              inline: true,
            })),
            {
              name: "Your copies",
              value: owned?.copies
                ? `${owned.copies} across ${owned.finishes} finish${owned.finishes === 1 ? "" : "es"}`
                : "Not in your album yet",
              inline: false,
            },
            {
              name: "Spoilers",
              value: found.spoiler_level
                ? `This profile has ${found.spoiler_level} spoiler layer${found.spoiler_level === 1 ? "" : "s"}. The full text is available in the website album after opting in.`
                : "This profile is spoiler-safe.",
              inline: false,
            },
          ],
          footer: { text: "Private member view · no draw, charge or new copy" },
        },
      ],
    },
    true,
  );
}

async function achievements(
  ctx: Ctx,
  installation: DiscordInstallation,
  providedScope?: DiscordScope,
  channelId?: string | null,
): Promise<DiscordCallback> {
  const scope =
    providedScope ??
    (await resolveDiscordScope(ctx, installation, channelId ?? installation.channel_key ?? null));
  const items = (await listAchievements(ctx, ctx.user!.id)).filter(
    (item) =>
      !item.criteria?.collection_id ||
      (typeof item.criteria.collection_id === "string" &&
        scope.collectionIds.includes(item.criteria.collection_id)),
  );
  const earned = items.filter((item) => item.state === "earned");
  const close = items
    .filter((item) => item.state !== "earned")
    .sort((a, b) => b.progress / Math.max(1, b.target) - a.progress / Math.max(1, a.target))
    .slice(0, 5);
  const wallet = await getWalletSummary(ctx.db, ctx.tenant.id, ctx.user!.id, 1);
  return achievementsOverviewMessage({
    currencySymbol: wallet.currencySymbol,
    items: [
      ...earned.map((item) => ({
        name: item.name,
        state: "earned" as const,
        progress: item.target,
        target: item.target,
        reward: item.reward_amount,
      })),
      ...close.map((item) => ({
        name: item.name,
        state: item.state,
        progress: item.progress,
        target: item.target,
        reward: item.reward_amount,
      })),
    ],
    achievementsUrl: absoluteUrl(ctx.config.publicOrigin, "/play/achievements")!,
  });
}

async function packs(
  ctx: Ctx,
  installation: DiscordInstallation,
  providedScope?: DiscordScope,
  channelId?: string | null,
): Promise<DiscordCallback> {
  const scope =
    providedScope ??
    (await resolveDiscordScope(ctx, installation, channelId ?? installation.channel_key ?? null));
  if (scope.emptyReason) return scopeFailureMessage(scope);
  const pools = await listEligiblePools(
    ctx,
    installation.channel_key ?? undefined,
    poolScopeFromDiscord(scope),
  );
  if (pools.length === 0) {
    return callback(
      {
        embeds: [
          {
            title: "No packs available to you",
            description:
              "No active capsule has an eligible card for this account right now. A Bot Admin may have disabled the relevant collection, or your collection preferences may hide every card. Nothing can be charged. Check /foilbury preferences on the website, then try again.",
            color: DISCORD_PALETTE.muted,
          },
        ],
      },
      true,
    );
  }
  const wallet = await getWalletSummary(ctx.db, ctx.tenant.id, ctx.user!.id, 1);
  const capsules = pools.slice(0, 10).map((preview) => {
    const odds = new Map<string, number>();
    for (const entry of preview.entries) {
      const key = displayFinish(entry.variant_name, entry.material_key, entry.effect_key);
      odds.set(key, (odds.get(key) ?? 0) + entry.probability_bps);
    }
    return {
      slug: preview.pool.slug,
      name: preview.pool.name,
      price: preview.price,
      eligibleCount: preview.eligible_count,
      odds: [...odds.entries()]
        .sort((left, right) => right[1] - left[1])
        .slice(0, 4)
        .map(([label, probabilityBps]) => ({ label, probabilityBps })),
    };
  });
  return capsulePickerMessage({
    scopeName: ctx.tenant.name,
    currencySymbol: wallet.currencySymbol,
    balance: wallet.balance,
    capsules,
    packsCustomId: "foilbury:packs",
    browseUrl: absoluteUrl(ctx.config.publicOrigin, "/play/draw"),
  });
}

async function profile(
  ctx: Ctx,
  installation: DiscordInstallation,
  providedScope?: DiscordScope,
  channelId?: string | null,
): Promise<DiscordCallback> {
  const scope =
    providedScope ??
    (await resolveDiscordScope(ctx, installation, channelId ?? installation.channel_key ?? null));
  const wallet = await getWalletSummary(ctx.db, ctx.tenant.id, ctx.user!.id, 1);
  const scopedCardIds = await discordScopeCardIds(ctx, scope);
  const inventory = (await getInventory(ctx, { limit: 500 })).filter(
    (item) =>
      scopedCardIds.has(item.card_id) &&
      (scope.aiArtEnabled || !isAiEditionOrigin(item.subject_origin)),
  );
  const lastReward = await first<{ created_at: string }>(
    ctx.db,
    "SELECT created_at FROM fb_reward_claims WHERE tenant_id = ? AND user_id = ? AND rule_key = 'daily-allowance' ORDER BY created_at DESC LIMIT 1",
    ctx.tenant.id,
    ctx.user!.id,
  );
  const economy = await getEconomy(ctx);
  const next = lastReward
    ? new Date(new Date(lastReward.created_at).getTime() + economy.daily_cooldown_seconds * 1000)
    : null;
  const achievements = (await listAchievements(ctx, ctx.user!.id)).filter(
    (achievement) =>
      !achievement.criteria?.collection_id ||
      (typeof achievement.criteria.collection_id === "string" &&
        scope.collectionIds.includes(achievement.criteria.collection_id)),
  );
  const earned = achievements.filter((achievement) => achievement.state === "earned").length;
  const scopedBadgeNames = new Set(
    achievements
      .filter((achievement) => achievement.state === "earned")
      .map((achievement) => achievement.name),
  );
  const [prefs, profileOptions] = await Promise.all([
    getPreferences(ctx),
    getProfilePresentationOptions(ctx),
  ]);
  const presentation = resolveProfilePresentation(
    prefs.profile_presentation,
    profileOptions,
    prefs.profile_presentation_version,
  );
  const featured = presentation.featured;
  const featuredCollectionRow = featured?.collectionId
    ? await first<{ view_audience: string }>(
        ctx.db,
        "SELECT view_audience FROM fb_collections WHERE id = ? AND archived_at IS NULL",
        featured.collectionId,
      )
    : null;
  const featuredCollectionProgress = featured?.collectionId
    ? await collectionProgress(ctx, featured.collectionId)
    : null;
  const render = featured ? await profileRenderFor(ctx, featured.id) : null;
  const avatar = accountAvatarViewFor(ctx.user);
  let avatarThumb: { attachment?: string; url?: string } | undefined;
  let avatarAttachment: { r2Key: string; filename: string; contentType: string } | undefined;
  if (avatar.assetId) {
    const media = await memberMediaById(ctx, avatar.assetId);
    const rendition = media ? renditionForSize(media, 256) : null;
    if (rendition) {
      const ext = rendition.mime === "image/png" ? "png" : rendition.mime === "image/webp" ? "webp" : "jpg";
      const filename = `foilbury-avatar.${ext}`;
      avatarAttachment = { r2Key: rendition.r2_key, filename, contentType: rendition.mime };
      avatarThumb = { attachment: filename };
    }
  }
  if (!avatarThumb) {
    avatarThumb = {
      url: absoluteUrl(ctx.config.publicOrigin, defaultAvatarPng(avatar.defaultKey, 256)) ?? undefined,
    };
  }
  const result = profileMessage({
    displayName: ctx.user!.displayName,
    scopeName: ctx.tenant.name,
    currencySymbol: wallet.currencySymbol,
    balance: wallet.balance,
    ownedCards: inventory.length,
    uniqueCards: new Set(inventory.map((item) => item.card_id)).size,
    dailyAvailable: !next || next.getTime() <= Date.now(),
    nextDailyAt: next?.toISOString() ?? null,
    achievementsEarned: earned,
    publicBadgeCount: achievements.filter(
      (achievement) => achievement.visibility === "public" && achievement.state === "earned",
    ).length,
    isBotAdmin: isBotAdmin(ctx.user!),
    lookLabel: starterLookLabel(prefs.profile_look),
    note: prefs.profile_bio || undefined,
    featured: featured
      ? {
          name: featured.cardName,
          variant: featured.variantName,
          finish: featured.finish,
        }
      : undefined,
    featuredCollection: featured?.collectionName
      ? {
          name: featured.collectionName,
          owned: featuredCollectionProgress?.owned_cards,
          total: featuredCollectionProgress?.total_cards,
          audience: featuredCollectionRow?.view_audience as Audience | undefined,
        }
      : undefined,
    badgeNames: presentation.badges
      .map((badge) => badge.name)
      .filter((name) => scopedBadgeNames.has(name)),
    imageAttachment: render ? "foilbury-profile.webp" : undefined,
    attachment: render
      ? {
          r2Key: render.r2_key,
          filename: "foilbury-profile.webp",
          contentType: render.mime || "image/webp",
        }
      : undefined,
    profileUrl: absoluteUrl(ctx.config.publicOrigin, "/play/profile")!,
    customiseUrl: absoluteUrl(ctx.config.publicOrigin, "/play/profile#customise")!,
    avatar: avatarThumb,
    avatarAttachment,
    dailyCustomId: "foilbury:daily",
    collectionCustomId: "foilbury:collection",
    shareCustomId: `foilbury:tourshare:profile:${ctx.user!.id}`,
  });
  return result;
}

async function profileRenderFor(
  ctx: Ctx,
  instanceId: string,
): Promise<{ r2_key: string; mime: string; width: number; height: number } | null> {
  return first<{ r2_key: string; mime: string; width: number; height: number }>(
    ctx.db,
    `SELECT a.r2_key, a.mime, vr.width, vr.height
       FROM fb_card_instances ci
       JOIN fb_variant_renders vr ON vr.variant_id = ci.variant_id AND vr.status = 'published'
       JOIN fb_assets a ON a.id = vr.asset_id AND a.tenant_id = vr.tenant_id
      WHERE ci.id = ? AND ci.tenant_id = ? AND ci.user_id = ? AND ci.status IN ('owned','reserved')
      LIMIT 1`,
    instanceId,
    ctx.tenant.id,
    ctx.user!.id,
  );
}

function starterLookLabel(look: string): string {
  return (
    {
      quiet: "Quiet archive",
      signal: "Signal room",
      binder: "Binder desk",
      night: "Night shelf",
    }[look] ?? "Quiet archive"
  );
}

async function npcView(
  ctx: Ctx,
  installation: DiscordInstallation,
  query: string,
  channelId: string | undefined,
): Promise<DiscordCallback> {
  const scope = await resolveDiscordScope(ctx, installation, channelId);
  if (scope.emptyReason) return scopeFailureMessage(scope);
  const allowedCardIds = await discordScopeCardIds(ctx, scope);
  const profiles = await listNpcProfiles(ctx);
  if (profiles.length === 0) {
    return callback(
      {
        embeds: [
          {
            title: "No NPC collectors are active",
            description:
              "This Bot has no labelled synthetic collectors yet. A Bot Owner can create one in Studio → NPC collectors. Nothing is simulated in the meantime.",
            color: DISCORD_PALETTE.raised,
            footer: { text: "Foilbury · NPC lounge" },
          },
        ],
        components: components([
          [
            {
              type: 2,
              style: 5,
              label: "Open Studio",
              url: absoluteUrl(ctx.config.publicOrigin, "/studio/npcs")!,
            },
          ],
        ]),
      },
      true,
    );
  }
  const needle = query.trim().toLowerCase();
  const selected = needle
    ? profiles.find(
        (npc) =>
          npc.id.toLowerCase() === needle ||
          npc.slug.toLowerCase() === needle ||
          npc.name.toLowerCase().includes(needle),
      )
    : null;
  if (!selected) {
    return callback(
      {
        embeds: [
          {
            title: "NPC collectors · synthetic cast",
            description:
              "Clearly labelled fictional game actors with real persisted cards. They are not Discord members or human engagement.",
            color: DISCORD_PALETTE.raised,
            fields: profiles.slice(0, 8).map((npc) => ({
              name: `${npc.name} · ${npc.preset_label}`,
              value: `${npc.status} · ${npc.subjects} subjects · ${npc.gold} Gold · ${npc.holographic} Holographic\n\`/foilbury npc name:${npc.slug}\``,
              inline: false,
            })),
            footer: { text: "NPC · synthetic collector · not a human member" },
          },
        ],
        components: components([
          [
            {
              type: 2,
              style: 5,
              label: "Open the NPC lounge",
              url: absoluteUrl(ctx.config.publicOrigin, "/play/rivals")!,
            },
          ],
        ]),
      },
      true,
    );
  }
  const comparison = await compareNpc(ctx, selected.id);
  const offers = await npcTradeOffers(ctx, selected.id, { allowedCardIds });
  return callback(
    {
      embeds: [
        {
          title: `${selected.name} · NPC`,
          description: selected.bio,
          color: DISCORD_PALETTE.action,
          thumbnail: selected.avatar_url
            ? {
                url:
                  absoluteUrl(ctx.config.publicOrigin, selected.avatar_url) ?? selected.avatar_url,
              }
            : undefined,
          fields: [
            { name: "Preset", value: selected.preset_label, inline: true },
            { name: "Status", value: selected.status, inline: true },
            { name: "Recorded actions", value: String(selected.actions_count), inline: true },
            {
              name: "NPC album",
              value: `${selected.subjects} subjects · ${selected.cards} copies\n${selected.gold} Gold · ${selected.holographic} Holographic`,
              inline: true,
            },
            {
              name: "Your album",
              value: `${comparison.viewer.subjects} subjects · ${comparison.viewer.cards} copies\n${comparison.viewer.gold} Gold · ${comparison.viewer.holographic} Holographic`,
              inline: true,
            },
            {
              name: "Tradeable copies",
              value:
                offers.copies
                  .slice(0, 6)
                  .map((copy) => `${copy.card_name} · ${copy.variant_name} · \`${copy.serial}\``)
                  .join("\n") || "No tradeable copies in an enabled collection.",
              inline: false,
            },
            {
              name: "Wants",
              value: offers.wants.missing_subjects.length
                ? `Missing subjects: ${offers.wants.missing_subjects.slice(0, 6).join(", ")}`
                : "No missing subjects to show in this channel.",
              inline: false,
            },
            {
              name: "Trade",
              value: `\`/foilbury trade npc:${selected.slug} give:<your serial> take:<its serial>\``,
              inline: false,
            },
            {
              name: "Honesty",
              value:
                "NPC · synthetic collector. Real draws, serials and ledger entries; never a human member or fabricated testimonial.",
              inline: false,
            },
          ],
          footer: { text: "Foilbury · on-demand NPC inspection and exchange" },
        },
      ],
      components: components([
        [
          {
            type: 2,
            style: 5,
            label: "Open trade desk",
            url: absoluteUrl(ctx.config.publicOrigin, `/play/trades?npc=${selected.id}`)!,
          },
          {
            type: 2,
            style: 5,
            label: "Compare in the lounge",
            url: absoluteUrl(ctx.config.publicOrigin, "/play/rivals")!,
          },
        ],
      ]),
    },
    true,
  );
}

async function findTradeCopy(ctx: Ctx, userId: string, serial: string) {
  return first<{ id: string; serial: string; card_name: string; variant_name: string }>(
    ctx.db,
    `SELECT ci.id, ci.serial, cd.name AS card_name, v.name AS variant_name
       FROM fb_card_instances ci
       JOIN fb_card_definitions cd ON cd.id = ci.card_id
       JOIN fb_variants v ON v.id = ci.variant_id
      WHERE ci.tenant_id = ? AND ci.user_id = ? AND ci.serial = ?
        AND ci.status = 'owned' AND ci.locked = 0
      LIMIT 1`,
    ctx.tenant.id,
    userId,
    serial,
  );
}

async function npcTradeCommand(
  ctx: Ctx,
  interaction: DiscordInteraction,
  installation: DiscordInstallation,
  values: Record<string, string | number | boolean | undefined>,
): Promise<DiscordCallback> {
  const scope = await resolveDiscordScope(ctx, installation, interaction.channel_id ?? null);
  if (scope.emptyReason) return scopeFailureMessage(scope);
  const query = typeof values.npc === "string" ? values.npc.trim().toLowerCase() : "";
  const giveSerial = typeof values.give === "string" ? values.give.trim() : "";
  const takeSerial = typeof values.take === "string" ? values.take.trim() : "";
  if (!query || !giveSerial || !takeSerial) {
    throw new ApiError(
      422,
      "npc_trade_options",
      "Choose an NPC by name or slug and provide both exact serials.",
    );
  }
  const profiles = await listNpcProfiles(ctx);
  const selected = profiles.find(
    (npc) =>
      npc.id.toLowerCase() === query ||
      npc.slug.toLowerCase() === query ||
      npc.name.toLowerCase().includes(query),
  );
  if (!selected)
    throw new ApiError(404, "npc_not_found", "That NPC collector is not active in this Bot.");
  const npc = await getNpc(ctx, selected.id);
  const give = await findTradeCopy(ctx, ctx.user!.id, giveSerial);
  if (!give)
    throw new ApiError(
      404,
      "trade_give_not_found",
      `No owned, unlocked copy with serial ${giveSerial} was found. Use the serial from /foilbury collection.`,
    );
  const take = await findTradeCopy(ctx, npc.row.user_id, takeSerial);
  if (!take)
    throw new ApiError(
      404,
      "trade_take_not_found",
      `The collector has no tradeable copy with serial ${takeSerial}. Use /foilbury npc name:${selected.slug}.`,
    );
  // The verified installation scope is a hard boundary for every Discord
  // surface, including NPC exchanges. A collection enabled for the Bot but not
  // for this server (or a later disabled collection) must not appear here.
  const [giveCard, takeCard] = await Promise.all([
    first<{ card_id: string }>(
      ctx.db,
      "SELECT card_id FROM fb_card_instances WHERE id = ? AND tenant_id = ?",
      give.id,
      ctx.tenant.id,
    ),
    first<{ card_id: string }>(
      ctx.db,
      "SELECT card_id FROM fb_card_instances WHERE id = ? AND tenant_id = ?",
      take.id,
      ctx.tenant.id,
    ),
  ]);
  if (!giveCard || !takeCard)
    throw new ApiError(409, "npc_trade_unavailable", "A selected copy no longer exists.");
  await assertCardInDiscordScope(ctx, scope, giveCard.card_id);
  await assertCardInDiscordScope(ctx, scope, takeCard.card_id);
  const preview = await previewNpcTrade(ctx, {
    npcId: selected.id,
    giveInstanceIds: [give.id],
    takeInstanceIds: [take.id],
  });
  const exact = [
    {
      name: "You give",
      value: `${give.card_name} · ${give.variant_name}\n\`${give.serial}\``,
      inline: true,
    },
    {
      name: "You receive",
      value: `${take.card_name} · ${take.variant_name}\n\`${take.serial}\``,
      inline: true,
    },
  ];
  if (preview.decision !== "accept") {
    return callback(
      {
        embeds: [
          {
            title: `${selected.name} declines`,
            description: preview.reason,
            color: DISCORD_PALETTE.muted,
            fields: exact,
            footer: { text: "NPC · synthetic collector · no copies moved" },
          },
        ],
        components: components([
          [
            {
              type: 2,
              style: 5,
              label: "Open trade desk",
              url: absoluteUrl(ctx.config.publicOrigin, `/play/trades?npc=${selected.id}`)!,
            },
            {
              type: 2,
              style: 5,
              label: "Inspect the collector",
              url: absoluteUrl(ctx.config.publicOrigin, "/play/rivals")!,
            },
          ],
        ]),
      },
      true,
    );
  }
  const created = await createNpcTrade(ctx, {
    npcId: selected.id,
    giveInstanceIds: [give.id],
    takeInstanceIds: [take.id],
    idempotencyKey: `discord-npc-trade:${interaction.id}`,
  });
  return callback(
    {
      embeds: [
        {
          title: `${selected.name} accepts · exact offer held`,
          description:
            "The collector's deterministic decision accepted this exchange. Both exact copies are reserved; nothing has moved yet. Confirm to complete the trade or cancel to release them.",
          color: DISCORD_PALETTE.action,
          fields: [
            ...exact,
            { name: "Decision", value: preview.reason, inline: false },
            {
              name: "Expires",
              value: formatDiscordTimestamp(created.trade.expires_at),
              inline: true,
            },
            { name: "Trade", value: `\`${created.trade.id}\``, inline: true },
            {
              name: "Honesty",
              value:
                "NPC · synthetic collector. The decision is deterministic, based on its recorded holdings, goals and preset; no AI inference or human impersonation.",
              inline: false,
            },
          ],
          footer: {
            text: "Foilbury · NPC exchange · reserved copies do not transfer until confirm",
          },
        },
      ],
      components: components([
        [
          button("Confirm exchange", `foilbury:npc-confirm:${created.trade.id}`, 3),
          button("Cancel offer", `foilbury:npc-cancel:${created.trade.id}`, 2),
          {
            type: 2,
            style: 5,
            label: "Open trade desk",
            url: absoluteUrl(ctx.config.publicOrigin, `/play/trades?npc=${selected.id}`)!,
          },
        ],
      ]),
    },
    true,
  );
}

async function npcTradeConfirm(ctx: Ctx, tradeId: string): Promise<DiscordCallback> {
  const result = await confirmNpcTrade(ctx, tradeId);
  const items = result.trade.items;
  const gave = items.filter((item) => item.side === "proposer");
  const received = items.filter((item) => item.side === "recipient");
  return callback(
    {
      embeds: [
        {
          title: `Exchange complete · ${result.decision.npc_name}`,
          description:
            "The exact copies moved atomically. Serials and instance history are preserved; the NPC remains a labelled synthetic collector.",
          color: DISCORD_PALETTE.success,
          fields: [
            {
              name: "You gave",
              value:
                gave
                  .map((item) => `${item.card_name} · ${item.variant_name}\n\`${item.serial}\``)
                  .join("\n") || "—",
              inline: true,
            },
            {
              name: "You received",
              value:
                received
                  .map((item) => `${item.card_name} · ${item.variant_name}\n\`${item.serial}\``)
                  .join("\n") || "—",
              inline: true,
            },
            { name: "Decision", value: result.decision.reason, inline: false },
            {
              name: "Trade",
              value: `\`${result.trade.id}\` · ${result.trade.status}`,
              inline: false,
            },
          ],
          footer: {
            text: "Foilbury · NPC exchange · serials preserved · no fabricated human activity",
          },
        },
      ],
      components: components([
        [
          {
            type: 2,
            style: 5,
            label: "Open my trades",
            url: absoluteUrl(ctx.config.publicOrigin, "/play/trades")!,
          },
          {
            type: 2,
            style: 5,
            label: "Inspect the collector",
            url: absoluteUrl(ctx.config.publicOrigin, "/play/rivals")!,
          },
        ],
      ]),
    },
    true,
  );
}

async function npcTradeCancel(ctx: Ctx, tradeId: string): Promise<DiscordCallback> {
  const result = await cancelNpcTrade(ctx, tradeId);
  return callback(
    {
      embeds: [
        {
          title: "NPC offer cancelled",
          description:
            "The exact copies were released from reservation. Nothing moved and no serial changed ownership.",
          color: DISCORD_PALETTE.muted,
          fields: [
            {
              name: "Trade",
              value: `\`${result.trade.id}\` · ${result.trade.status}`,
              inline: false,
            },
          ],
        },
      ],
      components: components([
        [
          {
            type: 2,
            style: 5,
            label: "Open my trades",
            url: absoluteUrl(ctx.config.publicOrigin, "/play/trades")!,
          },
        ],
      ]),
    },
    true,
  );
}

async function missionsView(ctx: Ctx, notice?: string): Promise<DiscordCallback> {
  const state = await getDailyMissions(ctx);
  return missionProgressMessage({
    day: state.day,
    resetAt: state.reset_at,
    cap: state.cap,
    earnedToday: state.earned_today,
    currencySymbol: state.currency_symbol,
    ...(notice ? { notice } : {}),
    missions: state.missions.map((mission) => ({
      key: mission.key,
      title: mission.title,
      description: mission.description,
      progress: mission.progress,
      target: mission.target,
      reward: mission.reward,
      complete: mission.complete,
      claimed: mission.claimed,
      claimable: mission.claimable,
      ...(mission.claimable ? { claimCustomId: `foilbury:mission:claim:${mission.key}` } : {}),
    })),
    missionsUrl: absoluteUrl(ctx.config.publicOrigin, "/play/missions")!,
  });
}

async function help(ctx: Ctx): Promise<DiscordCallback> {
  const wallet = await getWalletSummary(ctx.db, ctx.tenant.id, ctx.user!.id, 1);
  const economy = await getEconomy(ctx);
  const lastReward = await first<{ created_at: string }>(
    ctx.db,
    "SELECT created_at FROM fb_reward_claims WHERE tenant_id = ? AND user_id = ? AND rule_key = 'daily-allowance' ORDER BY created_at DESC LIMIT 1",
    ctx.tenant.id,
    ctx.user!.id,
  );
  const next = lastReward
    ? new Date(new Date(lastReward.created_at).getTime() + economy.daily_cooldown_seconds * 1000)
    : null;
  return welcomeMessage({
    displayName: ctx.user!.displayName,
    scopeName: ctx.tenant.name,
    balance: wallet.balance,
    currencySymbol: wallet.currencySymbol,
    dailyAvailable: !next || next.getTime() <= Date.now(),
    nextDailyAt: next?.toISOString() ?? null,
    starterGrant: economy.starter_grant,
    dailyReward: economy.daily_reward,
    guide: HELP_TEXT,
    actions: {
      daily: "foilbury:daily",
      open: "foilbury:open:cabinet-draw",
      packs: "foilbury:packs",
    },
    helpUrl: absoluteUrl(ctx.config.publicOrigin, "/play/tour")!,
  });
}

async function adminStatus(ctx: Ctx, installation: DiscordInstallation): Promise<DiscordCallback> {
  requireBotAdmin(ctx.user!);
  const counts = await first<{ cards: number; pools: number; inventory: number; members: number }>(
    ctx.db,
    `SELECT
       (SELECT COUNT(*) FROM fb_card_definitions WHERE tenant_id = ? AND status = 'published' AND archived_at IS NULL) AS cards,
       (SELECT COUNT(*) FROM fb_pools WHERE tenant_id = ? AND status = 'active') AS pools,
       (SELECT COUNT(*) FROM fb_card_instances WHERE tenant_id = ? AND status IN ('owned','reserved')) AS inventory,
       (SELECT COUNT(*) FROM fb_memberships WHERE tenant_id = ?) AS members`,
    ctx.tenant.id,
    ctx.tenant.id,
    ctx.tenant.id,
    ctx.tenant.id,
  );
  return callback(
    {
      embeds: [
        {
          title: `Bot status · ${ctx.tenant.name}`,
          description: "This is Bot administration, not Foilbury platform administration.",
          color: DISCORD_PALETTE.success,
          fields: [
            {
              name: "Guild",
              value: `${installation.guild_name ?? "Unknown"} (\`${installation.guild_id}\`)`,
              inline: false,
            },
            {
              name: "Channel allowlist",
              value: installation.channel_allowlist_json,
              inline: false,
            },
            {
              name: "Game / website / API",
              value: `${installation.game_enabled} / ${installation.website_enabled} / ${installation.api_enabled}`,
              inline: false,
            },
            {
              name: "Catalogue / admin GUI",
              value: `${installation.public_catalogue_enabled} / ${installation.admin_gui_enabled}`,
              inline: false,
            },
            { name: "Published cards", value: String(counts?.cards ?? 0), inline: true },
            { name: "Active pools", value: String(counts?.pools ?? 0), inline: true },
            { name: "Owned cards", value: String(counts?.inventory ?? 0), inline: true },
            { name: "Members", value: String(counts?.members ?? 0), inline: true },
          ],
        },
      ],
    },
    true,
  );
}

async function adminSettings(
  ctx: Ctx,
  installation: DiscordInstallation,
): Promise<DiscordCallback> {
  requireBotAdmin(ctx.user!);
  const economy = await getEconomy(ctx);
  return callback(
    {
      embeds: [
        {
          title: "Bot settings",
          description:
            "Availability switches are independent. Disabling one does not delete inventory or disable another interface.",
          color: DISCORD_PALETTE.raised,
          fields: [
            {
              name: "Currency",
              value: `${economy.currency_name} (${economy.currency_symbol})`,
              inline: true,
            },
            { name: "Starter grant", value: String(economy.starter_grant), inline: true },
            { name: "Daily allowance", value: String(economy.daily_reward), inline: true },
            {
              name: "Cooldown",
              value: `${Math.round(economy.daily_cooldown_seconds / 3600)} hours`,
              inline: true,
            },
            {
              name: "Game",
              value: installation.game_enabled ? "enabled" : "disabled",
              inline: true,
            },
            {
              name: "Website",
              value: installation.website_enabled ? "enabled" : "disabled",
              inline: true,
            },
            {
              name: "External API",
              value: installation.api_enabled ? "enabled" : "disabled",
              inline: true,
            },
            {
              name: "Public catalogue",
              value: installation.public_catalogue_enabled ? "enabled" : "disabled",
              inline: true,
            },
            {
              name: "Admin GUI",
              value: installation.admin_gui_enabled ? "enabled" : "disabled",
              inline: true,
            },
            {
              name: "Sensitive changes",
              value:
                "Use /foilbury admin enable|disable and confirm with the button. Grants require confirmation.",
              inline: false,
            },
          ],
        },
      ],
    },
    true,
  );
}

async function adminPools(ctx: Ctx, installation: DiscordInstallation): Promise<DiscordCallback> {
  requireBotAdmin(ctx.user!);
  const pools = await listPools(ctx, true);
  const lines: string[] = [];
  for (const pool of pools.slice(0, 12)) {
    let eligible = "—";
    try {
      const preview = await getPoolPreview(ctx, pool.slug, installation.channel_key ?? undefined, {
        includeDraft: true,
      });
      eligible = String(preview.eligible_count);
    } catch {
      eligible = "0";
    }
    lines.push(
      `• **${pool.name}** \`${pool.slug}\` · ${pool.status} · rev ${pool.revision} · ${pool.price} ✦ · ${eligible} eligible`,
    );
  }
  return callback(
    {
      embeds: [
        {
          title: "Pools",
          description: lines.length ? lines.join("\n") : "No pools configured.",
          color: DISCORD_PALETTE.raised,
          footer: {
            text: "Pool membership and card availability are enforced by the domain service.",
          },
        },
      ],
    },
    true,
  );
}

async function createConfirmation(
  ctx: Ctx,
  interaction: DiscordInteraction,
  action: string,
  payload: Record<string, unknown>,
  title: string,
  description: string,
): Promise<DiscordCallback> {
  const id = newId("dcf");
  const expiresAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();
  await ctx.db
    .prepare(
      "INSERT INTO fb_discord_confirmations (id, tenant_id, discord_user_id, action, payload_json, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      id,
      ctx.tenant.id,
      interaction.member?.user?.id ?? interaction.user?.id ?? "",
      action,
      JSON.stringify(payload),
      expiresAt,
      nowIso(),
    )
    .run();
  return callback(
    {
      embeds: [
        {
          title,
          description: `${description}\n\nThis confirmation expires <t:${Math.floor(new Date(expiresAt).getTime() / 1000)}:R> and is bound to your Discord account.`,
          color: DISCORD_PALETTE.danger,
        },
      ],
      components: components([
        [
          button("Confirm", `foilbury:confirm:${id}`, 3),
          button("Cancel", `foilbury:cancel:${id}`, 4),
        ],
      ]),
    },
    true,
  );
}

async function adminToggle(
  ctx: Ctx,
  interaction: DiscordInteraction,
  installation: DiscordInstallation,
  surface: string,
  enabled: boolean,
): Promise<DiscordCallback> {
  requireBotAdmin(ctx.user!);
  const column = SURFACE_COLUMNS[surface];
  if (!column) throw new ApiError(422, "surface_invalid", "Choose a valid availability surface.");
  return createConfirmation(
    ctx,
    interaction,
    "installation.toggle",
    { surface, enabled, installationId: installation.id },
    `${enabled ? "Enable" : "Disable"} ${surface}?`,
    `This changes **${surface}** availability for **${ctx.tenant.name}** in this installation. It does not delete cards, inventory or ledger history.`,
  );
}

function studioGrantRequired(ctx: Ctx): DiscordCallback {
  return callback(
    {
      embeds: [
        {
          title: "Continue in Studio",
          description:
            "Foil grants need recent strong authentication. Confirm with a passkey, authenticator or Cloudflare Access, then grant in Studio.",
          color: DISCORD_PALETTE.muted,
        },
      ],
      components: components([
        [
          {
            type: 2,
            style: 5,
            label: "Open Studio",
            url: new URL("/studio/economy", ctx.config.publicOrigin).href,
          },
          {
            type: 2,
            style: 5,
            label: "Account security",
            url: new URL("/account/security", ctx.config.publicOrigin).href,
          },
        ],
      ]),
    },
    true,
  );
}

async function adminGrant(
  ctx: Ctx,
  _interaction: DiscordInteraction,
  _values: Record<string, string | number | boolean>,
): Promise<DiscordCallback> {
  return studioGrantRequired(ctx);
}

const TOUR_STAGES = [
  "welcome",
  "albums",
  "fresh",
  "open",
  "inspect",
  "progress",
  "share",
  "admin",
] as const;
type TourStage = (typeof TOUR_STAGES)[number];

function isTourStage(value: string): value is TourStage {
  return (TOUR_STAGES as readonly string[]).includes(value);
}

function tourNav(
  stage: TourStage,
  extra: DiscordComponent[][] = [],
): Array<{ type: number; components: DiscordComponent[] }> {
  const index = TOUR_STAGES.indexOf(stage);
  const used = new Set(
    extra.flatMap((row) => row.map((component) => component.custom_id).filter(Boolean)),
  );
  const row: DiscordComponent[] = [];
  const add = (label: string, customId: string, style: 1 | 2): void => {
    if (used.has(customId)) return;
    used.add(customId);
    row.push(button(label, customId, style));
  };
  const backId = index > 0 ? `foilbury:tour:${TOUR_STAGES[index - 1]}` : null;
  const nextId = index < TOUR_STAGES.length - 1 ? `foilbury:tour:${TOUR_STAGES[index + 1]}` : null;
  // Discord rejects the whole message when any custom_id is repeated, even
  // across different action rows. Back and Tour home can both resolve to the
  // welcome stage, and a stage button can duplicate Next. Keep the first
  // explicit control and omit the duplicate navigation control.
  if (backId) add("Back", backId, 2);
  if (nextId) add("Next", nextId, 1);
  add("Tour home", "foilbury:tour:welcome", 2);
  return components(row.length ? [...extra, row] : extra);
}

/**
 * Rank the server's actual enabled albums. There is deliberately no preferred
 * slug: the account's existing progress, a compact eight-subject roster and
 * then the larger catalogue decide, and the caller still verifies that the
 * release has published cards and renders.
 */
async function tourAlbum(ctx: Ctx, scope: DiscordScope) {
  const ranked = await rankDiscordAlbums(ctx, scope);
  for (const candidate of ranked) {
    if (candidate.collection.card_count <= 0) continue;
    let detail;
    try {
      detail = await getCollection(ctx, candidate.collection.id);
    } catch {
      continue;
    }
    const [cards, progress] = await Promise.all([
      listCollectionCards(ctx, detail.id, { includeAi: scope.aiArtEnabled }),
      collectionProgress(ctx, detail.id),
    ]);
    if (cards.length === 0) continue;
    return { detail, cards, progress };
  }
  return null;
}

function scopeFailureMessage(scope: DiscordScope): DiscordCallback {
  return callback(
    {
      embeds: [
        {
          title: "This server has no eligible collection",
          description: [
            scope.emptyReason ?? "No collection is available for this server and channel.",
            "",
            "The tour does not fall back to the global catalogue, a hard-coded album or another Bot's content. Nothing was charged or awarded.",
            "",
            "A Bot Owner or scoped admin can reconcile this in Studio → Collections and the Discord installation settings.",
          ].join("\n"),
          color: DISCORD_PALETTE.muted,
          footer: {
            text: `Server scope ${scope.digest.slice(0, 12)} · installation ${scope.installationId}`,
          },
        },
      ],
    },
    true,
  );
}

async function tour(
  ctx: Ctx,
  installation: DiscordInstallation,
  stage: TourStage,
  channelId?: string,
): Promise<DiscordCallback> {
  const scope = await resolveDiscordScope(ctx, installation, channelId ?? null);
  if (stage !== "admin" && scope.emptyReason) return scopeFailureMessage(scope);
  const wallet = await getWalletSummary(ctx.db, ctx.tenant.id, ctx.user!.id, 1);
  const economy = await getEconomy(ctx);
  const album = stage === "admin" ? null : await tourAlbum(ctx, scope);

  if (stage === "welcome") {
    const selected = album?.detail.name ?? "No eligible album";
    const collectionLines = scope.collections
      .slice(0, 6)
      .map((collection) => `• ${collection.name} · ${collection.audience_label}`)
      .join("\n");
    return callback(
      {
        embeds: [
          {
            title: "Foilbury · guided tour",
            description: [
              "Foilbury is a collectible-card cabinet. Claim a free allowance, open a capsule, and keep the copy in this Bot's cabinet.",
              "",
              "**What you can see here:** this private response, your own inventory and the albums this server actually enables. Nothing in the tour spends Foil, draws a card or grants a reward until you choose an action.",
            ].join("\n"),
            color: DISCORD_PALETTE.warning,
            fields: [
              {
                name: "This server's enabled collections",
                value: collectionLines || "No collection is eligible for this channel.",
                inline: false,
              },
              {
                name: "Tour album",
                value: selected,
                inline: true,
              },
              {
                name: "Member albums",
                value: `${scope.collections.length} available here`,
                inline: true,
              },
              {
                name: "Free play",
                value: `${economy.starter_grant} welcome · ${economy.daily_reward} daily`,
                inline: true,
              },
              {
                name: "Your balance",
                value: `${wallet.balance} ${wallet.currencySymbol}`,
                inline: true,
              },
              {
                name: "Server scope",
                value: `\`${scope.digest.slice(0, 16)}\` · ${scope.channelAudience} channel · AI artwork ${scope.aiArtEnabled ? "included" : "excluded"}`,
                inline: false,
              },
            ],
            footer: {
              text: "Private tour · configured server collections only · use Next to continue",
            },
          },
        ],
        components: tourNav("welcome", [
          [
            button("Start with an album", "foilbury:tour:albums", 1),
            button("How free play works", "foilbury:tour:fresh", 2),
          ],
          [button("Claim daily", "foilbury:daily", 2), button("Packs", "foilbury:packs", 2)],
        ]),
      },
      true,
    );
  }

  if (!album) {
    return callback(
      {
        embeds: [
          {
            title: "No member album is available",
            description:
              "This server has no enabled, published album your account can enter right now. Ask the Bot Owner to enable a collection. Nothing was charged or awarded.",
            color: DISCORD_PALETTE.muted,
          },
        ],
        components: tourNav(stage),
      },
      true,
    );
  }

  if (stage === "albums") {
    const achievement = (await listAchievements(ctx, ctx.user!.id)).find(
      (item) => item.criteria.collection_id === album.detail.id,
    );
    return callback(
      {
        embeds: [
          {
            title: album.detail.name,
            description: truncate(album.detail.description, 700),
            color: DISCORD_PALETTE.raised,
            fields: [
              { name: "Audience", value: album.detail.audience_label, inline: true },
              { name: "Cards", value: `${album.cards.length} in the release roster`, inline: true },
              {
                name: "Collection release",
                value: `Version ${album.detail.release_version}`,
                inline: true,
              },
              {
                name: "Published variants",
                value: String(album.progress.total_variants),
                inline: true,
              },
              {
                name: "Release roster",
                value: album.cards.length
                  ? album.cards.map((card) => `• ${card.name}`).join("\n")
                  : "No published cards.",
                inline: false,
              },
              {
                name: "Collection milestone",
                value: achievement
                  ? `${achievement.name} · ${Math.min(achievement.progress, achievement.target)}/${achievement.target} · ${achievement.state === "earned" ? `earned${achievement.reward_amount ? ` · +${achievement.reward_amount} Foil` : ""}` : "in progress"}`
                  : "No collection achievement is published.",
                inline: false,
              },
              {
                name: "Your progress",
                value: `${album.progress.owned_cards}/${album.progress.total_cards} unique cards · ${album.progress.complete ? "complete" : "incomplete"}`,
                inline: true,
              },
              {
                name: "Finish families",
                value: `4 core finishes`,
                inline: false,
              },
            ],
            footer: {
              text: "Prepared release roster and frozen achievement target · no cards were granted",
            },
          },
        ],
        components: tourNav("albums", [
          [
            button("How free play works", "foilbury:tour:fresh", 1),
            button("Inspect an album card", "foilbury:tour:inspect", 2),
          ],
        ]),
      },
      true,
    );
  }

  if (stage === "fresh") {
    const pools = await listEligiblePools(
      ctx,
      installation.channel_key ?? undefined,
      poolScopeFromDiscord(scope),
    );
    const lines: string[] = [];
    for (const preview of pools.slice(0, 4)) {
      const odds = new Map<string, number>();
      for (const entry of preview.entries) {
        const key = displayFinish(entry.variant_name, entry.material_key, entry.effect_key);
        odds.set(key, (odds.get(key) ?? 0) + entry.probability_bps);
      }
      const oddsText = [...odds.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([key, bps]) => `${key} ${(bps / 100).toFixed(2)}%`)
        .join(" · ");
      lines.push(
        `**${preview.pool.name}** · ${preview.price} ${wallet.currencySymbol} · ${preview.eligible_count} eligible\n${oddsText || "No eligible odds"}`,
      );
    }
    return callback(
      {
        embeds: [
          {
            title: "Free play, first run",
            description: [
              `Your first verified Discord interaction creates a player and credits the **${economy.starter_grant} Foil** welcome grant once.`,
              `The daily allowance is **${economy.daily_reward} Foil** every ${Math.round(economy.daily_cooldown_seconds / 3600)} hours; the allowance is shared by this Bot across Discord, the website and the API.`,
              `**Your balance:** ${wallet.balance} ${wallet.currencySymbol}. Pools and the exact current odds are shown below before you open anything.`,
            ].join("\n"),
            color: DISCORD_PALETTE.surface,
            fields: lines.length
              ? lines.map((line, index) => ({
                  name: `Pool ${index + 1}`,
                  value: line,
                  inline: false,
                }))
              : [
                  {
                    name: "Pools",
                    value: "No active pool is currently eligible. Nothing can be charged.",
                    inline: false,
                  },
                ],
            footer: {
              text: "Opening is a deliberate action and spends the displayed price. This stage never draws.",
            },
          },
        ],
        components: tourNav("fresh", [
          [
            button("Claim daily", "foilbury:daily", 2),
            button("Open a capsule", "foilbury:tour:open", 1),
          ],
        ]),
      },
      true,
    );
  }

  if (stage === "open") {
    let poolLine = "No eligible pool right now. Nothing can be charged.";
    let poolButton: DiscordComponent[] = [];
    const pools = await listEligiblePools(
      ctx,
      installation.channel_key ?? undefined,
      poolScopeFromDiscord(scope),
    );
    const preview = pools[0];
    if (preview) {
      if (wallet.balance >= preview.price) {
        poolLine = `**${preview.pool.name}** · ${preview.price} ${wallet.currencySymbol} · ${preview.eligible_count} eligible variant${preview.eligible_count === 1 ? "" : "s"}. Your balance is ${wallet.balance} ${wallet.currencySymbol}.`;
        poolButton = [button(`Open ${preview.pool.name}`, `foilbury:open:${preview.pool.slug}`, 1)];
      } else {
        poolLine = `${preview.pool.name} costs ${preview.price} ${wallet.currencySymbol}; your balance is ${wallet.balance} ${wallet.currencySymbol}. Claim the daily allowance first.`;
      }
    }
    return callback(
      {
        embeds: [
          {
            title: "A real opening",
            description: [
              "The next stage opens a real capsule when you choose it. The award, serial, finish, price and balance are committed together in one D1 transaction.",
              "",
              poolLine,
              "",
              "After the reveal, use **View front**, **View back**, **Details** and **Collection**. Those controls never spend or award another copy.",
              "3D inspection is a website feature, not a native Discord 3D view; the tour labels that link clearly.",
            ].join("\n"),
            color: DISCORD_PALETTE.danger,
            fields: [
              {
                name: "Balance",
                value: `${wallet.balance} ${wallet.currencySymbol}`,
                inline: true,
              },
              {
                name: "Spend",
                value: preview ? `${preview.price} ${wallet.currencySymbol}` : "—",
                inline: true,
              },
              { name: "Passive navigation", value: "Free", inline: true },
            ],
            footer: { text: "No automatic draw. Choose the open button only when you are ready." },
          },
        ],
        components: tourNav("open", poolButton.length ? [poolButton] : []),
      },
      true,
    );
  }

  if (stage === "inspect") {
    const finishRows = await ctx.db
      .prepare(
        `SELECT cd.id AS card_id, cd.name AS card_name, v.id AS variant_id, v.name AS variant_name,
                m.key AS material_key, fx.key AS effect_key
           FROM fb_collection_cards cc
           JOIN fb_card_definitions cd ON cd.id = cc.card_id AND cd.status = 'published' AND cd.archived_at IS NULL
           JOIN fb_variants v ON v.card_id = cd.id AND v.status = 'published' AND v.archived_at IS NULL
           JOIN fb_artwork_editions e ON e.id = v.edition_id
           JOIN fb_assets sa ON sa.id = e.subject_asset_id AND sa.tenant_id = e.tenant_id
           JOIN fb_materials m ON m.id = v.material_id
           LEFT JOIN fb_effects fx ON fx.id = v.effect_id
           JOIN fb_variant_renders vr ON vr.variant_id = v.id AND vr.status = 'published'
          WHERE cc.collection_id = ? AND cc.tenant_id = ?
            AND (? = 1 OR sa.origin NOT IN ('ai_assisted','ai_generated'))
          ORDER BY cc.sort, v.name`,
      )
      .bind(album.detail.id, ctx.tenant.id, scope.aiArtEnabled ? 1 : 0)
      .all<{
        card_id: string;
        card_name: string;
        variant_id: string;
        variant_name: string;
        material_key: string;
        effect_key: string | null;
      }>();
    const example = new Map<string, (typeof finishRows.results)[number]>();
    for (const row of finishRows.results) {
      const key = finishKey(row.material_key, row.effect_key);
      if (!example.has(key)) example.set(key, row);
    }
    // One action row for all four finishes. Four separate rows plus the owned
    // controls and navigation would exceed Discord's five-row limit.
    const finishButtons: DiscordComponent[] = [];
    for (const key of ["plain", "silver", "gold", "holographic"] as const) {
      const item = example.get(key);
      if (item)
        finishButtons.push(
          button(
            key === "holographic" ? "Holographic" : key[0]!.toUpperCase() + key.slice(1),
            `foilbury:card:${item.card_id}:${item.variant_id}:front`,
            2,
          ),
        );
    }
    const owned = await first<{ instance_id: string; card_id: string; variant_id: string }>(
      ctx.db,
      `SELECT ci.id AS instance_id, ci.card_id, ci.variant_id
         FROM fb_card_instances ci
         JOIN fb_collection_cards cc ON cc.card_id = ci.card_id AND cc.collection_id = ?
        WHERE ci.tenant_id = ? AND ci.user_id = ? AND ci.status IN ('owned','reserved')
        ORDER BY ci.acquired_at DESC LIMIT 1`,
      album.detail.id,
      ctx.tenant.id,
      ctx.user!.id,
    );
    const fields = Object.entries(Object.fromEntries(example)).map(([key, item]) => ({
      name: key[0]!.toUpperCase() + key.slice(1),
      value: `${item.card_name} · ${item.variant_name}`,
      inline: false,
    }));
    const originRows = await ctx.db
      .prepare(
        `SELECT sa.origin AS origin, COUNT(DISTINCT cd.id) AS cards
           FROM fb_collection_cards cc
           JOIN fb_card_definitions cd ON cd.id = cc.card_id
           JOIN fb_artwork_editions e ON e.card_id = cd.id
           JOIN fb_assets sa ON sa.id = e.subject_asset_id
          WHERE cc.collection_id = ? AND cc.tenant_id = ?
          GROUP BY sa.origin`,
      )
      .bind(album.detail.id, ctx.tenant.id)
      .all<{ origin: string; cards: number }>();
    const origins = originRows.results.map((row) => row.origin);
    const artworkSummary = origins.some(
      (origin) => origin === "ai_assisted" || origin === "ai_generated",
    )
      ? origins.every((origin) => origin === "ai_assisted" || origin === "ai_generated")
        ? "AI-assisted artwork; reviewed, labelled and not official. This Bot includes AI-assisted editions."
        : "Mixed: sourced/original and AI-assisted editions. Each print carries its own origin label."
      : "Sourced character references with Foilbury-original card design and finishes. Not AI-generated.";
    return callback(
      {
        embeds: [
          {
            title: `Inspect · ${album.detail.name}`,
            description: [
              "These buttons open real published front renders for the four core finishes in this album. Viewing a side or details is private and free.",
              owned
                ? "A card from this album is in your cabinet. Use the inspection controls below."
                : "You do not own a card from this album yet. The finish examples are still real catalogue renders; open the album to add your first copy.",
              "",
              "**3D:** open the signed-in web album. Discord does not present native 3D cards.",
            ].join("\n"),
            color: DISCORD_PALETTE.action,
            fields: [
              ...(fields.length
                ? fields
                : [
                    {
                      name: "Renders",
                      value: "No published finish renders are available.",
                      inline: false,
                    },
                  ]),
              { name: "Artwork provenance", value: artworkSummary, inline: false },
            ],
            footer: {
              text: "Private member view · viewing does not spend Foil or award another copy",
            },
          },
        ],
        components: tourNav("inspect", [
          ...(finishButtons.length ? [finishButtons] : []),
          ...(owned
            ? [
                [
                  button(
                    "View front",
                    `foilbury:card:${owned.card_id}:${owned.variant_id}:front`,
                    2,
                  ),
                  button("View back", `foilbury:card:${owned.card_id}:${owned.variant_id}:back`, 2),
                  button("Details", `foilbury:card:${owned.card_id}:details`, 2),
                  {
                    type: 2,
                    style: 5,
                    label: "Open in web album (3D)",
                    url: absoluteUrl(ctx.config.publicOrigin, `/play/card/${owned.instance_id}`)!,
                  },
                ],
              ]
            : []),
        ]),
      },
      true,
    );
  }

  if (stage === "progress") {
    const inventory = (
      await getInventory(ctx, { collection: album.detail.slug, limit: 500 })
    ).filter((item) => scope.aiArtEnabled || !isAiEditionOrigin(item.subject_origin));
    const unique = new Set(inventory.map((item) => item.card_id));
    const variants = new Set(inventory.map((item) => item.variant_id));
    const duplicates = inventory.length - unique.size;
    const achievements = await listAchievements(ctx, ctx.user!.id);
    const collectionAchievements = achievements.filter(
      (item) => item.criteria.collection_id === album.detail.id,
    );
    const earned = collectionAchievements.filter((item) => item.state === "earned");
    const next = collectionAchievements
      .filter((item) => item.state !== "earned")
      .sort((a, b) => b.progress / Math.max(1, b.target) - a.progress / Math.max(1, a.target))[0];
    const completion = collectionAchievements
      .filter((item) => item.criteria?.type === "collection_complete" && item.state === "earned")
      .sort((a, b) => b.reward_amount - a.reward_amount)[0];
    const frozenRoster = Array.isArray(completion?.criteria?.roster_card_ids)
      ? (completion.criteria.roster_card_ids as unknown[]).length
      : (completion?.target ?? 0);
    const versionLabel = completion
      ? `version ${completion.version}${frozenRoster ? ` · frozen roster ${frozenRoster}` : ""}`
      : null;
    const expandedAfterUnlock = Boolean(
      completion && frozenRoster > 0 && frozenRoster < album.progress.total_cards,
    );
    const celebration = album.progress.complete
      ? completion
        ? `Completion unlocked: **${completion.name}**${completion.reward_amount ? ` · +${completion.reward_amount} Foil credited once` : ""}${completion.earned_at ? ` · ${new Date(completion.earned_at).toISOString().slice(0, 10)}` : ""}${versionLabel ? ` · ${versionLabel}` : ""}${expandedAfterUnlock ? ` · the live roster has since expanded to ${album.progress.total_cards}; this earned version stays complete at ${frozenRoster}` : ""}`
        : "The album is complete. The milestone will be evaluated by the next committed acquisition; the tour does not award it passively."
      : `Next target: ${next ? `${next.name} · ${Math.min(next.progress, next.target)}/${next.target}` : "keep collecting"}`;
    return callback(
      {
        embeds: [
          {
            title: `Progress · ${album.detail.name}`,
            description: celebration,
            color: album.progress.complete ? DISCORD_PALETTE.success : DISCORD_PALETTE.raised,
            fields: [
              {
                name: "Unique subjects",
                value: `${unique.size}/${album.progress.total_cards}`,
                inline: true,
              },
              { name: "Owned copies", value: String(inventory.length), inline: true },
              { name: "Duplicates", value: String(duplicates), inline: true },
              {
                name: "Variant progress",
                value: `${variants.size}/${album.progress.total_variants}`,
                inline: true,
              },
              {
                name: "Earned badges",
                value: `${earned.length}/${collectionAchievements.length}`,
                inline: true,
              },
              {
                name: "Completion",
                value: album.progress.complete
                  ? `${album.progress.total_cards}/${album.progress.total_cards} current roster${versionLabel ? ` · ${versionLabel}` : ""}`
                  : "Incomplete",
                inline: false,
              },
              ...(next
                ? [
                    {
                      name: "Next milestone",
                      value: `${next.name} · ${Math.min(next.progress, next.target)}/${next.target}${next.reward_amount ? ` · +${next.reward_amount} Foil` : ""}`,
                      inline: false,
                    },
                  ]
                : []),
              {
                name: "What becomes public",
                value:
                  "Nothing until you explicitly share. This response is private, and a shared post never contains your balance, email or admin controls.",
                inline: false,
              },
            ],
            footer: { text: "Progress uses committed receipts, not local counters" },
          },
        ],
        components: tourNav("progress", [
          [
            button("Achievements", "foilbury:achievements", 2),
            button("Share progress", "foilbury:tour:share", 2),
            ...(album.progress.complete
              ? [button("Share completion", `foilbury:tourshare:completion:${album.detail.id}`, 1)]
              : []),
          ],
        ]),
      },
      true,
    );
  }

  if (stage === "share") {
    const scopedCardIds = await discordScopeCardIds(ctx, scope);
    const inventory = (await getInventory(ctx, { limit: 500 })).filter(
      (item) =>
        scopedCardIds.has(item.card_id) &&
        (scope.aiArtEnabled || !isAiEditionOrigin(item.subject_origin)),
    );
    const channelAudience = channelAudienceFor(installation, channelId);
    let publicCard: (typeof inventory)[number] | null = null;
    for (const item of inventory.slice(0, 20)) {
      if ((await effectiveCardAudience(ctx, item.card_id)) === "public") {
        publicCard = item;
        break;
      }
    }
    const albumCard =
      inventory.find((item) => album.cards.some((card) => card.id === item.card_id)) ?? null;
    const albumCardAudience = albumCard
      ? await effectiveCardAudience(ctx, albumCard.card_id)
      : "private";
    const albumCardAi = albumCard
      ? await first<{ origin: string | null }>(
          ctx.db,
          `SELECT sa.origin FROM fb_variants v
             JOIN fb_artwork_editions e ON e.id = v.edition_id
             JOIN fb_assets sa ON sa.id = e.subject_asset_id
            WHERE v.id = ?`,
          albumCard.variant_id,
        )
      : null;
    const canShareAlbumCard =
      albumCard !== null &&
      (scope.aiArtEnabled ||
        !["ai_assisted", "ai_generated"].includes(albumCardAi?.origin ?? "")) &&
      albumCardAudience !== "private" &&
      audienceRank(channelAudience) >= audienceRank(albumCardAudience);
    const canShareCompletion =
      album.detail.view_audience !== "private" &&
      audienceRank(channelAudience) >= audienceRank(album.detail.view_audience);
    const available = [
      publicCard
        ? `• Public showcase card: ${publicCard.card_name} — ${publicCard.variant_name}`
        : "",
      canShareAlbumCard && albumCard
        ? `• Member album card: ${albumCard.card_name} — ${albumCard.variant_name}`
        : "",
      "• Your profile summary (no wallet or private account data)",
      album.progress.complete && canShareCompletion ? "• This complete album" : "",
    ].filter(Boolean);
    return callback(
      {
        embeds: [
          {
            title: "Share deliberately",
            description: [
              "Sharing is a separate, explicit action. A shared post is visible to everyone with access to this channel and its attachments can be copied after delivery.",
              "Foilbury checks the card or achievement audience and the channel policy before posting. Consent does not override a restricted collection.",
              "The tour never shares automatically, and no shared post includes your balance, email, sessions or administrator controls.",
            ].join("\n"),
            color: DISCORD_PALETTE.raised,
            fields: [
              {
                name: "Destination",
                value: channelId ? `<#${channelId}>` : "This channel",
                inline: false,
              },
              {
                name: "Available here",
                value: available.length
                  ? available.join("\n")
                  : "Only your profile summary is available in this channel.",
                inline: false,
              },
              ...(albumCard && !canShareAlbumCard
                ? [
                    {
                      name: "Restricted artwork",
                      value:
                        "This channel has not been verified for the member album's audience, so its card art stays private to you.",
                      inline: false,
                    },
                  ]
                : []),
            ],
            footer: { text: "An already-posted Discord attachment cannot be made private later" },
          },
        ],
        components: tourNav("share", [
          [
            ...(publicCard
              ? [button("Share public card", `foilbury:tourshare:card:${publicCard.id}`, 1)]
              : []),
            ...(canShareAlbumCard && albumCard
              ? [button("Share album card", `foilbury:tourshare:card:${albumCard.id}`, 1)]
              : []),
            button("Share profile", `foilbury:tourshare:profile:${ctx.user!.id}`, 2),
            ...(album.progress.complete && canShareCompletion
              ? [button("Share completion", `foilbury:tourshare:completion:${album.detail.id}`, 1)]
              : []),
          ],
        ]),
      },
      true,
    );
  }

  if (stage === "admin") {
    if (!isBotAdmin(ctx.user!)) {
      return callback(
        {
          embeds: [
            {
              title: "Administration is private",
              description:
                "This appendix is only available to this Bot's Owner or Admin. Server moderator status does not grant Foilbury administration.",
              color: DISCORD_PALETTE.muted,
            },
          ],
          components: tourNav("admin"),
        },
        true,
      );
    }
    const counts = await first<{ cards: number; pools: number; members: number }>(
      ctx.db,
      `SELECT
         (SELECT COUNT(*) FROM fb_card_definitions WHERE tenant_id = ? AND status = 'published' AND archived_at IS NULL) AS cards,
         (SELECT COUNT(*) FROM fb_pools WHERE tenant_id = ? AND status = 'active') AS pools,
         (SELECT COUNT(*) FROM fb_memberships WHERE tenant_id = ? AND status = 'active') AS members`,
      ctx.tenant.id,
      ctx.tenant.id,
      ctx.tenant.id,
    );
    return callback(
      {
        embeds: [
          {
            title: "Administration appendix · private",
            description: [
              "**Bot administration** is scoped to this Bot. Use `/foilbury admin status|settings|pools|enable|disable|grant` or your signed-in Foilbury Studio. A scoped Admin never needs the owner's Cloudflare entrance.",
              "**Platform administration** and the native EmDash console are separate Cloudflare Access areas. Neither is granted by Discord guild ownership or a Bot role.",
            ].join("\n"),
            color: DISCORD_PALETTE.surface,
            fields: [
              { name: "Bot", value: ctx.tenant.name, inline: true },
              { name: "Published cards", value: String(counts?.cards ?? 0), inline: true },
              { name: "Active pools", value: String(counts?.pools ?? 0), inline: true },
              { name: "Active members", value: String(counts?.members ?? 0), inline: true },
              {
                name: "Channel policy",
                value:
                  "Reveals are channel-visible only when the installation has verified the channel audience. Otherwise restricted art stays ephemeral.",
                inline: false,
              },
            ],
            footer: { text: "This response is private to the administrator" },
          },
        ],
        components: tourNav("admin", [
          [
            {
              type: 2,
              style: 5,
              label: "Open Foilbury Studio",
              url: absoluteUrl(ctx.config.publicOrigin, "/studio")!,
            },
            ...(ctx.user!.capabilities?.includes("grants") ||
            ctx.user!.capabilities?.includes("economy")
              ? [
                  {
                    type: 2,
                    style: 5,
                    label: "Foil & grants",
                    url: absoluteUrl(ctx.config.publicOrigin, "/studio/economy")!,
                  },
                ]
              : []),
            ...(ctx.user!.platformAdmin
              ? [
                  {
                    type: 2,
                    style: 5,
                    label: "Owner operator console",
                    url: absoluteUrl(ctx.config.publicOrigin, "/admin")!,
                  },
                  {
                    type: 2,
                    style: 5,
                    label: "Platform Admin",
                    url: absoluteUrl(ctx.config.publicOrigin, "/platform-admin")!,
                  },
                  {
                    type: 2,
                    style: 5,
                    label: "Open EmDash",
                    url: absoluteUrl(ctx.config.publicOrigin, "/_emdash/admin")!,
                  },
                ]
              : []),
          ],
        ]),
      },
      true,
    );
  }

  throw new ApiError(404, "tour_stage_unknown", "That tour stage is not recognised.");
}

async function tourShare(
  ctx: Ctx,
  interaction: DiscordInteraction,
  installation: DiscordInstallation,
  kind: string,
  objectId: string,
  providedScope?: DiscordScope,
): Promise<DiscordCallback> {
  if (!["card", "completion", "profile"].includes(kind)) {
    throw new ApiError(422, "share_kind_invalid", "That share type is not available.");
  }
  if (!interaction.channel_id)
    throw new ApiError(
      403,
      "share_channel_required",
      "Sharing needs an authorised server channel.",
    );
  const scope =
    providedScope ?? (await resolveDiscordScope(ctx, installation, interaction.channel_id));
  if (scope.emptyReason) throw new ApiError(403, "share_scope_empty", scope.emptyReason);
  const channelAudience = channelAudienceFor(installation, interaction.channel_id);
  let embed: DiscordEmbed;
  let audience: "public" | "members" | "private" = "public";
  let render: { r2_key: string; mime: string; width: number; height: number } | null = null;

  if (kind === "card") {
    const row = await first<{
      id: string;
      card_id: string;
      variant_id: string;
      card_name: string;
      variant_name: string;
      material_key: string;
      effect_key: string | null;
      serial: string;
      collection_name: string | null;
      r2_key: string;
      mime: string;
      width: number;
      height: number;
    }>(
      ctx.db,
      `SELECT ci.id, ci.card_id, ci.variant_id, cd.name AS card_name, v.name AS variant_name,
              m.key AS material_key, fx.key AS effect_key, ci.serial,
              (SELECT c.name FROM fb_collection_cards cc JOIN fb_collections c ON c.id = cc.collection_id WHERE cc.card_id = cd.id ORDER BY CASE c.scope WHEN 'global' THEN 0 ELSE 1 END LIMIT 1) AS collection_name,
              a.r2_key, a.mime, vr.width, vr.height
         FROM fb_card_instances ci
         JOIN fb_card_definitions cd ON cd.id = ci.card_id
         JOIN fb_variants v ON v.id = ci.variant_id
         JOIN fb_materials m ON m.id = v.material_id
         LEFT JOIN fb_effects fx ON fx.id = v.effect_id
         JOIN fb_variant_renders vr ON vr.variant_id = v.id AND vr.status = 'published'
         JOIN fb_assets a ON a.id = vr.asset_id AND a.tenant_id = vr.tenant_id
        WHERE ci.tenant_id = ? AND ci.user_id = ? AND ci.id = ? AND ci.status IN ('owned','reserved')
        LIMIT 1`,
      ctx.tenant.id,
      ctx.user!.id,
      objectId,
    );
    if (!row)
      throw new ApiError(404, "share_card_missing", "That owned card is not in your cabinet.");
    if (!(await canViewCard(ctx, row.card_id)))
      throw new ApiError(404, "share_card_missing", "That card is not available to this album.");
    await assertCardInDiscordScope(ctx, scope, row.card_id);
    const scopedCollection = await first<{ name: string }>(
      ctx.db,
      `SELECT c.name FROM fb_collection_cards cc JOIN fb_collections c ON c.id = cc.collection_id
        WHERE cc.card_id = ? AND cc.collection_id IN (${scope.collectionIds.map(() => "?").join(",")})
        ORDER BY c.sort, c.name LIMIT 1`,
      row.card_id,
      ...scope.collectionIds,
    );
    row.collection_name = scopedCollection?.name ?? row.collection_name;
    audience = await effectiveCardAudience(ctx, row.card_id);
    if (audience === "private") {
      throw new ApiError(
        403,
        "share_private_not_available",
        "Private collection artwork cannot be shared to a channel.",
      );
    }
    if (audienceRank(channelAudience) < audienceRank(audience)) {
      throw new ApiError(
        403,
        "share_channel_audience",
        "This channel has not been verified for that card's audience. It stays private.",
      );
    }
    embed = {
      title: `${row.card_name} — ${row.variant_name}`,
      description: `Shared by **${ctx.user!.displayName}** with explicit consent. The copy remains owned by the collector; sharing does not grant it to anyone else.`,
      color: DISCORD_PALETTE.warning,
      fields: [
        { name: "Collection", value: row.collection_name ?? "Foilbury", inline: true },
        {
          name: "Finish",
          value: displayFinish(row.variant_name, row.material_key, row.effect_key),
          inline: true,
        },
        { name: "Serial", value: `\`${row.serial}\``, inline: true },
      ],
      footer: {
        text: "Shared attachment · viewers cannot operate this copy · no wallet or account data",
      },
      image: { url: "attachment://foilbury-share.webp", width: row.width, height: row.height },
    };
    render = row;
    objectId = row.card_id;
  } else if (kind === "completion") {
    const album = await getCollection(ctx, objectId);
    if (!scope.collectionIds.includes(album.id)) {
      throw new ApiError(
        403,
        "share_outside_scope",
        "That album is not enabled for this server. Nothing was shared.",
      );
    }
    const progress = await collectionProgress(ctx, album.id);
    if (!progress.complete)
      throw new ApiError(
        409,
        "completion_incomplete",
        "That album is not complete yet. Nothing was shared.",
      );
    audience = album.view_audience;
    if (audience === "private") {
      throw new ApiError(
        403,
        "share_private_not_available",
        "Private collection artwork cannot be shared to a channel.",
      );
    }
    if (audienceRank(channelAudience) < audienceRank(audience)) {
      throw new ApiError(
        403,
        "share_channel_audience",
        "This channel has not been verified for that album's audience. It stays private.",
      );
    }
    embed = {
      title: `${album.name} · complete`,
      description: `**${ctx.user!.displayName}** completed this member album: ${progress.owned_cards}/${progress.total_cards} unique subjects.`,
      color: DISCORD_PALETTE.success,
      fields: [
        { name: "Album", value: album.name, inline: true },
        {
          name: "Progress",
          value: `${progress.owned_cards}/${progress.total_cards}`,
          inline: true,
        },
        { name: "Audience", value: album.audience_label, inline: true },
      ],
      footer: { text: "Explicit completion share · no balance, email or admin controls" },
    };
  } else {
    const [prefs, profileOptions] = await Promise.all([
      getPreferences(ctx),
      getProfilePresentationOptions(ctx),
    ]);
    const presentation = resolveProfilePresentation(
      prefs.profile_presentation,
      profileOptions,
      prefs.profile_presentation_version,
    );
    const featured = presentation.featured;
    objectId = ctx.user!.id;
    if (channelAudience === "public") {
      const scopedCardIds = await discordScopeCardIds(ctx, scope);
      const inventory = (await getInventory(ctx, { limit: 200 })).filter((item) =>
        scopedCardIds.has(item.card_id),
      );
      const achievements = await listAchievements(ctx, ctx.user!.id);
      const publicCards: string[] = [];
      for (const item of inventory.slice(0, 20)) {
        if ((await effectiveCardAudience(ctx, item.card_id)) === "public")
          publicCards.push(item.card_id);
      }
      const publicBadges = achievements.filter(
        (item) =>
          item.state === "earned" &&
          item.visibility === "public" &&
          (!item.criteria?.collection_id ||
            (typeof item.criteria.collection_id === "string" &&
              scope.collectionIds.includes(item.criteria.collection_id))),
      );
      audience = "public";
      embed = {
        title: `${ctx.user!.displayName} · collector profile`,
        description:
          "A member chose to share this public profile summary in an authorised channel. Member artwork and favourites stay private.",
        color: DISCORD_PALETTE.raised,
        fields: [
          {
            name: "Public showcase cards",
            value: String(new Set(publicCards).size),
            inline: true,
          },
          { name: "Public badges", value: String(publicBadges.length), inline: true },
        ],
        footer: {
          text: "Only approved public counts · no wallet, email, member roster, session or administrator data",
        },
      };
    } else {
      if (featured) {
        await assertCardInDiscordScope(ctx, scope, featured.cardId);
        const featuredAudience = await effectiveCardAudience(ctx, featured.cardId);
        if (audienceRank(channelAudience) < audienceRank(featuredAudience)) {
          throw new ApiError(
            403,
            "share_channel_audience",
            "This channel has not been verified for the featured card's audience. Nothing was shared.",
          );
        }
      }
      render = featured ? await profileRenderFor(ctx, featured.id) : null;
      const scopedBadgeNames = new Set(
        (await listAchievements(ctx, ctx.user!.id))
          .filter(
            (achievement) =>
              achievement.state === "earned" &&
              (!achievement.criteria?.collection_id ||
                (typeof achievement.criteria.collection_id === "string" &&
                  scope.collectionIds.includes(achievement.criteria.collection_id))),
          )
          .map((achievement) => achievement.name),
      );
      const badgeNames = presentation.badges
        .map((badge) => badge.name)
        .filter((name) => scopedBadgeNames.has(name))
        .slice(0, 6);
      const fields: Array<{ name: string; value: string; inline?: boolean }> = [
        { name: "Look", value: starterLookLabel(prefs.profile_look), inline: true },
      ];
      if (featured) {
        const meta =
          featured.finish && featured.finish !== featured.variantName
            ? `${featured.variantName} · ${featured.finish}`
            : featured.variantName;
        fields.push({
          name: "Featured copy",
          value: `**${featured.cardName}**\n${meta}`,
          inline: false,
        });
      }
      if (badgeNames.length) {
        fields.push({
          name: "Selected badges",
          value: badgeNames.join(" · ").slice(0, 1000),
          inline: false,
        });
      }
      if (prefs.profile_bio) {
        fields.push({
          name: "Collector note",
          value: prefs.profile_bio.slice(0, 1000),
          inline: false,
        });
      }
      fields.push({
        name: "Privacy",
        value:
          "Shared by explicit consent. No wallet, email, account ID, ledger or card serial is included.",
        inline: false,
      });
      audience = "members";
      embed = {
        title: `${ctx.user!.displayName} · collector profile`,
        description:
          "A member chose to share this collector view in an authorised channel. The featured copy is the exact owned card; the look and badges are the saved composition.",
        color: DISCORD_PALETTE.action,
        fields,
        ...(render
          ? { image: { url: "attachment://foilbury-share.webp", width: 750, height: 1050 } }
          : {}),
        footer: {
          text: "Foilbury composition · member audience · changing a look does not alter past awards",
        },
      };
    }
  }

  const shareId = newId("shr");
  try {
    await ctx.db
      .prepare(
        `INSERT INTO fb_discord_shares (id, tenant_id, user_id, channel_id, object_type, object_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(shareId, ctx.tenant.id, ctx.user!.id, interaction.channel_id, kind, objectId, nowIso())
      .run();
  } catch (error) {
    if (String(error).includes("UNIQUE")) {
      throw new ApiError(
        409,
        "share_already_delivered",
        "That item was already shared in this channel. Nothing was posted again.",
      );
    }
    throw error;
  }

  const result = callback(
    {
      embeds: [embed],
      components: components([
        [
          {
            type: 2,
            style: 5,
            label: kind === "profile" ? "View the full profile" : "Open the album",
            url: absoluteUrl(
              ctx.config.publicOrigin,
              kind === "profile" ? "/play/profile" : "/play",
            )!,
          },
        ],
      ]),
    },
    false,
  );
  if (render) {
    result.attachments = [
      {
        r2Key: render.r2_key,
        filename: "foilbury-share.webp",
        contentType: render.mime || "image/webp",
      },
    ];
  }
  return result;
}

export async function runCommand(
  ctx: Ctx,
  interaction: DiscordInteraction,
  installation: DiscordInstallation,
): Promise<DiscordCallback> {
  const { subcommand, values } = parseCommand(interaction.data);
  switch (subcommand) {
    case "open":
      return openCard(
        ctx,
        interaction,
        installation,
        poolName(values),
        drawIdempotencyKey(interaction.id),
      );
    case "daily":
      return daily(ctx, interaction);
    case "missions":
      return missionsView(ctx);
    case "collection":
      return collection(ctx, installation, undefined, interaction.channel_id);
    case "card": {
      const query = typeof values.query === "string" ? values.query.trim() : "";
      if (!query)
        throw new ApiError(422, "card_query_required", "Provide a card name, slug or ID.");
      return card(ctx, query, installation, undefined, interaction.channel_id);
    }
    case "packs":
      return packs(ctx, installation, undefined, interaction.channel_id);
    case "achievements":
      return achievements(ctx, installation, undefined, interaction.channel_id);
    case "tour":
      return tour(ctx, installation, "welcome", interaction.channel_id);
    case "profile":
      return profile(ctx, installation, undefined, interaction.channel_id);
    case "npc":
      return npcView(
        ctx,
        installation,
        typeof values.name === "string" ? values.name : "",
        interaction.channel_id,
      );
    case "trade":
      return npcTradeCommand(ctx, interaction, installation, values);
    case "help":
      return help(ctx);
    case "admin:status":
      return adminStatus(ctx, installation);
    case "admin:settings":
      return adminSettings(ctx, installation);
    case "admin:pools":
      return adminPools(ctx, installation);
    case "admin:enable": {
      const surface = typeof values.surface === "string" ? values.surface : "";
      return adminToggle(ctx, interaction, installation, surface, true);
    }
    case "admin:disable": {
      const surface = typeof values.surface === "string" ? values.surface : "";
      return adminToggle(ctx, interaction, installation, surface, false);
    }
    case "admin:grant":
      return adminGrant(ctx, interaction, values);
    default:
      throw new ApiError(
        404,
        "discord_command_unknown",
        "That Foilbury command is not implemented.",
      );
  }
}

async function executeConfirmation(
  ctx: Ctx,
  interaction: DiscordInteraction,
  confirmationId: string,
): Promise<DiscordCallback> {
  const discordUserId = interaction.member?.user?.id ?? interaction.user?.id ?? "";
  const row = await first<{
    id: string;
    tenant_id: string;
    discord_user_id: string;
    action: string;
    payload_json: string;
    expires_at: string;
    used_at: string | null;
  }>(
    ctx.db,
    "SELECT id, tenant_id, discord_user_id, action, payload_json, expires_at, used_at FROM fb_discord_confirmations WHERE id = ? AND tenant_id = ?",
    confirmationId,
    ctx.tenant.id,
  );
  if (!row) throw new ApiError(404, "confirmation_missing", "That confirmation does not exist.");
  if (row.discord_user_id !== discordUserId)
    throw new ApiError(403, "confirmation_not_yours", "This confirmation belongs to another user.");
  if (row.used_at)
    throw new ApiError(409, "confirmation_used", "That confirmation has already been used.");
  if (new Date(row.expires_at).getTime() <= Date.now())
    throw new ApiError(
      409,
      "confirmation_expired",
      "That confirmation expired. Run the admin command again.",
    );
  requireBotAdmin(ctx.user!);
  const payload = JSON.parse(row.payload_json) as Record<string, unknown>;

  if (row.action === "installation.toggle") {
    const surface = typeof payload.surface === "string" ? payload.surface : "";
    const enabled = Boolean(payload.enabled);
    const installationId = typeof payload.installationId === "string" ? payload.installationId : "";
    const column = SURFACE_COLUMNS[surface];
    if (!column || !installationId)
      throw new ApiError(422, "surface_invalid", "Unknown availability surface.");
    await ctx.db.batch([
      ctx.db
        .prepare(
          `UPDATE fb_discord_installations SET ${column} = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`,
        )
        .bind(enabled ? 1 : 0, nowIso(), installationId, ctx.tenant.id),
      ctx.db
        .prepare("UPDATE fb_discord_confirmations SET used_at = ? WHERE id = ? AND used_at IS NULL")
        .bind(nowIso(), confirmationId),
      auditStatement(
        ctx,
        enabled ? "discord.surface.enabled" : "discord.surface.disabled",
        "discord_installation",
        installationId,
        {
          surface,
          enabled,
        },
      ),
    ]);
    return callback(
      {
        embeds: [
          {
            title: `${surface} ${enabled ? "enabled" : "disabled"}`,
            description:
              "The change is live. Inventory, ownership history and the other interfaces are unchanged.",
            color: enabled ? DISCORD_PALETTE.success : DISCORD_PALETTE.danger,
          },
        ],
      },
      true,
    );
  }

  if (row.action === "wallet.grant") {
    return studioGrantRequired(ctx);
  }

  throw new ApiError(
    422,
    "confirmation_action_unknown",
    "That confirmation action is not supported.",
  );
}

export async function runComponent(
  ctx: Ctx,
  interaction: DiscordInteraction,
  installation: DiscordInstallation,
): Promise<DiscordCallback> {
  const customId = interaction.data?.custom_id ?? "";
  if (customId.startsWith("foilbury:tour:")) {
    const stage = customId.slice("foilbury:tour:".length);
    if (!isTourStage(stage))
      throw new ApiError(404, "tour_stage_unknown", "That tour stage is not recognised.");
    return tour(ctx, installation, stage, interaction.channel_id);
  }
  if (customId.startsWith("foilbury:tourshare:")) {
    const [kind, objectId] = customId.slice("foilbury:tourshare:".length).split(":");
    if (!kind || !objectId)
      throw new ApiError(422, "share_invalid", "That share control is incomplete.");
    return tourShare(ctx, interaction, installation, kind, objectId);
  }
  if (customId.startsWith("foilbury:open:")) {
    const pool = validatePoolSlug(customId.slice("foilbury:open:".length));
    return openCard(ctx, interaction, installation, pool, drawIdempotencyKey(interaction.id));
  }
  if (customId.startsWith("foilbury:reveal:")) {
    const originalInteractionId = customId.slice("foilbury:reveal:".length).split(":")[0]?.trim();
    if (!originalInteractionId || !/^[A-Za-z0-9_-]{4,80}$/.test(originalInteractionId)) {
      throw new ApiError(422, "reveal_invalid", "That reveal control is incomplete.");
    }
    return revealCommittedDraw(ctx, interaction, installation, originalInteractionId);
  }
  if (customId.startsWith("foilbury:redeliver:")) {
    const originalInteractionId = customId
      .slice("foilbury:redeliver:".length)
      .split(":")[0]
      ?.trim();
    if (!originalInteractionId || !/^[A-Za-z0-9_-]{4,80}$/.test(originalInteractionId)) {
      throw new ApiError(422, "redeliver_invalid", "That receipt retry control is incomplete.");
    }
    return redeliverReceipt(ctx, interaction, installation, originalInteractionId);
  }
  if (customId === "foilbury:collection")
    return collection(ctx, installation, undefined, interaction.channel_id);
  if (customId === "foilbury:daily") return daily(ctx, interaction);
  if (customId.startsWith("foilbury:mission:claim:")) {
    const key = customId.slice("foilbury:mission:claim:".length);
    const claimed = await claimDailyMission(ctx, key, `discord:${interaction.id}:mission:${key}`);
    return missionsView(ctx, `+${claimed.amount} Foil credited. Balance ${claimed.balance_after}.`);
  }
  if (customId === "foilbury:packs")
    return packs(ctx, installation, undefined, interaction.channel_id);
  if (customId === "foilbury:help") return help(ctx);
  if (customId.startsWith("foilbury:card:")) {
    const [, , cardId, variantId, action] = customId.split(":");
    if (!cardId)
      throw new ApiError(422, "card_component_invalid", "That card control is incomplete.");
    if (action === "front" || action === "back")
      return cardFace(
        ctx,
        cardId,
        variantId ?? null,
        action,
        installation,
        undefined,
        interaction.channel_id,
      );
    if (action === "details")
      return cardDetails(ctx, cardId, installation, undefined, interaction.channel_id);
    throw new ApiError(404, "card_component_unknown", "That card control is not recognised.");
  }
  if (customId.startsWith("foilbury:npc-confirm:")) {
    return npcTradeConfirm(ctx, customId.slice("foilbury:npc-confirm:".length));
  }
  if (customId.startsWith("foilbury:npc-cancel:")) {
    return npcTradeCancel(ctx, customId.slice("foilbury:npc-cancel:".length));
  }
  if (customId.startsWith("foilbury:confirm:")) {
    return executeConfirmation(ctx, interaction, customId.slice("foilbury:confirm:".length));
  }
  if (customId.startsWith("foilbury:cancel:")) {
    const id = customId.slice("foilbury:cancel:".length);
    const discordUserId = interaction.member?.user?.id ?? interaction.user?.id ?? "";
    const row = await first<{ discord_user_id: string; used_at: string | null }>(
      ctx.db,
      "SELECT discord_user_id, used_at FROM fb_discord_confirmations WHERE id = ? AND tenant_id = ?",
      id,
      ctx.tenant.id,
    );
    if (!row || row.discord_user_id !== discordUserId)
      throw new ApiError(
        403,
        "confirmation_not_yours",
        "This confirmation belongs to another user.",
      );
    if (!row.used_at) {
      await ctx.db
        .prepare("UPDATE fb_discord_confirmations SET used_at = ? WHERE id = ?")
        .bind(nowIso(), id)
        .run();
    }
    return callback(
      {
        embeds: [
          { title: "Cancelled", description: "No change was made.", color: DISCORD_PALETTE.muted },
        ],
      },
      true,
    );
  }
  throw new ApiError(404, "discord_component_unknown", "That button is not recognised.");
}

export { errorCallback };
