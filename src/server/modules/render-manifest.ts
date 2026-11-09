import { z } from "zod";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { ApiError } from "../context";
import { first } from "../db";
import { canonicalJson, sha256Hex } from "../ids";
import { readVerifiedRenderInput } from "./assets";

// A commitment to a proposed render, not an attestation of renderer execution
// or permission to publish. Back/mark/layers/fonts must be registered inputs;
// the legacy worker's implicit local-file lookup cannot produce this contract.
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/);
const text = z.string().max(2000);
const asset = z.strictObject({
  id,
  revision: z.number().int().positive(),
  key: z.string().min(1).max(1024),
  version: z.string().min(1).max(256),
  etag: z.string().min(1).max(256),
  sha256: digest,
  kind: z.enum(["subject", "background", "frame", "material", "effect", "brand", "render"]),
  processingState: z.enum(["staged", "processing", "ready", "failed", "quarantined"]),
  reviewStatus: z.string().min(1).max(64),
  accessClassification: z.enum(["public", "member", "private"]),
  provenanceJson: z.string().max(50000),
  dependenciesJson: z.string().max(50000),
  bytes: z
    .number()
    .int()
    .min(1)
    .max(8 * 1024 * 1024),
  mime: z.enum(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]),
});
export const renderManifestSchema = z
  .strictObject({
    protocol: z.literal("foilbury-render-inputs-v1"),
    tenantId: id,
    cardId: id,
    collectionId: id,
    variantId: id,
    editionId: id,
    editionName: text,
    recipeId: id,
    cardVersion: z.number().int().positive(),
    editionSourceHash: digest.nullable(),
    recipeVersion: z.number().int().positive(),
    recipeConfig: z.string().max(20000),
    metadata: z.strictObject({
      name: text,
      subtitle: text,
      setName: text,
      serial: z.enum(["PUBLIC SHOWCASE", "MEMBER EDITION", "PRIVATE EDITION"]),
      className: text,
      rarity: text,
      material: z.enum(["plain", "silver", "gold", "diamond"]),
      effect: z.enum(["none", "holographic", "prismatic"]),
      composition: z.strictObject({
        mode: z.enum(["contain", "fill", "medallion"]),
        zoom: z.number().finite().min(0.6).max(1.6),
        offsetX: z.number().finite().min(-20).max(20),
        offsetY: z.number().finite().min(-20).max(20),
      }),
    }),
    assets: z.strictObject({
      subject: asset,
      background: asset,
      back: asset,
      mark: asset.nullable(),
    }),
    // SHA-256 commitments to every executable/rendering dependency and selected
    // static layer. These values must later be measured by a trusted executor.
    renderer: z.strictObject({
      bundleSha256: digest,
      lockfileSha256: digest,
      runtimeImageSha256: digest,
      fonts: z.strictObject({
        fraunces: digest,
        manrope: digest,
        monoRegular: digest,
        monoSemibold: digest,
      }),
      layers: z.strictObject({ material: digest, frame: digest, effect: digest.nullable() }),
    }),
  })
  .superRefine((value, ctx) => {
    if ((value.metadata.effect === "none") !== (value.renderer.layers.effect === null))
      ctx.addIssue({
        code: "custom",
        path: ["renderer", "layers", "effect"],
        message: "Effect layer must match the selected effect.",
      });
    for (const [role, entry] of Object.entries(value.assets)) {
      if (
        entry &&
        (!(
          entry.key.startsWith(`tenants/${value.tenantId}/`) ||
          (role === "mark" &&
            entry.kind === "brand" &&
            entry.key.startsWith("collection-brand-v1/"))
        ) ||
          /[\\\u0000-\u001f]/.test(entry.key) ||
          entry.key.split("/").some((part) => !part || part === "." || part === ".."))
      )
        ctx.addIssue({
          code: "custom",
          path: ["assets", role, "key"],
          message: "Input must belong to this tenant.",
        });
    }
  });
export type RenderManifest = z.infer<typeof renderManifestSchema>;

export async function commitRenderManifest(
  input: unknown,
): Promise<{ manifest: RenderManifest; sha256: string }> {
  const parsed = renderManifestSchema.safeParse(input);
  if (!parsed.success)
    throw new ApiError(
      422,
      "render_manifest_invalid",
      "The render input manifest is incomplete or invalid.",
    );
  const manifest = parsed.data;
  return { manifest, sha256: await sha256Hex(canonicalJson(manifest)) };
}

/** Fetch bytes against recorded R2 versions and digests. No publication authority. */
export async function readRenderManifestInputs(media: R2Bucket, manifest: RenderManifest) {
  // Parse again so no caller can bypass validation by casting an arbitrary object.
  const { manifest: checked, sha256 } = await commitRenderManifest(manifest);
  const [subject, background, back, mark] = await Promise.all([
    readVerifiedRenderInput(media, checked.assets.subject),
    readVerifiedRenderInput(media, checked.assets.background),
    readVerifiedRenderInput(media, checked.assets.back),
    checked.assets.mark
      ? readVerifiedRenderInput(media, checked.assets.mark)
      : Promise.resolve(null),
  ]);
  return { manifest: checked, sha256, bytes: { subject, background, back, mark } };
}

/** Build the same reference predicate for a future transaction-bound mutation.
 * This does not itself authorize a renderer or publish an output. */
export async function renderManifestReferenceFence(input: unknown) {
  const { manifest } = await commitRenderManifest(input);
  const records = Object.values(manifest.assets).filter((entry) => entry !== null);
  const sql = `SELECT 1 AS ok FROM fb_variants v
    JOIN fb_artwork_editions e ON e.id=v.edition_id AND e.tenant_id=v.tenant_id AND e.card_id=v.card_id
    JOIN fb_card_definitions cd ON cd.id=v.card_id AND cd.tenant_id=v.tenant_id
    JOIN fb_recipes recipe ON recipe.id=e.recipe_id AND recipe.tenant_id=v.tenant_id
    JOIN fb_materials mat ON mat.id=v.material_id AND mat.tenant_id=v.tenant_id
    LEFT JOIN fb_effects fx ON fx.id=v.effect_id AND fx.tenant_id=v.tenant_id
    LEFT JOIN fb_classes cls ON cls.id=cd.class_id AND cls.tenant_id=cd.tenant_id
    LEFT JOIN fb_rarities rarity ON rarity.id=cd.rarity_id AND rarity.tenant_id=cd.tenant_id
    JOIN fb_collection_cards cc ON cc.card_id=cd.id
    JOIN fb_collections c ON c.id=cc.collection_id
    WHERE v.tenant_id=? AND v.id=? AND cd.id=? AND e.id=? AND e.recipe_id=? AND c.id=?
      AND e.subject_asset_id=? AND e.background_asset_id=? AND cd.card_back_asset_id=? AND c.logo_asset_id IS ?
      AND (? IS NOT NULL OR c.logo_url IS NULL OR c.logo_url='')
      AND cd.version=? AND e.name=? AND e.source_hash IS ? AND recipe.version=? AND recipe.config_json=?
      AND cd.name=? AND (CASE WHEN instr(e.name,' — ')>0 AND length(substr(e.name,instr(e.name,' — ')+3))>0 THEN substr(e.name,instr(e.name,' — ')+3) ELSE COALESCE(cd.subtitle,'') END)=?
      AND c.name=? AND (CASE WHEN instr(e.name,' — ')>0 AND length(substr(e.name,instr(e.name,' — ')+3))>0 THEN 'Print' ELSE COALESCE(cls.name,'') END)=? AND COALESCE(rarity.name,'')=?
      AND mat.key=? AND COALESCE(fx.key,'none')=? AND json_valid(e.composition_json)
      AND json_extract(e.composition_json,'$.mode')=? AND json_extract(e.composition_json,'$.zoom')=?
      AND json_extract(e.composition_json,'$.offsetX')=? AND json_extract(e.composition_json,'$.offsetY')=?
      AND NOT EXISTS (SELECT 1 FROM fb_collection_cards all_cc LEFT JOIN fb_collections all_c ON all_c.id=all_cc.collection_id
        WHERE all_cc.card_id=cd.id AND (all_c.id IS NULL OR all_c.status<>'published' OR all_c.archived_at IS NOT NULL OR all_c.scope NOT IN ('global','bot')
          OR (all_c.scope='bot' AND all_c.owner_tenant_id IS NOT v.tenant_id)
          OR NOT ((all_c.view_audience='public' AND all_c.scope='global' AND all_c.public_approved_at IS NOT NULL)
            OR all_c.view_audience IN ('members','private'))))
      AND (CASE WHEN EXISTS (SELECT 1 FROM fb_collection_cards pc JOIN fb_collections p ON p.id=pc.collection_id WHERE pc.card_id=cd.id AND p.view_audience='private') THEN 'PRIVATE EDITION'
        WHEN EXISTS (SELECT 1 FROM fb_collection_cards mc JOIN fb_collections m ON m.id=mc.collection_id WHERE mc.card_id=cd.id AND m.view_audience='members') THEN 'MEMBER EDITION'
        ELSE 'PUBLIC SHOWCASE' END)=?
      AND v.status='published' AND v.archived_at IS NULL AND e.status='published' AND e.archived_at IS NULL
      AND cd.status='published' AND cd.archived_at IS NULL AND c.status='published' AND c.archived_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM json_each(?) j LEFT JOIN fb_assets a ON a.id=json_extract(j.value,'$.id') AND a.tenant_id=v.tenant_id
        WHERE a.id IS NULL OR a.archived_at IS NOT NULL OR a.revision IS NOT json_extract(j.value,'$.revision')
          OR a.r2_key IS NOT json_extract(j.value,'$.key') OR a.sha256 IS NOT json_extract(j.value,'$.sha256')
          OR a.bytes IS NOT json_extract(j.value,'$.bytes') OR a.mime IS NOT json_extract(j.value,'$.mime')
          OR a.kind IS NOT json_extract(j.value,'$.kind') OR a.processing_state IS NOT json_extract(j.value,'$.processingState')
          OR a.review_status IS NOT json_extract(j.value,'$.reviewStatus') OR a.access_classification IS NOT json_extract(j.value,'$.accessClassification')
          OR a.provenance_json IS NOT json_extract(j.value,'$.provenanceJson') OR a.dependencies_json IS NOT json_extract(j.value,'$.dependenciesJson'))`;
  const args: unknown[] = [
    manifest.tenantId,
    manifest.variantId,
    manifest.cardId,
    manifest.editionId,
    manifest.recipeId,
    manifest.collectionId,
    manifest.assets.subject.id,
    manifest.assets.background.id,
    manifest.assets.back.id,
    manifest.assets.mark?.id ?? null,
    manifest.assets.mark?.id ?? null,
    manifest.cardVersion,
    manifest.editionName,
    manifest.editionSourceHash,
    manifest.recipeVersion,
    manifest.recipeConfig,
    manifest.metadata.name,
    manifest.metadata.subtitle,
    manifest.metadata.setName,
    manifest.metadata.className,
    manifest.metadata.rarity,
    manifest.metadata.material,
    manifest.metadata.effect,
    manifest.metadata.composition.mode,
    manifest.metadata.composition.zoom,
    manifest.metadata.composition.offsetX,
    manifest.metadata.composition.offsetY,
    manifest.metadata.serial,
    JSON.stringify(records),
  ];
  // Isolate the large expression from its caller: directly nesting this query
  // in a mutation exceeds D1's expression-depth limit.
  const predicate = `EXISTS (WITH render_input_check AS MATERIALIZED (${sql}) SELECT 1 FROM render_input_check)`;
  return { sql, predicate, args };
}

/** Point-in-time reference check only; not an authorization or publication fence. */
export async function checkRenderManifestReferences(db: D1Database, input: unknown) {
  const { sql, args } = await renderManifestReferenceFence(input);
  const row = await first<{ ok: number }>(db, sql, ...args);
  if (!row)
    throw new ApiError(
      409,
      "render_inputs_changed",
      "The selected render references or asset records no longer match.",
    );
  return { matched: true as const };
}
