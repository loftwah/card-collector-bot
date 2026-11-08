import type { Ctx } from "../context";
import { all, first } from "../db";
import { sha256Hex } from "../ids";
import { canViewCollection, mostRestrictive, viewerAccess, type Audience } from "./visibility";

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
 * A card inherits the most restrictive audience of every live collection it
 * belongs to. A public share must therefore be public in every one of them,
 * not merely in the first join row returned by the database.
 */
export async function cardShareAudience(
  ctx: Ctx,
  cardId: string,
): Promise<{ audience: Audience; collectionId: string | null }> {
  const rows = await all<{
    id: string;
    status: string;
    view_audience: string;
    public_approved_at: string | null;
  }>(
    ctx.db,
    `SELECT c.id, c.status, c.view_audience, c.public_approved_at
       FROM fb_collection_cards cc JOIN fb_collections c ON c.id = cc.collection_id
      WHERE cc.card_id = ? AND c.archived_at IS NULL
      ORDER BY CASE c.view_audience WHEN 'private' THEN 0 WHEN 'members' THEN 1 ELSE 2 END, c.name`,
    cardId,
  );
  if (!rows.length) return { audience: "private", collectionId: null };
  let audience: Audience = "public";
  for (const row of rows) {
    const next: Audience =
      row.status !== "published"
        ? "private"
        : row.view_audience === "private"
          ? "private"
          : row.view_audience === "members"
            ? "members"
            : row.public_approved_at
              ? "public"
              : "private";
    audience = mostRestrictive(audience, next);
  }
  // Prefer a collection that matches the effective audience for readable
  // context, while the audience itself is computed from every membership.
  const collection =
    rows.find((row) =>
      audience === "public"
        ? row.view_audience === "public" && row.public_approved_at && row.status === "published"
        : audience === "members"
          ? row.view_audience === "members" && row.status === "published"
          : row.view_audience === "private" || row.status !== "published",
    ) ?? rows[0];
  return { audience, collectionId: collection?.id ?? null };
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
  // The token is the bearer secret. Resolve it without assuming the viewer's
  // current tenant: a public share from a second Bot still has to open for a
  // signed-out recipient on the canonical origin. Membership is checked
  // against the link's own tenant below.
  const link = await first<{
    id: string;
    tenant_id: string;
    user_id: string;
    status: string;
    expires_at: string;
    kind: string;
    target_id: string | null;
    payload_json: string;
    created_at: string;
  }>(
    ctx.db,
    "SELECT id, tenant_id, user_id, status, expires_at, kind, target_id, payload_json, created_at FROM fb_share_links WHERE token_hash = ?",
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
    first<{ status: string; revoked_at: string | null }>(
      ctx.db,
      "SELECT status, revoked_at FROM fb_memberships WHERE tenant_id = ? AND user_id = ?",
      link.tenant_id,
      link.user_id,
    ),
  ]);
  const active =
    link.status === "active" &&
    new Date(link.expires_at) > new Date() &&
    ownerMembership?.status === "active" &&
    !ownerMembership.revoked_at &&
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

  const capturedPublic = payload.audience === "public";
  const cardAudience =
    (link.kind === "card" || link.kind === "latest") && typeof payload.card_id === "string"
      ? await cardShareAudience(ctx, payload.card_id)
      : null;
  const effectiveCollectionId = cardAudience?.collectionId ?? collectionId;
  const currentPublic =
    link.kind === "card" || link.kind === "latest"
      ? cardAudience?.audience === "public"
      : Boolean(collection && collection.view_audience === "public" && collection.public_approved_at);
  const publicView =
    capturedPublic &&
    (link.kind === "card" || link.kind === "latest" || link.kind === "collection") &&
    currentPublic;

  let visible = publicView;
  if (!visible && ctx.user) {
    const access = await viewerAccess(ctx);
    const memberHere = access.memberTenantIds.has(link.tenant_id);
    if (ctx.user.id === link.user_id) visible = true;
    else if (link.kind === "card" || link.kind === "latest") {
      // The card may belong to several collections. Re-check every one, not a
      // single representative row captured at creation time.
      visible = cardAudience
        ? cardAudience.audience === "public"
          ? true
          : cardAudience.audience === "members"
            ? memberHere && Boolean(effectiveCollectionId && (await canViewCollection(ctx, effectiveCollectionId)))
            : Boolean(effectiveCollectionId && (await canViewCollection(ctx, effectiveCollectionId)))
        : memberHere;
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
    // An active but unauthorised viewer gets no snapshot object at all. The
    // HTML already shows a gate, but a future unfurl/API consumer must not be
    // able to read private names or serials from this helper either.
    payload: visible ? payload : {},
    collection: visible ? collection : null,
    showSerial: visible && ctx.user?.id === link.user_id,
  };
}
