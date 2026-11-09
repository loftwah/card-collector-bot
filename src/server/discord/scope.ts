import { ApiError, type Ctx } from "../context";
import { all, first } from "../db";
import { sha256Hex } from "../ids";
import { botForTenant, isAiArtOrigin } from "../modules/bots";
import { listCollections, type CollectionSummary } from "../modules/collections";
import {
  audienceRank,
  canViewAudience,
  mostRestrictive,
  viewerAccess,
  type Audience,
} from "../modules/visibility";
import { channelAudienceFor } from "./context";
import type { DiscordInstallation } from "./types";

export interface DiscordScopeCollection {
  id: string;
  slug: string;
  name: string;
  scope: string;
  view_audience: Audience;
  audience_label: string;
  release_version: number;
  card_count: number;
  enabled: boolean;
  banner_url: string | null;
  logo_url: string | null;
}

export interface DiscordScope {
  installationId: string;
  botId: string;
  tenantId: string;
  guildId: string;
  channelId: string | null;
  channelAudience: Audience;
  allowlist: string[] | null;
  /**
   * The server's published Bot-enabled set after the installation allowlist,
   * before the invoking account and channel audience are applied. This is the
   * configuration an administrator approved for the server.
   */
  configuredCollectionIds: string[];
  /**
   * The effective set for this actor and destination. Every Discord surface
   * must use this set, not the global catalogue.
   */
  collectionIds: string[];
  collections: DiscordScopeCollection[];
  aiArtEnabled: boolean;
  revision: number;
  digest: string;
  emptyReason: string | null;
}

function parseAllowlist(raw: string | null | undefined): {
  value: string[] | null;
  error: string | null;
} {
  if (raw === null || raw === undefined || raw.trim() === "") return { value: null, error: null };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return { value: null, error: "The installation collection allowlist is not an array." };
    }
    const ids = parsed.filter((item): item is string => typeof item === "string" && item.length > 0);
    if (ids.length !== parsed.length) {
      return { value: null, error: "The installation collection allowlist contains a non-string entry." };
    }
    return { value: [...new Set(ids)], error: null };
  } catch {
    return { value: null, error: "The installation collection allowlist is not valid JSON." };
  }
}

function isPublished(collection: CollectionSummary): boolean {
  return collection.status === "published";
}

export async function resolveDiscordScope(
  ctx: Ctx,
  installation: DiscordInstallation,
  channelId: string | null | undefined,
): Promise<DiscordScope> {
  const channel = channelId ?? null;
  const channelAudience = channelAudienceFor(installation, channel);
  const allowlist = parseAllowlist(installation.collection_allowlist_json);
  const bot = installation.bot_id
    ? await first<{ id: string; ai_art_enabled: number }>(
        ctx.db,
        "SELECT id, ai_art_enabled FROM fb_bots WHERE id = ? AND tenant_id = ? AND status <> 'archived'",
        installation.bot_id,
        installation.tenant_id,
      )
    : null;
  const resolvedBot = bot ?? (await botForTenant(ctx.db, ctx.tenant.id));
  const revision = Number(installation.configuration_revision ?? 1);

  const base: Omit<
    DiscordScope,
    "collectionIds" | "collections" | "emptyReason" | "digest" | "configuredCollectionIds"
  > = {
    installationId: installation.id,
    botId: resolvedBot?.id ?? "",
    tenantId: installation.tenant_id,
    guildId: installation.guild_id,
    channelId: channel,
    channelAudience,
    allowlist: allowlist.value,
    aiArtEnabled: Number(resolvedBot?.ai_art_enabled ?? 0) === 1,
    revision,
  };

  const empty = async (
    reason: string,
    configuredCollectionIds: string[] = [],
  ): Promise<DiscordScope> => {
    const digest = await sha256Hex(
      JSON.stringify({ ...base, configuredCollectionIds, collectionIds: [], reason }),
    );
    return {
      ...base,
      configuredCollectionIds,
      collectionIds: [],
      collections: [],
      digest,
      emptyReason: reason,
    };
  };

  if (!resolvedBot) {
    return empty("No Bot is attached to this installation, so no collection can be offered.");
  }
  if (allowlist.error) {
    return empty(`${allowlist.error} Ask the Bot Owner to repair the server configuration.`);
  }

  // listCollections already applies the account's viewer predicate and carries
  // the Bot-wide enabled flag. The server scope must use the published set, not
  // an administrator's draft catalogue or the global public showcase.
  const allCollections = await listCollections(ctx);
  const botEnabled = allCollections.filter(
    (collection) => collection.enabled && isPublished(collection),
  );
  const configured =
    allowlist.value === null
      ? botEnabled
      : botEnabled.filter((collection) => allowlist.value!.includes(collection.id));
  const configuredCollectionIds = configured.map((collection) => collection.id).sort();

  if (botEnabled.length === 0) {
    return empty(
      "This Bot has no enabled published collections. Enable a collection in Studio or Bot Admin, then try again. Nothing was charged.",
      configuredCollectionIds,
    );
  }
  if (allowlist.value !== null && allowlist.value.length === 0) {
    return empty(
      "This server has an explicit empty collection allowlist. Add a collection in the server configuration, then try again. Nothing was charged.",
      configuredCollectionIds,
    );
  }
  if (configured.length === 0) {
    return empty(
      "None of this server's configured collections is enabled and published. Ask the Bot Owner to reconcile the installation allowlist and Bot availability. Nothing was charged.",
      configuredCollectionIds,
    );
  }

  const access = await viewerAccess(ctx);
  const eligible = configured.filter((collection) => canViewAudience(access, collection));
  if (eligible.length === 0) {
    return empty(
      "Your account is not an active member of any collection enabled for this server. Ask the Bot Owner to restore membership. Nothing was charged.",
      configuredCollectionIds,
    );
  }

  const visible = eligible.filter(
    (collection) => audienceRank(collection.view_audience) <= audienceRank(channelAudience),
  );
  if (visible.length === 0) {
    const audiences = [...new Set(eligible.map((collection) => collection.view_audience))].join(", ");
    return empty(
      `This channel is verified for ${channelAudience} content, but the collections enabled for this server are ${audiences}. Enable approved public content or verify a genuinely restricted channel; restricted artwork will not be posted here. Nothing was charged.`,
      configuredCollectionIds,
    );
  }

  // A card must not leak a disabled collection through a multi-collection
  // membership. The effective list is the exact set of ids every Discord card,
  // pool entry and share must belong to.
  const collections: DiscordScopeCollection[] = visible
    .map((collection) => ({
      id: collection.id,
      slug: collection.slug,
      name: collection.name,
      scope: collection.scope,
      view_audience: collection.view_audience,
      audience_label: collection.audience_label,
      release_version: Number(collection.release_version ?? 1),
      card_count: Number(collection.card_count ?? 0),
      enabled: Boolean(collection.enabled),
      banner_url: collection.banner_url ?? null,
      logo_url: collection.logo_url ?? null,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  const collectionIds = collections.map((collection) => collection.id).sort();
  const digest = await sha256Hex(
    JSON.stringify({
      installation_id: base.installationId,
      tenant_id: base.tenantId,
      bot_id: base.botId,
      guild_id: base.guildId,
      channel_id: base.channelId,
      channel_audience: base.channelAudience,
      allowlist: base.allowlist,
      configuration_revision: base.revision,
      ai_art_enabled: base.aiArtEnabled,
      collections: collections.map((collection) => ({
        id: collection.id,
        release_version: collection.release_version,
        view_audience: collection.view_audience,
      })),
    }),
  );

  return {
    ...base,
    configuredCollectionIds,
    collectionIds,
    collections,
    digest,
    emptyReason: null,
  };
}

export function scopeIncludesCollection(scope: DiscordScope, collectionId: string): boolean {
  return scope.collectionIds.includes(collectionId);
}

/**
 * A Discord card must be filed in at least one live collection and in no
 * collection outside the resolved server scope. An unfiled legacy card is not
 * a fallback for a missing configuration.
 */
export async function assertCardInDiscordScope(
  ctx: Ctx,
  scope: DiscordScope,
  cardId: string,
): Promise<{ collectionIds: string[]; audience: Audience }> {
  const rows = await all<{ collection_id: string; view_audience: Audience }>(
    ctx.db,
    `SELECT c.id AS collection_id, c.view_audience
       FROM fb_collection_cards cc
       JOIN fb_collections c ON c.id = cc.collection_id
      WHERE cc.card_id = ? AND c.archived_at IS NULL AND c.status = 'published'`,
    cardId,
  );
  if (rows.length === 0) {
    throw new ApiError(
      404,
      "card_not_configured",
      "That card is not filed in an enabled collection for this server. Nothing was charged.",
    );
  }
  const outside = rows.filter((row) => !scopeIncludesCollection(scope, row.collection_id));
  if (outside.length > 0) {
    throw new ApiError(
      403,
      "card_outside_scope",
      "That card belongs to a collection this server has not enabled. It stays private. Nothing was charged.",
    );
  }
  const audience = rows
    .map((row) => row.view_audience)
    .reduce<Audience>((current, next) => mostRestrictive(current, next), "public");
  if (audienceRank(audience) > audienceRank(scope.channelAudience)) {
    throw new ApiError(
      403,
      "card_channel_audience",
      "This channel has not been verified for that card's audience. Restricted artwork stays private.",
    );
  }
  return { collectionIds: rows.map((row) => row.collection_id), audience };
}

export interface RankedAlbum {
  collection: DiscordScopeCollection;
  ownedUnique: number;
}

/**
 * Pick a complete, enabled album without a hard-coded slug. The account's
 * existing progress is the first preference, then a compact eight-subject
 * roster, then the larger catalogue. The caller still verifies renders,
 * achievements and pool eligibility before presenting it.
 */
export async function rankDiscordAlbums(
  ctx: Ctx,
  scope: DiscordScope,
): Promise<RankedAlbum[]> {
  if (!ctx.user) return [];
  const rows = await all<{ collection_id: string; owned: number }>(
    ctx.db,
    `SELECT cc.collection_id, COUNT(DISTINCT ci.card_id) AS owned
       FROM fb_card_instances ci
       JOIN fb_collection_cards cc ON cc.card_id = ci.card_id
      WHERE ci.tenant_id = ? AND ci.user_id = ? AND ci.status IN ('owned','reserved')
      GROUP BY cc.collection_id`,
    ctx.tenant.id,
    ctx.user.id,
  );
  const owned = new Map(rows.map((row) => [row.collection_id, Number(row.owned)]));
  return scope.collections
    .map((collection) => ({ collection, ownedUnique: owned.get(collection.id) ?? 0 }))
    .sort((left, right) => {
      const progress = right.ownedUnique - left.ownedUnique;
      if (progress !== 0) return progress;
      const eightLeft = left.collection.card_count === 8 ? 1 : 0;
      const eightRight = right.collection.card_count === 8 ? 1 : 0;
      if (eightLeft !== eightRight) return eightRight - eightLeft;
      const size = right.collection.card_count - left.collection.card_count;
      if (size !== 0) return size;
      return left.collection.name.localeCompare(right.collection.name);
    });
}

/**
 * The scope is passed into the shared pool service so preview, commit, list and
 * API draw paths all use one predicate. Pool entries with no collection are
 * excluded: missing configuration is not permission to drop legacy cards.
 */
export function poolScopeFromDiscord(scope: DiscordScope): {
  collectionIds: string[];
  audience: Audience;
  digest: string;
  requireFiled: true;
  aiArtEnabled: boolean;
} {
  return {
    collectionIds: scope.collectionIds,
    audience: scope.channelAudience,
    digest: scope.digest,
    requireFiled: true,
    aiArtEnabled: scope.aiArtEnabled,
  };
}

export function isAiEditionOrigin(origin: string | null | undefined): boolean {
  return isAiArtOrigin(origin);
}

/**
 * The exact card ids a Discord surface may display. A card with any live
 * collection outside the scope is excluded, and at least one filed card
 * collection is required. This is used for inventory/cabinet summaries so a
 * historical copy from a now-disabled collection is not presented as current
 * server content.
 */
export async function discordScopeCardIds(
  ctx: Ctx,
  scope: DiscordScope,
): Promise<Set<string>> {
  if (scope.collectionIds.length === 0) return new Set();
  const placeholders = scope.collectionIds.map(() => "?").join(",");
  const rows = await all<{ card_id: string }>(
    ctx.db,
    `SELECT DISTINCT cc.card_id
       FROM fb_collection_cards cc
       JOIN fb_collections c ON c.id = cc.collection_id
      WHERE cc.collection_id IN (${placeholders})
        AND c.status = 'published' AND c.archived_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM fb_collection_cards other
          JOIN fb_collections oc ON oc.id = other.collection_id
           WHERE other.card_id = cc.card_id
             AND oc.status = 'published' AND oc.archived_at IS NULL
             AND oc.id NOT IN (${placeholders})
        )`,
    ...scope.collectionIds,
    ...scope.collectionIds,
  );
  return new Set(rows.map((row) => row.card_id));
}
