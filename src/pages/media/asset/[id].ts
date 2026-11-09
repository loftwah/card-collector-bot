import type { APIRoute } from "astro";
import { ApiError, buildContext, type Ctx } from "../../../server/context";
import { getAsset, readAsset, type AssetRow } from "../../../server/modules/assets";
import { all, first, nowIso } from "../../../server/db";
import { canViewCard, canViewCollection, effectiveCardAudience } from "../../../server/modules/visibility";
import { collectionWriteGuard, legacyBrandUrlFence } from "../../../server/modules/collections";
import { legacyMediaPolicyFence, mediaPrincipalFence } from "../../../server/modules/media";

export const prerender = false;

export const GET: APIRoute = async ({ request, params }) => {
  const ctx = await buildContext(request);
  return serveAsset(ctx, params.id ?? "");
};

export async function serveAsset(ctx: Ctx, id: string): Promise<Response> {
  try {
    return await serveAssetAvailable(ctx, id);
  } catch (error) {
    if (error instanceof ApiError && ["asset_missing", "asset_not_found", "render_input_changed"].includes(error.code)) {
      return new Response("Not found", { status: 404, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
    }
    throw error;
  }
}

async function serveAssetAvailable(ctx: Ctx, id: string, validationOnly = false, expected?: AssetRow): Promise<Response> {
  const asset = await getAsset(ctx, id);
  if (expected && (asset.id!==expected.id || asset.tenant_id!==expected.tenant_id || asset.r2_key!==expected.r2_key || asset.sha256!==expected.sha256 ||
    asset.bytes!==expected.bytes || asset.mime!==expected.mime || asset.revision!==expected.revision || asset.access_classification!==expected.access_classification || asset.visibility!==expected.visibility))
    return new Response('Not found',{status:404,headers:{'cache-control':'no-store'}});
  if (asset.processing_state !== "ready" || asset.archived_at) {
    return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  }
  const policy = validationOnly || asset.r2_key.startsWith('collection-brand-v1/') ? null : await legacyMediaPolicyFence(ctx);
  const checkedBytes = async (publicCache: boolean): Promise<ArrayBuffer> => {
    if (validationOnly) return new ArrayBuffer(0);
    const bytes=await readAsset(ctx.media,asset,ctx.db);
    const current=await serveAssetAvailable(ctx,id,true,asset);
    if (!current.ok || (publicCache && !current.headers.get('cache-control')?.startsWith('public,')))
      throw new ApiError(410,'asset_missing','The stored asset is unavailable.');
    const principal=publicCache ? {sql:'1',args:[] as unknown[]} : mediaPrincipalFence(ctx);
    if (!await first(ctx.db,`SELECT 1 WHERE ${principal.sql} AND ${policy?.sql ?? '1'}`,...principal.args,...(policy?.args ?? [])))
      throw new ApiError(410,'asset_missing','The stored asset is unavailable.');
    return bytes;
  };
  // Asset classification is a snapshot. Card and collection audiences can
  // become more restrictive after upload, so check every current use before
  // returning bytes, including reused sources and both saved render sides.
  const cards = await all<{ id: string }>(ctx.db,
    `SELECT DISTINCT card_id AS id FROM fb_artwork_editions WHERE subject_asset_id = ? OR background_asset_id = ?
     UNION SELECT id FROM fb_card_definitions WHERE card_back_asset_id = ?
     UNION SELECT card_id AS id FROM fb_print_proposals WHERE source_asset_id = ? OR artwork_asset_id = ? OR background_asset_id = ?
     UNION SELECT DISTINCT v.card_id AS id FROM fb_variants v JOIN fb_variant_renders r ON r.variant_id = v.id AND r.tenant_id = v.tenant_id WHERE r.asset_id = ?
     UNION SELECT DISTINCT v.card_id AS id FROM fb_variants v JOIN fb_variant_back_renders r ON r.variant_id = v.id AND r.tenant_id = v.tenant_id WHERE r.asset_id = ?`,
    asset.id, asset.id, asset.id, asset.id, asset.id, asset.id, asset.id, asset.id,
  );
  const collections = await all<{ id: string; scope: string; status: string; view_audience: string; public_approved_at: string | null }>(ctx.db,
    "SELECT id, scope, status, view_audience, public_approved_at FROM fb_collections WHERE logo_asset_id = ? OR banner_asset_id = ?",
    asset.id, asset.id,
  );
  let restricted = false;
  const drafts = await first<{ present: number }>(ctx.db,
    "SELECT 1 AS present FROM fb_print_proposals WHERE status <> 'approved' AND (source_asset_id = ? OR artwork_asset_id = ? OR background_asset_id = ?) LIMIT 1",
    asset.id, asset.id, asset.id,
  );
  // Do not trust the session's cached role after a Bot grant or membership is
  // revoked. An explicit Bot Admin grant supersedes legacy membership roles.
  const authority = ctx.user && (ctx.actor.type !== "agent" || ctx.scopes?.includes("content:read"))
    ? await first<{ allowed: number }>(ctx.db, `SELECT EXISTS (
        SELECT 1 FROM fb_memberships m JOIN fb_users u ON u.id = m.user_id
        JOIN fb_bots b ON b.tenant_id = m.tenant_id AND b.status <> 'archived'
        LEFT JOIN fb_bot_admins ba ON ba.bot_id = b.id AND ba.user_id = m.user_id
        WHERE m.tenant_id = ? AND m.user_id = ? AND m.status = 'active' AND m.revoked_at IS NULL AND u.disabled_at IS NULL
          AND (? IS NULL OR EXISTS (SELECT 1 FROM fb_sessions s WHERE s.id = ? AND s.user_id = m.user_id AND s.tenant_id = m.tenant_id AND s.revoked_at IS NULL AND s.expires_at > ?))
          AND ((m.role = 'owner' AND b.owner_user_id = m.user_id)
            OR (u.platform_admin = 1 AND EXISTS (SELECT 1 FROM fb_platform_admins pa WHERE pa.user_id = u.id AND pa.status = 'active' AND pa.revoked_at IS NULL))
            OR (EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(m.capabilities_json) THEN m.capabilities_json ELSE '[]' END) WHERE value = 'content')
              AND (ba.id IS NULL OR (ba.status = 'active' AND ba.revoked_at IS NULL AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(ba.capabilities_json) THEN ba.capabilities_json ELSE '[]' END) WHERE value = 'content')))))
      ) AS allowed`, ctx.tenant.id, ctx.user.id, ctx.sessionId, ctx.sessionId, nowIso())
    : null;
  const editor = Boolean(authority?.allowed);
  const role = !editor && ctx.user && (ctx.actor.type !== "agent" || ctx.scopes?.includes("content:read"))
    ? await first<{ scopes_json: string }>(ctx.db, `SELECT p.scopes_json FROM fb_platform_role_assignments p JOIN fb_users u ON u.id = p.user_id
       WHERE p.user_id = ? AND p.role = 'global_collection_admin' AND p.status = 'active' AND p.revoked_at IS NULL AND u.disabled_at IS NULL
       AND (? IS NULL OR EXISTS (SELECT 1 FROM fb_sessions s WHERE s.id = ? AND s.user_id = u.id AND s.tenant_id = ? AND s.revoked_at IS NULL AND s.expires_at > ?))`,
      ctx.user.id, ctx.sessionId, ctx.sessionId, ctx.tenant.id, nowIso()) : null;
  let scope: { all: boolean; collectionIds: string[] } | null = null;
  if (role) {
    try {
      const value = JSON.parse(role.scopes_json) as { all?: unknown; collectionIds?: unknown };
      if (value.all === true) scope = { all: true, collectionIds: [] };
      else if (value.all === false && Array.isArray(value.collectionIds) && value.collectionIds.length > 0 && value.collectionIds.every(id => typeof id === "string" && id.length > 0))
        scope = { all: false, collectionIds: value.collectionIds as string[] };
    } catch { /* Invalid scopes never grant access. */ }
  }
  let scopedEditor = Boolean(scope && (cards.length || collections.length));
  if (scope && scopedEditor) {
    const within = (c: { id: string; scope: string }) => c.scope === "global" && (scope!.all || scope!.collectionIds.includes(c.id));
    if (!collections.every(within)) scopedEditor = false;
    for (const card of cards) {
      const owners = await all<{ id: string; scope: string }>(ctx.db, "SELECT c.id, c.scope FROM fb_collection_cards cc JOIN fb_collections c ON c.id = cc.collection_id WHERE cc.card_id = ?", card.id);
      if (!owners.length || !owners.every(within)) scopedEditor = false;
    }
  }
  // Visibility helpers also use the cached role for draft/admin shortcuts.
  // Strip those shortcuts when live Bot authority no longer supports them;
  // active membership and explicit viewer grants are still evaluated normally.
  const viewerCtx: Ctx = !editor && ctx.user
    ? { ...ctx, user: { ...ctx.user, role: "player", platformAdmin: false, globalCollectionScope: scopedEditor ? scope : undefined } }
    : ctx;
  if (drafts && !editor && !scopedEditor) return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  if (drafts) restricted = true;
  let hasDependencies = true;
  try {
    const parsed: unknown = JSON.parse(asset.dependencies_json);
    hasDependencies = !Array.isArray(parsed) || parsed.length > 0;
  } catch {
    // Invalid provenance cannot establish a safe audience.
  }
  const dependent = await first<{ present: number }>(ctx.db,
    `SELECT 1 AS present FROM fb_assets a WHERE a.derivative_of_asset_id = ? OR EXISTS (
       SELECT 1 FROM json_each(CASE WHEN json_valid(a.dependencies_json) THEN a.dependencies_json ELSE '[]' END) d WHERE d.value = ?
     ) LIMIT 1`, asset.id, asset.id,
  );
  if (asset.derivative_of_asset_id || hasDependencies || dependent) {
    // Generic provenance graphs are not tied to a rendition-specific audience
    // here, so neither parents nor derivatives may be widened by stale labels.
    if (!editor) return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
    restricted = true;
  }
  for (const card of cards) {
    const state=await first<{status:string;tenant_id:string}>(ctx.db,'SELECT status,tenant_id FROM fb_card_definitions WHERE id=? AND archived_at IS NULL',card.id);
    if (!state || (state.status!=='published' && !(editor && state.tenant_id===ctx.tenant.id) && !scopedEditor))
      return new Response('Not found',{status:404,headers:{'cache-control':'no-store'}});
    if (!(await canViewCard(viewerCtx, card.id, { liveContentAdmin: true }))) return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
    if ((await effectiveCardAudience(ctx, card.id)) !== "public") restricted = true;
  }
  for (const collection of collections) {
    if (!(await canViewCollection(viewerCtx, collection.id, { liveContentAdmin: true }))) return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
    if (collection.status !== "published" || collection.view_audience !== "public" || !collection.public_approved_at) restricted = true;
  }
  if (asset.r2_key.startsWith('collection-brand-v1/')) {
    let legacy:Awaited<ReturnType<typeof legacyBrandUrlFence>>;
    try { legacy=await legacyBrandUrlFence(ctx,asset.id); }
    catch { return new Response('Not found',{status:404,headers:{'cache-control':'no-store'}}); }
    const brandPin=await first<{object_version:string;object_etag:string;content_sha256:string}>(ctx.db,`SELECT object_version,object_etag,content_sha256 FROM fb_collection_brand_uploads WHERE tenant_id=? AND asset_id=? AND r2_key=? AND status='completed'`,asset.tenant_id,asset.id,asset.r2_key);
    if (!brandPin?.object_version || !brandPin.object_etag || brandPin.content_sha256!==asset.sha256) return new Response('Not found',{status:404,headers:{'cache-control':'no-store'}});
    const privatePreview=async()=>{
      if (!ctx.user || cards.length || collections.length>1) return false;
      const choices: Array<'global'|'bot'>=collections.length ? [collections[0]!.scope as 'global'|'bot'] : ['global','bot'];
      for (const candidate of choices) {
        if (candidate!=='global' && candidate!=='bot') continue;
        const guard=collectionWriteGuard(ctx,candidate,collections[0]?.id ?? null,false);
        const valid=await first<{ok:number}>(ctx.db,`WITH x AS (SELECT ? AS asset_id, ? AS collection_id) SELECT 1 AS ok FROM x WHERE ${guard.sql}
          AND (x.collection_id IS NULL OR EXISTS (SELECT 1 FROM fb_collections c WHERE c.id=x.collection_id AND c.scope=?
            AND (c.scope<>'bot' OR c.owner_tenant_id=?) AND (c.logo_asset_id=x.asset_id OR c.banner_asset_id=x.asset_id)))
          AND NOT EXISTS (SELECT 1 FROM fb_collections c WHERE c.id IS NOT x.collection_id AND (c.logo_asset_id=x.asset_id OR c.banner_asset_id=x.asset_id))
          AND ${legacy.sql}
          AND NOT EXISTS (SELECT 1 FROM fb_artwork_editions e WHERE e.subject_asset_id=x.asset_id OR e.background_asset_id=x.asset_id)
          AND NOT EXISTS (SELECT 1 FROM fb_card_definitions d WHERE d.card_back_asset_id=x.asset_id)
          AND NOT EXISTS (SELECT 1 FROM fb_print_proposals p WHERE p.source_asset_id=x.asset_id OR p.artwork_asset_id=x.asset_id OR p.background_asset_id=x.asset_id)
          AND NOT EXISTS (SELECT 1 FROM fb_variant_renders v WHERE v.asset_id=x.asset_id)
          AND NOT EXISTS (SELECT 1 FROM fb_variant_back_renders v WHERE v.asset_id=x.asset_id)
          AND EXISTS (SELECT 1 FROM fb_assets a WHERE a.id=x.asset_id AND a.tenant_id=? AND a.archived_at IS NULL
            AND a.r2_key=? AND a.sha256=? AND a.revision=? AND a.bytes=? AND a.mime=? AND a.derivative_of_asset_id IS NULL
            AND json_valid(a.dependencies_json) AND json_type(a.dependencies_json)='array' AND json_array_length(a.dependencies_json)=0
            AND EXISTS (SELECT 1 FROM fb_collection_brand_uploads p WHERE p.asset_id=a.id AND p.tenant_id=a.tenant_id AND p.r2_key=a.r2_key AND p.status='completed' AND p.object_version=? AND p.object_etag=? AND p.content_sha256=a.sha256))
          AND NOT EXISTS (SELECT 1 FROM fb_assets a WHERE a.derivative_of_asset_id=x.asset_id OR EXISTS
            (SELECT 1 FROM json_each(CASE WHEN json_valid(a.dependencies_json) THEN a.dependencies_json ELSE '[]' END) d WHERE d.value=x.asset_id))`,
          asset.id,collections[0]?.id ?? null,...guard.args,candidate,ctx.tenant.id,...legacy.args,asset.tenant_id,asset.r2_key,asset.sha256,asset.revision,asset.bytes,asset.mime,brandPin.object_version,brandPin.object_etag);
        if (valid) return true;
      }
      return false;
    };
    const authorisedRelease=()=>first<{present:number}>(ctx.db,`SELECT 1 AS present FROM fb_collection_brand_releases r
      JOIN fb_collections c ON c.id=r.collection_id AND c.release_version=r.collection_version
      JOIN fb_collection_brand_uploads p ON p.asset_id=r.asset_id AND p.tenant_id=r.tenant_id AND p.status='completed'
      WHERE r.tenant_id=? AND r.asset_id=? AND c.id=? AND c.scope='global' AND c.status='published' AND c.archived_at IS NULL
        AND c.view_audience='public' AND c.public_approved_at IS NOT NULL AND ((r.role='logo' AND c.logo_asset_id=r.asset_id) OR (r.role='cover' AND c.banner_asset_id=r.asset_id))
        AND p.r2_key=? AND p.object_version=r.object_version AND p.object_version=? AND p.object_etag=? AND p.content_sha256=r.content_sha256 AND r.content_sha256=?
        AND NOT EXISTS (SELECT 1 FROM fb_collections other WHERE other.id<>c.id AND (other.logo_asset_id=r.asset_id OR other.banner_asset_id=r.asset_id))
        AND ${legacy.sql}
        AND NOT EXISTS (SELECT 1 FROM fb_artwork_editions e WHERE e.subject_asset_id=r.asset_id OR e.background_asset_id=r.asset_id)
        AND NOT EXISTS (SELECT 1 FROM fb_card_definitions d WHERE d.card_back_asset_id=r.asset_id)
        AND NOT EXISTS (SELECT 1 FROM fb_print_proposals q WHERE q.source_asset_id=r.asset_id OR q.artwork_asset_id=r.asset_id OR q.background_asset_id=r.asset_id)
        AND NOT EXISTS (SELECT 1 FROM fb_variant_renders v WHERE v.asset_id=r.asset_id)
        AND NOT EXISTS (SELECT 1 FROM fb_variant_back_renders v WHERE v.asset_id=r.asset_id)
        AND EXISTS (SELECT 1 FROM fb_assets a WHERE a.id=r.asset_id AND a.tenant_id=r.tenant_id AND a.archived_at IS NULL AND a.derivative_of_asset_id IS NULL
          AND a.revision=r.asset_revision AND a.r2_key=p.r2_key AND a.sha256=r.content_sha256 AND a.mime=r.mime AND a.bytes=r.bytes AND a.role=r.role AND a.processing_state='ready'
          AND json_valid(a.dependencies_json) AND json_type(a.dependencies_json)='array' AND json_array_length(a.dependencies_json)=0)
        AND NOT EXISTS (SELECT 1 FROM fb_assets a WHERE a.derivative_of_asset_id=r.asset_id OR EXISTS
          (SELECT 1 FROM json_each(CASE WHEN json_valid(a.dependencies_json) THEN a.dependencies_json ELSE '[]' END) d WHERE d.value=r.asset_id)) LIMIT 1`,
      asset.tenant_id,asset.id,collections[0]?.id ?? '',asset.r2_key,brandPin.object_version,brandPin.object_etag,asset.sha256,...legacy.args);
    const preview=(editor || scopedEditor) && await privatePreview();
    if (!preview) {
      if (cards.length || collections.length!==1) return new Response('Not found',{status:404,headers:{'cache-control':'no-store'}});
      if (!await authorisedRelease()) return new Response('Not found',{status:404,headers:{'cache-control':'no-store'}});
    }
    const bytes=await readAsset(ctx.media,asset,ctx.db);
    if (preview ? !await privatePreview() : !await authorisedRelease()) return new Response('Not found',{status:404,headers:{'cache-control':'no-store'}});
    return new Response(bytes,{headers:{'content-type':asset.mime,'cache-control':'no-store','x-content-type-options':'nosniff','cross-origin-resource-policy':'same-origin'}});
  }
  if (scopedEditor) {
    // Recheck the exact assignment after resolving all uses. Never cache a
    // privileged preview and do not widen access after revocation or rescope.
    const current = await first<{ present: number }>(ctx.db, "SELECT 1 AS present FROM fb_platform_role_assignments WHERE user_id = ? AND role = 'global_collection_admin' AND status = 'active' AND revoked_at IS NULL AND scopes_json = ?", ctx.user!.id, role!.scopes_json);
    if (!current) return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
    const bytes = await checkedBytes(false);
    return new Response(bytes, { headers: { "content-type": asset.mime, "cache-control": "private, no-store", vary: "cookie", "x-content-type-options": "nosniff" } });
  }
  if (!cards.length && !collections.length && ["render", "subject", "background"].includes(asset.kind)) {
    // An unlinked asset has no card audience to authorise. Editors may inspect
    // their own drafts; it is never treated as public from a stale label.
    if (!editor)
      return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
    restricted = true;
  }
  if (restricted && asset.access_classification === "public") {
    const bytes = await checkedBytes(false);
    return new Response(bytes, { headers: { "content-type": asset.mime, "cache-control": "private, no-store", vary: "cookie", "x-content-type-options": "nosniff" } });
  }
  if (asset.access_classification === "public") {
    const bytes = await checkedBytes(true);
    return new Response(bytes, {
      headers: {
        "content-type": asset.mime,
        "cache-control": "public, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
        "cross-origin-resource-policy": "same-origin",
      },
    });
  }
  if (!ctx.user) return new Response("Authentication required", { status: 401, headers: { "cache-control": "no-store" } });
  if (asset.access_classification === "member") {
    const member = await first<{ present: number }>(
      ctx.db,
      "SELECT 1 AS present FROM fb_memberships WHERE user_id = ? AND tenant_id = ? AND status = 'active' AND revoked_at IS NULL LIMIT 1",
      ctx.user.id,
      asset.tenant_id,
    );
    if (!member) return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
    const bytes = await checkedBytes(false);
    return new Response(bytes, {
      headers: {
        "content-type": asset.mime,
        "cache-control": "private, no-store",
        vary: "cookie",
        "x-content-type-options": "nosniff",
      },
    });
  }
  if (asset.visibility !== "private" && asset.access_classification === "private") {
    return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  }
  const privileged = editor;
  const owned = privileged
    ? true
    : Boolean(
        await first<{ present: number }>(
          ctx.db,
          `SELECT 1 AS present FROM fb_card_instances ci
             JOIN fb_variants v ON v.id = ci.variant_id
             JOIN fb_artwork_editions e ON e.id = v.edition_id
            WHERE ci.tenant_id = ? AND ci.user_id = ? AND ci.status IN ('owned','reserved')
              AND (e.subject_asset_id = ? OR e.background_asset_id = ?) LIMIT 1`,
          ctx.tenant.id,
          ctx.user.id,
          asset.id,
          asset.id,
        ),
      );
  const managed = privileged
    ? true
    : Boolean(
        await first<{ present: number }>(
          ctx.db,
          `SELECT 1 AS present FROM fb_collection_cards cc
             JOIN fb_collections c ON c.id = cc.collection_id
            WHERE (c.logo_asset_id = ? OR c.banner_asset_id = ?)
              AND (c.owner_tenant_id = ? OR (c.scope = 'global' AND c.view_audience <> 'private')) LIMIT 1`,
          asset.id,
          asset.id,
          ctx.tenant.id,
        ),
      );
  if (!owned && !managed) return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  const bytes = await checkedBytes(false);
  return new Response(bytes, {
    headers: {
      "content-type": asset.mime,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
