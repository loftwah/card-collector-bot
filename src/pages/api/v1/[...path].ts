import type { APIRoute } from "astro";
import { buildContext } from "../../../server/context";
import { apiErrorResponse, json } from "../../../server/http";
import { routeApi } from "../../../server/api/router";
import { newId } from "../../../server/ids";

export const prerender = false;

export const ALL: APIRoute = async ({ request, params }) => {
  const requestId = request.headers.get("cf-ray") ?? newId("req");
  try {
    const ctx = await buildContext(request);
    const response = await routeApi(request, ctx, params.path ?? "");
    response.headers.set("x-request-id", requestId);
    return response;
  } catch (error) {
    return apiErrorResponse(error, requestId);
  }
};

export const GET = ALL;
export const POST = ALL;
export const PATCH = ALL;
export const PUT = ALL;
export const DELETE = ALL;
