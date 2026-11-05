import { ApiError, type Ctx } from "../context";
import { first } from "../db";
import { npcDiscordScope, npcTradeAuthority } from "./npc-trade-authority";

function boundedCardCollections(cardSql:string) {
  return `(SELECT COUNT(*) FROM (SELECT rowid FROM fb_collection_cards INDEXED BY fb_collection_cards_card_idx WHERE card_id=${cardSql} LIMIT 17)) BETWEEN 1 AND 16`;
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
      rc.name AS requested_name, rv.name AS requested_variant, requested.serial AS requested_serial, requested.card_id AS requested_card_id,
      CASE WHEN offered.card_id=requested.card_id THEN 'same_subject'
        WHEN oc.tenant_id<>rc.tenant_id THEN 'catalogue_mismatch'
        WHEN oc.rarity_id IS NULL OR rc.rarity_id IS NULL OR orarity.id IS NULL OR rrarity.id IS NULL OR oc.rarity_id<>rc.rarity_id THEN 'rarity_mismatch'
        WHEN om.id IS NULL OR rm.id IS NULL OR ov.material_id<>rv.material_id OR ov.effect_id IS NOT rv.effect_id OR (ov.effect_id IS NOT NULL AND (ofx.id IS NULL OR rfx.id IS NULL)) THEN 'finish_mismatch' ELSE 'interested' END AS decision_reason
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
    LEFT JOIN fb_rarities orarity ON orarity.id=oc.rarity_id AND orarity.tenant_id=oc.tenant_id AND orarity.archived_at IS NULL
    LEFT JOIN fb_rarities rrarity ON rrarity.id=rc.rarity_id AND rrarity.tenant_id=rc.tenant_id AND rrarity.archived_at IS NULL
    LEFT JOIN fb_materials om ON om.id=ov.material_id AND om.tenant_id=ov.tenant_id AND om.archived_at IS NULL
    LEFT JOIN fb_materials rm ON rm.id=rv.material_id AND rm.tenant_id=rv.tenant_id AND rm.archived_at IS NULL
    LEFT JOIN fb_effects ofx ON ofx.id=ov.effect_id AND ofx.tenant_id=ov.tenant_id AND ofx.archived_at IS NULL
    LEFT JOIN fb_effects rfx ON rfx.id=rv.effect_id AND rfx.tenant_id=rv.tenant_id AND rfx.archived_at IS NULL
    JOIN fb_artwork_editions oe ON oe.id=ov.edition_id AND oe.card_id=oc.id AND oe.status='published' AND oe.archived_at IS NULL
    JOIN fb_artwork_editions re ON re.id=rv.edition_id AND re.card_id=rc.id AND re.status='published' AND re.archived_at IS NULL
    JOIN fb_assets os ON os.id=oe.subject_asset_id AND os.tenant_id=oe.tenant_id AND os.archived_at IS NULL
    JOIN fb_assets rs ON rs.id=re.subject_asset_id AND rs.tenant_id=re.tenant_id AND rs.archived_at IS NULL
    LEFT JOIN fb_assets ob ON ob.id=oe.background_asset_id AND ob.tenant_id=oe.tenant_id AND ob.archived_at IS NULL
    LEFT JOIN fb_assets rb ON rb.id=re.background_asset_id AND rb.tenant_id=re.tenant_id AND rb.archived_at IS NULL
    WHERE n.id=? AND n.tenant_id=? AND n.status='active' AND COALESCE((SELECT paused_all FROM fb_npc_limits WHERE tenant_id=n.tenant_id),0)=0
      AND (oe.background_asset_id IS NULL OR ob.id IS NOT NULL) AND (re.background_asset_id IS NULL OR rb.id IS NOT NULL)
      AND ${boundedCardCollections("offered.card_id")} AND ${boundedCardCollections("requested.card_id")}
      AND ${authority.sql}
      AND ${discordScope.sql}
      AND (b.ai_art_enabled=1 OR NOT EXISTS (
        SELECT 1 FROM (SELECT os.id AS asset_id UNION SELECT rs.id UNION SELECT ob.id UNION SELECT rb.id) layers
        JOIN fb_assets a ON a.id=layers.asset_id
        WHERE a.origin NOT IN ('sourced','foilbury_original') OR a.derivative_of_asset_id IS NOT NULL
          OR json_type(CASE WHEN length(a.dependencies_json)<=4096 AND json_valid(a.dependencies_json) THEN a.dependencies_json ELSE 'null' END)<>'array'
          OR json_array_length(CASE WHEN length(a.dependencies_json)<=4096 AND json_valid(a.dependencies_json) THEN a.dependencies_json ELSE '[]' END)<>0))
      AND NOT EXISTS (SELECT 1 FROM (SELECT offered.card_id AS card_id UNION SELECT requested.card_id) item
        WHERE NOT EXISTS (SELECT 1 FROM fb_collection_cards cc WHERE cc.card_id=item.card_id)
          OR EXISTS (SELECT 1 FROM fb_collection_cards cc LEFT JOIN fb_collections c ON c.id=cc.collection_id
            LEFT JOIN fb_bot_collections bc ON bc.collection_id=c.id AND bc.bot_id=b.id AND bc.enabled=1
            WHERE cc.card_id=item.card_id AND cc.rowid IN (SELECT rowid FROM fb_collection_cards INDEXED BY fb_collection_cards_card_idx WHERE card_id=item.card_id LIMIT 16)
              AND (c.id IS NULL OR c.status<>'published' OR c.archived_at IS NOT NULL OR bc.bot_id IS NULL
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
export function npcTradeCandidateQuery(ctx: Ctx, npcId: string, side: "player" | "npc", pageCursor = "", spare?: { cardId:string; excludeId:string }) {
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
  const sql = `SELECT ci.id FROM fb_npc_collectors n
    JOIN fb_bots b ON b.id=n.bot_id AND b.tenant_id=n.tenant_id AND b.status='active'
    JOIN fb_users human ON human.id=? AND human.disabled_at IS NULL AND human.is_synthetic=0
    JOIN fb_memberships member ON member.tenant_id=n.tenant_id AND member.user_id=human.id AND member.status='active' AND member.revoked_at IS NULL
    JOIN fb_users synthetic ON synthetic.id=n.user_id AND synthetic.is_synthetic=1 AND synthetic.disabled_at IS NULL
    JOIN fb_memberships nm ON nm.tenant_id=n.tenant_id AND nm.user_id=n.user_id AND nm.status='active' AND nm.revoked_at IS NULL
    JOIN fb_card_instances ci ON ci.tenant_id=n.tenant_id AND ci.user_id=${side === "player" ? "human.id" : "n.user_id"} AND ci.status='owned' AND ci.locked=0 AND ci.reserved_for IS NULL
      AND ci.id IN (SELECT raw.id FROM fb_card_instances raw INDEXED BY ${spare ? "fb_npc_trade_subject_idx" : "fb_npc_trade_candidate_idx"} WHERE raw.tenant_id=n.tenant_id AND raw.user_id=${side === "player" ? "human.id" : "n.user_id"} ${spare ? "AND raw.card_id=? AND raw.id<>?" : ""} AND raw.status='owned' AND raw.locked=0 AND raw.id>? ORDER BY raw.id LIMIT 8)
    JOIN fb_card_definitions cd ON cd.id=ci.card_id AND cd.status='published' AND cd.archived_at IS NULL
    JOIN fb_variants v ON v.id=ci.variant_id AND v.card_id=cd.id AND v.status='published' AND v.archived_at IS NULL
    JOIN fb_artwork_editions e ON e.id=v.edition_id AND e.card_id=cd.id AND e.status='published' AND e.archived_at IS NULL
    JOIN fb_assets source ON source.id=e.subject_asset_id AND source.tenant_id=e.tenant_id AND source.archived_at IS NULL
    LEFT JOIN fb_assets bg ON bg.id=e.background_asset_id AND bg.tenant_id=e.tenant_id AND bg.archived_at IS NULL
    WHERE n.id=? AND n.tenant_id=? AND n.status='active' AND COALESCE((SELECT paused_all FROM fb_npc_limits WHERE tenant_id=n.tenant_id),0)=0
      AND (e.background_asset_id IS NULL OR bg.id IS NOT NULL) AND ${authority.sql} AND ${discordScope.sql}
      AND (b.ai_art_enabled=1 OR NOT EXISTS (SELECT 1 FROM (SELECT source.id AS asset_id UNION SELECT bg.id) layers JOIN fb_assets a ON a.id=layers.asset_id
        WHERE a.origin NOT IN ('sourced','foilbury_original') OR a.derivative_of_asset_id IS NOT NULL
          OR json_type(CASE WHEN length(a.dependencies_json)<=4096 AND json_valid(a.dependencies_json) THEN a.dependencies_json ELSE 'null' END)<>'array'
          OR json_array_length(CASE WHEN length(a.dependencies_json)<=4096 AND json_valid(a.dependencies_json) THEN a.dependencies_json ELSE '[]' END)<>0))
      AND ${boundedCardCollections("ci.card_id")}
      AND NOT EXISTS (SELECT 1 FROM fb_collection_cards cc LEFT JOIN fb_collections c ON c.id=cc.collection_id
        LEFT JOIN fb_bot_collections bc ON bc.collection_id=c.id AND bc.bot_id=b.id AND bc.enabled=1
        WHERE cc.card_id=ci.card_id AND cc.rowid IN (SELECT rowid FROM fb_collection_cards INDEXED BY fb_collection_cards_card_idx WHERE card_id=ci.card_id LIMIT 16)
          AND (c.id IS NULL OR c.status<>'published' OR c.archived_at IS NOT NULL OR bc.bot_id IS NULL
          OR NOT (c.scope='global' OR (c.scope='bot' AND c.owner_tenant_id=n.tenant_id))
          OR NOT ((c.view_audience='public' AND c.public_approved_at IS NOT NULL)
            OR (c.view_audience='members' AND (c.scope='global' OR c.owner_tenant_id=n.tenant_id)))))
      ORDER BY ci.id LIMIT 8`;
  return { sql, args: [user.id, ...(spare ? [spare.cardId,spare.excludeId] : []), pageCursor, npcId, ctx.tenant.id, ...authority.args, ...discordScope.args] };
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
    requested_card_id: string;
    decision_reason: "same_subject" | "catalogue_mismatch" | "rarity_mismatch" | "finish_mismatch" | "interested";
  }>(ctx.db, query.sql, ...query.args);
  if (!row)
    throw new ApiError(
      404,
      "npc_offer_unavailable",
      "That collector or one of the chosen copies is not available.",
    );
  if (row.decision_reason === "interested") {
    const spare=npcTradeCandidateQuery(ctx,npcId,"npc","",{cardId:row.requested_card_id,excludeId:requestedId});
    if (!(await first(ctx.db,spare.sql,...spare.args)))
      throw new ApiError(409,"npc_offer_unavailable","This offer is not available right now. Try another pair.");
  }
  const interested = row.decision_reason === "interested";
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
      row.decision_reason === "same_subject"
        ? "This collector trades for a different subject."
        : row.decision_reason === "catalogue_mismatch"
          ? "This collector matches copies within the same catalogue."
        : row.decision_reason === "rarity_mismatch"
          ? "This collector prefers a card of the same rarity."
          : row.decision_reason === "finish_mismatch"
            ? "This collector prefers the same finish and effect."
            : "This collector accepts a different subject from the same catalogue with the same rarity, finish and effect.",
    preview_only: true,
    message: "This is an estimate, not a trade. No copies were reserved or transferred.",
  };
}
