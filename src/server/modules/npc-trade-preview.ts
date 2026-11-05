import { ApiError, type Ctx } from "../context";
import { first } from "../db";
import { npcDiscordScope, npcTradeAuthority } from "./npc-trade-authority";

/** Count only copies whose own edition and source layers are currently usable.
 * A hidden second print must not affect a visible NPC decision. */
function visibleNpcCopies(cardSql: string, reservedTarget?: string, includeReserved = false) {
  const status = includeReserved
    ? "x.status IN ('owned','reserved')"
    : reservedTarget
      ? `(x.status='owned' OR (x.id=${reservedTarget}.id AND x.status='reserved' AND x.reserved_for=${reservedTarget}.reserved_for))`
      : "x.status='owned'";
  return `(SELECT COUNT(*) FROM fb_card_instances x
    JOIN fb_variants xv ON xv.id=x.variant_id AND xv.card_id=x.card_id AND xv.status='published' AND xv.archived_at IS NULL
    JOIN fb_artwork_editions xe ON xe.id=xv.edition_id AND xe.card_id=x.card_id AND xe.status='published' AND xe.archived_at IS NULL
    JOIN fb_assets xs ON xs.id=xe.subject_asset_id AND xs.tenant_id=xe.tenant_id AND xs.archived_at IS NULL
    LEFT JOIN fb_assets xb ON xb.id=xe.background_asset_id AND xb.tenant_id=xe.tenant_id AND xb.archived_at IS NULL
    WHERE x.tenant_id=n.tenant_id AND x.user_id=n.user_id AND x.card_id=${cardSql} AND ${status}
      AND (xe.background_asset_id IS NULL OR xb.id IS NOT NULL)
      AND (b.ai_art_enabled=1 OR NOT EXISTS (SELECT 1 FROM (SELECT xs.id AS asset_id UNION SELECT xb.id) layers JOIN fb_assets a ON a.id=layers.asset_id
        WHERE a.origin NOT IN ('sourced','foilbury_original') OR a.derivative_of_asset_id IS NOT NULL
          OR json_type(CASE WHEN json_valid(a.dependencies_json) THEN a.dependencies_json ELSE 'null' END)<>'array'
          OR json_array_length(CASE WHEN json_valid(a.dependencies_json) THEN a.dependencies_json ELSE '[]' END)<>0)))`;
}

/**
 * A read-only, single-copy offer assessment. This is deliberately not a
 * reservation or acceptance: a later exchange must recheck every fact in its
 * own transaction, and trading remains disabled until that path exists.
 */
export function npcTradeAssessmentQuery(
  ctx: Ctx,
  npcId: string,
  offeredId: string,
  requestedId: string,
  reservationId?: string,
  scan = false,
) {
  const user = ctx.user;
  if (
    !user ||
    ctx.actor.type !== "user" ||
    ctx.actor.id !== user.id ||
    ctx.actor.representedUserId !== user.id ||
    user.synthetic
  )
    throw new ApiError(403, "human_player_required", "A signed-in player must preview this offer.");
  if (!scan && offeredId === requestedId)
    throw new ApiError(422, "trade_item_duplicate", "Choose a different copy on each side.");
  const authority = npcTradeAuthority(ctx, "human", "n.tenant_id");
  const discordScope = npcDiscordScope(ctx);

  const sql = `SELECT n.name AS npc_name, n.id AS npc_id, offered.id AS offered_id, requested.id AS requested_id,
      oc.name AS offered_name, ov.name AS offered_variant, offered.serial AS offered_serial,
      rc.name AS requested_name, rv.name AS requested_variant, requested.serial AS requested_serial,
      ${visibleNpcCopies("requested.card_id", "requested")} AS requested_copies,
      (${visibleNpcCopies("offered.card_id", undefined, true)}>0) AS already_has_subject
    FROM fb_npc_collectors n
    JOIN fb_bots b ON b.id=n.bot_id AND b.tenant_id=n.tenant_id AND b.status='active'
    JOIN fb_users human ON human.id=? AND human.disabled_at IS NULL AND human.is_synthetic=0
    JOIN fb_memberships member ON member.tenant_id=n.tenant_id AND member.user_id=human.id AND member.status='active' AND member.revoked_at IS NULL
    JOIN fb_users synthetic ON synthetic.id=n.user_id AND synthetic.is_synthetic=1 AND synthetic.disabled_at IS NULL
    JOIN fb_memberships nm ON nm.tenant_id=n.tenant_id AND nm.user_id=n.user_id AND nm.status='active' AND nm.revoked_at IS NULL
    JOIN fb_card_instances offered ON ${scan ? "1=1" : "offered.id=?"} AND offered.tenant_id=n.tenant_id AND offered.user_id=human.id AND offered.locked=0 AND ${reservationId ? "offered.status='reserved' AND offered.reserved_for=?" : "offered.status='owned' AND offered.reserved_for IS NULL"}
    JOIN fb_card_instances requested ON ${scan ? "1=1" : "requested.id=?"} AND requested.tenant_id=n.tenant_id AND requested.user_id=n.user_id AND requested.locked=0 AND ${reservationId ? "requested.status='reserved' AND requested.reserved_for=?" : "requested.status='owned' AND requested.reserved_for IS NULL"}
    JOIN fb_card_definitions oc ON oc.id=offered.card_id AND oc.status='published' AND oc.archived_at IS NULL
    JOIN fb_card_definitions rc ON rc.id=requested.card_id AND rc.status='published' AND rc.archived_at IS NULL
    JOIN fb_variants ov ON ov.id=offered.variant_id AND ov.card_id=oc.id AND ov.status='published' AND ov.archived_at IS NULL
    JOIN fb_variants rv ON rv.id=requested.variant_id AND rv.card_id=rc.id AND rv.status='published' AND rv.archived_at IS NULL
    JOIN fb_artwork_editions oe ON oe.id=ov.edition_id AND oe.card_id=oc.id AND oe.status='published' AND oe.archived_at IS NULL
    JOIN fb_artwork_editions re ON re.id=rv.edition_id AND re.card_id=rc.id AND re.status='published' AND re.archived_at IS NULL
    JOIN fb_assets os ON os.id=oe.subject_asset_id AND os.tenant_id=oe.tenant_id AND os.archived_at IS NULL
    JOIN fb_assets rs ON rs.id=re.subject_asset_id AND rs.tenant_id=re.tenant_id AND rs.archived_at IS NULL
    LEFT JOIN fb_assets ob ON ob.id=oe.background_asset_id AND ob.tenant_id=oe.tenant_id AND ob.archived_at IS NULL
    LEFT JOIN fb_assets rb ON rb.id=re.background_asset_id AND rb.tenant_id=re.tenant_id AND rb.archived_at IS NULL
    WHERE n.id=? AND n.tenant_id=? AND n.status='active' AND COALESCE((SELECT paused_all FROM fb_npc_limits WHERE tenant_id=n.tenant_id),0)=0
      AND (oe.background_asset_id IS NULL OR ob.id IS NOT NULL) AND (re.background_asset_id IS NULL OR rb.id IS NOT NULL)
      AND ${authority.sql}
      AND ${discordScope.sql}
      AND (b.ai_art_enabled=1 OR NOT EXISTS (
        SELECT 1 FROM (SELECT os.id AS asset_id UNION SELECT rs.id UNION SELECT ob.id UNION SELECT rb.id) layers
        JOIN fb_assets a ON a.id=layers.asset_id
        WHERE a.origin NOT IN ('sourced','foilbury_original') OR a.derivative_of_asset_id IS NOT NULL
          OR json_type(CASE WHEN json_valid(a.dependencies_json) THEN a.dependencies_json ELSE 'null' END)<>'array'
          OR json_array_length(CASE WHEN json_valid(a.dependencies_json) THEN a.dependencies_json ELSE '[]' END)<>0))
      AND NOT EXISTS (SELECT 1 FROM (SELECT offered.card_id AS card_id UNION SELECT requested.card_id) item
        WHERE NOT EXISTS (SELECT 1 FROM fb_collection_cards cc WHERE cc.card_id=item.card_id)
          OR EXISTS (SELECT 1 FROM fb_collection_cards cc LEFT JOIN fb_collections c ON c.id=cc.collection_id
            LEFT JOIN fb_bot_collections bc ON bc.collection_id=c.id AND bc.bot_id=b.id AND bc.enabled=1
            WHERE cc.card_id=item.card_id AND (c.id IS NULL OR c.status<>'published' OR c.archived_at IS NOT NULL OR bc.bot_id IS NULL
              OR NOT (c.scope='global' OR (c.scope='bot' AND c.owner_tenant_id=n.tenant_id))
              OR NOT ((c.view_audience='public' AND c.public_approved_at IS NOT NULL)
                OR (c.view_audience='members' AND (c.scope='global' OR c.owner_tenant_id=n.tenant_id))))))`;
  return {
    sql,
    args: [
      user.id,
      ...(scan ? [] : [offeredId]),
      ...(reservationId ? [reservationId] : []),
      ...(scan ? [] : [requestedId]),
      ...(reservationId ? [reservationId] : []),
      npcId,
      ctx.tenant.id,
      ...authority.args,
      ...discordScope.args,
    ],
  };
}

/** Limit each side only after all current audience and source checks. */
export function npcTradeCandidateQuery(ctx: Ctx, npcId: string, side: "player" | "npc") {
  const user = ctx.user;
  if (
    !user ||
    ctx.actor.type !== "user" ||
    ctx.actor.id !== user.id ||
    ctx.actor.representedUserId !== user.id ||
    user.synthetic
  )
    throw new ApiError(403, "human_player_required", "A signed-in player must browse offers.");
  const authority = npcTradeAuthority(ctx, "human", "n.tenant_id"),
    discordScope = npcDiscordScope(ctx, ["ci.card_id"]);
  const interest =
    side === "player"
      ? `${visibleNpcCopies("ci.card_id", undefined, true)}=0`
      : `${visibleNpcCopies("ci.card_id")}>1`;
  const sql = `SELECT ci.id FROM fb_npc_collectors n
    JOIN fb_bots b ON b.id=n.bot_id AND b.tenant_id=n.tenant_id AND b.status='active'
    JOIN fb_users human ON human.id=? AND human.disabled_at IS NULL AND human.is_synthetic=0
    JOIN fb_memberships member ON member.tenant_id=n.tenant_id AND member.user_id=human.id AND member.status='active' AND member.revoked_at IS NULL
    JOIN fb_users synthetic ON synthetic.id=n.user_id AND synthetic.is_synthetic=1 AND synthetic.disabled_at IS NULL
    JOIN fb_memberships nm ON nm.tenant_id=n.tenant_id AND nm.user_id=n.user_id AND nm.status='active' AND nm.revoked_at IS NULL
    JOIN fb_card_instances ci ON ci.tenant_id=n.tenant_id AND ci.user_id=${side === "player" ? "human.id" : "n.user_id"} AND ci.status='owned' AND ci.locked=0 AND ci.reserved_for IS NULL
    JOIN fb_card_definitions cd ON cd.id=ci.card_id AND cd.status='published' AND cd.archived_at IS NULL
    JOIN fb_variants v ON v.id=ci.variant_id AND v.card_id=cd.id AND v.status='published' AND v.archived_at IS NULL
    JOIN fb_artwork_editions e ON e.id=v.edition_id AND e.card_id=cd.id AND e.status='published' AND e.archived_at IS NULL
    JOIN fb_assets source ON source.id=e.subject_asset_id AND source.tenant_id=e.tenant_id AND source.archived_at IS NULL
    LEFT JOIN fb_assets bg ON bg.id=e.background_asset_id AND bg.tenant_id=e.tenant_id AND bg.archived_at IS NULL
    WHERE n.id=? AND n.tenant_id=? AND n.status='active' AND COALESCE((SELECT paused_all FROM fb_npc_limits WHERE tenant_id=n.tenant_id),0)=0
      AND (e.background_asset_id IS NULL OR bg.id IS NOT NULL) AND ${authority.sql} AND ${discordScope.sql}
      AND (b.ai_art_enabled=1 OR NOT EXISTS (SELECT 1 FROM (SELECT source.id AS asset_id UNION SELECT bg.id) layers JOIN fb_assets a ON a.id=layers.asset_id
        WHERE a.origin NOT IN ('sourced','foilbury_original') OR a.derivative_of_asset_id IS NOT NULL
          OR json_type(CASE WHEN json_valid(a.dependencies_json) THEN a.dependencies_json ELSE 'null' END)<>'array'
          OR json_array_length(CASE WHEN json_valid(a.dependencies_json) THEN a.dependencies_json ELSE '[]' END)<>0))
      AND EXISTS (SELECT 1 FROM fb_collection_cards cc WHERE cc.card_id=ci.card_id)
      AND NOT EXISTS (SELECT 1 FROM fb_collection_cards cc LEFT JOIN fb_collections c ON c.id=cc.collection_id
        LEFT JOIN fb_bot_collections bc ON bc.collection_id=c.id AND bc.bot_id=b.id AND bc.enabled=1
        WHERE cc.card_id=ci.card_id AND (c.id IS NULL OR c.status<>'published' OR c.archived_at IS NOT NULL OR bc.bot_id IS NULL
          OR NOT (c.scope='global' OR (c.scope='bot' AND c.owner_tenant_id=n.tenant_id))
          OR NOT ((c.view_audience='public' AND c.public_approved_at IS NOT NULL)
            OR (c.view_audience='members' AND (c.scope='global' OR c.owner_tenant_id=n.tenant_id)))))
      AND ${interest} ORDER BY ci.id LIMIT 24`;
  return { sql, args: [user.id, npcId, ctx.tenant.id, ...authority.args, ...discordScope.args] };
}

export async function previewNpcTrade(
  ctx: Ctx,
  npcId: string,
  offeredId: string,
  requestedId: string,
) {
  const query = npcTradeAssessmentQuery(ctx, npcId, offeredId, requestedId);
  const row = await first<{
    npc_name: string;
    offered_name: string;
    offered_variant: string;
    offered_serial: string;
    requested_name: string;
    requested_variant: string;
    requested_serial: string;
    requested_copies: number;
    already_has_subject: number;
  }>(ctx.db, query.sql, ...query.args);
  if (!row)
    throw new ApiError(
      404,
      "npc_offer_unavailable",
      "That collector or one of the chosen copies is not available.",
    );
  const interested = row.requested_copies > 1 && !row.already_has_subject;
  return {
    npc: { id: npcId, name: row.npc_name, label: "NPC collector" },
    give: {
      instance_id: offeredId,
      card_name: row.offered_name,
      variant_name: row.offered_variant,
      serial: row.offered_serial,
    },
    receive: {
      instance_id: requestedId,
      card_name: row.requested_name,
      variant_name: row.requested_variant,
      serial: row.requested_serial,
    },
    decision: interested ? "interested" : "declined",
    reason:
      row.requested_copies <= 1
        ? "This collector has no eligible spare to offer."
        : row.already_has_subject
          ? "This collector already has an eligible copy of that subject."
          : "This collector is interested and has an eligible spare.",
    preview_only: true,
    message: "This is an estimate, not a trade. No copies were reserved or transferred.",
  };
}
