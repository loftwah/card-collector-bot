import { imageSize } from "image-size";
import { ApiError, type Ctx } from "../context";
import { first, nowIso } from "../db";
import { audit } from "../http";
import { newId, sha256Hex } from "../ids";
import { detectMime } from "./assets";
import type { DiscordUser } from "../discord/types";

export const ACCOUNT_AVATAR_KINDS = ["default", "discord", "upload"] as const;
export type AccountAvatarKind = (typeof ACCOUNT_AVATAR_KINDS)[number];

export interface DefaultAvatar {
  key: string;
  label: string;
  note: string;
}

/**
 * One coherent illustrated family. The Keeper is the mascot and universal
 * fallback; the rest are collector archetypes drawn from the same paper, ink
 * and foil vocabulary. No member sees a letter monogram.
 */
export const DEFAULT_AVATARS: DefaultAvatar[] = [
  { key: "keeper", label: "The Keeper", note: "Foilbury's cabinet mascot." },
  { key: "archivist", label: "The Archivist", note: "Order, notes and a good pair of spectacles." },
  { key: "prospector", label: "The Prospector", note: "Always one more box to look through." },
  { key: "completionist", label: "The Completionist", note: "The last slot is the whole point." },
  { key: "curator", label: "The Curator", note: "Fewer things, chosen properly." },
  { key: "night-owl", label: "The Night Owl", note: "The quiet hours are for sorting." },
  { key: "trader", label: "The Trader", note: "Two cards, one good conversation." },
];

export const DEFAULT_AVATAR_KEYS = DEFAULT_AVATARS.map((avatar) => avatar.key);
export const FALLBACK_AVATAR_KEY = "keeper";
export const AVATAR_RENDITION_SIZES = [256, 128, 64] as const;
export const BANNER_RENDITION_SIZES = [1600, 800] as const;
const MAX_AVATAR_RENDITION_BYTES = 420_000;
const MAX_AVATAR_TOTAL_BYTES = 900_000;
const MAX_BANNER_RENDITION_BYTES = 1_400_000;
const MAX_DISCORD_AVATAR_BYTES = 2_000_000;

export interface AccountAvatarUserFields {
  avatar_kind?: string | null;
  avatar_default_key?: string | null;
  avatar_asset_id?: string | null;
  avatar_source_hash?: string | null;
  avatar_updated_at?: string | null;
}

export interface AccountAvatarView {
  kind: AccountAvatarKind;
  defaultKey: string;
  label: string;
  src: string;
  srcSet: string | null;
  assetId: string | null;
  updatedAt: string | null;
  /** True when the persisted choice resolved to the mascot fallback. */
  fallback: boolean;
  /** Short human explanation for the picker, not an error. */
  note: string;
}

export interface AccountBannerView {
  assetId: string | null;
  src: string;
  srcSet: string | null;
  updatedAt: string | null;
}

export interface MemberMediaRendition {
  size: number;
  r2_key: string;
  mime: string;
  bytes: number;
  sha256: string;
}

export interface MemberMediaRow {
  id: string;
  tenant_id: string;
  user_id: string;
  kind: "avatar" | "banner";
  mime: string;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  renditions_json: string;
  source: "upload" | "discord";
  created_at: string;
  archived_at: string | null;
}

export function defaultAvatarKey(value: string | null | undefined): string {
  return typeof value === "string" && DEFAULT_AVATAR_KEYS.includes(value)
    ? value
    : FALLBACK_AVATAR_KEY;
}

export function defaultAvatar(key: string): DefaultAvatar {
  return DEFAULT_AVATARS.find((avatar) => avatar.key === defaultAvatarKey(key)) ?? DEFAULT_AVATARS[0]!;
}

export function defaultAvatarSrc(key: string): string {
  return `/avatars/default/${defaultAvatarKey(key)}-256.png`;
}

export function defaultAvatarPng(key: string, size: 512 | 256 | 128 | 64 | 32 = 256): string {
  return `/avatars/default/${defaultAvatarKey(key)}-${size}.png`;
}

export function memberMediaSrc(id: string, size: number, kind: "avatar" | "banner" = "avatar"): string {
  return `/media/member/${encodeURIComponent(id)}?size=${size}&kind=${kind}`;
}

export function accountAvatarView(user: AccountAvatarUserFields | null | undefined): AccountAvatarView {  const kind: AccountAvatarKind =
    user?.avatar_kind === "discord" || user?.avatar_kind === "upload" ? user.avatar_kind : "default";
  const defaultKey = defaultAvatarKey(user?.avatar_default_key);
  const meta = defaultAvatar(defaultKey);
  if ((kind === "discord" || kind === "upload") && user?.avatar_asset_id) {
    const id = user.avatar_asset_id;
    return {
      kind,
      defaultKey,
      label: kind === "discord" ? "Discord avatar" : "Uploaded photo",
      src: memberMediaSrc(id, 256),
      srcSet:
        kind === "upload"
          ? `${memberMediaSrc(id, 64)} 64w, ${memberMediaSrc(id, 128)} 128w, ${memberMediaSrc(id, 256)} 256w`
          : null,
      assetId: id,
      updatedAt: user.avatar_updated_at ?? null,
      fallback: false,
      note: kind === "discord" ? "Cached privately from your linked Discord account." : "Private to your account.",
    };
  }
  return {
    kind: "default",
    defaultKey,
    label: meta.label,
    src: defaultAvatarSrc(defaultKey),
    srcSet: `${defaultAvatarPng(defaultKey, 64)} 64w, ${defaultAvatarPng(defaultKey, 128)} 128w, ${defaultAvatarPng(defaultKey, 256)} 256w`,
    assetId: null,
    updatedAt: user?.avatar_updated_at ?? null,
    fallback: kind !== "default",
    note:
      kind === "default"
        ? meta.note
        : "The chosen image is unavailable, so the Keeper is showing instead.",
  };
}

export function accountAvatarViewFor(user: {
  avatarKind?: string | null;
  avatarDefaultKey?: string | null;
  avatarAssetId?: string | null;
  avatarUpdatedAt?: string | null;
} | null | undefined): AccountAvatarView {
  return accountAvatarView({
    avatar_kind: user?.avatarKind,
    avatar_default_key: user?.avatarDefaultKey,
    avatar_asset_id: user?.avatarAssetId,
    avatar_updated_at: user?.avatarUpdatedAt,
  });
}

export function accountBannerView(user: { banner_asset_id?: string | null; banner_updated_at?: string | null } | null | undefined): AccountBannerView | null {
  if (!user?.banner_asset_id) return null;
  return {
    assetId: user.banner_asset_id,
    src: memberMediaSrc(user.banner_asset_id, 1600, "banner"),
    srcSet: `${memberMediaSrc(user.banner_asset_id, 800, "banner")} 800w, ${memberMediaSrc(user.banner_asset_id, 1600, "banner")} 1600w`,
    updatedAt: user.banner_updated_at ?? null,
  };
}

export function parseRenditions(raw: string | null | undefined): MemberMediaRendition[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
      .map((item) => ({
        size: Number(item.size),
        r2_key: String(item.r2_key ?? ""),
        mime: String(item.mime ?? ""),
        bytes: Number(item.bytes ?? 0),
        sha256: String(item.sha256 ?? ""),
      }))
      .filter((item) => Number.isFinite(item.size) && item.r2_key && item.mime);
  } catch {
    return [];
  }
}

export function renditionForSize(row: MemberMediaRow, requested: number): MemberMediaRendition | null {
  const renditions = parseRenditions(row.renditions_json).sort((a, b) => a.size - b.size);
  if (!renditions.length) return null;
  return renditions.find((item) => item.size >= requested) ?? renditions[renditions.length - 1]!;
}

function extensionForMime(mime: string): string {
  return mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
}

function decodeBase64(value: string): Uint8Array {
  const raw = value.includes(",") ? value.slice(value.indexOf(",") + 1) : value;
  if (!/^[A-Za-z0-9+/=\s]+$/.test(raw)) {
    throw new ApiError(422, "avatar_encoding_invalid", "That image could not be read. Choose the photo again.");
  }
  try {
    const binary = atob(raw.replace(/\s/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    throw new ApiError(422, "avatar_encoding_invalid", "That image could not be read. Choose the photo again.");
  }
}

export interface RenditionUploadInput {
  size: number;
  data: string;
  mime?: string;
}

interface ValidatedRendition {
  size: number;
  bytes: Uint8Array;
  mime: string;
}

function validateRendition(
  input: RenditionUploadInput,
  expectedSizes: readonly number[],
  maxBytes: number,
): ValidatedRendition {
  if (!expectedSizes.includes(input.size)) {
    throw new ApiError(422, "avatar_size_invalid", "The image was prepared at an unsupported size.");
  }
  const bytes = decodeBase64(input.data);
  if (bytes.length > maxBytes) {
    throw new ApiError(413, "avatar_too_large", "Keep the prepared image under 420 KB.");
  }
  const mime = detectMime(bytes);
  if (!mime || !["image/png", "image/jpeg", "image/webp"].includes(mime)) {
    throw new ApiError(422, "avatar_type_invalid", "Use a PNG, JPEG or WebP image.");
  }
  const size = imageSize(bytes);
  if (size.width !== input.size || size.height !== input.size) {
    throw new ApiError(422, "avatar_dimensions_invalid", "The prepared avatar must be square at the expected size.");
  }
  return { size: input.size, bytes, mime };
}

function validateAvatarRenditions(inputs: RenditionUploadInput[]): ValidatedRendition[] {
  const unique = new Map<number, RenditionUploadInput>();
  for (const input of inputs) {
    if (unique.has(input.size)) {
      throw new ApiError(422, "avatar_duplicate_size", "Each avatar rendition may be supplied once.");
    }
    unique.set(input.size, input);
  }
  for (const size of AVATAR_RENDITION_SIZES) {
    if (!unique.has(size)) {
      throw new ApiError(422, "avatar_rendition_missing", "The browser did not prepare every avatar size.");
    }
  }
  const validated = AVATAR_RENDITION_SIZES.map((size) =>
    validateRendition(unique.get(size)!, AVATAR_RENDITION_SIZES, MAX_AVATAR_RENDITION_BYTES),
  );
  if (validated.reduce((total, item) => total + item.bytes.length, 0) > MAX_AVATAR_TOTAL_BYTES) {
    throw new ApiError(413, "avatar_too_large", "The prepared avatar renditions are too large together.");
  }
  return validated;
}

function validateBannerRenditions(inputs: RenditionUploadInput[]): ValidatedRendition[] {
  const unique = new Map<number, RenditionUploadInput>();
  for (const input of inputs) {
    if (unique.has(input.size)) {
      throw new ApiError(422, "banner_duplicate_size", "Each banner rendition may be supplied once.");
    }
    unique.set(input.size, input);
  }
  for (const size of BANNER_RENDITION_SIZES) {
    if (!unique.has(size)) {
      throw new ApiError(422, "banner_rendition_missing", "The browser did not prepare every banner size.");
    }
  }
  return BANNER_RENDITION_SIZES.map((size) => {
    const input = unique.get(size)!;
    const bytes = decodeBase64(input.data);
    if (bytes.length > MAX_BANNER_RENDITION_BYTES) {
      throw new ApiError(413, "banner_too_large", "Keep each prepared banner under 1.4 MB.");
    }
    const mime = detectMime(bytes);
    if (!mime || !["image/png", "image/jpeg", "image/webp"].includes(mime)) {
      throw new ApiError(422, "banner_type_invalid", "Use a PNG, JPEG or WebP image.");
    }
    const dimensions = imageSize(bytes);
    if (dimensions.width !== size || dimensions.height !== Math.round(size * 0.375)) {
      throw new ApiError(422, "banner_dimensions_invalid", "The prepared banner must use the 8:3 banner ratio.");
    }
    return { size, bytes, mime };
  });
}

async function archiveCurrentMedia(ctx: Ctx, row: MemberMediaRow | null): Promise<void> {
  if (!row) return;
  const renditions = parseRenditions(row.renditions_json);
  await ctx.db
    .prepare("UPDATE fb_member_media SET archived_at = ? WHERE id = ? AND tenant_id = ?")
    .bind(nowIso(), row.id, ctx.tenant.id)
    .run();
  await Promise.all(renditions.map((item) => ctx.media.delete(item.r2_key).catch(() => undefined)));
}

async function currentMemberMedia(ctx: Ctx, userId: string, id: string | null): Promise<MemberMediaRow | null> {
  if (!id) return null;
  return first<MemberMediaRow>(
    ctx.db,
    "SELECT * FROM fb_member_media WHERE id = ? AND tenant_id = ? AND user_id = ? AND archived_at IS NULL",
    id,
    ctx.tenant.id,
    userId,
  );
}

async function userAvatarFields(ctx: Ctx, userId: string): Promise<AccountAvatarUserFields> {
  return (
    (await first<AccountAvatarUserFields>(
      ctx.db,
      "SELECT avatar_kind, avatar_default_key, avatar_asset_id, avatar_source_hash, avatar_updated_at FROM fb_users WHERE id = ? AND disabled_at IS NULL",
      userId,
    )) ?? {}
  );
}

export async function loadAccountAvatar(ctx: Ctx, userId: string): Promise<AccountAvatarView> {
  const fields = await userAvatarFields(ctx, userId);
  const view = accountAvatarView(fields);
  if (view.kind !== "default" && view.assetId) {
    const media = await currentMemberMedia(ctx, userId, view.assetId);
    if (!media) {
      return accountAvatarView({
        ...fields,
        avatar_kind: "default",
        avatar_asset_id: null,
        avatar_default_key: fields.avatar_default_key ?? FALLBACK_AVATAR_KEY,
      });
    }
  }
  return view;
}

export async function loadAccountBanner(ctx: Ctx, userId: string): Promise<AccountBannerView | null> {
  const row = await first<{ banner_asset_id: string | null; banner_updated_at: string | null }>(
    ctx.db,
    "SELECT banner_asset_id, banner_updated_at FROM fb_users WHERE id = ? AND disabled_at IS NULL",
    userId,
  );
  if (!row?.banner_asset_id) return null;
  const media = await currentMemberMedia(ctx, userId, row.banner_asset_id);
  return media ? accountBannerView(row) : null;
}

async function storeAvatarMedia(
  ctx: Ctx,
  userId: string,
  renditions: ValidatedRendition[],
  source: "upload" | "discord",
): Promise<MemberMediaRow> {
  const groupId = newId("mav");
  const now = nowIso();
  const stored: MemberMediaRendition[] = [];
  for (const rendition of renditions) {
    const ext = extensionForMime(rendition.mime);
    const r2Key = `tenants/${ctx.tenant.id}/members/${userId}/avatar/${groupId}/${rendition.size}.${ext}`;
    await ctx.media.put(r2Key, rendition.bytes, {
      httpMetadata: { contentType: rendition.mime, contentDisposition: "inline" },
      customMetadata: {
        tenant: ctx.tenant.id,
        user: userId,
        kind: "avatar",
        size: String(rendition.size),
        sha256: await sha256Hex(rendition.bytes),
      },
    });
    stored.push({
      size: rendition.size,
      r2_key: r2Key,
      mime: rendition.mime,
      bytes: rendition.bytes.length,
      sha256: await sha256Hex(rendition.bytes),
    });
  }
  const primary = stored.find((item) => item.size === 256) ?? stored[0]!;
  await ctx.db
    .prepare(
      `INSERT INTO fb_member_media
        (id, tenant_id, user_id, kind, mime, width, height, bytes, sha256, renditions_json, source, created_at)
       VALUES (?, ?, ?, 'avatar', ?, 256, 256, ?, ?, ?, ?, ?)`,
    )
    .bind(
      groupId,
      ctx.tenant.id,
      userId,
      primary.mime,
      stored.reduce((total, item) => total + item.bytes, 0),
      primary.sha256,
      JSON.stringify(stored),
      source,
      now,
    )
    .run();
  return {
    id: groupId,
    tenant_id: ctx.tenant.id,
    user_id: userId,
    kind: "avatar",
    mime: primary.mime,
    width: 256,
    height: 256,
    bytes: stored.reduce((total, item) => total + item.bytes, 0),
    sha256: primary.sha256,
    renditions_json: JSON.stringify(stored),
    source,
    created_at: now,
    archived_at: null,
  };
}

export async function setDefaultAvatar(ctx: Ctx, key: string): Promise<AccountAvatarView> {
  const userId = ctx.user!.id;
  const nextKey = defaultAvatarKey(key);
  if (nextKey !== key) {
    throw new ApiError(422, "avatar_default_invalid", "Choose one of the illustrated Foilbury avatars.");
  }
  const current = await first<{ avatar_asset_id: string | null }>(
    ctx.db,
    "SELECT avatar_asset_id FROM fb_users WHERE id = ?",
    userId,
  );
  const previous = await currentMemberMedia(ctx, userId, current?.avatar_asset_id ?? null);
  await ctx.db
    .prepare(
      `UPDATE fb_users SET avatar_kind = 'default', avatar_default_key = ?, avatar_asset_id = NULL,
         avatar_source_hash = NULL, avatar_updated_at = ? WHERE id = ?`,
    )
    .bind(nextKey, nowIso(), userId)
    .run();
  await archiveCurrentMedia(ctx, previous);
  await audit(ctx, "account.avatar.updated", "user", userId, {
    kind: "default",
    default_key: nextKey,
    previous_media_id: previous?.id ?? null,
  });
  return accountAvatarView(await userAvatarFields(ctx, userId));
}

function discordAvatarUrl(discordUser: Pick<DiscordUser, "id" | "avatar">, size = 256): string | null {
  if (!discordUser.avatar) return null;
  return `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png?size=${size}`;
}

async function fetchDiscordAvatar(discordUser: Pick<DiscordUser, "id" | "avatar">): Promise<ValidatedRendition | null> {
  const url = discordAvatarUrl(discordUser);
  if (!url) return null;
  const response = await fetch(url, {
    headers: { accept: "image/png,image/webp,image/jpeg" },
    redirect: "follow",
  });
  if (!response.ok) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_DISCORD_AVATAR_BYTES) return null;
  const mime = detectMime(bytes);
  if (!mime || !["image/png", "image/jpeg", "image/webp"].includes(mime)) return null;
  const dimensions = imageSize(bytes);
  if (!dimensions.width || !dimensions.height) return null;
  return { size: 256, bytes, mime };
}

export async function setDiscordAvatar(ctx: Ctx): Promise<AccountAvatarView> {
  const userId = ctx.user!.id;
  const identity = await first<{ discord_user_id: string; avatar_hash: string | null; username: string | null }>(
    ctx.db,
    `SELECT discord_user_id, avatar_hash, username FROM fb_discord_identities
      WHERE tenant_id = ? AND user_id = ? AND revoked_at IS NULL ORDER BY linked_at DESC LIMIT 1`,
    ctx.tenant.id,
    userId,
  );
  if (!identity) {
    throw new ApiError(409, "discord_not_linked", "Link Discord to this Foilbury account first.");
  }
  const fetched = identity.avatar_hash
    ? await fetchDiscordAvatar({ id: identity.discord_user_id, avatar: identity.avatar_hash }).catch(() => null)
    : null;
  if (!fetched) {
    const current = await first<{ avatar_asset_id: string | null }>(
      ctx.db,
      "SELECT avatar_asset_id FROM fb_users WHERE id = ?",
      userId,
    );
    if (current?.avatar_asset_id) {
      throw new ApiError(
        409,
        "discord_avatar_unavailable",
        "Discord did not return a usable image. Your existing avatar is unchanged.",
      );
    }
    await setDefaultAvatar(ctx, FALLBACK_AVATAR_KEY);
    const view = await loadAccountAvatar(ctx, userId);
    return {
      ...view,
      note: "Discord did not return a usable image, so the Keeper is showing.",
    };
  }
  const previousRow = await first<{ avatar_asset_id: string | null }>(
    ctx.db,
    "SELECT avatar_asset_id FROM fb_users WHERE id = ?",
    userId,
  );
  const previous = await currentMemberMedia(ctx, userId, previousRow?.avatar_asset_id ?? null);
  const media = await storeAvatarMedia(ctx, userId, [fetched], "discord");
  await ctx.db
    .prepare(
      `UPDATE fb_users SET avatar_kind = 'discord', avatar_asset_id = ?, avatar_source_hash = ?,
         avatar_updated_at = ? WHERE id = ?`,
    )
    .bind(media.id, identity.avatar_hash, nowIso(), userId)
    .run();
  await archiveCurrentMedia(ctx, previous);
  await audit(ctx, "account.avatar.updated", "user", userId, {
    kind: "discord",
    media_id: media.id,
    discord_user_id: identity.discord_user_id,
    source_hash: identity.avatar_hash,
    previous_media_id: previous?.id ?? null,
  });
  return accountAvatarView(await userAvatarFields(ctx, userId));
}

export async function setUploadedAvatar(ctx: Ctx, renditions: RenditionUploadInput[]): Promise<AccountAvatarView> {
  const userId = ctx.user!.id;
  const validated = validateAvatarRenditions(renditions);
  const previousRow = await first<{ avatar_asset_id: string | null }>(
    ctx.db,
    "SELECT avatar_asset_id FROM fb_users WHERE id = ?",
    userId,
  );
  const previous = await currentMemberMedia(ctx, userId, previousRow?.avatar_asset_id ?? null);
  const media = await storeAvatarMedia(ctx, userId, validated, "upload");
  await ctx.db
    .prepare(
      `UPDATE fb_users SET avatar_kind = 'upload', avatar_asset_id = ?, avatar_source_hash = ?,
         avatar_updated_at = ? WHERE id = ?`,
    )
    .bind(media.id, media.sha256, nowIso(), userId)
    .run();
  await archiveCurrentMedia(ctx, previous);
  await audit(ctx, "account.avatar.updated", "user", userId, {
    kind: "upload",
    media_id: media.id,
    sha256: media.sha256,
    sizes: validated.map((item) => item.size),
    previous_media_id: previous?.id ?? null,
  });
  return accountAvatarView(await userAvatarFields(ctx, userId));
}

export async function removeAccountAvatar(ctx: Ctx): Promise<AccountAvatarView> {
  return setDefaultAvatar(ctx, FALLBACK_AVATAR_KEY);
}

export async function setUploadedBanner(ctx: Ctx, renditions: RenditionUploadInput[]): Promise<AccountBannerView> {
  const userId = ctx.user!.id;
  const validated = validateBannerRenditions(renditions);
  const groupId = newId("mbn");
  const stored: MemberMediaRendition[] = [];
  const now = nowIso();
  for (const rendition of validated) {
    const ext = extensionForMime(rendition.mime);
    const r2Key = `tenants/${ctx.tenant.id}/members/${userId}/banner/${groupId}/${rendition.size}.${ext}`;
    const hash = await sha256Hex(rendition.bytes);
    await ctx.media.put(r2Key, rendition.bytes, {
      httpMetadata: { contentType: rendition.mime, contentDisposition: "inline" },
      customMetadata: { tenant: ctx.tenant.id, user: userId, kind: "banner", size: String(rendition.size), sha256: hash },
    });
    stored.push({ size: rendition.size, r2_key: r2Key, mime: rendition.mime, bytes: rendition.bytes.length, sha256: hash });
  }
  const primary = stored.find((item) => item.size === 1600) ?? stored[0]!;
  await ctx.db
    .prepare(
      `INSERT INTO fb_member_media
        (id, tenant_id, user_id, kind, mime, width, height, bytes, sha256, renditions_json, source, created_at)
       VALUES (?, ?, ?, 'banner', ?, 1600, 600, ?, ?, ?, 'upload', ?)`,
    )
    .bind(
      groupId,
      ctx.tenant.id,
      userId,
      primary.mime,
      stored.reduce((total, item) => total + item.bytes, 0),
      primary.sha256,
      JSON.stringify(stored),
      now,
    )
    .run();
  const previousRow = await first<{ banner_asset_id: string | null }>(
    ctx.db,
    "SELECT banner_asset_id FROM fb_users WHERE id = ?",
    userId,
  );
  const previous = await currentMemberMedia(ctx, userId, previousRow?.banner_asset_id ?? null);
  await ctx.db
    .prepare("UPDATE fb_users SET banner_asset_id = ?, banner_source_hash = ?, banner_updated_at = ? WHERE id = ?")
    .bind(groupId, primary.sha256, now, userId)
    .run();
  await archiveCurrentMedia(ctx, previous);
  await audit(ctx, "account.banner.updated", "user", userId, {
    media_id: groupId,
    sha256: primary.sha256,
    previous_media_id: previous?.id ?? null,
  });
  return {
    assetId: groupId,
    src: memberMediaSrc(groupId, 1600, "banner"),
    srcSet: `${memberMediaSrc(groupId, 800, "banner")} 800w, ${memberMediaSrc(groupId, 1600, "banner")} 1600w`,
    updatedAt: now,
  };
}

export async function removeAccountBanner(ctx: Ctx): Promise<void> {
  const userId = ctx.user!.id;
  const previousRow = await first<{ banner_asset_id: string | null }>(
    ctx.db,
    "SELECT banner_asset_id FROM fb_users WHERE id = ?",
    userId,
  );
  const previous = await currentMemberMedia(ctx, userId, previousRow?.banner_asset_id ?? null);
  await ctx.db
    .prepare("UPDATE fb_users SET banner_asset_id = NULL, banner_source_hash = NULL, banner_updated_at = ? WHERE id = ?")
    .bind(nowIso(), userId)
    .run();
  await archiveCurrentMedia(ctx, previous);
  await audit(ctx, "account.banner.removed", "user", userId, { previous_media_id: previous?.id ?? null });
}

export async function memberMediaById(ctx: Ctx, id: string): Promise<MemberMediaRow | null> {
  return first<MemberMediaRow>(
    ctx.db,
    "SELECT * FROM fb_member_media WHERE id = ? AND tenant_id = ? AND archived_at IS NULL",
    id,
    ctx.tenant.id,
  );
}

/**
 * Refresh the cached Discord avatar only when the member has explicitly chosen
 * it and the source hash changed. A failed fetch keeps the last good private
 * copy; a member with no good copy falls back to the Keeper mascot.
 */
export async function syncDiscordAvatar(ctx: Ctx, userId: string, discordUser: Pick<DiscordUser, "id" | "avatar">): Promise<void> {
  const user = await first<{
    avatar_kind: string;
    avatar_asset_id: string | null;
    avatar_source_hash: string | null;
  }>(
    ctx.db,
    "SELECT avatar_kind, avatar_asset_id, avatar_source_hash FROM fb_users WHERE id = ? AND disabled_at IS NULL",
    userId,
  );
  if (!user || user.avatar_kind !== "discord") return;
  if (discordUser.avatar && discordUser.avatar === user.avatar_source_hash) return;
  const fetched = discordUser.avatar ? await fetchDiscordAvatar(discordUser).catch(() => null) : null;
  if (!fetched) {
    if (!user.avatar_asset_id) {
      await ctx.db
        .prepare(
          "UPDATE fb_users SET avatar_kind = 'default', avatar_default_key = ?, avatar_updated_at = ? WHERE id = ?",
        )
        .bind(FALLBACK_AVATAR_KEY, nowIso(), userId)
        .run();
      await audit(ctx, "account.avatar.discord_fallback", "user", userId, {
        reason: "fetch_failed",
        discord_user_id: discordUser.id,
      });
    }
    return;
  }
  const previous = await currentMemberMedia(ctx, userId, user.avatar_asset_id);
  const media = await storeAvatarMedia(ctx, userId, [fetched], "discord");
  await ctx.db
    .prepare(
      "UPDATE fb_users SET avatar_asset_id = ?, avatar_source_hash = ?, avatar_updated_at = ? WHERE id = ?",
    )
    .bind(media.id, discordUser.avatar, nowIso(), userId)
    .run();
  await archiveCurrentMedia(ctx, previous);
  await audit(ctx, "account.avatar.refreshed", "user", userId, {
    media_id: media.id,
    discord_user_id: discordUser.id,
    source_hash: discordUser.avatar,
  });
}

export function publicDefaultAvatarUrl(origin: string, key: string, size: 512 | 256 | 128 | 64 | 32 = 256): string {
  return `${origin.replace(/\/$/, "")}${defaultAvatarPng(key, size)}`;
}
