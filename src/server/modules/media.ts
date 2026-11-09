import type { APIRoute } from "astro";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { ApiError, buildContext, type Ctx } from "../context";
import { all, first, nowIso } from "../db";
import { canViewAudience, cardVisibilitySql, viewerAccess } from "./visibility";
import { readAsset, readVerifiedRenderInput, type AssetRow } from "./assets";
import { legacyBrandUrlFence } from "./collections";
import { DRAW_EPOCH_TRIGGER_CHECK, DRAW_EPOCH_TRIGGER_DATA } from "./draw-scope-epoch";
import { BOUND_LINEAGE_TRIGGER_DEFINITIONS } from "./bound-lineage-trigger-definitions";

interface RenderRow {
  asset_id: string;
  r2_key: string;
  mime: string;
  bytes: number;
  width: number;
  height: number;
  sha256: string;
  variant_id: string;
  card_id: string;
  render_status: string;
  processing_state: string;
  access_classification: string;
}

async function renderRow(ctx: Ctx, assetId: string): Promise<RenderRow | null> {
  return first<RenderRow>(
    ctx.db,
    `SELECT vr.asset_id, a.r2_key, a.mime, a.bytes, a.width, a.height, a.sha256,
            vr.variant_id, v.card_id, vr.status AS render_status,
            a.processing_state, a.access_classification
       FROM fb_variant_renders vr
       JOIN fb_assets a ON a.id = vr.asset_id AND a.tenant_id = vr.tenant_id
       JOIN fb_variants v ON v.id = vr.variant_id AND v.tenant_id = vr.tenant_id
      WHERE vr.asset_id = ? AND vr.status = 'published' AND a.archived_at IS NULL`,
    assetId,
  );
}

/** Shared bytes inherit the restrictions of every linked use, not whichever
 * row SQLite happens to return first. */
async function safeMediaViewer(ctx: Ctx): Promise<Ctx> {
  if (!ctx.user) return ctx;
  const user = ctx.user;
  const identity = await first<{ present: number }>(ctx.db, `SELECT 1 AS present FROM fb_users u WHERE u.id = ? AND u.disabled_at IS NULL
    AND (? IS NULL OR EXISTS (SELECT 1 FROM fb_sessions s WHERE s.id = ? AND s.user_id = u.id AND s.tenant_id = ? AND s.revoked_at IS NULL AND s.expires_at > ?))`,
    user.id, ctx.sessionId, ctx.sessionId, ctx.tenant.id, nowIso());
  if (!identity) return { ...ctx, user: null };
  const live = await first<{ role: string; content: number; platform_admin: number }>(ctx.db, `SELECT m.role,
    CASE WHEN m.role = 'owner' AND b.owner_user_id = m.user_id THEN 1
      WHEN json_type(CASE WHEN json_valid(m.capabilities_json) THEN m.capabilities_json ELSE 'null' END)='array'
       AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(m.capabilities_json) THEN m.capabilities_json ELSE '[]' END) WHERE type<>'text')
       AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(m.capabilities_json) THEN m.capabilities_json ELSE '[]' END) WHERE value = 'content')
       AND (ba.id IS NULL OR (ba.role='admin' AND ba.status = 'active' AND ba.revoked_at IS NULL
         AND json_type(CASE WHEN json_valid(ba.capabilities_json) THEN ba.capabilities_json ELSE 'null' END)='array'
         AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(ba.capabilities_json) THEN ba.capabilities_json ELSE '[]' END) WHERE type<>'text')
         AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(ba.capabilities_json) THEN ba.capabilities_json ELSE '[]' END) WHERE value = 'content'))) THEN 1 ELSE 0 END AS content,
    CASE WHEN u.platform_admin = 1 AND EXISTS (SELECT 1 FROM fb_platform_admins pa WHERE pa.user_id = u.id AND pa.status = 'active' AND pa.revoked_at IS NULL) THEN 1 ELSE 0 END AS platform_admin
    FROM fb_memberships m JOIN fb_users u ON u.id = m.user_id JOIN fb_bots b ON b.tenant_id = m.tenant_id AND b.status <> 'archived'
    LEFT JOIN fb_bot_admins ba ON ba.bot_id = b.id AND ba.user_id = m.user_id
    WHERE m.tenant_id = ? AND m.user_id = ? AND m.status = 'active' AND m.revoked_at IS NULL AND u.disabled_at IS NULL
      AND (? IS NULL OR EXISTS (SELECT 1 FROM fb_sessions s WHERE s.id = ? AND s.user_id = m.user_id AND s.tenant_id = m.tenant_id AND s.revoked_at IS NULL AND s.expires_at > ?)) LIMIT 1`,
    ctx.tenant.id, user.id, ctx.sessionId, ctx.sessionId, nowIso());
  const permitted = ctx.actor.type !== "agent" || Boolean(ctx.scopes?.includes("content:read"));
  const assignment = permitted && live ? await first<{ scopes_json: string }>(ctx.db,
    "SELECT scopes_json FROM fb_platform_role_assignments WHERE user_id = ? AND role = 'global_collection_admin' AND status = 'active' AND revoked_at IS NULL", user.id) : null;
  let scope: { all: boolean; collectionIds: string[] } | undefined;
  if (assignment) try {
    const value = JSON.parse(assignment.scopes_json) as { all?: unknown; collectionIds?: unknown };
    if (value.all === true) scope = { all: true, collectionIds: [] };
    else if (value.all === false && Array.isArray(value.collectionIds) && value.collectionIds.length && value.collectionIds.every(id => typeof id === "string" && id.length)) scope = { all: false, collectionIds: value.collectionIds as string[] };
  } catch { /* A malformed role is never authority. */ }
  return { ...ctx, user: { ...user, role: permitted && live?.content ? (live.role === "owner" ? "owner" : "editor") : "player", platformAdmin: Boolean(permitted && live?.platform_admin), globalCollectionScope: scope } };
}

async function sharedAudience(ctx: Ctx, assetId: string, checkLegacyReferences = false, delegatedGlobalScope = false): Promise<{ allowed: boolean; public: boolean }> {
  const viewer = await safeMediaViewer(ctx);
  const boundSchema=await first(ctx.db,"SELECT 1 FROM sqlite_master WHERE type='table' AND name='fb_bound_render_outputs'");
  const visited = new Set<string>();
  const parents = new Map<string, string[]>();
  const assets = new Map<string, { derivative_of_asset_id: string | null; dependencies: string[] }>();
  let pending = [assetId];
  let rounds = 0;
  while (pending.length) {
    const batch = [...new Set(pending)].filter(id => !visited.has(id)).slice(0, 64);
    if (!batch.length) break;
    // Deep chains otherwise cause two database queries per node. Refuse an
    // unreasonably deep provenance graph instead of exceeding request limits.
    if (++rounds > 32) return { allowed: false, public: false };
    pending = pending.filter(id => !batch.includes(id) && !visited.has(id));
    if (visited.size + batch.length > 256) return { allowed: false, public: false };
    batch.forEach(id => visited.add(id));
    if (checkLegacyReferences) for (const id of batch) {
      try {
        const fence = await legacyBrandUrlFence(ctx,id);
        if (!await first(ctx.db, `SELECT 1 WHERE ${fence.sql}`, ...fence.args)) return {allowed:false,public:false};
      } catch (error) {
        if (!(error instanceof ApiError) || !['brand_index_unavailable','brand_reference_reconciling','brand_reference_ambiguous','brand_reference_invalid'].includes(error.code)) throw error;
        return {allowed:false,public:false};
      }
    }
    const ids = JSON.stringify(batch);
    const rows = await all<{ id: string; derivative_of_asset_id: string | null; dependencies_json: string; archived_at: string | null }>(ctx.db,
      "SELECT id, derivative_of_asset_id, dependencies_json, archived_at FROM fb_assets WHERE id IN (SELECT value FROM json_each(?))", ids);
    if (rows.length !== batch.length) return { allowed: false, public: false };
    for (const asset of rows) {
      if (asset.archived_at) return { allowed: false, public: false };
      let deps: unknown;
      try { deps = JSON.parse(asset.dependencies_json); } catch { return { allowed: false, public: false }; }
      if (!Array.isArray(deps) || deps.some(x => typeof x !== "string" || !x)) return { allowed: false, public: false };
      parents.set(asset.id, [...deps, ...(asset.derivative_of_asset_id ? [asset.derivative_of_asset_id] : [])]);
      assets.set(asset.id, { derivative_of_asset_id: asset.derivative_of_asset_id, dependencies: deps });
      pending.push(...deps);
      if (asset.derivative_of_asset_id) pending.push(asset.derivative_of_asset_id);
    }
    // Ignore a superseded bound output only after proving it has no current
    // consumers. URL references require the bounded legacy index snapshot:
    // unrelated dirty rows must not make every later rendition unavailable.
    const children = await all<{ id: string; bound: number }>(ctx.db, `SELECT id,
      ${boundSchema ? "EXISTS (SELECT 1 FROM fb_bound_render_outputs p WHERE p.asset_id=a.id)" : "0"} AS bound
      FROM fb_assets a WHERE (a.derivative_of_asset_id IN (SELECT value FROM json_each(?)) OR EXISTS (
      SELECT 1 FROM json_each(CASE WHEN json_valid(a.dependencies_json) THEN a.dependencies_json ELSE '[]' END) d JOIN json_each(?) ids ON ids.value = d.value)) LIMIT 257`, ids, ids);
    if (children.length > 256) return { allowed: false, public: false };
    for (const child of children) {
      if (!child.bound) { pending.push(child.id); continue; }
      let urlFence: Awaited<ReturnType<typeof legacyBrandUrlFence>>;
      try { urlFence = await legacyBrandUrlFence(ctx, child.id); }
      catch (error) {
        if (!(error instanceof ApiError) || !['brand_index_unavailable','brand_reference_reconciling','brand_reference_ambiguous','brand_reference_invalid'].includes(error.code)) throw error;
        pending.push(child.id);
        continue;
      }
      const unused = await first(ctx.db, `SELECT 1 FROM fb_assets a WHERE a.id=?
        AND NOT EXISTS (SELECT 1 FROM fb_artwork_editions e WHERE e.subject_asset_id=a.id OR e.background_asset_id=a.id)
        AND NOT EXISTS (SELECT 1 FROM fb_card_definitions cd WHERE cd.card_back_asset_id=a.id)
        AND NOT EXISTS (SELECT 1 FROM fb_print_proposals q WHERE q.source_asset_id=a.id OR q.artwork_asset_id=a.id OR q.background_asset_id=a.id)
        AND NOT EXISTS (SELECT 1 FROM fb_variant_renders vr WHERE vr.asset_id=a.id)
        AND NOT EXISTS (SELECT 1 FROM fb_variant_back_renders br WHERE br.asset_id=a.id)
        AND NOT EXISTS (SELECT 1 FROM fb_collections c WHERE c.logo_asset_id=a.id OR c.banner_asset_id=a.id)
        AND NOT EXISTS (SELECT 1 FROM fb_brand_url_refs r WHERE r.asset_id=a.id)
        AND NOT EXISTS (SELECT 1 FROM fb_asset_derivatives d WHERE d.source_asset_id=a.id)
        AND NOT EXISTS (SELECT 1 FROM fb_assets child WHERE child.id<>a.id AND (child.derivative_of_asset_id=a.id OR EXISTS
          (SELECT 1 FROM json_each(CASE WHEN json_valid(child.dependencies_json) THEN child.dependencies_json ELSE '[]' END) x WHERE x.value=a.id)))
        AND ${urlFence.sql}`, child.id, ...urlFence.args);
      if (!unused) pending.push(child.id);
    }
  }
  const done = new Set<string>();
  const active = new Set<string>();
  const hasCycle = (id: string): boolean => {
    if (active.has(id)) return true;
    if (done.has(id)) return false;
    active.add(id);
    for (const parent of parents.get(id) ?? []) if (hasCycle(parent)) return true;
    active.delete(id);
    done.add(id);
    return false;
  };
  if ([...visited].some(hasCycle)) return { allowed: false, public: false };
  const ids = JSON.stringify([...visited]);
  // Keep each compound SELECT below D1's term limit.
  const [sourceLinks, renderLinks] = await Promise.all([all<{ asset_id: string; card_id: string }>(ctx.db, `WITH ids AS (SELECT value AS id FROM json_each(?))
    SELECT e.subject_asset_id AS asset_id, e.card_id FROM fb_artwork_editions e JOIN ids ON ids.id = e.subject_asset_id
    UNION SELECT e.background_asset_id, e.card_id FROM fb_artwork_editions e JOIN ids ON ids.id = e.background_asset_id
    UNION SELECT c.card_back_asset_id, c.id FROM fb_card_definitions c JOIN ids ON ids.id = c.card_back_asset_id
    UNION SELECT p.source_asset_id, p.card_id FROM fb_print_proposals p JOIN ids ON ids.id = p.source_asset_id LIMIT 257`, ids),
    all<{ asset_id: string; card_id: string }>(ctx.db, `WITH ids AS (SELECT value AS id FROM json_each(?))
    SELECT p.artwork_asset_id AS asset_id, p.card_id FROM fb_print_proposals p JOIN ids ON ids.id = p.artwork_asset_id
    UNION SELECT p.background_asset_id, p.card_id FROM fb_print_proposals p JOIN ids ON ids.id = p.background_asset_id
    UNION SELECT r.asset_id, v.card_id FROM fb_variant_renders r JOIN ids ON ids.id = r.asset_id JOIN fb_variants v ON v.id = r.variant_id AND v.tenant_id = r.tenant_id
    UNION SELECT r.asset_id, v.card_id FROM fb_variant_back_renders r JOIN ids ON ids.id = r.asset_id JOIN fb_variants v ON v.id = r.variant_id AND v.tenant_id = r.tenant_id LIMIT 257`, ids)]);
  if (sourceLinks.length > 256 || renderLinks.length > 256) return { allowed: false, public: false };
  const links = [...sourceLinks, ...renderLinks];
  const collections = await all<{ asset_id: string; id: string; scope:string; owner_tenant_id:string|null; status: string; view_audience: string; public_approved_at: string | null; archived_at:string|null }>(ctx.db,
    `WITH ids AS (SELECT value AS id FROM json_each(?))
     SELECT c.logo_asset_id AS asset_id, c.id, c.scope, c.owner_tenant_id, c.status, c.view_audience, c.public_approved_at, c.archived_at FROM fb_collections c JOIN ids ON ids.id = c.logo_asset_id
     UNION SELECT c.banner_asset_id, c.id, c.scope, c.owner_tenant_id, c.status, c.view_audience, c.public_approved_at, c.archived_at FROM fb_collections c JOIN ids ON ids.id = c.banner_asset_id LIMIT 257`, ids);
  if (collections.length > 256) return { allowed: false, public: false };
  const draft = await first<{ present: number }>(ctx.db, `SELECT 1 AS present FROM fb_print_proposals p
    WHERE p.status <> 'approved' AND (p.source_asset_id IN (SELECT value FROM json_each(?)) OR p.artwork_asset_id IN (SELECT value FROM json_each(?)) OR p.background_asset_id IN (SELECT value FROM json_each(?))) LIMIT 1`, ids, ids, ids);
  if (draft) return { allowed: false, public: false };
  const linked = new Set([...links.map(row => row.asset_id), ...collections.map(row => row.asset_id)]);
  for (const [id, asset] of assets) {
    if (!linked.has(id) && (!asset.derivative_of_asset_id || asset.dependencies.length)) return { allowed: false, public: false };
  }
  if (!linked.size) return { allowed: false, public: false };
  let isPublic = true;
  const cardIds = new Set(links.map(row => row.card_id));
  const collectionIds = new Set(collections.map(row => row.id));
  // Each graph and linked-use set has a hard bound; visibility is evaluated
  // from one viewer snapshot rather than one database round trip per use.
  if (cardIds.size > 256 || collectionIds.size > 256) return { allowed: false, public: false };
  const access = cardIds.size || collectionIds.size
    ? await viewerAccess(viewer,{liveContentAdmin:true,delegatedGlobalScope,delegatedBotContent:delegatedGlobalScope}) : null;
  if (cardIds.size) {
    const visibility=cardVisibilitySql(access!);
    const rows=await all<{id:string;public_safe:number}>(ctx.db,`SELECT cd.id,
      CASE WHEN EXISTS (SELECT 1 FROM fb_collection_cards cc JOIN fb_collections c ON c.id=cc.collection_id
        WHERE cc.card_id=cd.id AND c.archived_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM fb_collection_cards cc JOIN fb_collections c ON c.id=cc.collection_id
          WHERE cc.card_id=cd.id AND c.archived_at IS NULL AND (c.status<>'published' OR c.view_audience<>'public' OR c.public_approved_at IS NULL))
        THEN 1 ELSE 0 END AS public_safe
      FROM fb_card_definitions cd WHERE cd.id IN (SELECT value FROM json_each(?)) AND cd.archived_at IS NULL
        AND (cd.status='published' OR (?=1 AND cd.tenant_id=?)) AND (${visibility.sql})`,
      JSON.stringify([...cardIds]),access!.managesCurrentTenant ? 1 : 0,ctx.tenant.id,...visibility.params);
    if (rows.length!==cardIds.size) return {allowed:false,public:false};
    if (rows.some(row=>row.public_safe!==1)) isPublic=false;
  }
  const checkedCollections = new Set<string>();
  for (const collection of collections) {
    if (checkedCollections.has(collection.id)) continue;
    checkedCollections.add(collection.id);
    if (collection.archived_at || !canViewAudience(access!,collection)) return { allowed: false, public: false };
    if (collection.status !== "published" || collection.view_audience !== "public" || !collection.public_approved_at) isPublic = false;
  }
  return { allowed: true, public: isPublic };
}

/** Snapshot every current use of the inputs, including other cards. The
 * returned SQL must be evaluated alongside live caller credentials at the
 * final read or mutation; no caller may use this snapshot as authority on
 * its own. Out-of-band trigger repair requires a trusted epoch invalidation. */
export async function boundLineageFence(ctx: Ctx, assetIds: string[], delegatedContent = true) {
  const userId = ctx.user?.id ?? '';
  const triggerData = JSON.stringify(BOUND_LINEAGE_TRIGGER_DEFINITIONS);
  const triggerCheck = `NOT EXISTS (SELECT 1 FROM json_each(?) e WHERE NOT EXISTS
    (SELECT 1 FROM sqlite_master s WHERE s.type='trigger' AND s.name=json_extract(e.value,'$[0]') AND s.sql=json_extract(e.value,'$[1]')))`;
  let draw: {global_revision:number;tenant_revision:number;user_revision:number} | null;
  let lineage: {revision:number} | null;
  try {
    draw = await first(ctx.db,
      `SELECT g.revision AS global_revision,COALESCE((SELECT revision FROM fb_draw_scope_tenant_epochs WHERE tenant_id=?),0) AS tenant_revision,
        COALESCE((SELECT revision FROM fb_draw_scope_user_epochs WHERE user_id=?),0) AS user_revision
        FROM fb_draw_scope_global_epoch g WHERE g.id=1 AND ${DRAW_EPOCH_TRIGGER_CHECK}`,
      ctx.tenant.id,userId,DRAW_EPOCH_TRIGGER_DATA);
    lineage = await first(ctx.db,`SELECT revision FROM fb_bound_lineage_epoch WHERE id=1 AND ${triggerCheck}`, triggerData);
  } catch (error) {
    if (/no such table: fb_(?:bound_lineage_epoch|draw_scope_(?:global_epoch|tenant_epochs|user_epochs))\b/.test(String(error)))
      throw new ApiError(503, "render_lineage_unavailable", "Render source checks are unavailable.");
    throw error;
  }
  if (!draw || !lineage) throw new ApiError(503, "render_lineage_unavailable", "Render source checks are unavailable.");
  // A verified render/review agent has delegated access only to the represented
  // user's current content authority; it never inherits platform root.
  const viewer = delegatedContent && ctx.actor.type === 'agent' ? { ...ctx, scopes: [...(ctx.scopes ?? []), 'content:read'] } : ctx;
  let isPublic = true;
  for (const id of new Set(assetIds)) {
    const audience = await sharedAudience(viewer, id, true, delegatedContent && ctx.actor.type === 'agent');
    if (!audience.allowed) throw new ApiError(409, "render_inputs_changed", "A render source is not available to this account.");
    isPublic &&= audience.public;
  }
  const sql = `EXISTS (SELECT 1 FROM fb_bound_lineage_epoch WHERE id=1 AND revision=?) AND ${triggerCheck}
    AND EXISTS (SELECT 1 FROM fb_draw_scope_global_epoch WHERE id=1 AND revision=?)
    AND COALESCE((SELECT revision FROM fb_draw_scope_tenant_epochs WHERE tenant_id=?),0)=?
    AND COALESCE((SELECT revision FROM fb_draw_scope_user_epochs WHERE user_id=?),0)=? AND ${DRAW_EPOCH_TRIGGER_CHECK}`;
  const args = [lineage.revision,triggerData,draw.global_revision,ctx.tenant.id,draw.tenant_revision,userId,draw.user_revision,DRAW_EPOCH_TRIGGER_DATA];
  if (!await first(ctx.db, `SELECT 1 WHERE ${sql}`, ...args))
    throw new ApiError(409, "render_inputs_changed", "Render source access changed; refresh and retry.");
  return {sql,args,public:isPublic};
}

/** Snapshot installed policy epochs around legacy multi-query authorisation.
 * Older schemas have no such fence; callers must not count that fallback as
 * release qualification. A present but damaged epoch schema fails closed. */
export async function legacyMediaPolicyFence(ctx: Ctx) {
  const userId=ctx.user?.id ?? '';
  const lineageTriggers=JSON.stringify(BOUND_LINEAGE_TRIGGER_DEFINITIONS);
  const lineageCheck=`NOT EXISTS (SELECT 1 FROM json_each(?) e WHERE NOT EXISTS
    (SELECT 1 FROM sqlite_master s WHERE s.type='trigger' AND s.name=json_extract(e.value,'$[0]') AND s.sql=json_extract(e.value,'$[1]')))`;
  let row:{global_revision:number;tenant_revision:number;user_revision:number;lineage_revision:number}|null;
  try {
    row=await first(ctx.db,`SELECT g.revision AS global_revision,
      COALESCE((SELECT revision FROM fb_draw_scope_tenant_epochs WHERE tenant_id=?),0) AS tenant_revision,
      COALESCE((SELECT revision FROM fb_draw_scope_user_epochs WHERE user_id=?),0) AS user_revision,
      l.revision AS lineage_revision FROM fb_draw_scope_global_epoch g CROSS JOIN fb_bound_lineage_epoch l
      WHERE g.id=1 AND l.id=1 AND ${DRAW_EPOCH_TRIGGER_CHECK} AND ${lineageCheck}`,
      ctx.tenant.id,userId,DRAW_EPOCH_TRIGGER_DATA,lineageTriggers);
  } catch (error) {
    if (/no such table: fb_(?:bound_lineage_epoch|draw_scope_(?:global_epoch|tenant_epochs|user_epochs))\b/.test(String(error))) {
      let installed: unknown = null;
      const missingLineage=String(error).includes('fb_bound_lineage_epoch');
      try { installed=await first(ctx.db,missingLineage
        ? "SELECT 1 FROM d1_migrations WHERE name='0035_version_bound_renders.sql' LIMIT 1"
        : "SELECT 1 FROM d1_migrations WHERE name IN ('0033_draw_scope_epochs.sql','0035_version_bound_renders.sql') LIMIT 1"); }
      catch (migrationError) {
        if (!/no such table: d1_migrations\b/.test(String(migrationError))) throw migrationError;
      }
      if (installed) throw new ApiError(503,'media_policy_unavailable','Media access checks are unavailable.');
      return null;
    }
    throw error;
  }
  if (!row || ![row.global_revision,row.tenant_revision,row.user_revision,row.lineage_revision].every(value => Number.isSafeInteger(value) && value >= 0))
    throw new ApiError(503,'media_policy_unavailable','Media access checks are unavailable.');
  return {sql:`EXISTS (SELECT 1 FROM fb_draw_scope_global_epoch WHERE id=1 AND revision=?)
    AND COALESCE((SELECT revision FROM fb_draw_scope_tenant_epochs WHERE tenant_id=?),0)=?
    AND COALESCE((SELECT revision FROM fb_draw_scope_user_epochs WHERE user_id=?),0)=?
    AND EXISTS (SELECT 1 FROM fb_bound_lineage_epoch WHERE id=1 AND revision=?)
    AND ${DRAW_EPOCH_TRIGGER_CHECK} AND ${lineageCheck}`,
    args:[row.global_revision,ctx.tenant.id,row.tenant_revision,userId,row.user_revision,row.lineage_revision,DRAW_EPOCH_TRIGGER_DATA,lineageTriggers]};
}

/** Bind the identity used for a member media decision in the final SELECT. */
export function mediaPrincipalFence(ctx: Ctx) {
  if (!ctx.user) return {sql:'1',args:[] as unknown[]};
  const user=ctx.user.id;
  const access=ctx.sessionAssurance==='access' && ctx.accessStatus==='linked' ? ctx.accessIdentity : null;
  return {sql:`EXISTS (SELECT 1 FROM fb_memberships m JOIN fb_users u ON u.id=m.user_id AND u.disabled_at IS NULL
    WHERE m.tenant_id=? AND m.user_id=? AND m.status='active' AND m.revoked_at IS NULL AND (
    (?='user' AND ?=? AND ?=? AND (
      EXISTS (SELECT 1 FROM fb_sessions s WHERE s.id=? AND s.user_id=u.id AND s.tenant_id=m.tenant_id AND s.revoked_at IS NULL AND s.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      OR (?='access' AND ?>unixepoch('now') AND EXISTS (SELECT 1 FROM fb_access_identities ai WHERE ai.user_id=u.id AND ai.team_domain=? AND ai.subject=? AND ai.email=? AND ai.revoked_at IS NULL) AND u.email=? COLLATE NOCASE)
      OR EXISTS (SELECT 1 FROM fb_discord_identities di WHERE di.tenant_id=m.tenant_id AND di.user_id=u.id AND di.discord_user_id=? AND di.revoked_at IS NULL)))
    OR (?='agent' AND ?=? AND EXISTS (SELECT 1 FROM fb_agent_tokens t JOIN fb_agent_grants ag ON ag.id=t.grant_id
      WHERE t.id=? AND t.token_hash=? AND t.token_hash<>'' AND t.revoked_at IS NULL AND ag.id=? AND ag.agent_id=? AND ag.represented_user_id=u.id
        AND ag.tenant_id=m.tenant_id AND ag.status='active' AND ag.revoked_at IS NULL AND ag.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
        AND json_type(CASE WHEN json_valid(ag.scopes_json) THEN ag.scopes_json ELSE 'null' END)='array'
        AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(ag.scopes_json) THEN ag.scopes_json ELSE '[]' END) WHERE type<>'text')
        AND json(ag.scopes_json)=json(?)))))`,args:[ctx.tenant.id,user,ctx.actor.type,ctx.actor.id,user,ctx.actor.representedUserId,user,ctx.sessionId,ctx.sessionAssurance,access?.payload.exp ?? 0,
      ctx.config.access.teamDomain,access?.subject ?? '',access?.email ?? '',access?.email ?? '',ctx.discordPrincipal?.discordUserId ?? '',ctx.actor.type,ctx.actor.representedUserId,user,
      ctx.agentCredential?.tokenId ?? '',ctx.agentCredential?.verifiedTokenHash ?? '',ctx.agentCredential?.grantId ?? '',ctx.actor.id,JSON.stringify(ctx.scopes ?? [])]};
}

async function boundMediaLineage(ctx: Ctx, assetId: string) {
  try { return await boundLineageFence(ctx,[assetId],false); }
  catch (error) { if (error instanceof ApiError) return null; throw error; }
}

function notFound(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

async function renderBytes(ctx: Ctx, media: R2Bucket, row: {asset_id:string;r2_key:string;sha256:string;bytes:number;mime:string}): Promise<ArrayBuffer | null> {
  if (!row.r2_key.startsWith('bound-render-stage-v1/')) {
    const object=await media.get(row.r2_key);
    return object ? object.arrayBuffer() : null;
  }
  const asset=await first<AssetRow>(ctx.db,`SELECT * FROM fb_assets WHERE id=? AND r2_key=? AND sha256=? AND bytes=? AND mime=? AND archived_at IS NULL AND processing_state='ready'`,
    row.asset_id,row.r2_key,row.sha256,row.bytes,row.mime);
  if (!asset) return null;
  try { return await readAsset(media,asset,ctx.db); }
  catch (error) {
    if (error instanceof ApiError && ['asset_missing','render_input_changed'].includes(error.code)) return null;
    throw error;
  }
}

export async function renderResponse(
  ctx: Ctx,
  media: R2Bucket,
  assetId: string,
  options: { publicOnly: boolean; request: Request },
): Promise<Response> {
  const row = await renderRow(ctx, assetId);
  if (!row || row.render_status !== "published" || row.processing_state !== "ready" || row.r2_key.startsWith('collection-brand-v1/')) return notFound();
  const bound = row.r2_key.startsWith('bound-render-stage-v1/');
  const lineage = bound ? await boundMediaLineage(ctx,assetId) : null;
  if (bound && !lineage) return notFound();
  const legacyPolicy=bound ? null : await legacyMediaPolicyFence(ctx);
  const audience = lineage ? {allowed:true,public:lineage.public} : await sharedAudience(ctx, assetId);
  if (!audience.allowed || (options.publicOnly && (!audience.public || row.access_classification !== "public"))) return notFound();
  const bytes = await renderBytes(ctx,media,row);
  if (!bytes) return notFound();
  const currentAudience = lineage ? audience : await sharedAudience(ctx, assetId);
  if (!currentAudience.allowed || (options.publicOnly && (!currentAudience.public || row.access_classification !== 'public'))) return notFound();
  if (lineage) {
    const principal=mediaPrincipalFence(ctx);
    const current=await first(ctx.db,`SELECT 1 FROM fb_variant_renders vr JOIN fb_assets a ON a.id=vr.asset_id AND a.tenant_id=vr.tenant_id
      JOIN fb_bound_render_outputs p ON p.asset_id=a.id AND p.tenant_id=a.tenant_id
      WHERE vr.asset_id=? AND vr.status='published' AND a.r2_key=? AND a.sha256=? AND a.bytes=? AND a.mime=? AND a.access_classification=?
        AND a.processing_state='ready' AND a.archived_at IS NULL AND p.r2_key=a.r2_key AND p.content_sha256=a.sha256 AND p.bytes=a.bytes AND p.mime=a.mime
        AND ${lineage.sql} AND ${principal.sql}`,
      assetId,row.r2_key,row.sha256,row.bytes,row.mime,row.access_classification,...lineage.args,...principal.args);
    if (!current) return notFound();
  } else {
    const principal=mediaPrincipalFence(ctx);
    const current=await first(ctx.db,`SELECT 1 FROM fb_variant_renders vr JOIN fb_assets a ON a.id=vr.asset_id AND a.tenant_id=vr.tenant_id
      WHERE vr.asset_id=? AND vr.status='published' AND a.r2_key=? AND a.sha256=? AND a.bytes=? AND a.mime=? AND a.access_classification=?
        AND a.processing_state='ready' AND a.archived_at IS NULL AND ${principal.sql} AND ${legacyPolicy?.sql ?? '1'}`,
      assetId,row.r2_key,row.sha256,row.bytes,row.mime,row.access_classification,...principal.args,...(legacyPolicy?.args ?? []));
    if (!current) return notFound();
  }
  const isPublic = currentAudience.public && row.access_classification === "public";
  const etag = `"${row.sha256.slice(0, 32)}"`;
  if (options.request.headers.get("if-none-match") === etag) {
    return new Response(null, {
      status: 304,
      headers: {
        etag,
        "cache-control": isPublic ? "public, max-age=31536000, immutable" : "private, no-store",
        vary: "cookie",
      },
    });
  }
  return new Response(bytes, {
    headers: {
      "content-type": row.mime,
      "content-length": String(row.bytes),
      "cache-control": isPublic ? "public, max-age=31536000, immutable" : "private, no-store",
      vary: "cookie",
      etag,
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "same-origin",
    },
  });
}

export const renderGET: APIRoute = async ({ request, params }) => {
  const ctx = await buildContext(request);
  const media = (ctx as unknown as { media: R2Bucket }).media;
  return renderResponse(ctx, media, params.id ?? "", { publicOnly: false, request });
};

export const backRenderGET: APIRoute = async ({ request, params }) => {
  const ctx = await buildContext(request);
  return backRenderResponse(ctx, params.id ?? "");
};

export async function backRenderResponse(ctx: Ctx, assetId: string): Promise<Response> {
  const row = await first<{
    asset_id: string; r2_key: string; mime: string; bytes: number; sha256: string; card_id: string; access_classification: string;
  }>(
    ctx.db,
    `SELECT br.asset_id, a.r2_key, a.mime, a.bytes, a.sha256, v.card_id, a.access_classification
       FROM fb_variant_back_renders br
       JOIN fb_assets a ON a.id = br.asset_id AND a.tenant_id = br.tenant_id
       JOIN fb_variants v ON v.id = br.variant_id AND v.tenant_id = br.tenant_id
      WHERE br.asset_id = ? AND br.status = 'published' AND a.processing_state = 'ready' AND a.archived_at IS NULL`,
    assetId,
  );
  if (!row || row.r2_key.startsWith('collection-brand-v1/')) return notFound();
  const bound=row.r2_key.startsWith('bound-render-stage-v1/');
  const lineage=bound ? await boundMediaLineage(ctx,assetId) : null;
  if (bound && !lineage) return notFound();
  const legacyPolicy=bound ? null : await legacyMediaPolicyFence(ctx);
  const audience=lineage ? {allowed:true,public:lineage.public} : await sharedAudience(ctx,assetId);
  if (!audience.allowed) return notFound();
  const bytes = await renderBytes(ctx,ctx.media,row);
  if (!bytes) return notFound();
  const currentAudience=lineage ? audience : await sharedAudience(ctx,assetId);
  if (!currentAudience.allowed) return notFound();
  if (lineage) {
    const principal=mediaPrincipalFence(ctx);
    const current=await first(ctx.db,`SELECT 1 FROM fb_variant_back_renders br JOIN fb_assets a ON a.id=br.asset_id AND a.tenant_id=br.tenant_id
      JOIN fb_bound_render_outputs p ON p.asset_id=a.id AND p.tenant_id=a.tenant_id
      WHERE br.asset_id=? AND br.status='published' AND a.r2_key=? AND a.sha256=? AND a.bytes=? AND a.mime=? AND a.access_classification=?
        AND a.processing_state='ready' AND a.archived_at IS NULL AND p.r2_key=a.r2_key AND p.content_sha256=a.sha256 AND p.bytes=a.bytes AND p.mime=a.mime
        AND ${lineage.sql} AND ${principal.sql}`,
      assetId,row.r2_key,row.sha256,row.bytes,row.mime,row.access_classification,...lineage.args,...principal.args);
    if (!current) return notFound();
  } else {
    const principal=mediaPrincipalFence(ctx);
    const current=await first(ctx.db,`SELECT 1 FROM fb_variant_back_renders br JOIN fb_assets a ON a.id=br.asset_id AND a.tenant_id=br.tenant_id
      WHERE br.asset_id=? AND br.status='published' AND a.r2_key=? AND a.sha256=? AND a.bytes=? AND a.mime=? AND a.access_classification=?
        AND a.processing_state='ready' AND a.archived_at IS NULL AND ${principal.sql} AND ${legacyPolicy?.sql ?? '1'}`,
      assetId,row.r2_key,row.sha256,row.bytes,row.mime,row.access_classification,...principal.args,...(legacyPolicy?.args ?? []));
    if (!current) return notFound();
  }
  const isPublic = currentAudience.public && row.access_classification === "public";
  return new Response(bytes, {
    headers: {
      "content-type": row.mime,
      "content-length": String(row.bytes),
      "cache-control": isPublic ? "public, max-age=31536000, immutable" : "private, no-store",
      vary: "cookie",
      etag: `"${row.sha256.slice(0, 32)}"`,
      "x-content-type-options": "nosniff",
    },
  });
}

export const publicRenderGET: APIRoute = async ({ request, params }) => {
  const ctx = await buildContext(request);
  const media = (ctx as unknown as { media: R2Bucket }).media;
  return renderResponse(ctx, media, params.id ?? "", { publicOnly: true, request });
};

export async function derivativeResponse(ctx: Ctx, media: R2Bucket, derivativeId: string, request: Request): Promise<Response> {
  const row = await first<{
    id: string;
    r2_key: string;
    mime: string;
    bytes: number;
    sha256: string;
    source_asset_id: string;
    source_r2_key: string;
    card_id: string;
    access_classification: string;
  }>(
    ctx.db,
    `SELECT d.id, d.r2_key, d.mime, d.bytes, d.sha256, d.source_asset_id, a.r2_key AS source_r2_key, v.card_id, a.access_classification
       FROM fb_asset_derivatives d
       JOIN fb_assets a ON a.id = d.source_asset_id AND a.tenant_id = d.tenant_id
       JOIN fb_variant_renders vr ON vr.asset_id = d.source_asset_id AND vr.tenant_id = d.tenant_id
       JOIN fb_variants v ON v.id = vr.variant_id AND v.tenant_id = vr.tenant_id
      WHERE d.id = ? AND d.status = 'ready' AND vr.status = 'published' AND a.processing_state = 'ready' AND a.archived_at IS NULL`,
    derivativeId,
  );
  if (!row || row.source_r2_key.startsWith('collection-brand-v1/') || row.r2_key.startsWith('collection-brand-v1/') || row.r2_key.startsWith('bound-render-stage-v1/')) return notFound();
  const bound=row.source_r2_key.startsWith('bound-render-stage-v1/');
  const lineage=bound ? await boundMediaLineage(ctx,row.source_asset_id) : null;
  if (bound && !lineage) return notFound();
  const legacyPolicy=bound ? null : await legacyMediaPolicyFence(ctx);
  const audience=lineage ? {allowed:true,public:lineage.public} : await sharedAudience(ctx,row.source_asset_id);
  if (!audience.allowed) return notFound();
  let bytes:ArrayBuffer;
  let finalAudience=audience;
  if (row.source_r2_key.startsWith('bound-render-stage-v1/')) {
    if (!row.r2_key.startsWith('bound-render-derivative-v1/')) return notFound();
    const pin=await first<{object_version:string;object_etag:string;content_sha256:string;bytes:number}>(ctx.db,`SELECT object_version,object_etag,content_sha256,bytes FROM fb_bound_render_derivatives
      WHERE derivative_id=? AND source_asset_id=? AND r2_key=? AND content_sha256=? AND bytes=?`,row.id,row.source_asset_id,row.r2_key,row.sha256,row.bytes);
    const source=await first<AssetRow>(ctx.db,`SELECT * FROM fb_assets WHERE id=? AND r2_key=? AND archived_at IS NULL AND processing_state='ready'`,row.source_asset_id,row.source_r2_key);
    if (!pin || !source) return notFound();
    try {
      await readAsset(media,source,ctx.db);
      const verified=await readVerifiedRenderInput(media,{key:row.r2_key,version:pin.object_version,etag:pin.object_etag,sha256:pin.content_sha256,bytes:pin.bytes});
      bytes=verified.slice().buffer;
    } catch(error) {
      if(error instanceof ApiError && ['asset_missing','render_input_changed'].includes(error.code)) return notFound();
      throw error;
    }
    if (!lineage) return notFound();
    const principal=mediaPrincipalFence(ctx);
    const current=await first(ctx.db,`SELECT 1 FROM fb_asset_derivatives d JOIN fb_bound_render_derivatives p ON p.derivative_id=d.id AND p.tenant_id=d.tenant_id
      JOIN fb_variant_renders vr ON vr.asset_id=d.source_asset_id AND vr.tenant_id=d.tenant_id AND vr.status='published'
      JOIN fb_assets a ON a.id=d.source_asset_id AND a.tenant_id=d.tenant_id
      JOIN fb_bound_render_outputs output ON output.asset_id=a.id AND output.tenant_id=a.tenant_id
      WHERE d.id=? AND d.status='ready' AND d.r2_key=? AND d.sha256=? AND d.bytes=? AND d.mime=? AND d.source_asset_id=?
       AND p.r2_key=d.r2_key AND p.content_sha256=d.sha256 AND p.bytes=d.bytes AND p.object_version=? AND p.object_etag=?
       AND a.r2_key=? AND a.sha256=? AND a.bytes=? AND a.mime=? AND a.access_classification=? AND a.processing_state='ready' AND a.archived_at IS NULL
       AND output.r2_key=a.r2_key AND output.content_sha256=a.sha256 AND output.bytes=a.bytes AND output.mime=a.mime
       AND ${lineage.sql} AND ${principal.sql}`,
      row.id,row.r2_key,row.sha256,row.bytes,row.mime,row.source_asset_id,pin.object_version,pin.object_etag,
      source.r2_key,source.sha256,source.bytes,source.mime,row.access_classification,...lineage.args,...principal.args);
    if(!current) return notFound();
  } else {
    if (row.r2_key.startsWith('bound-render-derivative-v1/')) return notFound();
    const object=await media.get(row.r2_key);
    if (!object) return notFound();
    bytes=await object.arrayBuffer();
    finalAudience=await sharedAudience(ctx,row.source_asset_id);
    if (!finalAudience.allowed) return notFound();
    const principal=mediaPrincipalFence(ctx);
    const current=await first(ctx.db,`SELECT 1 FROM fb_asset_derivatives d JOIN fb_assets a ON a.id=d.source_asset_id AND a.tenant_id=d.tenant_id
      JOIN fb_variant_renders vr ON vr.asset_id=a.id AND vr.tenant_id=a.tenant_id AND vr.status='published'
      WHERE d.id=? AND d.status='ready' AND d.r2_key=? AND d.sha256=? AND d.bytes=? AND d.mime=? AND d.source_asset_id=?
        AND a.r2_key=? AND a.access_classification=? AND a.processing_state='ready' AND a.archived_at IS NULL AND ${principal.sql} AND ${legacyPolicy?.sql ?? '1'}`,
      row.id,row.r2_key,row.sha256,row.bytes,row.mime,row.source_asset_id,row.source_r2_key,row.access_classification,...principal.args,...(legacyPolicy?.args ?? []));
    if (!current) return notFound();
  }
  const isPublic = finalAudience.public && row.access_classification === "public";
  return new Response(bytes, {
    headers: {
      "content-type": row.mime,
      "content-length": String(row.bytes),
      "cache-control": isPublic ? "public, max-age=31536000, immutable" : "private, no-store",
      vary: "cookie",
      etag: `"${row.sha256.slice(0, 32)}"`,
      "x-content-type-options": "nosniff",
    },
  });
}
