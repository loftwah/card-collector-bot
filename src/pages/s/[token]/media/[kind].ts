import type { APIRoute } from "astro";
import { buildContext } from "../../../../server/context";
import { resolveShareView } from "../../../../server/modules/shares";
import {
  FALLBACK_AVATAR_KEY,
  defaultAvatarSrc,
  memberMediaById,
  renditionForSize,
} from "../../../../server/modules/account-avatar";

export const prerender = false;

function notFound(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

export const GET: APIRoute = async ({ request, params }) => {
  const ctx = await buildContext(request);
  const view = await resolveShareView(ctx, params.token ?? "");
  if (!view.active || !view.visible) return notFound();
  const kind = params.kind === "banner" ? "banner" : params.kind === "avatar" ? "avatar" : null;
  if (!kind) return notFound();
  const presentation =
    view.payload.presentation && typeof view.payload.presentation === "object"
      ? (view.payload.presentation as Record<string, unknown>)
      : {};
  const captured = (kind === "avatar" ? presentation.avatar : presentation.banner) as
    { kind?: string; asset_id?: string | null } | undefined;
  if (!captured || captured.kind === "default" || captured.kind === "none") {
    return notFound();
  }
  const assetId = typeof captured.asset_id === "string" ? captured.asset_id : null;
  if (!assetId) return notFound();
  const media = await memberMediaById(ctx, assetId);
  if (!media || media.user_id !== view.link?.user_id || media.kind !== kind) return notFound();
  const requested =
    kind === "banner"
      ? Number(new URL(request.url).searchParams.get("size") ?? 1600)
      : Number(new URL(request.url).searchParams.get("size") ?? 256);
  const rendition = renditionForSize(media, Number.isFinite(requested) ? requested : 256);
  if (!rendition) return notFound();
  const object = await ctx.media.get(rendition.r2_key);
  if (!object) {
    if (kind === "avatar") {
      return new Response(null, {
        status: 302,
        headers: { location: defaultAvatarSrc(FALLBACK_AVATAR_KEY), "cache-control": "no-store" },
      });
    }
    return notFound();
  }
  const publicView = view.publicView;
  return new Response(await object.arrayBuffer(), {
    headers: {
      "content-type": rendition.mime,
      "content-length": String(rendition.bytes),
      "cache-control": publicView ? "public, max-age=3600" : "private, no-store",
      vary: "cookie",
      etag: `"${rendition.sha256.slice(0, 32)}"`,
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "same-origin",
    },
  });
};
