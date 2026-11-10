/**
 * Foilbury Art Lab.
 *
 * A brief is the operator's intent and spend ceiling. A job is one bounded
 * provider request. A candidate is an immutable output with its own provenance,
 * feedback and decision. Approval and publication are deliberately separate:
 * approving a direction never overwrites the live card or brand kit.
 *
 * Whole-card AI is a first-class card method. The shared card renderer is also
 * available as a comparison method, but it is not a gate on the lab.
 */
import {
  ApiError,
  canManageContent,
  canManageGlobalCollection,
  isGlobalCollectionAdmin,
  requireRecentStrongAuth,
  requireScope,
  requireUser,
  type Ctx,
  type CurrentUser,
} from "../context";
import { all, first, nowIso, parseJson, statement } from "../db";
import { auditStatement } from "../http";
import { newId } from "../ids";
import {
  createBackRenderAsset,
  createDerivative,
  createRenderAsset,
  readAsset,
  uploadAsset,
  type AssetKind,
  type AssetRow,
} from "./assets";
import { listCards, type CardView, type EditionRow, type VariantRow } from "./catalogue";
import { listCollections, type CollectionSummary } from "./collections";
import { readBrandSelections } from "./brand";
import {
  CARD_STYLE_KEYS,
  CARD_STYLE_LABEL,
  CARD_STYLES,
  DEFAULT_CARD_STYLES,
  normalizeCardStyleKeys,
  stylePromptLine,
  type CardStyleKey,
} from "../../lib/card-styles";

export const ART_CATEGORIES = [
  "cards",
  "icons",
  "mascots",
  "logo",
  "og_images",
  "shareables",
  "banners",
  "other",
] as const;
export type ArtCategory = (typeof ART_CATEGORIES)[number];

export const BRAND_CATEGORIES: ArtCategory[] = [
  "icons",
  "mascots",
  "logo",
  "og_images",
  "shareables",
  "banners",
  "other",
];

export const ART_CATEGORY_LABELS: Record<ArtCategory, string> = {
  cards: "Cards",
  icons: "Icons",
  mascots: "Mascots",
  logo: "Logo",
  og_images: "OG images",
  shareables: "Shareables",
  banners: "Banners",
  other: "Other art",
};

export const ART_METHODS = ["whole_card", "composed_scene", "composed_texture", "raw_art"] as const;
export type ArtMethod = (typeof ART_METHODS)[number];

export const ART_METHOD_LABELS: Record<ArtMethod, string> = {
  whole_card: "Whole-card AI",
  composed_scene: "Scene + renderer",
  composed_texture: "Texture + renderer",
  raw_art: "Raw art",
};

export const ART_METHOD_NOTES: Record<ArtMethod, string> = {
  whole_card:
    "The provider generates the complete 5:7 card from the real subject, the supplied collection mark and the exact copy prepared on a reference sheet. Code only scales it and records provenance.",
  composed_scene:
    "Comparison method. The provider generates scene/key art; the shared card renderer composes the card, type and back.",
  composed_texture:
    "Comparison method. The provider generates a texture or background plate; the shared card renderer composes the card, type and back.",
  raw_art: "The provider generates a standalone brand asset. Type, layout and marks stay in code.",
};

export const FEEDBACK_TAGS = [
  "too-busy",
  "wrong-palette",
  "wrong-face",
  "too-generic",
  "text-unreadable",
  "flat-material",
  "composition",
  "keep",
] as const;
export type FeedbackTag = (typeof FEEDBACK_TAGS)[number];

export const BRIEF_STATUSES = [
  "draft",
  "generating",
  "review",
  "approved",
  "published",
  "archived",
] as const;

export const CANDIDATE_STATUSES = [
  "generated",
  "shortlisted",
  "needs_revision",
  "rejected",
  "approved",
  "published",
] as const;
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

export const JOB_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;

export const DEFAULT_BRIEF_CAP_CENTS = 200;
export const MAX_BRIEF_CAP_CENTS = 2000;
export const DAILY_CAP_CENTS = 1000;

export interface ArtModelPrice {
  id: string;
  label: string;
  unitCents: number;
  priceNote: string;
  methods: ArtMethod[];
  /** Whether the runner can attach the prepared real-source reference sheet. */
  supportsReference?: boolean;
  /** FAL models disagree on the field name for a reference image. */
  referenceParam?: "image_url" | "image_urls";
}

export interface ArtProviderPrice {
  provider: "fal" | "openai";
  label: string;
  keyEnv: string;
  models: ArtModelPrice[];
}

/**
 * The single price table used by the queue, the cap check and the UI. These are
 * planning estimates, never a claim about a provider invoice. The runner records
 * the actual spend it observed; a failed job still records the estimated spend
 * unless the runner can prove no billed call was made.
 *
 * Whole-card AI is the primary card production method. OpenAI GPT Image 2.6
 * Sunburst is the default because it is the strongest layout/copy-adherence
 * model available to this project. FAL FLUX Pro Ultra and Seedream v4 are the
 * equivalent top-tier alternatives and both accept the prepared real-source
 * reference sheet.
 */
export const ART_PRICE_TABLE: ArtProviderPrice[] = [
  {
    provider: "openai",
    label: "OpenAI",
    keyEnv: "OPENAI_API_KEY",
    models: [
      {
        id: "gpt-image-2.6-sunburst",
        label: "GPT Image 2.6 Sunburst",
        unitCents: 5,
        priceNote:
          "US$0.05 per image planning estimate. OpenAI bills by output size and quality; record the reported spend on completion.",
        methods: ["whole_card", "composed_scene", "composed_texture", "raw_art"],
        supportsReference: true,
      },
    ],
  },
  {
    provider: "fal",
    label: "FAL.ai",
    keyEnv: "FAL_AI_API_KEY",
    models: [
      {
        id: "fal-ai/flux-pro/v1.1-ultra",
        label: "FLUX Pro 1.1 Ultra",
        unitCents: 6,
        priceNote:
          "US$0.06 per image planning estimate. Record the actual provider spend on completion.",
        methods: ["composed_scene", "composed_texture", "raw_art"],
        supportsReference: false,
      },
      {
        id: "fal-ai/bytedance/seedream/v4/edit",
        label: "Seedream v4 Edit",
        unitCents: 3,
        priceNote:
          "US$0.03 per image planning estimate. Record the actual provider spend on completion.",
        methods: ["whole_card"],
        supportsReference: true,
        referenceParam: "image_urls",
      },
      {
        id: "fal-ai/bytedance/seedream/v4/text-to-image",
        label: "Seedream v4 Text",
        unitCents: 3,
        priceNote:
          "US$0.03 per image planning estimate. Record the actual provider spend on completion.",
        methods: ["composed_scene", "composed_texture", "raw_art"],
        supportsReference: false,
      },
    ],
  },
];

export interface ArtBriefRow {
  id: string;
  tenant_id: string;
  category: ArtCategory;
  collection_id: string | null;
  card_id: string | null;
  target_variant_id: string | null;
  title: string;
  intent: string;
  references_json: string;
  audience: "private" | "members" | "public";
  status: string;
  candidate_count: number;
  provider: string;
  model: string;
  methods_json: string;
  style_keys_json: string;
  output_sizes_json: string;
  notes: string | null;
  cost_cap_cents: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface ArtJobRow {
  id: string;
  tenant_id: string;
  brief_id: string;
  method: ArtMethod;
  style_key: string | null;
  provider: string;
  model: string;
  prompt: string;
  count: number;
  size: string;
  status: string;
  cost_estimate_cents: number;
  cost_actual_cents: number | null;
  cost_source: string | null;
  error: string | null;
  created_by: string;
  claimed_by: string | null;
  claimed_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ArtCandidateRow {
  id: string;
  tenant_id: string;
  brief_id: string;
  job_id: string;
  asset_id: string;
  render_asset_id: string | null;
  render_back_asset_id: string | null;
  master_asset_id: string | null;
  preview_400_asset_id: string | null;
  thumb_128_asset_id: string | null;
  label: string;
  method: ArtMethod;
  style_key: string | null;
  provider: string;
  model: string;
  prompt: string;
  seed: string | null;
  width: number;
  height: number;
  sha256: string;
  audience: "private" | "members" | "public";
  official: number;
  status: CandidateStatus;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

export interface ArtFeedbackRow {
  id: string;
  tenant_id: string;
  candidate_id: string;
  author_user_id: string;
  decision: string;
  tags_json: string;
  body: string | null;
  created_at: string;
}

export interface ArtApprovalRow {
  id: string;
  tenant_id: string;
  brief_id: string;
  candidate_id: string;
  approved_by: string;
  approved_at: string;
  usage: string;
  style_key: string | null;
  notes: string | null;
  vector_ref: string | null;
  target_kind: string | null;
  target_id: string | null;
  published_asset_id: string | null;
  previous_state_json: string;
  published_at: string | null;
  published_by: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
  rollback_at: string | null;
  rollback_by: string | null;
  created_at: string;
}

export interface ArtPermissions {
  read: boolean;
  write: boolean;
  approve_public: boolean;
  publish: boolean;
  publish_brand: boolean;
}

export interface ArtCandidateView {
  id: string;
  brief_id: string;
  job_id: string;
  label: string;
  method: ArtMethod;
  method_label: string;
  method_note: string;
  style_key: string | null;
  style_label: string | null;
  provider: string;
  model: string;
  prompt: string;
  seed: string | null;
  width: number;
  height: number;
  display_width: number;
  display_height: number;
  sha256: string;
  audience: string;
  official: boolean;
  status: CandidateStatus;
  asset_id: string;
  render_asset_id: string | null;
  render_back_asset_id: string | null;
  master_asset_id: string | null;
  preview_400_asset_id: string | null;
  thumb_128_asset_id: string | null;
  display_side: "render" | "raw";
  metadata: Record<string, unknown>;
  files: {
    display: string;
    raw: string;
    back: string | null;
    master: string | null;
    preview400: string | null;
    thumb128: string | null;
    reference: string | null;
    download: string;
  };
  feedback: Array<
    Pick<ArtFeedbackRow, "id" | "decision" | "body" | "created_at"> & {
      author_user_id: string;
      tags: FeedbackTag[];
    }
  >;
  approval: ArtApprovalRow | null;
  created_at: string;
  updated_at: string;
}

export interface ArtBriefSummary {
  id: string;
  category: ArtCategory;
  title: string;
  intent: string;
  collection_id: string | null;
  collection_name: string | null;
  collection_slug: string | null;
  card_id: string | null;
  card_name: string | null;
  target_variant_id: string | null;
  audience: string;
  status: string;
  candidate_count: number;
  methods: ArtMethod[];
  styles: string[];
  spend_cents: number;
  cost_cap_cents: number;
  candidate_total: number;
  pending_count: number;
  approved_count: number;
  latest_job_status: string | null;
  latest_error: string | null;
  cover_candidate_id: string | null;
  cover_url: string | null;
  cover_method: ArtMethod | null;
  created_at: string;
  updated_at: string;
}

export interface ArtPin {
  candidate_id: string;
  brief_id: string;
  brief_title: string;
  category: ArtCategory;
  collection_name: string | null;
  card_name: string | null;
  label: string;
  method: ArtMethod;
  style_key: string | null;
  status: CandidateStatus;
  width: number;
  height: number;
  audience: string;
  created_at: string;
  image_url: string;
}

export interface ArtBriefDetail {
  brief: ArtBriefSummary & {
    references: string[];
    output_sizes: string[];
    notes: string | null;
    provider: string;
    model: string;
    style_keys: string[];
    created_by: string;
  };
  collection: {
    id: string;
    slug: string;
    name: string;
    scope: string;
    view_audience: string;
    logo_url: string | null;
    banner_url: string | null;
  } | null;
  card: {
    id: string;
    slug: string;
    name: string;
    subtitle: string | null;
    status: string;
    rarity_name: string | null;
    collection_name: string | null;
  } | null;
  target_variant: {
    id: string;
    name: string;
    material_key: string;
    effect_key: string | null;
    edition_id: string;
  } | null;
  jobs: ArtJobRow[];
  candidates: ArtCandidateView[];
  current_render: {
    asset_id: string;
    public_url: string;
    width: number;
    height: number;
    sha256: string;
    published_at: string | null;
    back_asset_id: string | null;
    back_sha256: string | null;
  } | null;
  permissions: ArtPermissions;
  price: { provider: string; model: string; unit_cents: number; note: string } | null;
}

interface BriefSummaryRow extends ArtBriefRow {
  collection_name: string | null;
  collection_slug: string | null;
  card_name: string | null;
  candidate_total: number;
  pending_count: number;
  approved_count: number;
  spend_cents: number;
  latest_job_status: string | null;
  latest_error: string | null;
  cover_candidate_id: string | null;
  cover_method: ArtMethod | null;
  cover_status: string | null;
}

interface CollectionRef {
  id: string;
  slug: string;
  name: string;
  scope: string;
  owner_tenant_id: string | null;
  status: string;
  view_audience: string;
  logo_asset_id: string | null;
  banner_asset_id: string | null;
  logo_url: string | null;
  banner_url: string | null;
  accent: string | null;
  archived_at: string | null;
}

interface CardRef {
  id: string;
  tenant_id: string;
  slug: string;
  name: string;
  subtitle: string | null;
  status: string;
  archived_at: string | null;
}

const STOP = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "for", "with", "on"]);

function words(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function slugPrefix(value: string): string {
  return value
    .split("-")
    .filter(Boolean)
    .map((part) => part[0] ?? "")
    .join("")
    .toUpperCase()
    .slice(0, 4);
}

function cleanText(value: string, field: string, min: number, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length < min) {
    throw new ApiError(
      422,
      `art_${field}_too_short`,
      `Give the ${field} at least ${min} characters.`,
    );
  }
  return trimmed.slice(0, max);
}

function optionalText(value: string | null | undefined, max: number): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

export function isBrandCategory(category: ArtCategory): boolean {
  return BRAND_CATEGORIES.includes(category);
}

/**
 * Brand candidate bytes stay behind the Access-protected admin path. Card
 * candidates are available inside the normal signed-in Studio path.
 */
function artFileBase(category: ArtCategory): string {
  return isBrandCategory(category) ? "/api/v1/admin/art" : "/api/v1/studio/art";
}

export function normalizeArtCategory(value: string): ArtCategory {
  if (!ART_CATEGORIES.includes(value as ArtCategory)) {
    throw new ApiError(422, "art_category_invalid", "Choose a supported Art Lab category.", {
      categories: [...ART_CATEGORIES],
    });
  }
  return value as ArtCategory;
}

export function normalizeArtMethod(value: string): ArtMethod {
  if (!ART_METHODS.includes(value as ArtMethod)) {
    throw new ApiError(422, "art_method_invalid", "Choose a supported generation method.", {
      methods: [...ART_METHODS],
    });
  }
  return value as ArtMethod;
}

export function normalizeFeedbackTags(values: string[] | undefined): FeedbackTag[] {
  const tags = (values ?? []).map((value) => value.trim()).filter(Boolean);
  for (const tag of tags) {
    if (!FEEDBACK_TAGS.includes(tag as FeedbackTag)) {
      throw new ApiError(422, "art_feedback_tag_invalid", "Use a supported feedback tag.", {
        tags: [...FEEDBACK_TAGS],
      });
    }
  }
  return [...new Set(tags)].slice(0, 8) as FeedbackTag[];
}

export function findModelPrice(
  provider: string,
  model: string,
): { provider: ArtProviderPrice; model: ArtModelPrice } | null {
  const providerEntry = ART_PRICE_TABLE.find((entry) => entry.provider === provider);
  if (!providerEntry) return null;
  const modelEntry = providerEntry.models.find((entry) => entry.id === model);
  if (!modelEntry) return null;
  return { provider: providerEntry, model: modelEntry };
}

function assertModelAndMethods(
  category: ArtCategory,
  provider: string,
  model: string,
  methods: string[],
): { provider: ArtProviderPrice; model: ArtModelPrice; methods: ArtMethod[] } {
  const price = findModelPrice(provider, model);
  if (!price) {
    throw new ApiError(422, "art_model_unknown", "Choose a provider model from the price table.", {
      providers: ART_PRICE_TABLE,
    });
  }
  const normalized = [...new Set(methods.map(normalizeArtMethod))];
  if (!normalized.length) {
    throw new ApiError(422, "art_method_required", "Choose at least one generation method.");
  }
  for (const method of normalized) {
    if (!price.model.methods.includes(method)) {
      throw new ApiError(
        422,
        "art_method_unsupported",
        `${price.model.label} does not support ${ART_METHOD_LABELS[method]} in this lab.`,
        { supported: price.model.methods },
      );
    }
    if (category === "cards" && method === "raw_art") {
      throw new ApiError(
        422,
        "art_method_card_raw",
        "Cards use whole-card AI, scene + renderer or texture + renderer. Raw art is a brand method.",
      );
    }
    if (category !== "cards" && method !== "raw_art") {
      throw new ApiError(
        422,
        "art_method_brand_raw",
        "Brand categories use raw art candidates; type, layout and marks stay in code.",
      );
    }
  }
  return { ...price, methods: normalized };
}

function normalizeReferences(values: string[] | undefined): string[] {
  const refs = (values ?? []).map((value) => value.trim()).filter(Boolean);
  for (const ref of refs) {
    const local = ref.startsWith("/") && !ref.startsWith("//");
    const https = /^https:\/\//i.test(ref);
    if (!local && !https) {
      throw new ApiError(
        422,
        "art_reference_invalid",
        "References must be HTTPS URLs or local paths.",
      );
    }
  }
  return [...new Set(refs)].slice(0, 20);
}

function normalizeVectorRef(value: string | null | undefined): string | null {
  const ref = value?.trim();
  if (!ref) return null;
  const local = ref.startsWith("/") && !ref.startsWith("//");
  const https = /^https:\/\//i.test(ref);
  if (!local && !https) {
    throw new ApiError(
      422,
      "art_vector_ref_invalid",
      "A logo vector source must be an HTTPS URL or local path.",
    );
  }
  return ref.slice(0, 1000);
}

function canRepresentedContent(ctx: Ctx): boolean {
  if (ctx.actor.type === "agent") return ["owner", "editor"].includes(ctx.user?.role ?? "");
  return canManageContent(ctx);
}

/**
 * Categories this caller may even see. Brand art is Super Admin only; card art
 * is content-management authority for the Bot or an assigned global collection.
 */
export function allowedArtCategories(ctx: Ctx): ArtCategory[] {
  const user = requireUser(ctx);
  if (ctx.actor.type === "agent") {
    const scopes = ctx.scopes ?? [];
    if (!scopes.includes("content:read") && !scopes.includes("content:write")) {
      throw new ApiError(
        403,
        "insufficient_scope",
        "The agent grant needs content:read or content:write for the Art Lab.",
      );
    }
  }
  if (user.platformAdmin) {
    if (ctx.actor.type === "agent") return [...ART_CATEGORIES];
    if (
      ctx.config.environment === "local" ||
      (ctx.accessIdentity && ctx.accessStatus === "linked")
    ) {
      return [...ART_CATEGORIES];
    }
    // A plain signed-in Super Admin session outside Access still gets the card
    // workspace, but brand art stays on the Access-protected platform surface.
    return ["cards"];
  }
  if (user.globalCollectionScope) return ["cards"];
  if (["owner", "editor"].includes(user.role)) return ["cards"];
  return [];
}

function requireCategoryRead(ctx: Ctx, category: ArtCategory): CurrentUser {
  const allowed = allowedArtCategories(ctx);
  if (!allowed.includes(category)) {
    throw new ApiError(
      403,
      "art_read_forbidden",
      "Art Lab is an operator-only surface. Your role has no art category here.",
      { categories: allowed },
    );
  }
  return ctx.user!;
}

function requireCategoryWrite(ctx: Ctx, category: ArtCategory): CurrentUser {
  const user = requireUser(ctx);
  if (!allowedArtCategories(ctx).includes(category)) {
    throw new ApiError(
      403,
      "art_write_forbidden",
      "Art Lab is an operator-only surface. Your role has no art category here.",
    );
  }
  if (isBrandCategory(category)) {
    if (!user.platformAdmin || ctx.actor.type !== "user") {
      throw new ApiError(
        403,
        "art_brand_super_admin_required",
        "Brand art is restricted to the provisioned Super Admin.",
      );
    }
    if (
      ctx.config.environment !== "local" &&
      (!ctx.accessIdentity || ctx.accessStatus !== "linked")
    ) {
      throw new ApiError(
        403,
        "art_brand_access_required",
        "Brand art must be changed through the Cloudflare Access-protected platform surface.",
      );
    }
    return user;
  }
  if (ctx.actor.type === "agent") {
    requireScope(ctx, "content:write");
    if (!["owner", "editor"].includes(user.role)) {
      throw new ApiError(
        403,
        "art_write_forbidden",
        "The represented member cannot manage card art for this Bot.",
      );
    }
    return user;
  }
  if (user.platformAdmin || ["owner", "editor"].includes(user.role) || user.globalCollectionScope) {
    return user;
  }
  throw new ApiError(403, "art_write_forbidden", "Your role cannot manage card art here.");
}

async function loadCollection(ctx: Ctx, collectionId: string): Promise<CollectionRef> {
  const collection = await first<CollectionRef>(
    ctx.db,
    `SELECT id, slug, name, scope, owner_tenant_id, status, view_audience,
            logo_asset_id, banner_asset_id, logo_url, banner_url, accent, archived_at
       FROM fb_collections
      WHERE id = ? AND archived_at IS NULL`,
    collectionId,
  );
  if (!collection) {
    throw new ApiError(404, "art_collection_not_found", "That collection is not available.");
  }
  return collection;
}

async function requireCollectionManagement(ctx: Ctx, collectionId: string): Promise<CollectionRef> {
  const collection = await loadCollection(ctx, collectionId);
  const user = ctx.user;
  if (!user) throw new ApiError(401, "authentication_required", "Sign in to continue.");
  if (user.platformAdmin) return collection;
  if (collection.scope === "global") {
    if (!canManageGlobalCollection(ctx, collection.id)) {
      throw new ApiError(
        403,
        "art_collection_out_of_scope",
        "That shared collection is outside your delegated scope.",
      );
    }
    return collection;
  }
  if (collection.owner_tenant_id !== ctx.tenant.id) {
    throw new ApiError(404, "art_collection_not_found", "That collection is not available.");
  }
  if (!canRepresentedContent(ctx)) {
    throw new ApiError(403, "art_write_forbidden", "Your role cannot manage this Bot's card art.");
  }
  return collection;
}

async function loadCardRef(ctx: Ctx, cardId: string): Promise<CardRef> {
  const card = await first<CardRef>(
    ctx.db,
    `SELECT id, tenant_id, slug, name, subtitle, status, archived_at
       FROM fb_card_definitions
      WHERE id = ? AND archived_at IS NULL`,
    cardId,
  );
  if (!card) throw new ApiError(404, "art_card_not_found", "That subject is not available.");
  return card;
}

async function assertCardInCollection(
  ctx: Ctx,
  collection: CollectionRef,
  cardId: string,
): Promise<CardRef> {
  const card = await loadCardRef(ctx, cardId);
  const linked = await first<{ present: number }>(
    ctx.db,
    "SELECT 1 AS present FROM fb_collection_cards WHERE collection_id = ? AND card_id = ? LIMIT 1",
    collection.id,
    card.id,
  );
  if (!linked) {
    throw new ApiError(
      422,
      "art_card_not_in_collection",
      "Choose a subject that belongs to the selected collection.",
    );
  }
  if (
    card.tenant_id !== ctx.tenant.id &&
    !ctx.user?.platformAdmin &&
    card.tenant_id !== collection.owner_tenant_id
  ) {
    throw new ApiError(
      404,
      "art_card_not_found",
      "That subject is not available in this workspace.",
    );
  }
  return card;
}

function permissionsFor(ctx: Ctx, category: ArtCategory): ArtPermissions {
  const user = ctx.user;
  const allowed = user ? allowedArtCategories(ctx).includes(category) : false;
  const brand = isBrandCategory(category);
  return {
    read: allowed,
    write: allowed && (!brand || Boolean(user?.platformAdmin && ctx.actor.type === "user")),
    approve_public: Boolean(user?.platformAdmin),
    publish: allowed,
    publish_brand: Boolean(user?.platformAdmin && ctx.actor.type === "user"),
  };
}

async function loadBriefRow(ctx: Ctx, briefId: string): Promise<ArtBriefRow> {
  const brief = await first<ArtBriefRow>(
    ctx.db,
    "SELECT * FROM fb_art_briefs WHERE id = ? AND tenant_id = ?",
    briefId,
    ctx.tenant.id,
  );
  if (!brief) throw new ApiError(404, "art_brief_not_found", "That Art Lab brief does not exist.");
  return brief;
}

async function requireBriefRead(ctx: Ctx, brief: ArtBriefRow): Promise<void> {
  requireCategoryRead(ctx, brief.category);
  if (brief.category === "cards" && brief.collection_id) {
    const collection = await loadCollection(ctx, brief.collection_id);
    const user = ctx.user!;
    if (!user.platformAdmin) {
      if (collection.scope === "global") {
        if (!canManageGlobalCollection(ctx, collection.id)) {
          throw new ApiError(
            403,
            "art_collection_out_of_scope",
            "That shared collection is outside your delegated scope.",
          );
        }
      } else if (collection.owner_tenant_id !== ctx.tenant.id) {
        throw new ApiError(404, "art_brief_not_found", "That Art Lab brief does not exist.");
      }
    }
  }
}

async function requireBriefWrite(ctx: Ctx, brief: ArtBriefRow): Promise<void> {
  requireCategoryWrite(ctx, brief.category);
  if (brief.category === "cards" && brief.collection_id) {
    await requireCollectionManagement(ctx, brief.collection_id);
  }
}

/**
 * The runner is a scoped agent, not a human publisher. It may claim and upload
 * candidates for a brand brief only when it represents the provisioned Super
 * Admin. Approval, publish and rollback still use the human-only path above.
 */
async function requireBriefRunner(ctx: Ctx, brief: ArtBriefRow): Promise<void> {
  if (ctx.actor.type !== "agent") {
    throw new ApiError(403, "art_agent_runner_required", "Only the Art Lab runner can do that.");
  }
  requireScope(ctx, "content:write");
  const user = requireUser(ctx);
  if (!user.platformAdmin && !["owner", "editor"].includes(user.role)) {
    throw new ApiError(
      403,
      "art_runner_forbidden",
      "The represented member cannot run Art Lab generation here.",
    );
  }
  if (brief.category === "cards" && brief.collection_id) {
    await requireCollectionManagement(ctx, brief.collection_id);
  }
}

async function loadCandidateRow(ctx: Ctx, candidateId: string): Promise<ArtCandidateRow> {
  const candidate = await first<ArtCandidateRow>(
    ctx.db,
    "SELECT * FROM fb_art_candidates WHERE id = ? AND tenant_id = ?",
    candidateId,
    ctx.tenant.id,
  );
  if (!candidate) {
    throw new ApiError(404, "art_candidate_not_found", "That art candidate does not exist.");
  }
  return candidate;
}

async function loadJobRow(ctx: Ctx, jobId: string): Promise<ArtJobRow> {
  const job = await first<ArtJobRow>(
    ctx.db,
    "SELECT * FROM fb_art_jobs WHERE id = ? AND tenant_id = ?",
    jobId,
    ctx.tenant.id,
  );
  if (!job) throw new ApiError(404, "art_job_not_found", "That art generation job does not exist.");
  return job;
}

async function loadApproval(
  ctx: Ctx,
  candidateId: string,
  options?: { activeOnly?: boolean; includeRevoked?: boolean },
): Promise<ArtApprovalRow | null> {
  const clauses = ["tenant_id = ?", "candidate_id = ?"];
  const params: unknown[] = [ctx.tenant.id, candidateId];
  if (!options?.includeRevoked) clauses.push("revoked_at IS NULL");
  return first<ArtApprovalRow>(
    ctx.db,
    `SELECT * FROM fb_art_approvals
      WHERE ${clauses.join(" AND ")}
      ORDER BY approved_at DESC LIMIT 1`,
    ...params,
  );
}

function dailySpend(ctx: Ctx): Promise<{ cents: number }> {
  return first<{ cents: number }>(
    ctx.db,
    `SELECT COALESCE(SUM(
              CASE WHEN status = 'cancelled' THEN 0
                   WHEN cost_actual_cents IS NOT NULL THEN cost_actual_cents
                   ELSE cost_estimate_cents END
            ), 0) AS cents
       FROM fb_art_jobs
      WHERE tenant_id = ? AND substr(created_at, 1, 10) = ?`,
    ctx.tenant.id,
    nowIso().slice(0, 10),
  ).then((row) => ({ cents: Number(row?.cents ?? 0) }));
}

async function briefSpendCents(ctx: Ctx, briefId: string): Promise<number> {
  const row = await first<{ cents: number }>(
    ctx.db,
    `SELECT COALESCE(SUM(
              CASE WHEN status = 'cancelled' THEN 0
                   WHEN cost_actual_cents IS NOT NULL THEN cost_actual_cents
                   ELSE cost_estimate_cents END
            ), 0) AS cents
       FROM fb_art_jobs
      WHERE tenant_id = ? AND brief_id = ?`,
    ctx.tenant.id,
    briefId,
  );
  return Number(row?.cents ?? 0);
}

async function assertBudget(ctx: Ctx, brief: ArtBriefRow, additionalCents: number): Promise<void> {
  const [briefSpent, daily] = await Promise.all([briefSpendCents(ctx, brief.id), dailySpend(ctx)]);
  if (briefSpent + additionalCents > brief.cost_cap_cents) {
    throw new ApiError(
      409,
      "art_brief_budget_exceeded",
      `This brief has US$${(briefSpent / 100).toFixed(2)} of its US$${(brief.cost_cap_cents / 100).toFixed(2)} ceiling committed. Raise the brief ceiling or start a new brief.`,
      {
        brief_spent_cents: briefSpent,
        brief_cap_cents: brief.cost_cap_cents,
        requested_cents: additionalCents,
      },
    );
  }
  if (daily.cents + additionalCents > DAILY_CAP_CENTS) {
    throw new ApiError(
      409,
      "art_daily_budget_exceeded",
      `Today's Art Lab spend is US$${(daily.cents / 100).toFixed(2)} of the US$${(DAILY_CAP_CENTS / 100).toFixed(2)} daily ceiling. No provider call was queued.`,
      {
        daily_spent_cents: daily.cents,
        daily_cap_cents: DAILY_CAP_CENTS,
        requested_cents: additionalCents,
      },
    );
  }
}

function finishLabel(
  variant: { material_key?: string | null; effect_key?: string | null } | null,
): string {
  const material = variant?.material_key ?? "plain";
  if (
    material === "diamond" ||
    material === "holographic" ||
    variant?.effect_key === "holographic"
  ) {
    return "HOLOGRAPHIC";
  }
  return material.toUpperCase();
}

function exactCopyLines(input: {
  brief: ArtBriefRow;
  card: { name: string; subtitle: string | null; rarity_name: string | null } | null;
  collection: CollectionRef | null;
  variant: { material_key: string; effect_key: string | null } | null;
  catalogueCode: string | null;
}): string[] {
  const provenance =
    input.brief.audience === "public"
      ? "PUBLIC SHOWCASE · ORIGINAL FOILBURY PROJECT"
      : "MEMBER ARCHIVE · THIRD-PARTY ART · NOT OFFICIAL";
  return [
    `NAME: ${input.card?.name ?? input.brief.title}`,
    `ROLE: ${input.card?.subtitle ?? "Member subject"}`,
    `COLLECTION: ${input.collection?.name ?? "Foilbury"}`,
    `RARITY: ${(input.card?.rarity_name ?? "RARE").toUpperCase()}`,
    `FINISH: ${finishLabel(input.variant)}`,
    `PRINT CODE: ${input.catalogueCode ?? "FB-ART-001"}`,
    `PROVENANCE: ${provenance}`,
  ];
}

function promptForBrief(
  brief: ArtBriefRow,
  method: ArtMethod,
  card: { name: string; subtitle: string | null; rarity_name: string | null } | null,
  collection: CollectionRef | null,
  variant: { material_key: string; effect_key: string | null } | null,
  catalogueCode: string | null,
  styleKey: string | null,
): string {
  const references = parseJson<string[]>(brief.references_json, []);
  const referenceLine = references.length
    ? ` Additional references: ${references.join("; ")}.`
    : "";
  const copy = exactCopyLines({ brief, card, collection, variant, catalogueCode });
  const base = `${brief.title}. ${brief.intent.replace(/\.+$/, "")}. Audience: ${brief.audience}.${referenceLine}`;

  if (method === "whole_card") {
    return [
      base,
      stylePromptLine(styleKey ? [styleKey] : []),
      "Create one finished 5:7 collectible card object as a single image. It is a card, not a poster, not a mood board and not a character illustration with a caption.",
      "Use the attached prepared reference sheet as the source for the real subject art, the supplied collection mark and the exact copy. Do not reproduce the reference sheet layout; use its information to make the finished card.",
      `EXACT COPY — use these words exactly and add no other lettering:\n${copy.join("\n")}`,
      "The object must have a designed border or frame, a reserved information band and a clear hierarchy. The name and rarity must remain readable at 214 x 300 Discord inline size.",
      "Keep the subject's face, hair, outfit, props and silhouette consistent with the supplied source art. Reproduce only the supplied collection mark; do not invent a different official logo.",
      "No Japanese text, no gibberish, no fake serial numbers, no watermarks, no UI, no shop language and no casino language.",
    ].join("\n\n");
  }
  if (method === "composed_scene") {
    return [
      base,
      "Generate only the scene or key art plate behind the subject.",
      "No card frame, no border, no typography, no logos, no serials and no UI.",
      "Use a portrait composition with deliberate negative space for a subject cutout and a reserved lower information band.",
    ].join(" ");
  }
  if (method === "composed_texture") {
    return [
      base,
      "Generate only a background or material texture plate.",
      "No characters, no card frame, no typography, no logos, no serials and no UI.",
      "Use a restrained palette that supports a subject cutout and stays legible behind exact type.",
    ].join(" ");
  }
  return [
    base,
    `Generate a standalone ${ART_CATEGORY_LABELS[brief.category]} brand asset.`,
    "No text, no lettering, no logos, no official marks and no UI.",
    "Leave safe margins for type and layout that code will apply. Keep the composition useful at small sizes.",
  ].join(" ");
}

function splitCount(
  total: number,
  methods: ArtMethod[],
): Array<{ method: ArtMethod; count: number }> {
  const base = Math.floor(total / methods.length);
  let remainder = total % methods.length;
  return methods.map((method) => {
    const count = base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder -= 1;
    return { method, count };
  });
}

function splitAcross<T>(total: number, entries: T[]): Array<{ entry: T; count: number }> {
  if (!entries.length) return [];
  const base = Math.floor(total / entries.length);
  let remainder = total % entries.length;
  return entries.map((entry) => {
    const count = base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder -= 1;
    return { entry, count };
  });
}

export async function createArtBrief(
  ctx: Ctx,
  input: {
    category: string;
    collectionId?: string | null;
    cardId?: string | null;
    targetVariantId?: string | null;
    title: string;
    intent: string;
    references?: string[];
    audience?: "private" | "members" | "public";
    candidateCount?: number;
    provider?: string;
    model?: string;
    methods?: string[];
    styleKeys?: string[];
    outputSizes?: string[];
    notes?: string | null;
    costCapCents?: number;
  },
): Promise<ArtBriefDetail> {
  const category = normalizeArtCategory(input.category);
  const user = requireCategoryWrite(ctx, category);
  const title = cleanText(input.title, "title", 2, 160);
  const intent = cleanText(input.intent, "intent", 12, 4000);
  const provider = input.provider?.trim() || "openai";
  const model = input.model?.trim() || "gpt-image-2.6-sunburst";
  const methods = input.methods?.length
    ? input.methods
    : category === "cards"
      ? ["whole_card"]
      : ["raw_art"];
  const price = assertModelAndMethods(category, provider, model, methods);
  const audience = input.audience ?? (category === "cards" ? "members" : "private");
  if (!["private", "members", "public"].includes(audience)) {
    throw new ApiError(422, "art_audience_invalid", "Choose private, members or public audience.");
  }
  const candidateCount = input.candidateCount ?? 6;
  const minCount = category === "cards" ? 2 : 1;
  if (!Number.isInteger(candidateCount) || candidateCount < minCount || candidateCount > 8) {
    throw new ApiError(
      422,
      "art_candidate_count_invalid",
      `Choose between ${minCount} and 8 candidates. Four to eight is the useful review range.`,
    );
  }
  const costCapCents = input.costCapCents ?? DEFAULT_BRIEF_CAP_CENTS;
  if (!Number.isInteger(costCapCents) || costCapCents < 50 || costCapCents > MAX_BRIEF_CAP_CENTS) {
    throw new ApiError(
      422,
      "art_cost_cap_invalid",
      `The per-brief ceiling must be between US$0.50 and US$${(MAX_BRIEF_CAP_CENTS / 100).toFixed(2)}.`,
    );
  }
  if (costCapCents > DAILY_CAP_CENTS) {
    throw new ApiError(
      422,
      "art_cost_cap_invalid",
      `The per-brief ceiling cannot exceed the US$${(DAILY_CAP_CENTS / 100).toFixed(2)} daily ceiling.`,
    );
  }
  const brandSelections = category === "cards" ? await readBrandSelections(ctx) : null;
  const styleKeys =
    category === "cards"
      ? normalizeCardStyleKeys(
          input.styleKeys?.length ? input.styleKeys : [brandSelections?.card_style ?? "atelier"],
        )
      : [];
  if (category === "cards" && !styleKeys.length) {
    throw new ApiError(
      422,
      "art_style_required",
      "Choose at least one named card style for this brief.",
    );
  }
  const references = normalizeReferences(input.references);
  let collection: CollectionRef | null = null;
  let card: CardRef | null = null;
  let targetVariantId: string | null = null;

  if (category === "cards") {
    if (!input.collectionId) {
      throw new ApiError(
        422,
        "art_collection_required",
        "Choose the collection this card art belongs to.",
      );
    }
    if (!input.cardId) {
      throw new ApiError(422, "art_card_required", "Choose the subject this card art belongs to.");
    }
    collection = await requireCollectionManagement(ctx, input.collectionId);
    card = await assertCardInCollection(ctx, collection, input.cardId);
    if (input.targetVariantId) {
      const variant = await first<{ id: string; card_id: string }>(
        ctx.db,
        "SELECT id, card_id FROM fb_variants WHERE id = ? AND tenant_id = ? AND archived_at IS NULL",
        input.targetVariantId,
        ctx.tenant.id,
      );
      if (!variant || variant.card_id !== card.id) {
        throw new ApiError(
          422,
          "art_target_variant_invalid",
          "Choose a finish variant that belongs to the selected subject.",
        );
      }
      targetVariantId = variant.id;
    }
  }

  const id = newId("artb");
  const now = nowIso();
  const outputSizes = input.outputSizes?.length
    ? input.outputSizes
        .map((size) => size.trim())
        .filter(Boolean)
        .slice(0, 10)
    : category === "cards"
      ? ["1500x2100", "750x1050", "400x560", "128x179"]
      : ["master", "web"];

  await ctx.db.batch([
    statement(
      ctx.db,
      `INSERT INTO fb_art_briefs
        (id, tenant_id, category, collection_id, card_id, target_variant_id, title, intent,
         references_json, audience, status, candidate_count, provider, model, methods_json,
         style_keys_json, output_sizes_json, notes, cost_cap_cents, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      ctx.tenant.id,
      category,
      collection?.id ?? null,
      card?.id ?? null,
      targetVariantId,
      title,
      intent,
      JSON.stringify(references),
      audience,
      candidateCount,
      price.provider.provider,
      price.model.id,
      JSON.stringify(price.methods),
      JSON.stringify(styleKeys),
      JSON.stringify(outputSizes),
      optionalText(input.notes, 2000),
      costCapCents,
      user.id,
      now,
      now,
    ),
    auditStatement(ctx, "art.brief.created", "art_brief", id, {
      category,
      collection_id: collection?.id ?? null,
      card_id: card?.id ?? null,
      provider: price.provider.provider,
      model: price.model.id,
      methods: price.methods,
      style_keys: styleKeys,
      candidate_count: candidateCount,
      cost_cap_cents: costCapCents,
    }),
  ]);
  return getArtBrief(ctx, id);
}

function summaryFromRow(row: BriefSummaryRow): ArtBriefSummary {
  return {
    id: row.id,
    category: row.category,
    title: row.title,
    intent: row.intent,
    collection_id: row.collection_id,
    collection_name: row.collection_name,
    collection_slug: row.collection_slug,
    card_id: row.card_id,
    card_name: row.card_name,
    target_variant_id: row.target_variant_id,
    audience: row.audience,
    status: row.status,
    candidate_count: row.candidate_count,
    methods: parseJson<ArtMethod[]>(row.methods_json, ["whole_card"]),
    styles: parseJson<string[]>(row.style_keys_json, []),
    spend_cents: Number(row.spend_cents ?? 0),
    cost_cap_cents: row.cost_cap_cents,
    candidate_total: Number(row.candidate_total ?? 0),
    pending_count: Number(row.pending_count ?? 0),
    approved_count: Number(row.approved_count ?? 0),
    latest_job_status: row.latest_job_status,
    latest_error: row.latest_error,
    cover_candidate_id: row.cover_candidate_id,
    cover_url: row.cover_candidate_id
      ? `${artFileBase(row.category)}/candidates/${row.cover_candidate_id}/file?side=display`
      : null,
    cover_method: row.cover_method,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function listArtBriefs(
  ctx: Ctx,
  options?: { category?: string; limit?: number },
): Promise<{
  briefs: ArtBriefSummary[];
  pins: ArtPin[];
  categories: Array<{
    key: ArtCategory;
    label: string;
    brief_count: number;
    candidate_count: number;
    pending_count: number;
    spend_cents: number;
  }>;
  daily: { cap_cents: number; spent_cents: number; remaining_cents: number; day: string };
  permissions: ArtPermissions;
}> {
  const allowed = allowedArtCategories(ctx);
  if (!allowed.length) {
    throw new ApiError(403, "art_read_forbidden", "Art Lab is an operator-only surface.");
  }
  const category = options?.category ? normalizeArtCategory(options.category) : null;
  if (category && !allowed.includes(category)) {
    throw new ApiError(
      403,
      "art_read_forbidden",
      "That art category is not available to your role.",
    );
  }
  const where = ["b.tenant_id = ?", `b.category IN (${allowed.map(() => "?").join(",")})`];
  const params: unknown[] = [ctx.tenant.id, ...allowed];
  if (category) {
    where.push("b.category = ?");
    params.push(category);
  }
  if (
    ctx.user &&
    !ctx.user.platformAdmin &&
    ctx.user.globalCollectionScope &&
    !["owner", "editor"].includes(ctx.user.role)
  ) {
    const scope = ctx.user.globalCollectionScope;
    if (scope.all) {
      where.push(
        "b.collection_id IN (SELECT id FROM fb_collections WHERE scope = 'global' AND archived_at IS NULL)",
      );
    } else if (scope.collectionIds.length) {
      where.push(`b.collection_id IN (${scope.collectionIds.map(() => "?").join(",")})`);
      params.push(...scope.collectionIds);
    } else {
      where.push("0 = 1");
    }
  }
  const limit = Math.min(200, Math.max(1, options?.limit ?? 100));
  params.push(limit);
  const rows = await all<BriefSummaryRow>(
    ctx.db,
    `SELECT b.*,
            c.name AS collection_name, c.slug AS collection_slug,
            cd.name AS card_name,
            (SELECT COUNT(*) FROM fb_art_candidates k WHERE k.brief_id = b.id) AS candidate_total,
            (SELECT COUNT(*) FROM fb_art_candidates k WHERE k.brief_id = b.id AND k.status = 'generated') AS pending_count,
            (SELECT COUNT(*) FROM fb_art_candidates k WHERE k.brief_id = b.id AND k.status = 'approved') AS approved_count,
            (SELECT COALESCE(SUM(CASE WHEN j.status = 'cancelled' THEN 0
                                      WHEN j.cost_actual_cents IS NOT NULL THEN j.cost_actual_cents
                                      ELSE j.cost_estimate_cents END), 0)
               FROM fb_art_jobs j WHERE j.brief_id = b.id) AS spend_cents,
            (SELECT k.id FROM fb_art_candidates k WHERE k.brief_id = b.id ORDER BY k.created_at DESC LIMIT 1) AS cover_candidate_id,
            (SELECT k.method FROM fb_art_candidates k WHERE k.brief_id = b.id ORDER BY k.created_at DESC LIMIT 1) AS cover_method,
            (SELECT j.status FROM fb_art_jobs j WHERE j.brief_id = b.id ORDER BY j.created_at DESC LIMIT 1) AS latest_job_status,
            (SELECT j.error FROM fb_art_jobs j WHERE j.brief_id = b.id AND j.status = 'failed' ORDER BY j.created_at DESC LIMIT 1) AS latest_error
       FROM fb_art_briefs b
       LEFT JOIN fb_collections c ON c.id = b.collection_id
       LEFT JOIN fb_card_definitions cd ON cd.id = b.card_id
      WHERE ${where.join(" AND ")}
      ORDER BY b.updated_at DESC
      LIMIT ?`,
    ...params,
  );
  const briefs = rows.map(summaryFromRow);
  const pinRows = await all<{
    candidate_id: string;
    brief_id: string;
    brief_title: string;
    category: ArtCategory;
    collection_name: string | null;
    card_name: string | null;
    label: string;
    method: ArtMethod;
    style_key: string | null;
    status: CandidateStatus;
    width: number;
    height: number;
    audience: string;
    created_at: string;
  }>(
    ctx.db,
    `SELECT k.id AS candidate_id, k.brief_id, b.title AS brief_title, b.category,
            c.name AS collection_name, cd.name AS card_name, k.label, k.method, k.style_key, k.status,
            k.width, k.height, k.audience, k.created_at
       FROM fb_art_candidates k
       JOIN fb_art_briefs b ON b.id = k.brief_id
       LEFT JOIN fb_collections c ON c.id = b.collection_id
       LEFT JOIN fb_card_definitions cd ON cd.id = b.card_id
      WHERE ${where.join(" AND ")}
      ORDER BY k.created_at DESC
      LIMIT 120`,
    ...params.slice(0, -1),
  );
  const pins: ArtPin[] = pinRows.map((row) => ({
    ...row,
    image_url: `${artFileBase(row.category)}/candidates/${row.candidate_id}/file?side=display`,
  }));
  const categories = allowed.map((key) => {
    const matching = briefs.filter((brief) => brief.category === key);
    return {
      key,
      label: ART_CATEGORY_LABELS[key],
      brief_count: matching.length,
      candidate_count: matching.reduce((total, brief) => total + brief.candidate_total, 0),
      pending_count: matching.reduce((total, brief) => total + brief.pending_count, 0),
      spend_cents: matching.reduce((total, brief) => total + brief.spend_cents, 0),
    };
  });
  const daily = await dailySpend(ctx);
  return {
    briefs,
    pins,
    categories,
    daily: {
      cap_cents: DAILY_CAP_CENTS,
      spent_cents: daily.cents,
      remaining_cents: Math.max(0, DAILY_CAP_CENTS - daily.cents),
      day: nowIso().slice(0, 10),
    },
    permissions: {
      read: true,
      write: allowed.some((entry) => !isBrandCategory(entry))
        ? Boolean(
            ctx.user &&
            (ctx.user.platformAdmin ||
              canRepresentedContent(ctx) ||
              isGlobalCollectionAdmin(ctx.user)),
          )
        : Boolean(ctx.user?.platformAdmin),
      approve_public: Boolean(ctx.user?.platformAdmin),
      publish: true,
      publish_brand: Boolean(ctx.user?.platformAdmin && ctx.actor.type === "user"),
    },
  };
}

export async function artPendingReviewCount(ctx: Ctx): Promise<number> {
  const allowed = allowedArtCategories(ctx);
  if (!allowed.length) return 0;
  const where = [
    "k.tenant_id = ?",
    "k.status = 'generated'",
    `b.category IN (${allowed.map(() => "?").join(",")})`,
  ];
  const params: unknown[] = [ctx.tenant.id, ...allowed];
  if (
    ctx.user &&
    !ctx.user.platformAdmin &&
    ctx.user.globalCollectionScope &&
    !["owner", "editor"].includes(ctx.user.role)
  ) {
    const scope = ctx.user.globalCollectionScope;
    if (scope.all) {
      where.push(
        "b.collection_id IN (SELECT id FROM fb_collections WHERE scope = 'global' AND archived_at IS NULL)",
      );
    } else if (scope.collectionIds.length) {
      where.push(`b.collection_id IN (${scope.collectionIds.map(() => "?").join(",")})`);
      params.push(...scope.collectionIds);
    } else {
      return 0;
    }
  }
  const row = await first<{ count: number }>(
    ctx.db,
    `SELECT COUNT(*) AS count
       FROM fb_art_candidates k
       JOIN fb_art_briefs b ON b.id = k.brief_id
      WHERE ${where.join(" AND ")}`,
    ...params,
  );
  return Number(row?.count ?? 0);
}

function candidateView(
  candidate: ArtCandidateRow,
  assets: Map<string, AssetRow>,
  feedback: ArtFeedbackRow[],
  approval: ArtApprovalRow | null,
  basePath: string,
): ArtCandidateView {
  const displayAssetId = candidate.render_asset_id ?? candidate.asset_id;
  const displayAsset = assets.get(displayAssetId);
  const metadata = parseJson<Record<string, unknown>>(candidate.metadata_json, {});
  const referenceAssetId =
    typeof metadata.reference_asset_id === "string" ? metadata.reference_asset_id : null;
  const feedbackRows = feedback.map((row) => ({
    id: row.id,
    decision: row.decision,
    author_user_id: row.author_user_id,
    tags: parseJson<FeedbackTag[]>(row.tags_json, []),
    body: row.body,
    created_at: row.created_at,
  }));
  return {
    id: candidate.id,
    brief_id: candidate.brief_id,
    job_id: candidate.job_id,
    label: candidate.label,
    method: candidate.method,
    method_label: ART_METHOD_LABELS[candidate.method],
    method_note: ART_METHOD_NOTES[candidate.method],
    style_key: candidate.style_key,
    style_label: candidate.style_key
      ? (CARD_STYLE_LABEL[candidate.style_key] ?? candidate.style_key)
      : null,
    provider: candidate.provider,
    model: candidate.model,
    prompt: candidate.prompt,
    seed: candidate.seed,
    width: candidate.width,
    height: candidate.height,
    display_width: displayAsset?.width ?? candidate.width,
    display_height: displayAsset?.height ?? candidate.height,
    sha256: candidate.sha256,
    audience: candidate.audience,
    official: Boolean(candidate.official),
    status: candidate.status,
    asset_id: candidate.asset_id,
    render_asset_id: candidate.render_asset_id,
    render_back_asset_id: candidate.render_back_asset_id,
    master_asset_id: candidate.master_asset_id,
    preview_400_asset_id: candidate.preview_400_asset_id,
    thumb_128_asset_id: candidate.thumb_128_asset_id,
    display_side: candidate.render_asset_id ? "render" : "raw",
    metadata,
    files: {
      display: `${basePath}/candidates/${candidate.id}/file?side=display`,
      raw: `${basePath}/candidates/${candidate.id}/file?side=raw`,
      back: candidate.render_back_asset_id
        ? `${basePath}/candidates/${candidate.id}/file?side=back`
        : null,
      master: candidate.master_asset_id
        ? `${basePath}/candidates/${candidate.id}/file?side=master`
        : null,
      preview400: candidate.preview_400_asset_id
        ? `${basePath}/candidates/${candidate.id}/file?side=preview400`
        : null,
      thumb128: candidate.thumb_128_asset_id
        ? `${basePath}/candidates/${candidate.id}/file?side=thumb128`
        : null,
      reference: referenceAssetId
        ? `${basePath}/candidates/${candidate.id}/file?side=reference`
        : null,
      download: `${basePath}/candidates/${candidate.id}/file?side=display&download=1`,
    },
    feedback: feedbackRows,
    approval,
    created_at: candidate.created_at,
    updated_at: candidate.updated_at,
  };
}

export async function getArtBrief(ctx: Ctx, briefId: string): Promise<ArtBriefDetail> {
  const brief = await loadBriefRow(ctx, briefId);
  await requireBriefRead(ctx, brief);
  const collection = brief.collection_id ? await loadCollection(ctx, brief.collection_id) : null;
  const card = brief.card_id
    ? await first<{
        id: string;
        slug: string;
        name: string;
        subtitle: string | null;
        status: string;
        rarity_name: string | null;
      }>(
        ctx.db,
        `SELECT cd.id, cd.slug, cd.name, cd.subtitle, cd.status, r.name AS rarity_name
           FROM fb_card_definitions cd
           LEFT JOIN fb_rarities r ON r.id = cd.rarity_id AND r.tenant_id = cd.tenant_id
          WHERE cd.id = ? AND cd.archived_at IS NULL`,
        brief.card_id,
      )
    : null;
  const [jobs, candidateRows, feedbackRows, approvalRows] = await Promise.all([
    all<ArtJobRow>(
      ctx.db,
      "SELECT * FROM fb_art_jobs WHERE tenant_id = ? AND brief_id = ? ORDER BY created_at",
      ctx.tenant.id,
      brief.id,
    ),
    all<ArtCandidateRow>(
      ctx.db,
      "SELECT * FROM fb_art_candidates WHERE tenant_id = ? AND brief_id = ? ORDER BY created_at",
      ctx.tenant.id,
      brief.id,
    ),
    all<ArtFeedbackRow>(
      ctx.db,
      `SELECT f.* FROM fb_art_feedback f
         JOIN fb_art_candidates c ON c.id = f.candidate_id AND c.tenant_id = f.tenant_id
        WHERE f.tenant_id = ? AND c.brief_id = ?
        ORDER BY f.created_at`,
      ctx.tenant.id,
      brief.id,
    ),
    all<ArtApprovalRow>(
      ctx.db,
      "SELECT * FROM fb_art_approvals WHERE tenant_id = ? AND brief_id = ? ORDER BY approved_at",
      ctx.tenant.id,
      brief.id,
    ),
  ]);
  const assetIds = new Set<string>();
  for (const candidate of candidateRows) {
    for (const id of [
      candidate.asset_id,
      candidate.render_asset_id,
      candidate.render_back_asset_id,
      candidate.master_asset_id,
      candidate.preview_400_asset_id,
      candidate.thumb_128_asset_id,
    ]) {
      if (id) assetIds.add(id);
    }
  }
  const assetRows = assetIds.size
    ? await all<AssetRow>(
        ctx.db,
        `SELECT * FROM fb_assets WHERE tenant_id = ? AND id IN (${[...assetIds].map(() => "?").join(",")})`,
        ctx.tenant.id,
        ...[...assetIds],
      )
    : [];
  const assetMap = new Map(assetRows.map((asset) => [asset.id, asset]));
  const feedbackByCandidate = new Map<string, ArtFeedbackRow[]>();
  for (const row of feedbackRows) {
    const list = feedbackByCandidate.get(row.candidate_id) ?? [];
    list.push(row);
    feedbackByCandidate.set(row.candidate_id, list);
  }
  const approvalByCandidate = new Map<string, ArtApprovalRow>();
  for (const row of approvalRows) {
    if (row.revoked_at) continue;
    approvalByCandidate.set(row.candidate_id, row);
  }
  const basePath = artFileBase(brief.category);
  const candidates = candidateRows.map((candidate) =>
    candidateView(
      candidate,
      assetMap,
      feedbackByCandidate.get(candidate.id) ?? [],
      approvalByCandidate.get(candidate.id) ?? null,
      basePath,
    ),
  );
  const targetVariant = brief.target_variant_id
    ? await first<{
        id: string;
        name: string;
        material_key: string;
        effect_key: string | null;
        edition_id: string;
      }>(
        ctx.db,
        `SELECT v.id, v.name, m.key AS material_key, e.key AS effect_key, v.edition_id
           FROM fb_variants v
           JOIN fb_materials m ON m.id = v.material_id
           LEFT JOIN fb_effects e ON e.id = v.effect_id
          WHERE v.id = ? AND v.tenant_id = ?`,
        brief.target_variant_id,
        ctx.tenant.id,
      )
    : null;
  const currentRender = targetVariant
    ? await first<{
        asset_id: string;
        public_url: string;
        width: number;
        height: number;
        sha256: string;
        published_at: string | null;
        back_asset_id: string | null;
        back_sha256: string | null;
      }>(
        ctx.db,
        `SELECT r.asset_id, r.public_url, r.width, r.height, r.sha256, r.published_at,
                b.asset_id AS back_asset_id, b.sha256 AS back_sha256
           FROM fb_variant_renders r
           LEFT JOIN fb_variant_back_renders b
             ON b.id = (
               SELECT b2.id FROM fb_variant_back_renders b2
                WHERE b2.tenant_id = r.tenant_id AND b2.variant_id = r.variant_id
                  AND b2.status = 'published'
                ORDER BY b2.published_at DESC LIMIT 1
             )
          WHERE r.tenant_id = ? AND r.variant_id = ? AND r.status = 'published'
          ORDER BY r.published_at DESC LIMIT 1`,
        ctx.tenant.id,
        targetVariant.id,
      )
    : null;
  const spend = await briefSpendCents(ctx, brief.id);
  const pending = candidates.filter((candidate) => candidate.status === "generated").length;
  const cover = candidates.at(-1) ?? null;
  const price = findModelPrice(brief.provider, brief.model);
  const summary: ArtBriefSummary = {
    id: brief.id,
    category: brief.category,
    title: brief.title,
    intent: brief.intent,
    collection_id: brief.collection_id,
    collection_name: collection?.name ?? null,
    collection_slug: collection?.slug ?? null,
    card_id: brief.card_id,
    card_name: card?.name ?? null,
    target_variant_id: brief.target_variant_id,
    audience: brief.audience,
    status: brief.status,
    candidate_count: brief.candidate_count,
    methods: parseJson<ArtMethod[]>(brief.methods_json, ["whole_card"]),
    styles: parseJson<string[]>(brief.style_keys_json, []),
    spend_cents: spend,
    cost_cap_cents: brief.cost_cap_cents,
    candidate_total: candidates.length,
    pending_count: pending,
    approved_count: candidates.filter((candidate) => candidate.status === "approved").length,
    latest_job_status: jobs.at(-1)?.status ?? null,
    latest_error: [...jobs].reverse().find((job) => job.status === "failed")?.error ?? null,
    cover_candidate_id: cover?.id ?? null,
    cover_url: cover
      ? `${artFileBase(brief.category)}/candidates/${cover.id}/file?side=display`
      : null,
    cover_method: cover?.method ?? null,
    created_at: brief.created_at,
    updated_at: brief.updated_at,
  };
  return {
    brief: {
      ...summary,
      references: parseJson<string[]>(brief.references_json, []),
      output_sizes: parseJson<string[]>(brief.output_sizes_json, []),
      notes: brief.notes,
      provider: brief.provider,
      model: brief.model,
      style_keys: parseJson<string[]>(brief.style_keys_json, []),
      created_by: brief.created_by,
    },
    collection: collection
      ? {
          id: collection.id,
          slug: collection.slug,
          name: collection.name,
          scope: collection.scope,
          view_audience: collection.view_audience,
          logo_url: collection.logo_url,
          banner_url: collection.banner_url,
        }
      : null,
    card: card ? { ...card, collection_name: collection?.name ?? null } : null,
    target_variant: targetVariant,
    jobs,
    candidates,
    current_render: currentRender,
    permissions: permissionsFor(ctx, brief.category),
    price: price
      ? {
          provider: price.provider.provider,
          model: price.model.id,
          unit_cents: price.model.unitCents,
          note: price.model.priceNote,
        }
      : null,
  };
}

export async function listArtOptions(ctx: Ctx): Promise<{
  categories: ArtCategory[];
  category_labels: Record<string, string>;
  providers: ArtProviderPrice[];
  methods: Array<{ key: ArtMethod; label: string; note: string }>;
  collections: CollectionSummary[];
  cards: CardView[];
  daily_cap_cents: number;
  default_cap_cents: number;
  max_cap_cents: number;
  tags: FeedbackTag[];
  styles: Array<{ key: CardStyleKey; label: string; note: string; prompt: string; thumb: string }>;
  default_style: string;
}> {
  const allowed = allowedArtCategories(ctx);
  if (!allowed.length) throw new ApiError(403, "art_read_forbidden", "Art Lab is operator-only.");
  const collections = allowed.includes("cards")
    ? (await listCollections(ctx, { includeAll: true })).filter(
        (collection) => collection.manageable,
      )
    : [];
  const manageableIds = new Set(collections.map((collection) => collection.id));
  const cards = allowed.includes("cards")
    ? (
        await listCards(ctx, {
          includeDrafts: true,
          viewerScope: false,
          limit: 200,
        })
      ).filter((card) => card.collections.some((collection) => manageableIds.has(collection.id)))
    : [];
  const brandSelections = await readBrandSelections(ctx);
  const defaultStyle = normalizeCardStyleKeys([brandSelections.card_style])[0] ?? "atelier";
  return {
    categories: allowed,
    category_labels: ART_CATEGORY_LABELS,
    providers: ART_PRICE_TABLE,
    methods: ART_METHODS.filter((method) =>
      allowed.includes("cards") ? true : method === "raw_art",
    ).map((key) => ({ key, label: ART_METHOD_LABELS[key], note: ART_METHOD_NOTES[key] })),
    collections,
    cards,
    daily_cap_cents: DAILY_CAP_CENTS,
    default_cap_cents: DEFAULT_BRIEF_CAP_CENTS,
    max_cap_cents: MAX_BRIEF_CAP_CENTS,
    tags: [...FEEDBACK_TAGS],
    styles: CARD_STYLE_KEYS.map((key) => {
      const style = CARD_STYLES.find((entry) => entry.key === key)!;
      return { ...style };
    }),
    default_style: defaultStyle,
  };
}

export async function queueArtGeneration(
  ctx: Ctx,
  briefId: string,
  input?: { methods?: string[]; candidateCount?: number },
): Promise<{ brief: ArtBriefDetail; jobs: ArtJobRow[] }> {
  const brief = await loadBriefRow(ctx, briefId);
  await requireBriefWrite(ctx, brief);
  const active = await first<{ count: number }>(
    ctx.db,
    `SELECT COUNT(*) AS count FROM fb_art_jobs
      WHERE tenant_id = ? AND brief_id = ? AND status IN ('queued','running')`,
    ctx.tenant.id,
    brief.id,
  );
  if (Number(active?.count ?? 0) > 0) {
    throw new ApiError(
      409,
      "art_job_in_progress",
      "A generation job for this brief is already queued or running. Wait for it to finish.",
    );
  }
  const methods = input?.methods?.length
    ? input.methods
    : parseJson<string[]>(brief.methods_json, ["whole_card"]);
  const price = assertModelAndMethods(brief.category, brief.provider, brief.model, methods);
  const count = input?.candidateCount ?? brief.candidate_count;
  if (!Number.isInteger(count) || count < 1 || count > 8) {
    throw new ApiError(422, "art_candidate_count_invalid", "Choose between 1 and 8 candidates.");
  }
  const styleKeys =
    brief.category === "cards"
      ? normalizeCardStyleKeys(parseJson<string[]>(brief.style_keys_json, []))
      : [];
  const effectiveStyles = styleKeys.length ? styleKeys : [null];
  const distribution: Array<{ method: ArtMethod; styleKey: string | null; count: number }> = [];
  for (const entry of splitCount(count, price.methods).filter((item) => item.count > 0)) {
    const perStyle = splitAcross(entry.count, effectiveStyles);
    for (const slice of perStyle) {
      if (slice.count > 0) {
        distribution.push({ method: entry.method, styleKey: slice.entry, count: slice.count });
      }
    }
  }
  const totalEstimate = distribution.reduce(
    (total, entry) => total + entry.count * price.model.unitCents,
    0,
  );
  await assertBudget(ctx, brief, totalEstimate);
  const card = brief.card_id
    ? await first<{ name: string; subtitle: string | null; rarity_name: string | null }>(
        ctx.db,
        `SELECT cd.name, cd.subtitle, r.name AS rarity_name
           FROM fb_card_definitions cd
           LEFT JOIN fb_rarities r ON r.id = cd.rarity_id AND r.tenant_id = cd.tenant_id
          WHERE cd.id = ? AND cd.archived_at IS NULL`,
        brief.card_id,
      )
    : null;
  const collection = brief.collection_id ? await loadCollection(ctx, brief.collection_id) : null;
  const targetVariant = brief.target_variant_id
    ? await first<{ material_key: string; effect_key: string | null }>(
        ctx.db,
        `SELECT m.key AS material_key, e.key AS effect_key
           FROM fb_variants v
           JOIN fb_materials m ON m.id = v.material_id
           LEFT JOIN fb_effects e ON e.id = v.effect_id
          WHERE v.id = ? AND v.tenant_id = ?`,
        brief.target_variant_id,
        ctx.tenant.id,
      )
    : null;
  const catalogueCode =
    brief.category === "cards" && brief.collection_id && brief.card_id
      ? await catalogueCodeFor(ctx, brief.collection_id, brief.card_id)
      : null;
  const now = nowIso();
  const statements = [];
  const created: string[] = [];
  for (const entry of distribution) {
    const id = newId("artj");
    created.push(id);
    const prompt = promptForBrief(
      brief,
      entry.method,
      card,
      collection,
      targetVariant,
      catalogueCode,
      entry.styleKey,
    );
    statements.push(
      statement(
        ctx.db,
        `INSERT INTO fb_art_jobs
          (id, tenant_id, brief_id, method, style_key, provider, model, prompt, count, size, status,
           cost_estimate_cents, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
        id,
        ctx.tenant.id,
        brief.id,
        entry.method,
        entry.styleKey,
        brief.provider,
        brief.model,
        prompt,
        entry.count,
        brief.category === "cards" ? "5:7" : brief.category,
        entry.count * price.model.unitCents,
        ctx.user!.id,
        now,
        now,
      ),
    );
  }
  statements.push(
    statement(
      ctx.db,
      "UPDATE fb_art_briefs SET status = 'generating', updated_at = ? WHERE id = ? AND tenant_id = ?",
      now,
      brief.id,
      ctx.tenant.id,
    ),
    auditStatement(ctx, "art.job.queued", "art_brief", brief.id, {
      jobs: created,
      methods: distribution,
      estimated_cents: totalEstimate,
      provider: brief.provider,
      model: brief.model,
    }),
  );
  await ctx.db.batch(statements);
  const jobs = await all<ArtJobRow>(
    ctx.db,
    `SELECT * FROM fb_art_jobs WHERE tenant_id = ? AND brief_id = ? AND id IN (${created.map(() => "?").join(",")}) ORDER BY created_at`,
    ctx.tenant.id,
    brief.id,
    ...created,
  );
  return { brief: await getArtBrief(ctx, brief.id), jobs };
}

async function catalogueCodeFor(ctx: Ctx, collectionId: string, cardId: string): Promise<string> {
  const collection = await loadCollection(ctx, collectionId);
  const rows = await all<{ card_id: string }>(
    ctx.db,
    `SELECT cc.card_id
       FROM fb_collection_cards cc
       JOIN fb_card_definitions cd ON cd.id = cc.card_id
      WHERE cc.collection_id = ? AND cd.archived_at IS NULL
      ORDER BY cc.sort, cd.name`,
    collectionId,
  );
  const index = rows.findIndex((row) => row.card_id === cardId);
  const prefix = slugPrefix(collection.slug) || "FB";
  return `FB-${prefix}-${String(Math.max(1, index + 1)).padStart(3, "0")}`;
}

export async function claimArtJob(
  ctx: Ctx,
  options?: { jobId?: string },
): Promise<Record<string, unknown> | null> {
  if (ctx.actor.type !== "agent") {
    throw new ApiError(
      403,
      "art_agent_runner_required",
      "Generation jobs are claimed by the local Art Lab runner using a scoped agent grant.",
    );
  }
  requireScope(ctx, "content:write");
  const now = nowIso();
  let job: ArtJobRow | null = null;
  if (options?.jobId) {
    job = await first<ArtJobRow>(
      ctx.db,
      `UPDATE fb_art_jobs
          SET status = 'running', claimed_by = ?, claimed_at = ?, started_at = COALESCE(started_at, ?), updated_at = ?
        WHERE id = ? AND tenant_id = ? AND status = 'queued'
        RETURNING *`,
      ctx.actor.id,
      now,
      now,
      now,
      options.jobId,
      ctx.tenant.id,
    );
  } else {
    const candidate = await first<ArtJobRow>(
      ctx.db,
      `SELECT * FROM fb_art_jobs
        WHERE tenant_id = ? AND status = 'queued'
        ORDER BY created_at LIMIT 1`,
      ctx.tenant.id,
    );
    if (candidate) {
      job = await first<ArtJobRow>(
        ctx.db,
        `UPDATE fb_art_jobs
            SET status = 'running', claimed_by = ?, claimed_at = ?, started_at = COALESCE(started_at, ?), updated_at = ?
          WHERE id = ? AND tenant_id = ? AND status = 'queued'
          RETURNING *`,
        ctx.actor.id,
        now,
        now,
        now,
        candidate.id,
        ctx.tenant.id,
      );
    }
  }
  if (!job) return null;
  const brief = await loadBriefRow(ctx, job.brief_id);
  await requireBriefRunner(ctx, brief);
  const card = brief.card_id
    ? await first<CardView | null>(
        ctx.db,
        "SELECT * FROM fb_card_definitions WHERE id = ? AND archived_at IS NULL",
        brief.card_id,
      )
    : null;
  const collection = brief.collection_id ? await loadCollection(ctx, brief.collection_id) : null;
  let fullCard: CardView | null = null;
  let targetVariant: VariantRow | null = null;
  let edition: EditionRow | null = null;
  if (card && collection) {
    const cards = await listCards(ctx, {
      id: card.id,
      includeDrafts: true,
      viewerScope: false,
      limit: 1,
    });
    fullCard = cards[0] ?? null;
    if (fullCard) {
      if (brief.target_variant_id) {
        for (const candidateEdition of fullCard.editions) {
          const match = candidateEdition.variants.find(
            (variant) => variant.id === brief.target_variant_id,
          );
          if (match) {
            targetVariant = match;
            edition = candidateEdition;
            break;
          }
        }
      }
      if (!targetVariant) {
        for (const candidateEdition of fullCard.editions) {
          const published = candidateEdition.variants.find(
            (variant) => variant.status === "published",
          );
          if (published) {
            targetVariant = published;
            edition = candidateEdition;
            break;
          }
        }
      }
    }
  }
  const catalogueCode =
    fullCard && collection ? await catalogueCodeFor(ctx, collection.id, fullCard.id) : null;
  const price = findModelPrice(job.provider, job.model);
  await auditStatement(ctx, "art.job.claimed", "art_job", job.id, {
    brief_id: brief.id,
    method: job.method,
    count: job.count,
  }).run();
  return {
    job,
    brief: {
      ...brief,
      references: parseJson<string[]>(brief.references_json, []),
      methods: parseJson<ArtMethod[]>(brief.methods_json, ["whole_card"]),
      output_sizes: parseJson<string[]>(brief.output_sizes_json, []),
    },
    collection,
    card: fullCard,
    edition,
    variant: targetVariant,
    catalogue_code: catalogueCode,
    current_render_url: targetVariant?.render_url ?? null,
    current_back_render_url: targetVariant?.back_render_url ?? null,
    source_assets: {
      subject_asset_id: edition?.subject_asset_id ?? null,
      background_asset_id: edition?.background_asset_id ?? null,
      logo_asset_id: collection?.logo_asset_id ?? null,
      banner_asset_id: collection?.banner_asset_id ?? null,
    },
    price: price
      ? {
          provider: price.provider.provider,
          model: price.model.id,
          unit_cents: price.model.unitCents,
          note: price.model.priceNote,
          supports_reference: price.model.supportsReference ?? false,
          reference_param: price.model.referenceParam ?? null,
        }
      : null,
  };
}

export async function addArtCandidate(
  ctx: Ctx,
  jobId: string,
  form: FormData,
): Promise<ArtCandidateView> {
  if (ctx.actor.type !== "agent") {
    throw new ApiError(
      403,
      "art_agent_runner_required",
      "Only the Art Lab runner can add candidates.",
    );
  }
  requireScope(ctx, "content:write");
  const job = await loadJobRow(ctx, jobId);
  if (job.status !== "running" || job.claimed_by !== ctx.actor.id) {
    throw new ApiError(
      409,
      "art_job_not_claimed",
      "This job is not running under this runner. Claim it before uploading candidates.",
    );
  }
  const brief = await loadBriefRow(ctx, job.brief_id);
  await requireBriefRunner(ctx, brief);
  const rawFile = form.get("raw");
  const frontFile = form.get("front");
  const backFile = form.get("back");
  const masterFile = form.get("master");
  const preview400File = form.get("preview400");
  const thumb128File = form.get("thumb128");
  const referenceFile = form.get("reference");
  if (!(rawFile instanceof File)) {
    throw new ApiError(422, "art_raw_required", "Upload the generated raw image.");
  }
  const seed = String(form.get("seed") ?? "").trim() || null;
  const label = (
    String(form.get("label") ?? "").trim() || (await nextCandidateLabel(ctx, brief.id))
  ).slice(0, 60);
  const prompt = String(form.get("prompt") ?? job.prompt).slice(0, 12000);
  const method = job.method;
  const isComposed = method === "composed_scene" || method === "composed_texture";
  if (isComposed && !(frontFile instanceof File)) {
    throw new ApiError(
      422,
      "art_front_required",
      "A composed candidate needs the rendered card front. Upload it with the job result.",
    );
  }
  const provenanceBase = {
    art_lab: true,
    brief_id: brief.id,
    job_id: job.id,
    method,
    provider: job.provider,
    model: job.model,
    prompt,
    seed,
    audience: brief.audience,
    official: false,
    generated_at: nowIso(),
    note:
      method === "whole_card"
        ? "Whole-card AI generation. Lettering and marks are model-authored and must be reviewed at real sizes."
        : "Provider art plate; card composition performed by art/card-render.mjs where present.",
  };
  const uploads: Record<string, AssetRow | null> = {
    raw: null,
    front: null,
    back: null,
    master: null,
    preview400: null,
    thumb128: null,
    reference: null,
  };
  const uploadOne = async (
    file: FormDataEntryValue | null,
    kind: AssetKind,
    role: string,
  ): Promise<AssetRow | null> => {
    if (!(file instanceof File)) return null;
    return uploadAsset(ctx, {
      kind,
      name: `Art Lab · ${brief.title} · ${label} · ${role}`,
      bytes: new Uint8Array(await file.arrayBuffer()),
      declaredMime: file.type || undefined,
      visibility: "private",
      accessClassification: "private",
      role,
      official: false,
      reviewStatus: "unreviewed",
      provenance: provenanceBase,
      dedupe: false,
    });
  };
  uploads.raw = await uploadOne(rawFile, method === "raw_art" ? "brand" : "background", "raw");
  uploads.front = await uploadOne(frontFile, "render", "front");
  uploads.back = await uploadOne(backFile, "render", "back");
  uploads.master = await uploadOne(masterFile, "render", "master");
  uploads.preview400 = await uploadOne(preview400File, "render", "preview-400");
  uploads.thumb128 = await uploadOne(thumb128File, "render", "thumb-128");
  uploads.reference = await uploadOne(referenceFile, "render", "reference");
  const raw = uploads.raw;
  if (!raw) throw new ApiError(422, "art_raw_required", "Upload the generated raw image.");
  const display = uploads.front ?? raw;
  if (brief.category === "cards") {
    const aspect = display.width && display.height ? display.width / display.height : 0;
    if (Math.abs(aspect - 5 / 7) > 0.02) {
      throw new ApiError(
        422,
        "art_card_aspect_invalid",
        "A card candidate must be a 5:7 object. Resize or crop it to 750x1050 before uploading.",
        { width: display.width, height: display.height },
      );
    }
  }
  const id = newId("artc");
  const now = nowIso();
  const metadata = {
    provider: job.provider,
    model: job.model,
    method,
    style_key: job.style_key,
    label,
    seed,
    prompt,
    raw_asset_id: raw.id,
    front_asset_id: display.id,
    back_asset_id: uploads.back?.id ?? null,
    master_asset_id: uploads.master?.id ?? null,
    preview_400_asset_id: uploads.preview400?.id ?? null,
    thumb_128_asset_id: uploads.thumb128?.id ?? null,
    reference_asset_id: uploads.reference?.id ?? null,
    references: parseJson<string[]>(brief.references_json, []),
    audience: brief.audience,
    official: false,
    cost_estimate_cents: job.cost_estimate_cents,
    fixture: String(form.get("fixture") ?? "") === "1",
  };
  await ctx.db.batch([
    statement(
      ctx.db,
      `INSERT INTO fb_art_candidates
        (id, tenant_id, brief_id, job_id, asset_id, render_asset_id, render_back_asset_id,
         master_asset_id, preview_400_asset_id, thumb_128_asset_id, label, method, style_key,
         provider, model, prompt, seed, width, height, sha256, audience, official, status,
         metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'generated', ?, ?, ?)`,
      id,
      ctx.tenant.id,
      brief.id,
      job.id,
      raw.id,
      method === "raw_art" ? null : display.id,
      uploads.back?.id ?? null,
      uploads.master?.id ?? null,
      uploads.preview400?.id ?? null,
      uploads.thumb128?.id ?? null,
      label,
      method,
      job.style_key,
      job.provider,
      job.model,
      prompt,
      seed,
      display.width ?? 0,
      display.height ?? 0,
      display.sha256,
      brief.audience,
      JSON.stringify(metadata),
      now,
      now,
    ),
    auditStatement(ctx, "art.candidate.added", "art_candidate", id, {
      brief_id: brief.id,
      job_id: job.id,
      method,
      style_key: job.style_key,
      label,
      width: display.width,
      height: display.height,
      sha256: display.sha256,
    }),
  ]);
  const row = await loadCandidateRow(ctx, id);
  const assets = new Map(
    [
      raw,
      display,
      uploads.back,
      uploads.master,
      uploads.preview400,
      uploads.thumb128,
      uploads.reference,
    ]
      .filter((asset): asset is AssetRow => Boolean(asset))
      .map((asset) => [asset.id, asset]),
  );
  return candidateView(row, assets, [], null, artFileBase(brief.category));
}

async function nextCandidateLabel(ctx: Ctx, briefId: string): Promise<string> {
  const row = await first<{ count: number }>(
    ctx.db,
    "SELECT COUNT(*) AS count FROM fb_art_candidates WHERE tenant_id = ? AND brief_id = ?",
    ctx.tenant.id,
    briefId,
  );
  return `Candidate ${Number(row?.count ?? 0) + 1}`;
}

export async function completeArtJob(
  ctx: Ctx,
  jobId: string,
  input: { actualCostCents?: number; costSource?: string; note?: string },
): Promise<ArtJobRow> {
  if (ctx.actor.type !== "agent") {
    throw new ApiError(
      403,
      "art_agent_runner_required",
      "Only the Art Lab runner can complete a job.",
    );
  }
  requireScope(ctx, "content:write");
  const job = await loadJobRow(ctx, jobId);
  if (job.status !== "running" || job.claimed_by !== ctx.actor.id) {
    throw new ApiError(409, "art_job_not_claimed", "This job is not running under this runner.");
  }
  const count = await first<{ count: number }>(
    ctx.db,
    "SELECT COUNT(*) AS count FROM fb_art_candidates WHERE tenant_id = ? AND job_id = ?",
    ctx.tenant.id,
    job.id,
  );
  if (Number(count?.count ?? 0) === 0) {
    throw new ApiError(
      409,
      "art_job_empty",
      "The job produced no candidates. Mark it failed with the provider reason instead.",
    );
  }
  const actual =
    input.actualCostCents === undefined
      ? job.cost_estimate_cents
      : Math.max(0, Math.floor(input.actualCostCents));
  if (actual > Math.max(job.cost_estimate_cents * 4, DAILY_CAP_CENTS)) {
    throw new ApiError(
      422,
      "art_cost_actual_invalid",
      "The reported actual cost is implausibly high. Record the real provider spend only.",
    );
  }
  const now = nowIso();
  await ctx.db.batch([
    statement(
      ctx.db,
      `UPDATE fb_art_jobs
          SET status = 'succeeded', cost_actual_cents = ?, cost_source = ?, finished_at = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ? AND status = 'running'`,
      actual,
      input.costSource ?? (input.actualCostCents === undefined ? "estimated" : "provider_reported"),
      now,
      now,
      job.id,
      ctx.tenant.id,
    ),
    statement(
      ctx.db,
      "UPDATE fb_art_briefs SET status = 'review', updated_at = ? WHERE id = ? AND tenant_id = ?",
      now,
      job.brief_id,
      ctx.tenant.id,
    ),
    auditStatement(ctx, "art.job.completed", "art_job", job.id, {
      brief_id: job.brief_id,
      actual_cost_cents: actual,
      cost_source: input.costSource ?? "estimated",
      note: optionalText(input.note, 1000),
    }),
  ]);
  return loadJobRow(ctx, job.id);
}

export async function failArtJob(
  ctx: Ctx,
  jobId: string,
  input: { message: string; actualCostCents?: number },
): Promise<ArtJobRow> {
  if (ctx.actor.type !== "agent") {
    throw new ApiError(403, "art_agent_runner_required", "Only the Art Lab runner can fail a job.");
  }
  requireScope(ctx, "content:write");
  const job = await loadJobRow(ctx, jobId);
  if (job.status !== "running" || job.claimed_by !== ctx.actor.id) {
    throw new ApiError(409, "art_job_not_claimed", "This job is not running under this runner.");
  }
  const message = cleanText(input.message, "job_error", 3, 2000);
  const actual =
    input.actualCostCents === undefined
      ? job.cost_estimate_cents
      : Math.max(0, Math.floor(input.actualCostCents));
  const now = nowIso();
  const candidates = await first<{ count: number }>(
    ctx.db,
    "SELECT COUNT(*) AS count FROM fb_art_candidates WHERE tenant_id = ? AND job_id = ?",
    ctx.tenant.id,
    job.id,
  );
  const hasCandidates = Number(candidates?.count ?? 0) > 0;
  await ctx.db.batch([
    statement(
      ctx.db,
      `UPDATE fb_art_jobs
          SET status = 'failed', error = ?, cost_actual_cents = ?, cost_source = 'runner_recorded',
              finished_at = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ? AND status = 'running'`,
      message,
      actual,
      now,
      now,
      job.id,
      ctx.tenant.id,
    ),
    statement(
      ctx.db,
      `UPDATE fb_art_briefs SET status = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`,
      hasCandidates ? "review" : "draft",
      now,
      job.brief_id,
      ctx.tenant.id,
    ),
    auditStatement(ctx, "art.job.failed", "art_job", job.id, {
      brief_id: job.brief_id,
      message,
      actual_cost_cents: actual,
    }),
  ]);
  return loadJobRow(ctx, job.id);
}

export async function cancelArtJob(ctx: Ctx, jobId: string): Promise<ArtJobRow> {
  const job = await loadJobRow(ctx, jobId);
  const brief = await loadBriefRow(ctx, job.brief_id);
  await requireBriefWrite(ctx, brief);
  if (!["queued", "running"].includes(job.status)) {
    throw new ApiError(409, "art_job_not_cancellable", `A ${job.status} job cannot be cancelled.`);
  }
  const candidates = await first<{ count: number }>(
    ctx.db,
    "SELECT COUNT(*) AS count FROM fb_art_candidates WHERE tenant_id = ? AND job_id = ?",
    ctx.tenant.id,
    job.id,
  );
  const actual = job.status === "running" ? (job.cost_actual_cents ?? job.cost_estimate_cents) : 0;
  const now = nowIso();
  await ctx.db.batch([
    statement(
      ctx.db,
      `UPDATE fb_art_jobs
          SET status = 'failed', error = ?, cost_actual_cents = ?, cost_source = 'estimated',
              finished_at = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ? AND status IN ('queued','running')`,
      "Cancelled by the operator before completion. No provider result was accepted.",
      actual,
      now,
      now,
      job.id,
      ctx.tenant.id,
    ),
    statement(
      ctx.db,
      `UPDATE fb_art_briefs SET status = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`,
      Number(candidates?.count ?? 0) > 0 ? "review" : "draft",
      now,
      brief.id,
      ctx.tenant.id,
    ),
    auditStatement(ctx, "art.job.cancelled", "art_job", job.id, {
      brief_id: brief.id,
      previous_status: job.status,
      actual_cost_cents: actual,
    }),
  ]);
  return loadJobRow(ctx, job.id);
}

export async function addArtFeedback(
  ctx: Ctx,
  candidateId: string,
  input: {
    decision?: string;
    tags?: string[];
    body?: string | null;
  },
): Promise<{ candidate: ArtCandidateView; feedback: ArtFeedbackRow }> {
  const candidate = await loadCandidateRow(ctx, candidateId);
  const brief = await loadBriefRow(ctx, candidate.brief_id);
  await requireBriefWrite(ctx, brief);
  const decision = input.decision ?? "comment";
  if (!["comment", "shortlist", "needs_revision", "reject"].includes(decision)) {
    throw new ApiError(
      422,
      "art_feedback_decision_invalid",
      "Use comment, shortlist, needs_revision or reject. Approve and publish have dedicated actions.",
    );
  }
  const tags = normalizeFeedbackTags(input.tags);
  const body = optionalText(input.body, 2000);
  if (["needs_revision", "reject"].includes(decision) && !body) {
    throw new ApiError(
      422,
      "art_feedback_note_required",
      "Record the reason so the next generation can be deliberately different.",
    );
  }
  if (candidate.status === "published") {
    throw new ApiError(
      409,
      "art_candidate_published",
      "A published candidate cannot be re-reviewed. Roll it back first.",
    );
  }
  if (candidate.status === "approved" && ["shortlist", "needs_revision"].includes(decision)) {
    throw new ApiError(
      409,
      "art_candidate_approved",
      "This direction is already approved. Add a comment, or reject it to revoke the approval.",
    );
  }
  if (decision === "reject" && candidate.status === "approved") {
    const approval = await loadApproval(ctx, candidate.id, { activeOnly: true });
    if (approval?.published_at) {
      throw new ApiError(
        409,
        "art_candidate_published",
        "Roll the publication back before rejecting it.",
      );
    }
    if (approval) {
      await statement(
        ctx.db,
        "UPDATE fb_art_approvals SET revoked_at = ?, revoked_by = ? WHERE id = ? AND tenant_id = ?",
        nowIso(),
        ctx.user!.id,
        approval.id,
        ctx.tenant.id,
      ).run();
    }
  }
  const id = newId("artf");
  const now = nowIso();
  const status =
    decision === "shortlist"
      ? "shortlisted"
      : decision === "needs_revision"
        ? "needs_revision"
        : decision === "reject"
          ? "rejected"
          : candidate.status;
  const briefStatus =
    candidate.status === "approved" && decision === "comment" ? "approved" : "review";
  await ctx.db.batch([
    statement(
      ctx.db,
      `INSERT INTO fb_art_feedback
        (id, tenant_id, candidate_id, author_user_id, decision, tags_json, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      ctx.tenant.id,
      candidate.id,
      ctx.user!.id,
      decision,
      JSON.stringify(tags),
      body,
      now,
    ),
    statement(
      ctx.db,
      "UPDATE fb_art_candidates SET status = ?, updated_at = ? WHERE id = ? AND tenant_id = ?",
      status,
      now,
      candidate.id,
      ctx.tenant.id,
    ),
    statement(
      ctx.db,
      `UPDATE fb_art_briefs SET status = ?, updated_at = ? WHERE id = ? AND tenant_id = ? AND status NOT IN ('published')`,
      briefStatus,
      now,
      brief.id,
      ctx.tenant.id,
    ),
    auditStatement(ctx, "art.feedback.recorded", "art_candidate", candidate.id, {
      brief_id: brief.id,
      decision,
      tags,
      body,
      previous_status: candidate.status,
      next_status: status,
    }),
  ]);
  const updated = await loadCandidateRow(ctx, candidate.id);
  const assetIds = [
    updated.asset_id,
    updated.render_asset_id,
    updated.render_back_asset_id,
    updated.master_asset_id,
    updated.preview_400_asset_id,
    updated.thumb_128_asset_id,
  ].filter((value): value is string => Boolean(value));
  const assets = assetIds.length
    ? await all<AssetRow>(
        ctx.db,
        `SELECT * FROM fb_assets WHERE tenant_id = ? AND id IN (${assetIds.map(() => "?").join(",")})`,
        ctx.tenant.id,
        ...assetIds,
      )
    : [];
  const feedbackRows = await all<ArtFeedbackRow>(
    ctx.db,
    "SELECT * FROM fb_art_feedback WHERE tenant_id = ? AND candidate_id = ? ORDER BY created_at",
    ctx.tenant.id,
    candidate.id,
  );
  const approval = await loadApproval(ctx, candidate.id, { activeOnly: true });
  return {
    candidate: candidateView(
      updated,
      new Map(assets.map((asset) => [asset.id, asset])),
      feedbackRows,
      approval,
      artFileBase(brief.category),
    ),
    feedback: feedbackRows.find((row) => row.id === id)!,
  };
}

export async function approveArtCandidate(
  ctx: Ctx,
  candidateId: string,
  input: { usage: string; notes?: string | null; vectorRef?: string | null; replace?: boolean },
): Promise<ArtCandidateView> {
  const candidate = await loadCandidateRow(ctx, candidateId);
  const brief = await loadBriefRow(ctx, candidate.brief_id);
  await requireBriefWrite(ctx, brief);
  if (brief.audience === "public" && !ctx.user?.platformAdmin) {
    throw new ApiError(
      403,
      "art_public_approval_forbidden",
      "Only the Super Admin can approve a public-audience direction.",
    );
  }
  if (candidate.status === "rejected") {
    throw new ApiError(
      409,
      "art_candidate_rejected",
      "A rejected candidate cannot be approved. Generate a new direction.",
    );
  }
  if (candidate.status === "published") {
    throw new ApiError(409, "art_candidate_published", "This candidate is already published.");
  }
  if (candidate.status === "approved") {
    const current = await loadApproval(ctx, candidate.id, { activeOnly: true });
    if (current) return candidateViewFor(ctx, candidate);
  }
  const usage = cleanText(input.usage, "usage", 3, 200);
  const vectorRef = normalizeVectorRef(input.vectorRef);
  if (brief.category === "logo" && !vectorRef) {
    throw new ApiError(
      422,
      "art_logo_vector_required",
      "A logo direction needs a vector source before approval. Record the vectorised file path or URL.",
    );
  }
  const liveApproval = await first<ArtApprovalRow>(
    ctx.db,
    `SELECT * FROM fb_art_approvals
      WHERE tenant_id = ? AND brief_id = ? AND candidate_id <> ?
        AND revoked_at IS NULL AND published_at IS NOT NULL AND rollback_at IS NULL
      ORDER BY published_at DESC LIMIT 1`,
    ctx.tenant.id,
    brief.id,
    candidate.id,
  );
  if (liveApproval) {
    throw new ApiError(
      409,
      "art_brief_already_published",
      "Another direction from this brief is currently published. Roll it back before approving a different direction.",
      { published_candidate_id: liveApproval.candidate_id, approval_id: liveApproval.id },
    );
  }
  const otherApproval = await first<ArtApprovalRow>(
    ctx.db,
    `SELECT * FROM fb_art_approvals
      WHERE tenant_id = ? AND brief_id = ? AND candidate_id <> ? AND revoked_at IS NULL AND published_at IS NULL
      ORDER BY approved_at DESC LIMIT 1`,
    ctx.tenant.id,
    brief.id,
    candidate.id,
  );
  if (otherApproval && !input.replace) {
    throw new ApiError(
      409,
      "art_direction_already_approved",
      "Another direction is already approved for this brief. Reject it or approve this one as a replacement.",
      { approved_candidate_id: otherApproval.candidate_id, approval_id: otherApproval.id },
    );
  }
  const now = nowIso();
  const approvalId = newId("arta");
  const statements = [];
  if (otherApproval) {
    statements.push(
      statement(
        ctx.db,
        "UPDATE fb_art_approvals SET revoked_at = ?, revoked_by = ? WHERE id = ? AND tenant_id = ?",
        now,
        ctx.user!.id,
        otherApproval.id,
        ctx.tenant.id,
      ),
      statement(
        ctx.db,
        "UPDATE fb_art_candidates SET status = 'shortlisted', updated_at = ? WHERE id = ? AND tenant_id = ?",
        now,
        otherApproval.candidate_id,
        ctx.tenant.id,
      ),
    );
  }
  statements.push(
    statement(
      ctx.db,
      `INSERT INTO fb_art_approvals
        (id, tenant_id, brief_id, candidate_id, approved_by, approved_at, usage, style_key,
         notes, vector_ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      approvalId,
      ctx.tenant.id,
      brief.id,
      candidate.id,
      ctx.user!.id,
      now,
      usage,
      candidate.style_key,
      optionalText(input.notes, 2000),
      vectorRef,
      now,
    ),
    statement(
      ctx.db,
      "UPDATE fb_art_candidates SET status = 'approved', updated_at = ? WHERE id = ? AND tenant_id = ?",
      now,
      candidate.id,
      ctx.tenant.id,
    ),
    statement(
      ctx.db,
      "UPDATE fb_art_briefs SET status = 'approved', updated_at = ? WHERE id = ? AND tenant_id = ?",
      now,
      brief.id,
      ctx.tenant.id,
    ),
    auditStatement(ctx, "art.candidate.approved", "art_candidate", candidate.id, {
      brief_id: brief.id,
      approval_id: approvalId,
      usage,
      style_key: candidate.style_key,
      vector_ref: vectorRef,
      replaced_approval_id: otherApproval?.id ?? null,
    }),
  );
  await ctx.db.batch(statements);
  return candidateViewFor(ctx, await loadCandidateRow(ctx, candidate.id));
}

async function candidateViewFor(ctx: Ctx, candidate: ArtCandidateRow): Promise<ArtCandidateView> {
  const assetIds = [
    candidate.asset_id,
    candidate.render_asset_id,
    candidate.render_back_asset_id,
    candidate.master_asset_id,
    candidate.preview_400_asset_id,
    candidate.thumb_128_asset_id,
  ].filter((value): value is string => Boolean(value));
  const assets = assetIds.length
    ? await all<AssetRow>(
        ctx.db,
        `SELECT * FROM fb_assets WHERE tenant_id = ? AND id IN (${assetIds.map(() => "?").join(",")})`,
        ctx.tenant.id,
        ...assetIds,
      )
    : [];
  const feedback = await all<ArtFeedbackRow>(
    ctx.db,
    "SELECT * FROM fb_art_feedback WHERE tenant_id = ? AND candidate_id = ? ORDER BY created_at",
    ctx.tenant.id,
    candidate.id,
  );
  const approval = await loadApproval(ctx, candidate.id, { activeOnly: true });
  const brief = await loadBriefRow(ctx, candidate.brief_id);
  return candidateView(
    candidate,
    new Map(assets.map((asset) => [asset.id, asset])),
    feedback,
    approval,
    artFileBase(brief.category),
  );
}

export async function rejectArtCandidate(
  ctx: Ctx,
  candidateId: string,
  input: { note: string; tags?: string[] },
): Promise<ArtCandidateView> {
  return (
    await addArtFeedback(ctx, candidateId, {
      decision: "reject",
      tags: input.tags,
      body: input.note,
    })
  ).candidate;
}

export async function publishArtCandidate(
  ctx: Ctx,
  candidateId: string,
  input: {
    confirmation: string;
    variantId?: string | null;
    notes?: string | null;
    publishBack?: boolean;
    vectorRef?: string | null;
  },
): Promise<{
  candidate: ArtCandidateView;
  approval: ArtApprovalRow;
  publication: Record<string, unknown>;
}> {
  const candidate = await loadCandidateRow(ctx, candidateId);
  const brief = await loadBriefRow(ctx, candidate.brief_id);
  await requireBriefWrite(ctx, brief);
  if (input.confirmation !== "PUBLISH") {
    throw new ApiError(
      422,
      "art_publish_confirmation_required",
      'Type "PUBLISH" to confirm this publication.',
    );
  }
  if (ctx.actor.type === "user") requireRecentStrongAuth(ctx, 30);
  const approval = await loadApproval(ctx, candidate.id, { activeOnly: true });
  if (!approval) {
    throw new ApiError(
      409,
      "art_approval_required",
      "Approve this direction before publishing it.",
    );
  }
  if (approval.published_at && !approval.rollback_at) {
    throw new ApiError(409, "art_already_published", "This direction is already published.");
  }
  if (candidate.status !== "approved") {
    throw new ApiError(
      409,
      "art_candidate_not_approved",
      "Only an approved direction can be published.",
    );
  }
  const livePublication = await first<ArtApprovalRow>(
    ctx.db,
    `SELECT * FROM fb_art_approvals
      WHERE tenant_id = ? AND brief_id = ? AND candidate_id <> ?
        AND revoked_at IS NULL AND published_at IS NOT NULL AND rollback_at IS NULL
      ORDER BY published_at DESC LIMIT 1`,
    ctx.tenant.id,
    brief.id,
    candidate.id,
  );
  if (livePublication) {
    throw new ApiError(
      409,
      "art_brief_already_published",
      "Another direction from this brief is currently published. Roll it back before publishing this one.",
      { published_candidate_id: livePublication.candidate_id, approval_id: livePublication.id },
    );
  }
  const now = nowIso();
  if (brief.category === "cards") {
    return publishCardCandidate(ctx, brief, candidate, approval, input, now);
  }
  return publishBrandCandidate(ctx, brief, candidate, approval, input, now);
}

async function publishCardCandidate(
  ctx: Ctx,
  brief: ArtBriefRow,
  candidate: ArtCandidateRow,
  approval: ArtApprovalRow,
  input: {
    variantId?: string | null;
    notes?: string | null;
    publishBack?: boolean;
    vectorRef?: string | null;
  },
  now: string,
): Promise<{
  candidate: ArtCandidateView;
  approval: ArtApprovalRow;
  publication: Record<string, unknown>;
}> {
  if (brief.audience === "public" && !ctx.user?.platformAdmin) {
    throw new ApiError(
      403,
      "art_public_publish_forbidden",
      "Only the Super Admin can publish a public-audience card.",
    );
  }
  if (!brief.card_id) {
    throw new ApiError(422, "art_card_required", "This brief has no subject to publish against.");
  }
  const variantId = input.variantId ?? brief.target_variant_id;
  if (!variantId) {
    throw new ApiError(
      422,
      "art_target_variant_required",
      "Choose the exact card variant this direction will replace before publishing.",
    );
  }
  const variant = await first<{
    id: string;
    card_id: string;
    edition_id: string;
    material_key: string;
    effect_key: string | null;
    recipe_id: string;
  }>(
    ctx.db,
    `SELECT v.id, v.card_id, v.edition_id, m.key AS material_key, e.key AS effect_key, ed.recipe_id
       FROM fb_variants v
       JOIN fb_materials m ON m.id = v.material_id
       LEFT JOIN fb_effects e ON e.id = v.effect_id
       JOIN fb_artwork_editions ed ON ed.id = v.edition_id
      WHERE v.id = ? AND v.tenant_id = ? AND v.card_id = ? AND v.archived_at IS NULL`,
    variantId,
    ctx.tenant.id,
    brief.card_id,
  );
  if (!variant) {
    throw new ApiError(
      422,
      "art_target_variant_invalid",
      "Choose a live variant that belongs to this brief's subject.",
    );
  }
  const frontAssetId = candidate.render_asset_id ?? candidate.asset_id;
  const front = await first<AssetRow>(
    ctx.db,
    "SELECT * FROM fb_assets WHERE id = ? AND tenant_id = ? AND archived_at IS NULL",
    frontAssetId,
    ctx.tenant.id,
  );
  if (!front) {
    throw new ApiError(422, "art_front_missing", "The candidate front asset is missing.");
  }
  const frontAspect = front.width && front.height ? front.width / front.height : 0;
  if (Math.abs(frontAspect - 5 / 7) > 0.02) {
    throw new ApiError(
      422,
      "art_card_aspect_invalid",
      "The published card must be a 5:7 object. Regenerate or resize the front to 750x1050.",
      { width: front.width, height: front.height },
    );
  }
  const previousFront = await first<Record<string, unknown>>(
    ctx.db,
    "SELECT * FROM fb_variant_renders WHERE tenant_id = ? AND variant_id = ? ORDER BY published_at DESC LIMIT 1",
    ctx.tenant.id,
    variant.id,
  );
  const previousBack = await first<Record<string, unknown>>(
    ctx.db,
    "SELECT * FROM fb_variant_back_renders WHERE tenant_id = ? AND variant_id = ? ORDER BY published_at DESC LIMIT 1",
    ctx.tenant.id,
    variant.id,
  );
  const previousState = {
    captured_at: now,
    published_recipe_id: variant.recipe_id,
    front: previousFront,
    back: previousBack,
  };
  const frontBytes = new Uint8Array(await readAsset(ctx.media, front));
  const publishedFront = await createRenderAsset(ctx, {
    variantId: variant.id,
    recipeId: variant.recipe_id,
    bytes: frontBytes,
    styleKey: candidate.style_key,
  });
  let publishedBack: { assetId: string; width: number; height: number; sha256: string } | null =
    null;
  const backAssetId = candidate.render_back_asset_id;
  const shouldPublishBack = input.publishBack !== false && Boolean(backAssetId);
  if (shouldPublishBack && backAssetId) {
    const back = await first<AssetRow>(
      ctx.db,
      "SELECT * FROM fb_assets WHERE id = ? AND tenant_id = ? AND archived_at IS NULL",
      backAssetId,
      ctx.tenant.id,
    );
    if (back) {
      const backAspect = back.width && back.height ? back.width / back.height : 0;
      if (Math.abs(backAspect - 5 / 7) <= 0.02) {
        const backBytes = new Uint8Array(await readAsset(ctx.media, back));
        publishedBack = await createBackRenderAsset(ctx, {
          variantId: variant.id,
          recipeId: variant.recipe_id,
          bytes: backBytes,
        });
      }
    }
  }
  try {
    await ctx.db.batch([
      statement(
        ctx.db,
        `UPDATE fb_art_candidates SET status = 'published', updated_at = ? WHERE id = ? AND tenant_id = ?`,
        now,
        candidate.id,
        ctx.tenant.id,
      ),
      statement(
        ctx.db,
        `UPDATE fb_art_briefs SET status = 'published', updated_at = ? WHERE id = ? AND tenant_id = ?`,
        now,
        brief.id,
        ctx.tenant.id,
      ),
      statement(
        ctx.db,
        `UPDATE fb_art_approvals
            SET published_at = ?, published_by = ?, target_kind = 'variant', target_id = ?,
                published_asset_id = ?, previous_state_json = ?, style_key = COALESCE(style_key, ?),
                notes = COALESCE(?, notes), rollback_at = NULL, rollback_by = NULL
          WHERE id = ? AND tenant_id = ?`,
        now,
        ctx.user!.id,
        variant.id,
        publishedFront.assetId,
        JSON.stringify(previousState),
        candidate.style_key,
        optionalText(input.notes, 2000),
        approval.id,
        ctx.tenant.id,
      ),
      auditStatement(ctx, "art.candidate.published", "art_candidate", candidate.id, {
        brief_id: brief.id,
        variant_id: variant.id,
        recipe_id: variant.recipe_id,
        previous_front_asset_id: previousFront?.asset_id ?? null,
        new_front_asset_id: publishedFront.assetId,
        new_front_sha256: publishedFront.sha256,
        style_key: candidate.style_key,
        previous_back_asset_id: previousBack?.asset_id ?? null,
        new_back_asset_id: publishedBack?.assetId ?? null,
        audience: brief.audience,
      }),
    ]);
  } catch (cause) {
    // The variant render rows were written before the approval record. Restore
    // the snapshot so a failed publication cannot leave an unaudited live card.
    await restoreRenderRow(
      ctx,
      "fb_variant_renders",
      variant.id,
      variant.recipe_id,
      previousFront,
    ).catch(() => undefined);
    await restoreRenderRow(
      ctx,
      "fb_variant_back_renders",
      variant.id,
      variant.recipe_id,
      previousBack,
    ).catch(() => undefined);
    throw cause;
  }
  // The full render is always available. Derivatives are a best-effort gallery
  // optimisation; a derivative miss never invalidates the publication.
  try {
    const previewSize = candidate.preview_400_asset_id
      ? await first<AssetRow>(
          ctx.db,
          "SELECT * FROM fb_assets WHERE id = ? AND tenant_id = ?",
          candidate.preview_400_asset_id,
          ctx.tenant.id,
        )
      : null;
    const thumbSize = candidate.thumb_128_asset_id
      ? await first<AssetRow>(
          ctx.db,
          "SELECT * FROM fb_assets WHERE id = ? AND tenant_id = ?",
          candidate.thumb_128_asset_id,
          ctx.tenant.id,
        )
      : null;
    if (previewSize) {
      await createDerivative(ctx, {
        sourceAssetId: publishedFront.assetId,
        sizeKey: "preview",
        bytes: new Uint8Array(await readAsset(ctx.media, previewSize)),
      });
    }
    if (thumbSize) {
      await createDerivative(ctx, {
        sourceAssetId: publishedFront.assetId,
        sizeKey: "thumb",
        bytes: new Uint8Array(await readAsset(ctx.media, thumbSize)),
      });
    }
  } catch {
    // Keep the publication; the render pipeline can rebuild derivatives later.
  }
  const updatedApproval = (await first<ArtApprovalRow>(
    ctx.db,
    "SELECT * FROM fb_art_approvals WHERE id = ? AND tenant_id = ?",
    approval.id,
    ctx.tenant.id,
  ))!;
  return {
    candidate: await candidateViewFor(ctx, await loadCandidateRow(ctx, candidate.id)),
    approval: updatedApproval,
    publication: {
      target_kind: "variant",
      variant_id: variant.id,
      asset_id: publishedFront.assetId,
      sha256: publishedFront.sha256,
      back_asset_id: publishedBack?.assetId ?? null,
      previous_front_asset_id: previousFront?.asset_id ?? null,
      previous_back_asset_id: previousBack?.asset_id ?? null,
    },
  };
}

async function publishBrandCandidate(
  ctx: Ctx,
  brief: ArtBriefRow,
  candidate: ArtCandidateRow,
  approval: ArtApprovalRow,
  input: { notes?: string | null; vectorRef?: string | null },
  now: string,
): Promise<{
  candidate: ArtCandidateView;
  approval: ArtApprovalRow;
  publication: Record<string, unknown>;
}> {
  if (!ctx.user?.platformAdmin || ctx.actor.type !== "user") {
    throw new ApiError(
      403,
      "art_brand_super_admin_required",
      "Only the Super Admin can publish brand art.",
    );
  }
  const vectorRef = normalizeVectorRef(input.vectorRef) ?? approval.vector_ref;
  if (brief.category === "logo" && !vectorRef) {
    throw new ApiError(
      422,
      "art_logo_vector_required",
      "Publish a logo only after its vector source has been reviewed.",
    );
  }
  const sourceAssetId = candidate.render_asset_id ?? candidate.asset_id;
  const source = await first<AssetRow>(
    ctx.db,
    "SELECT * FROM fb_assets WHERE id = ? AND tenant_id = ? AND archived_at IS NULL",
    sourceAssetId,
    ctx.tenant.id,
  );
  if (!source) throw new ApiError(422, "art_asset_missing", "The approved brand asset is missing.");
  const brandSlug = brandAssetSlug(brief.title);
  const existing = await first<{ id: string }>(
    ctx.db,
    "SELECT id FROM fb_assets WHERE tenant_id = ? AND sha256 = ? AND kind = 'brand' AND archived_at IS NULL",
    ctx.tenant.id,
    source.sha256,
  );
  const bytes = new Uint8Array(await readAsset(ctx.media, source));
  const ext = source.mime.includes("png") ? "png" : source.mime.includes("jpeg") ? "jpg" : "webp";
  const brandAsset = await uploadAsset(ctx, {
    kind: "brand",
    name: `Brand kit · ${brief.title}`,
    bytes,
    declaredMime: source.mime,
    visibility: "public_export",
    accessClassification: "public",
    role: brief.category,
    official: false,
    reviewStatus: "approved",
    dedupe: false,
    provenance: {
      art_lab: true,
      brief_id: brief.id,
      candidate_id: candidate.id,
      approval_id: approval.id,
      category: brief.category,
      method: candidate.method,
      provider: candidate.provider,
      model: candidate.model,
      prompt: candidate.prompt,
      seed: candidate.seed,
      sha256: source.sha256,
      vector_ref: vectorRef,
      official: false,
      note: "Published by the provisioned Super Admin from the Art Lab. Not official third-party artwork.",
      published_at: now,
    },
    source: {
      path: `public/brand/kit/approved/${brief.category}-${brandSlug}.${ext}`,
      credit: "Foilbury Art Lab",
    },
  });
  try {
    await ctx.db.batch([
      statement(
        ctx.db,
        `UPDATE fb_art_candidates SET status = 'published', updated_at = ? WHERE id = ? AND tenant_id = ?`,
        now,
        candidate.id,
        ctx.tenant.id,
      ),
      statement(
        ctx.db,
        `UPDATE fb_art_briefs SET status = 'published', updated_at = ? WHERE id = ? AND tenant_id = ?`,
        now,
        brief.id,
        ctx.tenant.id,
      ),
      statement(
        ctx.db,
        `UPDATE fb_art_approvals
            SET published_at = ?, published_by = ?, target_kind = 'brand_asset', target_id = ?,
                published_asset_id = ?, vector_ref = ?, previous_state_json = ?, notes = COALESCE(?, notes),
                rollback_at = NULL, rollback_by = NULL
          WHERE id = ? AND tenant_id = ?`,
        now,
        ctx.user.id,
        brandAsset.id,
        brandAsset.id,
        vectorRef,
        JSON.stringify({ captured_at: now, existing_brand_asset_id: existing?.id ?? null }),
        optionalText(input.notes, 2000),
        approval.id,
        ctx.tenant.id,
      ),
      auditStatement(ctx, "art.candidate.published", "art_candidate", candidate.id, {
        brief_id: brief.id,
        category: brief.category,
        brand_asset_id: brandAsset.id,
        sha256: brandAsset.sha256,
        vector_ref: vectorRef,
      }),
    ]);
  } catch (cause) {
    await statement(
      ctx.db,
      "UPDATE fb_assets SET archived_at = ? WHERE id = ? AND tenant_id = ?",
      now,
      brandAsset.id,
      ctx.tenant.id,
    )
      .run()
      .catch(() => undefined);
    throw cause;
  }
  const updatedApproval = (await first<ArtApprovalRow>(
    ctx.db,
    "SELECT * FROM fb_art_approvals WHERE id = ? AND tenant_id = ?",
    approval.id,
    ctx.tenant.id,
  ))!;
  return {
    candidate: await candidateViewFor(ctx, await loadCandidateRow(ctx, candidate.id)),
    approval: updatedApproval,
    publication: {
      target_kind: "brand_asset",
      asset_id: brandAsset.id,
      url: `/media/public/${brandAsset.id}`,
      sha256: brandAsset.sha256,
      category: brief.category,
      vector_ref: vectorRef,
    },
  };
}

function brandAssetSlug(value: string): string {
  return (
    words(value)
      .split(" ")
      .filter((word) => word && !STOP.has(word))
      .slice(0, 6)
      .join("-") || "brand-art"
  );
}

export async function rollbackArtPublication(
  ctx: Ctx,
  approvalId: string,
): Promise<{ approval: ArtApprovalRow; restored: Record<string, unknown> }> {
  const approval = await first<ArtApprovalRow>(
    ctx.db,
    "SELECT * FROM fb_art_approvals WHERE id = ? AND tenant_id = ?",
    approvalId,
    ctx.tenant.id,
  );
  if (!approval)
    throw new ApiError(404, "art_approval_not_found", "That publication record does not exist.");
  const brief = await loadBriefRow(ctx, approval.brief_id);
  await requireBriefWrite(ctx, brief);
  if (!approval.published_at) {
    throw new ApiError(409, "art_not_published", "This approval has not been published.");
  }
  if (approval.rollback_at) {
    throw new ApiError(409, "art_already_rolled_back", "This publication was already rolled back.");
  }
  if (ctx.actor.type === "user") requireRecentStrongAuth(ctx, 30);
  const now = nowIso();
  const previous = parseJson<{
    front?: Record<string, unknown> | null;
    back?: Record<string, unknown> | null;
    published_recipe_id?: string | null;
    existing_brand_asset_id?: string | null;
  }>(approval.previous_state_json, {});
  const statements = [];
  if (approval.target_kind === "variant" && approval.target_id) {
    const recipeId =
      previous.published_recipe_id ??
      (typeof previous.front?.recipe_id === "string"
        ? previous.front.recipe_id
        : typeof previous.back?.recipe_id === "string"
          ? previous.back.recipe_id
          : null);
    if (!recipeId) {
      throw new ApiError(
        409,
        "art_rollback_unavailable",
        "The publication record has no recipe snapshot. Restore the previous render from the render queue instead.",
      );
    }
    await restoreRenderRow(
      ctx,
      "fb_variant_renders",
      approval.target_id,
      recipeId,
      previous.front ?? null,
    );
    await restoreRenderRow(
      ctx,
      "fb_variant_back_renders",
      approval.target_id,
      recipeId,
      previous.back ?? null,
    );
  } else if (approval.target_kind === "brand_asset" && approval.published_asset_id) {
    const published = await first<AssetRow>(
      ctx.db,
      "SELECT * FROM fb_assets WHERE id = ? AND tenant_id = ?",
      approval.published_asset_id,
      ctx.tenant.id,
    );
    const provenance = parseJson<Record<string, unknown>>(published?.provenance_json ?? "{}", {});
    if (provenance.approval_id === approval.id) {
      statements.push(
        statement(
          ctx.db,
          "UPDATE fb_assets SET archived_at = ? WHERE id = ? AND tenant_id = ?",
          now,
          approval.published_asset_id,
          ctx.tenant.id,
        ),
      );
    }
  }
  statements.push(
    statement(
      ctx.db,
      `UPDATE fb_art_approvals SET rollback_at = ?, rollback_by = ? WHERE id = ? AND tenant_id = ?`,
      now,
      ctx.user!.id,
      approval.id,
      ctx.tenant.id,
    ),
    statement(
      ctx.db,
      "UPDATE fb_art_candidates SET status = 'approved', updated_at = ? WHERE id = ? AND tenant_id = ?",
      now,
      approval.candidate_id,
      ctx.tenant.id,
    ),
    statement(
      ctx.db,
      "UPDATE fb_art_briefs SET status = 'approved', updated_at = ? WHERE id = ? AND tenant_id = ?",
      now,
      brief.id,
      ctx.tenant.id,
    ),
    auditStatement(ctx, "art.publication.rolled_back", "art_approval", approval.id, {
      brief_id: brief.id,
      target_kind: approval.target_kind,
      target_id: approval.target_id,
      published_asset_id: approval.published_asset_id,
      previous_state: previous,
    }),
  );
  await ctx.db.batch(statements);
  return {
    approval: (await first<ArtApprovalRow>(
      ctx.db,
      "SELECT * FROM fb_art_approvals WHERE id = ? AND tenant_id = ?",
      approval.id,
      ctx.tenant.id,
    ))!,
    restored: previous as Record<string, unknown>,
  };
}

async function restoreRenderRow(
  ctx: Ctx,
  table: "fb_variant_renders" | "fb_variant_back_renders",
  variantId: string,
  recipeId: string,
  row: Record<string, unknown> | null,
): Promise<void> {
  if (!row) {
    await statement(
      ctx.db,
      `DELETE FROM ${table} WHERE tenant_id = ? AND variant_id = ? AND recipe_id = ?`,
      ctx.tenant.id,
      variantId,
      recipeId,
    ).run();
    return;
  }
  if (table === "fb_variant_renders") {
    await statement(
      ctx.db,
      `INSERT INTO fb_variant_renders
        (id, tenant_id, variant_id, recipe_id, asset_id, public_url, width, height, sha256,
         status, created_at, published_at, source_hash, style_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, variant_id, recipe_id) DO UPDATE SET
         asset_id = excluded.asset_id, public_url = excluded.public_url, width = excluded.width,
         height = excluded.height, sha256 = excluded.sha256, status = excluded.status,
         published_at = excluded.published_at, source_hash = excluded.source_hash,
         style_key = excluded.style_key`,
      row.id,
      ctx.tenant.id,
      variantId,
      row.recipe_id,
      row.asset_id,
      row.public_url,
      row.width,
      row.height,
      row.sha256,
      row.status,
      row.created_at,
      row.published_at,
      row.source_hash ?? null,
      row.style_key ?? null,
    ).run();
    return;
  }
  await statement(
    ctx.db,
    `INSERT INTO fb_variant_back_renders
      (id, tenant_id, variant_id, recipe_id, asset_id, width, height, sha256, status, created_at, published_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, variant_id, recipe_id) DO UPDATE SET
       asset_id = excluded.asset_id, width = excluded.width, height = excluded.height,
       sha256 = excluded.sha256, status = excluded.status, published_at = excluded.published_at`,
    row.id,
    ctx.tenant.id,
    variantId,
    row.recipe_id,
    row.asset_id,
    row.width,
    row.height,
    row.sha256,
    row.status,
    row.created_at,
    row.published_at,
  ).run();
}

export async function uploadCandidateRender(
  ctx: Ctx,
  candidateId: string,
  form: FormData,
): Promise<ArtCandidateView> {
  const candidate = await loadCandidateRow(ctx, candidateId);
  const brief = await loadBriefRow(ctx, candidate.brief_id);
  await requireBriefWrite(ctx, brief);
  if (candidate.status === "published") {
    throw new ApiError(
      409,
      "art_candidate_published",
      "Roll the publication back before replacing its render.",
    );
  }
  const frontFile = form.get("front");
  const backFile = form.get("back");
  const masterFile = form.get("master");
  const preview400File = form.get("preview400");
  const thumb128File = form.get("thumb128");
  if (!(frontFile instanceof File)) {
    throw new ApiError(422, "art_front_required", "Upload the rendered card front.");
  }
  const provenance = {
    art_lab: true,
    brief_id: brief.id,
    candidate_id: candidate.id,
    job_id: candidate.job_id,
    method: candidate.method,
    provider: candidate.provider,
    model: candidate.model,
    prompt: candidate.prompt,
    seed: candidate.seed,
    note: "Operator-supplied render for a reviewed Art Lab candidate.",
    generated_at: nowIso(),
  };
  const uploadOne = async (file: FormDataEntryValue | null, role: string) => {
    if (!(file instanceof File)) return null;
    return uploadAsset(ctx, {
      kind: "render",
      name: `Art Lab · ${brief.title} · ${candidate.label} · ${role}`,
      bytes: new Uint8Array(await file.arrayBuffer()),
      declaredMime: file.type || undefined,
      visibility: "private",
      accessClassification: "private",
      role,
      official: false,
      reviewStatus: "unreviewed",
      provenance,
      dedupe: false,
    });
  };
  const front = await uploadOne(frontFile, "front");
  const back = await uploadOne(backFile, "back");
  const master = await uploadOne(masterFile, "master");
  const preview400 = await uploadOne(preview400File, "preview-400");
  const thumb128 = await uploadOne(thumb128File, "thumb-128");
  if (!front) throw new ApiError(422, "art_front_required", "Upload the rendered card front.");
  if (brief.category === "cards" && front.width && front.height) {
    const aspect = front.width / front.height;
    if (Math.abs(aspect - 5 / 7) > 0.02) {
      throw new ApiError(
        422,
        "art_card_aspect_invalid",
        "The rendered front must be a 5:7 object.",
      );
    }
  }
  const now = nowIso();
  await ctx.db.batch([
    statement(
      ctx.db,
      `UPDATE fb_art_candidates
          SET render_asset_id = ?, render_back_asset_id = COALESCE(?, render_back_asset_id),
              master_asset_id = COALESCE(?, master_asset_id),
              preview_400_asset_id = COALESCE(?, preview_400_asset_id),
              thumb_128_asset_id = COALESCE(?, thumb_128_asset_id),
              width = ?, height = ?, sha256 = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ?`,
      front.id,
      back?.id ?? null,
      master?.id ?? null,
      preview400?.id ?? null,
      thumb128?.id ?? null,
      front.width ?? candidate.width,
      front.height ?? candidate.height,
      front.sha256,
      now,
      candidate.id,
      ctx.tenant.id,
    ),
    auditStatement(ctx, "art.candidate.render_added", "art_candidate", candidate.id, {
      brief_id: brief.id,
      front_asset_id: front.id,
      back_asset_id: back?.id ?? null,
      sha256: front.sha256,
    }),
  ]);
  return candidateViewFor(ctx, await loadCandidateRow(ctx, candidate.id));
}

export async function readArtCandidateFile(
  ctx: Ctx,
  candidateId: string,
  side: string,
): Promise<{ bytes: ArrayBuffer; mime: string; filename: string; updatedAt: string }> {
  const candidate = await loadCandidateRow(ctx, candidateId);
  const brief = await loadBriefRow(ctx, candidate.brief_id);
  await requireBriefRead(ctx, brief);
  const map: Record<string, string | null> = {
    display: candidate.render_asset_id ?? candidate.asset_id,
    raw: candidate.asset_id,
    back: candidate.render_back_asset_id,
    master: candidate.master_asset_id,
    preview400: candidate.preview_400_asset_id,
    thumb128: candidate.thumb_128_asset_id,
    reference:
      typeof parseJson<Record<string, unknown>>(candidate.metadata_json, {}).reference_asset_id ===
      "string"
        ? (parseJson<Record<string, unknown>>(candidate.metadata_json, {})
            .reference_asset_id as string)
        : null,
  };
  const assetId = map[side];
  if (!assetId) {
    throw new ApiError(404, "art_file_not_found", "That candidate file has not been produced yet.");
  }
  const asset = await first<AssetRow>(
    ctx.db,
    "SELECT * FROM fb_assets WHERE id = ? AND tenant_id = ? AND archived_at IS NULL",
    assetId,
    ctx.tenant.id,
  );
  if (!asset) throw new ApiError(404, "art_file_not_found", "That candidate file is missing.");
  const bytes = await readAsset(ctx.media, asset);
  const ext = asset.mime.includes("png") ? "png" : asset.mime.includes("jpeg") ? "jpg" : "webp";
  return {
    bytes,
    mime: asset.mime,
    filename: `foilbury-${brief.category}-${candidate.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${side}.${ext}`,
    updatedAt: asset.created_at,
  };
}

export async function listArtAgentExport(
  ctx: Ctx,
  options?: { briefId?: string; limit?: number },
): Promise<Record<string, unknown>> {
  const allowed = allowedArtCategories(ctx);
  if (!allowed.length) throw new ApiError(403, "art_read_forbidden", "Art Lab is operator-only.");
  if (options?.briefId) {
    const detail = await getArtBrief(ctx, options.briefId);
    return { generated_at: nowIso(), briefs: [detail] };
  }
  const index = await listArtBriefs(ctx, { limit: options?.limit ?? 50 });
  const briefs = [];
  for (const summary of index.briefs) {
    if (!allowed.includes(summary.category)) continue;
    briefs.push(await getArtBrief(ctx, summary.id));
  }
  return {
    generated_at: nowIso(),
    daily: index.daily,
    briefs: briefs.map((detail) => ({
      ...detail,
      candidates: detail.candidates.map((candidate) => ({
        id: candidate.id,
        brief_id: candidate.brief_id,
        label: candidate.label,
        method: candidate.method,
        provider: candidate.provider,
        model: candidate.model,
        prompt: candidate.prompt,
        seed: candidate.seed,
        width: candidate.width,
        height: candidate.height,
        sha256: candidate.sha256,
        audience: candidate.audience,
        official: candidate.official,
        status: candidate.status,
        feedback: candidate.feedback,
        approval: candidate.approval,
      })),
    })),
  };
}
