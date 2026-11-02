import type { APIRoute } from "astro";
import { renderGET } from "../../../server/modules/media";

export const prerender = false;
export const GET: APIRoute = renderGET;
