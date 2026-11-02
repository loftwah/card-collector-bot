import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { ApiError, type Ctx } from "../context";
import { all, first, nowIso } from "../db";
import { newId, sha256Hex } from "../ids";
import { audit, auditStatement } from "../http";
import { createCard, getCard, normalizeSlug, publishSet, setCardStatus, getTaxonomy } from "./catalogue";
import { getAsset } from "./assets";
import { assertTransition } from "../state";

export interface ImportVariantSpec {
  material: string;
  effect?: string | null;
}

export interface ImportItemInput {
  source: string;
  sourceRepo: string;
  sourceCommit: string;
  sourcePath: string;
  sourceHash: string;
  logicalId: string;
  slug: string;
  name: string;
  subtitle?: string;
  description: string;
  bio?: string;
  bioSafe?: string;
  bioFull?: string;
  spoilerLevel?: number;
  attributes?: Array<Record<string, unknown>>;
  sourceRefs?: string[];
  reviewStatus?: string;
  sourceWork?: string;
  adaptationBoundary?: string;
  quote?: string;
  categorySlug?: string;
  collectionSlug?: string;
  classKey?: string;
  rarityKey?: string;
  tags?: string[];
  credit?: string;
  subjectAssetId: string;
  backgroundAssetId?: string;
  variants: ImportVariantSpec[];
  sets?: string[];
  /** Optimistic concurrency: the card version the manifest was built from. */
  expectedVersion?: number;
}

export interface ImportManifest {
  source: string;
  sourceRepo: string;
  sourceCommit: string;
  publish?: boolean;
  items: ImportItemInput[];
}

export async function previewImport(ctx: Ctx, manifest: ImportManifest) {
  const items = [];
  for (const item of manifest.items) {
    const card = await first<{ id: string; slug: string; name: string; version: number }>(
      ctx.db,
      "SELECT id, slug, name, version FROM fb_card_definitions WHERE tenant_id = ? AND logical_id = ?",
      ctx.tenant.id,
      item.logicalId,
    );
    const previous = await first<{ hash: string; status: string }>(
      ctx.db,
      "SELECT hash, status FROM fb_import_items WHERE tenant_id = ? AND source = ? AND logical_id = ? ORDER BY created_at DESC LIMIT 1",
      ctx.tenant.id,
      item.source,
      item.logicalId,
    );
    const action = !card ? "new" : previous?.hash === item.sourceHash ? "unchanged" : "revision";
    items.push({
      logicalId: item.logicalId,
      slug: item.slug,
      name: item.name,
      sourcePath: item.sourcePath,
      sourceHash: item.sourceHash,
      action,
      existingCardId: card?.id ?? null,
      currentVersion: card?.version ?? null,
      expectedVersion: item.expectedVersion ?? null,
      conflict: Boolean(card && item.expectedVersion !== undefined && card.version !== item.expectedVersion),
      sets: item.sets ?? [],
      variants: item.variants,
      published: card ? (await first<{ status: string }>(ctx.db, "SELECT status FROM fb_card_definitions WHERE id = ?", card.id))?.status === "published" : false,
    });
  }
  return {
    source: manifest.source,
    sourceRepo: manifest.sourceRepo,
    sourceCommit: manifest.sourceCommit,
    counts: {
      new: items.filter((item) => item.action === "new").length,
      unchanged: items.filter((item) => item.action === "unchanged").length,
      revision: items.filter((item) => item.action === "revision").length,
    },
    items,
  };
}

async function applyImportedCardMetadata(ctx: Ctx, cardId: string, item: ImportItemInput): Promise<void> {
  const hasMetadata =
    item.bio ||
    item.bioSafe ||
    item.bioFull ||
    item.attributes ||
    item.sourceRefs ||
    item.reviewStatus ||
    item.sourceWork ||
    item.adaptationBoundary ||
    item.quote ||
    item.credit;
  if (!hasMetadata) return;
  await ctx.db
    .prepare(
      `UPDATE fb_card_definitions SET
         bio = COALESCE(?, bio),
         bio_safe = COALESCE(?, bio_safe),
         spoiler_bio = COALESCE(?, spoiler_bio),
         spoiler_level = COALESCE(?, spoiler_level),
         attributes_json = COALESCE(?, attributes_json),
         source_refs_json = COALESCE(?, source_refs_json),
         review_status = COALESCE(?, review_status),
         source_work = COALESCE(?, source_work),
         adaptation_boundary = COALESCE(?, adaptation_boundary),
         quote = COALESCE(?, quote),
         credit = COALESCE(?, credit),
         updated_at = ?
       WHERE id = ? AND tenant_id = ?`,
    )
    .bind(
      item.bio ?? null,
      item.bioSafe ?? null,
      item.bioFull ?? null,
      item.spoilerLevel ?? null,
      item.attributes ? JSON.stringify(item.attributes) : null,
      item.sourceRefs ? JSON.stringify(item.sourceRefs) : null,
      item.reviewStatus ?? null,
      item.sourceWork ?? null,
      item.adaptationBoundary ?? null,
      item.quote ?? null,
      item.credit ?? null,
      nowIso(),
      cardId,
      ctx.tenant.id,
    )
    .run();
}

export async function commitImport(ctx: Ctx, manifest: ImportManifest) {
  if (manifest.items.length === 0) throw new ApiError(422, "import_empty", "The import manifest has no items.");
  if (manifest.items.length > 60) throw new ApiError(422, "import_limit", "Import at most 60 cards in one run.");
  const runId = newId("imp");
  const now = nowIso();
  await ctx.db
    .prepare(
      "INSERT INTO fb_import_runs (id, tenant_id, source, mode, status, summary_json, created_at) VALUES (?, ?, ?, ?, 'running', '{}', ?)",
    )
    .bind(runId, ctx.tenant.id, manifest.source, manifest.publish ? "import-publish" : "import-review", now)
    .run();

  const results: Array<{ logicalId: string; status: string; cardId?: string; editionId?: string; error?: string }> = [];
  for (const item of manifest.items) {
    try {
      // The current artwork edition's source hash is the authority. An import
      // item row alone can outlive the edition it was applied to, so do not use
      // it to skip reconciliation.
      const subject = await getAsset(ctx, item.subjectAssetId);
      if (subject.kind !== "subject") throw new ApiError(422, "subject_asset_invalid", "Subject asset must have kind subject.");
      if (item.backgroundAssetId) {
        const background = await getAsset(ctx, item.backgroundAssetId);
        if (background.kind !== "background") throw new ApiError(422, "background_asset_invalid", "Background asset must have kind background.");
      }
      let card = await first<{ id: string; status: string; version: number }>(
        ctx.db,
        "SELECT id, status, version FROM fb_card_definitions WHERE tenant_id = ? AND logical_id = ?",
        ctx.tenant.id,
        item.logicalId,
      );
      if (card && item.expectedVersion !== undefined && card.version !== item.expectedVersion) {
        throw new ApiError(409, "import_conflict", "This card changed through the Admin UI after the manifest was prepared. Re-export before importing.");
      }
      let outcome: "new" | "revision" = "new";
      let previousEdition: {
        id: string;
        source_hash: string | null;
        subject_asset_id: string;
        background_asset_id: string | null;
      } | null = null;
      if (!card) {
        const created = await createCard(ctx, {
          slug: item.slug,
          name: item.name,
          subtitle: item.subtitle,
          description: item.description,
          bio: item.bio,
          bioSafe: item.bioSafe,
          quote: item.quote,
          spoilerLevel: item.spoilerLevel,
          spoilerBio: item.bioFull,
          attributes: item.attributes,
          sourceRefs: item.sourceRefs,
          reviewStatus: item.reviewStatus,
          sourceWork: item.sourceWork,
          adaptationBoundary: item.adaptationBoundary,
          logicalId: item.logicalId,
          classKey: item.classKey,
          categorySlug: item.categorySlug,
          collectionSlug: item.collectionSlug,
          rarityKey: item.rarityKey,
          tags: item.tags,
          source: {
            repo: item.sourceRepo,
            path: item.sourcePath,
            commit: item.sourceCommit,
            logicalId: item.logicalId,
            credit: item.credit,
          },
        });
        card = { id: created.id, status: created.status, version: 1 };
      } else {
        outcome = "revision";
        previousEdition = await first<{
          id: string;
          source_hash: string | null;
          subject_asset_id: string;
          background_asset_id: string | null;
        }>(
          ctx.db,
          "SELECT id, source_hash, subject_asset_id, background_asset_id FROM fb_artwork_editions WHERE tenant_id = ? AND card_id = ? AND archived_at IS NULL ORDER BY created_at DESC LIMIT 1",
          ctx.tenant.id,
          card.id,
        );
        if (previousEdition?.source_hash === item.sourceHash) {
          await applyImportedCardMetadata(ctx, card.id, item);
          results.push({ logicalId: item.logicalId, status: "unchanged", cardId: card.id });
          continue;
        }
      }
      const recipe = await first<{ id: string }>(
        ctx.db,
        "SELECT id FROM fb_recipes WHERE tenant_id = ? AND status = 'published' ORDER BY version DESC LIMIT 1",
        ctx.tenant.id,
      );
      if (!recipe) throw new ApiError(409, "recipe_missing", "No published card recipe exists.");
      const editionId = previousEdition?.id ?? newId("edt");
      const variantIds: string[] = [];
      const statements: D1PreparedStatement[] = [];
      if (previousEdition) {
        // Revise the current edition in place. The edition and variant IDs stay
        // stable, so owned serials and the ledger keep pointing at the same
        // collectible; only the artwork revision and provenance advance.
        statements.push(
          ctx.db
            .prepare(
              `UPDATE fb_artwork_editions SET
                 name = ?, subject_asset_id = ?, background_asset_id = ?, recipe_id = ?, status = 'draft',
                 source_repo = ?, source_path = ?, source_commit = ?, source_logical_id = ?, source_hash = ?,
                 credit = ?, archived_at = NULL
               WHERE id = ? AND tenant_id = ?`,
            )
            .bind(
              `${item.name} — source edition`,
              item.subjectAssetId,
              item.backgroundAssetId ?? null,
              recipe.id,
              item.sourceRepo,
              item.sourcePath,
              item.sourceCommit,
              item.logicalId,
              item.sourceHash,
              item.credit ?? null,
              editionId,
              ctx.tenant.id,
            ),
          auditStatement(ctx, "import.edition.revised", "artwork_edition", editionId, {
            previous_source_hash: previousEdition.source_hash,
            source_hash: item.sourceHash,
            previous_subject_asset_id: previousEdition.subject_asset_id,
            subject_asset_id: item.subjectAssetId,
            previous_background_asset_id: previousEdition.background_asset_id,
            background_asset_id: item.backgroundAssetId ?? null,
          }),
        );
      } else {
        statements.push(
          ctx.db
            .prepare(
              `INSERT INTO fb_artwork_editions
                (id, tenant_id, card_id, name, subject_asset_id, background_asset_id, recipe_id, status,
                 source_repo, source_path, source_commit, source_logical_id, source_hash, credit, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              editionId,
              ctx.tenant.id,
              card.id,
              `${item.name} — source edition`,
              item.subjectAssetId,
              item.backgroundAssetId ?? null,
              recipe.id,
              item.sourceRepo,
              item.sourcePath,
              item.sourceCommit,
              item.logicalId,
              item.sourceHash,
              item.credit ?? null,
              now,
            ),
        );
      }
      const taxonomy = await getTaxonomy(ctx);
      const existingVariants = previousEdition
        ? await all<{ id: string; material_id: string; effect_id: string | null }>(
            ctx.db,
            "SELECT id, material_id, effect_id FROM fb_variants WHERE tenant_id = ? AND edition_id = ? AND archived_at IS NULL",
            ctx.tenant.id,
            editionId,
          )
        : [];
      for (const spec of item.variants) {
        const material = taxonomy.materials.find((row) => row.key === spec.material);
        if (!material) throw new ApiError(422, "material_unknown", `Unknown material ${spec.material}.`);
        const effect = spec.effect
          ? taxonomy.effects.find((row) => row.key === spec.effect)
          : taxonomy.effects.find((row) => row.key === "none");
        if (spec.effect && !effect) throw new ApiError(422, "effect_unknown", `Unknown effect ${spec.effect}.`);
        const effectId = effect ? String(effect.id) : null;
        const existing = existingVariants.find(
          (row) => row.material_id === String(material.id) && (row.effect_id ?? null) === effectId,
        );
        const variantId = existing?.id ?? newId("var");
        variantIds.push(variantId);
        const materialName = String(material.name);
        const effectName = effect ? String(effect.name) : "None";
        const variantName = effectName === "None" ? materialName : `${materialName} · ${effectName}`;
        if (existing) {
          statements.push(
            ctx.db
              .prepare(
                "UPDATE fb_variants SET name = ?, status = 'draft', archived_at = NULL WHERE id = ? AND tenant_id = ? AND edition_id = ?",
              )
              .bind(variantName, variantId, ctx.tenant.id, editionId),
          );
        } else {
          statements.push(
            ctx.db
              .prepare(
                `INSERT INTO fb_variants
                  (id, tenant_id, card_id, edition_id, material_id, effect_id, name, status, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?)`,
              )
              .bind(
                variantId,
                ctx.tenant.id,
                card.id,
                editionId,
                String(material.id),
                effectId,
                variantName,
                now,
              ),
          );
        }
      }
      statements.push(
        ctx.db
          .prepare(
            `INSERT INTO fb_import_items
              (id, tenant_id, run_id, source, source_repo, source_path, source_commit, logical_id, hash, status, card_id, asset_id, notes, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(tenant_id, source, source_path, source_commit, logical_id, hash) DO UPDATE SET
               run_id = excluded.run_id, status = excluded.status, card_id = excluded.card_id,
               asset_id = excluded.asset_id, notes = excluded.notes, created_at = excluded.created_at`,
          )
          .bind(
            newId("imi"),
            ctx.tenant.id,
            runId,
            item.source,
            item.sourceRepo,
            item.sourcePath,
            item.sourceCommit,
            item.logicalId,
            item.sourceHash,
            outcome === "new" ? "imported" : "updated",
            card.id,
            item.subjectAssetId,
            null,
            now,
          ),
        auditStatement(ctx, "import.item", "card", card.id, {
          source: item.source,
          source_path: item.sourcePath,
          source_commit: item.sourceCommit,
          hash: item.sourceHash,
          outcome,
        }),
      );
      await ctx.db.batch(statements);
      await applyImportedCardMetadata(ctx, card.id, item);
      if (manifest.publish) {
        await ctx.db.batch([
          ctx.db
            .prepare("UPDATE fb_artwork_editions SET status = 'published' WHERE id = ? AND tenant_id = ?")
            .bind(editionId, ctx.tenant.id),
          ctx.db
            .prepare("UPDATE fb_variants SET status = 'published' WHERE edition_id = ? AND tenant_id = ?")
            .bind(editionId, ctx.tenant.id),
        ]);
        await setCardStatus(ctx, card.id, "published");
      }
      if (item.collectionSlug) {
        await ctx.db
          .prepare(
            `INSERT OR IGNORE INTO fb_collection_cards (collection_id, card_id, tenant_id, sort, added_by, added_at)
             SELECT id, ?, ?, 0, ?, ? FROM fb_collections WHERE slug = ? AND owner_tenant_id = ? AND archived_at IS NULL`,
          )
          .bind(card.id, ctx.tenant.id, ctx.user?.id ?? "system", nowIso(), item.collectionSlug, ctx.tenant.id)
          .run();
      }
      if (item.sets?.length) {
        for (const setSlug of item.sets) {
          await appendSetMembership(ctx, setSlug, [card.id]);
        }
      }
      results.push({ logicalId: item.logicalId, status: outcome, cardId: card.id, editionId });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Import item failed";
      results.push({ logicalId: item.logicalId, status: "failed", error: message });
      await ctx.db
        .prepare(
          "INSERT INTO fb_import_items (id, tenant_id, run_id, source, source_repo, source_path, source_commit, logical_id, hash, status, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'failed', ?, ?) ON CONFLICT(tenant_id, source, source_path, source_commit, logical_id, hash) DO UPDATE SET run_id = excluded.run_id, status = 'failed', notes = excluded.notes, created_at = excluded.created_at",
        )
        .bind(
          newId("imi"),
          ctx.tenant.id,
          runId,
          item.source,
          item.sourceRepo,
          item.sourcePath,
          item.sourceCommit,
          item.logicalId,
          item.sourceHash,
          message.slice(0, 500),
          nowIso(),
        )
        .run();
    }
  }
  const failed = results.filter((result) => result.status === "failed").length;
  const summary = {
    total: results.length,
    imported: results.filter((result) => result.status === "new").length,
    revised: results.filter((result) => result.status === "revision").length,
    unchanged: results.filter((result) => result.status === "unchanged").length,
    failed,
  };
  await ctx.db
    .prepare("UPDATE fb_import_runs SET status = ?, summary_json = ?, completed_at = ? WHERE id = ?")
    .bind(failed ? "partial" : "complete", JSON.stringify(summary), nowIso(), runId)
    .run();
  return { runId, summary, results };
}

async function appendSetMembership(ctx: Ctx, setSlug: string, cardIds: string[]) {
  const set = await first<{ id: string; version: number; status: string }>(
    ctx.db,
    "SELECT id, version, status FROM fb_sets WHERE tenant_id = ? AND slug = ?",
    ctx.tenant.id,
    normalizeSlug(setSlug),
  );
  if (!set) throw new ApiError(404, "set_not_found", `Set ${setSlug} was not found.`);
  if (set.status === "published") {
    const previous = await all<{ card_id: string; sort: number }>(
      ctx.db,
      "SELECT card_id, sort FROM fb_set_memberships WHERE tenant_id = ? AND set_id = ? AND set_version = ? ORDER BY sort",
      ctx.tenant.id,
      set.id,
      set.version,
    );
    const nextVersion = set.version + 1;
    const existing = new Set(previous.map((row) => row.card_id));
    const additions = cardIds.filter((id) => !existing.has(id));
    await ctx.db.batch([
      ctx.db
        .prepare("UPDATE fb_sets SET version = ?, status = 'draft' WHERE id = ? AND tenant_id = ? AND version = ?")
        .bind(nextVersion, set.id, ctx.tenant.id, set.version),
      ctx.db
        .prepare(
          "INSERT INTO fb_set_reward_rules (id, tenant_id, set_id, set_version, reward_amount, created_at) SELECT ?, tenant_id, id, ?, COALESCE((SELECT reward_amount FROM fb_set_reward_rules WHERE set_id = ? AND set_version = ?), 0), ? FROM fb_sets WHERE id = ?",
        )
        .bind(newId("sr"), nextVersion, set.id, set.version, nowIso(), set.id),
      ...previous.map((row, index) =>
        ctx.db
          .prepare("INSERT INTO fb_set_memberships (id, tenant_id, set_id, set_version, card_id, sort, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .bind(newId("smi"), ctx.tenant.id, set.id, nextVersion, row.card_id, index, nowIso()),
      ),
      ...additions.map((cardId, index) =>
        ctx.db
          .prepare("INSERT INTO fb_set_memberships (id, tenant_id, set_id, set_version, card_id, sort, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .bind(newId("smi"), ctx.tenant.id, set.id, nextVersion, cardId, previous.length + index, nowIso()),
      ),
      auditStatement(ctx, "set.membership.imported", "set", set.id, { version: nextVersion, cards: additions.length }),
    ]);
    return;
  }
  const existing = await all<{ card_id: string }>(
    ctx.db,
    "SELECT card_id FROM fb_set_memberships WHERE tenant_id = ? AND set_id = ? AND set_version = ?",
    ctx.tenant.id,
    set.id,
    set.version,
  );
  const existingIds = new Set(existing.map((row) => row.card_id));
  const additions = cardIds.filter((id) => !existingIds.has(id));
  if (!additions.length) return;
  await ctx.db.batch(
    additions.map((cardId, index) =>
      ctx.db
        .prepare("INSERT INTO fb_set_memberships (id, tenant_id, set_id, set_version, card_id, sort, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(newId("smi"), ctx.tenant.id, set.id, set.version, cardId, existing.length + index, nowIso()),
    ).concat([auditStatement(ctx, "set.membership.imported", "set", set.id, { version: set.version, cards: additions.length })]),
  );
}

export async function createRenderJobs(ctx: Ctx, options?: { force?: boolean }) {
  const variants = await all<{
    variant_id: string;
    card_id: string;
    edition_id: string;
    recipe_id: string;
    subject_asset_id: string;
    background_asset_id: string | null;
    card_name: string;
    variant_name: string;
    material_key: string;
    effect_key: string | null;
  }>(
    ctx.db,
    `SELECT v.id AS variant_id, v.card_id, v.edition_id, e.recipe_id, e.subject_asset_id, e.background_asset_id,
            cd.name AS card_name, cd.slug AS card_slug, cd.subtitle AS card_subtitle, v.name AS variant_name,
            m.key AS material_key, fx.key AS effect_key
       FROM fb_variants v
       JOIN fb_artwork_editions e ON e.id = v.edition_id
       JOIN fb_card_definitions cd ON cd.id = v.card_id
       JOIN fb_materials m ON m.id = v.material_id
       LEFT JOIN fb_effects fx ON fx.id = v.effect_id
      WHERE v.tenant_id = ? AND v.status = 'published' AND e.status = 'published'
        AND v.archived_at IS NULL AND e.archived_at IS NULL
        AND (? = 1 OR NOT EXISTS (
          SELECT 1 FROM fb_variant_renders r
           WHERE r.variant_id = v.id AND r.tenant_id = v.tenant_id AND r.status = 'published'
             AND r.source_hash IS e.source_hash
        ))
        AND NOT EXISTS (SELECT 1 FROM fb_jobs j WHERE j.tenant_id = v.tenant_id AND j.kind = 'render_card'
          AND json_extract(j.payload_json, '$.variant_id') = v.id AND j.status IN ('pending','running'))`,
    ctx.tenant.id,
    options?.force ? 1 : 0,
  );
  const jobIds: string[] = [];
  for (const variant of variants) {
    const id = newId("job");
    jobIds.push(id);
    await ctx.db.batch([
      ctx.db
        .prepare(
          "INSERT INTO fb_jobs (id, tenant_id, kind, status, payload_json, attempts, max_attempts, available_at, created_at, updated_at) VALUES (?, ?, 'render_card', 'pending', ?, 0, 3, ?, ?, ?)",
        )
        .bind(
          id,
          ctx.tenant.id,
          JSON.stringify(variant),
          nowIso(),
          nowIso(),
          nowIso(),
        ),
      auditStatement(ctx, "render.queued", "job", id, { variant_id: variant.variant_id }),
    ]);
  }
  return { queued: jobIds.length, jobIds };
}

export async function listRenderJobs(ctx: Ctx, status?: string) {
  if (status === "pending") {
    return all(
      ctx.db,
      "SELECT * FROM fb_jobs WHERE tenant_id = ? AND status = 'pending' AND available_at <= ? ORDER BY created_at LIMIT 200",
      ctx.tenant.id,
      nowIso(),
    );
  }
  return all(
    ctx.db,
    `SELECT * FROM fb_jobs WHERE tenant_id = ? ${status ? "AND status = ?" : ""} ORDER BY created_at DESC LIMIT 200`,
    ...(status ? [ctx.tenant.id, status] : [ctx.tenant.id]),
  );
}

export async function claimRenderJob(ctx: Ctx, jobId?: string) {
  const job = await first<{
    id: string;
    payload_json: string;
    attempts: number;
    max_attempts: number;
  }>(
    ctx.db,
    jobId
      ? "SELECT id, payload_json, attempts, max_attempts FROM fb_jobs WHERE id = ? AND tenant_id = ? AND status IN ('pending','failed') AND available_at <= ?"
      : "SELECT id, payload_json, attempts, max_attempts FROM fb_jobs WHERE tenant_id = ? AND kind = 'render_card' AND status = 'pending' AND available_at <= ? ORDER BY created_at LIMIT 1",
    ...(jobId ? [jobId, ctx.tenant.id, nowIso()] : [ctx.tenant.id, nowIso()]),
  );
  // Kept explicit: a job id selection needs both the status and availability guard parameters.
  if (!job) return null;
  const claimed = await first<{ id: string }>(
    ctx.db,
    "UPDATE fb_jobs SET status = 'running', locked_at = ?, attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'pending' RETURNING id",
    nowIso(),
    nowIso(),
    job.id,
  );
  if (!claimed) return null;
  return { ...job, payload: JSON.parse(job.payload_json) as Record<string, unknown> };
}

export async function failRenderJob(ctx: Ctx, jobId: string, message: string) {
  const job = await first<{ attempts: number; max_attempts: number }>(
    ctx.db,
    "SELECT attempts, max_attempts FROM fb_jobs WHERE id = ? AND tenant_id = ?",
    jobId,
    ctx.tenant.id,
  );
  if (!job) throw new ApiError(404, "job_not_found", "Job not found.");
  const retry = job.attempts < job.max_attempts;
  await ctx.db
    .prepare(
      "UPDATE fb_jobs SET status = ?, available_at = ?, last_error = ?, updated_at = ? WHERE id = ? AND tenant_id = ?",
    )
    .bind(retry ? "pending" : "failed", new Date(Date.now() + 15_000).toISOString(), message.slice(0, 500), nowIso(), jobId, ctx.tenant.id)
    .run();
  return { retry };
}

export async function completeRenderJob(ctx: Ctx, jobId: string, bytes: Uint8Array, backBytes?: Uint8Array) {
  const job = await first<{ payload_json: string; status: string }>(
    ctx.db,
    "SELECT payload_json, status FROM fb_jobs WHERE id = ? AND tenant_id = ?",
    jobId,
    ctx.tenant.id,
  );
  if (!job) throw new ApiError(404, "job_not_found", "Job not found.");
  if (job.status === "succeeded") throw new ApiError(409, "job_already_complete", "This render job already completed.");
  if (job.status !== "running") throw new ApiError(409, "job_not_running", "Claim the render job before completing it.");
  const payload = JSON.parse(job.payload_json) as {
    variant_id: string;
    recipe_id: string;
    variant_name: string;
  };
  const { createRenderAsset } = await import("./assets");
  const render = await createRenderAsset(ctx, {
    variantId: payload.variant_id,
    recipeId: payload.recipe_id,
    bytes,
  });
  let back = null;
  if (backBytes?.length) {
    const { createBackRenderAsset } = await import("./assets");
    back = await createBackRenderAsset(ctx, {
      variantId: payload.variant_id,
      recipeId: payload.recipe_id,
      bytes: backBytes,
    });
  }
  await ctx.db.batch([
    ctx.db
      .prepare("UPDATE fb_jobs SET status = 'succeeded', result_json = ?, last_error = NULL, updated_at = ? WHERE id = ? AND tenant_id = ?")
      .bind(JSON.stringify({ ...render, back }), nowIso(), jobId, ctx.tenant.id),
    ctx.db
      .prepare(
        "INSERT INTO fb_outbox (id, tenant_id, topic, payload_json, status, attempts, available_at, created_at) VALUES (?, ?, 'render.completed', ?, 'pending', 0, ?, ?)",
      )
      .bind(newId("out"), ctx.tenant.id, JSON.stringify({ job_id: jobId, ...render, back }), nowIso(), nowIso()),
    auditStatement(ctx, "render.completed", "job", jobId, { ...render, back }),
  ]);
  return { ...render, back };
}

export async function estimateGenerationPlan(ctx: Ctx, input: { prompt: string; model: string; count: number }) {
  const unitCost = 40_000;
  const estimated = unitCost * Math.max(1, Math.min(10, input.count));
  return {
    provider: "fal",
    model: input.model,
    count: input.count,
    estimated_cost_micros: estimated,
    currency: "USD",
    budget_ceiling_micros: 0,
    status: "blocked_no_recorded_ceiling",
    message:
      "No recorded generation ceiling exists. This build does not submit billed jobs; use supplied or designed layers, or record a ceiling before approving a batch.",
    input_hash: await sha256Hex(JSON.stringify(input)),
  };
}
