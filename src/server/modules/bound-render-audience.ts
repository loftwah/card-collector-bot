import type { Ctx } from "../context";
import { ApiError } from "../context";

/** Live private-collection intersection for a renderer/reviewer. The caller
 * must independently fence the exact session or agent credential. */
export function boundRenderAudienceFence(ctx: Ctx, cardId: string) {
  if (
    !ctx.user ||
    ctx.actor.representedUserId !== ctx.user.id ||
    (ctx.actor.type === "user" && ctx.actor.id !== ctx.user.id) ||
    !["user", "agent"].includes(ctx.actor.type)
  )
    throw new ApiError(403, "render_audience_unavailable", "The render audience is unavailable.");
  const p = JSON.stringify({
    tenant: ctx.tenant.id,
    user: ctx.user.id,
    actor: ctx.actor.type,
    card: cardId,
  });
  const safeScopes = "CASE WHEN json_valid(pr.scopes_json) THEN pr.scopes_json ELSE '{}' END";
  return {
    sql: `NOT EXISTS (SELECT 1 FROM fb_collection_cards cc JOIN fb_collections c ON c.id=cc.collection_id
    CROSS JOIN (SELECT json(?) AS p) x WHERE cc.card_id=json_extract(x.p,'$.card') AND c.view_audience='private' AND NOT (
      (json_extract(x.p,'$.actor')='user' AND EXISTS (SELECT 1 FROM fb_users u JOIN fb_platform_admins pa ON pa.user_id=u.id
        WHERE u.id=json_extract(x.p,'$.user') AND u.platform_admin=1 AND u.disabled_at IS NULL AND pa.status='active' AND pa.revoked_at IS NULL))
      OR EXISTS (SELECT 1 FROM fb_collection_viewers cv WHERE cv.collection_id=c.id AND cv.user_id=json_extract(x.p,'$.user') AND cv.revoked_at IS NULL)
      OR (c.scope='global' AND EXISTS (SELECT 1 FROM fb_platform_role_assignments pr WHERE pr.user_id=json_extract(x.p,'$.user') AND pr.role='global_collection_admin'
        AND pr.status='active' AND pr.revoked_at IS NULL AND json_valid(pr.scopes_json) AND
        (json_type(${safeScopes},'$.all')='true' OR (json_type(${safeScopes},'$.all')='false' AND json_type(${safeScopes},'$.collectionIds')='array'
          AND NOT EXISTS (SELECT 1 FROM json_each(${safeScopes},'$.collectionIds') WHERE type<>'text')
          AND EXISTS (SELECT 1 FROM json_each(${safeScopes},'$.collectionIds') WHERE value=c.id)))))
      OR (c.scope='bot' AND c.owner_tenant_id=json_extract(x.p,'$.tenant') AND EXISTS (
        SELECT 1 FROM fb_memberships m JOIN fb_bots b ON b.tenant_id=m.tenant_id AND b.status='active'
        LEFT JOIN fb_bot_admins ba ON ba.bot_id=b.id AND ba.user_id=m.user_id
        WHERE m.tenant_id=c.owner_tenant_id AND m.user_id=json_extract(x.p,'$.user') AND m.status='active' AND m.revoked_at IS NULL AND
        ((m.role='owner' AND b.owner_user_id=m.user_id) OR (m.role<>'owner' AND json_type(CASE WHEN json_valid(m.capabilities_json) THEN m.capabilities_json ELSE 'null' END)='array'
          AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(m.capabilities_json) THEN m.capabilities_json ELSE '[]' END) WHERE type<>'text')
          AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(m.capabilities_json) THEN m.capabilities_json ELSE '[]' END) WHERE value='content')
          AND ba.role='admin' AND ba.status='active' AND ba.revoked_at IS NULL
          AND json_type(CASE WHEN json_valid(ba.capabilities_json) THEN ba.capabilities_json ELSE 'null' END)='array'
          AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(ba.capabilities_json) THEN ba.capabilities_json ELSE '[]' END) WHERE type<>'text')
          AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(ba.capabilities_json) THEN ba.capabilities_json ELSE '[]' END) WHERE value='content')))))
    ))`,
    args: [p],
  };
}
