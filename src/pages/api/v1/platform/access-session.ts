import type { APIRoute } from "astro";
import { buildContext } from "../../../../server/context";
import { accessSessionResponse } from "../../../../server/access-session";
import { apiErrorResponse } from "../../../../server/http";

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  try {
    return accessSessionResponse(request, await buildContext(request), "platform");
  } catch (error) {
    return apiErrorResponse(error, request.headers.get("cf-ray") ?? crypto.randomUUID());
  }
};
