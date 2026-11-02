import type { APIRoute } from "astro";
import { ApiError, buildContext } from "../../../server/context";
import { json, apiErrorResponse } from "../../../server/http";
import { getWallet } from "../../../server/modules/wallet";
import { newId } from "../../../server/ids";

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const requestId = newId("req");
  try {
    const ctx = await buildContext(request);
    if (!ctx.user) throw new ApiError(401, "authentication_required", "Sign in to continue.");
    const wallet = await getWallet(ctx.db, ctx.tenant.id, ctx.user.id);
    return json({
      user: ctx.user,
      tenant: ctx.tenant,
      actor: ctx.actor,
      scopes: ctx.scopes,
      csrf_token: ctx.csrfToken,
      wallet,
    });
  } catch (error) {
    return apiErrorResponse(error, requestId);
  }
};
