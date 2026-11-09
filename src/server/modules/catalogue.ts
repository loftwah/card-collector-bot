import type { D1Database } from "@cloudflare/workers-types";
import { ApiError, type Ctx, type Role } from "../context";
import { all, first, nowIso, statement } from "../db";
import { newId, sha256Hex } from "../ids";
import { auditStatement } from "../http";
import { assertTransition } from "../state";
import { cardVisibilitySql, currentViewerAccess, publicCollectionSql } from "./visibility";
import { botAllowsAiArt, isAiArtOrigin } from "./bots";
import { normalizeCardName } from "./card-name-aliases";
import { currentPublicSetRelease, currentPublicSetReleases, currentReleaseSql } from "./public-set-releases";

export interface CardRow {
  id: string;
  tenant_id: string;
  logical_id: string;
  slug: string;
  name: string;
  subtitle: string | null;
  description: string;
  class_id: string | null;
  category_id: string | null;
  rarity_id: string | null;
  status: "draft" | "published" | "retired";
  source_repo: string | null;
  source_path: string | null;
  source_commit: string | null;
  source_logical_id: string | null;
  credit: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  version: number;
  bio: string | null;
  bio_safe: string | null;
  quote: string | null;
  spoiler_level: number;
  spoiler_bio: string | null;
  attributes_json: string;
  source_refs_json: string;
  review_status: string;
  source_work: string | null;
  adaptation_boundary: string | null;
  editorial_version: number;
  released_at: string | null;
  card_back_asset_id: string | null;
  visibility: string;
  class_key: string | null;
  class_name: string | null;
  category_slug: string | null;
  category_name: string | null;
  rarity_key: string | null;
  rarity_name: string | null;
  rarity_tone: string | null;
}

export interface EditionRow {
  id: string;
  card_id: string;
  name: string;
  subject_asset_id: string;
  background_asset_id: string | null;
  recipe_id: string;
  status: string;
  source_repo: string | null;
  source_path: string | null;
  source_commit: string | null;
  source_logical_id: string | null;
  source_hash: string | null;
  composition_json: string | null;
  credit: string | null;
  created_at: string;
  archived_at: string | null;
}

export interface VariantRow {
  id: string;
  card_id: string;
  edition_id: string;
  material_id: string;
  effect_id: string | null;
  name: string;
  status: string;
  created_at: string;
  archived_at: string | null;
  material_key: string;
  material_name: string;
  effect_key: string | null;
  effect_name: string | null;
  render_url: string | null;
  back_render_url: string | null;
  thumbnail_url: string | null;
  preview_url: string | null;
  render_status: string | null;
}

export interface CardView extends CardRow {
  class: { id: string; key: string; name: string } | null;
  category: { id: string; slug: string; name: string } | null;
  rarity: { id: string; key: string; name: string; tone: string } | null;
  tags: Array<{ id: string; slug: string; name: string }>;
  collections: Array<{
    id: string;
    slug: string;
    name: string;
    scope: string;
    logo_url: string | null;
    accent: string;
    view_audience: string;
  }>;
  card_back_url: string;
  editions: Array<EditionRow & { variants: VariantRow[] }>;
  sets: Array<{ id: string; slug: string; name: string; version: number }>;
}

const CARD_SELECT = `SELECT cd.*, cls.key AS class_key, cls.name AS class_name,
  cat.slug AS category_slug, cat.name AS category_name,
  rar.key AS rarity_key, rar.name AS rarity_name, rar.tone AS rarity_tone
  FROM fb_card_definitions cd
  LEFT JOIN fb_classes cls ON cls.id = cd.class_id AND cls.tenant_id = cd.tenant_id
  LEFT JOIN fb_categories cat ON cat.id = cd.category_id AND cat.tenant_id = cd.tenant_id
  LEFT JOIN fb_rarities rar ON rar.id = cd.rarity_id AND rar.tenant_id = cd.tenant_id`;

export async function listCards(
  ctx: Ctx,
  options: {
    includeDrafts?: boolean;
    /** Exact lookup, never limited by a page of a broader listing. */
    id?: string;
    slug?: string;
    search?: string;
    /** Match normalized canonical/alternate names only, not descriptions. */
    exactName?: boolean;
    category?: string;
    tag?: string;
    set?: string;
    collection?: string;
    limit?: number;
    publicOnly?: boolean;
    /** Disable the viewer predicate only for an authorised administrative read. */
    viewerScope?: boolean;
    /** Include AI-assisted editions. Defaults to the Bot preference for member reads. */
    includeAi?: boolean;
  } = {},
): Promise<CardView[]> {
  const limit = Math.min(200, Math.max(1, options.limit ?? 100));
  const where: string[] = ["cd.tenant_id = ?", "cd.archived_at IS NULL"];
  const params: unknown[] = [ctx.tenant.id];
  if (!options.includeDrafts) where.push("cd.status = 'published'");
  if (options.id) {
    where.push("cd.id = ?");
    params.push(options.id);
  }
  if (options.slug) {
    where.push("cd.slug = ?");
    params.push(options.slug);
  }
  if (options.publicOnly) {
    const pub = publicCollectionSql("cvis");
    const hidden = publicCollectionSql("chidden");
    where.push(`EXISTS (
      SELECT 1 FROM fb_collection_cards cc_vis JOIN fb_collections cvis ON cvis.id = cc_vis.collection_id
       WHERE cc_vis.card_id = cd.id AND ${pub}
    )`);
    where.push(`NOT EXISTS (
      SELECT 1 FROM fb_collection_cards cc_hidden JOIN fb_collections chidden ON chidden.id = cc_hidden.collection_id
       WHERE cc_hidden.card_id = cd.id AND NOT (${hidden})
    )`);
  } else if (options.viewerScope !== false && !options.includeDrafts) {
    const access = await currentViewerAccess(ctx);
    const visibility = cardVisibilitySql(access);
    where.push(visibility.sql);
    params.push(...visibility.params);
  }
  if (options.search) {
    const normalized = normalizeCardName(options.search);
    // SQLite's LOWER/LIKE do not implement Unicode NFKC case normalization.
    // Include canonical names using the same normalization as aliases so a
    // later rename cannot silently hide an ambiguous identity.
    const names = await all<{ id: string; name: string }>(ctx.db, `SELECT cd.id, cd.name FROM fb_card_definitions cd WHERE ${where.join(" AND ")}`, ...params);
    const exactNames = names.filter(row => normalizeCardName(row.name) === normalized).map(row => row.id);
    if (exactNames.length > 80) throw new ApiError(409, "card_name_ambiguous", "Too many cards share that name. Use a card's exact slug.");
    const exactClause = `EXISTS (SELECT 1 FROM fb_card_name_aliases na WHERE na.tenant_id = cd.tenant_id AND na.card_id = cd.id AND na.normalized = ?)${exactNames.length ? ` OR cd.id IN (${exactNames.map(() => "?").join(",")})` : ""}`;
    if (options.exactName) {
      where.push(`(${exactClause})`);
      params.push(normalized, ...exactNames);
    } else {
      where.push(`(cd.name LIKE ? OR cd.description LIKE ? OR cd.subtitle LIKE ? OR ${exactClause})`);
      const query = `%${options.search}%`;
      params.push(query, query, query, normalized, ...exactNames);
    }
  }
  if (options.category) {
    where.push("cat.slug = ?");
    params.push(options.category);
  }
  if (options.tag) {
    where.push(
      "EXISTS (SELECT 1 FROM fb_card_tags ct JOIN fb_tags t ON t.id = ct.tag_id WHERE ct.card_id = cd.id AND t.slug = ?)",
    );
    params.push(options.tag);
  }
  if (options.set) {
    where.push(
      "EXISTS (SELECT 1 FROM fb_set_memberships sm JOIN fb_sets s ON s.id = sm.set_id WHERE sm.card_id = cd.id AND s.slug = ? AND sm.set_version = s.version)",
    );
    params.push(options.set);
  }
  if (options.collection) {
    where.push(
      "EXISTS (SELECT 1 FROM fb_collection_cards cc JOIN fb_collections c ON c.id = cc.collection_id WHERE cc.card_id = cd.id AND c.slug = ? AND c.archived_at IS NULL)",
    );
    params.push(options.collection);
  }
  if (options.publicOnly) {
    const release = await first<{ id: string }>(
      ctx.db,
      "SELECT id FROM fb_catalogue_releases WHERE tenant_id = ? AND status = 'active' LIMIT 1",
      ctx.tenant.id,
    );
    if (!release) return [];
  }
  const rows = await all<CardRow>(
    ctx.db,
    `${CARD_SELECT} WHERE ${where.join(" AND ")} ORDER BY cd.name COLLATE NOCASE LIMIT ?`,
    ...params,
    limit,
  );
  const includeAi =
    options.includeAi ??
    (options.includeDrafts || options.publicOnly
      ? true
      : await botAllowsAiArt(ctx.db, ctx.tenant.id));
  const hydrated = await hydrateCards(ctx, rows, includeAi);
  if (!options.publicOnly) {
    return includeAi ? hydrated : hydrated.filter((card) => card.editions.length > 0);
  }
  return hydrated
    .filter((card) => includeAi || card.editions.length > 0)
    .map((card) => ({
      ...card,
      editions: card.editions
        .filter((edition) => edition.status === "published")
        .map((edition) => ({
          ...edition,
          variants: edition.variants.filter(
            (variant) => variant.status === "published" && variant.render_url,
          ),
        }))
        .filter((edition) => edition.variants.length > 0),
    }))
    .filter((card) => card.editions.length > 0);
}

export async function getCard(
  ctx: Ctx,
  idOrSlug: string,
  options?: { includeDrafts?: boolean; includeAi?: boolean; includeArchived?: boolean },
): Promise<CardView> {
  const access = await currentViewerAccess(ctx);
  const visibility = cardVisibilitySql(access);
  const administrative = Boolean(options?.includeDrafts && (access.managesCurrentTenant ||
    (ctx.actor.type === "agent" && ctx.scopes?.includes("content:write") && ctx.user?.agentBotCapabilities?.includes("content"))));
  const gate = `(${administrative ? "1 = 1" : "cd.status = 'published'"} AND (${visibility.sql}))`;
  const gateParams = visibility.params;
  // Archived rows are normally invisible, including to the administrative
  // catalogue. Restoration is the one explicit exception: the caller must ask
  // for the archived row before it can clear the archive marker.
  const archivedGate = options?.includeArchived ? "" : "AND cd.archived_at IS NULL";
  const row = await first<CardRow>(
    ctx.db,
    `${CARD_SELECT} WHERE cd.tenant_id = ? AND (cd.id = ? OR cd.slug = ?) ${archivedGate} AND ${gate}`,
    ctx.tenant.id,
    idOrSlug,
    idOrSlug,
    ...gateParams,
  );
  if (!row) {
    const alias = await first<{ target_card_id: string }>(
      ctx.db,
      "SELECT target_card_id FROM fb_card_aliases WHERE tenant_id = ? AND source_card_id = ?",
      ctx.tenant.id,
      idOrSlug,
    );
    if (alias) return getCard(ctx, alias.target_card_id, options);
    throw new ApiError(404, "card_not_found", "That card does not exist in this cabinet.");
  }
  return (await hydrateCards(
    ctx,
    [row],
    options?.includeAi ?? (administrative || (await botAllowsAiArt(ctx.db, ctx.tenant.id))),
  ))[0]!;
}

async function hydrateCards(ctx: Ctx, rows: CardRow[], includeAi = true): Promise<CardView[]> {
  if (rows.length === 0) return [];
  // D1 has a finite bound-parameter budget per statement. Keep each hydration
  // batch small so a 200-card admin page cannot exceed it.
  if (rows.length > 20) {
    const hydrated: CardView[] = [];
    for (let index = 0; index < rows.length; index += 20) {
      hydrated.push(...(await hydrateCards(ctx, rows.slice(index, index + 20), includeAi)));
    }
    return hydrated;
  }
  const ids = rows.map((row) => row.id);
  const placeholders = ids.map(() => "?").join(",");
  const editions = await all<
    EditionRow & { subject_url: string; background_url: string | null; subject_origin: string }
  >(
    ctx.db,
    `SELECT e.*, sa.id AS subject_url, sa.origin AS subject_origin, ba.id AS background_url
       FROM fb_artwork_editions e
       JOIN fb_assets sa ON sa.id = e.subject_asset_id AND sa.tenant_id = e.tenant_id
       LEFT JOIN fb_assets ba ON ba.id = e.background_asset_id AND ba.tenant_id = e.tenant_id
      WHERE e.tenant_id = ? AND e.card_id IN (${placeholders}) AND e.archived_at IS NULL ORDER BY e.created_at`,
    ctx.tenant.id,
    ...ids,
  );
  const editionIds = editions.map((edition) => edition.id);
  // D1 allows a limited number of bound parameters per statement. Multi-print
  // subjects can push a 20-card hydration batch over that budget, so each
  // IN(...) query is chunked. This is a parameter bound, not a behavioural cap.
  const inChunks = async <T>(
    values: string[],
    run: (chunk: string[]) => Promise<T[]>,
    size = 80,
  ): Promise<T[]> => {
    const rows: T[] = [];
    for (let index = 0; index < values.length; index += size) {
      rows.push(...(await run(values.slice(index, index + size))));
    }
    return rows;
  };
  const variants = await inChunks<VariantRow & {
    material_key: string;
    material_name: string;
    effect_key: string | null;
    effect_name: string | null;
  }>(editionIds, (chunk) =>
    all(
      ctx.db,
      `SELECT v.*, m.key AS material_key, m.name AS material_name, e.key AS effect_key, e.name AS effect_name
         FROM fb_variants v JOIN fb_materials m ON m.id = v.material_id AND m.tenant_id = v.tenant_id
         LEFT JOIN fb_effects e ON e.id = v.effect_id AND e.tenant_id = v.tenant_id
        WHERE v.tenant_id = ? AND v.edition_id IN (${chunk.map(() => "?").join(",")}) AND v.archived_at IS NULL
        ORDER BY m.sort, e.sort`,
      ctx.tenant.id,
      ...chunk,
    ),
  );
  const variantIds = variants.map((variant) => variant.id);
  const renders = await inChunks<{
    variant_id: string;
    asset_id: string;
    public_url: string;
    status: string;
  }>(variantIds, (chunk) =>
    all(
      ctx.db,
      `SELECT variant_id, asset_id, public_url, status FROM fb_variant_renders
        WHERE tenant_id = ? AND variant_id IN (${chunk.map(() => "?").join(",")}) AND status = 'published'`,
      ctx.tenant.id,
      ...chunk,
    ),
  );
  const renderMap = new Map(renders.map((render) => [render.variant_id, render]));
  const backRenders = await inChunks<{ variant_id: string; asset_id: string }>(
    variantIds,
    (chunk) =>
      all(
        ctx.db,
        `SELECT variant_id, asset_id FROM fb_variant_back_renders
          WHERE tenant_id = ? AND variant_id IN (${chunk.map(() => "?").join(",")}) AND status = 'published'`,
        ctx.tenant.id,
        ...chunk,
      ),
  );
  const backMap = new Map(backRenders.map((render) => [render.variant_id, render]));
  const derivativeRows = await inChunks<{
    id: string;
    source_asset_id: string;
    size_key: string;
  }>(renders.map((render) => render.asset_id), (chunk) =>
    all(
      ctx.db,
      `SELECT id, source_asset_id, size_key FROM fb_asset_derivatives
        WHERE tenant_id = ? AND source_asset_id IN (${chunk.map(() => "?").join(",")}) AND status = 'ready'`,
      ctx.tenant.id,
      ...chunk,
    ),
  );
  const derivativeMap = new Map(
    derivativeRows.map((row) => [`${row.source_asset_id}:${row.size_key}`, row.id]),
  );
  const derivativeUrl = (assetId: string | undefined, size: string) => {
    if (!assetId) return null;
    const id = derivativeMap.get(`${assetId}:${size}`);
    return id ? `/media/derivative/${id}` : null;
  };
  const tagRows = await all<{ card_id: string; id: string; slug: string; name: string }>(
    ctx.db,
    `SELECT ct.card_id, t.id, t.slug, t.name FROM fb_card_tags ct JOIN fb_tags t ON t.id = ct.tag_id
      WHERE ct.tenant_id = ? AND ct.card_id IN (${placeholders}) AND t.archived_at IS NULL ORDER BY t.name`,
    ctx.tenant.id,
    ...ids,
  );
  const setRows = await all<{
    card_id: string;
    id: string;
    slug: string;
    name: string;
    version: number;
  }>(
    ctx.db,
    `SELECT sm.card_id, s.id, s.slug, s.name, sm.set_version AS version
       FROM fb_set_memberships sm JOIN fb_sets s ON s.id = sm.set_id
      WHERE sm.tenant_id = ? AND sm.card_id IN (${placeholders}) AND sm.set_version = s.version AND s.status = 'published'
      ORDER BY s.name`,
    ctx.tenant.id,
    ...ids,
  );

  const collectionRows = await all<{
    card_id: string;
    id: string;
    slug: string;
    name: string;
    scope: string;
    logo_url: string | null;
    accent: string;
    view_audience: string;
  }>(
    ctx.db,
    `SELECT cc.card_id, c.id, c.slug, c.name, c.scope, c.logo_url, c.accent, c.view_audience
       FROM fb_collection_cards cc JOIN fb_collections c ON c.id = cc.collection_id
      WHERE cc.card_id IN (${placeholders}) AND c.archived_at IS NULL
      ORDER BY c.scope, c.sort, c.name`,
    ...ids,
  );

  return rows.map((row) => {
    const cardEditions = editions
      .filter(
        (edition) =>
          edition.card_id === row.id && (includeAi || !isAiArtOrigin(edition.subject_origin)),
      )
      .map((edition) => ({
        ...edition,
        subject_url: `/media/asset/${edition.subject_asset_id}`,
        background_url: edition.background_asset_id
          ? `/media/asset/${edition.background_asset_id}`
          : null,
        variants: variants
          .filter((variant) => variant.edition_id === edition.id)
          .map((variant) => ({
            ...variant,
            render_url: renderMap.get(variant.id)?.asset_id
              ? `/media/render/${renderMap.get(variant.id)!.asset_id}`
              : null,
            back_render_url: backMap.get(variant.id)?.asset_id
              ? `/media/back/${backMap.get(variant.id)!.asset_id}`
              : null,
            thumbnail_url: derivativeUrl(renderMap.get(variant.id)?.asset_id, "thumb"),
            preview_url: derivativeUrl(renderMap.get(variant.id)?.asset_id, "preview"),
            render_status: renderMap.get(variant.id)?.status ?? null,
          })),
      }));
    return {
      ...row,
      class: row.class_id ? { id: row.class_id, key: row.class_key!, name: row.class_name! } : null,
      category: row.category_id
        ? { id: row.category_id, slug: row.category_slug!, name: row.category_name! }
        : null,
      rarity: row.rarity_id
        ? {
            id: row.rarity_id,
            key: row.rarity_key!,
            name: row.rarity_name!,
            tone: row.rarity_tone ?? "neutral",
          }
        : null,
      tags: tagRows
        .filter((tag) => tag.card_id === row.id)
        .map(({ id, slug, name }) => ({ id, slug, name })),
      collections: collectionRows
        .filter((collection) => collection.card_id === row.id)
        .map(({ id, slug, name, scope, logo_url, accent, view_audience }) => ({
          id,
          slug,
          name,
          scope,
          logo_url,
          accent,
          view_audience,
        })),
      card_back_url: "/brand/card-back.webp",
      editions: cardEditions,
      sets: setRows
        .filter((set) => set.card_id === row.id)
        .map(({ id, slug, name, version }) => ({ id, slug, name, version })),
    };
  });
}

export async function createCard(
  ctx: Ctx,
  input: {
    slug: string;
    name: string;
    subtitle?: string;
    description: string;
    bio?: string;
    bioSafe?: string;
    quote?: string;
    spoilerLevel?: number;
    spoilerBio?: string;
    attributes?: Array<Record<string, unknown>>;
    sourceRefs?: string[];
    reviewStatus?: string;
    sourceWork?: string;
    adaptationBoundary?: string;
    editorialVersion?: number;
    logicalId?: string;
    classKey?: string;
    categorySlug?: string;
    collectionSlug?: string;
    rarityKey?: string;
    tags?: string[];
    source?: { repo?: string; path?: string; commit?: string; logicalId?: string; credit?: string };
  },
): Promise<CardView> {
  const slug = normalizeSlug(input.slug);
  if (!slug) throw new ApiError(422, "slug_invalid", "Provide a lowercase slug.");
  if (!input.name.trim()) throw new ApiError(422, "name_required", "Card name is required.");
  if (!input.description.trim())
    throw new ApiError(422, "description_required", "Card description is required.");
  const existing = await first<{ id: string }>(
    ctx.db,
    "SELECT id FROM fb_card_definitions WHERE tenant_id = ? AND (slug = ? OR logical_id = ?)",
    ctx.tenant.id,
    slug,
    input.logicalId ?? slug,
  );
  if (existing) throw new ApiError(409, "card_exists", "That card identity already exists.");
  const classRow = input.classKey
    ? await first<{ id: string }>(
        ctx.db,
        "SELECT id FROM fb_classes WHERE tenant_id = ? AND key = ? AND archived_at IS NULL",
        ctx.tenant.id,
        input.classKey,
      )
    : null;
  const categoryRow = input.categorySlug
    ? await first<{ id: string }>(
        ctx.db,
        "SELECT id FROM fb_categories WHERE tenant_id = ? AND slug = ? AND archived_at IS NULL",
        ctx.tenant.id,
        input.categorySlug,
      )
    : null;
  const rarityRow = input.rarityKey
    ? await first<{ id: string }>(
        ctx.db,
        "SELECT id FROM fb_rarities WHERE tenant_id = ? AND key = ? AND archived_at IS NULL",
        ctx.tenant.id,
        input.rarityKey,
      )
    : null;
  const tagRows = input.tags?.length
    ? await all<{ id: string }>(
        ctx.db,
        `SELECT id FROM fb_tags WHERE tenant_id = ? AND slug IN (${input.tags.map(() => "?").join(",")}) AND archived_at IS NULL`,
        ctx.tenant.id,
        ...input.tags,
      )
    : [];
  const id = newId("crd");
  const now = nowIso();
  const statements = [
    ctx.db
      .prepare(
        `INSERT INTO fb_card_definitions
          (id, tenant_id, logical_id, slug, name, subtitle, description, bio, bio_safe, quote, spoiler_level, spoiler_bio,
           attributes_json, source_refs_json, review_status, source_work, adaptation_boundary, editorial_version,
           class_id, category_id, rarity_id, status, source_repo, source_path, source_commit, source_logical_id, credit,
           created_at, updated_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .bind(
        id,
        ctx.tenant.id,
        input.logicalId ?? `card:${slug}`,
        slug,
        input.name.trim(),
        input.subtitle?.trim() || null,
        input.description.trim(),
        input.bio?.trim() || null,
        input.bioSafe?.trim() || null,
        input.quote?.trim() || null,
        Math.min(3, Math.max(0, Math.trunc(input.spoilerLevel ?? 0))),
        input.spoilerBio?.trim() || null,
        JSON.stringify(input.attributes ?? []),
        JSON.stringify(input.sourceRefs ?? []),
        input.reviewStatus ?? "unreviewed",
        input.sourceWork ?? null,
        input.adaptationBoundary ?? null,
        Math.max(1, Math.trunc(input.editorialVersion ?? 1)),
        classRow?.id ?? null,
        categoryRow?.id ?? null,
        rarityRow?.id ?? null,
        input.source?.repo ?? null,
        input.source?.path ?? null,
        input.source?.commit ?? null,
        input.source?.logicalId ?? null,
        input.source?.credit ?? null,
        now,
        now,
      ),
    ...tagRows.map((tag) =>
      statement(
        ctx.db,
        "INSERT INTO fb_card_tags (tenant_id, card_id, tag_id) VALUES (?, ?, ?)",
        ctx.tenant.id,
        id,
        tag.id,
      ),
    ),
    ...((input.collectionSlug ?? input.categorySlug)
      ? [
          ctx.db
            .prepare(
              `INSERT OR IGNORE INTO fb_collection_cards (collection_id, card_id, tenant_id, sort, added_by, added_at)
               SELECT c.id, ?, ?, 0, ?, ? FROM fb_collections c
                WHERE c.slug = ? AND c.owner_tenant_id = ? AND c.archived_at IS NULL`,
            )
            .bind(
              id,
              ctx.tenant.id,
              ctx.user?.id ?? "system",
              now,
              input.collectionSlug ?? input.categorySlug!,
              ctx.tenant.id,
            ),
          ctx.db
            .prepare(
              `UPDATE fb_card_definitions SET visibility = CASE WHEN EXISTS (
                 SELECT 1 FROM fb_collection_cards cc JOIN fb_collections c ON c.id = cc.collection_id
                  WHERE cc.card_id = ? AND c.scope = 'global' AND c.view_audience = 'public'
               ) THEN 'global' ELSE 'collection' END
                WHERE id = ?`,
            )
            .bind(id, id),
        ]
      : []),
    auditStatement(ctx, "card.created", "card", id, { slug, name: input.name }),
  ];
  await ctx.db.batch(statements);
  return getCard(ctx, id, { includeDrafts: true });
}

export async function updateCard(
  ctx: Ctx,
  id: string,
  input: {
    expectedVersion: number;
    name?: string;
    subtitle?: string | null;
    description?: string;
    bio?: string | null;
    bioSafe?: string | null;
    spoilerLevel?: number;
    spoilerBio?: string | null;
    attributes?: Array<Record<string, unknown>>;
    sourceRefs?: string[];
    reviewStatus?: string;
    sourceWork?: string | null;
    adaptationBoundary?: string | null;
    editorialVersion?: number;
    quote?: string | null;
    classKey?: string | null;
    categorySlug?: string | null;
    rarityKey?: string | null;
    tags?: string[];
  },
): Promise<CardView> {
  const card = await getCard(ctx, id, { includeDrafts: true });
  if (card.version !== input.expectedVersion) {
    throw new ApiError(
      409,
      "stale_write",
      "This card changed since you opened it. Reload before saving.",
      {
        current_version: card.version,
      },
    );
  }
  const classRow =
    input.classKey === undefined
      ? undefined
      : input.classKey
        ? await first<{ id: string }>(
            ctx.db,
            "SELECT id FROM fb_classes WHERE tenant_id = ? AND key = ? AND archived_at IS NULL",
            ctx.tenant.id,
            input.classKey,
          )
        : null;
  const categoryRow =
    input.categorySlug === undefined
      ? undefined
      : input.categorySlug
        ? await first<{ id: string }>(
            ctx.db,
            "SELECT id FROM fb_categories WHERE tenant_id = ? AND slug = ? AND archived_at IS NULL",
            ctx.tenant.id,
            input.categorySlug,
          )
        : null;
  const rarityRow =
    input.rarityKey === undefined
      ? undefined
      : input.rarityKey
        ? await first<{ id: string }>(
            ctx.db,
            "SELECT id FROM fb_rarities WHERE tenant_id = ? AND key = ? AND archived_at IS NULL",
            ctx.tenant.id,
            input.rarityKey,
          )
        : null;
  const tagRows =
    input.tags === undefined
      ? undefined
      : input.tags.length
        ? await all<{ id: string }>(
            ctx.db,
            `SELECT id FROM fb_tags WHERE tenant_id = ? AND slug IN (${input.tags.map(() => "?").join(",")}) AND archived_at IS NULL`,
            ctx.tenant.id,
            ...input.tags,
          )
        : [];
  const now = nowIso();
  const statements = [
    ctx.db
      .prepare(
        `UPDATE fb_card_definitions SET
          name = COALESCE(?, name), subtitle = ?, description = COALESCE(?, description),
          bio = CASE WHEN ? THEN ? ELSE bio END,
          quote = CASE WHEN ? THEN ? ELSE quote END,
          class_id = CASE WHEN ? THEN ? ELSE class_id END,
          category_id = CASE WHEN ? THEN ? ELSE category_id END,
          rarity_id = CASE WHEN ? THEN ? ELSE rarity_id END,
          updated_at = ?, version = version + 1
         WHERE id = ? AND tenant_id = ? AND version = ?`,
      )
      .bind(
        input.name?.trim() ?? null,
        input.subtitle === undefined ? card.subtitle : input.subtitle,
        input.description?.trim() ?? null,
        input.bio !== undefined ? 1 : 0,
        input.bio ?? null,
        input.quote !== undefined ? 1 : 0,
        input.quote ?? null,
        input.classKey !== undefined ? 1 : 0,
        classRow?.id ?? null,
        input.categorySlug !== undefined ? 1 : 0,
        categoryRow?.id ?? null,
        input.rarityKey !== undefined ? 1 : 0,
        rarityRow?.id ?? null,
        now,
        card.id,
        ctx.tenant.id,
        input.expectedVersion,
      ),
    ...(tagRows === undefined
      ? []
      : [
          ctx.db
            .prepare("DELETE FROM fb_card_tags WHERE tenant_id = ? AND card_id = ?")
            .bind(ctx.tenant.id, card.id),
          ...tagRows.map((tag) =>
            statement(
              ctx.db,
              "INSERT INTO fb_card_tags (tenant_id, card_id, tag_id) VALUES (?, ?, ?)",
              ctx.tenant.id,
              card.id,
              tag.id,
            ),
          ),
        ]),
    auditStatement(ctx, "card.updated", "card", card.id, {
      expected_version: input.expectedVersion,
    }),
  ];
  await ctx.db.batch(statements);
  return getCard(ctx, card.id, { includeDrafts: true });
}

export async function setCardStatus(
  ctx: Ctx,
  id: string,
  status: "draft" | "published" | "retired",
): Promise<CardView> {
  const card = await getCard(ctx, id, { includeDrafts: true, includeArchived: true });
  if (status === "published") {
    const variants = await first<{ count: number }>(
      ctx.db,
      `SELECT COUNT(*) AS count FROM fb_variants v JOIN fb_artwork_editions e ON e.id = v.edition_id
        WHERE v.tenant_id = ? AND v.card_id = ? AND v.status = 'published' AND e.status = 'published' AND e.archived_at IS NULL`,
      ctx.tenant.id,
      card.id,
    );
    if (!variants?.count) {
      throw new ApiError(
        422,
        "no_published_variant",
        "Publish at least one artwork edition and variant first.",
      );
    }
  }
  if (status === "retired" && card.status === "draft") {
    throw new ApiError(409, "invalid_transition", "A draft is removed or archived, not retired.");
  }
  if (status !== card.status) assertTransition("card", card.status, status);
  // `archived_at` is the archive marker, not a synonym for `retired`. Leaving
  // it set while publishing or drafting a card produces a status/visibility
  // contradiction: the row claims to be published, but every catalogue and
  // media read filters it out. Restoring a retired or archived card must clear
  // the marker in the same write that changes the status.
  await ctx.db.batch([
    ctx.db
      .prepare(
        `UPDATE fb_card_definitions SET
           status = ?,
           archived_at = CASE WHEN ? = 'retired' THEN archived_at ELSE NULL END,
           updated_at = ?,
           version = version + 1
         WHERE id = ? AND tenant_id = ?`,
      )
      .bind(status, status, nowIso(), card.id, ctx.tenant.id),
    auditStatement(ctx, `card.${status}`, "card", card.id, {
      restored_from_archive: Boolean(card.archived_at) && status !== "retired",
    }),
  ]);
  return getCard(ctx, card.id, { includeDrafts: true });
}

export async function archiveCard(ctx: Ctx, id: string): Promise<void> {
  const card = await getCard(ctx, id, { includeDrafts: true });
  const instances = await first<{ count: number }>(
    ctx.db,
    "SELECT COUNT(*) AS count FROM fb_card_instances WHERE tenant_id = ? AND card_id = ? AND status IN ('owned','reserved')",
    ctx.tenant.id,
    card.id,
  );
  if (!instances?.count && card.status === "draft") {
    try {
      await ctx.db.batch([
        ctx.db.prepare("DELETE FROM fb_card_name_aliases WHERE tenant_id = ? AND card_id = ?").bind(ctx.tenant.id, card.id),
        ctx.db
          .prepare("DELETE FROM fb_card_tags WHERE tenant_id = ? AND card_id = ?")
          .bind(ctx.tenant.id, card.id),
        ctx.db
          .prepare("DELETE FROM fb_variants WHERE tenant_id = ? AND card_id = ?")
          .bind(ctx.tenant.id, card.id),
        ctx.db
          .prepare("DELETE FROM fb_artwork_editions WHERE tenant_id = ? AND card_id = ?")
          .bind(ctx.tenant.id, card.id),
        ctx.db
          .prepare("DELETE FROM fb_card_definitions WHERE tenant_id = ? AND id = ?")
          .bind(ctx.tenant.id, card.id),
        auditStatement(ctx, "card.draft_removed", "card", card.id),
      ]);
      return;
    } catch (error) {
      // A draft that is already referenced by a collection, set, print
      // proposal or another durable record cannot be hard-deleted without
      // losing that history. Fall through to the archive path instead of
      // surfacing a raw foreign-key failure.
      if (!/FOREIGN KEY/i.test(String(error))) throw error;
    }
  }
  await ctx.db.batch([
    ctx.db
      .prepare(
        "UPDATE fb_card_definitions SET status = 'retired', archived_at = ?, updated_at = ?, version = version + 1 WHERE id = ? AND tenant_id = ?",
      )
      .bind(nowIso(), nowIso(), card.id, ctx.tenant.id),
    auditStatement(ctx, "card.archived", "card", card.id, { instances: instances?.count ?? 0 }),
  ]);
}

export async function bulkSetStatus(
  ctx: Ctx,
  ids: string[],
  status: "draft" | "published" | "retired",
): Promise<{ updated: number }> {
  if (ids.length === 0) return { updated: 0 };
  if (ids.length > 100)
    throw new ApiError(422, "bulk_limit", "Update at most 100 cards at a time.");
  let updated = 0;
  for (const id of ids) {
    if (status === "published") {
      const variants = await first<{ count: number }>(
        ctx.db,
        `SELECT COUNT(*) AS count FROM fb_variants v JOIN fb_artwork_editions e ON e.id = v.edition_id
          WHERE v.tenant_id = ? AND v.card_id = ? AND v.status = 'published' AND e.status = 'published'`,
        ctx.tenant.id,
        id,
      );
      if (!variants?.count) continue;
    }
    await setCardStatus(ctx, id, status);
    updated++;
  }
  return { updated };
}

export interface Taxonomy {
  classes: Array<Record<string, unknown>>;
  categories: Array<Record<string, unknown>>;
  tags: Array<Record<string, unknown>>;
  rarities: Array<Record<string, unknown>>;
  materials: Array<Record<string, unknown>>;
  effects: Array<Record<string, unknown>>;
}

export async function getTaxonomy(ctx: Ctx, options?: { publicOnly?: boolean }): Promise<Taxonomy> {
  let categoryFilter = "";
  let tagFilter = "";
  let classFilter = "";
  const params: unknown[] = [ctx.tenant.id];
  if (options?.publicOnly) {
    categoryFilter = `AND EXISTS (SELECT 1 FROM fb_card_definitions cd JOIN fb_collection_cards cc ON cc.card_id = cd.id JOIN fb_collections c ON c.id = cc.collection_id WHERE cd.category_id = fb_categories.id AND cd.status = 'published' AND c.status = 'published' AND c.view_audience = 'public' AND c.public_approved_at IS NOT NULL)`;
    tagFilter = `AND EXISTS (SELECT 1 FROM fb_card_tags ct JOIN fb_card_definitions cd ON cd.id = ct.card_id JOIN fb_collection_cards cc ON cc.card_id = cd.id JOIN fb_collections c ON c.id = cc.collection_id WHERE ct.tag_id = fb_tags.id AND cd.status = 'published' AND c.status = 'published' AND c.view_audience = 'public' AND c.public_approved_at IS NOT NULL)`;
    classFilter = `AND EXISTS (SELECT 1 FROM fb_card_definitions cd JOIN fb_collection_cards cc ON cc.card_id = cd.id JOIN fb_collections c ON c.id = cc.collection_id WHERE cd.class_id = fb_classes.id AND cd.status = 'published' AND c.status = 'published' AND c.view_audience = 'public' AND c.public_approved_at IS NOT NULL)`;
  }
  const [classes, categories, tags, rarities, materials, effects] = await Promise.all([
    all(
      ctx.db,
      `SELECT id, key, name, description, sort FROM fb_classes WHERE tenant_id = ? AND archived_at IS NULL ${classFilter} ORDER BY sort, name`,
      ...params,
    ),
    all(
      ctx.db,
      `SELECT id, parent_id, slug, name, description, sort, icon_url FROM fb_categories WHERE tenant_id = ? AND archived_at IS NULL ${categoryFilter} ORDER BY sort, name`,
      ...params,
    ),
    all(
      ctx.db,
      `SELECT id, slug, name FROM fb_tags WHERE tenant_id = ? AND archived_at IS NULL ${tagFilter} ORDER BY name`,
      ...params,
    ),
    all(
      ctx.db,
      "SELECT id, key, name, weight, tone, sort FROM fb_rarities WHERE tenant_id = ? AND archived_at IS NULL ORDER BY sort, name",
      ...params,
    ),
    all(
      ctx.db,
      "SELECT id, key, name, config_json, sort FROM fb_materials WHERE tenant_id = ? AND archived_at IS NULL ORDER BY sort, name",
      ...params,
    ),
    all(
      ctx.db,
      "SELECT id, key, name, config_json, sort FROM fb_effects WHERE tenant_id = ? AND archived_at IS NULL ORDER BY sort, name",
      ...params,
    ),
  ]);
  return { classes, categories, tags, rarities, materials, effects } as Taxonomy;
}

export type TaxonomyKind = "class" | "category" | "tag" | "rarity" | "material" | "effect";

export async function createTaxonomyItem(
  ctx: Ctx,
  kind: TaxonomyKind,
  input: { key: string; name: string; description?: string; parentId?: string; config?: unknown },
) {
  const key = normalizeSlug(input.key);
  if (!key) throw new ApiError(422, "key_invalid", "Provide a lowercase key or slug.");
  if (!input.name.trim()) throw new ApiError(422, "name_required", "Name is required.");
  const id = newId(kind.slice(0, 3));
  const table = {
    class: "fb_classes",
    category: "fb_categories",
    tag: "fb_tags",
    rarity: "fb_rarities",
    material: "fb_materials",
    effect: "fb_effects",
  }[kind];
  const column =
    kind === "class" || kind === "rarity" || kind === "material" || kind === "effect"
      ? "key"
      : "slug";
  try {
    if (kind === "class") {
      await ctx.db
        .prepare(
          "INSERT INTO fb_classes (id, tenant_id, key, name, description, sort) VALUES (?, ?, ?, ?, ?, 99)",
        )
        .bind(id, ctx.tenant.id, key, input.name.trim(), input.description ?? null)
        .run();
    } else if (kind === "category") {
      if (input.parentId) {
        const parent = await first<{ id: string }>(
          ctx.db,
          "SELECT id FROM fb_categories WHERE id = ? AND tenant_id = ?",
          input.parentId,
          ctx.tenant.id,
        );
        if (!parent) throw new ApiError(422, "parent_invalid", "Parent category not found.");
      }
      await ctx.db
        .prepare(
          "INSERT INTO fb_categories (id, tenant_id, parent_id, slug, name, description, sort) VALUES (?, ?, ?, ?, ?, ?, 99)",
        )
        .bind(
          id,
          ctx.tenant.id,
          input.parentId ?? null,
          key,
          input.name.trim(),
          input.description ?? null,
        )
        .run();
    } else if (kind === "tag") {
      await ctx.db
        .prepare("INSERT INTO fb_tags (id, tenant_id, slug, name) VALUES (?, ?, ?, ?)")
        .bind(id, ctx.tenant.id, key, input.name.trim())
        .run();
    } else if (kind === "rarity") {
      await ctx.db
        .prepare(
          "INSERT INTO fb_rarities (id, tenant_id, key, name, weight, tone, sort) VALUES (?, ?, ?, ?, ?, 'neutral', 99)",
        )
        .bind(id, ctx.tenant.id, key, input.name.trim(), 100)
        .run();
    } else if (kind === "material") {
      await ctx.db
        .prepare(
          "INSERT INTO fb_materials (id, tenant_id, key, name, config_json, sort) VALUES (?, ?, ?, ?, ?, 99)",
        )
        .bind(id, ctx.tenant.id, key, input.name.trim(), JSON.stringify(input.config ?? {}))
        .run();
    } else {
      await ctx.db
        .prepare(
          "INSERT INTO fb_effects (id, tenant_id, key, name, config_json, sort) VALUES (?, ?, ?, ?, ?, 99)",
        )
        .bind(id, ctx.tenant.id, key, input.name.trim(), JSON.stringify(input.config ?? {}))
        .run();
    }
  } catch (error) {
    if (String(error).includes("UNIQUE"))
      throw new ApiError(409, "taxonomy_exists", "That taxonomy item already exists.");
    throw error;
  }
  await auditStatement(ctx, "taxonomy.created", kind, id, { key, name: input.name }).run();
  return { id, kind, key, name: input.name.trim(), table, column };
}

export async function archiveTaxonomyItem(ctx: Ctx, kind: TaxonomyKind, id: string) {
  const table = {
    class: "fb_classes",
    category: "fb_categories",
    tag: "fb_tags",
    rarity: "fb_rarities",
    material: "fb_materials",
    effect: "fb_effects",
  }[kind];
  await ctx.db.batch([
    ctx.db
      .prepare(`UPDATE ${table} SET archived_at = ? WHERE id = ? AND tenant_id = ?`)
      .bind(nowIso(), id, ctx.tenant.id),
    auditStatement(ctx, "taxonomy.archived", kind, id),
  ]);
}

export interface SetView {
  id: string;
  slug: string;
  name: string;
  description: string;
  status: string;
  version: number;
  published_at: string | null;
  cards: Array<{ id: string; slug: string; name: string; sort: number }>;
  reward_amount: number;
  progress?: { owned: number; total: number; complete: boolean | null; claimed: boolean | null };
}

export async function listSets(
  ctx: Ctx,
  userId?: string,
  options?: { publicOnly?: boolean; viewerScope?: boolean },
): Promise<SetView[]> {
  if (ctx.actor.type === "agent" && !ctx.scopes?.includes("inventory:read")) userId = undefined;
  const access = await currentViewerAccess(ctx);
  if (!access.signedIn) userId = undefined;
  if (userId && !access.platformAdmin) options = { ...options, viewerScope: true, publicOnly: false };
  let cardFilter = "";
  const cardParams: unknown[] = [];
  if (options?.publicOnly) {
    cardFilter = `AND EXISTS (
      SELECT 1 FROM fb_collection_cards cc JOIN fb_collections c ON c.id = cc.collection_id
       WHERE cc.card_id = cd.id AND c.status = 'published' AND c.view_audience = 'public' AND c.public_approved_at IS NOT NULL
    ) AND NOT EXISTS (
      SELECT 1 FROM fb_collection_cards cc2 JOIN fb_collections c2 ON c2.id = cc2.collection_id
       WHERE cc2.card_id = cd.id AND NOT (c2.status = 'published' AND c2.view_audience = 'public' AND c2.public_approved_at IS NOT NULL)
    )`;
  } else if (options?.viewerScope) {
    const visibility = cardVisibilitySql(access);
    cardFilter = `AND ${visibility.sql}`;
    cardParams.push(...visibility.params);
  }
  const requiresRelease = Boolean(options?.publicOnly || !access.platformAdmin);
  let rows: Array<{
    id: string;
    slug: string;
    name: string;
    description: string;
    status: string;
    version: number;
    published_at: string | null;
    reward_amount: number | null;
  }>;
  try { rows = await all(
    ctx.db,
    `SELECT s.id, s.slug, s.name, s.description, s.status, s.version, s.published_at, r.reward_amount
       FROM fb_sets s LEFT JOIN fb_set_reward_rules r ON r.set_id = s.id AND r.set_version = s.version
      WHERE s.tenant_id = ? ${requiresRelease ? `AND EXISTS (SELECT 1 FROM fb_public_set_releases pr WHERE pr.tenant_id=s.tenant_id AND pr.set_id=s.id AND ${currentReleaseSql})` : ""}
      ORDER BY s.status = 'published' DESC, s.name LIMIT 101`,
    ctx.tenant.id,
  ); } catch (error) {
    if (requiresRelease && /no such table: (?:fb_public_set_releases|fb_public_set_release_revocations)\b/.test(String(error))) return [];
    throw error;
  }
  if (rows.length > 100) throw new ApiError(503,"set_list_overloaded","Too many sets to check safely. Please contact an administrator.");
  const releases = requiresRelease ? await currentPublicSetReleases(ctx, rows.map((row) => row.id)) : new Map();
  const selected = rows.filter((row) => !requiresRelease || releases.has(row.id));
  const targets = selected.map((row) => {
    const release = releases.get(row.id);
    return { id: row.id, version: release?.set_version ?? row.version, roster: release ? JSON.parse(release.roster_json) : null };
  });
  const targetsJson = JSON.stringify(targets);
  const cards = targets.length ? await all<{ set_id: string; id: string; slug: string; name: string; sort: number }>(ctx.db,
    `SELECT sm.set_id,cd.id,cd.slug,cd.name,sm.sort FROM fb_set_memberships sm
      JOIN json_each(?) target ON sm.set_id=json_extract(target.value,'$.id') AND sm.set_version=json_extract(target.value,'$.version')
      JOIN fb_card_definitions cd ON cd.id=sm.card_id
      WHERE sm.tenant_id=? ${cardFilter} ORDER BY sm.sort,cd.name`, targetsJson,ctx.tenant.id,...cardParams) : [];
  const bySet = new Map<string, Array<{id:string;slug:string;name:string;sort:number}>>();
  for (const { set_id, ...card } of cards) { const group = bySet.get(set_id) ?? []; group.push(card); bySet.set(set_id,group); }
  const ownedRows = userId && targets.length ? await all<{set_id:string;count:number}>(ctx.db,
    `SELECT sm.set_id,COUNT(DISTINCT ci.card_id) AS count FROM fb_set_memberships sm
      JOIN json_each(?) target ON sm.set_id=json_extract(target.value,'$.id') AND sm.set_version=json_extract(target.value,'$.version')
      JOIN fb_card_definitions cd ON cd.id=sm.card_id JOIN fb_card_instances ci ON ci.card_id=sm.card_id AND ci.tenant_id=sm.tenant_id
      WHERE sm.tenant_id=? AND ci.user_id=? AND ci.status IN ('owned','reserved') ${cardFilter}
      AND (json_type(target.value,'$.roster')='null' OR ci.card_id IN (SELECT json_extract(value,'$[0]') FROM json_each(target.value,'$.roster')))
      GROUP BY sm.set_id`, targetsJson,ctx.tenant.id,userId,...cardParams) : [];
  const ownedBySet = new Map(ownedRows.map((row) => [row.set_id,Number(row.count)]));
  const claimRows = userId && targets.length ? await all<{set_id:string}>(ctx.db,
    `SELECT sc.set_id FROM fb_set_completion_claims sc JOIN json_each(?) target ON sc.set_id=json_extract(target.value,'$.id') AND sc.set_version=json_extract(target.value,'$.version') WHERE sc.tenant_id=? AND sc.user_id=?`, targetsJson,ctx.tenant.id,userId) : [];
  const claimedSets = new Set(claimRows.map((row) => row.set_id));
  const stillCurrent = requiresRelease ? await currentPublicSetReleases(ctx, selected.map((row) => row.id)) : new Map();
  const result: SetView[] = [];
  for (const row of selected) {
    // Unreviewed free-form set metadata is not public-safe merely because a
    // member card is visible. Only an explicit still-current release can be
    // shown outside the platform administrator's management view.
    const release = releases.get(row.id) ?? null;
    if (requiresRelease && !release) continue;
    if (release && stillCurrent.get(row.id)?.id !== release.id) continue;
    const setVersion = release?.set_version ?? row.version;
    let setCards = bySet.get(row.id) ?? [];
    if (release) {
      const roster = JSON.parse(release.roster_json) as Array<[string, string, string, number]>;
      const visibleIds = new Set(setCards.map((card) => card.id));
      if (visibleIds.size !== roster.length || roster.some(([id]) => !visibleIds.has(id))) continue;
      // Never return stale or newly edited set/card labels read before review.
      setCards = roster.map(([id, slug, name, sort]) => ({ id, slug, name, sort })).sort((a,b) => a.sort-b.sort || a.name.localeCompare(b.name));
    }
    if (options?.publicOnly || options?.viewerScope) {
      if (setCards.length === 0) continue;
    }
    let progress: SetView["progress"];
    if (userId) {
      const ownedCount = ownedBySet.get(row.id) ?? 0;
      progress = {
        owned: ownedCount,
        total: setCards.length,
        complete: access.platformAdmin || release ? setCards.length > 0 && ownedCount >= setCards.length : null,
        claimed: access.platformAdmin || release ? claimedSets.has(row.id) : null,
      };
    }
    result.push({
      id: row.id,
      slug: release?.slug ?? row.slug,
      name: release?.name ?? row.name,
      description: release?.description ?? row.description,
      status: row.status,
      version: setVersion,
      published_at: release ? null : row.published_at,
      cards: setCards,
      reward_amount: release?.reward_amount ?? row.reward_amount ?? 0,
      progress,
    });
  }
  return result;
}

export async function createSet(ctx: Ctx, input: { slug: string; name: string; description: string; rewardAmount: number }): Promise<SetView> {
  const { changeManagedSet } = await import("./set-management");
  return changeManagedSet(ctx, "create", input);
}

export async function replaceSetMembership(ctx: Ctx, setId: string, cardIds: string[]): Promise<SetView> {
  const { changeManagedSet } = await import("./set-management");
  return changeManagedSet(ctx, "members", { id: setId, cardIds });
}

export async function publishSet(ctx: Ctx, setId: string): Promise<SetView> {
  const { changeManagedSet } = await import("./set-management");
  return changeManagedSet(ctx, "publish", { id: setId });
}

export async function claimSetCompletion(ctx: Ctx, setId: string, idempotencyKey: string) {
  const user = ctx.user;
  if (!user || ctx.actor.type !== "user" || ctx.actor.id !== user.id || ctx.actor.representedUserId !== user.id)
    throw new ApiError(403, "set_claim_unavailable", "A signed-in member is required for this claim.");
  if (!idempotencyKey || idempotencyKey.length > 200) throw new ApiError(422,"idempotency_key_required","A valid idempotency key is required.");
  const accessIdentity = ctx.sessionAssurance === "access" && ctx.accessStatus === "linked" ? ctx.accessIdentity : null;
  const sessionFence = `(EXISTS (SELECT 1 FROM fb_sessions sess WHERE sess.id=? AND sess.user_id=m.user_id AND sess.tenant_id=m.tenant_id AND sess.revoked_at IS NULL AND sess.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    OR (? = 'access' AND ? > unixepoch('now') AND EXISTS (SELECT 1 FROM fb_access_identities ai WHERE ai.user_id=m.user_id AND ai.team_domain=? AND ai.subject=? AND ai.email=? AND ai.revoked_at IS NULL) AND u.email=? COLLATE NOCASE))`;
  const sessionParams = [ctx.sessionId, ctx.sessionAssurance, accessIdentity?.payload.exp ?? 0, ctx.config.access.teamDomain, accessIdentity?.subject ?? "", accessIdentity?.email ?? "", accessIdentity?.email ?? ""];
  const active = await first<{id: string}>(ctx.db, `SELECT m.user_id AS id FROM fb_memberships m JOIN fb_users u ON u.id=m.user_id WHERE m.tenant_id=? AND m.user_id=? AND m.status='active' AND m.revoked_at IS NULL AND u.disabled_at IS NULL AND ${sessionFence}`, ctx.tenant.id,user.id,...sessionParams);
  if (!active) throw new ApiError(403,"membership_required","Your access to this Bot has changed.");
  const existing = async () => {
    const rows = await all<{id: string; set_id: string; set_version: number; reward_amount: number}>(ctx.db,
    `SELECT id,set_id,set_version,reward_amount FROM fb_set_completion_claims sc WHERE tenant_id=? AND user_id=? AND idempotency_key=?
     AND EXISTS (SELECT 1 FROM fb_memberships m JOIN fb_users u ON u.id=m.user_id WHERE m.tenant_id=sc.tenant_id AND m.user_id=sc.user_id AND m.status='active' AND m.revoked_at IS NULL AND u.disabled_at IS NULL AND ${sessionFence}) LIMIT 2`,ctx.tenant.id,user.id,idempotencyKey,...sessionParams);
    if (rows.length > 1) throw new ApiError(409,"idempotency_conflict","That key has ambiguous historical claims. Contact an administrator.");
    return rows[0] ?? null;
  };
  const replay = await existing();
  if (replay) {
    if (replay.set_id !== setId) throw new ApiError(409,"idempotency_conflict","That key was used for another claim.");
    return { claim_id: replay.id, set_id: replay.set_id, set_version: replay.set_version, amount: replay.reward_amount };
  }
  const release = await currentPublicSetRelease(ctx, setId);
  if (!release) throw new ApiError(409,"set_completion_unavailable","Whole-set completion is temporarily unavailable. Your existing rewards remain recorded.");
  const claimId = newId("swd");
  const now = nowIso();
  const response = {
    claim_id: claimId,
    set_id: setId,
    set_version: release.set_version,
    amount: release.reward_amount,
  };
  try {
    const [inserted] = await ctx.db.batch([
      ctx.db
        .prepare(
          `INSERT INTO fb_set_completion_claims (id,tenant_id,user_id,set_id,set_version,reward_amount,created_at,idempotency_key)
           SELECT ?,pr.tenant_id,?,pr.set_id,pr.set_version,pr.reward_amount,?,? FROM fb_public_set_releases pr
            WHERE pr.id=? AND pr.tenant_id=? AND ${currentReleaseSql}
              AND EXISTS (SELECT 1 FROM fb_memberships m JOIN fb_users u ON u.id=m.user_id WHERE m.tenant_id=pr.tenant_id AND m.user_id=? AND m.status='active' AND m.revoked_at IS NULL AND u.disabled_at IS NULL AND ${sessionFence})
              AND EXISTS (SELECT 1 FROM fb_wallets w WHERE w.tenant_id=pr.tenant_id AND w.user_id=?)
              AND NOT EXISTS (SELECT 1 FROM fb_set_completion_claims prior WHERE prior.tenant_id=pr.tenant_id AND prior.user_id=? AND prior.idempotency_key=?)
              AND NOT EXISTS (SELECT 1 FROM fb_set_memberships sm WHERE sm.tenant_id=pr.tenant_id AND sm.set_id=pr.set_id AND sm.set_version=pr.set_version
                AND NOT EXISTS (SELECT 1 FROM fb_card_instances ci WHERE ci.tenant_id=sm.tenant_id AND ci.user_id=? AND ci.card_id=sm.card_id AND ci.status IN ('owned','reserved')))`,
        )
        .bind(claimId,user.id,now,idempotencyKey,release.id,ctx.tenant.id,user.id,...sessionParams,user.id,user.id,idempotencyKey,user.id),
      ctx.db.prepare(`INSERT INTO fb_audit_events (id,tenant_id,actor_type,actor_id,represented_user_id,action,object_type,object_id,metadata_json,request_id,created_at)
        SELECT ?,?,'user',?,?,'set.reward.claimed','set',?,?,?,? WHERE changes()=1`).bind(newId("aud"),ctx.tenant.id,user.id,user.id,setId,JSON.stringify({version:release.set_version,amount:release.reward_amount,release_id:release.id}),ctx.requestId,now),
    ]);
    if (!inserted?.meta.changes) {
      const raced = await existing();
      if (raced && raced.set_id === setId) return { claim_id: raced.id, set_id: raced.set_id, set_version: raced.set_version, amount: raced.reward_amount };
      if (raced) throw new ApiError(409,"idempotency_conflict","That key was used for another claim.");
      throw new ApiError(409,"set_completion_unavailable","The set or your access changed, or the reviewed roster is incomplete. Your existing rewards remain recorded.");
    }
  } catch (error) {
    if (String(error).includes("UNIQUE")) {
      const retried = await existing();
      if (retried && retried.set_id === setId) return { claim_id: retried.id, set_id: retried.set_id, set_version: retried.set_version, amount: retried.reward_amount };
      if (retried) throw new ApiError(409,"idempotency_conflict","That key was used for another claim.");
      const prior = await first<{id:string}>(ctx.db, `SELECT sc.id FROM fb_set_completion_claims sc WHERE sc.tenant_id=? AND sc.user_id=? AND sc.set_id=? AND sc.set_version=?
        AND EXISTS (SELECT 1 FROM fb_memberships m JOIN fb_users u ON u.id=m.user_id WHERE m.tenant_id=sc.tenant_id AND m.user_id=sc.user_id AND m.status='active' AND m.revoked_at IS NULL AND u.disabled_at IS NULL AND ${sessionFence})`,ctx.tenant.id,user.id,setId,release.set_version,...sessionParams);
      if (prior) throw new ApiError(409,"already_claimed","This set reward has already been claimed.");
    }
    throw error;
  }
  return response;
}

export interface TopicPolicy {
  id: string;
  channel_key: string;
  name: string;
  exclude_tags: string[];
  active: boolean;
}

export async function listTopicPolicies(ctx: Ctx): Promise<TopicPolicy[]> {
  const rows = await all<{
    id: string;
    channel_key: string;
    name: string;
    exclude_tags_json: string;
    active: number;
  }>(
    ctx.db,
    "SELECT id, channel_key, name, exclude_tags_json, active FROM fb_topic_policies WHERE tenant_id = ? ORDER BY name",
    ctx.tenant.id,
  );
  return rows.map((row) => ({
    id: row.id,
    channel_key: row.channel_key,
    name: row.name,
    exclude_tags: JSON.parse(row.exclude_tags_json) as string[],
    active: Boolean(row.active),
  }));
}

export async function createTopicPolicy(
  ctx: Ctx,
  input: { channelKey: string; name: string; excludeTags: string[] },
): Promise<TopicPolicy> {
  const id = newId("pol");
  await ctx.db.batch([
    ctx.db
      .prepare(
        "INSERT INTO fb_topic_policies (id, tenant_id, channel_key, name, exclude_tags_json, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
      )
      .bind(
        id,
        ctx.tenant.id,
        normalizeSlug(input.channelKey),
        input.name.trim(),
        JSON.stringify(input.excludeTags),
        nowIso(),
        nowIso(),
      ),
    auditStatement(ctx, "topic.created", "topic_policy", id, input),
  ]);
  return (await listTopicPolicies(ctx)).find((policy) => policy.id === id)!;
}

export async function setTopicPolicyActive(ctx: Ctx, id: string, active: boolean): Promise<void> {
  await ctx.db.batch([
    ctx.db
      .prepare(
        "UPDATE fb_topic_policies SET active = ?, updated_at = ? WHERE id = ? AND tenant_id = ?",
      )
      .bind(active ? 1 : 0, nowIso(), id, ctx.tenant.id),
    auditStatement(ctx, "topic.updated", "topic_policy", id, { active }),
  ]);
}

export async function publishCatalogue(ctx: Ctx) {
  const cards = await listCards(ctx, { includeDrafts: true, limit: 200 });
  const publishedCards = cards.filter((card) => card.status === "published");
  if (publishedCards.length === 0)
    throw new ApiError(422, "catalogue_empty", "Publish at least one card first.");
  const problems: string[] = [];
  for (const card of publishedCards) {
    const variants = card.editions.flatMap((edition) => edition.variants);
    if (!variants.some((variant) => variant.status === "published")) {
      problems.push(`${card.name}: no published variant`);
    }
    if (!variants.some((variant) => variant.render_url)) {
      problems.push(`${card.name}: no published render (run the card renderer)`);
    }
  }
  const sets = await listSets(ctx);
  for (const set of sets.filter((item) => item.status === "published")) {
    if (set.cards.length === 0) problems.push(`${set.name}: empty set`);
  }
  const activePools = await all<{ id: string; slug: string; revision: number }>(
    ctx.db,
    "SELECT id, slug, revision FROM fb_pools WHERE tenant_id = ? AND status = 'active'",
    ctx.tenant.id,
  );
  if (problems.length)
    throw new ApiError(422, "catalogue_invalid", "The catalogue cannot be released yet.", {
      problems,
    });
  const versionRow = await first<{ version: number }>(
    ctx.db,
    "SELECT COALESCE(MAX(version), 0) + 1 AS version FROM fb_catalogue_releases WHERE tenant_id = ?",
    ctx.tenant.id,
  );
  const version = versionRow?.version ?? 1;
  const manifest = {
    version,
    schema: 1,
    cards: publishedCards.map((card) => ({
      id: card.id,
      slug: card.slug,
      name: card.name,
      editions: card.editions
        .filter((edition) => edition.status === "published")
        .map((edition) => ({
          id: edition.id,
          recipe_id: edition.recipe_id,
          variants: edition.variants
            .filter((variant) => variant.status === "published")
            .map((variant) => ({
              id: variant.id,
              name: variant.name,
              render_url: variant.render_url,
            })),
        })),
    })),
    sets: sets.map((set) => ({
      id: set.id,
      slug: set.slug,
      version: set.version,
      cards: set.cards.map((card) => card.id),
    })),
    pools: activePools,
    published_at: nowIso(),
  };
  const checksum = await sha256Hex(JSON.stringify(manifest));
  const releaseId = newId("rel");
  await ctx.db.batch([
    ctx.db
      .prepare(
        "UPDATE fb_catalogue_releases SET status = 'superseded' WHERE tenant_id = ? AND status = 'active'",
      )
      .bind(ctx.tenant.id),
    ctx.db
      .prepare(
        "INSERT INTO fb_catalogue_releases (id, tenant_id, version, status, manifest_json, checksum, published_by, published_at) VALUES (?, ?, ?, 'active', ?, ?, ?, ?)",
      )
      .bind(
        releaseId,
        ctx.tenant.id,
        version,
        JSON.stringify(manifest),
        checksum,
        ctx.actor.id,
        nowIso(),
      ),
    ctx.db
      .prepare("UPDATE fb_tenants SET publication_json = ? WHERE id = ?")
      .bind(
        JSON.stringify({ publicCatalogue: true, activeRelease: version, releasedAt: nowIso() }),
        ctx.tenant.id,
      ),
    auditStatement(ctx, "catalogue.released", "catalogue_release", releaseId, {
      version,
      checksum,
    }),
  ]);
  return { id: releaseId, version, checksum, manifest };
}

export function normalizeSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export async function mergeCards(ctx: Ctx, sourceId: string, targetId: string) {
  if (sourceId === targetId)
    throw new ApiError(422, "merge_self", "A card cannot be merged into itself.");
  const source = await first<{ id: string; name: string; status: string }>(
    ctx.db,
    "SELECT id, name, status FROM fb_card_definitions WHERE id = ? AND tenant_id = ? AND archived_at IS NULL",
    sourceId,
    ctx.tenant.id,
  );
  const target = await first<{ id: string; name: string }>(
    ctx.db,
    "SELECT id, name FROM fb_card_definitions WHERE id = ? AND tenant_id = ? AND archived_at IS NULL",
    targetId,
    ctx.tenant.id,
  );
  if (!source || !target)
    throw new ApiError(
      404,
      "card_not_found",
      "Both merge endpoints must be active cards in this tenant.",
    );
  const now = nowIso();
  await ctx.db.batch([
    ctx.db
      .prepare("UPDATE fb_artwork_editions SET card_id = ? WHERE tenant_id = ? AND card_id = ?")
      .bind(target.id, ctx.tenant.id, source.id),
    ctx.db
      .prepare("UPDATE fb_variants SET card_id = ? WHERE tenant_id = ? AND card_id = ?")
      .bind(target.id, ctx.tenant.id, source.id),
    ctx.db
      .prepare("UPDATE fb_card_instances SET card_id = ? WHERE tenant_id = ? AND card_id = ?")
      .bind(target.id, ctx.tenant.id, source.id),
    ctx.db
      .prepare(
        "DELETE FROM fb_set_memberships WHERE tenant_id = ? AND card_id = ? AND EXISTS (SELECT 1 FROM fb_set_memberships t WHERE t.tenant_id = fb_set_memberships.tenant_id AND t.set_id = fb_set_memberships.set_id AND t.set_version = fb_set_memberships.set_version AND t.card_id = ?)",
      )
      .bind(ctx.tenant.id, source.id, target.id),
    ctx.db
      .prepare("UPDATE fb_set_memberships SET card_id = ? WHERE tenant_id = ? AND card_id = ?")
      .bind(target.id, ctx.tenant.id, source.id),
    // Collection membership is part of card identity. A merge must not make a
    // curated collection silently lose the subject because only the retired
    // source id kept the link.
    ctx.db
      .prepare(
        `INSERT OR IGNORE INTO fb_collection_cards (collection_id, card_id, tenant_id, sort, added_by, added_at)
         SELECT collection_id, ?, tenant_id, sort, added_by, added_at
           FROM fb_collection_cards WHERE tenant_id = ? AND card_id = ?`,
      )
      .bind(target.id, ctx.tenant.id, source.id),
    ctx.db
      .prepare("DELETE FROM fb_collection_cards WHERE tenant_id = ? AND card_id = ?")
      .bind(ctx.tenant.id, source.id),
    ctx.db
      .prepare(
        "INSERT OR IGNORE INTO fb_card_tags (tenant_id, card_id, tag_id) SELECT tenant_id, ?, tag_id FROM fb_card_tags WHERE tenant_id = ? AND card_id = ?",
      )
      .bind(target.id, ctx.tenant.id, source.id),
    ctx.db
      .prepare("DELETE FROM fb_card_tags WHERE tenant_id = ? AND card_id = ?")
      .bind(ctx.tenant.id, source.id),
    ctx.db
      .prepare(
        "INSERT OR IGNORE INTO fb_favourites (tenant_id, user_id, card_id, created_at) SELECT tenant_id, user_id, ?, created_at FROM fb_favourites WHERE tenant_id = ? AND card_id = ?",
      )
      .bind(target.id, ctx.tenant.id, source.id),
    ctx.db
      .prepare("DELETE FROM fb_favourites WHERE tenant_id = ? AND card_id = ?")
      .bind(ctx.tenant.id, source.id),
    ctx.db
      .prepare(
        "INSERT OR IGNORE INTO fb_wishlists (tenant_id, user_id, card_id, created_at) SELECT tenant_id, user_id, ?, created_at FROM fb_wishlists WHERE tenant_id = ? AND card_id = ?",
      )
      .bind(target.id, ctx.tenant.id, source.id),
    ctx.db
      .prepare("DELETE FROM fb_wishlists WHERE tenant_id = ? AND card_id = ?")
      .bind(ctx.tenant.id, source.id),
    ctx.db
      .prepare(
        "INSERT INTO fb_card_aliases (tenant_id, source_card_id, target_card_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(tenant_id, source_card_id) DO UPDATE SET target_card_id = excluded.target_card_id, created_at = excluded.created_at",
      )
      .bind(ctx.tenant.id, source.id, target.id, now),
    ctx.db.prepare("UPDATE fb_card_name_aliases SET card_id = ? WHERE tenant_id = ? AND card_id = ?")
      .bind(target.id, ctx.tenant.id, source.id),
    ctx.db.prepare("UPDATE fb_card_definitions SET version = version + 1, updated_at = ? WHERE tenant_id = ? AND id = ?")
      .bind(now, ctx.tenant.id, target.id),
    ctx.db
      .prepare(
        "UPDATE fb_card_definitions SET status = 'retired', archived_at = ?, updated_at = ?, version = version + 1 WHERE tenant_id = ? AND id = ?",
      )
      .bind(now, now, ctx.tenant.id, source.id),
    auditStatement(ctx, "card.merged", "card", source.id, {
      target_card_id: target.id,
      source_name: source.name,
      target_name: target.name,
    }),
  ]);
  return { source_id: source.id, target_id: target.id, status: "merged" };
}

export async function getTenantPublication(ctx: Ctx) {
  const row = await first<{ publication_json: string; settings_json: string }>(
    ctx.db,
    "SELECT publication_json, settings_json FROM fb_tenants WHERE id = ?",
    ctx.tenant.id,
  );
  const publication = row?.publication_json ? JSON.parse(row.publication_json) : {};
  return {
    public_catalogue: publication.publicCatalogue !== false,
    blocked_tags: Array.isArray(publication.blockedTags) ? publication.blockedTags : [],
    active_release: publication.activeRelease ?? null,
    settings: row?.settings_json ? JSON.parse(row.settings_json) : {},
  };
}

export async function updateTenantPublication(
  ctx: Ctx,
  input: { publicCatalogue?: boolean; blockedTags?: string[] },
) {
  const current = await getTenantPublication(ctx);
  const publication = {
    ...(current.active_release ? { activeRelease: current.active_release } : {}),
    publicCatalogue: input.publicCatalogue ?? current.public_catalogue,
    blockedTags: input.blockedTags ?? current.blocked_tags,
    updatedAt: nowIso(),
  };
  await ctx.db.batch([
    ctx.db
      .prepare("UPDATE fb_tenants SET publication_json = ? WHERE id = ?")
      .bind(JSON.stringify(publication), ctx.tenant.id),
    auditStatement(ctx, "tenant.publication.updated", "tenant", ctx.tenant.id, {
      publicCatalogue: publication.publicCatalogue,
      blockedTags: publication.blockedTags,
    }),
  ]);
  return getTenantPublication(ctx);
}

export async function createEditionForCard(
  ctx: Ctx,
  cardId: string,
  input: {
    name: string;
    subjectAssetId: string;
    backgroundAssetId?: string | null;
    recipeId?: string | null;
    materials: string[];
    effects?: string[];
    variants?: Array<{ material: string; effect?: string | null }>;
    status?: "draft" | "published";
    parentEditionId?: string | null;
    composition?: {
      mode?: "contain" | "fill" | "medallion";
      zoom?: number;
      offsetX?: number;
      offsetY?: number;
    } | null;
  },
): Promise<CardView> {
  const card = await getCard(ctx, cardId, { includeDrafts: true });
  if (!input.name.trim())
    throw new ApiError(422, "edition_name_required", "Give the artwork edition a name.");
  if (!input.subjectAssetId) throw new ApiError(422, "subject_required", "Choose a subject asset.");
  const subject = await first<{ id: string; kind: string }>(
    ctx.db,
    "SELECT id, kind FROM fb_assets WHERE id = ? AND tenant_id = ? AND archived_at IS NULL AND kind = 'subject'",
    input.subjectAssetId,
    ctx.tenant.id,
  );
  if (!subject)
    throw new ApiError(422, "subject_invalid", "That subject asset is not available in this Bot.");
  if (input.backgroundAssetId) {
    const background = await first<{ id: string }>(
      ctx.db,
      "SELECT id FROM fb_assets WHERE id = ? AND tenant_id = ? AND kind = 'background' AND archived_at IS NULL",
      input.backgroundAssetId,
      ctx.tenant.id,
    );
    if (!background)
      throw new ApiError(
        422,
        "background_invalid",
        "That background asset is not available in this Bot.",
      );
  }
  const recipe = input.recipeId
    ? await first<{ id: string }>(
        ctx.db,
        "SELECT id FROM fb_recipes WHERE id = ? AND tenant_id = ? AND status = 'published'",
        input.recipeId,
        ctx.tenant.id,
      )
    : await first<{ id: string }>(
        ctx.db,
        "SELECT id FROM fb_recipes WHERE tenant_id = ? AND status = 'published' ORDER BY version DESC LIMIT 1",
        ctx.tenant.id,
      );
  if (!recipe)
    throw new ApiError(422, "recipe_required", "Publish a render recipe before adding artwork.");
  const requestedVariants = input.variants?.length
    ? input.variants
    : input.materials.flatMap((material) =>
        (input.effects?.length ? input.effects : ["none"]).map((effect) => ({ material, effect })),
      );
  const materialKeys = [...new Set(requestedVariants.map((variant) => variant.material))];
  const effectKeys = [...new Set(requestedVariants.map((variant) => variant.effect ?? "none"))];
  const materialRows = await all<{ id: string; key: string; name: string }>(
    ctx.db,
    `SELECT id, key, name FROM fb_materials WHERE tenant_id = ? AND key IN (${materialKeys.map(() => "?").join(",")}) AND archived_at IS NULL`,
    ctx.tenant.id,
    ...materialKeys,
  );
  if (materialRows.length !== materialKeys.length)
    throw new ApiError(422, "material_invalid", "One or more materials are not available.");
  const effectRows = await all<{ id: string; key: string; name: string }>(
    ctx.db,
    `SELECT id, key, name FROM fb_effects WHERE tenant_id = ? AND key IN (${effectKeys.map(() => "?").join(",")}) AND archived_at IS NULL`,
    ctx.tenant.id,
    ...effectKeys,
  );
  if (effectRows.length !== effectKeys.length)
    throw new ApiError(422, "effect_invalid", "One or more effects are not available.");
  let parentEditionId: string | null = null;
  if (input.parentEditionId) {
    const parent = await first<{ id: string }>(
      ctx.db,
      "SELECT id FROM fb_artwork_editions WHERE id = ? AND card_id = ? AND tenant_id = ? AND archived_at IS NULL",
      input.parentEditionId,
      card.id,
      ctx.tenant.id,
    );
    if (!parent) throw new ApiError(422, "parent_edition_invalid", "The edition being revised is not available on this card.");
    parentEditionId = parent.id;
  }
  const editionId = newId("edt");
  const now = nowIso();
  const composition = input.composition
    ? {
        mode: ["contain", "fill", "medallion"].includes(input.composition.mode ?? "")
          ? input.composition.mode
          : "contain",
        zoom: Math.min(1.6, Math.max(0.6, Number(input.composition.zoom ?? 1))),
        offsetX: Math.min(20, Math.max(-20, Number(input.composition.offsetX ?? 0))),
        offsetY: Math.min(20, Math.max(-20, Number(input.composition.offsetY ?? 0))),
      }
    : null;
  const statements = [
    ctx.db
      .prepare(
        `INSERT INTO fb_artwork_editions
          (id, tenant_id, card_id, name, subject_asset_id, background_asset_id, recipe_id, status, created_at, composition_json, parent_edition_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        editionId,
        ctx.tenant.id,
        card.id,
        input.name.trim().slice(0, 160),
        subject.id,
        input.backgroundAssetId ?? null,
        recipe.id,
        input.status ?? "published",
        now,
        composition ? JSON.stringify(composition) : null,
        parentEditionId,
      ),
    ...requestedVariants.map((variant) => {
      const material = materialRows.find((row) => row.key === variant.material)!;
      const effect = effectRows.find((row) => row.key === (variant.effect ?? "none"))!;
      return ctx.db
        .prepare(
          `INSERT INTO fb_variants (id, tenant_id, card_id, edition_id, material_id, effect_id, name, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          newId("var"),
          ctx.tenant.id,
          card.id,
          editionId,
          material.id,
          effect.key === "none" ? null : effect.id,
          effect.key === "none" ? material.name : `${material.name} · ${effect.name}`,
          input.status ?? "published",
          now,
        );
    }),
    auditStatement(ctx, "card.edition.created", "card", card.id, {
      edition: input.name,
      materials: input.materials,
      effects: effectKeys,
    }),
  ];
  await ctx.db.batch(statements);
  return getCard(ctx, card.id, { includeDrafts: true });
}
