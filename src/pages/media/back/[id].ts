import type { APIRoute } from "astro";
import { backRenderGET } from "../../../server/modules/media";

export const prerender = false;
export const GET: APIRoute = backRenderGET;
