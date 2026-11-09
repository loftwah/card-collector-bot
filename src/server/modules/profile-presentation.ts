import { ApiError, type Ctx } from "../context";
import { listAchievements } from "./achievements";
import { getInventory, type InventoryRow } from "./collection";
import { listCollections } from "./collections";
import { displayFinish, printTitle } from "../../lib/utils";

import {
  DEFAULT_PROFILE_PRESENTATION,
  PROFILE_AVATAR_DECORATIONS,
  PROFILE_EFFECTS,
  PROFILE_FRAMES,
  PROFILE_NAME_TREATMENTS,
  type ProfileAvatarDecoration,
  type ProfileEffect,
  type ProfileFrame,
  type ProfileNameTreatment,
  type ProfilePresentationSelection,
} from "../../lib/profile-presentation";

export {
  PROFILE_AVATAR_DECORATIONS,
  PROFILE_EFFECTS,
  PROFILE_FRAMES,
  PROFILE_NAME_TREATMENTS,
};
export type {
  ProfileAvatarDecoration,
  ProfileEffect,
  ProfileFrame,
  ProfileNameTreatment,
  ProfilePresentationSelection,
};

export interface ProfileCopyView {
  id: string;
  cardId: string;
  cardName: string;
  variantName: string;
  finish: string;
  serial: string;
  renderUrl: string | null;
  thumbnailUrl: string | null;
  favourite: boolean;
}

export interface ProfileBadgeView {
  id: string;
  name: string;
  category: string;
  artKey: string;
  collectionLogoUrl: string | null;
}

export interface ProfilePresentationOptions {
  collections: Array<{
    id: string;
    slug: string;
    name: string;
    logoUrl: string | null;
    bannerUrl: string | null;
    coverUrl: string | null;
  }>;
  copies: ProfileCopyView[];
  badges: ProfileBadgeView[];
}

export interface ResolvedProfilePortrait {
  key: string;
  kind: "monogram" | "collection";
  label: string;
  imageUrl: string | null;
}

export interface ResolvedProfileBanner {
  key: string;
  kind: "none" | "collection";
  label: string;
  imageUrl: string | null;
}

export interface ResolvedProfilePresentation {
  version: number;
  selection: ProfilePresentationSelection;
  portrait: ResolvedProfilePortrait;
  banner: ResolvedProfileBanner;
  featured: ProfileCopyView | null;
  favourites: ProfileCopyView[];
  badges: ProfileBadgeView[];
  fallbackNotes: string[];
}

function isOneOf<T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function uniqueIds(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && item.length <= 80))].slice(0, max);
}

function collectionKey(value: string): string | null {
  return value.startsWith("collection:") ? value.slice("collection:".length) : null;
}

export function parseProfilePresentation(raw: string | null | undefined): ProfilePresentationSelection {
  if (!raw) return { ...DEFAULT_PROFILE_PRESENTATION, favouriteInstanceIds: [], badgeIds: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_PROFILE_PRESENTATION, favouriteInstanceIds: [], badgeIds: [] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ...DEFAULT_PROFILE_PRESENTATION, favouriteInstanceIds: [], badgeIds: [] };
  }
  const value = parsed as Record<string, unknown>;
  return {
    portrait:
      typeof value.portrait === "string" && (value.portrait === "monogram" || collectionKey(value.portrait))
        ? value.portrait
        : "monogram",
    banner:
      typeof value.banner === "string" && (value.banner === "none" || collectionKey(value.banner))
        ? value.banner
        : "none",
    frame: isOneOf(PROFILE_FRAMES, value.frame) ? value.frame : "none",
    avatarDecoration: isOneOf(PROFILE_AVATAR_DECORATIONS, value.avatarDecoration)
      ? value.avatarDecoration
      : "none",
    nameTreatment: isOneOf(PROFILE_NAME_TREATMENTS, value.nameTreatment) ? value.nameTreatment : "plain",
    effect: isOneOf(PROFILE_EFFECTS, value.effect) ? value.effect : "none",
    featuredInstanceId:
      typeof value.featuredInstanceId === "string" && value.featuredInstanceId.length <= 80
        ? value.featuredInstanceId
        : null,
    favouriteInstanceIds: uniqueIds(value.favouriteInstanceIds, 8),
    badgeIds: uniqueIds(value.badgeIds, 6),
  };
}

export function profilePresentationVersion(row: { profile_presentation_version?: number | null } | null | undefined): number {
  const version = Number(row?.profile_presentation_version ?? 1);
  return Number.isFinite(version) && version > 0 ? Math.floor(version) : 1;
}

export async function getProfilePresentationOptions(ctx: Ctx): Promise<ProfilePresentationOptions> {
  const [collections, copies, achievements] = await Promise.all([
    listCollections(ctx),
    getInventory(ctx, { limit: 120, status: "owned" }),
    listAchievements(ctx, ctx.user?.id),
  ]);
  return {
    collections: collections.map((collection) => ({
      id: collection.id,
      slug: collection.slug,
      name: collection.name,
      logoUrl: collection.logo_url,
      bannerUrl: collection.banner_url,
      coverUrl: collection.cover_url,
    })),
    copies: copies.map(copyView),
    badges: achievements
      .filter((achievement) => achievement.state === "earned")
      .map((achievement) => ({
        id: achievement.id,
        name: achievement.name,
        category: achievement.category,
        artKey: achievement.art_key,
        collectionLogoUrl: achievement.collection_logo_url ?? null,
      })),
  };
}

function copyView(row: InventoryRow): ProfileCopyView {
  return {
    id: row.id,
    cardId: row.card_id,
    cardName: row.card_name,
    variantName: printTitle(row.edition_name) ?? row.variant_name,
    finish: displayFinish(row.variant_name, row.material_key, row.effect_key),
    serial: row.serial,
    renderUrl: row.render_url,
    thumbnailUrl: row.thumbnail_url,
    favourite: Boolean(row.favourite),
  };
}

function collectionById(options: ProfilePresentationOptions, id: string | null) {
  if (!id) return null;
  return options.collections.find((collection) => collection.id === id) ?? null;
}

function resolvePortrait(
  selection: ProfilePresentationSelection,
  options: ProfilePresentationOptions,
  notes: string[],
): ResolvedProfilePortrait {
  if (selection.portrait === "monogram") {
    return { key: "monogram", kind: "monogram", label: "Monogram", imageUrl: null };
  }
  const collection = collectionById(options, collectionKey(selection.portrait));
  if (!collection?.logoUrl) {
    notes.push("The chosen portrait is no longer available. Showing your monogram.");
    return { key: "monogram", kind: "monogram", label: "Monogram", imageUrl: null };
  }
  return {
    key: `collection:${collection.id}`,
    kind: "collection",
    label: collection.name,
    imageUrl: collection.logoUrl,
  };
}

function resolveBanner(
  selection: ProfilePresentationSelection,
  options: ProfilePresentationOptions,
  notes: string[],
): ResolvedProfileBanner {
  if (selection.banner === "none") {
    return { key: "none", kind: "none", label: "No banner", imageUrl: null };
  }
  const collection = collectionById(options, collectionKey(selection.banner));
  const imageUrl = collection?.bannerUrl ?? null;
  if (!collection || !imageUrl) {
    notes.push("The chosen banner is no longer available. Using the plain surface.");
    return { key: "none", kind: "none", label: "No banner", imageUrl: null };
  }
  return {
    key: `collection:${collection.id}`,
    kind: "collection",
    label: collection.name,
    imageUrl,
  };
}

function resolveFeatured(
  selection: ProfilePresentationSelection,
  options: ProfilePresentationOptions,
  favourites: ProfileCopyView[],
  notes: string[],
): ProfileCopyView | null {
  if (selection.featuredInstanceId) {
    const saved = options.copies.find((copy) => copy.id === selection.featuredInstanceId);
    if (saved) return saved;
    notes.push("The featured copy is no longer in your collection. Showing your first available favourite.");
  }
  return favourites[0] ?? options.copies[0] ?? null;
}

function orderSelected<T extends { id: string }>(selectedIds: string[], available: T[], max: number): T[] {
  if (!selectedIds.length) return available.slice(0, max);
  const byId = new Map(available.map((item) => [item.id, item]));
  const ordered: T[] = [];
  for (const id of selectedIds) {
    const item = byId.get(id);
    if (item && !ordered.includes(item)) ordered.push(item);
    if (ordered.length >= max) break;
  }
  return ordered;
}

export function resolveProfilePresentation(
  selection: ProfilePresentationSelection,
  options: ProfilePresentationOptions,
  version = 1,
): ResolvedProfilePresentation {
  const notes: string[] = [];
  const portrait = resolvePortrait(selection, options, notes);
  const banner = resolveBanner(selection, options, notes);
  const favouriteCopies = options.copies.filter((copy) => copy.favourite);
  const favourites = orderSelected(selection.favouriteInstanceIds, favouriteCopies, 8);
  const featured = resolveFeatured(selection, options, favourites, notes);
  const badges = orderSelected(selection.badgeIds, options.badges, 6);
  return {
    version,
    selection: {
      ...selection,
      portrait: portrait.key,
      banner: banner.key,
    },
    portrait,
    banner,
    featured,
    favourites,
    badges,
    fallbackNotes: notes,
  };
}

export function validateProfilePresentation(
  value: unknown,
  options: ProfilePresentationOptions,
): ProfilePresentationSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(422, "profile_presentation_invalid", "Choose a valid profile composition.");
  }
  const input = value as Record<string, unknown>;
  const portrait = typeof input.portrait === "string" ? input.portrait : "monogram";
  if (portrait !== "monogram") {
    const collection = collectionById(options, collectionKey(portrait));
    if (!collection?.logoUrl) {
      throw new ApiError(422, "profile_portrait_unavailable", "That portrait is not available to this account.");
    }
  }
  const banner = typeof input.banner === "string" ? input.banner : "none";
  if (banner !== "none") {
    const collection = collectionById(options, collectionKey(banner));
    if (!collection || !collection.bannerUrl) {
      throw new ApiError(422, "profile_banner_unavailable", "That banner is not available to this account.");
    }
  }
  if (!isOneOf(PROFILE_FRAMES, input.frame)) {
    throw new ApiError(422, "profile_frame_invalid", "Choose one of the available profile frames.");
  }
  if (!isOneOf(PROFILE_AVATAR_DECORATIONS, input.avatarDecoration)) {
    throw new ApiError(422, "profile_avatar_decoration_invalid", "Choose one of the available avatar decorations.");
  }
  if (!isOneOf(PROFILE_NAME_TREATMENTS, input.nameTreatment)) {
    throw new ApiError(422, "profile_name_treatment_invalid", "Choose one of the available name treatments.");
  }
  if (!isOneOf(PROFILE_EFFECTS, input.effect)) {
    throw new ApiError(422, "profile_effect_invalid", "Choose one of the available profile effects.");
  }
  const featuredInstanceId =
    typeof input.featuredInstanceId === "string" && input.featuredInstanceId.length <= 80
      ? input.featuredInstanceId
      : null;
  if (featuredInstanceId && !options.copies.some((copy) => copy.id === featuredInstanceId)) {
    throw new ApiError(422, "profile_featured_unavailable", "The featured copy is not in your collection.");
  }
  const favouriteInstanceIds = uniqueIds(input.favouriteInstanceIds, 8);
  const favouriteSet = new Set(options.copies.filter((copy) => copy.favourite).map((copy) => copy.id));
  if (favouriteInstanceIds.some((id) => !favouriteSet.has(id))) {
    throw new ApiError(422, "profile_favourite_unavailable", "Choose only cards that are currently in your favourites.");
  }
  const badgeIds = uniqueIds(input.badgeIds, 6);
  const badgeSet = new Set(options.badges.map((badge) => badge.id));
  if (badgeIds.some((id) => !badgeSet.has(id))) {
    throw new ApiError(422, "profile_badge_unavailable", "Choose only badges you have actually earned.");
  }
  return {
    portrait,
    banner,
    frame: input.frame,
    avatarDecoration: input.avatarDecoration,
    nameTreatment: input.nameTreatment,
    effect: input.effect,
    featuredInstanceId,
    favouriteInstanceIds,
    badgeIds,
  };
}

export interface ProfileSharePresentation {
  portrait: { kind: "monogram" | "collection"; label: string; image_url: string | null };
  banner: { kind: "none" | "collection"; label: string; image_url: string | null };
  frame: ProfileFrame;
  avatar_decoration: ProfileAvatarDecoration;
  name_treatment: ProfileNameTreatment;
  effect: ProfileEffect;
  featured: {
    card_name: string;
    variant_name: string;
    finish: string;
    render_url: string | null;
  } | null;
  favourites: Array<{
    card_name: string;
    variant_name: string;
    finish: string;
    render_url: string | null;
  }>;
  badges: Array<{ name: string; category: string; art_key: string; collection_logo_url: string | null }>;
}

export function profileSharePresentation(resolved: ResolvedProfilePresentation): ProfileSharePresentation {
  return {
    portrait: {
      kind: resolved.portrait.kind,
      label: resolved.portrait.label,
      image_url: resolved.portrait.imageUrl,
    },
    banner: {
      kind: resolved.banner.kind,
      label: resolved.banner.label,
      image_url: resolved.banner.imageUrl,
    },
    frame: resolved.selection.frame,
    avatar_decoration: resolved.selection.avatarDecoration,
    name_treatment: resolved.selection.nameTreatment,
    effect: resolved.selection.effect,
    featured: resolved.featured
      ? {
          card_name: resolved.featured.cardName,
          variant_name: resolved.featured.variantName,
          finish: resolved.featured.finish,
          render_url: resolved.featured.renderUrl,
        }
      : null,
    favourites: resolved.favourites.map((copy) => ({
      card_name: copy.cardName,
      variant_name: copy.variantName,
      finish: copy.finish,
      render_url: copy.renderUrl,
    })),
    badges: resolved.badges.map((badge) => ({
      name: badge.name,
      category: badge.category,
      art_key: badge.artKey,
      collection_logo_url: badge.collectionLogoUrl,
    })),
  };
}
