import type { APIRoute } from "astro";
import { publicRenderGET } from "../../../server/modules/media";

export const prerender = false;
export const GET: APIRoute = publicRenderGET;
