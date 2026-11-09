import type { APIRoute } from "astro";
import { buildContext } from "../../../../server/context";
import { accessSessionResponse } from "../../../../server/access-session";
import { apiErrorResponse } from "../../../../server/http";
import { requestReference } from "../../../../server/ids";

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  try {
    return accessSessionResponse(request, await buildContext(request), "admin");
  } catch (error) {
    return apiErrorResponse(error, requestReference(request));
  }
};
