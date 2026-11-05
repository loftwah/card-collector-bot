import { ApiError, type Ctx } from "../context";
import { all, first, nowIso } from "../db";
import { auditStatement } from "../http";
import { newId, sha256Hex } from "../ids";
import {
  npcTradeAssessmentQuery,
  npcTradeCandidateQuery,
  previewNpcTrade,
} from "./npc-trade-preview";
import { npcTradeAuthority } from "./npc-trade-authority";

type Offer = {
  trade_id: string;
  player_id: string;
  npc_id: string;
  offered_instance_id: string;
  requested_instance_id: string;
  request_digest: string;
  decision: string;
  reason: string;
  status: string;
  revision: number;
  expires_at: string;
};

/** A returned result contains no historical card details: caller and session
 * are checked again even on retries, and media has its own audience checks. */
async function readOffer(
  ctx: Ctx,
  field: "trade_id" | "idempotency_key",
  value: string,
): Promise<Offer | null> {
  const user = ctx.user;
  if (
    !user ||
    ctx.actor.type !== "user" ||
    ctx.actor.id !== user.id ||
    ctx.actor.representedUserId !== user.id ||
    user.synthetic
  )
    throw new ApiError(403, "human_player_required", "A signed-in player must manage this offer.");
  const authority = npcTradeAuthority(ctx, "u", "m.tenant_id");
  return first<Offer>(
    ctx.db,
    `SELECT o.trade_id,o.player_id,o.npc_id,o.offered_instance_id,o.requested_instance_id,o.request_digest,o.decision,o.reason,t.status,t.revision,t.expires_at
    FROM fb_npc_trade_offers o JOIN fb_trades t ON t.id=o.trade_id AND t.tenant_id=o.tenant_id
    JOIN fb_users u ON u.id=o.player_id AND u.disabled_at IS NULL AND u.is_synthetic=0
    JOIN fb_memberships m ON m.tenant_id=o.tenant_id AND m.user_id=u.id AND m.status='active' AND m.revoked_at IS NULL
    WHERE o.tenant_id=? AND o.player_id=? AND o.${field}=? AND ${authority.sql}`,
    ctx.tenant.id,
    user.id,
    value,
    ...authority.args,
  );
}

function publicOffer(offer: Offer, replayed: boolean) {
  return {
    trade_id: offer.trade_id,
    decision: offer.decision,
    status: offer.status,
    revision: offer.revision,
    expires_at: offer.expires_at,
    replayed,
  };
}

/** Minimal history deliberately omits card names, serials and artwork; those
 * require a current audience check even after an offer was once visible. */
export async function listNpcTradeOffers(ctx: Ctx) {
  const user = ctx.user;
  if (
    !user ||
    ctx.actor.type !== "user" ||
    ctx.actor.id !== user.id ||
    ctx.actor.representedUserId !== user.id ||
    user.synthetic
  )
    throw new ApiError(
      403,
      "human_player_required",
      "A signed-in player must inspect these offers.",
    );
  const authority = npcTradeAuthority(ctx, "u", "m.tenant_id");
  return all<{
    trade_id: string;
    decision: string;
    status: string;
    revision: number;
    expires_at: string;
    created_at: string;
  }>(
    ctx.db,
    `SELECT o.trade_id,o.decision,t.status,t.revision,t.expires_at,o.created_at FROM fb_npc_trade_offers o
     JOIN fb_trades t ON t.id=o.trade_id AND t.tenant_id=o.tenant_id
     JOIN fb_users u ON u.id=o.player_id AND u.disabled_at IS NULL AND u.is_synthetic=0
     JOIN fb_memberships m ON m.tenant_id=o.tenant_id AND m.user_id=u.id AND m.status='active' AND m.revoked_at IS NULL
     WHERE o.tenant_id=? AND o.player_id=? AND ${authority.sql}
     ORDER BY o.created_at DESC,o.trade_id DESC LIMIT 50`,
    ctx.tenant.id,
    user.id,
    ...authority.args,
  );
}

// Bound one collector to three completed exchanges per rolling day and three
// open offers. A copy cannot travel back and forth between the same pair.
function quotaGuard(
  ctx: Ctx,
  npcId: string,
  playerId: string,
  offeredId: string,
  requestedId: string,
  includeOpen: boolean,
) {
  return ctx.db
    .prepare(
      `SELECT CASE WHEN
    (SELECT COUNT(*) FROM fb_npc_trade_offers o JOIN fb_trades t ON t.id=o.trade_id AND t.tenant_id=o.tenant_id
      WHERE o.tenant_id=? AND o.player_id=? AND t.status='completed' AND t.completed_at>strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day'))<3
    AND (SELECT COUNT(*) FROM fb_npc_trade_offers o JOIN fb_trades t ON t.id=o.trade_id AND t.tenant_id=o.tenant_id
      WHERE o.tenant_id=? AND o.npc_id=? AND t.status='completed' AND t.completed_at>strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day'))<10
    AND (?=0 OR (SELECT COUNT(*) FROM fb_npc_trade_offers o JOIN fb_trades t ON t.id=o.trade_id AND t.tenant_id=o.tenant_id
      WHERE o.tenant_id=? AND o.player_id=? AND t.status='open')<3)
    AND NOT EXISTS (SELECT 1 FROM fb_npc_trade_exchanged_copies x
      WHERE x.tenant_id=? AND x.player_id=? AND x.npc_id=? AND x.instance_id IN (?,?))
    THEN 1 ELSE json('npc_trade_limit') END`,
    )
    .bind(
      ctx.tenant.id,
      playerId,
      ctx.tenant.id,
      npcId,
      includeOpen ? 1 : 0,
      ctx.tenant.id,
      playerId,
      ctx.tenant.id,
      playerId,
      npcId,
      offeredId,
      requestedId,
    );
}

function attemptGuard(ctx: Ctx, npcId: string, playerId: string) {
  return ctx.db
    .prepare(
      `SELECT CASE WHEN
    (SELECT COUNT(*) FROM fb_npc_trade_offers WHERE tenant_id=? AND player_id=? AND created_at>strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day'))<20
    AND (SELECT COUNT(*) FROM fb_npc_trade_offers WHERE tenant_id=? AND npc_id=? AND created_at>strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day'))<100
    THEN 1 ELSE json('npc_attempt_limit') END`,
    )
    .bind(ctx.tenant.id, playerId, ctx.tenant.id, npcId);
}

function assessmentGuard(
  ctx: Ctx,
  npcId: string,
  offeredId: string,
  requestedId: string,
  decision: "interested" | "declined",
  reservationId?: string,
  reason?: string,
  snapshot?: {npc:{name:string};give:{card_name:string;variant_name:string;serial:string};receive:{card_name:string;variant_name:string;serial:string}},
) {
  const q = npcTradeAssessmentQuery(ctx, npcId, offeredId, requestedId, reservationId);
  const spare = npcTradeCandidateQuery(ctx,npcId,"npc","",{cardId:"__REPLACE_CARD__",excludeId:requestedId});
  // Bind the selected card through a scalar primary-key lookup; candidate proof stays bounded.
  spare.sql=spare.sql.replace("raw.card_id=?", "raw.card_id=(SELECT card_id FROM fb_card_instances WHERE id=?)");
  spare.args[1]=requestedId;
  const predicate =
    decision === "interested"
      ? "decision_reason='interested'"
      : reason === "This collector trades for a different subject."
        ? "decision_reason='same_subject'"
        : reason === "This collector matches copies within the same catalogue."
          ? "decision_reason='catalogue_mismatch'"
        : reason === "This collector prefers a card of the same rarity."
          ? "decision_reason='rarity_mismatch'"
          : reason === "This collector prefers the same finish and effect."
            ? "decision_reason='finish_mismatch'"
            : "0=1";
  return ctx.db
    .prepare(
      `SELECT CASE WHEN EXISTS (SELECT 1 FROM (${q.sql}) candidate WHERE ${predicate} ${snapshot ? "AND npc_name IS ? AND offered_name IS ? AND offered_variant IS ? AND offered_serial IS ? AND requested_name IS ? AND requested_variant IS ? AND requested_serial IS ?" : ""}) ${decision === "interested" ? `AND EXISTS (SELECT 1 FROM (${spare.sql}) eligible_spare)` : ""} THEN 1 ELSE json('npc_offer_changed') END`,
    )
    .bind(...q.args,...(snapshot ? [snapshot.npc.name,snapshot.give.card_name,snapshot.give.variant_name,snapshot.give.serial,snapshot.receive.card_name,snapshot.receive.variant_name,snapshot.receive.serial] : []),...(decision === "interested" ? spare.args : []));
}

function callerGuard(ctx: Ctx) {
  const user = ctx.user;
  if (
    !user ||
    ctx.actor.type !== "user" ||
    ctx.actor.id !== user.id ||
    ctx.actor.representedUserId !== user.id ||
    user.synthetic
  )
    throw new ApiError(403, "human_player_required", "A signed-in player must manage this offer.");
  const authority = npcTradeAuthority(ctx, "u", "m.tenant_id");
  return ctx.db
    .prepare(
      `SELECT CASE WHEN EXISTS (SELECT 1 FROM fb_users u JOIN fb_memberships m ON m.user_id=u.id AND m.tenant_id=? AND m.status='active' AND m.revoked_at IS NULL
    WHERE u.id=? AND u.is_synthetic=0 AND u.disabled_at IS NULL AND ${authority.sql}) THEN 1 ELSE json('npc_caller_changed') END`,
    )
    .bind(ctx.tenant.id, user.id, ...authority.args);
}

export async function createNpcTradeOffer(
  ctx: Ctx,
  npcId: string,
  offeredId: string,
  requestedId: string,
  key: string,
) {
  if (key.length < 8 || key.length > 200)
    throw new ApiError(
      422,
      "idempotency_key_invalid",
      "Provide an idempotency key of 8–200 characters.",
    );
  const user = ctx.user;
  if (!user) throw new ApiError(401, "authentication_required", "Sign in to make an offer.");
  const digest = await sha256Hex(JSON.stringify([npcId, offeredId, requestedId]));
  const existing = await readOffer(ctx, "idempotency_key", key);
  if (existing) {
    if (existing.request_digest !== digest)
      throw new ApiError(
        409,
        "idempotency_conflict",
        "This offer key was already used for different copies.",
      );
    return publicOffer(existing, true);
  }
  const preview = await previewNpcTrade(ctx, npcId, offeredId, requestedId);
  const decision = preview.decision as "interested" | "declined";
  const npc = await first<{ user_id: string }>(
    ctx.db,
    "SELECT user_id FROM fb_npc_collectors WHERE id=? AND tenant_id=?",
    npcId,
    ctx.tenant.id,
  );
  if (!npc) throw new ApiError(404, "npc_offer_unavailable", "That collector is unavailable.");
  const tradeId = newId("trd"),
    now = nowIso(),
    expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
  try {
    await ctx.db.batch([
      assessmentGuard(ctx, npcId, offeredId, requestedId, decision, undefined, preview.reason),
      attemptGuard(ctx, npcId, user.id),
      ...(decision === "interested"
        ? [quotaGuard(ctx, npcId, user.id, offeredId, requestedId, true)]
        : []),
      ctx.db
        .prepare(
          "INSERT INTO fb_trades (id,tenant_id,proposer_id,recipient_id,status,revision,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?,?)",
        )
        .bind(
          tradeId,
          ctx.tenant.id,
          user.id,
          npc.user_id,
          decision === "interested" ? "open" : "declined",
          expiresAt,
          now,
          now,
        ),
      ...(decision === "interested"
        ? [
            ctx.db
              .prepare(
                "INSERT INTO fb_trade_items (id,tenant_id,trade_id,side,instance_id,created_at) VALUES (?,?,?,'proposer',?,?)",
              )
              .bind(newId("tri"), ctx.tenant.id, tradeId, offeredId, now),
            ctx.db
              .prepare(
                "INSERT INTO fb_trade_items (id,tenant_id,trade_id,side,instance_id,created_at) VALUES (?,?,?,'recipient',?,?)",
              )
              .bind(newId("tri"), ctx.tenant.id, tradeId, requestedId, now),
            ctx.db
              .prepare(
                "INSERT INTO fb_trade_acceptances (tenant_id,trade_id,revision,user_id,accepted_at) VALUES (?,?,1,?,?)",
              )
              .bind(ctx.tenant.id, tradeId, npc.user_id, now),
          ]
        : []),
      ctx.db
        .prepare(
          "INSERT INTO fb_npc_trade_offers (trade_id,tenant_id,player_id,npc_id,offered_instance_id,requested_instance_id,idempotency_key,request_digest,decision,reason,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          tradeId,
          ctx.tenant.id,
          user.id,
          npcId,
          offeredId,
          requestedId,
          key,
          digest,
          decision,
          preview.reason,
          now,
        ),
      auditStatement(ctx, "npc.trade.offered", "trade", tradeId, { npc_id: npcId, decision }),
    ]);
  } catch (error) {
    const prior = await readOffer(ctx, "idempotency_key", key);
    if (prior) {
      if (prior.request_digest !== digest)
        throw new ApiError(
          409,
          "idempotency_conflict",
          "This offer key was already used for different copies.",
        );
      return publicOffer(prior, true);
    }
    if (
      String(error).includes("malformed JSON") ||
      String(error).includes("trade_item_unavailable")
    )
      throw new ApiError(
        409,
        "npc_offer_changed",
        "The offer, access or trade limit changed. Review the copies again.",
      );
    throw error;
  }
  const stored = await readOffer(ctx, "trade_id", tradeId);
  if (!stored)
    throw new ApiError(
      409,
      "npc_offer_unavailable",
      "The offer was recorded but your access changed.",
    );
  return { ...publicOffer(stored, false), reason: preview.reason };
}

export async function confirmNpcTrade(ctx: Ctx, tradeId: string) {
  const offer = await readOffer(ctx, "trade_id", tradeId);
  if (!offer) throw new ApiError(404, "npc_offer_unavailable", "That offer is unavailable.");
  if (offer.status === "completed") return publicOffer(offer, true);
  if (offer.status !== "open")
    throw new ApiError(409, "trade_not_open", "That offer is no longer open.");
  if (new Date(offer.expires_at).getTime() <= Date.now()) {
    await releaseNpcTrade(ctx, tradeId, true);
    throw new ApiError(
      409,
      "trade_expired",
      "That offer expired; the reserved copies were released.",
    );
  }
  const now = nowIso();
  const player = ctx.user!.id;
  const npc = await first<{ user_id: string }>(
    ctx.db,
    "SELECT user_id FROM fb_npc_collectors WHERE id=? AND tenant_id=?",
    offer.npc_id,
    ctx.tenant.id,
  );
  if (!npc) throw new ApiError(409, "npc_offer_changed", "That collector is unavailable.");
  const moves = [
    { id: offer.offered_instance_id, from: player, to: npc.user_id },
    { id: offer.requested_instance_id, from: npc.user_id, to: player },
  ];
  try {
    await ctx.db.batch([
      assessmentGuard(
        ctx,
        offer.npc_id,
        offer.offered_instance_id,
        offer.requested_instance_id,
        "interested",
        offer.trade_id,
      ),
      quotaGuard(
        ctx,
        offer.npc_id,
        player,
        offer.offered_instance_id,
        offer.requested_instance_id,
        false,
      ),
      ctx.db
        .prepare(
          "SELECT CASE WHEN EXISTS (SELECT 1 FROM fb_trades WHERE id=? AND tenant_id=? AND proposer_id=? AND recipient_id=? AND status='open' AND revision=? AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) THEN 1 ELSE json('npc_offer_changed') END",
        )
        .bind(tradeId, ctx.tenant.id, player, npc.user_id, offer.revision),
      ctx.db
        .prepare(
          "INSERT INTO fb_trade_acceptances (tenant_id,trade_id,revision,user_id,accepted_at) VALUES (?,?,?,?,?)",
        )
        .bind(ctx.tenant.id, tradeId, offer.revision, player, now),
      ctx.db
        .prepare(
          "UPDATE fb_trades SET status='completed',completed_at=?,updated_at=? WHERE id=? AND tenant_id=? AND status='open' AND revision=?",
        )
        .bind(now, now, tradeId, ctx.tenant.id, offer.revision),
      ctx.db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json('npc_offer_changed') END"),
      ...moves.flatMap((move) => [
        ctx.db
          .prepare(
            "UPDATE fb_card_instances SET user_id=?,status='owned',reserved_for=NULL,updated_at=? WHERE id=? AND tenant_id=? AND user_id=? AND status='reserved' AND reserved_for=? AND locked=0",
          )
          .bind(move.to, now, move.id, ctx.tenant.id, move.from, tradeId),
        ctx.db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json('npc_offer_changed') END"),
        ctx.db
          .prepare(
            "INSERT INTO fb_instance_history (id,tenant_id,instance_id,event,from_user_id,to_user_id,reference_type,reference_id,metadata_json,created_at) VALUES (?,?,?,'traded',?,?,'npc_trade',?,'{}',?)",
          )
          .bind(newId("ih"), ctx.tenant.id, move.id, move.from, move.to, tradeId, now),
        ctx.db.prepare("INSERT INTO fb_npc_trade_exchanged_copies (tenant_id,player_id,npc_id,instance_id,trade_id) VALUES (?,?,?,?,?)")
          .bind(ctx.tenant.id,player,offer.npc_id,move.id,tradeId),
      ]),
      ctx.db
        .prepare(
          "INSERT INTO fb_outbox (id,tenant_id,topic,payload_json,status,attempts,available_at,created_at) VALUES (?,?,'trade.completed',?,'pending',0,?,?)",
        )
        .bind(
          newId("out"),
          ctx.tenant.id,
          JSON.stringify({ trade_id: tradeId, revision: offer.revision }),
          now,
          now,
        ),
      auditStatement(ctx, "npc.trade.completed", "trade", tradeId, { npc_id: offer.npc_id }),
    ]);
  } catch (error) {
    const prior = await readOffer(ctx, "trade_id", tradeId);
    if (prior?.status === "completed") return publicOffer(prior, true);
    if (
      String(error).includes("malformed JSON") ||
      String(error).includes("trade_not_ready") ||
      String(error).includes("trade_item_invalid") ||
      String(error).includes("UNIQUE")
    )
      throw new ApiError(
        409,
        "npc_offer_changed",
        "The outcome could not be confirmed. Check your offer history before retrying.",
      );
    throw error;
  }
  const completed = await readOffer(ctx, "trade_id", tradeId);
  if (!completed)
    throw new ApiError(
      409,
      "npc_offer_unavailable",
      "The exchange was recorded but your access changed.",
    );
  return publicOffer(completed, false);
}

async function releaseNpcTrade(ctx: Ctx, tradeId: string, expired: boolean) {
  const offer = await readOffer(ctx, "trade_id", tradeId);
  if (!offer) throw new ApiError(404, "npc_offer_unavailable", "That offer is unavailable.");
  if (offer.status === "cancelled" || offer.status === "expired") return publicOffer(offer, true);
  if (offer.status !== "open")
    throw new ApiError(409, "trade_not_open", "That offer is no longer open.");
  const now = nowIso(),
    status = expired ? "expired" : "cancelled";
  try {
    await ctx.db.batch([
      callerGuard(ctx),
      ctx.db
        .prepare(
          `UPDATE fb_trades SET status=?,updated_at=? WHERE id=? AND tenant_id=? AND proposer_id=? AND status='open' AND revision=? ${expired ? "AND expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')" : ""}`,
        )
        .bind(status, now, tradeId, ctx.tenant.id, ctx.user!.id, offer.revision),
      ctx.db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json('npc_offer_changed') END"),
      ctx.db
        .prepare(
          "UPDATE fb_card_instances SET status='owned',reserved_for=NULL,updated_at=? WHERE tenant_id=? AND reserved_for=? AND status='reserved' AND id IN (?,?)",
        )
        .bind(now, ctx.tenant.id, tradeId, offer.offered_instance_id, offer.requested_instance_id),
      ctx.db.prepare("SELECT CASE WHEN changes()=2 THEN 1 ELSE json('npc_offer_changed') END"),
      auditStatement(ctx, `npc.trade.${status}`, "trade", tradeId, { npc_id: offer.npc_id }),
    ]);
  } catch (error) {
    const prior = await readOffer(ctx, "trade_id", tradeId);
    if (prior?.status === status) return publicOffer(prior, true);
    if (String(error).includes("malformed JSON"))
      throw new ApiError(
        409,
        "npc_offer_changed",
        "The offer or access changed. Reload its current state.",
      );
    throw error;
  }
  const result = await readOffer(ctx, "trade_id", tradeId);
  if (!result)
    throw new ApiError(
      409,
      "npc_offer_unavailable",
      "The offer changed but your access is no longer active.",
    );
  return publicOffer(result, false);
}

export async function cancelNpcTrade(ctx: Ctx, tradeId: string) {
  return releaseNpcTrade(ctx, tradeId, false);
}

/** Scan fixed indexed windows, then expose only currently authorized pairs.
 * Cursors are server-only; callers expose only an opaque search record. */
export async function suggestNpcTradeOffers(ctx: Ctx, npcId: string, playerCursor = "", npcCursor = "") {
  const mineQuery = npcTradeCandidateQuery(ctx, npcId, "player",playerCursor),
    npcQuery = npcTradeCandidateQuery(ctx, npcId, "npc",npcCursor);
  const [mine, theirs] = await Promise.all([
    all<{ id: string }>(ctx.db, mineQuery.sql, ...mineQuery.args),
    all<{ id: string }>(ctx.db, npcQuery.sql, ...npcQuery.args),
  ]);
  if (!mine.length || !theirs.length) return [];
  const q = npcTradeAssessmentQuery(ctx, npcId, "", "", undefined, true);
  const rows = await all<{
    npc_id: string;
    npc_name: string;
    offered_id: string;
    offered_name: string;
    offered_variant: string;
    offered_serial: string;
    requested_id: string;
    requested_name: string;
    requested_variant: string;
    requested_serial: string;
    requested_card_id: string;
  }>(
    ctx.db,
    `SELECT * FROM (${q.sql} AND offered.id IN (SELECT value FROM json_each(?)) AND requested.id IN (SELECT value FROM json_each(?))) candidate WHERE decision_reason='interested' ORDER BY offered_id,requested_id LIMIT 64`,
    ...q.args,
    JSON.stringify(mine.map((row) => row.id)),
    JSON.stringify(theirs.map((row) => row.id)),
  );
  // At most eight requested copies occur in an 8×8 window. Check each once;
  // limiting before this proof can let an unavailable prefix suppress valid ideas.
  const requested=[...new Map(rows.map(row=>[row.requested_id,row])).values()];
  const eligibility=await Promise.all(requested.map(async row => {
    const spare=npcTradeCandidateQuery(ctx,npcId,"npc","",{cardId:row.requested_card_id,excludeId:row.requested_id});
    return [row.requested_id,Boolean(await first(ctx.db,spare.sql,...spare.args))] as const;
  }));
  const eligible=new Map(eligibility);
  return rows.filter(row=>eligible.get(row.requested_id)).slice(0,3).map((row) => ({
    npc: { id: row.npc_id, name: row.npc_name, label: "NPC collector" },
    give: {
      instance_id: row.offered_id,
      card_name: row.offered_name,
      variant_name: row.offered_variant,
      serial: row.offered_serial,
    },
    receive: {
      instance_id: row.requested_id,
      card_name: row.requested_name,
      variant_name: row.requested_variant,
      serial: row.requested_serial,
    },
    decision: "interested" as const,
    reason: "This collector accepts a different subject from the same catalogue with the same rarity, finish and effect.",
    preview_only: true,
    message: "This is an estimate, not a trade. No copies were reserved or transferred.",
  }));
}

export async function inspectOpenNpcTrade(ctx: Ctx, tradeId: string) {
  const offer = await readOffer(ctx, "trade_id", tradeId);
  if (!offer || offer.status !== "open") return null;
  const q = npcTradeAssessmentQuery(
    ctx,
    offer.npc_id,
    offer.offered_instance_id,
    offer.requested_instance_id,
    offer.trade_id,
  );
  const row = await first<{
    npc_name: string;
    offered_name: string;
    offered_variant: string;
    offered_serial: string;
    requested_name: string;
    requested_variant: string;
    requested_serial: string;
  }>(ctx.db, q.sql, ...q.args);
  return row ? { ...publicOffer(offer, false), ...row } : null;
}

type SearchRow = { id:string;npc_id:string;npc_user_id:string;player_cursor:string;npc_cursor:string;revision:number;pages:number;scan_exhausted:number;expires_at:string;last_result_json:string|null };

async function searchSource(ctx:Ctx) {
  if (ctx.discordPrincipal) return sha256Hex(JSON.stringify(["discord",ctx.discordPrincipal]));
  if (ctx.sessionId) return sha256Hex(JSON.stringify(["session",ctx.sessionId]));
  if (ctx.sessionAssurance === "access" && ctx.accessStatus === "linked" && ctx.accessIdentity)
    return sha256Hex(JSON.stringify(["access",ctx.config.access.teamDomain,ctx.accessIdentity.subject]));
  throw new ApiError(403,"npc_trade_search_unavailable","Sign in again before browsing trades.");
}

async function readSearch(ctx:Ctx,id:string,sourceKey:string) {
  const user=ctx.user;
  if (!user || ctx.actor.type!=="user" || ctx.actor.id!==user.id || ctx.actor.representedUserId!==user.id || user.synthetic)
    throw new ApiError(403,"human_player_required","A signed-in player must browse offers.");
  const authority=npcTradeAuthority(ctx,"u","m.tenant_id");
  return first<SearchRow>(ctx.db,`SELECT s.id,s.npc_id,n.user_id AS npc_user_id,s.player_cursor,s.npc_cursor,s.revision,s.pages,s.scan_exhausted,s.expires_at,s.last_result_json
    FROM fb_npc_trade_searches s JOIN fb_users u ON u.id=s.player_id AND u.disabled_at IS NULL AND u.is_synthetic=0
    JOIN fb_memberships m ON m.user_id=u.id AND m.tenant_id=s.tenant_id AND m.status='active' AND m.revoked_at IS NULL
    JOIN fb_npc_collectors n ON n.id=s.npc_id AND n.tenant_id=s.tenant_id AND n.status='active'
    JOIN fb_bots b ON b.id=n.bot_id AND b.tenant_id=n.tenant_id AND b.status='active'
    WHERE s.id=? AND s.tenant_id=? AND s.player_id=? AND s.source_key=? AND s.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND ${authority.sql}`,
    id,ctx.tenant.id,user.id,sourceKey,...authority.args);
}

export async function startNpcTradeSearch(ctx:Ctx,npcId:string,requestKey:string) {
  const user=ctx.user;
  if (!user || requestKey.length<8 || requestKey.length>200) throw new ApiError(422,"npc_trade_search_unavailable","Could not start a trade search.");
  const sourceKey=await searchSource(ctx),id=newId("nps"),now=nowIso(),expires=new Date(Date.now()+5*60_000).toISOString();
  try {
    await ctx.db.batch([
      callerGuard(ctx),
      ctx.db.prepare(`SELECT CASE WHEN EXISTS (SELECT 1 FROM fb_npc_collectors n JOIN fb_bots b ON b.id=n.bot_id AND b.tenant_id=n.tenant_id AND b.status='active'
        WHERE n.id=? AND n.tenant_id=? AND n.status='active') AND
        ((SELECT COUNT(*) FROM fb_npc_trade_searches WHERE tenant_id=? AND player_id=? AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))<3
          OR EXISTS (SELECT 1 FROM fb_npc_trade_searches WHERE tenant_id=? AND player_id=? AND source_key=? AND request_key=?))
        THEN 1 ELSE json('npc_search_unavailable') END`).bind(npcId,ctx.tenant.id,ctx.tenant.id,user.id,ctx.tenant.id,user.id,sourceKey,requestKey),
      ctx.db.prepare("INSERT OR IGNORE INTO fb_npc_trade_searches (id,tenant_id,player_id,npc_id,source_key,request_key,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?)")
        .bind(id,ctx.tenant.id,user.id,npcId,sourceKey,requestKey,now,expires),
    ]);
  } catch (error) {
    if (String(error).includes("malformed JSON")) throw new ApiError(409,"npc_trade_search_unavailable","Trade search is unavailable. Try again later.");
    throw error;
  }
  const row=await first<{id:string;npc_id:string;revision:number}>(ctx.db,"SELECT id,npc_id,revision FROM fb_npc_trade_searches WHERE tenant_id=? AND player_id=? AND source_key=? AND request_key=?",ctx.tenant.id,user.id,sourceKey,requestKey);
  if (!row || row.npc_id!==npcId || (row.revision!==0 && row.revision!==1) || !(await readSearch(ctx,row.id,sourceKey))) throw new ApiError(409,"npc_trade_search_unavailable","This search has expired or advanced. Start a new search.");
  return {id:row.id,revision:0};
}

export async function nextNpcTradeSearchPage(ctx:Ctx,id:string,expectedRevision:number) {
  const sourceKey=await searchSource(ctx),search=await readSearch(ctx,id,sourceKey);
  if (!search) throw new ApiError(409,"npc_trade_search_unavailable","This search has expired or changed. Start a new search.");
  if (search.revision===expectedRevision+1 && search.last_result_json) {
    let receipt:{revision:number; pairs:[string,string][]; end:"exhausted"|"limit"|null};
    try {
      receipt=JSON.parse(search.last_result_json);
      if (receipt.revision!==expectedRevision || !Array.isArray(receipt.pairs) || receipt.pairs.length>3 ||
          !receipt.pairs.every(pair=>Array.isArray(pair) && pair.length===2 && pair.every(id=>typeof id==="string" && id.length<=200)) ||
          ![null,"exhausted","limit"].includes(receipt.end)) throw new Error("invalid receipt");
      const ideas=await Promise.all(receipt.pairs.map(async ([give,receive])=>{
        const preview=await previewNpcTrade(ctx,search.npc_id,give,receive);
        if(preview.decision!=="interested") throw new Error("changed receipt");
        return preview;
      }));
      await ctx.db.batch([
        callerGuard(ctx),
        ...ideas.map(idea=>assessmentGuard(ctx,search.npc_id,idea.give.instance_id,idea.receive.instance_id,"interested",undefined,undefined,idea)),
        ctx.db.prepare(`SELECT CASE WHEN EXISTS (SELECT 1 FROM fb_npc_trade_searches s JOIN fb_npc_collectors n ON n.id=s.npc_id AND n.tenant_id=s.tenant_id AND n.status='active' JOIN fb_bots b ON b.id=n.bot_id AND b.tenant_id=n.tenant_id AND b.status='active' WHERE s.id=? AND s.tenant_id=? AND s.player_id=? AND s.source_key=? AND s.revision=? AND s.last_result_json=? AND s.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) THEN 1 ELSE json('npc_search_changed') END`).bind(id,ctx.tenant.id,ctx.user!.id,sourceKey,expectedRevision+1,search.last_result_json),
      ]);
      return {id,npc_id:search.npc_id,revision:expectedRevision+1,ideas,can_continue:receipt.end===null,end:receipt.end};
    } catch {
      throw new ApiError(409,"npc_trade_search_unavailable","This search has expired or changed. Start a new search.");
    }
  }
  if (search.last_result_json) {
    try { if (JSON.parse(search.last_result_json).end !== null) throw new Error("finished"); }
    catch { throw new ApiError(409,"npc_trade_search_unavailable","This search has ended. Start a new search."); }
  }
  if (search.revision!==expectedRevision || search.pages>=4) throw new ApiError(409,"npc_trade_search_unavailable","This search has expired or changed. Start a new search.");
  const raw=(ownerId:string,cursor:string)=>all<{id:string}>(ctx.db,`SELECT id FROM fb_card_instances INDEXED BY fb_npc_trade_candidate_idx
    WHERE tenant_id=? AND user_id=? AND status='owned' AND locked=0 AND id>? ORDER BY id LIMIT 9`,ctx.tenant.id,ownerId,cursor);
  // Four fixed-size windows per page; every candidate is authorized live.
  // Never use inventory exhaustion to determine the public page budget.
  let nextPlayer=search.player_cursor,nextNpc=search.npc_cursor,exhausted=search.scan_exhausted===1;
  const ideas:Awaited<ReturnType<typeof suggestNpcTradeOffers>>=[];
  for (let window=0;window<4 && !exhausted;window++) {
    const [mine,theirs,windowIdeas]=await Promise.all([
      raw(ctx.user!.id,nextPlayer),raw(search.npc_user_id,nextNpc),
      suggestNpcTradeOffers(ctx,search.npc_id,nextPlayer,nextNpc),
    ]);
    for (const idea of windowIdeas) if (ideas.length<3) ideas.push(idea);
    exhausted=theirs.length<=8 && mine.length<=8;
    if (theirs.length>8) nextNpc=theirs[7]!.id;
    else { nextNpc=""; nextPlayer=mine.length>8 ? mine[7]!.id : ""; }
  }
  const end=search.pages+1>=4 ? "limit" as const : null;
  const receipt=JSON.stringify({revision:expectedRevision,pairs:ideas.map(idea=>[idea.give.instance_id,idea.receive.instance_id]),end});
  try {
    await ctx.db.batch([
      callerGuard(ctx),
      ...ideas.map(idea=>assessmentGuard(ctx,search.npc_id,idea.give.instance_id,idea.receive.instance_id,"interested",undefined,undefined,idea)),
      ctx.db.prepare(`UPDATE fb_npc_trade_searches SET player_cursor=?,npc_cursor=?,revision=revision+1,pages=pages+1,scan_exhausted=?,last_result_json=?
        WHERE id=? AND tenant_id=? AND player_id=? AND source_key=? AND revision=? AND pages<4 AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
        .bind(nextPlayer,nextNpc,exhausted ? 1 : 0,receipt,id,ctx.tenant.id,ctx.user!.id,sourceKey,expectedRevision),
      ctx.db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json('npc_search_changed') END"),
    ]);
  } catch (error) {
    if (String(error).includes("malformed JSON")) {
      const latest=await readSearch(ctx,id,sourceKey);
      if (latest?.revision===expectedRevision+1) return nextNpcTradeSearchPage(ctx,id,expectedRevision);
      throw new ApiError(409,"npc_trade_search_unavailable","This search changed. Start a new search.");
    }
    throw error;
  }
  return {id,npc_id:search.npc_id,revision:expectedRevision+1,ideas,can_continue:end===null,end};
}

export async function stopNpcTradeSearch(ctx:Ctx,id:string) {
  const sourceKey=await searchSource(ctx),search=await readSearch(ctx,id,sourceKey);
  if (!search) throw new ApiError(409,"npc_trade_search_unavailable","This search has already closed or expired.");
  try {
    await ctx.db.batch([
      callerGuard(ctx),
      ctx.db.prepare("DELETE FROM fb_npc_trade_searches WHERE id=? AND tenant_id=? AND player_id=? AND source_key=?")
        .bind(id,ctx.tenant.id,ctx.user!.id,sourceKey),
      ctx.db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json('npc_search_changed') END"),
    ]);
  } catch (error) {
    if (String(error).includes("malformed JSON")) throw new ApiError(409,"npc_trade_search_unavailable","This search has already closed or expired.");
    throw error;
  }
  return {npc_id:search.npc_id};
}

/** Trusted bounded maintenance. A state transition and both releases are one
 * transaction; a concurrent confirmation/cancellation wins or loses whole. */
export async function expireNpcTradeOffers(db: Ctx["db"]) {
  const installed = await first<{ name: string }>(
    db,
    "SELECT name FROM sqlite_master WHERE type='table' AND name='fb_npc_trade_offers'",
  );
  if (!installed) return { expired: 0, schema_installed: false };
  const cursor = await first<{
    expires_at: string | null;
    trade_id: string | null;
    revision: number;
  }>(db, "SELECT expires_at,trade_id,revision FROM fb_npc_trade_expiry_cursor WHERE id=1");
  if (!cursor) throw new Error("NPC trade expiry cursor is missing.");
  const rows = await all<{
    trade_id: string;
    tenant_id: string;
    offered_instance_id: string;
    requested_instance_id: string;
    expires_at: string;
  }>(
    db,
    `SELECT o.trade_id,o.tenant_id,o.offered_instance_id,o.requested_instance_id,t.expires_at FROM fb_npc_trade_offers o
     JOIN fb_trades t ON t.id=o.trade_id AND t.tenant_id=o.tenant_id
     WHERE t.status='open' AND t.expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
       AND (? IS NULL OR t.expires_at>? OR (t.expires_at=? AND o.trade_id>?))
     ORDER BY t.expires_at,o.trade_id LIMIT 20`,
    cursor.expires_at,
    cursor.expires_at,
    cursor.expires_at,
    cursor.trade_id,
  );
  let expired = 0,
    failed = 0;
  for (const row of rows) {
    const now = nowIso();
    try {
      await db.batch([
        db
          .prepare(
            "UPDATE fb_trades SET status='expired',updated_at=? WHERE id=? AND tenant_id=? AND status='open' AND expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')",
          )
          .bind(now, row.trade_id, row.tenant_id),
        db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json('npc_offer_changed') END"),
        db
          .prepare(
            "UPDATE fb_card_instances SET status='owned',reserved_for=NULL,updated_at=? WHERE tenant_id=? AND reserved_for=? AND status='reserved' AND id IN (?,?)",
          )
          .bind(
            now,
            row.tenant_id,
            row.trade_id,
            row.offered_instance_id,
            row.requested_instance_id,
          ),
        db.prepare("SELECT CASE WHEN changes()=2 THEN 1 ELSE json('npc_offer_changed') END"),
        db
          .prepare(
            "INSERT INTO fb_audit_events (id,tenant_id,actor_type,actor_id,action,object_type,object_id,metadata_json,request_id,created_at) VALUES (?,?,'system','npc-trade-expiry','npc.trade.expired','trade',?,'{}','scheduled:npc-trade-expiry',?)",
          )
          .bind(newId("aud"), row.tenant_id, row.trade_id, now),
      ]);
      expired++;
    } catch {
      const current = await first<{ status: string }>(
        db,
        "SELECT status FROM fb_trades WHERE id=? AND tenant_id=?",
        row.trade_id,
        row.tenant_id,
      );
      if (current?.status === "open") failed++;
    }
  }
  const last = rows.length === 20 ? rows[rows.length - 1] : null;
  const moved = await db
    .prepare(
      "UPDATE fb_npc_trade_expiry_cursor SET expires_at=?,trade_id=?,revision=revision+1 WHERE id=1 AND revision=? RETURNING revision",
    )
    .bind(last?.expires_at ?? null, last?.trade_id ?? null, cursor.revision)
    .all();
  if (moved.results.length !== 1) {
    const current = await first<{ revision: number }>(
      db,
      "SELECT revision FROM fb_npc_trade_expiry_cursor WHERE id=1",
    );
    if (!current || current.revision <= cursor.revision)
      throw new Error("NPC trade expiry cursor could not be advanced.");
  }
  await db.prepare("DELETE FROM fb_npc_trade_searches WHERE id IN (SELECT id FROM fb_npc_trade_searches WHERE expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') ORDER BY expires_at LIMIT 50)").run();
  if (failed) throw new Error(`NPC trade expiry could not safely release ${failed} offer(s).`);
  return { expired, schema_installed: true };
}
