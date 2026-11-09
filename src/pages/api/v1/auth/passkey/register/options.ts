import type { APIRoute } from "astro";
import { buildContext } from "../../../../../../server/context";
import { apiErrorResponse, json } from "../../../../../../server/http";
import { requestReference } from "../../../../../../server/ids";
import { registrationOptions } from "../../../../../../server/modules/passkeys";

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  try {
    const ctx = await buildContext(request);
    return json(await registrationOptions(ctx, request), 200, { "cache-control": "no-store" });
  } catch (error) {
    return apiErrorResponse(error, requestReference(request));
  }
};
