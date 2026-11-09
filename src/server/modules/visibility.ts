import { ApiError, type Ctx } from "../context";
import { all, first } from "../db";
import { liveViewerContext } from "./live-viewer";

/**
 * Viewing audience is deliberately separate from collection lifecycle
 * (`status`), ownership (`scope`/`owner_tenant_id`) and distribution
 * (`fb_bot_collections.enabled`).
 *
 *   public  — approved Loftwah showcase material, readable while signed out
 *   members — an active member of the owning album / Bot community
 *   private — owner scope, platform Super Admin, or an explicit grant
 *
 * A card inherits the most restrictive audience of every live collection it
 * belongs to. Adding a permissive membership link can never widen access.
 */
export type Audience = "public" | "members" | "private";

export interface ViewerAccess {
  signedIn: boolean;
  userId: string | null;
  platformAdmin: boolean;
  globalCollectionAdmin: boolean;
  globalCollectionIds: Set<string> | null;
  /** Every tenant where the account has an active, non-revoked membership. */
  memberTenantIds: Set<string>;
  /** Tenants where the account holds an administrative role. */
  adminTenantIds: Set<string>;
  mainAlbumTenantId: string | null;
  /** Collections explicitly shared with this user, including private ones. */
  explicitCollectionIds: Set<string>;
  /** Admin roles for the current tenant can inspect their own drafts. */
  managesCurrentTenant: boolean;
  /** Delegated Bot administration never grants access to global-private sets. */
  botScopedAgentAdmin?: boolean;
}

const AUDIENCE_RANK: Record<Audience, number> = { public: 0, members: 1, private: 2 };

export function mostRestrictive(a: Audience, b: Audience): Audience {
  return AUDIENCE_RANK[a] >= AUDIENCE_RANK[b] ? a : b;
}

export function isPublicAudience(value: string): boolean {
  return value === "public";
}

export function audienceRank(value: string): number {
  return AUDIENCE_RANK[(value as Audience) in AUDIENCE_RANK ? (value as Audience) : "private"];
}

export async function viewerAccess(ctx: Ctx, options?: { liveContentAdmin?: boolean; delegatedGlobalScope?: boolean; delegatedBotContent?: boolean }): Promise<ViewerAccess> {
  const user = ctx.user;
  if (!user || (ctx.actor.type === "agent" && !ctx.scopes?.some((scope) => scope === "inventory:read" || scope === "content:read"))) {
    return {
      signedIn: false,
      userId: null,
      platformAdmin: false,
      globalCollectionAdmin: false,
      globalCollectionIds: null,
      memberTenantIds: new Set(),
      adminTenantIds: new Set(),
      mainAlbumTenantId: ctx.tenant.id,
      explicitCollectionIds: new Set(),
      managesCurrentTenant: false,
    };
  }
  const memberships = await all<{ tenant_id: string; role: string }>(
    ctx.db,
    `SELECT tenant_id, role FROM fb_memberships
      WHERE user_id = ? AND status = 'active' AND revoked_at IS NULL AND (? = 0 OR tenant_id = ?)`,
    user.id,
    ctx.actor.type === "agent" ? 1 : 0,
    ctx.tenant.id,
  );
  const grants = await all<{ collection_id: string }>(
    ctx.db,
    `SELECT cv.collection_id FROM fb_collection_viewers cv JOIN fb_collections c ON c.id = cv.collection_id
      WHERE cv.user_id = ? AND cv.revoked_at IS NULL AND (? = 0 OR c.scope = 'global' OR c.owner_tenant_id = ?)`,
    user.id,
    ctx.actor.type === "agent" ? 1 : 0,
    ctx.tenant.id,
  );
  const liveContentTenants = options?.liveContentAdmin ? new Set((await all<{ tenant_id: string }>(ctx.db,
    `SELECT m.tenant_id FROM fb_memberships m JOIN fb_users u ON u.id = m.user_id
       JOIN fb_bots b ON b.tenant_id = m.tenant_id AND b.status <> 'archived'
       LEFT JOIN fb_bot_admins ba ON ba.bot_id = b.id AND ba.user_id = m.user_id
      WHERE m.user_id = ? AND m.status = 'active' AND m.revoked_at IS NULL AND u.disabled_at IS NULL
        AND ((m.role = 'owner' AND b.owner_user_id = m.user_id)
          OR (EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(m.capabilities_json) THEN m.capabilities_json ELSE '[]' END) WHERE value = 'content')
            AND (ba.id IS NULL OR (ba.status = 'active' AND ba.revoked_at IS NULL AND EXISTS
              (SELECT 1 FROM json_each(CASE WHEN json_valid(ba.capabilities_json) THEN ba.capabilities_json ELSE '[]' END) WHERE value = 'content')))))`, user.id)).map(row => row.tenant_id)) : null;
  const delegatedBot = ctx.actor.type === 'agent' && options?.delegatedBotContent && Boolean(await first(ctx.db,
    `SELECT 1 FROM fb_memberships m JOIN fb_bots b ON b.tenant_id=m.tenant_id AND b.status='active'
      JOIN fb_users u ON u.id=m.user_id AND u.disabled_at IS NULL LEFT JOIN fb_bot_admins ba ON ba.bot_id=b.id AND ba.user_id=m.user_id
      WHERE m.tenant_id=? AND m.user_id=? AND m.status='active' AND m.revoked_at IS NULL AND
        ((m.role='owner' AND b.owner_user_id=m.user_id) OR (m.role<>'owner'
          AND json_type(CASE WHEN json_valid(m.capabilities_json) THEN m.capabilities_json ELSE 'null' END)='array'
          AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(m.capabilities_json) THEN m.capabilities_json ELSE '[]' END) WHERE type<>'text')
          AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(m.capabilities_json) THEN m.capabilities_json ELSE '[]' END) WHERE value='content')
          AND ba.role='admin' AND ba.status='active' AND ba.revoked_at IS NULL
          AND json_type(CASE WHEN json_valid(ba.capabilities_json) THEN ba.capabilities_json ELSE 'null' END)='array'
          AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(ba.capabilities_json) THEN ba.capabilities_json ELSE '[]' END) WHERE type<>'text')
          AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(ba.capabilities_json) THEN ba.capabilities_json ELSE '[]' END) WHERE value='content')))`,ctx.tenant.id,user.id));
  const managesCurrentTenant = Boolean(delegatedBot) || (ctx.actor.type !== "agent" &&
    (user.platformAdmin || (["owner", "editor", "economy_admin"].includes(user.role) &&
      (!liveContentTenants || liveContentTenants.has(ctx.tenant.id)))));
  const globalScope = ctx.actor.type === "agent" && !options?.delegatedGlobalScope ? null : user.globalCollectionScope;
  return {
    signedIn: true,
    userId: user.id,
    // A delegated bearer must not inherit unrestricted platform visibility
    // merely because its represented person is a platform administrator.
    platformAdmin: ctx.actor.type !== "agent" && Boolean(user.platformAdmin),
    globalCollectionAdmin: Boolean(globalScope),
    globalCollectionIds: globalScope && !globalScope.all ? new Set(globalScope.collectionIds) : null,
    memberTenantIds: new Set(memberships.map((row) => row.tenant_id)),
    adminTenantIds: delegatedBot ? new Set([ctx.tenant.id]) : new Set(
      memberships.filter((row) => ctx.actor.type !== "agent" && ["owner", "editor", "economy_admin"].includes(row.role) && (!liveContentTenants || liveContentTenants.has(row.tenant_id))).map((row) => row.tenant_id),
    ),
    botScopedAgentAdmin: Boolean(delegatedBot),
    mainAlbumTenantId: ctx.tenant.id,
    explicitCollectionIds: new Set(grants.map((row) => row.collection_id)),
    managesCurrentTenant,
  };
}

/** Rebuild identity and scoped authority before a visibility-sensitive read. */
export async function currentViewerAccess(ctx: Ctx): Promise<ViewerAccess> {
  if (!ctx.user) return viewerAccess(ctx, { liveContentAdmin: true });
  const live = await liveViewerContext(ctx, ctx.user.id);
  return viewerAccess(live ?? { ...ctx, user: null }, { liveContentAdmin: true });
}

export function canViewAudience(
  access: ViewerAccess,
  collection: {
    id: string;
    scope: string;
    owner_tenant_id: string | null;
    view_audience: string;
    status: string;
    public_approved_at: string | null;
  },
): boolean {
  if (collection.status !== "published") {
    if (access.globalCollectionAdmin && collection.scope === "global") {
      return !access.globalCollectionIds || access.globalCollectionIds.has(collection.id);
    }
    return access.platformAdmin || access.managesCurrentTenant;
  }
  if (access.globalCollectionAdmin && collection.scope === "global") {
    if (!access.globalCollectionIds || access.globalCollectionIds.has(collection.id)) return true;
  }
  if (collection.view_audience === "public") {
    return Boolean(collection.public_approved_at);
  }
  if (!access.signedIn) return false;
  if (access.platformAdmin) return true;
  if (collection.view_audience === "private") {
    if (access.explicitCollectionIds.has(collection.id)) return true;
    return Boolean((!access.botScopedAgentAdmin || collection.scope === 'bot') && collection.owner_tenant_id && access.adminTenantIds.has(collection.owner_tenant_id));
  }
  // Members: a global member collection is available to any active Foilbury
  // album member; a Bot collection requires membership of that Bot.
  if (collection.scope === "global") {
    return access.memberTenantIds.size > 0;
  }
  return Boolean(collection.owner_tenant_id && access.memberTenantIds.has(collection.owner_tenant_id));
}

export interface CollectionVisibilityRow {
  id: string;
  scope: string;
  owner_tenant_id: string | null;
  view_audience: string;
  status: string;
  public_approved_at: string | null;
}

export async function canViewCollection(ctx: Ctx, idOrSlug: string, options?: { liveContentAdmin?: boolean; delegatedGlobalScope?: boolean; delegatedBotContent?: boolean }): Promise<CollectionVisibilityRow | null> {
  const row = await first<CollectionVisibilityRow>(
    ctx.db,
    `SELECT id, scope, owner_tenant_id, view_audience, status, public_approved_at
       FROM fb_collections WHERE id = ? OR slug = ?`,
    idOrSlug,
    idOrSlug,
  );
  if (!row) return null;
  const access = await viewerAccess(ctx, options);
  return canViewAudience(access, row) ? row : null;
}

export function assertCanViewCollection(
  access: ViewerAccess,
  collection: CollectionVisibilityRow,
): asserts collection is CollectionVisibilityRow {
  if (!canViewAudience(access, collection)) {
    throw new ApiError(404, "collection_not_found", "That collection is not available to this account.");
  }
}

/**
 * Builds the SQL predicate for a collection row alias. The same predicate is
 * used for collection lists, card lists, counts and media decisions so a new
 * surface cannot drift into a weaker rule.
 */
export function collectionVisibilitySql(
  access: ViewerAccess,
  alias = "c",
  options: { includeDrafts?: boolean } = {},
): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  clauses.push(`(${alias}.status = 'published' AND ${alias}.archived_at IS NULL)`);
  const publishedVisible: string[] = [];

  publishedVisible.push(`(${alias}.view_audience = 'public' AND ${alias}.public_approved_at IS NOT NULL)`);

  if (access.globalCollectionAdmin) {
    if (access.globalCollectionIds) {
      const ids = [...access.globalCollectionIds];
      if (ids.length) {
        publishedVisible.push(`(${alias}.scope = 'global' AND ${alias}.id IN (${ids.map(() => "?").join(",")}))`);
        params.push(...ids);
      }
    } else {
      publishedVisible.push(`(${alias}.scope = 'global')`);
    }
  }

  if (access.signedIn) {
    if (access.platformAdmin) {
      publishedVisible.push("1 = 1");
    } else {
      const memberIds = [...access.memberTenantIds];
      if (memberIds.length) {
        const placeholders = memberIds.map(() => "?").join(",");
        publishedVisible.push(
          `(${alias}.view_audience = 'members' AND ((${alias}.scope = 'global') OR ${alias}.owner_tenant_id IN (${placeholders})))`,
        );
        params.push(...memberIds);
        const adminIds = [...access.adminTenantIds];
        if (adminIds.length) {
          publishedVisible.push(
            `(${alias}.view_audience = 'private' ${access.botScopedAgentAdmin ? `AND ${alias}.scope = 'bot'` : ''} AND ${alias}.owner_tenant_id IN (${adminIds.map(() => "?").join(",")}))`,
          );
          params.push(...adminIds);
        }
      }
      if (access.explicitCollectionIds.size) {
        const ids = [...access.explicitCollectionIds];
        publishedVisible.push(
          `(${alias}.view_audience = 'private' AND ${alias}.id IN (${ids.map(() => "?").join(",")}))`,
        );
        params.push(...ids);
      }
    }
  }
  if (publishedVisible.length === 0) return { sql: "0 = 1", params: [] };

  // Admin management lists may include drafts of the current tenant. Card and
  // media reads pass includeDrafts=false and therefore never serve a draft.
  // A Global Collection Admin may inspect drafts inside their explicit scope.
  const draftClause =
    options.includeDrafts && access.managesCurrentTenant
      ? ` OR (${alias}.status <> 'published' AND (${alias}.scope = 'global' OR ${alias}.owner_tenant_id = ?))`
      : options.includeDrafts && access.globalCollectionAdmin
        ? access.globalCollectionIds
          ? ` OR (${alias}.status <> 'published' AND ${alias}.scope = 'global' AND ${alias}.id IN (${[...access.globalCollectionIds].map(() => "?").join(",") || "NULL"}))`
          : ` OR (${alias}.status <> 'published' AND ${alias}.scope = 'global')`
        : "";
  if (draftClause) {
    if (options.includeDrafts && access.managesCurrentTenant) params.push(access.mainAlbumTenantId ?? "__none__");
    else if (access.globalCollectionIds) params.push(...access.globalCollectionIds);
  }
  clauses.push(`((${publishedVisible.join(" OR ")})${draftClause})`);
  return { sql: clauses.join(" AND "), params };
}

/**
 * A public-facing predicate. Drafts, members and private collections are all
 * excluded, regardless of who is signed in.
 */
export function publicCollectionSql(alias = "c"): string {
  return `${alias}.status = 'published' AND ${alias}.archived_at IS NULL AND ${alias}.view_audience = 'public' AND ${alias}.public_approved_at IS NOT NULL`;
}

/**
 * Effective card predicate: published, in at least one visible collection, and
 * every collection it belongs to is visible. This is what prevents a public
 * link from widening a card that also belongs to a member-only world.
 */
export function cardVisibilitySql(access: ViewerAccess, alias = "cd"): { sql: string; params: unknown[] } {
  const visibility = collectionVisibilitySql(access, "cvis");
  const notVisibility = collectionVisibilitySql(access, "chidden");
  const legacy = access.signedIn
    ? ` OR (NOT EXISTS (SELECT 1 FROM fb_collection_cards cc_any WHERE cc_any.card_id = ${alias}.id) AND ${alias}.tenant_id = ?)`
    : "";
  const sql = `((EXISTS (
      SELECT 1 FROM fb_collection_cards cc_vis
      JOIN fb_collections cvis ON cvis.id = cc_vis.collection_id
      WHERE cc_vis.card_id = ${alias}.id AND (${visibility.sql})
    )
    AND NOT EXISTS (
      SELECT 1 FROM fb_collection_cards cc_hidden
      JOIN fb_collections chidden ON chidden.id = cc_hidden.collection_id
      WHERE cc_hidden.card_id = ${alias}.id AND NOT (${notVisibility.sql})
    ))${legacy})`;
  return {
    sql,
    params: [...visibility.params, ...notVisibility.params, ...(access.signedIn ? [access.mainAlbumTenantId ?? "__none__"] : [])],
  };
}

export async function visibleCollectionIds(ctx: Ctx): Promise<Set<string>> {
  const access = await viewerAccess(ctx);
  const visibility = collectionVisibilitySql(access);
  const rows = await all<{ id: string }>(
    ctx.db,
    `SELECT c.id FROM fb_collections c WHERE ${visibility.sql}`,
    ...visibility.params,
  );
  return new Set(rows.map((row) => row.id));
}

export async function canViewCard(ctx: Ctx, cardId: string, options?: { liveContentAdmin?: boolean; delegatedGlobalScope?: boolean; delegatedBotContent?: boolean }): Promise<boolean> {
  const access = await viewerAccess(ctx, options);
  const visibility = cardVisibilitySql(access);
  const row = await first<{ present: number }>(
    ctx.db,
    `SELECT 1 AS present FROM fb_card_definitions cd
      WHERE cd.id = ? AND cd.archived_at IS NULL AND (${visibility.sql}) LIMIT 1`,
    cardId,
    ...visibility.params,
  );
  return Boolean(row);
}

export async function effectiveCardAudience(ctx: Ctx, cardId: string): Promise<Audience> {
  const rows = await all<{ view_audience: string; public_approved_at: string | null; status: string }>(
    ctx.db,
    `SELECT c.view_audience, c.public_approved_at, c.status
       FROM fb_collection_cards cc JOIN fb_collections c ON c.id = cc.collection_id
      WHERE cc.card_id = ? AND c.archived_at IS NULL`,
    cardId,
  );
  if (!rows.length) return "private";
  let audience: Audience = "public";
  for (const row of rows) {
    const next: Audience =
      row.status !== "published" || row.view_audience === "private"
        ? "private"
        : row.view_audience === "members"
          ? "members"
          : row.public_approved_at
            ? "public"
            : "private";
    audience = mostRestrictive(audience, next);
  }
  return audience;
}

export function audienceLabel(value: string): string {
  if (value === "public") return "Public showcase";
  if (value === "members") return "Members";
  return "Private";
}

export function audienceExplanation(value: string): string {
  if (value === "public") return "Reviewed Loftwah project content on the public showcase.";
  if (value === "members") return "Visible to signed-in members of this album or Bot community.";
  return "Restricted to the owner scope and explicitly invited viewers.";
}
