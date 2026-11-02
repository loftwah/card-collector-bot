import type { APIRoute } from "astro";
import { buildContext } from "../../../server/context";
import { derivativeResponse } from "../../../server/modules/media";

export const prerender = false;

export const GET: APIRoute = async ({ request, params }) => {
  const ctx = await buildContext(request);
  return derivativeResponse(ctx, ctx.media, params.id ?? "", request);
};
