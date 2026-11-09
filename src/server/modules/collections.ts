import type { D1Database } from "@cloudflare/workers-types";
import {
  ApiError,
  canManageGlobalCollection,
  hasCapability,
  requireGlobalCollectionManager,
  requireSuperAdminContent,
  requireUser,
  type Ctx,
} from "../context";
import { all, first, nowIso } from "../db";
import { newId } from "../ids";
import { botForTenant, botAllowsAiArt } from "./bots";
import {
  audienceLabel,
  canViewAudience,
  collectionVisibilitySql,
  publicCollectionSql,
  viewerAccess,
} from "./visibility";
import { assertTransition } from "../state";

export interface CollectionRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  scope: "global" | "bot";
  owner_tenant_id: string | null;
  logo_asset_id: string | null;
  banner_asset_id: string | null;
  logo_url: string | null;
  banner_url: string | null;
  back_url: string | null;
  accent: string;
  status: "draft" | "published" | "archived";
  view_audience: "public" | "members" | "private";
  public_approved_at: string | null;
  public_approved_by: string | null;
  source_work: string | null;
  source_context: string | null;
  content_advisory: string | null;
  release_version: number;
  released_at: string | null;
  provenance_json: string;
  featured: number;
  sort: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface CollectionSummary extends CollectionRow {
  card_count: number;
  enabled: boolean;
  manageable: boolean;
  owner_name: string;
  audience_label: string;
  /** A card render used as a fallback cover. Collection identity uses banner_url or logo_url. */
  cover_url: string | null;
}

function normalizeSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

async function platformCatalogueTenantId(ctx: Ctx): Promise<string> {
  if (ctx.tenant.slug === ctx.config.tenantSlug) return ctx.tenant.id;
  const main = await first<{ id: string }>(
    ctx.db,
    "SELECT id FROM fb_tenants WHERE slug = ?",
    ctx.config.tenantSlug,
  );
  return main?.id ?? ctx.tenant.id;
}

function globalScopeClause(user: Ctx["user"]): { sql: string; params: unknown[] } {
  const scope = user?.globalCollectionScope;
  if (!scope) return { sql: "", params: [] };
  if (scope.all) return { sql: "(c.scope = 'global')", params: [] };
  const ids = scope.collectionIds;
  if (!ids.length) return { sql: "(c.scope = 'global' AND 0 = 1)", params: [] };
  return { sql: `(c.scope = 'global' AND c.id IN (${ids.map(() => "?").join(",")}))`, params: ids };
}

export async function listCollections(
  ctx: Ctx,
  options?: { includeArchived?: boolean; includeAll?: boolean },
): Promise<CollectionSummary[]> {
  const bot = await botForTenant(ctx.db, ctx.tenant.id);
  const access = await viewerAccess(ctx);
  const visibility = collectionVisibilitySql(access);
  const platformScope = globalScopeClause(ctx.user);
  const scopeClause = options?.includeAll
    ? ctx.user?.globalCollectionScope && !ctx.user.platformAdmin
      ? `((${platformScope.sql}) OR (c.scope = 'bot' AND c.owner_tenant_id = ?))`
      : "(c.scope = 'global' OR c.owner_tenant_id = ?)"
    : visibility.sql;
  const params: unknown[] = [bot?.id ?? "", options?.includeArchived ? 1 : 0];
  if (options?.includeAll) {
    if (ctx.user?.globalCollectionScope && !ctx.user.platformAdmin)
      params.push(...platformScope.params);
    params.push(ctx.tenant.id);
  } else params.push(...visibility.params);
  const rows = await all<CollectionSummary & { owner_name: string | null }>(
    ctx.db,
    `SELECT c.*,
            (SELECT COUNT(*) FROM fb_collection_cards cc WHERE cc.collection_id = c.id) AS card_count,
            COALESCE(bc.enabled, 0) AS enabled,
            COALESCE(t.name, 'Foilbury global') AS owner_name,
            (SELECT vr.public_url
               FROM fb_collection_cards cc2
               JOIN fb_variants v2 ON v2.card_id = cc2.card_id AND v2.status = 'published' AND v2.archived_at IS NULL
               JOIN fb_variant_renders vr ON vr.variant_id = v2.id AND vr.status = 'published'
              WHERE cc2.collection_id = c.id
              ORDER BY cc2.sort, v2.name
              LIMIT 1) AS cover_url
       FROM fb_collections c
       LEFT JOIN fb_tenants t ON t.id = c.owner_tenant_id
       LEFT JOIN fb_bot_collections bc ON bc.collection_id = c.id AND bc.bot_id = ?
      WHERE c.archived_at IS NULL
        AND (? = 1 OR c.status <> 'archived')
        AND ${scopeClause}
      ORDER BY CASE c.scope WHEN 'global' THEN 0 ELSE 1 END, c.sort, c.name`,
    ...params,
  );
  return rows.map((row) => ({
    ...row,
    enabled: Boolean(row.enabled),
    manageable:
      row.scope === "global"
        ? canManageGlobalCollection(ctx, row.id)
        : Boolean(ctx.user && (ctx.user.role === "owner" || hasCapability(ctx.user, "content"))),
    owner_name: row.owner_name ?? "Foilbury global",
    audience_label: audienceLabel(row.view_audience),
  }));
}

export async function listPublicCollections(ctx: Ctx): Promise<CollectionSummary[]> {
  const rows = await all<CollectionSummary & { owner_name: string | null }>(
    ctx.db,
    `SELECT c.*,
            (SELECT COUNT(*) FROM fb_collection_cards cc WHERE cc.collection_id = c.id) AS card_count,
            0 AS enabled,
            COALESCE(t.name, 'Foilbury global') AS owner_name,
            (SELECT vr.public_url
               FROM fb_collection_cards cc2
               JOIN fb_variants v2 ON v2.card_id = cc2.card_id AND v2.status = 'published' AND v2.archived_at IS NULL
               JOIN fb_variant_renders vr ON vr.variant_id = v2.id AND vr.status = 'published'
              WHERE cc2.collection_id = c.id
              ORDER BY cc2.sort, v2.name
              LIMIT 1) AS cover_url
       FROM fb_collections c
       LEFT JOIN fb_tenants t ON t.id = c.owner_tenant_id
      WHERE ${publicCollectionSql("c")}
      ORDER BY c.featured DESC, c.sort, c.name`,
  );
  return rows.map((row) => ({
    ...row,
    enabled: false,
    manageable: false,
    owner_name: row.owner_name ?? "Foilbury global",
    audience_label: audienceLabel(row.view_audience),
  }));
}

export async function getCollection(
  ctx: Ctx,
  id: string,
  options?: { includeAll?: boolean },
): Promise<CollectionSummary> {
  const bot = await botForTenant(ctx.db, ctx.tenant.id);
  const access = await viewerAccess(ctx);
  const visibility = collectionVisibilitySql(access);
  const platformScope = globalScopeClause(ctx.user);
  const identityClause = options?.includeAll
    ? ctx.user?.globalCollectionScope && !ctx.user.platformAdmin
      ? `((${platformScope.sql}) OR (c.scope = 'bot' AND c.owner_tenant_id = ?))`
      : "(c.scope = 'global' OR c.owner_tenant_id = ?)"
    : visibility.sql;
  const params: unknown[] = [bot?.id ?? "", id];
  if (options?.includeAll) {
    if (ctx.user?.globalCollectionScope && !ctx.user.platformAdmin)
      params.push(...platformScope.params);
    params.push(ctx.tenant.id);
  } else params.push(...visibility.params);
  const row = await first<CollectionSummary & { owner_name: string | null }>(
    ctx.db,
    `SELECT c.*,
            (SELECT COUNT(*) FROM fb_collection_cards cc WHERE cc.collection_id = c.id) AS card_count,
            COALESCE(bc.enabled, 0) AS enabled,
            COALESCE(t.name, 'Foilbury global') AS owner_name,
            (SELECT vr.public_url
               FROM fb_collection_cards cc2
               JOIN fb_variants v2 ON v2.card_id = cc2.card_id AND v2.status = 'published' AND v2.archived_at IS NULL
               JOIN fb_variant_renders vr ON vr.variant_id = v2.id AND vr.status = 'published'
              WHERE cc2.collection_id = c.id
              ORDER BY cc2.sort, v2.name
              LIMIT 1) AS cover_url
       FROM fb_collections c
       LEFT JOIN fb_tenants t ON t.id = c.owner_tenant_id
       LEFT JOIN fb_bot_collections bc ON bc.collection_id = c.id AND bc.bot_id = ?
      WHERE c.id = ? AND ${identityClause}`,
    ...params,
  );
  if (!row)
    throw new ApiError(
      404,
      "collection_not_found",
      "That collection is not available to this account.",
    );
  return {
    ...row,
    enabled: Boolean(row.enabled),
    manageable:
      row.scope === "global"
        ? canManageGlobalCollection(ctx, row.id)
        : Boolean(ctx.user && (ctx.user.role === "owner" || hasCapability(ctx.user, "content"))),
    owner_name: row.owner_name ?? "Foilbury global",
    audience_label: audienceLabel(row.view_audience),
  };
}

export async function listCollectionCards(
  ctx: Ctx,
  id: string,
  options?: { includeDrafts?: boolean; includeAi?: boolean },
) {
  const collection = await getCollection(ctx, id, { includeAll: options?.includeDrafts });
  const statusClause = options?.includeDrafts ? "" : "AND cd.status = 'published'";
  const includeAi = options?.includeAi ?? (await botAllowsAiArt(ctx.db, ctx.tenant.id));
  return all<{
    id: string;
    slug: string;
    name: string;
    subtitle: string | null;
    description: string;
    bio: string | null;
    bio_safe: string | null;
    quote: string | null;
    status: string;
    visibility: string;
    spoiler_level: number;
    attributes_json: string;
    render_url: string | null;
    card_back_url: string | null;
    category_name: string | null;
    tags_json: string | null;
  }>(
    ctx.db,
    `SELECT cd.id, cd.slug, cd.name, cd.subtitle, cd.description, cd.bio, cd.bio_safe, cd.quote,
            cd.status, cd.visibility, cd.spoiler_level, cd.attributes_json,
            (SELECT ('/media/render/' || vr.asset_id) FROM fb_variants v
              JOIN fb_variant_renders vr ON vr.variant_id = v.id AND vr.status = 'published'
              JOIN fb_artwork_editions e ON e.id = v.edition_id
              JOIN fb_assets sa ON sa.id = e.subject_asset_id AND sa.tenant_id = e.tenant_id
             WHERE v.card_id = cd.id AND (? = 1 OR sa.origin NOT IN ('ai_assisted','ai_generated'))
             ORDER BY vr.created_at DESC LIMIT 1) AS render_url,
            COALESCE((SELECT a.r2_key FROM fb_assets a WHERE a.id = cd.card_back_asset_id), '/brand/card-back.webp') AS card_back_url,
            cat.name AS category_name,
            (SELECT json_group_array(t.slug) FROM fb_card_tags ct JOIN fb_tags t ON t.id = ct.tag_id WHERE ct.card_id = cd.id) AS tags_json
       FROM fb_collection_cards cc
       JOIN fb_card_definitions cd ON cd.id = cc.card_id
       LEFT JOIN fb_categories cat ON cat.id = cd.category_id
      WHERE cc.collection_id = ? AND cd.archived_at IS NULL ${statusClause}
        AND EXISTS (
          SELECT 1 FROM fb_artwork_editions ae
          JOIN fb_assets asa ON asa.id = ae.subject_asset_id AND asa.tenant_id = ae.tenant_id
          WHERE ae.card_id = cd.id AND ae.status = 'published' AND ae.archived_at IS NULL
            AND (? = 1 OR asa.origin NOT IN ('ai_assisted','ai_generated'))
        )
      ORDER BY cc.sort, cd.name`,
    includeAi ? 1 : 0,
    collection.id,
    includeAi ? 1 : 0,
  );
}

export async function createCollection(
  ctx: Ctx,
  input: {
    name: string;
    slug?: string;
    description?: string;
    scope: "global" | "bot";
    logoUrl?: string;
    bannerUrl?: string;
    backUrl?: string;
    accent?: string;
    status?: "draft" | "published";
    viewAudience?: "public" | "members" | "private";
    sourceWork?: string;
    sourceContext?: string;
    contentAdvisory?: string;
    featured?: boolean;
  },
): Promise<CollectionRow> {
  const user = requireUser(ctx);
  if (input.scope === "global") {
    requireGlobalCollectionManager(ctx);
  } else {
    const bot = await botForTenant(ctx.db, ctx.tenant.id);
    if (!bot)
      throw new ApiError(
        403,
        "bot_required",
        "Create or select a Bot before making a Bot collection.",
      );
    if (user.role !== "owner" && !hasCapability(user, "content")) {
      throw new ApiError(
        403,
        "content_capability_required",
        "Your Bot role cannot create collections.",
      );
    }
  }
  const name = input.name.trim().slice(0, 120);
  if (name.length < 2)
    throw new ApiError(422, "collection_name_invalid", "Give the collection a name.");
  const slug = normalizeSlug(input.slug || name);
  if (slug.length < 2)
    throw new ApiError(422, "collection_slug_invalid", "Choose a URL-friendly collection slug.");
  const id = newId("col");
  const now = nowIso();
  // New collections are never public by default. Approval is an explicit
  // Super Admin action, even when a creator asks for a public collection.
  let audience = input.viewAudience ?? "members";
  if (audience === "public") {
    requireSuperAdminContent(ctx);
    if ((input.status ?? "draft") !== "published") {
      throw new ApiError(
        422,
        "public_requires_publish",
        "Publish the collection before approving it for the public showcase.",
      );
    }
  }
  if (input.scope === "bot" && audience === "public") {
    throw new ApiError(
      422,
      "bot_collection_not_public",
      "Bot collections are members-only; public showcase content is curated by the Super Admin.",
    );
  }
  const ownerTenantId =
    input.scope === "global" ? await platformCatalogueTenantId(ctx) : ctx.tenant.id;
  await ctx.db
    .prepare(
      `INSERT INTO fb_collections
        (id, slug, name, description, scope, owner_tenant_id, logo_url, banner_url, back_url,
         logo_asset_id, banner_asset_id, accent, status,
         view_audience, public_approved_at, public_approved_by, source_work, source_context, content_advisory,
         featured, sort, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    )
    .bind(
      id,
      slug,
      name,
      input.description?.slice(0, 2000) ?? "",
      input.scope,
      ownerTenantId,
      safeUrl(input.logoUrl),
      safeUrl(input.bannerUrl),
      safeUrl(input.backUrl),
      assetIdFromUrl(input.logoUrl),
      assetIdFromUrl(input.bannerUrl),
      input.accent?.slice(0, 30) ?? "brass",
      input.status ?? (input.scope === "global" ? "published" : "draft"),
      audience,
      audience === "public" ? now : null,
      audience === "public" ? user.id : null,
      input.sourceWork?.slice(0, 500) ?? null,
      input.sourceContext?.slice(0, 4000) ?? null,
      input.contentAdvisory?.slice(0, 1000) ?? null,
      input.featured ? 1 : 0,
      user.id,
      now,
      now,
    )
    .run();
  if (input.scope === "bot") {
    const bot = await botForTenant(ctx.db, ctx.tenant.id);
    if (bot) {
      await ctx.db
        .prepare(
          "INSERT INTO fb_bot_collections (bot_id, collection_id, enabled, updated_by, updated_at) VALUES (?, ?, 1, ?, ?)",
        )
        .bind(bot.id, id, user.id, now)
        .run();
    }
  }
  await auditCollection(ctx, "collection.created", id, { name, slug, scope: input.scope });
  return (await getCollection(ctx, id)) as CollectionRow;
}

export async function updateCollection(
  ctx: Ctx,
  id: string,
  input: {
    name?: string;
    description?: string;
    logoUrl?: string | null;
    bannerUrl?: string | null;
    backUrl?: string | null;
    accent?: string;
    status?: "draft" | "published" | "archived";
    sort?: number;
    viewAudience?: "public" | "members" | "private";
    sourceWork?: string | null;
    sourceContext?: string | null;
    contentAdvisory?: string | null;
    featured?: boolean;
    expectedVersion?: number;
  },
): Promise<CollectionRow> {
  const collection = await getCollection(ctx, id, { includeAll: true });
  assertManage(ctx, collection);
  if (input.expectedVersion !== undefined && input.expectedVersion !== collection.release_version) {
    throw new ApiError(
      409,
      "stale_write",
      "This collection changed since you opened it. Reload before saving.",
      {
        current_version: collection.release_version,
      },
    );
  }
  const updates: string[] = [];
  const values: unknown[] = [];
  if (input.name !== undefined) {
    const name = input.name.trim().slice(0, 120);
    if (name.length < 2)
      throw new ApiError(422, "collection_name_invalid", "Give the collection a name.");
    updates.push("name = ?");
    values.push(name);
  }
  if (input.description !== undefined) {
    updates.push("description = ?");
    values.push(input.description.slice(0, 2000));
  }
  if (input.logoUrl !== undefined) {
    updates.push("logo_url = ?", "logo_asset_id = ?");
    values.push(safeUrl(input.logoUrl), assetIdFromUrl(input.logoUrl));
  }
  if (input.bannerUrl !== undefined) {
    updates.push("banner_url = ?", "banner_asset_id = ?");
    values.push(safeUrl(input.bannerUrl), assetIdFromUrl(input.bannerUrl));
  }
  if (input.backUrl !== undefined) {
    updates.push("back_url = ?");
    values.push(safeUrl(input.backUrl));
  }
  if (input.accent !== undefined) {
    updates.push("accent = ?");
    values.push(input.accent.slice(0, 30));
  }
  if (input.sourceWork !== undefined) {
    updates.push("source_work = ?");
    values.push(input.sourceWork?.slice(0, 500) ?? null);
  }
  if (input.sourceContext !== undefined) {
    updates.push("source_context = ?");
    values.push(input.sourceContext?.slice(0, 4000) ?? null);
  }
  if (input.contentAdvisory !== undefined) {
    updates.push("content_advisory = ?");
    values.push(input.contentAdvisory?.slice(0, 1000) ?? null);
  }
  if (input.featured !== undefined) {
    if (input.featured) requireSuperAdminContent(ctx);
    updates.push("featured = ?");
    values.push(input.featured ? 1 : 0);
  }
  if (input.viewAudience !== undefined) {
    if (input.viewAudience === "public") {
      requireSuperAdminContent(ctx);
      if ((input.status ?? collection.status) !== "published") {
        throw new ApiError(
          422,
          "public_requires_publish",
          "Publish the collection before approving it for the public showcase.",
        );
      }
      if (collection.scope === "bot") {
        throw new ApiError(
          422,
          "bot_collection_not_public",
          "Bot collections cannot be promoted to the public showcase.",
        );
      }
      updates.push(
        "public_approved_at = COALESCE(public_approved_at, ?)",
        "public_approved_by = COALESCE(public_approved_by, ?)",
      );
      values.push(nowIso(), ctx.user?.id ?? "system");
    } else if (collection.view_audience === "public") {
      // Removing public approval is a deliberate visibility change. The caller
      // must purge the public cache; media reads switch to member-only at once.
      updates.push("public_approved_at = NULL", "public_approved_by = NULL");
    }
    updates.push("view_audience = ?");
    values.push(input.viewAudience);
  }
  if (input.status !== undefined) {
    if (collection.scope === "global") requireGlobalCollectionManager(ctx, collection.id);
    if (input.status !== collection.status)
      assertTransition("collection", collection.status, input.status);
    if (input.status !== "published" && collection.view_audience === "public") {
      updates.push(
        "view_audience = 'members'",
        "public_approved_at = NULL",
        "public_approved_by = NULL",
      );
    }
    updates.push("status = ?");
    values.push(input.status);
    if (input.status === "archived") {
      updates.push("archived_at = ?");
      values.push(nowIso());
    }
    if (input.status === "published" && !collection.released_at) {
      updates.push("released_at = ?");
      values.push(nowIso());
    }
  }
  if (input.sort !== undefined) {
    updates.push("sort = ?");
    values.push(Math.trunc(input.sort));
  }
  if (!updates.length) return collection;
  updates.push("updated_at = ?", "release_version = release_version + 1");
  values.push(nowIso(), id);
  await ctx.db
    .prepare(`UPDATE fb_collections SET ${updates.join(", ")} WHERE id = ?`)
    .bind(...values)
    .run();
  await auditCollection(ctx, "collection.updated", id, {
    fields: Object.keys(input),
    view_audience: input.viewAudience ?? collection.view_audience,
  });
  return (await getCollection(ctx, id, { includeAll: true })) as CollectionRow;
}

export async function addCollectionCards(
  ctx: Ctx,
  id: string,
  cardIds: string[],
): Promise<{ added: number }> {
  const collection = await getCollection(ctx, id);
  assertManage(ctx, collection);
  const unique = [...new Set(cardIds)].slice(0, 300);
  if (!unique.length) throw new ApiError(422, "cards_required", "Choose at least one card.");
  const placeholders = unique.map(() => "?").join(",");
  const cards = await all<{ id: string; tenant_id: string }>(
    ctx.db,
    `SELECT id, tenant_id FROM fb_card_definitions WHERE id IN (${placeholders}) AND archived_at IS NULL`,
    ...unique,
  );
  const allowed = cards.filter((card) =>
    collection.scope === "global"
      ? card.tenant_id === collection.owner_tenant_id
      : card.tenant_id === ctx.tenant.id,
  );
  if (allowed.length !== unique.length) {
    throw new ApiError(
      403,
      "card_scope_invalid",
      "One or more cards are outside this collection's catalogue scope.",
    );
  }
  const now = nowIso();
  for (const card of allowed) {
    await ctx.db
      .prepare(
        `INSERT INTO fb_collection_cards (collection_id, card_id, tenant_id, sort, added_by, added_at)
         VALUES (?, ?, ?, 0, ?, ?)
         ON CONFLICT(collection_id, card_id) DO NOTHING`,
      )
      .bind(collection.id, card.id, card.tenant_id, ctx.user?.id ?? "system", now)
      .run();
  }
  await auditCollection(ctx, "collection.cards.added", id, { count: allowed.length });
  return { added: allowed.length };
}

export async function removeCollectionCard(ctx: Ctx, id: string, cardId: string): Promise<void> {
  const collection = await getCollection(ctx, id);
  assertManage(ctx, collection);
  await ctx.db
    .prepare("DELETE FROM fb_collection_cards WHERE collection_id = ? AND card_id = ?")
    .bind(collection.id, cardId)
    .run();
  await auditCollection(ctx, "collection.card.removed", id, { card_id: cardId });
}

export async function enableCollection(
  ctx: Ctx,
  collectionId: string,
  enabled: boolean,
): Promise<void> {
  const user = requireUser(ctx);
  const bot = await botForTenant(ctx.db, ctx.tenant.id);
  if (!bot)
    throw new ApiError(403, "bot_required", "No Bot is attached to this administration area.");
  if (user.role !== "owner" && !hasCapability(user, "content")) {
    throw new ApiError(
      403,
      "content_capability_required",
      "Your Bot role cannot change collection availability.",
    );
  }
  const collection = await getCollection(ctx, collectionId);
  await ctx.db
    .prepare(
      `INSERT INTO fb_bot_collections (bot_id, collection_id, enabled, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(bot_id, collection_id) DO UPDATE SET enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    )
    .bind(bot.id, collection.id, enabled ? 1 : 0, user.id, nowIso())
    .run();
  await auditCollection(
    ctx,
    enabled ? "collection.enabled" : "collection.disabled",
    collection.id,
    { bot_id: bot.id },
  );
}

/**
 * A card in any collection must have at least one enabled collection for the
 * Bot before it can drop. Cards outside collections keep the legacy behaviour.
 */
export async function assertCardEnabledForTenant(
  db: D1Database,
  tenantId: string,
  cardId: string,
): Promise<void> {
  const state = await first<{ collections: number; enabled: number }>(
    db,
    `SELECT
       (SELECT COUNT(*) FROM fb_collection_cards cc WHERE cc.card_id = ?) AS collections,
       (SELECT COUNT(*) FROM fb_collection_cards cc
          JOIN fb_bot_collections bc ON bc.collection_id = cc.collection_id AND bc.enabled = 1
          JOIN fb_bots b ON b.id = bc.bot_id AND b.tenant_id = ?
         WHERE cc.card_id = ?) AS enabled`,
    cardId,
    tenantId,
    cardId,
  );
  if (state && state.collections > 0 && state.enabled === 0) {
    throw new ApiError(
      409,
      "collection_disabled",
      "That card's collection is turned off for this Bot. Nothing was charged.",
    );
  }
}

function assertManage(ctx: Ctx, collection: CollectionRow): void {
  if (collection.scope === "global") {
    requireGlobalCollectionManager(ctx, collection.id);
    return;
  }
  const user = requireUser(ctx);
  if (collection.owner_tenant_id !== ctx.tenant.id)
    throw new ApiError(403, "collection_scope_invalid", "That collection belongs to another Bot.");
  if (user.role !== "owner" && !hasCapability(user, "content")) {
    throw new ApiError(
      403,
      "content_capability_required",
      "Your Bot role cannot manage collections.",
    );
  }
}

export async function setCollectionViewers(
  ctx: Ctx,
  collectionId: string,
  userIds: string[],
): Promise<{ count: number }> {
  const collection = await getCollection(ctx, collectionId, { includeAll: true });
  assertManage(ctx, collection);
  if (collection.view_audience !== "private") {
    throw new ApiError(
      422,
      "collection_not_private",
      "Explicit viewers apply to private collections only.",
    );
  }
  const unique = [...new Set(userIds)].slice(0, 500);
  if (unique.length) {
    const found = await all<{ id: string }>(
      ctx.db,
      `SELECT id FROM fb_users WHERE id IN (${unique.map(() => "?").join(",")}) AND disabled_at IS NULL`,
      ...unique,
    );
    if (found.length !== unique.length)
      throw new ApiError(422, "viewer_unknown", "One or more viewers do not exist.");
  }
  const now = nowIso();
  await ctx.db
    .prepare(
      "UPDATE fb_collection_viewers SET revoked_at = ? WHERE collection_id = ? AND revoked_at IS NULL",
    )
    .bind(now, collection.id)
    .run();
  for (const userId of unique) {
    await ctx.db
      .prepare(
        `INSERT INTO fb_collection_viewers (collection_id, user_id, granted_by, created_at, revoked_at)
         VALUES (?, ?, ?, ?, NULL)
         ON CONFLICT(collection_id, user_id) DO UPDATE SET revoked_at = NULL, granted_by = excluded.granted_by, created_at = excluded.created_at`,
      )
      .bind(collection.id, userId, ctx.user?.id ?? "system", now)
      .run();
  }
  await auditCollection(ctx, "collection.viewers.updated", collection.id, { count: unique.length });
  return { count: unique.length };
}

export async function listCollectionViewers(ctx: Ctx, collectionId: string) {
  const collection = await getCollection(ctx, collectionId, { includeAll: true });
  assertManage(ctx, collection);
  return all<{ user_id: string; email: string; display_name: string; granted_at: string }>(
    ctx.db,
    `SELECT v.user_id, u.email, u.display_name, v.created_at AS granted_at
       FROM fb_collection_viewers v JOIN fb_users u ON u.id = v.user_id
      WHERE v.collection_id = ? AND v.revoked_at IS NULL ORDER BY u.display_name`,
    collection.id,
  );
}

export async function collectionProgress(ctx: Ctx, collectionId: string) {
  const user = ctx.user;
  const collection = await getCollection(ctx, collectionId);
  const totals = await first<{ cards: number; variants: number }>(
    ctx.db,
    `SELECT COUNT(DISTINCT cd.id) AS cards,
            COUNT(DISTINCT v.id) AS variants
       FROM fb_collection_cards cc
       JOIN fb_card_definitions cd ON cd.id = cc.card_id AND cd.status = 'published' AND cd.archived_at IS NULL
       LEFT JOIN fb_variants v ON v.card_id = cd.id AND v.status = 'published' AND v.archived_at IS NULL
      WHERE cc.collection_id = ?`,
    collection.id,
  );
  const finishTotals = await all<{
    card_id: string;
    material_key: string;
    effect_key: string | null;
  }>(
    ctx.db,
    `SELECT DISTINCT cd.id AS card_id, m.key AS material_key, fx.key AS effect_key
       FROM fb_collection_cards cc
       JOIN fb_card_definitions cd ON cd.id = cc.card_id AND cd.status = 'published' AND cd.archived_at IS NULL
       JOIN fb_variants v ON v.card_id = cd.id AND v.status = 'published' AND v.archived_at IS NULL
       JOIN fb_materials m ON m.id = v.material_id
       LEFT JOIN fb_effects fx ON fx.id = v.effect_id
      WHERE cc.collection_id = ?`,
    collection.id,
  );
  if (!user) {
    return {
      collection: collection.slug,
      audience: collection.view_audience,
      total_cards: totals?.cards ?? 0,
      total_variants: totals?.variants ?? 0,
      owned_cards: 0,
      owned_variants: 0,
      owned_copies: 0,
      duplicates: 0,
      finishes: emptyFinishProgress(finishTotals),
      complete: false,
    };
  }
  const owned = await first<{ cards: number; variants: number; copies: number }>(
    ctx.db,
    `SELECT COUNT(DISTINCT ci.card_id) AS cards, COUNT(DISTINCT ci.variant_id) AS variants, COUNT(*) AS copies
       FROM fb_card_instances ci
       JOIN fb_card_definitions cd ON cd.id = ci.card_id AND cd.status = 'published' AND cd.archived_at IS NULL
       JOIN fb_collection_cards cc ON cc.card_id = ci.card_id
      WHERE ci.tenant_id = ? AND ci.user_id = ? AND ci.status IN ('owned','reserved')
        AND cc.collection_id = ?`,
    ctx.tenant.id,
    user.id,
    collection.id,
  );
  const ownedFinishRows = await all<{
    card_id: string;
    material_key: string;
    effect_key: string | null;
  }>(
    ctx.db,
    `SELECT ci.card_id, m.key AS material_key, fx.key AS effect_key
       FROM fb_card_instances ci
       JOIN fb_card_definitions cd ON cd.id = ci.card_id AND cd.status = 'published' AND cd.archived_at IS NULL
       JOIN fb_collection_cards cc ON cc.card_id = ci.card_id
       JOIN fb_variants v ON v.id = ci.variant_id
       JOIN fb_materials m ON m.id = v.material_id
       LEFT JOIN fb_effects fx ON fx.id = v.effect_id
      WHERE ci.tenant_id = ? AND ci.user_id = ? AND ci.status IN ('owned','reserved')
        AND cc.collection_id = ?`,
    ctx.tenant.id,
    user.id,
    collection.id,
  );
  const totalCards = totals?.cards ?? 0;
  const ownedCards = owned?.cards ?? 0;
  const totalVariants = totals?.variants ?? 0;
  const ownedVariants = owned?.variants ?? 0;
  return {
    collection: collection.slug,
    audience: collection.view_audience,
    total_cards: totalCards,
    total_variants: totalVariants,
    owned_cards: ownedCards,
    owned_variants: ownedVariants,
    owned_copies: owned?.copies ?? 0,
    duplicates: Math.max(0, (owned?.copies ?? 0) - ownedCards),
    finishes: finishProgress(finishTotals, ownedFinishRows),
    complete: totalCards > 0 && ownedCards >= totalCards,
    variant_complete: totalVariants > 0 && ownedVariants >= totalVariants,
  };
}

export async function collectionBinder(ctx: Ctx, collectionId: string) {
  const collection = await getCollection(ctx, collectionId);
  const user = ctx.user;
  if (!user) throw new ApiError(401, "authentication_required", "Sign in to open the album.");
  const rows = await all<{
    id: string;
    slug: string;
    name: string;
    subtitle: string | null;
    status: string;
    render_url: string | null;
    thumbnail_url: string | null;
  }>(
    ctx.db,
    `SELECT cd.id, cd.slug, cd.name, cd.subtitle, cd.status,
            (SELECT vr.public_url FROM fb_variants v2
               JOIN fb_variant_renders vr ON vr.variant_id = v2.id AND vr.status = 'published'
              WHERE v2.card_id = cd.id AND v2.status = 'published' AND v2.archived_at IS NULL
              ORDER BY v2.name LIMIT 1) AS render_url,
            (SELECT vr.public_url FROM fb_variants v2
               JOIN fb_variant_renders vr ON vr.variant_id = v2.id AND vr.status = 'published'
              WHERE v2.card_id = cd.id AND v2.status = 'published' AND v2.archived_at IS NULL
              ORDER BY v2.name LIMIT 1) AS thumbnail_url
       FROM fb_collection_cards cc
       JOIN fb_card_definitions cd ON cd.id = cc.card_id AND cd.status = 'published' AND cd.archived_at IS NULL
      WHERE cc.collection_id = ?
      ORDER BY cc.sort, cd.name`,
    collection.id,
  ).catch(async () => {
    // Older local schemas may not have the ordered material join; the base
    // fields are still useful and the page stays honest about missing media.
    return all<{
      id: string;
      slug: string;
      name: string;
      subtitle: string | null;
      status: string;
      render_url: string | null;
      thumbnail_url: string | null;
    }>(
      ctx.db,
      `SELECT cd.id, cd.slug, cd.name, cd.subtitle, cd.status, NULL AS render_url, NULL AS thumbnail_url
         FROM fb_collection_cards cc
         JOIN fb_card_definitions cd ON cd.id = cc.card_id AND cd.status = 'published' AND cd.archived_at IS NULL
        WHERE cc.collection_id = ? ORDER BY cc.sort, cd.name`,
      collection.id,
    );
  });
  const ownedRows = await all<{
    card_id: string;
    instance_id: string;
    material_key: string;
    effect_key: string | null;
    render_url: string | null;
  }>(
    ctx.db,
    `SELECT ci.card_id, ci.id AS instance_id, m.key AS material_key, fx.key AS effect_key,
            (SELECT vr.public_url FROM fb_variant_renders vr WHERE vr.variant_id = ci.variant_id AND vr.status = 'published' LIMIT 1) AS render_url
       FROM fb_card_instances ci
       JOIN fb_collection_cards cc ON cc.card_id = ci.card_id
       JOIN fb_variants v ON v.id = ci.variant_id
       JOIN fb_materials m ON m.id = v.material_id
       LEFT JOIN fb_effects fx ON fx.id = v.effect_id
      WHERE ci.tenant_id = ? AND ci.user_id = ? AND ci.status IN ('owned','reserved') AND cc.collection_id = ?`,
    ctx.tenant.id,
    user.id,
    collection.id,
  );
  const byCard = new Map<
    string,
    { finishes: Set<string>; render_url: string | null; copies: number; instance_id: string }
  >();
  for (const row of ownedRows) {
    const current = byCard.get(row.card_id) ?? {
      finishes: new Set<string>(),
      render_url: null,
      copies: 0,
      instance_id: row.instance_id,
    };
    current.finishes.add(finishKeyOf(row.material_key, row.effect_key));
    current.copies += 1;
    if (!current.render_url) current.render_url = row.render_url;
    byCard.set(row.card_id, current);
  }
  return {
    collection: collection.slug,
    name: collection.name,
    total: rows.length,
    cards: rows.map((row) => {
      const owned = byCard.get(row.id);
      return {
        ...row,
        owned: Boolean(owned),
        copies: owned?.copies ?? 0,
        finishes: owned
          ? [...owned.finishes].filter((finish) =>
              (CORE_FINISHES as readonly string[]).includes(finish),
            )
          : [],
        render_url: owned?.render_url ?? null,
        instance_id: owned?.instance_id ?? null,
      };
    }),
  };
}

const CORE_FINISHES = ["plain", "silver", "gold", "holographic"] as const;

function finishKeyOf(material: string, effect: string | null): string {
  if (effect === "holographic" || material === "diamond") return "holographic";
  if (material === "silver") return "silver";
  if (material === "gold") return "gold";
  if (material === "plain") return "plain";
  return "other";
}

function emptyFinishProgress(
  rows: Array<{ card_id: string; material_key: string; effect_key: string | null }>,
) {
  const out: Record<string, { owned: number; total: number }> = {};
  for (const finish of CORE_FINISHES) out[finish] = { owned: 0, total: 0 };
  const totals = new Map<string, Set<string>>();
  for (const row of rows) {
    const key = finishKeyOf(row.material_key, row.effect_key);
    if (!totals.has(key)) totals.set(key, new Set());
    totals.get(key)!.add(row.card_id);
  }
  for (const finish of CORE_FINISHES) out[finish]!.total = totals.get(finish)?.size ?? 0;
  return out;
}

function finishProgress(
  totalsRows: Array<{ card_id: string; material_key: string; effect_key: string | null }>,
  ownedRows: Array<{ card_id: string; material_key: string; effect_key: string | null }>,
) {
  const out = emptyFinishProgress(totalsRows);
  const owned = new Map<string, Set<string>>();
  for (const row of ownedRows) {
    const key = finishKeyOf(row.material_key, row.effect_key);
    if (!owned.has(key)) owned.set(key, new Set());
    owned.get(key)!.add(row.card_id);
  }
  for (const finish of CORE_FINISHES) out[finish]!.owned = owned.get(finish)?.size ?? 0;
  return out;
}

function assetIdFromUrl(value: string | undefined | null): string | null {
  if (!value) return null;
  const match = value.match(/^\/media\/asset\/([A-Za-z0-9_-]+)$/);
  return match ? match[1]! : null;
}

function safeUrl(value: string | undefined | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) return trimmed.slice(0, 500);
  try {
    const url = new URL(trimmed);
    if (url.protocol === "https:") return url.toString().slice(0, 500);
  } catch {
    return null;
  }
  return null;
}

async function auditCollection(
  ctx: Ctx,
  action: string,
  collectionId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await ctx.db
    .prepare(
      `INSERT INTO fb_audit_events
        (id, tenant_id, actor_type, actor_id, represented_user_id, action, object_type, object_id, metadata_json, request_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'collection', ?, ?, ?, ?)`,
    )
    .bind(
      newId("aud"),
      ctx.tenant.id,
      ctx.actor.type,
      ctx.actor.id,
      ctx.actor.representedUserId,
      action,
      collectionId,
      JSON.stringify(metadata),
      ctx.requestId,
      nowIso(),
    )
    .run()
    .catch(() => undefined);
}
