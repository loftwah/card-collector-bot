import type { Ctx } from "../context";
import { first } from "../db";
import { sha256Hex } from "../ids";
import { canViewCollection, viewerAccess } from "./visibility";

export interface ShareView {
  active: boolean;
  visible: boolean;
  publicView: boolean;
  ownerDisplayName: string | null;
  link: {
    id: string;
    user_id: string;
    status: string;
    expires_at: string;
    kind: string;
    target_id: string | null;
    created_at: string;
  } | null;
  payload: Record<string, any>;
  collection: {
    id: string;
    slug: string;
    name: string;
    view_audience: string;
    public_approved_at: string | null;
    logo_url: string | null;
    description: string;
  } | null;
  showSerial: boolean;
}

function objectPayload(value: string | null | undefined): Record<string, any> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, any>)
      : {};
  } catch {
    return {};
  }
}

/**
 * One canonical resolution policy for every share token. HTML, unfurls and the
 * member view call this helper; a blocked image never substitutes for it.
 *
 * A share is a snapshot of an explicitly chosen object, but membership,
 * collection audience, link status, expiry and the owner's current membership
 * are all re-checked on every read.
 */
export async function resolveShareView(ctx: Ctx, rawToken: string): Promise<ShareView> {
  const tokenHash = await sha256Hex(rawToken);
  const link = await first<{
    id: string;
    user_id: string;
    status: string;
    expires_at: string;
    kind: string;
    target_id: string | null;
    payload_json: string;
    created_at: string;
  }>(
    ctx.db,
    "SELECT id, user_id, status, expires_at, kind, target_id, payload_json, created_at FROM fb_share_links WHERE tenant_id = ? AND token_hash = ?",
    ctx.tenant.id,
    tokenHash,
  );

  const notActive: ShareView = {
    active: false,
    visible: false,
    publicView: false,
    ownerDisplayName: null,
    link: null,
    payload: {},
    collection: null,
    showSerial: false,
  };
  if (!link) return notActive;

  const [owner, ownerMembership] = await Promise.all([
    first<{ display_name: string }>(ctx.db, "SELECT display_name FROM fb_users WHERE id = ? AND disabled_at IS NULL", link.user_id),
    first<{ status: string }>(ctx.db, "SELECT status FROM fb_memberships WHERE tenant_id = ? AND user_id = ?", ctx.tenant.id, link.user_id),
  ]);
  const active =
    link.status === "active" &&
    new Date(link.expires_at) > new Date() &&
    ownerMembership?.status === "active" &&
    Boolean(owner);
  if (!active) return notActive;

  const payload = objectPayload(link.payload_json);
  const collectionId = typeof payload.collection_id === "string" ? payload.collection_id : null;
  const collection = collectionId
    ? await first<{
        id: string;
        slug: string;
        name: string;
        view_audience: string;
        public_approved_at: string | null;
        logo_url: string | null;
        description: string;
      }>(
        ctx.db,
        "SELECT id, slug, name, view_audience, public_approved_at, logo_url, description FROM fb_collections WHERE id = ? AND archived_at IS NULL",
        collectionId,
      )
    : null;

  const currentPublic = Boolean(collection && collection.view_audience === "public" && collection.public_approved_at);
  const capturedPublic = payload.audience === "public";
  const publicView =
    capturedPublic &&
    (link.kind === "card" || link.kind === "latest" || link.kind === "collection") &&
    currentPublic;

  let visible = publicView;
  if (!visible && ctx.user) {
    const access = await viewerAccess(ctx);
    const memberHere = access.memberTenantIds.has(ctx.tenant.id);
    if (ctx.user.id === link.user_id) visible = true;
    else if (link.kind === "card" || link.kind === "latest") {
      visible = collectionId ? Boolean(await canViewCollection(ctx, collectionId)) : memberHere;
    } else if (link.kind === "collection") {
      visible = Boolean(collectionId && (await canViewCollection(ctx, collectionId)));
    } else {
      visible = memberHere;
    }
  }

  return {
    active,
    visible,
    publicView,
    ownerDisplayName: owner?.display_name ?? null,
    link: {
      id: link.id,
      user_id: link.user_id,
      status: link.status,
      expires_at: link.expires_at,
      kind: link.kind,
      target_id: link.target_id,
      created_at: link.created_at,
    },
    payload,
    collection,
    showSerial: visible && ctx.user?.id === link.user_id,
  };
}
