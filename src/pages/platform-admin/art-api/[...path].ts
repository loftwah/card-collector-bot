import type { APIRoute } from "astro";
import { assertCsrf, buildContext } from "../../../server/context";
import { routeArtLab } from "../../../server/api/art-lab-routes";
import { apiErrorResponse } from "../../../server/http";
import { newId } from "../../../server/ids";

export const prerender = false;

/**
 * Same-origin transport for the Access-protected platform Art Lab.
 *
 * `/api/v1/admin/*` is a separate Cloudflare Access application from
 * `/platform-admin`. The browser is authenticated to the page application, so
 * a client fetch to the API path is challenged and redirected cross-origin,
 * which the CSP blocks. This route stays inside the page application, performs
 * the same CSRF check as the main API dispatcher, and then invokes the one Art
 * Lab module. It is not a second authority surface: routeArtLab still requires
 * the provisioned Super Admin and the page middleware still requires Access.
 */
const handler: APIRoute = async ({ request, params, url }) => {
  const requestId = newId("req");
  try {
    const ctx = await buildContext(request);
    const method = request.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") assertCsrf(ctx, request);
    const path = (params.path ?? "")
      .split("/")
      .map((segment) => segment.trim())
      .filter(Boolean);
    return await routeArtLab(request, ctx, ["admin", "art", ...path], url, method);
  } catch (error) {
    return apiErrorResponse(error, requestId);
  }
};

export const GET = handler;
export const HEAD = handler;
export const POST = handler;
export const PATCH = handler;
