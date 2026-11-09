import { ApiError, type Ctx } from "../context";
import { all, first, nowIso } from "../db";
import { newId, sha256Hex } from "../ids";
import {
  auditStatement,
  findIdempotent,
  idempotencyStatement,
  type IdempotencyInput,
} from "../http";
import { getWallet } from "./wallet";
import { cardVisibilitySql, audienceRank, viewerAccess } from "./visibility";
import { botAllowsAiArt } from "./bots";
import { classifyArtLineage } from "./art-lineage";
import { liveViewerContext } from "./live-viewer";
import {
  readDrawScopeEpoch,
  DRAW_EPOCH_TRIGGER_CHECK,
  DRAW_EPOCH_TRIGGER_DATA,
  type DrawScopeEpoch,
  type DrawInstallationSnapshot,
} from "./draw-scope-epoch";

export interface PoolRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  status: string;
  revision: number;
  price: number;
  channel_key: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface EligibleEntry {
  variant_id: string;
  card_id: string;
  card_name: string;
  edition_name: string | null;
  variant_name: string;
  material_key: string;
  effect_key: string | null;
  render_url: string | null;
  weight: number;
  probability_bps: number;
  tags: string[];
  collections: Array<{ id: string; name: string }>;
}

export interface PoolScope {
  /** Guard revision captured before resolving the installation scope. */
  drawEpoch?: DrawScopeEpoch | null;
  drawInstallation?: DrawInstallationSnapshot;
  collectionIds: string[];
  audience: "public" | "members" | "private";
  digest: string;
  /** Discord scope: a card with no collection is not eligible. */
  requireFiled: boolean;
  aiArtEnabled: boolean;
}

export interface PoolPreview {
  pool: PoolRow;
  revision: number;
  price: number;
  eligible_count: number;
  total_weight: number;
  entries: EligibleEntry[];
  filters: {
    channel_key: string | null;
    excluded_tags: string[];
    tenant_excluded_tags: string[];
    player_excluded_tags: string[];
    player_hidden_collection_ids: string[];
    unfiled_count: number;
    out_of_scope_count: number;
    ai_excluded_count: number;
    ai_art_enabled: boolean;
    scope_digest: string | null;
    empty_reason: string | null;
  };
  pity: "disabled";
  expected_revision: number;
  /**
   * Identity of the exact eligible distribution the player is approving. A
   * pool revision alone cannot represent personal preferences, channel policy
   * or Bot collection availability changing under an unchanged pool.
   */
  distribution_fingerprint: string;
  currency: { name: string; symbol: string };
}

export async function listPools(ctx: Ctx, includeDrafts = false) {
  const rows = await all<PoolRow>(
    ctx.db,
    `SELECT * FROM fb_pools WHERE tenant_id = ? ${includeDrafts ? "" : "AND status = 'active'"} ORDER BY name`,
    ctx.tenant.id,
  );
  return rows;
}

/**
 * The authoritative player-facing pool list. A pool is offered only when the
 * same preview used by the commit path has at least one eligible entry for
 * this player, Bot distribution and channel. This prevents a disabled
 * collection from lingering in a selector, deep link or Discord picker merely
 * because the pool row is still active.
 */
export async function listEligiblePools(
  ctx: Ctx,
  channelKey?: string,
  scope?: PoolScope,
): Promise<PoolPreview[]> {
  const pools = await listPools(ctx);
  const previews = await Promise.all(
    pools.map((pool) =>
      getPoolPreview(ctx, pool.slug, channelKey, { scope }).catch((error: unknown) => {
        if (error instanceof ApiError && error.code === "pool_not_found") return null;
        throw error;
      }),
    ),
  );
  return previews
    .filter((preview): preview is PoolPreview => Boolean(preview && preview.eligible_count > 0))
    .sort((left, right) => {
      if (left.pool.slug === "cabinet-draw") return -1;
      if (right.pool.slug === "cabinet-draw") return 1;
      return left.pool.name.localeCompare(right.pool.name);
    });
}

export async function getPoolPreview(
  ctx: Ctx,
  slugOrId: string,
  channelKey?: string,
  options?: { includeDraft?: boolean; scope?: PoolScope },
): Promise<PoolPreview> {
  if (!ctx.user)
    throw new ApiError(401, "authentication_required", "Sign in to see the capsule pool.");
  if (options?.scope) await assertScopedPreviewAuthority(ctx, options.scope);
  const viewer = await liveViewerContext(ctx, ctx.user.id);
  if (!viewer)
    throw new ApiError(403, "membership_required", "Your access to this Bot has changed.");
  ctx = viewer;
  const pool = await first<PoolRow>(
    ctx.db,
    `SELECT * FROM fb_pools WHERE tenant_id = ? AND (id = ? OR slug = ?) ${options?.includeDraft ? "" : "AND status = 'active'"}`,
    ctx.tenant.id,
    slugOrId,
    slugOrId,
  );
  if (!pool) throw new ApiError(404, "pool_not_found", "No eligible pool was found.");
  const user = ctx.user;
  const tenantRow = await first<{ publication_json: string }>(
    ctx.db,
    "SELECT publication_json FROM fb_tenants WHERE id = ?",
    ctx.tenant.id,
  );
  const tenantPublication = parseTags(tenantRow?.publication_json, "blockedTags");
  const excluded = new Set<string>(tenantPublication);
  let channelExcluded: string[] = [];
  if (channelKey) {
    const policy = await first<{ exclude_tags_json: string }>(
      ctx.db,
      "SELECT exclude_tags_json FROM fb_topic_policies WHERE tenant_id = ? AND channel_key = ? AND active = 1",
      ctx.tenant.id,
      channelKey,
    );
    channelExcluded = policy ? (JSON.parse(policy.exclude_tags_json) as string[]) : [];
    for (const tag of channelExcluded) excluded.add(tag);
  }
  let playerExcluded: string[] = [];
  let playerHiddenCollections: string[] = [];
  if (user) {
    const prefs = await first<{ hide_tags_json: string; hidden_collection_ids_json?: string }>(
      ctx.db,
      "SELECT hide_tags_json, hidden_collection_ids_json FROM fb_player_preferences WHERE tenant_id = ? AND user_id = ?",
      ctx.tenant.id,
      user.id,
    );
    playerExcluded = prefs ? (JSON.parse(prefs.hide_tags_json) as string[]) : [];
    playerHiddenCollections = prefs?.hidden_collection_ids_json
      ? (JSON.parse(prefs.hidden_collection_ids_json) as string[])
      : [];
    for (const tag of playerExcluded) excluded.add(tag);
  }
  const hiddenCollections = new Set(playerHiddenCollections);
  if (!ctx.user)
    throw new ApiError(401, "authentication_required", "Sign in to see the capsule pool.");
  const access = await viewerAccess(ctx, { liveContentAdmin: true });
  const visibility = cardVisibilitySql(access, "cd");
  const entries = await all<{
    variant_id: string;
    card_id: string;
    card_name: string;
    edition_name: string | null;
    variant_name: string;
    material_key: string;
    effect_key: string | null;
    render_url: string | null;
    weight: number;
    tags_json: string;
    collections_json: string;
    subject_asset_id: string;
    background_asset_id: string | null;
  }>(
    ctx.db,
    `SELECT v.id AS variant_id, v.card_id, cd.name AS card_name, e.name AS edition_name, v.name AS variant_name,
            m.key AS material_key, fx.key AS effect_key, ('/media/render/' || r.asset_id) AS render_url, pe.weight,
            e.subject_asset_id, e.background_asset_id,
            COALESCE((SELECT json_group_array(t.slug) FROM fb_card_tags ct JOIN fb_tags t ON t.id = ct.tag_id WHERE ct.card_id = cd.id), '[]') AS tags_json,
            COALESCE((
              SELECT json_group_array(json_object('id', c.id, 'name', c.name, 'view_audience', c.view_audience))
                FROM fb_collection_cards cc
                JOIN fb_collections c ON c.id = cc.collection_id
               WHERE cc.card_id = cd.id AND c.status = 'published' AND c.archived_at IS NULL
                 AND (
                   (c.scope = 'bot' AND c.owner_tenant_id = pe.tenant_id)
                   OR EXISTS (
                     SELECT 1 FROM fb_bot_collections bc
                      JOIN fb_bots b ON b.id = bc.bot_id
                     WHERE bc.collection_id = c.id AND bc.enabled = 1 AND b.tenant_id = pe.tenant_id
                   )
                 )
            ), '[]') AS collections_json
       FROM fb_pool_entries pe
       JOIN fb_variants v ON v.id = pe.variant_id
       JOIN fb_artwork_editions e ON e.id = v.edition_id
       JOIN fb_assets sa ON sa.id = e.subject_asset_id AND sa.tenant_id = e.tenant_id
       JOIN fb_card_definitions cd ON cd.id = v.card_id
       JOIN fb_materials m ON m.id = v.material_id
       LEFT JOIN fb_effects fx ON fx.id = v.effect_id
       LEFT JOIN fb_variant_renders r ON r.variant_id = v.id AND r.tenant_id = v.tenant_id AND r.status = 'published'
      WHERE pe.tenant_id = ? AND pe.pool_id = ? AND pe.pool_revision = ? AND pe.enabled = 1
        AND v.status = 'published' AND v.archived_at IS NULL AND cd.status = 'published' AND cd.archived_at IS NULL
        AND r.id IS NOT NULL
        AND (${visibility.sql})
        AND (
          (v.tenant_id = pe.tenant_id AND cd.tenant_id = pe.tenant_id)
          OR EXISTS (
            SELECT 1 FROM fb_collection_cards cc JOIN fb_collections c ON c.id = cc.collection_id
             WHERE cc.card_id = cd.id AND c.scope = 'global' AND c.status = 'published' AND c.owner_tenant_id = v.tenant_id
          )
        )
        AND (
          NOT EXISTS (SELECT 1 FROM fb_collection_cards cc2 WHERE cc2.card_id = cd.id)
          OR EXISTS (
            SELECT 1 FROM fb_collection_cards cc3
            JOIN fb_bot_collections bc ON bc.collection_id = cc3.collection_id AND bc.enabled = 1
            JOIN fb_bots b ON b.id = bc.bot_id AND b.tenant_id = pe.tenant_id
            WHERE cc3.card_id = cd.id
          )
        )`,
    ctx.tenant.id,
    pool.id,
    pool.revision,
    ...visibility.params,
  );
  const eligible: EligibleEntry[] = [];
  let unfiledCount = 0;
  let outOfScopeCount = 0;
  let aiExcludedCount = 0;
  const aiAllowed = options?.scope?.aiArtEnabled ?? (await botAllowsAiArt(ctx.db, ctx.tenant.id));
  const scope = options?.scope;
  const lineage = aiAllowed
    ? new Map()
    : await classifyArtLineage(
        ctx.db,
        entries.flatMap((entry) =>
          [entry.subject_asset_id, entry.background_asset_id].filter((id): id is string =>
            Boolean(id),
          ),
        ),
      );
  for (const entry of entries) {
    const tags = JSON.parse(entry.tags_json) as string[];
    if (tags.some((tag) => excluded.has(tag))) continue;
    const collections = JSON.parse(entry.collections_json) as Array<{
      id: string;
      name: string;
      view_audience: "public" | "members" | "private";
    }>;
    if (collections.length === 0) {
      if (scope?.requireFiled) {
        outOfScopeCount += 1;
        continue;
      }
      // Legacy/unfiled cards stay eligible on interfaces that do not resolve a
      // configured server scope; Discord never uses this fallback.
      unfiledCount += 1;
    } else if (scope) {
      const outside = collections.some(
        (collection) =>
          !scope.collectionIds.includes(collection.id) ||
          audienceRank(collection.view_audience) > audienceRank(scope.audience),
      );
      if (outside) {
        outOfScopeCount += 1;
        continue;
      }
    }
    // Preserve the established treatment of a directly unclassified subject,
    // while never calling a derived asset with incomplete lineage non-AI.
    const subject = lineage.get(entry.subject_asset_id);
    const background = entry.background_asset_id ? lineage.get(entry.background_asset_id) : null;
    if (
      !aiAllowed &&
      (subject === "ai" ||
        background === "ai" ||
        subject === "unknown" ||
        background === "unknown" ||
        background === "unclassified")
    ) {
      aiExcludedCount += 1;
      continue;
    }
    if (
      collections.length > 0 &&
      hiddenCollections.size &&
      collections.every((collection) => hiddenCollections.has(collection.id))
    ) {
      // Multi-collection cards remain eligible while any member collection is
      // included; hiding every owning collection removes the card.
      continue;
    }
    eligible.push({
      variant_id: entry.variant_id,
      card_id: entry.card_id,
      card_name: entry.card_name,
      edition_name: entry.edition_name,
      variant_name: entry.variant_name,
      material_key: entry.material_key,
      effect_key: entry.effect_key,
      render_url: entry.render_url,
      weight: entry.weight,
      probability_bps: 0,
      tags,
      collections,
    });
  }
  const totalWeight = eligible.reduce((sum, entry) => sum + entry.weight, 0);
  for (const entry of eligible) {
    entry.probability_bps = totalWeight > 0 ? Math.round((entry.weight / totalWeight) * 10000) : 0;
  }
  const distributionFingerprint = await sha256Hex(
    JSON.stringify({
      pool_id: pool.id,
      pool_revision: pool.revision,
      price: pool.price,
      channel_key: channelKey ?? null,
      excluded_tags: [...excluded].sort(),
      hidden_collection_ids: [...hiddenCollections].sort(),
      scope_digest: scope?.digest ?? null,
      ai_art_enabled: aiAllowed,
      entries: eligible
        .map((entry) => ({ variant_id: entry.variant_id, weight: entry.weight }))
        .sort((left, right) => left.variant_id.localeCompare(right.variant_id)),
    }),
  );
  const economy = await first<{ currency_name: string; currency_symbol: string }>(
    ctx.db,
    "SELECT currency_name, currency_symbol FROM fb_economy_settings WHERE tenant_id = ?",
    ctx.tenant.id,
  );
  if (scope?.drawEpoch) {
    const current = await readDrawScopeEpoch(ctx);
    if (
      !current ||
      current.global !== scope.drawEpoch.global ||
      current.tenant !== scope.drawEpoch.tenant || current.user !== scope.drawEpoch.user || current.userId !== scope.drawEpoch.userId
    )
      throw new ApiError(
        409,
        "stale_scope",
        "Server options changed while loading. Reload before drawing.",
      );
  }
  const emptyReason =
    eligible.length > 0
      ? null
      : aiExcludedCount > 0 && aiExcludedCount === entries.length
        ? "Every eligible card has AI-assisted artwork or unverified artwork lineage, which this Bot excludes from new draws. Nothing will be charged."
        : scope && outOfScopeCount > 0 && outOfScopeCount === entries.length
          ? "Every entry in this capsule belongs to a collection this server has not enabled for this channel. Nothing will be charged."
          : hiddenCollections.size
            ? "Every card in this capsule belongs to a collection you turned off in your draw preferences. Nothing will be charged."
            : entries.length > 0
              ? "Every entry in this pool is hidden by the active topic policy, the server's collection scope, the AI-artwork preference or your preferences. Nothing will be charged."
              : "This pool has no published variants with a finished render. Nothing will be charged.";
  return {
    pool,
    revision: pool.revision,
    price: pool.price,
    eligible_count: eligible.length,
    total_weight: totalWeight,
    entries: eligible,
    filters: {
      channel_key: channelKey ?? null,
      excluded_tags: [...excluded],
      tenant_excluded_tags: tenantPublication,
      player_excluded_tags: playerExcluded,
      player_hidden_collection_ids: playerHiddenCollections,
      unfiled_count: unfiledCount,
      out_of_scope_count: outOfScopeCount,
      ai_excluded_count: aiExcludedCount,
      ai_art_enabled: aiAllowed,
      scope_digest: scope?.digest ?? null,
      empty_reason: emptyReason,
    },
    pity: "disabled",
    expected_revision: pool.revision,
    distribution_fingerprint: distributionFingerprint,
    currency: { name: economy?.currency_name ?? "Foil", symbol: economy?.currency_symbol ?? "✦" },
  };
}

/** Read an existing installation-scoped API receipt without starting a draw.
 * The receipt, owning user, current membership and exact credential are checked
 * in one statement; installation availability cannot erase a committed draw.
 */
function scopedDrawAuthority(ctx: Ctx, exactScopes = false, requiredScope = "draw:execute") {
  const user = ctx.user;
  if (
    !user ||
    ctx.actor.representedUserId !== user.id ||
    (ctx.actor.type === "user" && ctx.actor.id !== user.id)
  )
    return null;
  if (ctx.discordPrincipal) {
    if (ctx.actor.type !== "user") return null;
    return {
      sql: `EXISTS (SELECT 1 FROM fb_discord_identities d WHERE d.tenant_id=m.tenant_id AND d.user_id=u.id AND d.discord_user_id=? AND d.revoked_at IS NULL)`,
      args: [ctx.discordPrincipal.discordUserId],
    };
  }
  const access =
    ctx.sessionAssurance === "access" && ctx.accessStatus === "linked" ? ctx.accessIdentity : null;
  return {
    sql: `((?='user' AND (EXISTS (SELECT 1 FROM fb_sessions s WHERE s.id=? AND s.user_id=u.id AND s.tenant_id=m.tenant_id AND s.revoked_at IS NULL AND s.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      OR (?='access' AND ?>unixepoch('now') AND EXISTS (SELECT 1 FROM fb_access_identities ai WHERE ai.user_id=u.id AND ai.team_domain=? AND ai.subject=? AND ai.email=? AND ai.revoked_at IS NULL) AND u.email=? COLLATE NOCASE)))
      OR (?='agent' AND EXISTS (SELECT 1 FROM fb_agent_tokens t JOIN fb_agent_grants g ON g.id=t.grant_id WHERE t.id=? AND g.id=? AND t.revoked_at IS NULL
        AND g.agent_id=? AND g.represented_user_id=u.id AND g.tenant_id=m.tenant_id AND g.status='active' AND g.revoked_at IS NULL AND g.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
        AND json_type(CASE WHEN json_valid(g.scopes_json) THEN g.scopes_json ELSE 'null' END)='array'
        AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(g.scopes_json) THEN g.scopes_json ELSE '[]' END) WHERE type<>'text')
        AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(g.scopes_json) THEN g.scopes_json ELSE '[]' END) WHERE value=?) ${exactScopes ? "AND json(g.scopes_json)=json(?)" : ""})))`,
    args: [
      ctx.actor.type,
      ctx.sessionId,
      ctx.sessionAssurance,
      access?.payload.exp ?? 0,
      ctx.config.access.teamDomain,
      access?.subject ?? "",
      access?.email ?? "",
      access?.email ?? "",
      ctx.actor.type,
      ctx.agentCredential?.tokenId ?? "",
      ctx.agentCredential?.grantId ?? "",
      ctx.actor.id,
      requiredScope,
      ...(exactScopes ? [JSON.stringify(ctx.scopes)] : []),
    ],
  };
}

async function assertScopedPreviewAuthority(ctx: Ctx, scope: PoolScope): Promise<void> {
  const user = ctx.user;
  const installation = scope.drawInstallation;
  const requiredScope = ctx.scopes?.includes("inventory:read") ? "inventory:read" : "draw:execute";
  const authority = scopedDrawAuthority(ctx, true, requiredScope);
  if (!user || !installation || !authority)
    throw new ApiError(
      403,
      "draw_authority_required",
      "Sign in again before viewing server-scoped draw options.",
    );
  const result = await first<{ ok: number }>(
    ctx.db,
    `SELECT EXISTS (
    SELECT 1 FROM fb_memberships m JOIN fb_users u ON u.id=m.user_id AND u.disabled_at IS NULL
    JOIN fb_discord_installations di ON di.id=? AND di.tenant_id=m.tenant_id AND di.active=1 AND di.revoked_at IS NULL AND di.game_enabled=1
    JOIN fb_bots b ON b.tenant_id=di.tenant_id AND b.status='active' AND (di.bot_id IS NULL OR di.bot_id=b.id)
    WHERE m.tenant_id=? AND m.user_id=? AND m.status='active' AND m.revoked_at IS NULL
      AND di.configuration_revision=? AND di.bot_id IS ? AND di.channel_allowlist_json IS ? AND di.collection_allowlist_json IS ? AND di.channel_audience_json IS ? AND di.channel_key IS ? AND ${authority.sql}
  ) AS ok`,
    installation.id,
    ctx.tenant.id,
    user.id,
    installation.revision,
    installation.botId,
    installation.channelAllowlist,
    installation.collectionAllowlist,
    installation.channelAudience,
    installation.channelKey,
    ...authority.args,
  );
  if (!result?.ok)
    throw new ApiError(
      403,
      "draw_authority_changed",
      "Your access or server configuration changed. Reload before drawing.",
    );
}

function sameDrawInstallation(
  left: DrawInstallationSnapshot,
  right: DrawInstallationSnapshot,
): boolean {
  return (
    left.id === right.id &&
    left.revision === right.revision &&
    left.botId === right.botId &&
    left.channelAllowlist === right.channelAllowlist &&
    left.collectionAllowlist === right.collectionAllowlist &&
    left.channelAudience === right.channelAudience &&
    left.channelKey === right.channelKey
  );
}

function safeDrawReplay(receipt: Record<string, unknown>, currentBalance: number | null | undefined) {
  const confirmed = receipt.settlement_status === "settled" && receipt.settlement_pending === false && typeof currentBalance === "number";
  return {
    ...receipt,
    replayed: true,
    current_balance: typeof currentBalance === "number" ? currentBalance : undefined,
    settlement_status: confirmed ? "settled" : "pending",
    settlement_pending: !confirmed,
  };
}

export async function readAuthorizedScopedDrawReplay(ctx: Ctx, input: IdempotencyInput) {
  const user = ctx.user;
  const authority = scopedDrawAuthority(ctx);
  if (!user || !authority) return null;
  const row = await first<{
    request_digest: string;
    response_json: string;
    current_balance: number | null;
  }>(
    ctx.db,
    `SELECT k.request_digest,k.response_json,
    (SELECT w.balance FROM fb_wallets w WHERE w.tenant_id=k.tenant_id AND w.user_id=?) AS current_balance
    FROM fb_idempotency_keys k JOIN fb_draws d ON d.id=json_extract(k.response_json,'$.draw_id') AND d.tenant_id=k.tenant_id AND d.user_id=?
    JOIN fb_memberships m ON m.tenant_id=k.tenant_id AND m.user_id=d.user_id AND m.status='active' AND m.revoked_at IS NULL
    JOIN fb_users u ON u.id=m.user_id AND u.disabled_at IS NULL
    WHERE k.tenant_id=? AND k.actor_type=? AND k.actor_id=? AND k.operation='draw.execute' AND k.idempotency_key=? AND ${authority.sql}`,
    user.id,
    user.id,
    ctx.tenant.id,
    ctx.actor.type,
    ctx.actor.id,
    input.key,
    ...authority.args,
  );
  if (!row) return null;
  if (row.request_digest !== input.digest)
    throw new ApiError(
      409,
      "idempotency_conflict",
      "This idempotency key was already used with a different request.",
    );
  const receipt = JSON.parse(row.response_json) as Record<string, unknown>;
  return safeDrawReplay(receipt, row.current_balance);
}

export async function executeDraw(ctx: Ctx, input: Parameters<typeof executeDrawInternal>[1]) {
  try {
    return await executeDrawInternal(ctx, input);
  } catch (error) {
    if (!(input.scope || input.discordInstallation || input.authorizedReplayOnly)) throw error;
    return recoverScopedDrawFailure(ctx, input.idempotency, error);
  }
}


/** Recover only through live authority; absence cannot prove a peer won't commit. */
export async function recoverScopedDrawFailure(ctx: Ctx, idempotency: IdempotencyInput, error: unknown) {
  try {
    const replay = await readAuthorizedScopedDrawReplay(ctx, idempotency);
    if (replay) return replay;
  } catch {
    // A failed lookup cannot prove the outcome or grant receipt access.
  }
  if (!(error instanceof ApiError)) console.error(JSON.stringify({ level: "error", message: "scoped draw failed" }));
  throw new ApiError(error instanceof ApiError ? error.status : 503,
    error instanceof ApiError ? error.code : "draw_outcome_uncertain",
    "This opening's outcome could not be confirmed. Check your collection for an opening that already completed before starting a new one.",
    { ...(error instanceof ApiError ? error.details : {}), draw_outcome_uncertain: true });
}

async function executeDrawInternal(
  ctx: Ctx,
  input: {
    pool: string;
    expectedRevision: number;
    /** The exact distribution fingerprint returned by the preview the player approved. */
    expectedDistribution: string;
    channelKey?: string;
    /** Server-scoped predicate shared by preview and commit. */
    scope?: PoolScope;
    /** Internal-only NPC reservation, revalidated in the draw transaction. */
    npcActionId?: string;
    /** Internal Discord installation bound at the draw transaction. */
    discordInstallation?: {
      id: string;
      revision: number;
      botId: string | null;
      channelAllowlist: string;
      collectionAllowlist: string | null;
      channelAudience: string | null;
      channelKey: string | null;
    };
    /** API replay reads must revalidate the exact current credential. */
    authorizedReplayOnly?: boolean;
    idempotency: IdempotencyInput;
  },
) {
  const user = ctx.user;
  if (!user) throw new ApiError(401, "authentication_required", "Sign in to draw.");
  const requireAuthorisedReplay = Boolean(
    input.authorizedReplayOnly || (input.discordInstallation && ctx.discordPrincipal),
  );
  if (requireAuthorisedReplay) {
    const replay = await readAuthorizedScopedDrawReplay(ctx, input.idempotency);
    if (replay) return replay;
  }
  const replay = requireAuthorisedReplay
    ? null
    : await findIdempotent(ctx, "draw.execute", input.idempotency);
  if (replay) {
    // The stored receipt is the transaction-time record. The current balance
    // may have moved since then (another tab, mission or grant), so expose it
    // separately rather than overwriting history. A balance read failure must
    // not turn a committed replay into a generic failure.
    const stored = replay.response as Record<string, unknown>;
    const current = await readWalletBalance(ctx, user.id);
    return safeDrawReplay(stored, current?.balance);
  }
  // A new scoped draw needs the captured epoch and matching installation
  // snapshot for the transaction guards. Authorised replay is handled above.
  if (
    (input.discordInstallation || input.scope || input.authorizedReplayOnly) &&
    (!input.scope?.drawEpoch || input.scope.drawEpoch.userId !== user.id ||
      !input.scope.drawInstallation ||
      !input.discordInstallation ||
      !sameDrawInstallation(input.scope.drawInstallation, input.discordInstallation))
  ) {
    // A concurrent same-key request may have committed after the initial
    // lookup. Recover it if still authorised before reporting unavailability.
    if (requireAuthorisedReplay) {
      const concurrentReplay = await readAuthorizedScopedDrawReplay(ctx, input.idempotency);
      if (concurrentReplay) return concurrentReplay;
    }
    throw new ApiError(
      503,
      "scoped_draw_temporarily_unavailable",
      "Server-scoped draws are temporarily unavailable. Check your collection for any opening already completed.",
    );
  }
  const preview = await getPoolPreview(ctx, input.pool, input.channelKey, {
    scope: input.scope,
  });
  if (preview.revision !== input.expectedRevision) {
    throw new ApiError(
      409,
      "stale_pool_revision",
      "The pool changed. Review the new odds before drawing.",
      {
        expected_revision: preview.revision,
        expected_distribution: preview.distribution_fingerprint,
      },
    );
  }
  if (preview.eligible_count === 0) {
    throw new ApiError(
      409,
      "empty_pool",
      preview.filters.empty_reason ?? "This pool has no eligible cards. You were not charged.",
    );
  }
  if (preview.distribution_fingerprint !== input.expectedDistribution) {
    throw new ApiError(
      409,
      "stale_distribution",
      "Your eligible cards, odds or collection availability changed after you reviewed them. Review the new odds before drawing. Nothing was charged.",
      {
        expected_revision: preview.revision,
        expected_distribution: preview.distribution_fingerprint,
      },
    );
  }
  const wallet = await getWallet(ctx.db, ctx.tenant.id, user.id);
  if (wallet.balance < preview.price) {
    throw new ApiError(
      409,
      "insufficient_funds",
      `You need ${preview.price} ${wallet.currency_symbol} for this draw.`,
      {
        balance: wallet.balance,
        price: preview.price,
      },
    );
  }
  const drawId = newId("drw");
  const instanceId = newId("ins");
  const random = crypto.getRandomValues(new Uint32Array(1))[0]!;
  const selected = pickWeighted(preview.entries, random, preview.total_weight);
  const prior = await first<{ copies: number; finishes: number }>(
    ctx.db,
    `SELECT COUNT(*) AS copies,
            (SELECT COUNT(*) FROM fb_card_instances ci2 WHERE ci2.tenant_id = ? AND ci2.user_id = ? AND ci2.variant_id = ?) AS finishes
       FROM fb_card_instances ci WHERE ci.tenant_id = ? AND ci.user_id = ? AND ci.card_id = ?`,
    ctx.tenant.id,
    user.id,
    selected.variant_id,
    ctx.tenant.id,
    user.id,
    selected.card_id,
  );
  const commitment = await sha256Hex(
    `${drawId}:${random}:${selected.variant_id}:${ctx.config.sessionSecret}`,
  );
  const serial = makeSerial(user.displayName, preview.revision);
  const now = nowIso();
  const receipt = {
    draw_id: drawId,
    instance_id: instanceId,
    pool_id: preview.pool.id,
    pool_slug: preview.pool.slug,
    pool_revision: preview.revision,
    pool_name: preview.pool.name,
    price: preview.price,
    currency: preview.currency,
    variant_id: selected.variant_id,
    card_id: selected.card_id,
    card_name: selected.card_name,
    edition_name: selected.edition_name,
    variant_name: selected.variant_name,
    material_key: selected.material_key,
    effect_key: selected.effect_key,
    render_url: selected.render_url,
    serial,
    new_subject: (prior?.copies ?? 0) === 0,
    new_finish: (prior?.finishes ?? 0) === 0,
    owned_copies: (prior?.copies ?? 0) + 1,
    eligible_count: preview.eligible_count,
    total_weight: preview.total_weight,
    selected_weight: selected.weight,
    probability_bps: selected.probability_bps,
    odds: preview.entries.map((entry) => ({
      variant_id: entry.variant_id,
      card_name: entry.card_name,
      edition_name: entry.edition_name,
      variant_name: entry.variant_name,
      probability_bps: entry.probability_bps,
      weight: entry.weight,
    })),
    filters: preview.filters,
    distribution_fingerprint: preview.distribution_fingerprint,
    pity: preview.pity,
    random_commitment: commitment,
    drawn_at: now,
  };

  const authority = input.scope
    ? scopedDrawAuthority(ctx, true)
    : input.authorizedReplayOnly
      ? scopedDrawAuthority(ctx)
      : null;
  if ((input.scope || input.authorizedReplayOnly) && !authority)
    throw new ApiError(403, "draw_authority_required", "Sign in again before opening a capsule.");
  const statements = [
    ...(input.scope?.drawEpoch
      ? [
          ctx.db
            .prepare(
              `SELECT CASE WHEN EXISTS (
      SELECT 1 FROM fb_draw_scope_global_epoch g WHERE g.id=1 AND g.revision=?
        AND COALESCE((SELECT revision FROM fb_draw_scope_tenant_epochs WHERE tenant_id=?),0)=?
        AND COALESCE((SELECT revision FROM fb_draw_scope_user_epochs WHERE user_id=?),0)=?
        AND ${DRAW_EPOCH_TRIGGER_CHECK}
    ) THEN 1 ELSE json('draw_epoch_changed') END`,
            )
            .bind(input.scope.drawEpoch.global, ctx.tenant.id, input.scope.drawEpoch.tenant, user.id, input.scope.drawEpoch.user, DRAW_EPOCH_TRIGGER_DATA),
        ]
      : []),
    ...(authority
      ? [
          ctx.db
            .prepare(
              `SELECT CASE WHEN EXISTS (
      SELECT 1 FROM fb_memberships m JOIN fb_users u ON u.id=m.user_id AND u.disabled_at IS NULL
      WHERE m.tenant_id=? AND m.user_id=? AND m.status='active' AND m.revoked_at IS NULL AND ${authority.sql}
    ) THEN 1 ELSE json('draw_authority_changed') END`,
            )
            .bind(ctx.tenant.id, user.id, ...authority.args),
        ]
      : []),
    ...(input.discordInstallation
      ? [
          ctx.db
            .prepare(
              `SELECT CASE WHEN EXISTS (
      SELECT 1 FROM fb_discord_installations di JOIN fb_bots b ON b.tenant_id=di.tenant_id AND (di.bot_id IS NULL OR b.id=di.bot_id)
      WHERE di.id=? AND di.tenant_id=? AND di.active=1 AND di.revoked_at IS NULL AND di.game_enabled=1 AND b.status='active'
        AND di.configuration_revision=? AND di.bot_id IS ? AND di.channel_allowlist_json IS ? AND di.collection_allowlist_json IS ? AND di.channel_audience_json IS ? AND di.channel_key IS ?
    ) THEN 1 ELSE json('discord_scope_changed') END`,
            )
            .bind(
              input.discordInstallation.id,
              ctx.tenant.id,
              input.discordInstallation.revision,
              input.discordInstallation.botId,
              input.discordInstallation.channelAllowlist,
              input.discordInstallation.collectionAllowlist,
              input.discordInstallation.channelAudience,
              input.discordInstallation.channelKey,
            ),
        ]
      : []),
    ...(input.npcActionId
      ? [
          ctx.db
            .prepare(
              `SELECT CASE WHEN EXISTS (
      SELECT 1 FROM fb_npc_actions a JOIN fb_npc_collectors n ON n.id = a.npc_id AND n.tenant_id = a.tenant_id
        JOIN fb_bots b ON b.id = n.bot_id AND b.tenant_id = n.tenant_id
      WHERE a.id = ? AND a.tenant_id = ? AND a.status = 'planned' AND n.user_id = ? AND n.status = 'active' AND b.status = 'active'
        AND COALESCE((SELECT paused_all FROM fb_npc_limits WHERE tenant_id = a.tenant_id), 0) = 0
        AND (SELECT COUNT(*) FROM fb_npc_actions x WHERE x.tenant_id = a.tenant_id AND x.action = 'draw' AND x.status IN ('planned','failed','completed')
          AND (x.created_at >= strftime('%Y-%m-%dT00:00:00.000Z','now') OR x.id = a.id)) <= COALESCE((SELECT max_draws_per_day FROM fb_npc_limits WHERE tenant_id = a.tenant_id), 40)
      ) THEN 1 ELSE json('npc_guard_rejected') END`,
            )
            .bind(input.npcActionId, ctx.tenant.id, user.id),
        ]
      : []),
    // Receipt ownership flags were computed before this transaction. Reject if
    // inventory changed in between so neither the stored receipt nor a retry
    // can misrepresent the committed draw.
    ctx.db.prepare(`SELECT CASE WHEN
      (SELECT COUNT(*) FROM fb_card_instances WHERE tenant_id=? AND user_id=? AND card_id=?)=?
      AND (SELECT COUNT(*) FROM fb_card_instances WHERE tenant_id=? AND user_id=? AND variant_id=?)=?
      THEN 1 ELSE json('draw_inventory_changed') END`)
      .bind(ctx.tenant.id, user.id, selected.card_id, prior?.copies ?? 0,
        ctx.tenant.id, user.id, selected.variant_id, prior?.finishes ?? 0),
    idempotencyStatement(ctx, "draw.execute", input.idempotency, receipt),
    ctx.db
      .prepare(
        `INSERT INTO fb_draws
          (id, tenant_id, user_id, pool_id, pool_revision, price, variant_id, instance_id, created_at, idempotency_key, receipt_json, random_commitment)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        drawId,
        ctx.tenant.id,
        user.id,
        preview.pool.id,
        preview.revision,
        preview.price,
        selected.variant_id,
        instanceId,
        now,
        input.idempotency.key,
        JSON.stringify(receipt),
        commitment,
      ),
    ctx.db
      .prepare(
        `INSERT INTO fb_card_instances
          (id, tenant_id, user_id, card_id, variant_id, serial, acquired_via, acquired_at, status, favourite, locked, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'draw', ?, 'owned', 0, 0, ?)`,
      )
      .bind(
        instanceId,
        ctx.tenant.id,
        user.id,
        selected.card_id,
        selected.variant_id,
        serial,
        now,
        now,
      ),
    ctx.db
      .prepare(
        "INSERT INTO fb_instance_history (id, tenant_id, instance_id, event, from_user_id, to_user_id, reference_type, reference_id, metadata_json, created_at) VALUES (?, ?, ?, 'drawn', NULL, ?, 'draw', ?, ?, ?)",
      )
      .bind(
        newId("ih"),
        ctx.tenant.id,
        instanceId,
        user.id,
        drawId,
        JSON.stringify({ pool_revision: preview.revision, price: preview.price }),
        now,
      ),
    auditStatement(ctx, "draw.executed", "draw", drawId, {
      pool_id: preview.pool.id,
      pool_revision: preview.revision,
      price: preview.price,
      variant_id: selected.variant_id,
      instance_id: instanceId,
    }),
  ];
  try {
    await ctx.db.batch(statements);
  } catch (error) {
    const message = String(error);
    // A competing same-key draw can commit just before the installation
    // guard rejects this batch. Reconcile before saying nothing was charged.
    if (input.discordInstallation) {
      if (requireAuthorisedReplay) {
        const existing = await readAuthorizedScopedDrawReplay(ctx, input.idempotency);
        if (existing) return existing;
      } else {
        const existing = await findIdempotent(ctx, "draw.execute", input.idempotency);
        if (existing) return safeDrawReplay(existing.response as Record<string, unknown>, undefined);
      }
    }
    if (message.includes("UNIQUE") && message.includes("fb_idempotency_keys")) {
      if (requireAuthorisedReplay) {
        const existing = await readAuthorizedScopedDrawReplay(ctx, input.idempotency);
        if (existing) return existing;
        throw new ApiError(
          409,
          "draw_conflict",
          "This draw request collided with another request. Reload your collection.",
        );
      }
      const existing = await findIdempotent(ctx, "draw.execute", input.idempotency);
      if (existing) return safeDrawReplay(existing.response as Record<string, unknown>, undefined);
      throw new ApiError(
        409,
        "draw_conflict",
        "This draw request collided with another request. Reload your collection.",
      );
    }
    if (authority) {
      const current = await first<{ ok: number }>(
        ctx.db,
        `SELECT EXISTS (
        SELECT 1 FROM fb_memberships m JOIN fb_users u ON u.id=m.user_id AND u.disabled_at IS NULL
        WHERE m.tenant_id=? AND m.user_id=? AND m.status='active' AND m.revoked_at IS NULL AND ${authority.sql}
      ) AS ok`,
        ctx.tenant.id,
        user.id,
        ...authority.args,
      );
      if (!current?.ok)
        throw new ApiError(
          403,
          "draw_authority_changed",
          "Your access changed. Sign in again and check your collection before retrying with the same key.",
        );
    }
    if (input.discordInstallation) {
      const d = input.discordInstallation;
      const active = await first<{ ok: number }>(
        ctx.db,
        `SELECT EXISTS (SELECT 1 FROM fb_discord_installations di JOIN fb_bots b ON b.tenant_id=di.tenant_id AND (di.bot_id IS NULL OR b.id=di.bot_id) WHERE di.id=? AND di.tenant_id=? AND di.active=1 AND di.revoked_at IS NULL AND di.game_enabled=1 AND b.status='active') AS ok`,
        d.id,
        ctx.tenant.id,
      );
      if (!active?.ok)
        throw new ApiError(
          409,
          "discord_game_disabled",
          "Discord gameplay is paused for this server. You were not charged.",
        );
      const unchanged = await first<{ ok: number }>(
        ctx.db,
        `SELECT EXISTS (SELECT 1 FROM fb_discord_installations di WHERE di.id=? AND di.tenant_id=? AND di.configuration_revision=? AND di.bot_id IS ? AND di.channel_allowlist_json IS ? AND di.collection_allowlist_json IS ? AND di.channel_audience_json IS ? AND di.channel_key IS ?) AS ok`,
        d.id,
        ctx.tenant.id,
        d.revision,
        d.botId,
        d.channelAllowlist,
        d.collectionAllowlist,
        d.channelAudience,
        d.channelKey,
      );
      if (!unchanged?.ok)
        throw new ApiError(
          409,
          "stale_scope",
          "The server configuration changed before the draw. Review the new options. You were not charged.",
        );
    }
    if (input.scope?.drawEpoch) {
      const current = await readDrawScopeEpoch(ctx);
      if (
        !current ||
        current.global !== input.scope.drawEpoch.global ||
        current.tenant !== input.scope.drawEpoch.tenant || current.user !== input.scope.drawEpoch.user
      )
        throw new ApiError(
          409,
          "stale_distribution",
          "The available cards or odds changed. Review them again. You were not charged.",
        );
    }
    if (message.includes("insufficient_funds")) {
      throw new ApiError(
        409,
        "insufficient_funds",
        "Your balance changed before the draw. You were not charged.",
      );
    }
    if (message.includes("stale_pool_revision")) {
      throw new ApiError(
        409,
        "stale_pool_revision",
        "The pool changed before the draw. You were not charged.",
      );
    }
    if (message.includes("variant_unavailable")) {
      throw new ApiError(
        409,
        "pool_changed",
        "A pool entry became unavailable. You were not charged.",
      );
    }
    if (message.includes("collection_disabled")) {
      throw new ApiError(
        409,
        "collection_disabled",
        "That card's collection is turned off for this Bot. You were not charged.",
      );
    }
    if (message.includes("UNIQUE") && message.includes("fb_card_instances")) {
      throw new ApiError(
        409,
        "serial_collision",
        "The cabinet could not assign a serial. Try the draw again.",
      );
    }
    // D1 may redact json()'s argument in its error text. Re-read only after a
    // failed atomic batch and after same-key recovery, to identify this guard.
    if (message.includes("malformed JSON")) {
      const current = await first<{ copies: number; finishes: number }>(ctx.db,
        `SELECT (SELECT COUNT(*) FROM fb_card_instances WHERE tenant_id=? AND user_id=? AND card_id=?) AS copies,
                (SELECT COUNT(*) FROM fb_card_instances WHERE tenant_id=? AND user_id=? AND variant_id=?) AS finishes`,
        ctx.tenant.id, user.id, selected.card_id, ctx.tenant.id, user.id, selected.variant_id);
      if (current && (current.copies !== (prior?.copies ?? 0) || current.finishes !== (prior?.finishes ?? 0))) {
        throw new ApiError(409, "draw_inventory_changed", "Your cabinet changed before the draw. Try again. Nothing was charged.");
      }
    }
    throw error;
  }
  // Everything below is presentation/settlement work after the atomic commit.
  // It must never turn a committed draw into a generic failure. The draw row
  // remains the authoritative transaction-time receipt; recovery can rebuild
  // the same card, serial, debit and settled rewards from it.
  // The draw trigger records the wallet balance inside the debit transaction,
  // including for free draws. A later wallet read may include unrelated work.
  const balanceAfterDebit = await readDebitLedgerBalance(ctx, user.id, drawId, preview.price);
  let settlementPending = balanceAfterDebit === null;

  let achievements: Array<{
    id: string;
    name: string;
    reward_amount: number;
    reward_state: string | null;
  }> = [];
  try {
    const { evaluateAchievements, recordDomainEvent } = await import("./achievements");
    const eventId = await recordDomainEvent(ctx, {
      type: "card.drawn",
      objectType: "draw",
      objectId: drawId,
      dedupeKey: `draw:${drawId}`,
      userId: user.id,
      payload: {
        card_id: selected.card_id,
        variant_id: selected.variant_id,
        instance_id: instanceId,
      },
    });
    const result = await evaluateAchievements(ctx, { userId: user.id, eventId });
    achievements = result.newlyUnlocked.map((item) => ({
      id: item.id,
      name: item.name,
      reward_amount: item.reward_amount,
      reward_state: item.reward_state,
    }));
  } catch (error) {
    settlementPending = true;
    console.error(
      JSON.stringify({
        level: "error",
        message: "achievement evaluation after draw failed",
        draw_id: drawId,
        error: String(error),
      }),
    );
  }
  // Reward fulfilment may have credited Foil after the debit. Read the wallet
  // again and expose each part separately: the opening debit, settled credits,
  // and the authoritative settled balance. Never show pre-reward money as the
  // result of a reward-paying opening.
  const settlementRead = await readWalletBalance(ctx, user.id);
  const verifiedCredits = await readSettledAchievementCredits(ctx, user.id, drawId);
  if (verifiedCredits === null) settlementPending = true;
  const achievementCredits = verifiedCredits ?? [];
  const creditsTotal = achievementCredits.reduce((sum, item) => sum + item.amount, 0);
  if (settlementRead === null) settlementPending = true;
  // An internal reward read-back failure can still leave the credit in the
  // ledger. Reconcile against the ledger before presenting the result so the
  // settled reward is shown once and a mismatch is never called settled.
  if (settlementRead && balanceAfterDebit !== null && settlementRead.balance !== balanceAfterDebit + creditsTotal) {
    settlementPending = true;
  }
  // A failed fulfilment may have committed before read-back failed. Use
  // reconciled ledger credits to distinguish that case from an unpaid unlock.
  if (
    achievements.some(
      (item) =>
        item.reward_amount > 0 &&
        !achievementCredits.some(
          (credit) => credit.id === item.id && credit.amount >= item.reward_amount,
        ),
    )
  ) {
    settlementPending = true;
  }
  const balanceAfter = balanceAfterDebit === null ? null : balanceAfterDebit + creditsTotal;
  const settledReceipt = {
    ...receipt,
    ...(balanceAfterDebit !== null ? { balance_after_debit: balanceAfterDebit } : {}),
    ...(balanceAfter !== null ? { balance_after: balanceAfter } : {}),
    credits_total: creditsTotal,
    achievement_credits: achievementCredits,
    settlement_status: settlementPending ? "pending" : "settled",
    settlement_pending: settlementPending,
  };
  // Only persist the settled totals when settlement actually completed. If a
  // read failed, leave the transaction-time receipt in place so the handler
  // recovers from the draw row and its ledger instead of trusting a partial
  // snapshot.
  if (!settlementPending) {
    try {
      const updated = await ctx.db
        .prepare(
          `UPDATE fb_idempotency_keys SET response_json = ?
            WHERE tenant_id = ? AND actor_type = ? AND actor_id = ? AND operation = 'draw.execute' AND idempotency_key = ?`,
        )
        .bind(
          JSON.stringify(settledReceipt),
          ctx.tenant.id,
          ctx.actor.type,
          ctx.actor.id,
          input.idempotency.key,
        )
        .run();
      if ((updated.meta?.changes ?? 0) === 0) {
        console.error(
          JSON.stringify({
            level: "error",
            message: "draw idempotency response was not updated",
            draw_id: drawId,
          }),
        );
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          message: "draw idempotency response update failed",
          draw_id: drawId,
          error: String(error),
        }),
      );
    }
  }
  return {
    ...settledReceipt,
    achievements,
    ...(settlementRead ? { current_balance: settlementRead.balance } : {}),
    replayed: false,
  };
}

async function readSettledAchievementCredits(
  ctx: Ctx,
  userId: string,
  drawId: string,
): Promise<Array<{ id: string; name: string; amount: number }> | null> {
  try {
    const rows = await all<{
      id: string;
      name: string;
      amount: number;
      ledger_amount: number;
    }>(
      ctx.db,
      `SELECT u.achievement_id AS id, d.name,
              u.reward_amount AS amount, l.amount AS ledger_amount
         FROM fb_achievement_unlocks u
         JOIN fb_achievement_definitions d ON d.id = u.achievement_id
         JOIN fb_ledger_entries l
           ON l.id = u.reward_ledger_id AND l.tenant_id = u.tenant_id AND l.user_id = u.user_id
          AND l.kind = 'issue' AND l.amount = u.reward_amount
          AND l.reference_type = 'achievement' AND l.reference_id = u.id
        WHERE u.tenant_id = ? AND u.user_id = ?
          AND u.reward_state = 'granted'
          AND u.event_id IN (
            SELECT e.id FROM fb_domain_events e
             WHERE e.tenant_id = ? AND e.user_id = ? AND e.dedupe_key = ?
          )
        ORDER BY u.earned_at, u.rowid`,
      ctx.tenant.id,
      userId,
      ctx.tenant.id,
      userId,
      `draw:${drawId}`,
    );
    return rows
      .map((row) => {
        const amount = Number(row.ledger_amount);
        if (!Number.isFinite(amount) || amount <= 0) return null;
        return { id: row.id, name: row.name, amount };
      })
      .filter((item): item is { id: string; name: string; amount: number } => item !== null);
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        message: "draw achievement credits could not be read",
        draw_id: drawId,
        error: String(error),
      }),
    );
    return null;
  }
}

async function readWalletBalance(ctx: Ctx, userId: string): Promise<{ balance: number } | null> {
  try {
    return await getWallet(ctx.db, ctx.tenant.id, userId);
  } catch {
    console.error(
      JSON.stringify({
        level: "error",
        message: "wallet read after draw failed",
        error: "operation_failed",
      }),
    );
    return null;
  }
}

async function readDebitLedgerBalance(
  ctx: Ctx,
  userId: string,
  drawId: string,
  price: number,
): Promise<number | null> {
  try {
    const row = await first<{ balance_after: number }>(
      ctx.db,
      `SELECT balance_after FROM fb_ledger_entries
        WHERE id = ? AND tenant_id = ? AND user_id = ? AND kind = 'spend' AND amount = ?
          AND reference_type = 'draw' AND reference_id = ?`,
      `led_${drawId}`,
      ctx.tenant.id,
      userId,
      -price,
      drawId,
    );
    return typeof row?.balance_after === "number" ? row.balance_after : null;
  } catch {
    console.error(
      JSON.stringify({
        level: "error",
        message: "draw debit ledger read failed",
        draw_id: drawId,
        error: "operation_failed",
      }),
    );
    return null;
  }
}

function pickWeighted(
  entries: EligibleEntry[],
  random: number,
  totalWeight: number,
): EligibleEntry {
  let target = (random / 2 ** 32) * totalWeight;
  for (const entry of entries) {
    target -= entry.weight;
    if (target < 0) return entry;
  }
  return entries[entries.length - 1]!;
}

function makeSerial(displayName: string, revision: number): string {
  const letters = displayName
    .replace(/[^A-Za-z]/g, "")
    .slice(0, 2)
    .toUpperCase()
    .padEnd(2, "F");
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  const suffix = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 6)
    .toUpperCase();
  return `FB-${revision}-${letters}-${suffix}`;
}

function parseTags(json: string | undefined, key: string): string[] {
  if (!json) return [];
  try {
    const value = JSON.parse(json) as Record<string, unknown>;
    return Array.isArray(value[key]) ? (value[key] as string[]) : [];
  } catch {
    return [];
  }
}

export async function createPool(
  ctx: Ctx,
  input: {
    slug: string;
    name: string;
    description: string;
    price: number;
    channelKey?: string;
    entries: Array<{ variantId: string; weight: number }>;
  },
) {
  const slug = input.slug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
  const id = newId("pool");
  const now = nowIso();
  if (input.price < 0 || !Number.isInteger(input.price))
    throw new ApiError(422, "price_invalid", "Price must be a non-negative integer.");
  if (!input.entries.length) throw new ApiError(422, "pool_empty", "Add at least one pool entry.");
  const variants = await all<{ id: string }>(
    ctx.db,
    `SELECT v.id FROM fb_variants v
       JOIN fb_card_definitions cd ON cd.id = v.card_id
      WHERE v.id IN (${input.entries.map(() => "?").join(",")}) AND v.status = 'published' AND cd.status = 'published'
        AND (v.tenant_id = ? OR EXISTS (
          SELECT 1 FROM fb_collection_cards cc JOIN fb_collections c ON c.id = cc.collection_id
           WHERE cc.card_id = cd.id AND c.scope = 'global' AND c.status = 'published' AND c.owner_tenant_id = v.tenant_id
        ))`,
    ...input.entries.map((entry) => entry.variantId),
    ctx.tenant.id,
  );
  if (variants.length !== new Set(input.entries.map((entry) => entry.variantId)).size) {
    throw new ApiError(
      422,
      "pool_entry_invalid",
      "Every pool entry must be a published variant in this Bot or an enabled global collection.",
    );
  }
  await ctx.db.batch([
    ctx.db
      .prepare(
        "INSERT INTO fb_pools (id, tenant_id, slug, name, description, status, revision, price, channel_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'draft', 1, ?, ?, ?, ?)",
      )
      .bind(
        id,
        ctx.tenant.id,
        slug,
        input.name.trim(),
        input.description.trim(),
        input.price,
        input.channelKey ?? null,
        now,
        now,
      ),
    ...input.entries.map((entry) =>
      ctx.db
        .prepare(
          "INSERT INTO fb_pool_entries (id, tenant_id, pool_id, pool_revision, variant_id, weight, enabled, created_at) VALUES (?, ?, ?, 1, ?, ?, 1, ?)",
        )
        .bind(
          newId("poe"),
          ctx.tenant.id,
          id,
          entry.variantId,
          Math.max(1, Math.floor(entry.weight)),
          now,
        ),
    ),
    auditStatement(ctx, "pool.created", "pool", id, {
      slug,
      price: input.price,
      entries: input.entries.length,
    }),
  ]);
  return (await listPools(ctx, true)).find((pool) => pool.id === id)!;
}

export async function publishPool(ctx: Ctx, id: string) {
  const pool = await first<PoolRow>(
    ctx.db,
    "SELECT * FROM fb_pools WHERE id = ? AND tenant_id = ?",
    id,
    ctx.tenant.id,
  );
  if (!pool) throw new ApiError(404, "pool_not_found", "Pool not found.");
  const entries = await first<{ count: number }>(
    ctx.db,
    "SELECT COUNT(*) AS count FROM fb_pool_entries WHERE tenant_id = ? AND pool_id = ? AND pool_revision = ? AND enabled = 1",
    ctx.tenant.id,
    pool.id,
    pool.revision,
  );
  if (!entries?.count)
    throw new ApiError(422, "pool_empty", "A pool cannot be published without entries.");
  await ctx.db.batch([
    ctx.db
      .prepare(
        "UPDATE fb_pools SET status = 'active', published_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ? AND revision = ?",
      )
      .bind(nowIso(), nowIso(), pool.id, ctx.tenant.id, pool.revision),
    auditStatement(ctx, "pool.published", "pool", pool.id, {
      revision: pool.revision,
      price: pool.price,
    }),
  ]);
  return (await listPools(ctx, true)).find((item) => item.id === id)!;
}

export async function updatePool(
  ctx: Ctx,
  id: string,
  input: {
    expectedRevision: number;
    name?: string;
    description?: string;
    price?: number;
    entries?: Array<{ variantId: string; weight: number }>;
  },
) {
  const pool = await first<PoolRow>(
    ctx.db,
    "SELECT * FROM fb_pools WHERE id = ? AND tenant_id = ?",
    id,
    ctx.tenant.id,
  );
  if (!pool) throw new ApiError(404, "pool_not_found", "Pool not found.");
  if (pool.revision !== input.expectedRevision) {
    throw new ApiError(409, "stale_pool_revision", "The pool changed since you opened it.", {
      current_revision: pool.revision,
    });
  }
  if (input.price !== undefined && (!Number.isInteger(input.price) || input.price < 0)) {
    throw new ApiError(422, "price_invalid", "Price must be a non-negative integer.");
  }
  const revision = pool.revision + 1;
  const now = nowIso();
  const statements = [
    ctx.db
      .prepare(
        "UPDATE fb_pools SET revision = ?, status = 'draft', name = COALESCE(?, name), description = COALESCE(?, description), price = COALESCE(?, price), updated_at = ? WHERE id = ? AND tenant_id = ? AND revision = ?",
      )
      .bind(
        revision,
        input.name?.trim() ?? null,
        input.description?.trim() ?? null,
        input.price ?? null,
        now,
        pool.id,
        ctx.tenant.id,
        pool.revision,
      ),
  ];
  if (input.entries) {
    if (!input.entries.length)
      throw new ApiError(422, "pool_empty", "A pool needs at least one entry.");
    const ids = [...new Set(input.entries.map((entry) => entry.variantId))];
    const valid: Array<{ id: string }> = [];
    for (let index = 0; index < ids.length; index += 40) {
      const chunk = ids.slice(index, index + 40);
      valid.push(
        ...(await all<{ id: string }>(
          ctx.db,
          `SELECT v.id FROM fb_variants v
             JOIN fb_card_definitions cd ON cd.id = v.card_id
            WHERE v.status = 'published' AND cd.status = 'published' AND v.id IN (${chunk.map(() => "?").join(",")})
              AND (v.tenant_id = ? OR EXISTS (
                SELECT 1 FROM fb_collection_cards cc JOIN fb_collections c ON c.id = cc.collection_id
                 WHERE cc.card_id = cd.id AND c.scope = 'global' AND c.status = 'published' AND c.owner_tenant_id = v.tenant_id
              ))`,
          ...chunk,
          ctx.tenant.id,
        )),
      );
    }
    if (valid.length !== ids.length)
      throw new ApiError(
        422,
        "pool_entry_invalid",
        "Every pool entry must be a published variant in this Bot or an enabled global collection.",
      );
    statements.push(
      ctx.db
        .prepare(
          "DELETE FROM fb_pool_entries WHERE tenant_id = ? AND pool_id = ? AND pool_revision = ?",
        )
        .bind(ctx.tenant.id, pool.id, revision),
    );
    for (const entry of input.entries) {
      statements.push(
        ctx.db
          .prepare(
            "INSERT INTO fb_pool_entries (id, tenant_id, pool_id, pool_revision, variant_id, weight, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)",
          )
          .bind(
            newId("poe"),
            ctx.tenant.id,
            pool.id,
            revision,
            entry.variantId,
            Math.max(1, Math.floor(entry.weight)),
            now,
          ),
      );
    }
  } else {
    statements.push(
      ctx.db
        .prepare(
          "INSERT INTO fb_pool_entries (id, tenant_id, pool_id, pool_revision, variant_id, weight, enabled, created_at) SELECT ?, tenant_id, pool_id, ?, variant_id, weight, enabled, ? FROM fb_pool_entries WHERE tenant_id = ? AND pool_id = ? AND pool_revision = ?",
        )
        .bind(newId("poe"), revision, now, ctx.tenant.id, pool.id, pool.revision),
    );
  }
  statements.push(
    auditStatement(ctx, "pool.updated", "pool", pool.id, {
      revision,
      price: input.price ?? pool.price,
    }),
  );
  await ctx.db.batch(statements);
  return (await listPools(ctx, true)).find((item) => item.id === id)!;
}

export async function retirePool(ctx: Ctx, id: string) {
  await ctx.db.batch([
    ctx.db
      .prepare(
        "UPDATE fb_pools SET status = 'retired', updated_at = ? WHERE id = ? AND tenant_id = ?",
      )
      .bind(nowIso(), id, ctx.tenant.id),
    auditStatement(ctx, "pool.retired", "pool", id),
  ]);
}

export async function getPoolDetail(ctx: Ctx, id: string) {
  const pool = await first<PoolRow>(
    ctx.db,
    "SELECT * FROM fb_pools WHERE id = ? AND tenant_id = ?",
    id,
    ctx.tenant.id,
  );
  if (!pool) throw new ApiError(404, "pool_not_found", "Pool not found.");
  const entries = await all<{
    id: string;
    variant_id: string;
    weight: number;
    enabled: number;
    card_name: string;
    variant_name: string;
    material_key: string;
    effect_key: string | null;
  }>(
    ctx.db,
    `SELECT pe.id, pe.variant_id, pe.weight, pe.enabled, cd.name AS card_name, v.name AS variant_name,
            m.key AS material_key, fx.key AS effect_key
       FROM fb_pool_entries pe JOIN fb_variants v ON v.id = pe.variant_id
       JOIN fb_card_definitions cd ON cd.id = v.card_id
       JOIN fb_materials m ON m.id = v.material_id
       LEFT JOIN fb_effects fx ON fx.id = v.effect_id
      WHERE pe.tenant_id = ? AND pe.pool_id = ? AND pe.pool_revision = ? ORDER BY cd.name, v.name`,
    ctx.tenant.id,
    pool.id,
    pool.revision,
  );
  return { pool, entries };
}
