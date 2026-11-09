import { ApiError, type Ctx } from "../context";
import { all, first, nowIso } from "../db";
import { newId } from "../ids";
import { normalizeCardName } from "./card-name-aliases";
import { DRAW_EPOCH_TRIGGER_CHECK, DRAW_EPOCH_TRIGGER_DATA, type DrawInstallationSnapshot, type DrawScopeEpoch } from './draw-scope-epoch';

export interface InventoryRow {
  id: string;
  card_id: string;
  variant_id: string;
  card_name: string;
  card_slug: string;
  subtitle: string | null;
  description: string;
  bio: string | null;
  bio_safe: string | null;
  spoiler_level: number;
  attributes_json: string;
  source_work: string | null;
  review_status: string;
  quote: string | null;
  collection_name: string | null;
  collection_logo: string | null;
  collection_description: string | null;
  variant_name: string;
  material_key: string;
  effect_key: string | null;
  rarity_key: string | null;
  rarity_name: string | null;
  rarity_tone: string | null;
  class_name: string | null;
  category_name: string | null;
  serial: string;
  status: string;
  favourite: number;
  locked: number;
  acquired_via: string;
  acquired_at: string;
  render_url: string | null;
  thumbnail_url: string | null;
  back_render_url: string | null;
  edition_id: string;
  edition_name: string;
  composition_json: string | null;
  subject_asset_id: string;
  subject_origin: string;
  background_asset_id: string | null;
  subject_width: number | null;
  subject_height: number | null;
}

const INVENTORY_SELECT = `SELECT ci.id, ci.card_id, ci.variant_id, cd.name AS card_name, cd.slug AS card_slug,
  cd.subtitle, cd.description, cd.bio, cd.bio_safe, cd.spoiler_level, cd.attributes_json, cd.source_work, cd.review_status, cd.quote,
  (SELECT c.name FROM fb_collection_cards cc JOIN fb_collections c ON c.id = cc.collection_id WHERE cc.card_id = cd.id ORDER BY CASE c.scope WHEN 'global' THEN 0 ELSE 1 END LIMIT 1) AS collection_name,
  (SELECT c.logo_url FROM fb_collection_cards cc JOIN fb_collections c ON c.id = cc.collection_id WHERE cc.card_id = cd.id ORDER BY CASE c.scope WHEN 'global' THEN 0 ELSE 1 END LIMIT 1) AS collection_logo,
  (SELECT c.description FROM fb_collection_cards cc JOIN fb_collections c ON c.id = cc.collection_id WHERE cc.card_id = cd.id ORDER BY CASE c.scope WHEN 'global' THEN 0 ELSE 1 END LIMIT 1) AS collection_description,
  v.name AS variant_name, m.key AS material_key, fx.key AS effect_key,
  rar.key AS rarity_key, rar.name AS rarity_name, rar.tone AS rarity_tone,
  cls.name AS class_name, cat.name AS category_name, ci.serial, ci.status, ci.favourite, ci.locked,
  ci.acquired_via, ci.acquired_at, cd.status AS card_status, ('/media/render/' || vr.asset_id) AS render_url,
  ('/media/back/' || br.asset_id) AS back_render_url,
  (SELECT '/media/derivative/' || d.id FROM fb_asset_derivatives d WHERE d.tenant_id = vr.tenant_id AND d.source_asset_id = vr.asset_id AND d.size_key = 'thumb' AND d.status = 'ready' LIMIT 1) AS thumbnail_url,
  v.edition_id, e.name AS edition_name, e.subject_asset_id, sa.origin AS subject_origin, e.background_asset_id, e.composition_json, sa.width AS subject_width, sa.height AS subject_height
  FROM fb_card_instances ci
  JOIN fb_card_definitions cd ON cd.id = ci.card_id
  JOIN fb_variants v ON v.id = ci.variant_id
  JOIN fb_artwork_editions e ON e.id = v.edition_id AND e.tenant_id = v.tenant_id
  JOIN fb_assets sa ON sa.id = e.subject_asset_id AND sa.tenant_id = e.tenant_id
  LEFT JOIN fb_assets ba ON ba.id = e.background_asset_id AND ba.tenant_id = e.tenant_id
  JOIN fb_materials m ON m.id = v.material_id
  LEFT JOIN fb_effects fx ON fx.id = v.effect_id
  LEFT JOIN fb_rarities rar ON rar.id = cd.rarity_id
  LEFT JOIN fb_classes cls ON cls.id = cd.class_id
  LEFT JOIN fb_categories cat ON cat.id = cd.category_id
  LEFT JOIN fb_variant_renders vr ON vr.variant_id = v.id AND vr.tenant_id = v.tenant_id AND vr.status = 'published'
  LEFT JOIN fb_variant_back_renders br ON br.variant_id = v.id AND br.tenant_id = v.tenant_id AND br.status = 'published'`;

interface InventoryQuery {
  status?: string;
  search?: string;
  favourite?: boolean;
  setSlug?: string;
  collection?: string;
  limit?: number;
  offset?: number;
  allowedCardIds?: string[];
  excludeAi?: boolean;
  discordFence?: { epoch: DrawScopeEpoch | null; installation: DrawInstallationSnapshot };
}

function discordInventoryFence(ctx: Ctx, fence: NonNullable<InventoryQuery["discordFence"]>) {
  if (!ctx.user || !fence.epoch || fence.epoch.userId !== ctx.user.id)
    throw new ApiError(503, "discord_scope_changed", "Server settings changed. Try again.");
  const e = fence.epoch;
  const i = fence.installation;
  return {
    sql: `EXISTS (SELECT 1 FROM fb_draw_scope_global_epoch g
      JOIN fb_discord_installations di ON di.id=? AND di.tenant_id=? AND di.active=1 AND di.revoked_at IS NULL AND di.game_enabled=1
      JOIN fb_bots b ON b.tenant_id=di.tenant_id AND b.status='active' AND (di.bot_id IS NULL OR di.bot_id=b.id)
      WHERE g.id=1 AND g.revision=? AND COALESCE((SELECT revision FROM fb_draw_scope_tenant_epochs WHERE tenant_id=?),0)=?
        AND COALESCE((SELECT revision FROM fb_draw_scope_user_epochs WHERE user_id=?),0)=?
        AND di.configuration_revision=? AND di.bot_id IS ? AND di.channel_allowlist_json IS ?
        AND di.collection_allowlist_json IS ? AND di.channel_audience_json IS ? AND di.channel_key IS ?
        AND ${DRAW_EPOCH_TRIGGER_CHECK})`,
    args: [i.id, ctx.tenant.id, e.global, ctx.tenant.id, e.tenant, ctx.user.id, e.user,
      i.revision, i.botId, i.channelAllowlist, i.collectionAllowlist, i.channelAudience, i.channelKey, DRAW_EPOCH_TRIGGER_DATA],
  };
}

export async function assertDiscordInventoryFence(ctx: Ctx, fence: NonNullable<InventoryQuery["discordFence"]>): Promise<void> {
  const guard = discordInventoryFence(ctx, fence);
  const principal = await inventoryFilter(ctx, {});
  const row = await first<{ ok: number }>(ctx.db,
    `SELECT (${guard.sql} AND ${principal.principalSql}) AS ok`,
    ...guard.args, ...principal.principalArgs);
  if (!row?.ok) throw new ApiError(409, "discord_scope_changed", "Server settings changed. Try again.");
}

/**
 * The filter fragment is shared by the list and count queries. A page is never
 * used as a total: "12 cards kept" must mean the collection, not the rows that
 * happened to fit in the first request.
 */
async function inventoryFilter(ctx: Ctx, options: InventoryQuery, agentScope: "inventory:read" | "profile:write" = "inventory:read") {
  const user = ctx.user;
  if (!user) throw new ApiError(401, "authentication_required", "Sign in to see your collection.");
  const guard=inventoryAccess(ctx,null,agentScope);
  const access=ctx.sessionAssurance==='access' && ctx.accessStatus==='linked' ? ctx.accessIdentity : null;
  const principalSql=`EXISTS (SELECT 1 FROM fb_memberships m JOIN fb_users u ON u.id=m.user_id AND u.disabled_at IS NULL
    WHERE m.tenant_id=? AND m.user_id=? AND m.status='active' AND m.revoked_at IS NULL AND (
      (?='user' AND (EXISTS (SELECT 1 FROM fb_sessions s WHERE s.id=? AND s.user_id=u.id AND s.tenant_id=m.tenant_id AND s.revoked_at IS NULL AND s.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        OR (?='access' AND ?>unixepoch('now') AND EXISTS (SELECT 1 FROM fb_access_identities ai WHERE ai.user_id=u.id AND ai.team_domain=? AND ai.subject=? AND ai.email=? AND ai.revoked_at IS NULL) AND u.email=? COLLATE NOCASE)))
      OR (?='user' AND EXISTS (SELECT 1 FROM fb_discord_identities di WHERE di.tenant_id=m.tenant_id AND di.user_id=u.id AND di.discord_user_id=? AND di.revoked_at IS NULL))
      OR (?='agent' AND EXISTS (SELECT 1 FROM fb_agent_tokens t JOIN fb_agent_grants g ON g.id=t.grant_id WHERE t.id=? AND g.id=? AND g.agent_id=? AND g.represented_user_id=u.id AND g.tenant_id=m.tenant_id AND t.revoked_at IS NULL AND g.status='active' AND g.revoked_at IS NULL AND g.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
        AND json_type(CASE WHEN json_valid(g.scopes_json) THEN g.scopes_json ELSE 'null' END)='array' AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(g.scopes_json) THEN g.scopes_json ELSE '[]' END) WHERE type<>'text')
        AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(g.scopes_json) THEN g.scopes_json ELSE '[]' END) WHERE value=?)))))`;
  const principalArgs=[ctx.tenant.id,user.id,ctx.actor.type,ctx.sessionId,ctx.sessionAssurance,access?.payload.exp ?? 0,ctx.config.access.teamDomain,access?.subject ?? '',access?.email ?? '',access?.email ?? '',ctx.actor.type,ctx.discordPrincipal?.discordUserId ?? '',ctx.actor.type,ctx.agentCredential?.tokenId ?? '',ctx.agentCredential?.grantId ?? '',ctx.actor.id,agentScope];
  const principal=await first<{ok:number}>(ctx.db,`SELECT 1 AS ok WHERE ${principalSql}`,...principalArgs);
  if (!principal) throw new ApiError(403,'inventory_access_changed','Your collection access changed. Sign in again.');
  const where = ["ci.tenant_id = ?", "ci.user_id = ?", "ci.status IN ('owned','reserved')", guard.authority];
  const params: unknown[] = [ctx.tenant.id, user.id,...guard.authArgs];
  if (options.discordFence) {
    const fence = discordInventoryFence(ctx, options.discordFence);
    where.push(fence.sql);
    params.push(...fence.args);
  }
  if (options.allowedCardIds) {
    where.push("ci.card_id IN (SELECT value FROM json_each(?))");
    params.push(JSON.stringify(options.allowedCardIds));
  }
  if (options.excludeAi) {
    where.push("EXISTS (SELECT 1 FROM fb_artwork_editions ie JOIN fb_assets ia ON ia.id=ie.subject_asset_id AND ia.tenant_id=ie.tenant_id WHERE ie.id=v.edition_id AND ie.tenant_id=v.tenant_id AND COALESCE(ia.origin, '') NOT IN ('ai_assisted','ai_generated'))");
  }
  if (options.status) {
    where.push("ci.status = ?");
    params.push(options.status);
  }
  if (options.favourite) where.push("ci.favourite = 1");
  if (options.search) {
    const normalized = normalizeCardName(options.search);
    const owned = await all<{ id: string; name: string }>(ctx.db, `${guard.scopeCte}SELECT DISTINCT cd.id, cd.name FROM fb_card_instances ci JOIN fb_card_definitions cd ON cd.id = ci.card_id
      WHERE ci.tenant_id = ? AND ci.user_id = ? AND ci.status IN ('owned','reserved') AND ${guard.authority}`, ...guard.scopeArgs,ctx.tenant.id, user.id,...guard.authArgs);
    const exactNames = owned.filter(row => normalizeCardName(row.name) === normalized).map(row => row.id);
    if (exactNames.length > 80) throw new ApiError(409, "card_name_ambiguous", "Too many cards share that name. Use a card's exact slug.");
    where.push(`(cd.name LIKE ? OR v.name LIKE ? OR cd.description LIKE ? OR EXISTS (SELECT 1 FROM fb_card_name_aliases na WHERE na.tenant_id = cd.tenant_id AND na.card_id = cd.id AND na.normalized = ?)${exactNames.length ? ` OR cd.id IN (${exactNames.map(() => "?").join(",")})` : ""})`);
    const search = `%${options.search}%`;
    params.push(search, search, search, normalized, ...exactNames);
  }
  if (options.setSlug) {
    where.push(
      "EXISTS (SELECT 1 FROM fb_set_memberships sm JOIN fb_sets s ON s.id = sm.set_id WHERE sm.card_id = ci.card_id AND s.slug = ? AND sm.set_version = s.version)",
    );
    params.push(options.setSlug);
  }
  if (options.collection) {
    where.push(
      "EXISTS (SELECT 1 FROM fb_collection_cards cc JOIN fb_collections c ON c.id = cc.collection_id WHERE cc.card_id = ci.card_id AND c.slug = ? AND c.archived_at IS NULL)",
    );
    params.push(options.collection);
  }
  return { where: where.join(" AND "), params,scopeCte:guard.scopeCte,scopeArgs:guard.scopeArgs,principalSql,principalArgs };
}

/** A partial, viewer-authorised inventory summary; this is not a backup. */
export async function visibleOwnerInventorySummary(ctx:Ctx) {
  const filter=await inventoryFilter(ctx,{});
  const row=await first<{copies:number|null}>(ctx.db,`/* owner:visible-summary */ ${filter.scopeCte}, summary_principal AS MATERIALIZED (SELECT 1 WHERE ${filter.principalSql})
    SELECT CASE WHEN EXISTS (SELECT 1 FROM summary_principal) AND EXISTS (SELECT 1 FROM fb_bots b JOIN fb_memberships m ON m.tenant_id=b.tenant_id AND m.user_id=? AND m.role='owner' AND m.status='active' AND m.revoked_at IS NULL WHERE b.tenant_id=? AND b.status='active' AND b.owner_user_id=m.user_id) THEN COUNT(*) ELSE NULL END AS copies
    FROM fb_card_instances ci JOIN fb_card_definitions cd ON cd.id=ci.card_id JOIN fb_variants v ON v.id=ci.variant_id WHERE ${filter.where}`,
    ...filter.scopeArgs,...filter.principalArgs,ctx.user!.id,ctx.tenant.id,...filter.params);
  if (!row || row.copies===null) throw new ApiError(403,'inventory_owner_changed','Your current Bot Owner access changed.');
  return {scope:'visible_owned_inventory' as const,complete:false as const,visibleCopies:Number(row.copies),exclusions:'Only your currently visible owned or reserved card copies are counted. This is not a backup; other members, inaccessible cards, assets, wallets and history are excluded.'};
}

export async function countInventory(ctx: Ctx, options: InventoryQuery = {}): Promise<number> {
  const { where, params,scopeCte,scopeArgs } = await inventoryFilter(ctx, options);
  const row = await first<{ count: number }>(
    ctx.db,
    `${scopeCte}SELECT COUNT(*) AS count
     FROM fb_card_instances ci
     JOIN fb_card_definitions cd ON cd.id = ci.card_id
     JOIN fb_variants v ON v.id = ci.variant_id
     WHERE ${where}`,
    ...scopeArgs,
    ...params,
  );
  return Number(row?.count ?? 0);
}

export async function inventoryCounts(ctx: Ctx, options: InventoryQuery = {}): Promise<{ copies: number; unique: number }> {
  const { where, params, scopeCte, scopeArgs } = await inventoryFilter(ctx, options);
  const row = await first<{ copies: number; unique_cards: number }>(ctx.db,
    `${scopeCte}SELECT COUNT(*) AS copies, COUNT(DISTINCT ci.card_id) AS unique_cards
     FROM fb_card_instances ci JOIN fb_card_definitions cd ON cd.id=ci.card_id
     JOIN fb_variants v ON v.id=ci.variant_id WHERE ${where}`,
    ...scopeArgs, ...params);
  return { copies: Number(row?.copies ?? 0), unique: Number(row?.unique_cards ?? 0) };
}

export async function getInventory(
  ctx: Ctx,
  options: InventoryQuery = {},
): Promise<InventoryRow[]> {
  const { where, params,scopeCte,scopeArgs } = await inventoryFilter(ctx, options);
  const limit = Math.min(500, Math.max(1, options.limit ?? 200));
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  return all<InventoryRow>(
    ctx.db,
    `${scopeCte}${INVENTORY_SELECT} WHERE ${where} ORDER BY ci.acquired_at DESC, ci.id DESC LIMIT ? OFFSET ?`,
    ...scopeArgs,
    ...params,
    limit,
    offset,
  );
}

function inventoryAccess(ctx: Ctx, instanceId: string | null, agentScope: "inventory:read" | "inventory:write" | "profile:write" | "recycle:write" = "inventory:read", cardId?: string, tradePeer = false) {
  const user = ctx.user;
  if (!user) throw new ApiError(401, "authentication_required", "Sign in to see your collection.");
  if (ctx.actor.representedUserId !== user.id || (ctx.actor.type === 'user' && ctx.actor.id !== user.id))
    throw new ApiError(404, 'instance_not_found', 'That card instance is not in your collection.');
  const access=ctx.sessionAssurance==='access' && ctx.accessStatus==='linked' ? ctx.accessIdentity : null;
  // Evaluated in every statement returning private instance or history data.
  const authority = `EXISTS (SELECT 1 FROM fb_memberships am JOIN fb_users au ON au.id=am.user_id AND au.disabled_at IS NULL
    JOIN fb_bots b ON b.tenant_id=am.tenant_id AND b.status='active'
    LEFT JOIN fb_bot_admins ba ON ba.bot_id=b.id AND ba.user_id=am.user_id
    WHERE am.tenant_id=ci.tenant_id AND am.user_id=? AND am.status='active' AND am.revoked_at IS NULL
    AND (${tradePeer ? '1=1' : cardId ? 'ci.user_id=au.id' : `ci.user_id=au.id OR (am.role='owner' AND b.owner_user_id=au.id)
      OR (?='user' AND au.platform_admin=1 AND EXISTS (SELECT 1 FROM fb_platform_admins pa WHERE pa.user_id=au.id AND pa.status='active' AND pa.revoked_at IS NULL))
      OR (am.role<>'owner' AND json_type(CASE WHEN json_valid(am.capabilities_json) THEN am.capabilities_json ELSE 'null' END)='array'
        AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(am.capabilities_json) THEN am.capabilities_json ELSE '[]' END) WHERE type<>'text')
        AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(am.capabilities_json) THEN am.capabilities_json ELSE '[]' END) WHERE value='inventory')
        AND (ba.id IS NULL OR (ba.role='admin' AND ba.status='active' AND ba.revoked_at IS NULL
          AND json_type(CASE WHEN json_valid(ba.capabilities_json) THEN ba.capabilities_json ELSE 'null' END)='array'
          AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(ba.capabilities_json) THEN ba.capabilities_json ELSE '[]' END) WHERE type<>'text')
          AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(ba.capabilities_json) THEN ba.capabilities_json ELSE '[]' END) WHERE value='inventory'))))`})
    AND (
      EXISTS (SELECT 1 FROM fb_collection_cards cc WHERE cc.card_id=ci.card_id)
      AND NOT EXISTS (SELECT 1 FROM fb_collection_cards cc LEFT JOIN fb_collections c ON c.id=cc.collection_id
        WHERE cc.card_id=ci.card_id AND (c.id IS NULL OR c.status<>'published' OR c.archived_at IS NOT NULL OR (c.scope='bot' AND c.owner_tenant_id IS NOT am.tenant_id)
          OR NOT ((?='user' AND au.platform_admin=1 AND EXISTS (SELECT 1 FROM fb_platform_admins pa WHERE pa.user_id=au.id AND pa.status='active' AND pa.revoked_at IS NULL))
            OR (c.scope='global' AND c.view_audience='public' AND c.public_approved_at IS NOT NULL)
            OR (c.view_audience='members' AND (c.scope='global' OR (c.scope='bot' AND c.owner_tenant_id=am.tenant_id)))
            OR (c.view_audience='private' AND ((c.scope='bot' AND c.owner_tenant_id=am.tenant_id AND ((am.role='owner' AND b.owner_user_id=au.id) OR EXISTS (SELECT 1 FROM bot_content)))
              OR (c.scope='global' AND EXISTS (SELECT 1 FROM global_scope gs WHERE gs.id=c.id))
              OR EXISTS (SELECT 1 FROM fb_collection_viewers cv WHERE cv.collection_id=c.id AND cv.user_id=au.id AND cv.revoked_at IS NULL)))))))
    AND ((?='user' AND (EXISTS (SELECT 1 FROM fb_sessions s WHERE s.id=? AND s.user_id=au.id AND s.tenant_id=am.tenant_id AND s.revoked_at IS NULL AND s.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      OR (?='access' AND ?>unixepoch('now') AND EXISTS (SELECT 1 FROM fb_access_identities ai WHERE ai.user_id=au.id AND ai.team_domain=? AND ai.subject=? AND ai.email=? AND ai.revoked_at IS NULL) AND au.email=? COLLATE NOCASE)))
      OR (?='user' AND EXISTS (SELECT 1 FROM fb_discord_identities di WHERE di.tenant_id=am.tenant_id AND di.user_id=au.id AND di.discord_user_id=? AND di.revoked_at IS NULL))
      OR (?='agent' AND EXISTS (SELECT 1 FROM fb_agent_tokens t JOIN fb_agent_grants g ON g.id=t.grant_id WHERE t.id=? AND g.id=? AND g.agent_id=? AND g.represented_user_id=au.id AND g.tenant_id=am.tenant_id AND t.revoked_at IS NULL AND g.status='active' AND g.revoked_at IS NULL AND g.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
        AND json_type(CASE WHEN json_valid(g.scopes_json) THEN g.scopes_json ELSE 'null' END)='array'
        AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(g.scopes_json) THEN g.scopes_json ELSE '[]' END) WHERE type<>'text')
        AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(g.scopes_json) THEN g.scopes_json ELSE '[]' END) WHERE value=?)))))`;
  const authArgs=[user.id,...(cardId || tradePeer ? [] : [ctx.actor.type]),ctx.actor.type,ctx.actor.type,ctx.sessionId,ctx.sessionAssurance,access?.payload.exp ?? 0,ctx.config.access.teamDomain,access?.subject ?? '',access?.email ?? '',access?.email ?? '',ctx.actor.type,ctx.discordPrincipal?.discordUserId ?? '',ctx.actor.type,ctx.agentCredential?.tokenId ?? '',ctx.agentCredential?.grantId ?? '',ctx.actor.id,agentScope];
  const scopeCte = `WITH global_scope AS MATERIALIZED (
    SELECT c.id FROM fb_collection_cards sc ${cardId || tradePeer ? '' : `JOIN fb_card_instances si ON si.card_id=sc.card_id AND si.tenant_id=? AND ${instanceId === null ? "si.user_id=? AND si.status IN ('owned','reserved')" : 'si.id=?'}`}
    JOIN fb_collections c ON c.id=sc.collection_id JOIN fb_platform_role_assignments p ON p.user_id=? AND p.role='global_collection_admin' AND p.status='active' AND p.revoked_at IS NULL
    WHERE ?='user' AND json_valid(p.scopes_json) AND (
      json_type(CASE WHEN json_valid(p.scopes_json) THEN p.scopes_json ELSE '{}' END,'$.all')='true'
      OR (json_type(CASE WHEN json_valid(p.scopes_json) THEN p.scopes_json ELSE '{}' END,'$.all')='false'
        AND json_type(CASE WHEN json_valid(p.scopes_json) THEN p.scopes_json ELSE '{}' END,'$.collectionIds')='array'
        AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(p.scopes_json) THEN p.scopes_json ELSE '{}' END,'$.collectionIds') WHERE type<>'text')
        AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(p.scopes_json) THEN p.scopes_json ELSE '{}' END,'$.collectionIds') WHERE value=c.id)))),
    content_token AS MATERIALIZED (
      SELECT 1 FROM fb_agent_tokens t JOIN fb_agent_grants g ON g.id=t.grant_id
      WHERE t.id=? AND g.id=? AND t.revoked_at IS NULL AND g.agent_id=? AND g.represented_user_id=? AND g.tenant_id=?
        AND g.status='active' AND g.revoked_at IS NULL AND g.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
        AND json_type(CASE WHEN json_valid(g.scopes_json) THEN g.scopes_json ELSE 'null' END)='array'
        AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(g.scopes_json) THEN g.scopes_json ELSE '[]' END) WHERE type<>'text')
        AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(g.scopes_json) THEN g.scopes_json ELSE '[]' END) WHERE value='content:read')
    ), content_membership AS MATERIALIZED (
      SELECT cm.user_id,cm.tenant_id,cb.id AS bot_id FROM fb_memberships cm JOIN fb_users cu ON cu.id=cm.user_id AND cu.disabled_at IS NULL
      JOIN fb_bots cb ON cb.tenant_id=cm.tenant_id AND cb.status='active'
      WHERE cm.tenant_id=? AND cm.user_id=? AND cm.role<>'owner' AND cm.status='active' AND cm.revoked_at IS NULL
        AND json_type(CASE WHEN json_valid(cm.capabilities_json) THEN cm.capabilities_json ELSE 'null' END)='array'
        AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(cm.capabilities_json) THEN cm.capabilities_json ELSE '[]' END) WHERE type<>'text')
        AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(cm.capabilities_json) THEN cm.capabilities_json ELSE '[]' END) WHERE value='content')
    ), content_grant AS MATERIALIZED (
      SELECT ca.bot_id,ca.user_id FROM fb_bot_admins ca JOIN content_membership cm ON cm.bot_id=ca.bot_id AND cm.user_id=ca.user_id WHERE ca.role='admin' AND ca.status='active' AND ca.revoked_at IS NULL
        AND json_type(CASE WHEN json_valid(ca.capabilities_json) THEN ca.capabilities_json ELSE 'null' END)='array'
        AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(ca.capabilities_json) THEN ca.capabilities_json ELSE '[]' END) WHERE type<>'text')
        AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(ca.capabilities_json) THEN ca.capabilities_json ELSE '[]' END) WHERE value='content')
    ), bot_content AS MATERIALIZED (
      SELECT 1 FROM content_membership cm LEFT JOIN fb_bot_admins ca ON ca.bot_id=cm.bot_id AND ca.user_id=cm.user_id
      WHERE (ca.id IS NULL OR EXISTS (SELECT 1 FROM content_grant cg WHERE cg.bot_id=cm.bot_id AND cg.user_id=cm.user_id))
        AND (?='user' OR (?='agent' AND EXISTS (SELECT 1 FROM content_token)))
    ) `;
  const scopeArgs=[...(cardId || tradePeer ? [] : [ctx.tenant.id,instanceId ?? user.id]),user.id,ctx.actor.type,ctx.agentCredential?.tokenId ?? '',ctx.agentCredential?.grantId ?? '',ctx.actor.id,user.id,ctx.tenant.id,ctx.tenant.id,user.id,ctx.actor.type,ctx.actor.type];
  return {scopeCte,scopeArgs,authority,authArgs};
}

/** Internal profile-share read: only explicitly pinned copies under profile:write. */
export async function getProfileFavouriteInventory(ctx: Ctx): Promise<InventoryRow[]> {
  const {where,params,scopeCte,scopeArgs}=await inventoryFilter(ctx,{favourite:true},'profile:write');
  return all<InventoryRow>(ctx.db,`${scopeCte}${INVENTORY_SELECT} WHERE ${where} ORDER BY ci.acquired_at DESC,ci.id DESC LIMIT 100`,...scopeArgs,...params);
}

export async function getInstance(ctx: Ctx, instanceId: string) {
  const {scopeCte,scopeArgs,authority,authArgs}=inventoryAccess(ctx,instanceId);
  const instance = await first<InventoryRow & { description: string; card_status: string; acquired_via: string }>(
    ctx.db, `${scopeCte}${INVENTORY_SELECT} WHERE ci.tenant_id=? AND ci.id=? AND ${authority}`,...scopeArgs,ctx.tenant.id,instanceId,...authArgs,
  );
  if (!instance)
    throw new ApiError(404, "instance_not_found", "That card instance is not in your collection.");
  // Only start these independent reads after instance authorization succeeds.
  const [history, draws] = await Promise.all([
    all<{
    id: string;
    event: string;
    from_user_id: string | null;
    to_user_id: string | null;
    reference_type: string | null;
    reference_id: string | null;
    created_at: string;
  }>(
    ctx.db,
    `${scopeCte}SELECT h.id,h.event,h.from_user_id,h.to_user_id,h.reference_type,h.reference_id,h.created_at FROM fb_instance_history h JOIN fb_card_instances ci ON ci.id=h.instance_id AND ci.tenant_id=h.tenant_id WHERE h.tenant_id=? AND h.instance_id=? AND ${authority} ORDER BY h.created_at`,
    ...scopeArgs,
    ctx.tenant.id,
    instanceId,
    ...authArgs,
  ),
    all<{
    id: string;
    pool_id: string;
    pool_revision: number;
    price: number;
    created_at: string;
  }>(
    ctx.db,
    `${scopeCte}SELECT d.id,d.pool_id,d.pool_revision,d.price,d.created_at FROM fb_draws d JOIN fb_card_instances ci ON ci.id=d.instance_id AND ci.tenant_id=d.tenant_id WHERE d.tenant_id=? AND d.instance_id=? AND ${authority}`,
    ...scopeArgs,
    ctx.tenant.id,
    instanceId,
    ...authArgs,
  ),
  ]);
  const stillAllowed=await first<{allowed:number}>(ctx.db,`${scopeCte}SELECT 1 AS allowed FROM fb_card_instances ci WHERE ci.tenant_id=? AND ci.id=? AND ${authority}`,...scopeArgs,ctx.tenant.id,instanceId,...authArgs);
  if (!stillAllowed?.allowed) throw new ApiError(404, 'instance_not_found', 'That card instance is not in your collection.');
  return { instance, history, draws };
}

/** Record an intentional flip, only for a currently visible owned copy. */
export async function recordCardInspection(ctx: Ctx, instanceId: string) {
  if (!ctx.user || ctx.user.synthetic || ctx.actor.type !== 'user' || ctx.actor.id !== ctx.user.id || ctx.actor.representedUserId !== ctx.user.id)
    throw new ApiError(403, 'inspection_unavailable', 'Sign in as a member to record an inspection.');
  const { scopeCte, scopeArgs, authority, authArgs } = inventoryAccess(ctx, instanceId);
  const keyPrefix=`card.inspected:${ctx.user.id}:`;
  const result=await ctx.db.prepare(`${scopeCte}INSERT OR IGNORE INTO fb_domain_events
    (id,tenant_id,user_id,event_type,object_type,object_id,dedupe_key,payload_json,created_at)
    SELECT ?,ci.tenant_id,ci.user_id,'card.inspected','card',ci.card_id,? || strftime('%Y-%m-%d','now'),'{}',strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM fb_card_instances ci
    WHERE ci.tenant_id=? AND ci.id=? AND ci.user_id=? AND ci.status='owned' AND EXISTS (SELECT 1 FROM fb_users u WHERE u.id=ci.user_id AND u.is_synthetic=0) AND ${authority}`)
    .bind(...scopeArgs,newId('evt'),keyPrefix,ctx.tenant.id,instanceId,ctx.user.id,...authArgs).run();
  const current=await first<{ok:number}>(ctx.db,`${scopeCte}SELECT 1 AS ok FROM fb_card_instances ci
    WHERE ci.tenant_id=? AND ci.id=? AND ci.user_id=? AND ci.status='owned' AND EXISTS (SELECT 1 FROM fb_users u WHERE u.id=ci.user_id AND u.is_synthetic=0) AND ${authority}`,
    ...scopeArgs,ctx.tenant.id,instanceId,ctx.user.id,...authArgs);
  if (!current) throw new ApiError(404,'instance_not_found','That card instance is not in your collection.');
  return { recorded: result.meta.changes === 1, already_recorded: result.meta.changes === 0 };
}

async function setInstanceFlag(ctx: Ctx, instanceId: string, flag: 'favourite' | 'locked', value: boolean) {
  const user=ctx.user;
  if (!user) throw new ApiError(401,'authentication_required','Sign in to manage your collection.');
  const {scopeCte,scopeArgs,authority,authArgs}=inventoryAccess(ctx,instanceId,'inventory:write');
  const action=flag==='favourite' ? (value?'instance.favourited':'instance.unfavourited') : (value?'instance.locked':'instance.unlocked');
  const exactAgent=`(?<>'agent' OR EXISTS (SELECT 1 FROM fb_agent_tokens t WHERE t.id=? AND t.grant_id=? AND t.token_hash=? AND t.token_hash<>'' AND t.revoked_at IS NULL))`;
  const now=nowIso();
  const statements=[
    ctx.db.prepare(`${scopeCte}UPDATE fb_card_instances AS ci SET ${flag}=?,updated_at=?
      WHERE ci.id=? AND ci.tenant_id=? AND ci.user_id=? AND ci.status='owned' AND ci.${flag}<>? AND ${authority} AND ${exactAgent}`)
      .bind(...scopeArgs,value?1:0,now,instanceId,ctx.tenant.id,user.id,value?1:0,...authArgs,ctx.actor.type,ctx.agentCredential?.tokenId ?? '',ctx.agentCredential?.grantId ?? '',ctx.agentCredential?.verifiedTokenHash ?? ''),
    ctx.db.prepare(`INSERT INTO fb_audit_events(id,tenant_id,actor_type,actor_id,represented_user_id,action,object_type,object_id,metadata_json,request_id,created_at)
      SELECT ?,?,?,?,?,?,'instance',?,'{}',?,? WHERE changes()=1`)
      .bind(newId('aud'),ctx.tenant.id,ctx.actor.type,ctx.actor.id,ctx.actor.representedUserId,action,instanceId,ctx.requestId,now),
  ];
  if (flag==='favourite' && value && ctx.actor.type==='user' && !user.synthetic) {
    statements.push(ctx.db.prepare(`INSERT OR IGNORE INTO fb_domain_events(id,tenant_id,user_id,event_type,object_type,object_id,dedupe_key,payload_json,created_at)
      SELECT ?,ci.tenant_id,ci.user_id,'card.favourited','card',ci.card_id,? || strftime('%Y-%m-%d','now'),'{}',strftime('%Y-%m-%dT%H:%M:%fZ','now')
      FROM fb_card_instances ci JOIN fb_users u ON u.id=ci.user_id AND u.is_synthetic=0
      WHERE ci.id=? AND ci.tenant_id=? AND ci.user_id=? AND changes()=1`)
      .bind(newId('evt'),`card.favourited:${user.id}:`,instanceId,ctx.tenant.id,user.id));
  }
  // An unchanged setting is still an idempotent success, but only for a
  // principal who remains authorised in the same transaction.
  statements.push(ctx.db.prepare(`${scopeCte}SELECT ci.id FROM fb_card_instances ci
    WHERE ci.id=? AND ci.tenant_id=? AND ci.user_id=? AND ci.status='owned' AND ci.${flag}=? AND ${authority} AND ${exactAgent}`)
    .bind(...scopeArgs,instanceId,ctx.tenant.id,user.id,value?1:0,...authArgs,ctx.actor.type,ctx.agentCredential?.tokenId ?? '',ctx.agentCredential?.grantId ?? '',ctx.agentCredential?.verifiedTokenHash ?? ''));
  const results=await ctx.db.batch(statements);
  if (!results.at(-1)?.results?.length) throw new ApiError(404,'instance_not_found','That card is not in your collection.');
}

export async function toggleFavourite(ctx: Ctx, instanceId: string, favourite: boolean) {
  await setInstanceFlag(ctx,instanceId,'favourite',favourite);
  return { id: instanceId, favourite };
}

export async function setLocked(ctx: Ctx, instanceId: string, locked: boolean) {
  await setInstanceFlag(ctx,instanceId,'locked',locked);
  return { id: instanceId, locked };
}

export async function toggleWishlist(
  ctx: Ctx,
  cardId: string,
  wanted: boolean,
  target?: { materialKey?: string | null; effectKey?: string | null; variantId?: string | null },
) {
  const user = ctx.user;
  if (!user) throw new ApiError(401,'authentication_required','Sign in to manage your wishlist.');
  const {scopeCte,scopeArgs,authority,authArgs}=inventoryAccess(ctx,null,'inventory:write',cardId);
  const exactAgent=`(?<>'agent' OR EXISTS (SELECT 1 FROM fb_agent_tokens t WHERE t.id=? AND t.grant_id=? AND t.token_hash=? AND t.token_hash<>'' AND t.revoked_at IS NULL))`;
  const agentArgs=[ctx.actor.type,ctx.agentCredential?.tokenId ?? '',ctx.agentCredential?.grantId ?? '',ctx.agentCredential?.verifiedTokenHash ?? ''];
  const cardSource=`(SELECT cd.id AS card_id,cd.tenant_id,? AS user_id FROM fb_card_definitions cd WHERE cd.id=? AND cd.tenant_id=? AND cd.status='published' AND cd.archived_at IS NULL) ci`;
  const cardArgs=[user.id,cardId,ctx.tenant.id];
  const visible=async()=>first<{ok:number}>(ctx.db,`${scopeCte}SELECT 1 AS ok FROM ${cardSource} WHERE ${authority} AND ${exactAgent}`,...scopeArgs,...cardArgs,...authArgs,...agentArgs);
  if (!await visible()) throw new ApiError(404,'card_not_found','Card not found.');
  let targetVariant: { id: string; material_key: string; effect_key: string | null } | null = null;
  if (target?.variantId) {
    targetVariant = await first<{ id: string; material_key: string; effect_key: string | null }>(
      ctx.db,
      `${scopeCte}SELECT v.id, m.key AS material_key, e.key AS effect_key
         FROM fb_variants v JOIN fb_materials m ON m.id = v.material_id
         LEFT JOIN fb_effects e ON e.id = v.effect_id
         JOIN ${cardSource} ON ci.card_id=v.card_id AND ci.tenant_id=v.tenant_id
        WHERE v.id = ? AND v.card_id = ? AND v.tenant_id = ? AND v.status = 'published' AND v.archived_at IS NULL AND ${authority} AND ${exactAgent}`,
      ...scopeArgs,...cardArgs,
      target.variantId,
      cardId,
      ctx.tenant.id,
      ...authArgs,...agentArgs,
    );
    if (!targetVariant) {
      if (!await visible()) throw new ApiError(404,'card_not_found','Card not found.');
      throw new ApiError(422, "wishlist_target_invalid", "That published finish does not belong to this card.");
    }
  }
  if (wanted) {
    const result=await ctx.db
      .prepare(
        `${scopeCte}INSERT INTO fb_wishlists (tenant_id, user_id, card_id, target_material_key, target_effect_key, target_variant_id, created_at)
         SELECT ci.tenant_id,ci.user_id,ci.card_id,?,?,?,? FROM ${cardSource}
         WHERE ${authority} AND ${exactAgent} AND (? IS NULL OR EXISTS (SELECT 1 FROM fb_variants v JOIN fb_materials m ON m.id=v.material_id LEFT JOIN fb_effects e ON e.id=v.effect_id
           WHERE v.id=? AND v.card_id=ci.card_id AND v.tenant_id=ci.tenant_id AND v.status='published' AND v.archived_at IS NULL AND m.key=? AND e.key IS ?))
         ON CONFLICT(tenant_id, user_id, card_id) DO UPDATE SET
           target_material_key = excluded.target_material_key,
           target_effect_key = excluded.target_effect_key,
           target_variant_id = excluded.target_variant_id`,
      )
      .bind(
        ...scopeArgs,
        targetVariant?.material_key ?? target?.materialKey ?? null,
        targetVariant?.effect_key ?? target?.effectKey ?? null,
        targetVariant?.id ?? null,
        nowIso(),
        ...cardArgs,...authArgs,...agentArgs,targetVariant?.id ?? null,targetVariant?.id ?? null,targetVariant?.material_key ?? null,targetVariant?.effect_key ?? null,
      ).run();
    if(result.meta.changes!==1) throw new ApiError(404,'card_not_found','Card not found or no longer available.');
  } else {
    const results=await ctx.db.batch([
      ctx.db.prepare(`${scopeCte}, permitted AS MATERIALIZED (SELECT 1 FROM ${cardSource} WHERE ${authority} AND ${exactAgent})
        DELETE FROM fb_wishlists WHERE tenant_id=? AND user_id=? AND card_id=? AND EXISTS (SELECT 1 FROM permitted)`)
        .bind(...scopeArgs,...cardArgs,...authArgs,...agentArgs,ctx.tenant.id,user.id,cardId),
      ctx.db.prepare(`${scopeCte}SELECT 1 FROM ${cardSource} WHERE ${authority} AND ${exactAgent}`).bind(...scopeArgs,...cardArgs,...authArgs,...agentArgs),
    ]);
    if (!results[1]?.results?.length) throw new ApiError(404,'card_not_found','Card not found.');
  }
  return {
    card_id: cardId,
    wanted,
    target_material_key: targetVariant?.material_key ?? target?.materialKey ?? null,
    target_effect_key: targetVariant?.effect_key ?? target?.effectKey ?? null,
    target_variant_id: targetVariant?.id ?? null,
  };
}

export async function getWishlist(ctx: Ctx) {
  const user = ctx.user;
  if (!user) throw new ApiError(401,'authentication_required','Sign in to see your wishlist.');
  const {scopeCte,scopeArgs,authority,authArgs}=inventoryAccess(ctx,null,'inventory:read','wishlist');
  const exactAgent=`(?<>'agent' OR EXISTS (SELECT 1 FROM fb_agent_tokens t WHERE t.id=? AND t.grant_id=? AND t.token_hash=? AND t.token_hash<>'' AND t.revoked_at IS NULL))`;
  return all<{
    card_id: string;
    name: string;
    slug: string;
    target_material_key: string | null;
    target_effect_key: string | null;
    target_variant_id: string | null;
    variant_name: string | null;
  }>(
    ctx.db,
    `${scopeCte}SELECT w.card_id, cd.name, cd.slug,
       CASE WHEN w.target_variant_id IS NOT NULL AND v.id IS NULL THEN NULL ELSE w.target_material_key END AS target_material_key,
       CASE WHEN w.target_variant_id IS NOT NULL AND v.id IS NULL THEN NULL ELSE w.target_effect_key END AS target_effect_key,
       v.id AS target_variant_id, v.name AS variant_name
       FROM fb_wishlists w JOIN fb_card_definitions cd ON cd.id = w.card_id
       JOIN fb_wishlists ci ON ci.tenant_id=w.tenant_id AND ci.user_id=w.user_id AND ci.card_id=w.card_id
       LEFT JOIN fb_variants v ON v.id=w.target_variant_id AND v.card_id=w.card_id AND v.tenant_id=w.tenant_id AND v.status='published' AND v.archived_at IS NULL
      WHERE w.tenant_id = ? AND w.user_id = ? AND cd.tenant_id=w.tenant_id AND cd.status = 'published' AND cd.archived_at IS NULL AND ${authority} AND ${exactAgent} ORDER BY w.created_at DESC`,
    ...scopeArgs,
    ctx.tenant.id,
    user.id,
    ...authArgs,ctx.actor.type,ctx.agentCredential?.tokenId ?? '',ctx.agentCredential?.grantId ?? '',ctx.agentCredential?.verifiedTokenHash ?? '',
  );
}

/** Guard an already-built share snapshot at the INSERT boundary. */
export function sharePrincipalEpochFence(ctx: Ctx, snapshot: {global_epoch:number; tenant_epoch:number; user_epoch:number}, requireInventory = true) {
  const user=ctx.user;
  if (!user || ctx.actor.representedUserId!==user.id || (ctx.actor.type==='user' && ctx.actor.id!==user.id))
    throw new ApiError(403,'share_access_changed','Your sharing access changed. Sign in again.');
  const access=ctx.sessionAssurance==='access' && ctx.accessStatus==='linked' ? ctx.accessIdentity : null;
  const principal=`EXISTS (SELECT 1 FROM fb_memberships m JOIN fb_users u ON u.id=m.user_id AND u.disabled_at IS NULL JOIN fb_bots b ON b.tenant_id=m.tenant_id AND b.status='active'
    WHERE m.tenant_id=? AND m.user_id=? AND m.status='active' AND m.revoked_at IS NULL AND (
      (?='user' AND (EXISTS (SELECT 1 FROM fb_sessions s WHERE s.id=? AND s.user_id=u.id AND s.tenant_id=m.tenant_id AND s.revoked_at IS NULL AND s.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        OR (?='access' AND ?>unixepoch('now') AND EXISTS (SELECT 1 FROM fb_access_identities ai WHERE ai.user_id=u.id AND ai.team_domain=? AND ai.subject=? AND ai.email=? AND ai.revoked_at IS NULL) AND u.email=? COLLATE NOCASE)))
      OR (?='user' AND EXISTS (SELECT 1 FROM fb_discord_identities d WHERE d.tenant_id=m.tenant_id AND d.user_id=u.id AND d.discord_user_id=? AND d.revoked_at IS NULL))
      OR (?='agent' AND EXISTS (SELECT 1 FROM fb_agent_tokens t JOIN fb_agent_grants g ON g.id=t.grant_id WHERE t.id=? AND t.token_hash=? AND t.token_hash<>'' AND t.revoked_at IS NULL AND g.id=? AND g.agent_id=? AND g.represented_user_id=u.id AND g.tenant_id=m.tenant_id AND g.status='active' AND g.revoked_at IS NULL AND g.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
        AND json_type(CASE WHEN json_valid(g.scopes_json) THEN g.scopes_json ELSE 'null' END)='array' AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(g.scopes_json) THEN g.scopes_json ELSE '[]' END) WHERE type<>'text')
        ${requireInventory ? "AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(g.scopes_json) THEN g.scopes_json ELSE '[]' END) WHERE value='inventory:read')" : ''} AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(g.scopes_json) THEN g.scopes_json ELSE '[]' END) WHERE value='profile:write')))))`;
  const principalArgs=[ctx.tenant.id,user.id,ctx.actor.type,ctx.sessionId,ctx.sessionAssurance,access?.payload.exp ?? 0,ctx.config.access.teamDomain,access?.subject ?? '',access?.email ?? '',access?.email ?? '',ctx.actor.type,ctx.discordPrincipal?.discordUserId ?? '',ctx.actor.type,ctx.agentCredential?.tokenId ?? '',ctx.agentCredential?.verifiedTokenHash ?? '',ctx.agentCredential?.grantId ?? '',ctx.actor.id];
  return {sql:`${principal} AND EXISTS (SELECT 1 FROM fb_player_preferences pref WHERE pref.tenant_id=? AND pref.user_id=? AND pref.sharing_enabled=1)
    AND ${DRAW_EPOCH_TRIGGER_CHECK} AND EXISTS (SELECT 1 FROM fb_draw_scope_global_epoch g WHERE g.id=1 AND g.revision=?
    AND COALESCE((SELECT revision FROM fb_draw_scope_tenant_epochs WHERE tenant_id=?),0)=?
    AND COALESCE((SELECT revision FROM fb_draw_scope_user_epochs WHERE user_id=?),0)=?)`,
    args:[...principalArgs,ctx.tenant.id,user.id,DRAW_EPOCH_TRIGGER_DATA,snapshot.global_epoch,ctx.tenant.id,snapshot.tenant_epoch,user.id,snapshot.user_epoch]};
}

/** Guard an already-built wishlist share, including an empty snapshot. */
export function wishlistShareFence(ctx: Ctx, snapshot: {global_epoch:number; tenant_epoch:number; user_epoch:number; wishes:string}) {
  const base=sharePrincipalEpochFence(ctx,snapshot);
  return {sql:`${base.sql} AND (SELECT json_group_array(json_array(card_id,target_material_key,target_effect_key,target_variant_id,created_at)) FROM
    (SELECT card_id,target_material_key,target_effect_key,target_variant_id,created_at FROM fb_wishlists WHERE tenant_id=? AND user_id=? ORDER BY card_id))=?`,
    args:[...base.args,ctx.tenant.id,ctx.user!.id,snapshot.wishes]};
}

type RecycleQuote = { preview: { instance: InventoryRow; credit: number; breakdown: {rarity:number;material:number}; currency_symbol:string; warning:string }; rates:string };

async function recycleQuote(ctx: Ctx, instanceId: string, scope: 'inventory:read'|'recycle:write'): Promise<RecycleQuote> {
  const user=ctx.user;
  if (!user) throw new ApiError(401,'authentication_required','Sign in to recycle a card.');
  const {scopeCte,scopeArgs,authority,authArgs}=inventoryAccess(ctx,instanceId,scope);
  const exactAgent=`(?<>'agent' OR EXISTS (SELECT 1 FROM fb_agent_tokens t WHERE t.id=? AND t.grant_id=? AND t.token_hash=? AND t.token_hash<>'' AND t.revoked_at IS NULL))`;
  const agentArgs=[ctx.actor.type,ctx.agentCredential?.tokenId ?? '',ctx.agentCredential?.grantId ?? '',ctx.agentCredential?.verifiedTokenHash ?? ''];
  const instance=await first<InventoryRow & {recycle_rates_json:string;recycle_enabled:number;currency_symbol:string}>(ctx.db,
    `${scopeCte}${INVENTORY_SELECT.replace('SELECT ci.id', 'SELECT es.recycle_rates_json,es.recycle_enabled,es.currency_symbol,ci.id')}
      JOIN fb_economy_settings es ON es.tenant_id=ci.tenant_id
      WHERE ci.tenant_id=? AND ci.id=? AND ci.user_id=? AND ci.status='owned' AND v.card_id=ci.card_id AND ${authority} AND ${exactAgent}`,
    ...scopeArgs,ctx.tenant.id,instanceId,user.id,...authArgs,...agentArgs);
  if (!instance) throw new ApiError(404,'instance_not_found','That card is not available to recycle.');
  if (instance.favourite) throw new ApiError(409,'favourite_protected','Remove the favourite mark before recycling this card.');
  if (instance.locked) throw new ApiError(409,'locked_protected','Locked cards cannot be recycled.');
  if (!instance.recycle_enabled) throw new ApiError(409,'recycle_disabled','Recycling is disabled in this cabinet.');
  const rates=JSON.parse(instance.recycle_rates_json) as {rarity:Record<string,number>;material:Record<string,number>};
  const base=rates.rarity[instance.rarity_key ?? 'common'] ?? 10,bonus=rates.material[instance.material_key] ?? 0;
  if (!Number.isSafeInteger(base) || !Number.isSafeInteger(bonus) || base<0 || bonus<0 || !Number.isSafeInteger(base+bonus)) throw new ApiError(503,'recycle_unavailable','Recycle values are temporarily unavailable.');
  const {recycle_rates_json,recycle_enabled:_enabled,currency_symbol,...card}=instance;
  return {rates:recycle_rates_json,preview:{instance:card,credit:base+bonus,breakdown:{rarity:base,material:bonus},currency_symbol,warning:'Recycling is permanent. The instance leaves your collection and the acquisition history remains in the ledger.'}};
}

export async function recyclePreview(ctx: Ctx, instanceId: string) {
  return (await recycleQuote(ctx,instanceId,'inventory:read')).preview;
}

type RecycleInput={instanceId:string;idempotencyKey:string;expectedCredit:number};
function recycleAccess(ctx:Ctx,input:RecycleInput) {
  const user=ctx.user;
  if (!user) throw new ApiError(401,'authentication_required','Sign in to recycle a card.');
  const {scopeCte,scopeArgs,authority,authArgs}=inventoryAccess(ctx,input.instanceId,'recycle:write');
  const exactAgent=`(?<>'agent' OR EXISTS (SELECT 1 FROM fb_agent_tokens t WHERE t.id=? AND t.grant_id=? AND t.token_hash=? AND t.token_hash<>'' AND t.revoked_at IS NULL))`;
  const agentArgs=[ctx.actor.type,ctx.agentCredential?.tokenId ?? '',ctx.agentCredential?.grantId ?? '',ctx.agentCredential?.verifiedTokenHash ?? ''];
  return {user,scopeCte,scopeArgs,authority,authArgs,exactAgent,agentArgs};
}

async function recycleReservation(ctx:Ctx,input:RecycleInput) {
  const {user,scopeCte,scopeArgs,authority,authArgs,exactAgent,agentArgs}=recycleAccess(ctx,input),now=nowIso();
  let results: Awaited<ReturnType<Ctx['db']['batch']>>;
  try { results=await ctx.db.batch([
    ctx.db.prepare(`${scopeCte}INSERT OR IGNORE INTO fb_recycle_requests(tenant_id,user_id,idempotency_key,instance_id,expected_credit,status,created_at,updated_at)
      SELECT ci.tenant_id,ci.user_id,?,?,?,'pending',?,? FROM fb_card_instances ci
      WHERE ci.tenant_id=? AND ci.user_id=? AND ci.id=? AND ${authority} AND ${exactAgent}`)
      .bind(...scopeArgs,input.idempotencyKey,input.instanceId,input.expectedCredit,now,now,ctx.tenant.id,user.id,input.instanceId,...authArgs,...agentArgs),
    ctx.db.prepare(`${scopeCte}SELECT r.instance_id,r.expected_credit,r.status FROM fb_recycle_requests r JOIN fb_card_instances ci ON ci.id=? AND ci.tenant_id=r.tenant_id AND ci.user_id=r.user_id
      WHERE r.tenant_id=? AND r.user_id=? AND r.idempotency_key=? AND ${authority} AND ${exactAgent}`)
      .bind(...scopeArgs,input.instanceId,ctx.tenant.id,user.id,input.idempotencyKey,...authArgs,...agentArgs),
  ]); } catch(error) {
    if (/no such table: fb_recycle_requests\b/.test(String(error)))
      throw new ApiError(503,'recycle_temporarily_unavailable','Recycle recovery is temporarily unavailable. Keep this request and try again later.');
    throw error;
  }
  const row=results[1]?.results?.[0] as {instance_id:string;expected_credit:number;status:string}|undefined;
  if (!row) throw new ApiError(404,'instance_not_found','That card is not available to recycle.');
  if (row.instance_id!==input.instanceId || row.expected_credit!==input.expectedCredit) throw new ApiError(409,'recycle_conflict','That request key belongs to a different recycle.');
  return row.status;
}

type RecycleReceipt={receipt_id:string;instance_id:string;credit:number;balance_after:number};
function recycleReceipt(ctx:Ctx,input:RecycleInput) {
  const {user,scopeCte,scopeArgs,authority,authArgs,exactAgent,agentArgs}=recycleAccess(ctx,input);
  return first<RecycleReceipt>(ctx.db,`${scopeCte}SELECT r.id AS receipt_id,r.instance_id,r.credit_amount AS credit,l.balance_after
    FROM fb_recycle_receipts r JOIN fb_card_instances ci ON ci.id=r.instance_id AND ci.tenant_id=r.tenant_id
    JOIN fb_ledger_entries l ON l.tenant_id=r.tenant_id AND l.user_id=r.user_id AND l.reference_type='recycle' AND l.reference_id=r.id AND l.amount=r.credit_amount
    WHERE r.tenant_id=? AND r.user_id=? AND r.idempotency_key=? AND ${authority} AND ${exactAgent}`,
    ...scopeArgs,ctx.tenant.id,user.id,input.idempotencyKey,...authArgs,...agentArgs);
}

export async function recycleCommit(ctx: Ctx, input: RecycleInput) {
  const {user,scopeCte,scopeArgs,authority,authArgs,exactAgent,agentArgs}=recycleAccess(ctx,input);
  const receipt=()=>recycleReceipt(ctx,input);
  const prior=await receipt();
  if (prior) {
    if (prior.instance_id!==input.instanceId || prior.credit!==input.expectedCredit) throw new ApiError(409,'recycle_conflict','That request key belongs to a different recycle.');
    return prior;
  }
  const status=await recycleReservation(ctx,input);
  if (status==='cancelled') throw new ApiError(409,'recycle_cancelled','This recycle request was cancelled. Start again with a new quote.');
  if (status!=='pending') {
    const existing=await receipt();
    if (existing && existing.instance_id===input.instanceId && existing.credit===input.expectedCredit) return existing;
    throw new ApiError(503,'recycle_receipt_unavailable','The card may already have been recycled. Restore access and retry with the same request key.');
  }
  let quote: RecycleQuote;
  try { quote=await recycleQuote(ctx,input.instanceId,'recycle:write'); }
  catch(error) {
    const existing=await receipt();
    if (existing) {
      if (existing.instance_id!==input.instanceId || existing.credit!==input.expectedCredit) throw new ApiError(409,'recycle_conflict','That request key belongs to a different recycle.');
      return existing;
    }
    throw error;
  }
  const preview=quote.preview;
  if (preview.credit!==input.expectedCredit) throw new ApiError(409,'credit_changed','The recycle value changed. Review it again before confirming.',{current_credit:preview.credit});
  const receiptId=newId('rcy'),now=nowIso();
  try {
    const results=await ctx.db.batch([
      ctx.db.prepare(`${scopeCte}INSERT INTO fb_recycle_receipts(id,tenant_id,user_id,instance_id,credit_amount,created_at,idempotency_key,actor_type,actor_id)
        SELECT ?,ci.tenant_id,ci.user_id,ci.id,?,?,?,?,? FROM fb_card_instances ci
        JOIN fb_variants v ON v.id=ci.variant_id AND v.tenant_id=ci.tenant_id AND v.card_id=ci.card_id
        JOIN fb_materials m ON m.id=v.material_id LEFT JOIN fb_card_definitions cd ON cd.id=ci.card_id AND cd.tenant_id=ci.tenant_id
        LEFT JOIN fb_rarities rar ON rar.id=cd.rarity_id JOIN fb_economy_settings es ON es.tenant_id=ci.tenant_id
        WHERE ci.id=? AND ci.tenant_id=? AND ci.user_id=? AND ci.status='owned' AND ci.favourite=0 AND ci.locked=0
          AND ci.card_id=? AND ci.variant_id=? AND m.key=? AND rar.key IS ? AND es.recycle_enabled=1 AND es.recycle_rates_json=?
          AND EXISTS (SELECT 1 FROM fb_recycle_requests r WHERE r.tenant_id=ci.tenant_id AND r.user_id=ci.user_id AND r.idempotency_key=? AND r.instance_id=ci.id AND r.expected_credit=? AND r.status='pending')
          AND ${authority} AND ${exactAgent}`)
        .bind(...scopeArgs,receiptId,preview.credit,now,input.idempotencyKey,ctx.actor.type,ctx.actor.id,input.instanceId,ctx.tenant.id,user.id,preview.instance.card_id,preview.instance.variant_id,preview.instance.material_key,preview.instance.rarity_key,quote.rates,input.idempotencyKey,input.expectedCredit,...authArgs,...agentArgs),
      ctx.db.prepare(`INSERT INTO fb_audit_events(id,tenant_id,actor_type,actor_id,represented_user_id,action,object_type,object_id,metadata_json,request_id,created_at)
        SELECT ?,?,?,?,?,'instance.recycled','instance',?,?,?,? WHERE changes()=1`)
        .bind(newId('aud'),ctx.tenant.id,ctx.actor.type,ctx.actor.id,ctx.actor.representedUserId,input.instanceId,JSON.stringify({credit:preview.credit}),ctx.requestId,now),
    ]);
    if (results[0]?.meta.changes!==1) {
      const existing=await receipt();
      if (existing && existing.instance_id===input.instanceId && existing.credit===input.expectedCredit) return existing;
      const current=await recycleReservation(ctx,input);
      if (current==='cancelled') throw new ApiError(409,'recycle_cancelled','This recycle request was cancelled. Start again with a new quote.');
      if (current==='completed') throw new ApiError(503,'recycle_receipt_unavailable','The card may already have been recycled. Restore access and retry with the same request key.');
      throw new ApiError(409,'recycle_changed','The card, access or recycle value changed. Review it again before retrying.');
    }
  } catch(error) {
    if (error instanceof ApiError) throw error;
    try {
      const existing=await receipt();
      if (existing && existing.instance_id===input.instanceId && existing.credit===input.expectedCredit) return existing;
      if (existing) throw new ApiError(409,'recycle_conflict','That request key belongs to a different recycle.');
    } catch(readError) { if (readError instanceof ApiError) throw readError; }
    throw new ApiError(503,'recycle_receipt_unavailable','The card may already have been recycled. Restore access and retry with the same request key.');
  }
  try {
    const saved=await receipt();
    if (saved) return saved;
  } catch { /* The committed result can be recovered using the same key. */ }
  throw new ApiError(503,'recycle_receipt_unavailable','The card may already have been recycled. Restore access and retry with the same request key.');
}

/** Explicitly stop a request only if its receipt has not won the transaction. */
export async function cancelRecycle(ctx:Ctx,input:RecycleInput) {
  const access=recycleAccess(ctx,input),existing=await recycleReceipt(ctx,input);
  if (existing) {
    if (existing.instance_id!==input.instanceId || existing.credit!==input.expectedCredit) throw new ApiError(409,'recycle_conflict','That request key belongs to a different recycle.');
    return {status:'completed' as const,receipt:existing};
  }
  await recycleReservation(ctx,input);
  const {user,scopeCte,scopeArgs,authority,authArgs,exactAgent,agentArgs}=access,now=nowIso();
  const results=await ctx.db.batch([
    ctx.db.prepare(`${scopeCte}, permitted AS MATERIALIZED (SELECT 1 FROM fb_card_instances ci WHERE ci.tenant_id=? AND ci.user_id=? AND ci.id=? AND ${authority} AND ${exactAgent})
      UPDATE fb_recycle_requests SET status='cancelled',updated_at=? WHERE tenant_id=? AND user_id=? AND idempotency_key=? AND instance_id=? AND expected_credit=? AND status='pending'
      AND EXISTS (SELECT 1 FROM permitted) AND NOT EXISTS (SELECT 1 FROM fb_recycle_receipts r WHERE r.tenant_id=? AND r.user_id=? AND r.idempotency_key=?)`)
      .bind(...scopeArgs,ctx.tenant.id,user.id,input.instanceId,...authArgs,...agentArgs,now,ctx.tenant.id,user.id,input.idempotencyKey,input.instanceId,input.expectedCredit,ctx.tenant.id,user.id,input.idempotencyKey),
    ctx.db.prepare(`INSERT INTO fb_audit_events(id,tenant_id,actor_type,actor_id,represented_user_id,action,object_type,object_id,metadata_json,request_id,created_at)
      SELECT ?,?,?,?,?,'recycle.cancelled','instance',?,'{}',?,? WHERE changes()=1`)
      .bind(newId('aud'),ctx.tenant.id,ctx.actor.type,ctx.actor.id,ctx.actor.representedUserId,input.instanceId,ctx.requestId,now),
    ctx.db.prepare(`${scopeCte}SELECT r.status FROM fb_recycle_requests r JOIN fb_card_instances ci ON ci.id=r.instance_id AND ci.tenant_id=r.tenant_id AND ci.user_id=r.user_id
      WHERE r.tenant_id=? AND r.user_id=? AND r.idempotency_key=? AND r.instance_id=? AND r.expected_credit=? AND ${authority} AND ${exactAgent}`)
      .bind(...scopeArgs,ctx.tenant.id,user.id,input.idempotencyKey,input.instanceId,input.expectedCredit,...authArgs,...agentArgs),
  ]);
  const status=(results[2]?.results?.[0] as {status:string}|undefined)?.status;
  if (status==='cancelled') return {status:'cancelled' as const};
  if (status==='completed') {
    const saved=await recycleReceipt(ctx,input);
    if (saved && saved.instance_id===input.instanceId && saved.credit===input.expectedCredit) return {status:'completed' as const,receipt:saved};
  }
  throw new ApiError(503,'recycle_resolution_unavailable','The result is not confirmed. Restore access and retry this same request.');
}

export async function setCounts(ctx: Ctx) {
  const user = ctx.user!;
  return all<{ card_id: string; count: number }>(
    ctx.db,
    "SELECT card_id, COUNT(*) AS count FROM fb_card_instances WHERE tenant_id = ? AND user_id = ? AND status IN ('owned','reserved') GROUP BY card_id",
    ctx.tenant.id,
    user.id,
  );
}

/**
 * Ordinary peer discovery. Deliberately excludes email, capabilities, wallet
 * and last-seen data: those belong to the privileged member-administration
 * route. Only active members are discoverable as trade partners.
 */
export async function listTenantMembers(ctx: Ctx) {
  const filter = await inventoryFilter(ctx, {}, 'inventory:read');
  return all<{ id: string; display_name: string; role: string }>(
    ctx.db,
    `SELECT u.id, u.display_name, m.role
       FROM fb_memberships m JOIN fb_users u ON u.id = m.user_id
      WHERE m.tenant_id = ? AND m.status = 'active' AND m.revoked_at IS NULL AND u.disabled_at IS NULL
        AND ${filter.principalSql}
        AND (? <> 'agent' OR EXISTS (SELECT 1 FROM fb_agent_tokens t WHERE t.id=? AND t.grant_id=? AND t.token_hash=? AND t.token_hash<>'' AND t.revoked_at IS NULL))
      ORDER BY u.display_name`,
    ctx.tenant.id,
    ...filter.principalArgs,
    ctx.actor.type, ctx.agentCredential?.tokenId ?? '', ctx.agentCredential?.grantId ?? '', ctx.agentCredential?.verifiedTokenHash ?? '',
  );
}

export async function getMemberTradeInventory(ctx: Ctx, memberId: string) {
  const {scopeCte,scopeArgs,authority,authArgs}=inventoryAccess(ctx,null,'inventory:read',undefined,true);
  return all<Pick<InventoryRow,'id'|'card_name'|'variant_name'|'serial'>>(
    ctx.db,
    `${scopeCte}SELECT ci.id,cd.name AS card_name,v.name AS variant_name,ci.serial
     FROM fb_card_instances ci JOIN fb_card_definitions cd ON cd.id=ci.card_id AND cd.tenant_id=ci.tenant_id
     JOIN fb_variants v ON v.id=ci.variant_id AND v.tenant_id=ci.tenant_id AND v.card_id=ci.card_id
     WHERE ci.tenant_id=? AND ci.user_id=? AND ci.status='owned' AND ci.locked=0 AND cd.status='published' AND cd.archived_at IS NULL
       AND v.status='published' AND v.archived_at IS NULL
       AND EXISTS (SELECT 1 FROM fb_memberships target JOIN fb_users tu ON tu.id=target.user_id AND tu.disabled_at IS NULL
         WHERE target.tenant_id=ci.tenant_id AND target.user_id=ci.user_id AND target.status='active' AND target.revoked_at IS NULL)
       AND ${authority}
       AND (? <> 'agent' OR EXISTS (SELECT 1 FROM fb_agent_tokens t WHERE t.id=? AND t.grant_id=? AND t.token_hash=? AND t.token_hash<>'' AND t.revoked_at IS NULL))
     ORDER BY ci.acquired_at DESC,ci.id DESC LIMIT 200`,
    ...scopeArgs,ctx.tenant.id,memberId,...authArgs,
    ctx.actor.type,ctx.agentCredential?.tokenId ?? '',ctx.agentCredential?.grantId ?? '',ctx.agentCredential?.verifiedTokenHash ?? '',
  );
}
