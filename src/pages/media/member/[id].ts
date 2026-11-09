import type { APIRoute } from "astro";
import { buildContext } from "../../../server/context";
import {
  FALLBACK_AVATAR_KEY,
  defaultAvatarSrc,
  memberMediaById,
  renditionForSize,
} from "../../../server/modules/account-avatar";

export const prerender = false;

function notFound(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

export const GET: APIRoute = async ({ request, params }) => {
  const ctx = await buildContext(request);
  if (!ctx.user) {
    return new Response("Authentication required", {
      status: 401,
      headers: { "cache-control": "no-store" },
    });
  }
  const media = await memberMediaById(ctx, params.id ?? "");
  if (!media || media.user_id !== ctx.user.id) return notFound();
  const requested = Number(new URL(request.url).searchParams.get("size") ?? 256);
  const rendition = renditionForSize(media, Number.isFinite(requested) ? requested : 256);
  if (!rendition) return notFound();
  const object = await ctx.media.get(rendition.r2_key);
  if (!object) {
    // A missing private object must never surface as initials or a broken icon.
    if (media.kind === "avatar") {
      return new Response(null, {
        status: 302,
        headers: {
          location: defaultAvatarSrc(FALLBACK_AVATAR_KEY),
          "cache-control": "no-store",
        },
      });
    }
    return notFound();
  }
  return new Response(await object.arrayBuffer(), {
    headers: {
      "content-type": rendition.mime,
      "content-length": String(rendition.bytes),
      "cache-control": "private, no-store",
      vary: "cookie",
      etag: `"${rendition.sha256.slice(0, 32)}"`,
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "same-origin",
    },
  });
};
