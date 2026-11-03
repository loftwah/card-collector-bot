import { ApiError, requireRole, requireSuperAdmin, type Ctx } from "./context";
import { ACCESS_HANDOFF_QUERY, ACCESS_SESSION_HEADER, safeAccessReturnTo, type AccessArea } from "../lib/access-session";

/** The route's buildContext must verify its own API audience before this runs. */
export function accessSessionResponse(request: Request, ctx: Ctx, area: AccessArea): Response {
  if (request.method !== "GET" && request.method !== "HEAD") {
    throw new ApiError(405, "method_not_allowed", "Use GET to continue signing in.");
  }
  if (ctx.actor.type !== "user") {
    throw new ApiError(403, "human_required", "Sign in to continue to administration.");
  }
  if (ctx.config.access.enabled) {
    const audience = area === "platform" ? ctx.config.access.platformApiAudience : ctx.config.access.apiAudience;
    if (!audience || ctx.accessStatus !== "linked" || ctx.accessIdentity?.audience !== audience) {
      throw new ApiError(403, "access_identity_required", "Cloudflare Access identity is not linked to this administration session.");
    }
  } else if (ctx.config.environment !== "local") {
    throw new ApiError(403, "access_required", "Administrative access requires Cloudflare Access.");
  }
  if (area === "platform") requireSuperAdmin(ctx);
  else requireRole(ctx, ["owner", "editor", "economy_admin"]);

  const url = new URL(request.url);
  const headers = new Headers({ "cache-control": "no-store", [ACCESS_SESSION_HEADER]: area });
  if (url.searchParams.get("check") === "1") return new Response(null, { status: 204, headers });

  const destination = new URL(safeAccessReturnTo(url.searchParams.get("returnTo"), area), url.origin);
  destination.searchParams.set(ACCESS_HANDOFF_QUERY, area);
  headers.set("location", `${destination.pathname}${destination.search}${destination.hash}`);
  return new Response(null, { status: 303, headers });
}
