import { ApiError, type Ctx } from "../context";
import { all, first, nowIso } from "../db";
import { newId } from "../ids";
import { audit, auditStatement } from "../http";
import { normalizeCardName } from "./card-name-aliases";

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
  duplicate_count: number;
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
  (SELECT COUNT(*) FROM fb_card_instances dup
    WHERE dup.tenant_id = ci.tenant_id AND dup.user_id = ci.user_id
      AND dup.card_id = ci.card_id AND dup.variant_id = ci.variant_id
      AND dup.status IN ('owned','reserved')) AS duplicate_count,
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
  finish?: string;
  duplicates?: boolean;
  sort?: "newest" | "name" | "finish";
  limit?: number;
  offset?: number;
}

/**
 * The filter fragment is shared by the list and count queries. A page is never
 * used as a total: "12 cards kept" must mean the collection, not the rows that
 * happened to fit in the first request.
 */
function inventoryFilter(ctx: Ctx, options: InventoryQuery) {
  const user = ctx.user;
  if (!user) throw new ApiError(401, "authentication_required", "Sign in to see your collection.");
  const where = ["ci.tenant_id = ?", "ci.user_id = ?", "ci.status IN ('owned','reserved')"];
  const params: unknown[] = [ctx.tenant.id, user.id];
  if (options.status) {
    where.push("ci.status = ?");
    params.push(options.status);
  }
  if (options.favourite) where.push("ci.favourite = 1");
  if (options.search) {
    where.push(
      "(cd.name LIKE ? OR v.name LIKE ? OR cd.description LIKE ? OR EXISTS (SELECT 1 FROM fb_card_name_aliases na WHERE na.tenant_id = cd.tenant_id AND na.card_id = cd.id AND na.normalized = ?))",
    );
    const search = `%${options.search}%`;
    params.push(search, search, search, normalizeCardName(options.search));
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
  if (options.finish) {
    if (options.finish === "holographic") {
      where.push("(m.key = 'diamond' OR fx.key = 'holographic')");
    } else if (["plain", "silver", "gold"].includes(options.finish)) {
      where.push("m.key = ?");
      params.push(options.finish);
    }
  }
  if (options.duplicates) {
    where.push(`(SELECT COUNT(*) FROM fb_card_instances dup
      WHERE dup.tenant_id = ci.tenant_id AND dup.user_id = ci.user_id
        AND dup.card_id = ci.card_id AND dup.variant_id = ci.variant_id
        AND dup.status IN ('owned','reserved')) > 1`);
  }
  return { where: where.join(" AND "), params };
}

export async function countInventory(ctx: Ctx, options: InventoryQuery = {}): Promise<number> {
  const { where, params } = inventoryFilter(ctx, options);
  const row = await first<{ count: number }>(
    ctx.db,
    `SELECT COUNT(*) AS count
     FROM fb_card_instances ci
     JOIN fb_card_definitions cd ON cd.id = ci.card_id
     JOIN fb_variants v ON v.id = ci.variant_id
     JOIN fb_materials m ON m.id = v.material_id
     LEFT JOIN fb_effects fx ON fx.id = v.effect_id
     WHERE ${where}`,
    ...params,
  );
  return Number(row?.count ?? 0);
}

export async function getInventory(
  ctx: Ctx,
  options: InventoryQuery = {},
): Promise<InventoryRow[]> {
  const { where, params } = inventoryFilter(ctx, options);
  const limit = Math.min(500, Math.max(1, options.limit ?? 200));
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const order =
    options.sort === "name"
      ? "cd.name COLLATE NOCASE, ci.acquired_at DESC, ci.id DESC"
      : options.sort === "finish"
        ? "m.sort, fx.sort, cd.name COLLATE NOCASE, ci.id DESC"
        : "ci.acquired_at DESC, ci.id DESC";
  return all<InventoryRow>(
    ctx.db,
    `${INVENTORY_SELECT} WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
    ...params,
    limit,
    offset,
  );
}

export async function getInstance(ctx: Ctx, instanceId: string) {
  const user = ctx.user;
  if (!user) throw new ApiError(401, "authentication_required", "Sign in to inspect a card.");
  const instance = await first<
    InventoryRow & { description: string; card_status: string; acquired_via: string }
  >(
    ctx.db,
    `${INVENTORY_SELECT}
      WHERE ci.tenant_id = ? AND ci.id = ? AND (ci.user_id = ? OR EXISTS (
        SELECT 1 FROM fb_memberships m WHERE m.tenant_id = ci.tenant_id AND m.user_id = ? AND m.role IN ('owner','editor','economy_admin')
      ))`,
    ctx.tenant.id,
    instanceId,
    user.id,
    user.id,
  );
  if (!instance)
    throw new ApiError(404, "instance_not_found", "That card instance is not in your collection.");
  const history = await all<{
    id: string;
    event: string;
    from_user_id: string | null;
    to_user_id: string | null;
    reference_type: string | null;
    reference_id: string | null;
    created_at: string;
  }>(
    ctx.db,
    "SELECT id, event, from_user_id, to_user_id, reference_type, reference_id, created_at FROM fb_instance_history WHERE tenant_id = ? AND instance_id = ? ORDER BY created_at",
    ctx.tenant.id,
    instanceId,
  );
  const draws = await all<{
    id: string;
    pool_id: string;
    pool_revision: number;
    price: number;
    created_at: string;
  }>(
    ctx.db,
    "SELECT id, pool_id, pool_revision, price, created_at FROM fb_draws WHERE tenant_id = ? AND instance_id = ?",
    ctx.tenant.id,
    instanceId,
  );
  return { instance, history, draws };
}

export async function toggleFavourite(ctx: Ctx, instanceId: string, favourite: boolean) {
  const user = ctx.user!;
  const row = await first<{ id: string; card_id: string }>(
    ctx.db,
    "SELECT id, card_id FROM fb_card_instances WHERE id = ? AND tenant_id = ? AND user_id = ? AND status = 'owned'",
    instanceId,
    ctx.tenant.id,
    user.id,
  );
  if (!row) throw new ApiError(404, "instance_not_found", "That card is not in your collection.");
  await ctx.db.batch([
    ctx.db
      .prepare(
        "UPDATE fb_card_instances SET favourite = ?, updated_at = ? WHERE id = ? AND tenant_id = ? AND user_id = ?",
      )
      .bind(favourite ? 1 : 0, nowIso(), instanceId, ctx.tenant.id, user.id),
    auditStatement(
      ctx,
      favourite ? "instance.favourited" : "instance.unfavourited",
      "instance",
      instanceId,
    ),
  ]);
  if (favourite) {
    const { recordDailyInteraction } = await import("./missions");
    await recordDailyInteraction(ctx, "card.favourited", row.card_id);
  }
  return { id: instanceId, favourite };
}

export async function setLocked(ctx: Ctx, instanceId: string, locked: boolean) {
  const user = ctx.user!;
  const row = await first<{ id: string; card_id: string }>(
    ctx.db,
    "SELECT id, card_id FROM fb_card_instances WHERE id = ? AND tenant_id = ? AND user_id = ? AND status = 'owned'",
    instanceId,
    ctx.tenant.id,
    user.id,
  );
  if (!row) throw new ApiError(404, "instance_not_found", "That card is not in your collection.");
  await ctx.db.batch([
    ctx.db
      .prepare(
        "UPDATE fb_card_instances SET locked = ?, updated_at = ? WHERE id = ? AND tenant_id = ? AND user_id = ?",
      )
      .bind(locked ? 1 : 0, nowIso(), instanceId, ctx.tenant.id, user.id),
    auditStatement(ctx, locked ? "instance.locked" : "instance.unlocked", "instance", instanceId),
  ]);
  return { id: instanceId, locked };
}

export async function toggleWishlist(
  ctx: Ctx,
  cardId: string,
  wanted: boolean,
  target?: { materialKey?: string | null; effectKey?: string | null; variantId?: string | null },
) {
  const user = ctx.user!;
  const card = await first<{ id: string }>(
    ctx.db,
    "SELECT id FROM fb_card_definitions WHERE id = ? AND tenant_id = ?",
    cardId,
    ctx.tenant.id,
  );
  if (!card) throw new ApiError(404, "card_not_found", "Card not found.");
  let targetVariant: { id: string; material_key: string; effect_key: string | null } | null = null;
  if (target?.variantId) {
    targetVariant = await first<{ id: string; material_key: string; effect_key: string | null }>(
      ctx.db,
      `SELECT v.id, m.key AS material_key, e.key AS effect_key
         FROM fb_variants v JOIN fb_materials m ON m.id = v.material_id
         LEFT JOIN fb_effects e ON e.id = v.effect_id
        WHERE v.id = ? AND v.card_id = ? AND v.tenant_id = ? AND v.status = 'published' AND v.archived_at IS NULL`,
      target.variantId,
      cardId,
      ctx.tenant.id,
    );
    if (!targetVariant) throw new ApiError(422, "wishlist_target_invalid", "That published finish does not belong to this card.");
  }
  if (wanted) {
    await ctx.db
      .prepare(
        `INSERT INTO fb_wishlists (tenant_id, user_id, card_id, target_material_key, target_effect_key, target_variant_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, user_id, card_id) DO UPDATE SET
           target_material_key = excluded.target_material_key,
           target_effect_key = excluded.target_effect_key,
           target_variant_id = excluded.target_variant_id`,
      )
      .bind(
        ctx.tenant.id,
        user.id,
        cardId,
        targetVariant?.material_key ?? target?.materialKey ?? null,
        target?.effectKey ?? targetVariant?.effect_key ?? null,
        targetVariant?.id ?? null,
        nowIso(),
      )
      .run();
  } else {
    await ctx.db
      .prepare("DELETE FROM fb_wishlists WHERE tenant_id = ? AND user_id = ? AND card_id = ?")
      .bind(ctx.tenant.id, user.id, cardId)
      .run();
  }
  return {
    card_id: cardId,
    wanted,
    target_material_key: targetVariant?.material_key ?? target?.materialKey ?? null,
    target_effect_key: target?.effectKey ?? targetVariant?.effect_key ?? null,
    target_variant_id: targetVariant?.id ?? null,
  };
}

export async function getWishlist(ctx: Ctx) {
  const user = ctx.user!;
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
    `SELECT w.card_id, cd.name, cd.slug, w.target_material_key, w.target_effect_key, w.target_variant_id, v.name AS variant_name
       FROM fb_wishlists w JOIN fb_card_definitions cd ON cd.id = w.card_id
       LEFT JOIN fb_variants v ON v.id = w.target_variant_id
      WHERE w.tenant_id = ? AND w.user_id = ? ORDER BY w.created_at DESC`,
    ctx.tenant.id,
    user.id,
  );
}

export async function recyclePreview(ctx: Ctx, instanceId: string) {
  const user = ctx.user!;
  const instance = await first<InventoryRow>(
    ctx.db,
    `${INVENTORY_SELECT} WHERE ci.tenant_id = ? AND ci.id = ? AND ci.user_id = ? AND ci.status = 'owned'`,
    ctx.tenant.id,
    instanceId,
    user.id,
  );
  if (!instance)
    throw new ApiError(404, "instance_not_found", "That card is not available to recycle.");
  if (instance.favourite)
    throw new ApiError(
      409,
      "favourite_protected",
      "Remove the favourite mark before recycling this card.",
    );
  if (instance.locked)
    throw new ApiError(409, "locked_protected", "Locked cards cannot be recycled.");
  const settings = await first<{
    recycle_rates_json: string;
    recycle_enabled: number;
    currency_symbol: string;
  }>(
    ctx.db,
    "SELECT recycle_rates_json, recycle_enabled, currency_symbol FROM fb_economy_settings WHERE tenant_id = ?",
    ctx.tenant.id,
  );
  if (!settings?.recycle_enabled)
    throw new ApiError(409, "recycle_disabled", "Recycling is disabled in this cabinet.");
  const rates = JSON.parse(settings.recycle_rates_json) as {
    rarity: Record<string, number>;
    material: Record<string, number>;
  };
  const base = rates.rarity[instance.rarity_key ?? "common"] ?? 10;
  const bonus = rates.material[instance.material_key] ?? 0;
  return {
    instance,
    credit: base + bonus,
    breakdown: { rarity: base, material: bonus },
    currency_symbol: settings.currency_symbol,
    warning:
      "Recycling is permanent. The instance leaves your collection and the acquisition history remains in the ledger.",
  };
}

export async function recycleCommit(
  ctx: Ctx,
  input: { instanceId: string; idempotencyKey: string; expectedCredit: number },
) {
  const user = ctx.user!;
  const preview = await recyclePreview(ctx, input.instanceId);
  if (preview.credit !== input.expectedCredit) {
    throw new ApiError(
      409,
      "credit_changed",
      "The recycle value changed. Review it again before confirming.",
      {
        current_credit: preview.credit,
      },
    );
  }
  const receiptId = newId("rcy");
  const now = nowIso();
  try {
    await ctx.db.batch([
      ctx.db
        .prepare(
          "INSERT INTO fb_recycle_receipts (id, tenant_id, user_id, instance_id, credit_amount, created_at, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          receiptId,
          ctx.tenant.id,
          user.id,
          input.instanceId,
          preview.credit,
          now,
          input.idempotencyKey,
        ),
      auditStatement(ctx, "instance.recycled", "instance", input.instanceId, {
        credit: preview.credit,
      }),
    ]);
  } catch (error) {
    const message = String(error);
    if (message.includes("UNIQUE"))
      throw new ApiError(409, "recycle_conflict", "This recycle request was already processed.");
    if (message.includes("instance_not_eligible")) {
      throw new ApiError(
        409,
        "instance_not_eligible",
        "That card is no longer eligible to recycle. You were not credited.",
      );
    }
    throw error;
  }
  const balance = await first<{ balance: number }>(
    ctx.db,
    "SELECT balance FROM fb_wallets WHERE tenant_id = ? AND user_id = ?",
    ctx.tenant.id,
    user.id,
  );
  return {
    receipt_id: receiptId,
    instance_id: input.instanceId,
    credit: preview.credit,
    balance_after: balance?.balance ?? 0,
  };
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
  return all<{ id: string; display_name: string; role: string }>(
    ctx.db,
    `SELECT u.id, u.display_name, m.role
       FROM fb_memberships m JOIN fb_users u ON u.id = m.user_id
      WHERE m.tenant_id = ? AND m.status = 'active' AND m.revoked_at IS NULL
        AND u.disabled_at IS NULL AND u.is_synthetic = 0
      ORDER BY u.display_name`,
    ctx.tenant.id,
  );
}

/** Peer shelves deliberately disclose only the fields needed to choose a trade.
 * Collection and principal predicates are evaluated in the same D1 read.
 * Private curatorial access without an explicit viewer grant is conservatively
 * limited to the current owning Bot owner; unfiled cards are withheld.
 */
export async function getMemberTradeInventory(ctx: Ctx, memberId: string) {
  const user = ctx.user;
  if (!user) throw new ApiError(401, "authentication_required", "Sign in to continue.");
  const userSession = ctx.actor.type === "user" ? ctx.sessionId : null;
  const agentToken = ctx.actor.type === "agent" ? ctx.agentTokenId : null;
  if (!userSession && !agentToken)
    throw new ApiError(
      403,
      "trade_peer_authority_unavailable",
      "This shelf is unavailable for this credential.",
    );
  // Missing, inactive or newly revoked members produce the same empty shelf.
  // Checking existence separately would expose their state after a caller's
  // authority was revoked between reads.
  return all(
    ctx.db,
    `WITH principal AS (
    SELECT u.id AS user_id FROM fb_users u
    JOIN fb_memberships m ON m.user_id = u.id AND m.tenant_id = ?
    WHERE u.id = ? AND u.disabled_at IS NULL AND u.is_synthetic = 0 AND m.status = 'active' AND m.revoked_at IS NULL
      AND (EXISTS (SELECT 1 FROM fb_sessions s WHERE s.id = ? AND s.user_id = u.id AND s.tenant_id = m.tenant_id
             AND s.revoked_at IS NULL AND julianday(s.expires_at) > julianday('now'))
        OR EXISTS (SELECT 1 FROM fb_agent_tokens tok JOIN fb_agent_grants g ON g.id = tok.grant_id
             WHERE tok.id = ? AND tok.revoked_at IS NULL AND g.agent_id = ? AND g.represented_user_id = u.id
               AND g.tenant_id = m.tenant_id AND g.status = 'active' AND g.revoked_at IS NULL
               AND julianday(g.expires_at) > julianday('now')
               AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(g.scopes_json) THEN g.scopes_json ELSE '[]' END) scope
                           WHERE json_type(CASE WHEN json_valid(g.scopes_json) THEN g.scopes_json ELSE '[]' END) = 'array'
                             AND scope.type = 'text' AND scope.value = 'inventory:read')
               AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(g.scopes_json) THEN g.scopes_json ELSE '[]' END) scope_bad WHERE scope_bad.type <> 'text')))
  )
  SELECT ci.id, cd.name AS card_name, v.name AS variant_name, ci.serial,
         m.key AS material_key, fx.key AS effect_key,
         (SELECT vr.public_url FROM fb_variant_renders vr
           WHERE vr.variant_id = ci.variant_id AND vr.status = 'published' LIMIT 1) AS render_url
  FROM principal p JOIN fb_card_instances ci ON ci.tenant_id = ? AND ci.user_id = ?
  JOIN fb_card_definitions cd ON cd.id = ci.card_id
  JOIN fb_variants v ON v.id = ci.variant_id AND v.card_id = cd.id
  JOIN fb_materials m ON m.id = v.material_id
  LEFT JOIN fb_effects fx ON fx.id = v.effect_id
  JOIN fb_artwork_editions e ON e.id = v.edition_id AND e.tenant_id = v.tenant_id AND e.card_id = cd.id
  JOIN fb_assets subject ON subject.id = e.subject_asset_id AND subject.tenant_id = e.tenant_id
  WHERE ci.status = 'owned' AND ci.locked = 0 AND cd.status = 'published' AND cd.archived_at IS NULL
    AND v.status = 'published' AND v.archived_at IS NULL AND e.status = 'published' AND e.archived_at IS NULL
    AND (subject.origin NOT IN ('ai_assisted', 'ai_generated') OR EXISTS (
      SELECT 1 FROM fb_bots b WHERE b.tenant_id = ci.tenant_id AND b.status <> 'archived' AND b.ai_art_enabled = 1))
    AND EXISTS (SELECT 1 FROM fb_memberships target JOIN fb_users tu ON tu.id = target.user_id
      WHERE target.tenant_id = ci.tenant_id AND target.user_id = ci.user_id
        AND target.status = 'active' AND target.revoked_at IS NULL AND tu.disabled_at IS NULL AND tu.is_synthetic = 0)
    AND EXISTS (SELECT 1 FROM fb_collection_cards cc WHERE cc.card_id = cd.id)
    AND NOT EXISTS (
      SELECT 1 FROM fb_collection_cards cc JOIN fb_collections c ON c.id = cc.collection_id
      WHERE cc.card_id = cd.id AND NOT COALESCE(
        c.status = 'published' AND c.archived_at IS NULL
        AND (c.scope = 'global' OR c.owner_tenant_id = ci.tenant_id) AND (
          (c.view_audience = 'public' AND c.public_approved_at IS NOT NULL)
          OR (c.view_audience = 'members' AND EXISTS (SELECT 1 FROM fb_memberships cm
            WHERE cm.user_id = p.user_id AND cm.status = 'active' AND cm.revoked_at IS NULL
              AND (c.scope = 'global' OR cm.tenant_id = c.owner_tenant_id)))
          OR (c.view_audience = 'private' AND (
            EXISTS (SELECT 1 FROM fb_collection_viewers cv WHERE cv.collection_id = c.id AND cv.user_id = p.user_id AND cv.revoked_at IS NULL)
            OR (? = 1 AND EXISTS (SELECT 1 FROM fb_bots b JOIN fb_memberships om ON om.tenant_id = b.tenant_id AND om.user_id = p.user_id
              WHERE b.tenant_id = c.owner_tenant_id AND b.owner_user_id = p.user_id AND b.status <> 'archived'
                AND om.role = 'owner' AND om.status = 'active' AND om.revoked_at IS NULL))
          ))
        ), 0)
    )
  ORDER BY ci.acquired_at DESC LIMIT 200`,
    ctx.tenant.id,
    user.id,
    userSession,
    agentToken,
    ctx.actor.id,
    ctx.tenant.id,
    memberId,
    ctx.actor.type === "user" ? 1 : 0,
  );
}
