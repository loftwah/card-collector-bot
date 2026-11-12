import { BRAND_ASSETS } from "../../lib/brand-catalogue";
import { CARD_STYLES } from "../../lib/card-styles";
import type { ArtTaste, ArtTastePiece } from "../../lib/art-taste";
import {
  AFTER_THE_TIDE,
  REFERENCE_PRINTS,
  STUDIO_IMAGE_BASE,
  STUDIO_STUDIES,
} from "../../lib/studio-resources";
import { ApiError, requireUser, type Ctx } from "../context";
import { all, first, nowIso } from "../db";
import { listArtBriefs } from "./art-lab";
import { listCollections } from "./collections";

function requireTasteOperator(ctx: Ctx) {
  const user = requireUser(ctx);
  if (
    ctx.actor.type !== "user" ||
    (!user.platformAdmin && !user.globalCollectionScope && !["owner", "editor"].includes(user.role))
  ) {
    throw new ApiError(
      403,
      "art_taste_forbidden",
      "Sign in to a Studio art workspace to review artwork.",
    );
  }
  return user;
}

const duplicateExports = new Set(["og-master", "banner-standard-960", "share-banner"]);
const studioPieces: ArtTastePiece[] = [
  ...[...STUDIO_STUDIES, AFTER_THE_TIDE].map((study): ArtTastePiece => ({
    id: `studio:${study.file}`,
    kind: "studies",
    name: study.title,
    caption: study.kind,
    image: `${STUDIO_IMAGE_BASE}/${study.file}`,
    width: study.width,
    height: study.height,
    provenance: `Codex ImageGen. ${study.use}`,
  })),
  ...REFERENCE_PRINTS.map((print): ArtTastePiece => ({
    id: `studio:${print.file}`,
    kind: "studies",
    name: print.title,
    caption: "Reference print",
    image: `${STUDIO_IMAGE_BASE}/${print.file}`,
    width: print.width,
    height: print.height,
    provenance: `${print.credit}. ${print.rights}. ${print.use}`,
  })),
];
const brandPieces: ArtTastePiece[] = [
  ...BRAND_ASSETS.filter(
    (asset) => asset.kind !== "card_styles" && !duplicateExports.has(asset.id),
  ).map((asset): ArtTastePiece => ({
    id: `brand:${asset.id}:${asset.path}`,
    kind: asset.kind === "icons" || asset.kind === "mascots" ? asset.kind : "brand",
    name: asset.label,
    caption: asset.kind.replaceAll("_", " "),
    image: asset.path,
    width: asset.width,
    height: asset.height,
    provenance: asset.note,
  })),
  ...CARD_STYLES.map((style): ArtTastePiece => ({
    id: `style:${style.key}:${style.thumb}`,
    kind: "styles",
    name: style.label,
    caption: "Card style",
    image: style.thumb,
    width: 480,
    height: 480,
    provenance: style.note,
  })),
];

function candidatePieces(
  { pins, permissions }: Awaited<ReturnType<typeof listArtBriefs>>,
  collections: Set<string>,
): ArtTastePiece[] {
  return pins
    .filter((pin) => !pin.collection_id || collections.has(pin.collection_id))
    .map((pin) => ({
      id: `candidate:${pin.candidate_id}`,
      kind: "candidates",
      name: pin.card_name ?? pin.brief_title,
      caption: `${pin.label} · ${pin.brief_title}`,
      image: pin.image_url,
      back: pin.back_url ?? undefined,
      width: pin.width,
      height: pin.height,
      collection: pin.collection_name,
      status: pin.status,
      brief: pin.brief_id,
      candidateReview:
        permissions.write && !["approved", "published"].includes(pin.status)
          ? {
              endpoint: `/api/v1/studio/art/candidates/${pin.candidate_id}/feedback`,
              likes: pin.review_likes,
              dislikes: pin.review_dislikes,
              decision: pin.review_decision,
            }
          : undefined,
    }));
}

async function visibleCollections(ctx: Ctx) {
  return (await listCollections(ctx, { includeAll: true })).filter(
    (collection) => collection.manageable,
  );
}

function collectionPieces(
  collections: Awaited<ReturnType<typeof visibleCollections>>,
): ArtTastePiece[] {
  return collections.flatMap((collection) => {
    const sources = [
      ["Banner", collection.banner_url, collection.banner_asset_id],
      ["Mark", collection.logo_url, collection.logo_asset_id],
    ] as const;
    return sources.flatMap(([caption, image, assetId]): ArtTastePiece[] =>
      image
        ? [
            {
              id: `collection:${collection.id}:${caption}:${assetId ?? image}`,
              kind: "collections",
              name: collection.name,
              caption,
              image,
              collection: collection.name,
            },
          ]
        : [],
    );
  });
}

export async function listArtTaste(ctx: Ctx): Promise<{ pieces: ArtTastePiece[] }> {
  const user = requireTasteOperator(ctx);
  const [collections, saved, briefs] = await Promise.all([
    visibleCollections(ctx),
    all<ArtTaste & { piece_id: string }>(
      ctx.db,
      "SELECT piece_id, grade, note FROM fb_art_taste WHERE tenant_id = ? AND user_id = ?",
      ctx.tenant.id,
      user.id,
    ),
    listArtBriefs(ctx, { category: "cards" }),
  ]);
  const candidates = candidatePieces(briefs, new Set(collections.map(({ id }) => id)));
  const tastes = new Map(saved.map(({ piece_id, grade, note }) => [piece_id, { grade, note }]));
  return {
    pieces: [...studioPieces, ...candidates, ...collectionPieces(collections), ...brandPieces].map(
      (piece) => ({
        ...piece,
        taste: tastes.get(piece.id),
      }),
    ),
  };
}

export async function saveArtTaste(
  ctx: Ctx,
  pieceId: string,
  patch: Partial<ArtTaste>,
): Promise<ArtTaste> {
  const user = requireTasteOperator(ctx);
  const isCandidate = pieceId.startsWith("candidate:");
  const [collections, briefs] = await Promise.all([
    isCandidate || pieceId.startsWith("collection:") ? visibleCollections(ctx) : null,
    isCandidate ? listArtBriefs(ctx, { category: "cards" }) : null,
  ]);
  const pieces =
    briefs && collections
      ? candidatePieces(briefs, new Set(collections.map(({ id }) => id)))
      : collections
        ? collectionPieces(collections)
        : [...studioPieces, ...brandPieces];
  if (!pieces.some((piece) => piece.id === pieceId)) {
    throw new ApiError(
      404,
      "art_piece_not_found",
      "This artwork is no longer available on your wall.",
    );
  }
  const saved = await first<ArtTaste>(
    ctx.db,
    `INSERT INTO fb_art_taste (tenant_id, user_id, piece_id, grade, note, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (tenant_id, user_id, piece_id) DO UPDATE SET
       grade = CASE WHEN ? THEN excluded.grade ELSE fb_art_taste.grade END,
       note = CASE WHEN ? THEN excluded.note ELSE fb_art_taste.note END,
       updated_at = excluded.updated_at
     RETURNING grade, note`,
    ctx.tenant.id,
    user.id,
    pieceId,
    patch.grade ?? null,
    patch.note?.trim() ?? "",
    nowIso(),
    patch.grade === undefined ? 0 : 1,
    patch.note === undefined ? 0 : 1,
  );
  return saved!;
}
