import { ApiError, type Ctx } from "../context";
import { first } from "../db";

/**
 * A read-only, single-copy offer assessment. This is deliberately not a
 * reservation or acceptance: a later exchange must recheck every fact in its
 * own transaction, and trading remains disabled until that path exists.
 */
export async function previewNpcTrade(
  ctx: Ctx,
  npcId: string,
  offeredId: string,
  requestedId: string,
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
  if (offeredId === requestedId)
    throw new ApiError(422, "trade_item_duplicate", "Choose a different copy on each side.");
  const access =
    ctx.sessionAssurance === "access" && ctx.accessStatus === "linked" ? ctx.accessIdentity : null;

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
  }>(
    ctx.db,
    `SELECT n.name AS npc_name,
      oc.name AS offered_name, ov.name AS offered_variant, offered.serial AS offered_serial,
      rc.name AS requested_name, rv.name AS requested_variant, requested.serial AS requested_serial,
      (SELECT COUNT(*) FROM fb_card_instances x WHERE x.tenant_id=n.tenant_id AND x.user_id=n.user_id
        AND x.card_id=requested.card_id AND x.status='owned') AS requested_copies,
      EXISTS (SELECT 1 FROM fb_card_instances x WHERE x.tenant_id=n.tenant_id AND x.user_id=n.user_id
        AND x.card_id=offered.card_id AND x.status IN ('owned','reserved')) AS already_has_subject
    FROM fb_npc_collectors n
    JOIN fb_bots b ON b.id=n.bot_id AND b.tenant_id=n.tenant_id AND b.status='active'
    JOIN fb_users human ON human.id=? AND human.disabled_at IS NULL AND human.is_synthetic=0
    JOIN fb_memberships member ON member.tenant_id=n.tenant_id AND member.user_id=human.id AND member.status='active' AND member.revoked_at IS NULL
    JOIN fb_users synthetic ON synthetic.id=n.user_id AND synthetic.is_synthetic=1 AND synthetic.disabled_at IS NULL
    JOIN fb_memberships nm ON nm.tenant_id=n.tenant_id AND nm.user_id=n.user_id AND nm.status='active' AND nm.revoked_at IS NULL
    JOIN fb_card_instances offered ON offered.id=? AND offered.tenant_id=n.tenant_id AND offered.user_id=human.id AND offered.status='owned' AND offered.locked=0 AND offered.reserved_for IS NULL
    JOIN fb_card_instances requested ON requested.id=? AND requested.tenant_id=n.tenant_id AND requested.user_id=n.user_id AND requested.status='owned' AND requested.locked=0 AND requested.reserved_for IS NULL
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
      AND (EXISTS (SELECT 1 FROM fb_sessions s WHERE s.id=? AND s.user_id=human.id AND s.tenant_id=n.tenant_id
        AND s.revoked_at IS NULL AND s.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        OR (?='access' AND ?>unixepoch('now') AND EXISTS (SELECT 1 FROM fb_access_identities ai
          WHERE ai.user_id=human.id AND ai.team_domain=? AND ai.subject=? AND ai.email=? COLLATE NOCASE AND ai.revoked_at IS NULL)
          AND human.email=? COLLATE NOCASE))
      AND (b.ai_art_enabled=1 OR (os.origin IN ('sourced','foilbury_original') AND rs.origin IN ('sourced','foilbury_original')
        AND (oe.background_asset_id IS NULL OR ob.origin IN ('sourced','foilbury_original'))
        AND (re.background_asset_id IS NULL OR rb.origin IN ('sourced','foilbury_original'))))
      AND NOT EXISTS (SELECT 1 FROM (SELECT offered.card_id AS card_id UNION SELECT requested.card_id) item
        WHERE NOT EXISTS (SELECT 1 FROM fb_collection_cards cc WHERE cc.card_id=item.card_id)
          OR EXISTS (SELECT 1 FROM fb_collection_cards cc LEFT JOIN fb_collections c ON c.id=cc.collection_id
            LEFT JOIN fb_bot_collections bc ON bc.collection_id=c.id AND bc.bot_id=b.id AND bc.enabled=1
            WHERE cc.card_id=item.card_id AND (c.id IS NULL OR c.status<>'published' OR c.archived_at IS NOT NULL OR bc.bot_id IS NULL
              OR NOT ((c.view_audience='public' AND c.public_approved_at IS NOT NULL)
                OR (c.view_audience='members' AND (c.scope='global' OR c.owner_tenant_id=n.tenant_id))))))`,
    user.id,
    offeredId,
    requestedId,
    npcId,
    ctx.tenant.id,
    ctx.sessionId,
    ctx.sessionAssurance,
    access?.payload.exp ?? 0,
    ctx.config.access.teamDomain,
    access?.subject ?? "",
    access?.email ?? "",
    access?.email ?? "",
  );
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
        ? "This collector keeps their last copy of a subject."
        : row.already_has_subject
          ? "This collector already has that subject."
          : "This collector wants the new subject and has a spare.",
    preview_only: true,
    message: "This is an estimate, not a trade. No copies were reserved or transferred.",
  };
}
