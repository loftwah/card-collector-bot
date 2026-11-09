import type { Ctx } from "../context";
import { all, first } from "../db";
import { sha256Hex } from "../ids";
import { canViewCard, canViewCollection, cardVisibilitySql, effectiveCardAudience, viewerAccess } from "./visibility";
import { liveViewerContext } from "./live-viewer";
import { DRAW_EPOCH_TRIGGER_CHECK, DRAW_EPOCH_TRIGGER_DATA } from './draw-scope-epoch';

export interface ShareView {
  active: boolean;
  visible: boolean;
  publicView: boolean;
  ownerDisplayName: string | null;
  link: {
    id: string;
    user_id: string;
    status: string;
    expires_at: string;
    kind: string;
    target_id: string | null;
    created_at: string;
  } | null;
  payload: Record<string, any>;
  collection: {
    id: string;
    slug: string;
    name: string;
    view_audience: string;
    public_approved_at: string | null;
    logo_url: string | null;
    description: string;
  } | null;
  showSerial: boolean;
}

function objectPayload(value: string | null | undefined): Record<string, any> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, any>)
      : {};
  } catch {
    return {};
  }
}

async function visibleWishlistItems(ctx: Ctx, ownerCtx: Ctx, payload: Record<string, any>) {
  const items = Array.isArray(payload.items) ? payload.items.slice(0, 100).filter((item: unknown): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item))) : [];
  // Historical entries lack a stable identity. A slug/name cannot prove that a
  // later card is the same object, so those entries remain suppressed.
  const ids = [...new Set(items.map((item: Record<string, unknown>) => item.card_id).filter((id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 100))];
  if (!ids.length) return [];
  async function allowed(actor: Ctx) {
    const predicate = cardVisibilitySql(await viewerAccess(actor, { liveContentAdmin: true }));
    const chunkSize = Math.min(20, 90 - predicate.params.length - 1);
    // D1's parameter ceiling is finite. When the visibility predicate alone is
    // too large, suppress rather than return unchecked snapshot content.
    if (chunkSize < 1) return new Set<string>();
    const result = new Set<string>();
    for (let index = 0; index < ids.length; index += chunkSize) {
      const chunk = ids.slice(index, index + chunkSize);
      const rows = await all<{ id: string }>(ctx.db, `SELECT cd.id FROM fb_card_definitions cd WHERE cd.tenant_id = ? AND cd.id IN (${chunk.map(() => "?").join(",")}) AND cd.status = 'published' AND cd.archived_at IS NULL AND (${predicate.sql})`, ctx.tenant.id, ...chunk, ...predicate.params);
      for (const row of rows) result.add(row.id);
    }
    return result;
  }
  const [ownerAllowed, viewerAllowed] = await Promise.all([allowed(ownerCtx), allowed(ctx)]);
  return items.filter((item: Record<string, unknown>) => typeof item.card_id === "string" && ownerAllowed.has(item.card_id) && viewerAllowed.has(item.card_id))
    .map(({ card_id: _id, ...item }: Record<string, unknown>) => item);
}

/**
 * One canonical resolution policy for every share token. HTML, unfurls and the
 * member view call this helper; a blocked image never substitutes for it.
 *
 * A share is a snapshot of an explicitly chosen object, but membership,
 * collection audience, link status, expiry and the owner's current membership
 * are all re-checked on every read.
 */
export async function resolveShareView(ctx: Ctx, rawToken: string): Promise<ShareView> {
  const tokenHash = await sha256Hex(rawToken);
  const link = await first<{
    id: string;
    user_id: string;
    status: string;
    expires_at: string;
    kind: string;
    target_id: string | null;
    payload_json: string;
    created_at: string;
  }>(
    ctx.db,
    "SELECT id, user_id, status, expires_at, kind, target_id, payload_json, created_at FROM fb_share_links WHERE tenant_id = ? AND token_hash = ?",
    ctx.tenant.id,
    tokenHash,
  );

  const notActive: ShareView = {
    active: false,
    visible: false,
    publicView: false,
    ownerDisplayName: null,
    link: null,
    payload: {},
    collection: null,
    showSerial: false,
  };
  if (!link) return notActive;

  // Decisions below span several queries. Capture the monotonic policy clocks
  // before making them and verify them again before returning any metadata.
  let epoch: {global_revision:number;tenant_revision:number;owner_revision:number;viewer_revision:number} | null=null;
  try {
    epoch=await first(ctx.db,`SELECT g.revision AS global_revision,
      COALESCE((SELECT revision FROM fb_draw_scope_tenant_epochs WHERE tenant_id=?),0) AS tenant_revision,
      COALESCE((SELECT revision FROM fb_draw_scope_user_epochs WHERE user_id=?),0) AS owner_revision,
      COALESCE((SELECT revision FROM fb_draw_scope_user_epochs WHERE user_id=?),0) AS viewer_revision
      FROM fb_draw_scope_global_epoch g WHERE g.id=1 AND ${DRAW_EPOCH_TRIGGER_CHECK}`,
      ctx.tenant.id,link.user_id,ctx.user?.id ?? '',DRAW_EPOCH_TRIGGER_DATA);
  } catch(error) {
    if (!/no such table: fb_draw_scope_(?:global_epoch|tenant_epochs|user_epochs)\b/.test(String(error))) throw error;
  }
  if (!epoch) return notActive;

  const [owner, ownerMembership] = await Promise.all([
    first<{ display_name: string }>(ctx.db, "SELECT display_name FROM fb_users WHERE id = ? AND disabled_at IS NULL", link.user_id),
    first<{ status: string }>(ctx.db, "SELECT status FROM fb_memberships WHERE tenant_id = ? AND user_id = ?", ctx.tenant.id, link.user_id),
  ]);
  const active =
    link.status === "active" &&
    new Date(link.expires_at) > new Date() &&
    ownerMembership?.status === "active" &&
    Boolean(owner);
  if (!active) return notActive;

  let payload = objectPayload(link.payload_json);
  let achievementFence: {achievementId:string;version:number;earnedAt:string;criteria:string;visibility:string} | null=null;
  const ownerCtx = await liveViewerContext(ctx, link.user_id);
  if (!ownerCtx) return notActive;
  const viewerCtx = ctx.user ? await liveViewerContext(ctx, ctx.user.id) : null;
  const collectionId = typeof payload.collection_id === "string" ? payload.collection_id : null;
  const collection = collectionId
    ? await first<{
        id: string;
        slug: string;
        name: string;
        view_audience: string;
        status: string;
        public_approved_at: string | null;
        logo_url: string | null;
        description: string;
      }>(
        ctx.db,
        "SELECT id, slug, name, view_audience, status, public_approved_at, logo_url, description FROM fb_collections WHERE id = ? AND archived_at IS NULL",
        collectionId,
      )
    : null;

  const currentPublic = Boolean(collection && collection.status === "published" && collection.view_audience === "public" && collection.public_approved_at);
  const capturedPublic = payload.audience === "public";
  let publicView =
    capturedPublic &&
    (link.kind === "card" || link.kind === "latest" || link.kind === "collection") &&
    currentPublic;

  let visible = publicView;
  if (!visible && viewerCtx?.user) {
    const access = await viewerAccess(viewerCtx, { liveContentAdmin: true });
    const memberHere = access.memberTenantIds.has(ctx.tenant.id);
    if (viewerCtx.user.id === link.user_id) visible = true;
    else if (link.kind === "card" || link.kind === "latest") {
      visible = collectionId ? Boolean(await canViewCollection(viewerCtx, collectionId, { liveContentAdmin: true })) : memberHere;
    } else if (link.kind === "collection") {
      visible = Boolean(collectionId && (await canViewCollection(viewerCtx, collectionId, { liveContentAdmin: true })));
    } else {
      visible = memberHere;
    }
  }

  if (link.kind === "card" || link.kind === "latest") {
    const cardId = typeof payload.card_id === "string" ? payload.card_id : null;
    const published = cardId && await first<{ id: string }>(ctx.db, "SELECT id FROM fb_card_definitions WHERE id = ? AND tenant_id = ? AND status = 'published' AND archived_at IS NULL", cardId, ctx.tenant.id);
    if (!cardId || !published || !(await canViewCard(ownerCtx, cardId, { liveContentAdmin: true }))) visible = publicView = false;
    else {
      if (publicView && await effectiveCardAudience(ctx, cardId) !== "public") {
        publicView = false;
        visible = Boolean(viewerCtx && await canViewCard(viewerCtx, cardId, { liveContentAdmin: true }));
      }
      if (visible && !publicView && (!viewerCtx || !(await canViewCard(viewerCtx, cardId, { liveContentAdmin: true })))) visible = false;
    }
    if (!viewerCtx || viewerCtx.user?.id !== link.user_id) { const { serial: _serial, ...safePayload } = payload; payload = safePayload; }
  }
  if (link.kind === "collection") {
    if (!collectionId || !collection || collection.status !== "published" || !(await canViewCollection(ownerCtx, collectionId, { liveContentAdmin: true }))) visible = publicView = false;
    else if (visible && !publicView && (!viewerCtx || !(await canViewCollection(viewerCtx, collectionId, { liveContentAdmin: true })))) visible = false;
  }
  if (link.kind === "wishlist") {
    const items=visible && viewerCtx ? await visibleWishlistItems(viewerCtx, ownerCtx, payload) : [];
    payload = { label:'Wishlist', audience:'member', captured_at:payload.captured_at,
      items:items.map(item=>({card_name:item.card_name,card_slug:item.card_slug,target:item.target ? 'Selected finish' : null})) };
  }
  if (link.kind === "cabinet") visible = publicView = false;
  if (link.kind === "profile") {
    if (payload.profile_version !== 1 || !Array.isArray(payload.favourite_cards) || !viewerCtx || !visible) visible = publicView = false;
    else {
      const cards = payload.favourite_cards.slice(0, 8).filter((item: unknown) => item && typeof item === "object" && !Array.isArray(item)).map((item: Record<string, unknown>) => ({ card_id: item.card_id, name: item.name, variant_name: item.variant_name, render_url: item.render_url }));
      payload = { label: "Pinned cards", captured_at: payload.captured_at, favourite_cards: await visibleWishlistItems(viewerCtx, ownerCtx, { items: cards }) };
    }
  }
  if (link.kind === "achievement") {
    if (!visible || !viewerCtx || payload.achievement_version !== 1 || typeof payload.achievement_id !== "string" || (typeof payload.criteria_hash !== "string" || !/^[a-f0-9]{64}$/.test(payload.criteria_hash)) || !link.target_id) visible = publicView = false;
    else {
      const { authorizedAchievementShare } = await import("./achievement-share");
      const achievement = await authorizedAchievementShare(ownerCtx, viewerCtx, link.target_id, payload.criteria_hash);
      if (!achievement || achievement.achievementId !== payload.achievement_id) visible = publicView = false;
      else { achievementFence=achievement.fence; payload = { ...achievement.payload, captured_at: payload.captured_at }; }
    }
  }
  if (!visible) payload = {};

  const access=ctx.sessionAssurance==='access' && ctx.accessStatus==='linked' ? ctx.accessIdentity : null;
  const final=await first<{ok:number}>(ctx.db,`SELECT 1 AS ok FROM fb_share_links l
    JOIN fb_users owner ON owner.id=l.user_id AND owner.disabled_at IS NULL
    JOIN fb_memberships om ON om.tenant_id=l.tenant_id AND om.user_id=l.user_id AND om.status='active' AND om.revoked_at IS NULL
    JOIN fb_draw_scope_global_epoch g ON g.id=1 AND g.revision=?
    WHERE l.id=? AND l.tenant_id=? AND l.token_hash=? AND l.status='active' AND l.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND l.user_id=? AND l.kind=? AND l.target_id IS ? AND l.payload_json=? AND l.expires_at=?
      AND COALESCE((SELECT revision FROM fb_draw_scope_tenant_epochs WHERE tenant_id=l.tenant_id),0)=?
      AND COALESCE((SELECT revision FROM fb_draw_scope_user_epochs WHERE user_id=l.user_id),0)=?
      AND COALESCE((SELECT revision FROM fb_draw_scope_user_epochs WHERE user_id=?),0)=? AND ${DRAW_EPOCH_TRIGGER_CHECK}
      AND (?<>'achievement' OR ?=0 OR EXISTS (SELECT 1 FROM fb_achievement_unlocks u JOIN fb_achievement_definitions d ON d.id=u.achievement_id AND d.version=u.achievement_version
        WHERE u.id=l.target_id AND u.tenant_id=l.tenant_id AND u.user_id=l.user_id AND u.achievement_id=? AND u.achievement_version=? AND u.earned_at=?
          AND d.status='active' AND d.archived_at IS NULL AND (d.scope='platform' OR (d.scope='bot' AND d.tenant_id=l.tenant_id)) AND d.criteria_json=? AND d.visibility=?))
      AND (?=1 OR (?='user' AND ?=? AND ?=? AND EXISTS (SELECT 1 FROM fb_memberships vm JOIN fb_users vu ON vu.id=vm.user_id AND vu.disabled_at IS NULL
        WHERE vm.tenant_id=l.tenant_id AND vm.user_id=? AND vm.status='active' AND vm.revoked_at IS NULL AND (
          EXISTS (SELECT 1 FROM fb_sessions s WHERE s.id=? AND s.user_id=vu.id AND s.tenant_id=vm.tenant_id AND s.revoked_at IS NULL AND s.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
          OR (?='access' AND ?>unixepoch('now') AND EXISTS (SELECT 1 FROM fb_access_identities ai WHERE ai.user_id=vu.id AND ai.team_domain=? AND ai.subject=? AND ai.email=? AND ai.revoked_at IS NULL) AND vu.email=? COLLATE NOCASE)
          OR EXISTS (SELECT 1 FROM fb_discord_identities di WHERE di.tenant_id=vm.tenant_id AND di.user_id=vu.id AND di.discord_user_id=? AND di.revoked_at IS NULL))))
      OR (?='agent' AND ?=? AND EXISTS (SELECT 1 FROM fb_memberships am JOIN fb_users au ON au.id=am.user_id AND au.disabled_at IS NULL
        JOIN fb_agent_tokens t ON t.id=? AND t.token_hash=? AND t.token_hash<>'' AND t.revoked_at IS NULL JOIN fb_agent_grants ag ON ag.id=t.grant_id
        WHERE am.tenant_id=l.tenant_id AND am.user_id=? AND am.status='active' AND am.revoked_at IS NULL AND ag.id=? AND ag.agent_id=?
          AND ag.represented_user_id=au.id AND ag.tenant_id=am.tenant_id AND ag.status='active' AND ag.revoked_at IS NULL AND ag.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
          AND json_type(CASE WHEN json_valid(ag.scopes_json) THEN ag.scopes_json ELSE 'null' END)='array'
          AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(ag.scopes_json) THEN ag.scopes_json ELSE '[]' END) WHERE type<>'text')
          AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(ag.scopes_json) THEN ag.scopes_json ELSE '[]' END) WHERE value=?))))`,
    epoch.global_revision,link.id,ctx.tenant.id,tokenHash,link.user_id,link.kind,link.target_id,link.payload_json,link.expires_at,
    epoch.tenant_revision,epoch.owner_revision,ctx.user?.id ?? '',epoch.viewer_revision,DRAW_EPOCH_TRIGGER_DATA,
    link.kind,visible ? 1:0,achievementFence?.achievementId ?? '',achievementFence?.version ?? -1,achievementFence?.earnedAt ?? '',achievementFence?.criteria ?? '',achievementFence?.visibility ?? '',
    (!ctx.user && publicView) || !visible ? 1:0,ctx.actor.type,ctx.actor.id,ctx.user?.id ?? '',ctx.actor.representedUserId,ctx.user?.id ?? '',ctx.user?.id ?? '',ctx.sessionId,ctx.sessionAssurance,access?.payload.exp ?? 0,
    ctx.config.access.teamDomain,access?.subject ?? '',access?.email ?? '',access?.email ?? '',ctx.discordPrincipal?.discordUserId ?? '',
    ctx.actor.type,ctx.actor.representedUserId,ctx.user?.id ?? '',ctx.agentCredential?.tokenId ?? '',ctx.agentCredential?.verifiedTokenHash ?? '',ctx.user?.id ?? '',ctx.agentCredential?.grantId ?? '',ctx.actor.id,
    link.kind==='collection'?'content:read':'inventory:read');
  if (!final) return notActive;
  if (!visible) return {...notActive,active:true};

  return {
    active,
    visible,
    publicView,
    ownerDisplayName: owner?.display_name ?? null,
    link: {
      id: link.id,
      user_id: link.user_id,
      status: link.status,
      expires_at: link.expires_at,
      kind: link.kind,
      target_id: link.target_id,
      created_at: link.created_at,
    },
    payload,
    collection: visible ? collection : null,
    showSerial: visible && (link.kind === "card" || link.kind === "latest") && ctx.user?.id === link.user_id,
  };
}
