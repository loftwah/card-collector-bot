import type { APIRoute } from "astro";
import { ApiError, buildContext } from "../../../server/context";
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
    const segments = (params.path ?? "").split("/").filter(Boolean);
    if (!(error instanceof ApiError) && request.method === "POST" && segments.length === 4 &&
        (segments[0] === "admin" || segments[0] === "studio") && segments[1] === "wallets" && segments[2] && segments[3] === "adjust") {
      console.error(JSON.stringify({ level: "error", request_id: requestId, message: error instanceof Error ? error.message : "Unexpected grant error" }));
      return apiErrorResponse(new ApiError(503, "grant_outcome_unavailable", "The grant outcome could not be confirmed. Retry the same grant or check the ledger."), requestId);
    }
    return apiErrorResponse(error, requestId);
  }
};

export const GET = ALL;
export const POST = ALL;
export const PATCH = ALL;
export const PUT = ALL;
export const DELETE = ALL;
