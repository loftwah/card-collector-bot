/**
 * Multi-print proposals and review.
 *
 * A print is a genuinely different artwork edition of an existing subject. A
 * finish (Plain/Silver/Gold/Holographic) is a treatment of that print, never a
 * print of its own. This module deliberately does not create a second catalogue,
 * variants, instances, serials or awards: it references existing cards, assets
 * and artwork editions, and approval links a proposal to one edition without
 * modifying it.
 *
 * The workflow is intentionally conservative:
 *   draft -> proposed -> approved | rejected
 * A rejected proposal is revised in place (same stable print key) and resubmitted.
 */
import { ApiError, canManageContent, requireUser, type Ctx, type CurrentUser } from "../context";
import { all, first, nowIso, parseJson, run, statement } from "../db";
import { auditStatement } from "../http";
import { newId } from "../ids";

export const PRINT_ROLES = [
  "portrait",
  "action_scene",
  "alternate_art",
  "special_release",
  "ensemble",
  "location",
  "object",
  "other",
] as const;
export type PrintRole = (typeof PRINT_ROLES)[number];

export const PRINT_FINISH_KEYS = ["plain", "silver", "gold", "holographic"] as const;
export type PrintFinishKey = (typeof PRINT_FINISH_KEYS)[number];

export const PRINT_PROPOSAL_STATUSES = ["draft", "proposed", "approved", "rejected"] as const;
export type PrintProposalStatus = (typeof PRINT_PROPOSAL_STATUSES)[number];

export const MIN_CREATIVE_DIRECTION_LENGTH = 40;

export interface PrintProposalInput {
  cardId: string;
  printNumber: string;
  role: string;
  title: string;
  creativeDirection: string;
  sourceAssetId: string;
  artworkAssetId?: string | null;
  backgroundAssetId?: string | null;
  rightsNote?: string | null;
  sourceRefs?: string[];
  provenance?: Record<string, unknown>;
  finishKeys?: string[];
  status?: "draft" | "proposed";
}

export interface PrintProposalRevisionInput {
  role?: string;
  title?: string;
  creativeDirection?: string;
  sourceAssetId?: string;
  artworkAssetId?: string | null;
  backgroundAssetId?: string | null;
  rightsNote?: string | null;
  sourceRefs?: string[];
  finishKeys?: string[];
  note?: string;
}

export interface PrintProposalRow {
  id: string;
  tenant_id: string;
  card_id: string;
  print_number: string;
  print_key: string;
  role: PrintRole;
  title: string;
  creative_direction: string;
  source_asset_id: string;
  artwork_asset_id: string | null;
  background_asset_id: string | null;
  rights_note: string | null;
  source_refs_json: string;
  provenance_json: string;
  finish_keys_json: string;
  status: PrintProposalStatus;
  revision: number;
  created_by: string;
  reviewed_by: string | null;
  reviewer_kind: "human" | "agent" | null;
  reviewed_at: string | null;
  review_note: string | null;
  approved_edition_id: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PrintProposalView extends Omit<
  PrintProposalRow,
  "source_refs_json" | "provenance_json" | "finish_keys_json"
> {
  source_refs: string[];
  provenance: Record<string, unknown>;
  finish_keys: PrintFinishKey[];
  source_asset_url: string;
  artwork_url: string | null;
  background_url: string | null;
  approved_edition: { id: string; name: string; status: string } | null;
}

export interface PrintProposalReviewRow {
  id: string;
  proposal_id: string;
  revision: number;
  decision: "submitted" | "revised" | "approved" | "rejected" | "linked";
  reviewer_id: string;
  reviewer_kind: "human" | "agent";
  note: string | null;
  created_at: string;
}

/**
 * A comparable print identity. `role` is null for an existing edition, whose
 * role was never recorded by the legacy catalogue.
 */
export interface PrintCandidate {
  id: string;
  kind: "proposal" | "edition";
  role: string | null;
  title: string;
  creativeDirection: string;
  artworkFingerprint: string | null;
  finishKeys: string[];
  status?: string;
}

export interface PrintConflict {
  code: "finish_is_not_a_print" | "print_duplicate" | "print_near_duplicate";
  reason: string;
  against_kind: "proposal" | "edition";
  against_id: string;
  against_title: string;
}

export interface PrintCoverage {
  card_id: string;
  total: number;
  by_status: Record<PrintProposalStatus, number>;
  approved_prints: number;
  distinct_approved_artwork: number;
  linked_editions: number;
  minimum_met: boolean;
  recommended_third: boolean;
  label:
    "not_started" | "planning" | "in_review" | "single_print_requires_exception" | "minimum_met";
}

interface AssetRow {
  id: string;
  kind: string;
  name: string;
  mime: string;
  width: number | null;
  height: number | null;
  bytes: number;
  sha256: string;
  visibility: string;
  access_classification: string;
  processing_state: string;
  review_status: string;
  provenance_json: string;
  credit: string | null;
  source_repo: string | null;
  source_path: string | null;
  source_commit: string | null;
  source_logical_id: string | null;
  derivative_of_asset_id: string | null;
  archived_at: string | null;
}

interface CardRef {
  id: string;
  logical_id: string;
  slug: string;
  name: string;
  status: string;
}

interface EditionRef {
  id: string;
  card_id: string;
  name: string;
  status: string;
  subject_asset_id: string;
  archived_at: string | null;
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "has",
  "in",
  "into",
  "is",
  "it",
  "its",
  "not",
  "of",
  "on",
  "or",
  "so",
  "such",
  "than",
  "that",
  "the",
  "their",
  "then",
  "this",
  "to",
  "was",
  "were",
  "when",
  "where",
  "while",
  "will",
  "with",
  "without",
]);

const FINISH_WORDS = new Set([
  "plain",
  "base",
  "silver",
  "gold",
  "golden",
  "holographic",
  "holo",
  "foil",
  "foiled",
  "metallic",
  "matte",
  "gloss",
  "glossy",
  "rainbow",
  "finish",
  "variant",
]);

function normalizedWords(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function stripFinishWords(value: string): string {
  return normalizedWords(value)
    .split(" ")
    .filter((word) => word && !FINISH_WORDS.has(word))
    .join(" ");
}

function tokens(value: string): Set<string> {
  return new Set(
    stripFinishWords(value)
      .split(" ")
      .filter((word) => word.length >= 3 && !STOP_WORDS.has(word)),
  );
}

function similarity(left: string, right: string): number {
  const a = tokens(left);
  const b = tokens(right);
  if (!a.size || !b.size) {
    return stripFinishWords(left) === stripFinishWords(right) ? 1 : 0;
  }
  let common = 0;
  for (const token of a) if (b.has(token)) common += 1;
  return common / (a.size + b.size - common);
}

export function normalizePrintNumber(value: string): string {
  const match = /^(\d{1,3})([a-z])?$/i.exec(value.trim());
  if (!match) {
    throw new ApiError(422, "print_number_invalid", "Use a print number such as 01 or 02a.");
  }
  const numeric = Number(match[1]);
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > 999) {
    throw new ApiError(422, "print_number_invalid", "Print numbers must be between 1 and 999.");
  }
  const suffix = (match[2] ?? "").toUpperCase();
  return `${String(numeric).padStart(2, "0")}${suffix}`;
}

export function normalizePrintRole(value: string): PrintRole {
  const key = normalizedWords(value).replace(/ /g, "_");
  if (!PRINT_ROLES.includes(key as PrintRole)) {
    throw new ApiError(422, "print_role_invalid", "Choose a supported print role.", {
      roles: [...PRINT_ROLES],
    });
  }
  return key as PrintRole;
}

export function normalizeFinishKeys(
  values: string[] | undefined,
  fallback: string[] = ["plain"],
): PrintFinishKey[] {
  const input = values?.length ? values : fallback;
  const normalized = input.map((value) => {
    const cleaned = normalizedWords(value)
      .split(" ")
      .filter((word) => word && !["foil", "finish", "material"].includes(word))
      .join("_");
    if (cleaned === "holo") return "holographic";
    if (cleaned === "base") return "plain";
    return cleaned;
  });
  const unique = [...new Set(normalized)];
  for (const key of unique) {
    if (!PRINT_FINISH_KEYS.includes(key as PrintFinishKey)) {
      throw new ApiError(422, "print_finish_invalid", "Use a supported finish key.", {
        finishes: [...PRINT_FINISH_KEYS],
      });
    }
  }
  return unique as PrintFinishKey[];
}

function normalizeText(value: string, field: string, max: number): string {
  const trimmed = value.trim();
  if (!trimmed) throw new ApiError(422, `print_${field}_required`, `Give the print a ${field}.`);
  return trimmed.slice(0, max);
}

function normalizeTitle(value: string): string {
  const title = normalizeText(value, "title", 160);
  if (!stripFinishWords(title)) {
    throw new ApiError(
      422,
      "finish_is_not_a_print",
      "A finish label is not a print. Give the print its own title and artwork.",
    );
  }
  return title;
}

function normalizeCreativeDirection(value: string): string {
  const direction = value.trim();
  if (direction.length < MIN_CREATIVE_DIRECTION_LENGTH) {
    throw new ApiError(
      422,
      "print_direction_too_short",
      `Describe a distinct creative direction of at least ${MIN_CREATIVE_DIRECTION_LENGTH} characters.`,
      { min: MIN_CREATIVE_DIRECTION_LENGTH },
    );
  }
  return direction.slice(0, 1200);
}

function normalizeSourceRefs(values: string[] | undefined): string[] {
  const refs = (values ?? []).map((value) => value.trim()).filter(Boolean);
  for (const ref of refs) {
    const local = ref.startsWith("/") && !ref.startsWith("//");
    const https = /^https:\/\//i.test(ref);
    if (!local && !https) {
      throw new ApiError(
        422,
        "print_source_ref_invalid",
        "Source references must be HTTPS URLs or local paths.",
      );
    }
  }
  return [...new Set(refs)].slice(0, 20);
}

function normalizeNote(value: string | null | undefined, max = 2000): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

export interface ValidatedPrintFields {
  role: PrintRole;
  title: string;
  creativeDirection: string;
  finishKeys: PrintFinishKey[];
}

export function validatePrintFields(input: {
  role: string;
  title: string;
  creativeDirection: string;
  finishKeys?: string[];
}): ValidatedPrintFields {
  return {
    role: normalizePrintRole(input.role),
    title: normalizeTitle(input.title),
    creativeDirection: normalizeCreativeDirection(input.creativeDirection),
    finishKeys: normalizeFinishKeys(input.finishKeys),
  };
}

export function assetFingerprint(asset: { id: string; sha256: string }): string {
  return asset.sha256.trim().toLowerCase() || `asset:${asset.id}`;
}

/**
 * Pure same-subject distinctness check. It deliberately treats the artwork
 * fingerprint as identity: reusing the same image under a new role or title is
 * still the same print, while a different finish list alone is not a print.
 */
export function findPrintConflict(
  existing: PrintCandidate[],
  candidate: PrintCandidate,
): PrintConflict | null {
  for (const other of existing) {
    if (other.id === candidate.id) continue;
    const sameRole =
      candidate.role !== null && other.role !== null && candidate.role === other.role;
    const sameArtwork = Boolean(
      candidate.artworkFingerprint &&
      other.artworkFingerprint &&
      candidate.artworkFingerprint === other.artworkFingerprint,
    );
    const sameTitle = stripFinishWords(other.title) === stripFinishWords(candidate.title);
    const titleScore = similarity(other.title, candidate.title);
    const directionScore = similarity(other.creativeDirection, candidate.creativeDirection);
    const against = {
      against_kind: other.kind,
      against_id: other.id,
      against_title: other.title,
    } as const;

    if (sameRole && sameArtwork && sameTitle && directionScore >= 0.9) {
      return {
        code: "finish_is_not_a_print",
        reason:
          "That is the same artwork and print with a different finish. Finishes are variants of an existing print, not a new print.",
        ...against,
      };
    }
    if (sameArtwork) {
      return {
        code: "print_duplicate",
        reason:
          "That artwork already identifies another print of this subject. A new print needs genuinely different artwork.",
        ...against,
      };
    }
    if (sameRole && sameTitle) {
      return {
        code: "print_duplicate",
        reason:
          "This subject already has a print with that role and title. Revise the existing print instead of creating a duplicate.",
        ...against,
      };
    }
    if (sameRole && titleScore >= 0.8) {
      return {
        code: "print_near_duplicate",
        reason:
          "That title is too close to another print with the same role. Give the new print a clearly different identity.",
        ...against,
      };
    }
    if (sameRole && directionScore >= 0.85) {
      return {
        code: "print_near_duplicate",
        reason:
          "That creative direction is too close to another print with the same role. Change the composition, scene or art treatment.",
        ...against,
      };
    }
    if (!sameRole && titleScore >= 0.9) {
      return {
        code: "print_near_duplicate",
        reason:
          "That title is already used by another print of this subject. A different role is not enough to make it distinct.",
        ...against,
      };
    }
  }
  return null;
}

export function assertDistinctPrintCandidate(
  existing: PrintCandidate[],
  candidate: PrintCandidate,
): void {
  const conflict = findPrintConflict(existing, candidate);
  if (!conflict) return;
  throw new ApiError(409, conflict.code, conflict.reason, {
    against_kind: conflict.against_kind,
    against_id: conflict.against_id,
    against_title: conflict.against_title,
  });
}

export function requirePrintRead(ctx: Ctx): CurrentUser {
  const user = requireUser(ctx);
  if (ctx.actor.type === "agent" && !ctx.scopes?.includes("content:read")) {
    throw new ApiError(403, "insufficient_scope", "The agent grant does not include content:read.");
  }
  if (ctx.actor.type === "user" && user.role === "player") {
    throw new ApiError(
      403,
      "print_read_forbidden",
      "Print proposals are an administrative workflow, not a member surface.",
    );
  }
  return user;
}

export function requirePrintManager(ctx: Ctx): CurrentUser {
  const user = requireUser(ctx);
  if (!canManageContent(ctx)) {
    if (ctx.actor.type === "agent") {
      throw new ApiError(
        403,
        "insufficient_scope",
        "The agent grant does not include content:write.",
      );
    }
    throw new ApiError(
      403,
      "print_management_required",
      "Your role cannot propose print artwork for this Bot.",
    );
  }
  return user;
}

export function requirePrintReviewer(ctx: Ctx): CurrentUser {
  const user = requireUser(ctx);
  if (ctx.actor.type === "agent") {
    // An agent may review only when its grant explicitly carries print:review.
    // The decision is recorded as an agent decision, never as human approval.
    if (!ctx.scopes?.includes("print:review")) {
      throw new ApiError(
        403,
        "print_review_scope_required",
        "This agent grant does not include print:review. A human reviewer or a grant with that explicit scope is required.",
      );
    }
    if (!canManageContent(ctx)) {
      throw new ApiError(
        403,
        "print_review_forbidden",
        "The represented member cannot review print proposals for this Bot.",
      );
    }
    return user;
  }
  if (!user.platformAdmin && user.role !== "owner") {
    throw new ApiError(
      403,
      "print_review_forbidden",
      "Only the Bot Owner or a platform administrator can review print proposals.",
    );
  }
  return user;
}

async function loadCard(ctx: Ctx, cardId: string): Promise<CardRef> {
  const card = await first<CardRef>(
    ctx.db,
    `SELECT id, logical_id, slug, name, status
       FROM fb_card_definitions
      WHERE id = ? AND tenant_id = ? AND archived_at IS NULL`,
    cardId,
    ctx.tenant.id,
  );
  if (!card)
    throw new ApiError(404, "card_not_found", "That subject is not available in this Bot.");
  return card;
}

async function loadAsset(
  ctx: Ctx,
  assetId: string,
  allowedKinds: string[],
): Promise<AssetRow | null> {
  return first<AssetRow>(
    ctx.db,
    `SELECT id, kind, name, mime, width, height, bytes, sha256, visibility,
            access_classification, processing_state, review_status, provenance_json,
            credit, source_repo, source_path, source_commit, source_logical_id,
            derivative_of_asset_id, archived_at
       FROM fb_assets
      WHERE id = ? AND tenant_id = ? AND archived_at IS NULL`,
    assetId,
    ctx.tenant.id,
  ).then((row) => (row && allowedKinds.includes(row.kind) ? row : null));
}

function assertArtworkUsable(asset: AssetRow, forProposal: boolean): void {
  if (asset.review_status === "rejected" || asset.review_status === "placeholder") {
    throw new ApiError(
      422,
      "print_artwork_rejected",
      "That artwork is rejected or a placeholder and cannot be proposed as a print.",
    );
  }
  if (forProposal && asset.processing_state !== "ready") {
    throw new ApiError(
      422,
      "print_artwork_not_ready",
      "That artwork is still processing. Wait for a ready asset before submitting.",
    );
  }
}

function assertSourceUsable(asset: AssetRow): void {
  if (asset.review_status === "rejected") {
    throw new ApiError(
      422,
      "print_source_asset_rejected",
      "That source artwork has been rejected and cannot anchor a print proposal.",
    );
  }
  if (!["ready", "staged"].includes(asset.processing_state)) {
    throw new ApiError(
      422,
      "print_source_asset_not_ready",
      "That source artwork is not ready to anchor a print proposal.",
    );
  }
}

function assetProvenance(asset: AssetRow): Record<string, unknown> {
  return {
    id: asset.id,
    name: asset.name,
    kind: asset.kind,
    sha256: asset.sha256,
    mime: asset.mime,
    width: asset.width,
    height: asset.height,
    review_status: asset.review_status,
    processing_state: asset.processing_state,
    access_classification: asset.access_classification,
    credit: asset.credit,
    source_repo: asset.source_repo,
    source_path: asset.source_path,
    source_commit: asset.source_commit,
    source_logical_id: asset.source_logical_id,
    derivative_of_asset_id: asset.derivative_of_asset_id,
    provenance: parseJson<Record<string, unknown>>(asset.provenance_json, {}),
  };
}

async function loadProposalRow(ctx: Ctx, proposalId: string): Promise<PrintProposalRow> {
  const row = await first<PrintProposalRow>(
    ctx.db,
    "SELECT * FROM fb_print_proposals WHERE id = ? AND tenant_id = ?",
    proposalId,
    ctx.tenant.id,
  );
  if (!row) {
    throw new ApiError(
      404,
      "print_proposal_not_found",
      "That print proposal does not exist in this Bot.",
    );
  }
  return row;
}

async function hydrateProposal(ctx: Ctx, row: PrintProposalRow): Promise<PrintProposalView> {
  const { source_refs_json, provenance_json, finish_keys_json, ...rest } = row;
  const edition = row.approved_edition_id
    ? await first<{ id: string; name: string; status: string }>(
        ctx.db,
        "SELECT id, name, status FROM fb_artwork_editions WHERE id = ? AND tenant_id = ?",
        row.approved_edition_id,
        ctx.tenant.id,
      )
    : null;
  return {
    ...rest,
    source_refs: parseJson<string[]>(source_refs_json, []),
    provenance: parseJson<Record<string, unknown>>(provenance_json, {}),
    finish_keys: parseJson<PrintFinishKey[]>(finish_keys_json, ["plain"]),
    source_asset_url: `/media/asset/${row.source_asset_id}`,
    artwork_url: row.artwork_asset_id ? `/media/asset/${row.artwork_asset_id}` : null,
    background_url: row.background_asset_id ? `/media/asset/${row.background_asset_id}` : null,
    approved_edition: edition,
  };
}

async function candidateList(
  ctx: Ctx,
  cardId: string,
  excludeProposalId?: string,
  options?: { editionStatuses?: string[] },
): Promise<PrintCandidate[]> {
  const proposals = await all<PrintProposalRow & { artwork_sha: string | null }>(
    ctx.db,
    `SELECT p.*, a.sha256 AS artwork_sha
       FROM fb_print_proposals p
       LEFT JOIN fb_assets a
         ON a.id = p.artwork_asset_id AND a.tenant_id = p.tenant_id
      WHERE p.tenant_id = ? AND p.card_id = ?
        ${excludeProposalId ? "AND p.id <> ?" : ""}`,
    ...(excludeProposalId ? [ctx.tenant.id, cardId, excludeProposalId] : [ctx.tenant.id, cardId]),
  );
  const editions = await all<{
    id: string;
    name: string;
    status: string;
    subject_asset_id: string;
    sha256: string | null;
  }>(
    ctx.db,
    `SELECT e.id, e.name, e.status, e.subject_asset_id, a.sha256
       FROM fb_artwork_editions e
       LEFT JOIN fb_assets a
         ON a.id = e.subject_asset_id AND a.tenant_id = e.tenant_id
      WHERE e.tenant_id = ? AND e.card_id = ? AND e.archived_at IS NULL`,
    ctx.tenant.id,
    cardId,
  );
  return [
    ...proposals.map((row) => ({
      id: row.id,
      kind: "proposal" as const,
      role: row.role,
      title: row.title,
      creativeDirection: row.creative_direction,
      artworkFingerprint: row.artwork_sha?.trim().toLowerCase() ?? null,
      finishKeys: parseJson<string[]>(row.finish_keys_json, []),
      status: row.status,
    })),
    ...editions
      .filter((row) => !options?.editionStatuses || options.editionStatuses.includes(row.status))
      .map((row) => ({
        id: row.id,
        kind: "edition" as const,
        role: null,
        title: row.name,
        creativeDirection: "",
        artworkFingerprint: row.sha256?.trim().toLowerCase() ?? null,
        finishKeys: [],
        status: row.status,
      })),
  ];
}

function assertProposalReady(input: {
  artwork: AssetRow | null;
  sourceRefs: string[];
  rightsNote: string | null;
  artworkCredit: string | null;
}): void {
  if (!input.artwork) {
    throw new ApiError(
      422,
      "print_artwork_required",
      "A print proposal needs its own approved artwork before it can be submitted.",
    );
  }
  assertArtworkUsable(input.artwork, true);
  if (!input.sourceRefs.length && !input.rightsNote && !input.artworkCredit?.trim()) {
    throw new ApiError(
      422,
      "print_provenance_required",
      "Record a source reference, rights note or artwork credit before submitting.",
    );
  }
}

function assertRevisionMatches(row: PrintProposalRow, expectedRevision?: number): void {
  if (expectedRevision !== undefined && expectedRevision !== row.revision) {
    throw new ApiError(
      409,
      "stale_print_proposal_revision",
      "This print proposal changed. Reload it before trying again.",
      { current_revision: row.revision },
    );
  }
}

async function insertReview(
  ctx: Ctx,
  proposalId: string,
  revision: number,
  decision: PrintProposalReviewRow["decision"],
  reviewerId: string,
  note: string | null,
): Promise<void> {
  await statement(
    ctx.db,
    `INSERT INTO fb_print_proposal_reviews
       (id, tenant_id, proposal_id, revision, decision, reviewer_id, reviewer_kind, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    newId("prv"),
    ctx.tenant.id,
    proposalId,
    revision,
    decision,
    reviewerId,
    ctx.actor.type === "agent" ? "agent" : "human",
    note,
    nowIso(),
  ).run();
}

export async function createPrintProposal(
  ctx: Ctx,
  input: PrintProposalInput,
): Promise<PrintProposalView> {
  const user = requirePrintManager(ctx);
  const card = await loadCard(ctx, input.cardId);
  const fields = validatePrintFields({
    role: input.role,
    title: input.title,
    creativeDirection: input.creativeDirection,
    finishKeys: input.finishKeys,
  });
  const printNumber = normalizePrintNumber(input.printNumber);
  const printKey = `${card.logical_id}:${printNumber}`;
  const sourceRefs = normalizeSourceRefs(input.sourceRefs);
  const rightsNote = normalizeNote(input.rightsNote, 500);
  const status = input.status ?? "draft";
  if (!["draft", "proposed"].includes(status)) {
    throw new ApiError(
      422,
      "print_status_invalid",
      "Create a proposal as a draft or submit it for review. Approval is a separate human action.",
    );
  }

  const sourceAsset = await loadAsset(ctx, input.sourceAssetId, ["subject"]);
  if (!sourceAsset) {
    throw new ApiError(
      422,
      "print_source_asset_invalid",
      "Choose an existing subject asset from this Bot as the identity source.",
    );
  }
  assertSourceUsable(sourceAsset);

  const artworkAsset = input.artworkAssetId
    ? await loadAsset(ctx, input.artworkAssetId, ["subject"])
    : null;
  if (input.artworkAssetId && !artworkAsset) {
    throw new ApiError(
      422,
      "print_artwork_invalid",
      "Choose an existing subject artwork asset from this Bot as the print artwork.",
    );
  }
  if (artworkAsset) assertArtworkUsable(artworkAsset, status === "proposed");

  const backgroundAsset = input.backgroundAssetId
    ? await loadAsset(ctx, input.backgroundAssetId, ["background"])
    : null;
  if (input.backgroundAssetId && !backgroundAsset) {
    throw new ApiError(
      422,
      "print_background_invalid",
      "Choose an existing background asset from this Bot.",
    );
  }

  if (status === "proposed") {
    assertProposalReady({
      artwork: artworkAsset,
      sourceRefs,
      rightsNote,
      artworkCredit: artworkAsset?.credit ?? null,
    });
  }

  const inUse = await first<{ id: string }>(
    ctx.db,
    `SELECT id FROM fb_print_proposals
      WHERE tenant_id = ? AND card_id = ? AND (print_number = ? OR print_key = ?)`,
    ctx.tenant.id,
    card.id,
    printNumber,
    printKey,
  );
  if (inUse) {
    throw new ApiError(
      409,
      "print_number_in_use",
      "That print number is already reserved for this subject.",
    );
  }

  const existing = await candidateList(ctx, card.id);
  const candidate: PrintCandidate = {
    id: "new-proposal",
    kind: "proposal",
    role: fields.role,
    title: fields.title,
    creativeDirection: fields.creativeDirection,
    artworkFingerprint: artworkAsset
      ? assetFingerprint({ id: artworkAsset.id, sha256: artworkAsset.sha256 })
      : null,
    finishKeys: fields.finishKeys,
  };
  assertDistinctPrintCandidate(existing, candidate);

  const now = nowIso();
  const id = newId("prp");
  const provenance = {
    ...(input.provenance ?? {}),
    source_asset: assetProvenance(sourceAsset),
    artwork_asset: artworkAsset ? assetProvenance(artworkAsset) : null,
    background_asset: backgroundAsset ? assetProvenance(backgroundAsset) : null,
    captured_at: now,
  };
  const statements = [
    ctx.db
      .prepare(
        `INSERT INTO fb_print_proposals
          (id, tenant_id, card_id, print_number, print_key, role, title, creative_direction,
           source_asset_id, artwork_asset_id, background_asset_id, rights_note,
           source_refs_json, provenance_json, finish_keys_json, status, revision,
           created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .bind(
        id,
        ctx.tenant.id,
        card.id,
        printNumber,
        printKey,
        fields.role,
        fields.title,
        fields.creativeDirection,
        sourceAsset.id,
        artworkAsset?.id ?? null,
        backgroundAsset?.id ?? null,
        rightsNote,
        JSON.stringify(sourceRefs),
        JSON.stringify(provenance),
        JSON.stringify(fields.finishKeys),
        status,
        user.id,
        now,
        now,
      ),
  ];
  if (status === "proposed") {
    statements.push(
      ctx.db
        .prepare(
          `INSERT INTO fb_print_proposal_reviews
            (id, tenant_id, proposal_id, revision, decision, reviewer_id, reviewer_kind, note, created_at)
           VALUES (?, ?, ?, 1, 'submitted', ?, ?, ?, ?)`,
        )
        .bind(
          newId("prv"),
          ctx.tenant.id,
          id,
          user.id,
          ctx.actor.type === "agent" ? "agent" : "human",
          "Submitted for print review.",
          now,
        ),
    );
  }
  statements.push(
    auditStatement(ctx, "print.proposal.created", "print_proposal", id, {
      card_id: card.id,
      print_number: printNumber,
      print_key: printKey,
      role: fields.role,
      title: fields.title,
      status,
      artwork_asset_id: artworkAsset?.id ?? null,
    }),
  );
  try {
    await ctx.db.batch(statements);
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) {
      throw new ApiError(
        409,
        "print_number_in_use",
        "That print number or stable print key is already in use.",
      );
    }
    throw error;
  }
  return hydrateProposal(ctx, await loadProposalRow(ctx, id));
}

export async function getPrintProposal(ctx: Ctx, proposalId: string): Promise<PrintProposalView> {
  requirePrintRead(ctx);
  return hydrateProposal(ctx, await loadProposalRow(ctx, proposalId));
}

export async function listPrintProposals(ctx: Ctx, cardId: string): Promise<PrintProposalView[]> {
  requirePrintRead(ctx);
  await loadCard(ctx, cardId);
  const rows = await all<PrintProposalRow>(
    ctx.db,
    `SELECT * FROM fb_print_proposals
      WHERE tenant_id = ? AND card_id = ?
      ORDER BY print_number, created_at`,
    ctx.tenant.id,
    cardId,
  );
  return Promise.all(rows.map((row) => hydrateProposal(ctx, row)));
}

export async function listPrintProposalReviews(
  ctx: Ctx,
  proposalId: string,
): Promise<PrintProposalReviewRow[]> {
  requirePrintRead(ctx);
  await loadProposalRow(ctx, proposalId);
  return all<PrintProposalReviewRow>(
    ctx.db,
    `SELECT id, proposal_id, revision, decision, reviewer_id, reviewer_kind, note, created_at
       FROM fb_print_proposal_reviews
      WHERE tenant_id = ? AND proposal_id = ?
      ORDER BY revision, created_at`,
    ctx.tenant.id,
    proposalId,
  );
}

export async function submitPrintProposal(
  ctx: Ctx,
  proposalId: string,
  options?: { expectedRevision?: number; note?: string },
): Promise<PrintProposalView> {
  const user = requirePrintManager(ctx);
  const row = await loadProposalRow(ctx, proposalId);
  assertRevisionMatches(row, options?.expectedRevision);
  if (row.status !== "draft") {
    throw new ApiError(
      409,
      "invalid_transition",
      `A ${row.status} print proposal cannot be submitted again.`,
    );
  }
  const artwork = row.artwork_asset_id
    ? await loadAsset(ctx, row.artwork_asset_id, ["subject"])
    : null;
  const sourceRefs = parseJson<string[]>(row.source_refs_json, []);
  assertProposalReady({
    artwork,
    sourceRefs,
    rightsNote: row.rights_note,
    artworkCredit: artwork?.credit ?? null,
  });
  const now = nowIso();
  const updated = await run(
    ctx.db,
    `UPDATE fb_print_proposals
        SET status = 'proposed', revision = revision + 1, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND status = 'draft' AND revision = ?`,
    now,
    row.id,
    ctx.tenant.id,
    row.revision,
  );
  if (updated.changes === 0) {
    throw new ApiError(
      409,
      "stale_print_proposal_revision",
      "This print proposal changed. Reload it before submitting.",
    );
  }
  await insertReview(
    ctx,
    row.id,
    row.revision + 1,
    "submitted",
    user.id,
    normalizeNote(options?.note) ?? "Submitted for print review.",
  );
  await auditStatement(ctx, "print.proposal.submitted", "print_proposal", row.id, {
    revision: row.revision + 1,
  }).run();
  return hydrateProposal(ctx, await loadProposalRow(ctx, row.id));
}

export async function reviewPrintProposal(
  ctx: Ctx,
  proposalId: string,
  decision: "approved" | "rejected",
  options?: { note?: string; expectedRevision?: number },
): Promise<PrintProposalView> {
  const reviewer = requirePrintReviewer(ctx);
  const row = await loadProposalRow(ctx, proposalId);
  assertRevisionMatches(row, options?.expectedRevision);
  if (row.status !== "proposed") {
    throw new ApiError(
      409,
      "invalid_transition",
      `A ${row.status} print proposal cannot be ${decision}.`,
    );
  }
  const note = normalizeNote(options?.note);
  if (decision === "rejected" && !note) {
    throw new ApiError(
      422,
      "print_rejection_note_required",
      "Record why the print was rejected so the artwork can be revised deliberately.",
    );
  }
  if (decision === "approved") {
    const artwork = row.artwork_asset_id
      ? await loadAsset(ctx, row.artwork_asset_id, ["subject"])
      : null;
    if (!artwork) {
      throw new ApiError(
        422,
        "print_artwork_required",
        "This proposal no longer has a usable artwork asset.",
      );
    }
    assertArtworkUsable(artwork, true);
    // Re-check at the decision boundary: a published or retired edition may
    // have appeared after submission. Draft editions are allowed because they
    // can be the intended edition created for composition preview and linked
    // after approval.
    const existing = await candidateList(ctx, row.card_id, row.id, {
      editionStatuses: ["published", "retired"],
    });
    assertDistinctPrintCandidate(existing, {
      id: row.id,
      kind: "proposal",
      role: row.role,
      title: row.title,
      creativeDirection: row.creative_direction,
      artworkFingerprint: assetFingerprint(artwork),
      finishKeys: parseJson<string[]>(row.finish_keys_json, []),
    });
  }

  const now = nowIso();
  const updated = await run(
    ctx.db,
    `UPDATE fb_print_proposals
        SET status = ?, reviewed_by = ?, reviewer_kind = ?, reviewed_at = ?, review_note = ?,
            approved_at = CASE WHEN ? = 'approved' THEN ? ELSE approved_at END,
            revision = revision + 1, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND status = 'proposed' AND revision = ?`,
    decision,
    reviewer.id,
    ctx.actor.type === "agent" ? "agent" : "human",
    now,
    note,
    decision,
    now,
    now,
    row.id,
    ctx.tenant.id,
    row.revision,
  );
  if (updated.changes === 0) {
    throw new ApiError(
      409,
      "stale_print_proposal_revision",
      "This print proposal changed. Reload it before reviewing.",
    );
  }
  await insertReview(ctx, row.id, row.revision + 1, decision, reviewer.id, note);
  await auditStatement(
    ctx,
    decision === "approved" ? "print.proposal.approved" : "print.proposal.rejected",
    "print_proposal",
    row.id,
    { revision: row.revision + 1, note },
  ).run();
  return hydrateProposal(ctx, await loadProposalRow(ctx, row.id));
}

export async function revisePrintProposal(
  ctx: Ctx,
  proposalId: string,
  input: PrintProposalRevisionInput,
  options?: { expectedRevision?: number },
): Promise<PrintProposalView> {
  const user = requirePrintManager(ctx);
  const row = await loadProposalRow(ctx, proposalId);
  assertRevisionMatches(row, options?.expectedRevision);
  if (!["draft", "rejected"].includes(row.status)) {
    throw new ApiError(
      409,
      "invalid_transition",
      `A ${row.status} print proposal cannot be revised. Revise only drafts or rejected proposals.`,
    );
  }
  const card = await loadCard(ctx, row.card_id);
  const fields = validatePrintFields({
    role: input.role ?? row.role,
    title: input.title ?? row.title,
    creativeDirection: input.creativeDirection ?? row.creative_direction,
    finishKeys: input.finishKeys ?? parseJson<string[]>(row.finish_keys_json, ["plain"]),
  });
  const sourceAssetId = input.sourceAssetId ?? row.source_asset_id;
  const sourceAsset = await loadAsset(ctx, sourceAssetId, ["subject"]);
  if (!sourceAsset) {
    throw new ApiError(
      422,
      "print_source_asset_invalid",
      "Choose an existing subject asset from this Bot as the identity source.",
    );
  }
  assertSourceUsable(sourceAsset);
  const artworkAssetId =
    input.artworkAssetId === undefined ? row.artwork_asset_id : input.artworkAssetId;
  const artworkAsset = artworkAssetId ? await loadAsset(ctx, artworkAssetId, ["subject"]) : null;
  if (artworkAssetId && !artworkAsset) {
    throw new ApiError(
      422,
      "print_artwork_invalid",
      "Choose an existing subject artwork asset from this Bot as the print artwork.",
    );
  }
  if (artworkAsset) assertArtworkUsable(artworkAsset, false);

  const backgroundAssetId =
    input.backgroundAssetId === undefined ? row.background_asset_id : input.backgroundAssetId;
  const backgroundAsset = backgroundAssetId
    ? await loadAsset(ctx, backgroundAssetId, ["background"])
    : null;
  if (backgroundAssetId && !backgroundAsset) {
    throw new ApiError(
      422,
      "print_background_invalid",
      "Choose an existing background asset from this Bot.",
    );
  }

  const existing = await candidateList(ctx, card.id, row.id);
  assertDistinctPrintCandidate(existing, {
    id: row.id,
    kind: "proposal",
    role: fields.role,
    title: fields.title,
    creativeDirection: fields.creativeDirection,
    artworkFingerprint: artworkAsset
      ? assetFingerprint({ id: artworkAsset.id, sha256: artworkAsset.sha256 })
      : null,
    finishKeys: fields.finishKeys,
  });

  const sourceRefs =
    input.sourceRefs === undefined
      ? parseJson<string[]>(row.source_refs_json, [])
      : normalizeSourceRefs(input.sourceRefs);
  const rightsNote =
    input.rightsNote === undefined ? row.rights_note : normalizeNote(input.rightsNote, 500);
  const now = nowIso();
  const provenance = {
    ...parseJson<Record<string, unknown>>(row.provenance_json, {}),
    source_asset: assetProvenance(sourceAsset),
    artwork_asset: artworkAsset ? assetProvenance(artworkAsset) : null,
    background_asset: backgroundAsset ? assetProvenance(backgroundAsset) : null,
    revised_at: now,
  };
  const updated = await run(
    ctx.db,
    `UPDATE fb_print_proposals
        SET role = ?, title = ?, creative_direction = ?, source_asset_id = ?,
            artwork_asset_id = ?, background_asset_id = ?, rights_note = ?,
            source_refs_json = ?, provenance_json = ?, finish_keys_json = ?,
            status = 'draft', reviewed_by = NULL, reviewed_at = NULL,
            review_note = NULL, approved_at = NULL, revision = revision + 1,
            updated_at = ?
      WHERE id = ? AND tenant_id = ? AND status IN ('draft','rejected') AND revision = ?`,
    fields.role,
    fields.title,
    fields.creativeDirection,
    sourceAsset.id,
    artworkAsset?.id ?? null,
    backgroundAsset?.id ?? null,
    rightsNote,
    JSON.stringify(sourceRefs),
    JSON.stringify(provenance),
    JSON.stringify(fields.finishKeys),
    now,
    row.id,
    ctx.tenant.id,
    row.revision,
  );
  if (updated.changes === 0) {
    throw new ApiError(
      409,
      "stale_print_proposal_revision",
      "This print proposal changed. Reload it before revising.",
    );
  }
  await insertReview(
    ctx,
    row.id,
    row.revision + 1,
    "revised",
    user.id,
    normalizeNote(input.note) ?? "Revised print proposal.",
  );
  await auditStatement(ctx, "print.proposal.revised", "print_proposal", row.id, {
    revision: row.revision + 1,
    artwork_asset_id: artworkAsset?.id ?? null,
  }).run();
  return hydrateProposal(ctx, await loadProposalRow(ctx, row.id));
}

export async function linkApprovedEdition(
  ctx: Ctx,
  proposalId: string,
  editionId: string,
  options?: { expectedRevision?: number },
): Promise<PrintProposalView> {
  const reviewer = requirePrintReviewer(ctx);
  const row = await loadProposalRow(ctx, proposalId);
  assertRevisionMatches(row, options?.expectedRevision);
  if (row.status !== "approved") {
    throw new ApiError(
      409,
      "print_not_approved",
      "Only an approved print proposal can be linked to an artwork edition.",
    );
  }
  if (row.approved_edition_id) {
    if (row.approved_edition_id === editionId) {
      return hydrateProposal(ctx, row);
    }
    throw new ApiError(
      409,
      "print_edition_already_linked",
      "This proposal is already linked to a different artwork edition.",
      { approved_edition_id: row.approved_edition_id },
    );
  }
  const edition = await first<EditionRef>(
    ctx.db,
    `SELECT id, card_id, name, status, subject_asset_id, archived_at
       FROM fb_artwork_editions
      WHERE id = ? AND tenant_id = ?`,
    editionId,
    ctx.tenant.id,
  );
  if (!edition || edition.archived_at || edition.card_id !== row.card_id) {
    throw new ApiError(
      422,
      "print_edition_invalid",
      "Choose a live artwork edition for the same subject.",
    );
  }
  if (!row.artwork_asset_id || edition.subject_asset_id !== row.artwork_asset_id) {
    throw new ApiError(
      422,
      "print_edition_artwork_mismatch",
      "The artwork edition must use exactly the approved print artwork.",
    );
  }
  const now = nowIso();
  const updated = await run(
    ctx.db,
    `UPDATE fb_print_proposals
        SET approved_edition_id = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND status = 'approved'
        AND approved_edition_id IS NULL AND revision = ?`,
    edition.id,
    now,
    row.id,
    ctx.tenant.id,
    row.revision,
  );
  if (updated.changes === 0) {
    throw new ApiError(
      409,
      "stale_print_proposal_revision",
      "This print proposal changed. Reload it before linking the edition.",
    );
  }
  await insertReview(
    ctx,
    row.id,
    row.revision + 1,
    "linked",
    reviewer.id,
    `Linked to artwork edition ${edition.name}.`,
  );
  await auditStatement(ctx, "print.proposal.edition_linked", "print_proposal", row.id, {
    revision: row.revision + 1,
    edition_id: edition.id,
    edition_name: edition.name,
  }).run();
  return hydrateProposal(ctx, await loadProposalRow(ctx, row.id));
}

export async function printCoverageForCard(ctx: Ctx, cardId: string): Promise<PrintCoverage> {
  requirePrintRead(ctx);
  await loadCard(ctx, cardId);
  const rows = await all<{ status: PrintProposalStatus; count: number }>(
    ctx.db,
    `SELECT status, COUNT(*) AS count
       FROM fb_print_proposals
      WHERE tenant_id = ? AND card_id = ?
      GROUP BY status`,
    ctx.tenant.id,
    cardId,
  );
  const byStatus: Record<PrintProposalStatus, number> = {
    draft: 0,
    proposed: 0,
    approved: 0,
    rejected: 0,
  };
  for (const row of rows) byStatus[row.status] = Number(row.count);
  const aggregate = await first<{
    approved: number;
    distinct_artwork: number;
    linked: number;
  }>(
    ctx.db,
    `SELECT COUNT(*) AS approved,
            COUNT(DISTINCT COALESCE(a.sha256, p.artwork_asset_id)) AS distinct_artwork,
            SUM(CASE WHEN p.approved_edition_id IS NOT NULL THEN 1 ELSE 0 END) AS linked
       FROM fb_print_proposals p
       LEFT JOIN fb_assets a
         ON a.id = p.artwork_asset_id AND a.tenant_id = p.tenant_id
      WHERE p.tenant_id = ? AND p.card_id = ? AND p.status = 'approved'`,
    ctx.tenant.id,
    cardId,
  );
  const approved = Number(aggregate?.approved ?? 0);
  const distinct = Number(aggregate?.distinct_artwork ?? 0);
  const linked = Number(aggregate?.linked ?? 0);
  const minimumMet = approved >= 2 && distinct >= 2;
  const label: PrintCoverage["label"] =
    approved === 0
      ? byStatus.proposed > 0
        ? "in_review"
        : byStatus.draft > 0
          ? "planning"
          : "not_started"
      : approved === 1
        ? "single_print_requires_exception"
        : "minimum_met";
  return {
    card_id: cardId,
    total: byStatus.draft + byStatus.proposed + byStatus.approved + byStatus.rejected,
    by_status: byStatus,
    approved_prints: approved,
    distinct_approved_artwork: distinct,
    linked_editions: linked,
    minimum_met: minimumMet,
    recommended_third: approved === 2,
    label,
  };
}

export interface OriginalIpVerticalSliceInput {
  cardId: string;
  subjectName: string;
  sourceAssetId: string;
  artworkAssetIds?: Partial<Record<"portrait" | "action_scene" | "alternate_art", string | null>>;
  sourceRefs?: string[];
}

export interface OriginalIpVerticalSlicePrint {
  role: "portrait" | "action_scene" | "alternate_art";
  printNumber: string;
  workingTitle: string;
  creativeDirection: string;
  distinctness: string;
  finishKeys: PrintFinishKey[];
  artworkAssetId: string | null;
  requiresNewArtwork: boolean;
}

export interface OriginalIpVerticalSlicePlan {
  cardId: string;
  subjectName: string;
  sourceAssetId: string;
  sourceRefs: string[];
  prints: OriginalIpVerticalSlicePrint[];
  reviewGates: string[];
  rolloutTracking: string;
}

/**
 * One bounded original-IP vertical slice: a portrait, an action/scene print and
 * an alternate-art print. This is a plan, not generated art. Artwork ids are
 * only filled when the caller already has an approved asset; no asset is created
 * and no provider is called.
 */
export function originalIpVerticalSlicePlan(
  input: OriginalIpVerticalSliceInput,
): OriginalIpVerticalSlicePlan {
  const subjectName = input.subjectName.trim();
  if (!subjectName) {
    throw new ApiError(422, "print_subject_required", "Name the original-IP subject.");
  }
  if (!input.cardId) {
    throw new ApiError(422, "print_card_required", "Choose the existing subject card.");
  }
  if (!input.sourceAssetId) {
    throw new ApiError(422, "print_source_asset_required", "Choose the identity source asset.");
  }
  const artwork = input.artworkAssetIds ?? {};
  const sourceRefs = normalizeSourceRefs(input.sourceRefs);
  return {
    cardId: input.cardId,
    subjectName,
    sourceAssetId: input.sourceAssetId,
    sourceRefs,
    prints: [
      {
        role: "portrait",
        printNumber: "01",
        workingTitle: `${subjectName} · Portrait`,
        creativeDirection:
          "A deliberate three-quarter portrait in the collection palette, with a restrained graphic ground and a clear silhouette that stays legible at thumbnail size.",
        distinctness:
          "Identity-first plate: the calm, collectable portrait that anchors the subject before the more expressive prints.",
        finishKeys: ["plain", "silver", "gold", "holographic"],
        artworkAssetId: artwork.portrait ?? null,
        requiresNewArtwork: !artwork.portrait,
      },
      {
        role: "action_scene",
        printNumber: "02",
        workingTitle: `${subjectName} · Action scene`,
        creativeDirection:
          "A new narrative action moment with dynamic diagonal composition, environmental depth and motion cues, while keeping the subject's identity anchors readable at card scale.",
        distinctness:
          "Scene plate: a different pose, setting and camera angle, authored as an action beat rather than a recolour of the portrait.",
        finishKeys: ["plain", "silver", "gold"],
        artworkAssetId: artwork.action_scene ?? null,
        requiresNewArtwork: !artwork.action_scene,
      },
      {
        role: "alternate_art",
        printNumber: "03",
        workingTitle: `${subjectName} · Alternate art`,
        creativeDirection:
          "A full-bleed illustrative alternate treatment in a genuinely different art medium and colour story, composed as a distinct collectable artwork rather than a filter over the portrait.",
        distinctness:
          "Art-directed alternate: a different medium, composition and mood that collectors can recognise as its own print.",
        finishKeys: ["plain", "gold", "holographic"],
        artworkAssetId: artwork.alternate_art ?? null,
        requiresNewArtwork: !artwork.alternate_art,
      },
    ],
    reviewGates: [
      "Human identity and likeness comparison against the reviewed source pack",
      "Source, rights and provenance review before any paid generation or publication",
      "Print-versus-finish check: different artwork and composition, not a renamed finish",
      "Front and back composition at the 5:7 card contract, including thumbnail legibility",
      "Explicit human approval for each print before an edition is linked or published",
      "Recorded budget ceiling and owner approval before any paid generation batch",
    ],
    rolloutTracking: "docs/MULTI_PRINT.md",
  };
}

export async function createOriginalIpVerticalSlice(
  ctx: Ctx,
  input: OriginalIpVerticalSliceInput,
): Promise<{
  plan: OriginalIpVerticalSlicePlan;
  proposals: PrintProposalView[];
}> {
  requirePrintManager(ctx);
  const plan = originalIpVerticalSlicePlan(input);
  const proposals: PrintProposalView[] = [];
  for (const print of plan.prints) {
    proposals.push(
      await createPrintProposal(ctx, {
        cardId: plan.cardId,
        printNumber: print.printNumber,
        role: print.role,
        title: print.workingTitle,
        creativeDirection: print.creativeDirection,
        sourceAssetId: plan.sourceAssetId,
        artworkAssetId: print.artworkAssetId,
        sourceRefs: plan.sourceRefs,
        provenance: {
          vertical_slice: "original-ip",
          distinctness: print.distinctness,
        },
        finishKeys: print.finishKeys,
        status: "draft",
      }),
    );
  }
  return { plan, proposals };
}
