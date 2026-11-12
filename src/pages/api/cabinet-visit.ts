import type { APIRoute } from "astro";
import { readConfig } from "../../server/config";
import { ApiError, checkRateLimit, runtimeEnv, trustedClientKey } from "../../server/context";
import { hmacHex } from "../../server/ids";
import {
  hasEmptyCabinetVisitBody,
  recordCabinetVisit,
} from "../../server/modules/cabinet-analytics";

export const prerender = false;

const reply = (status: number) =>
  new Response(null, { status, headers: { "cache-control": "no-store" } });

export const POST: APIRoute = async ({ request, url }) => {
  const env = runtimeEnv();
  const headers = request.headers;
  const fetchSite = headers.get("sec-fetch-site");
  if (
    env.FOILBURY_ENV !== "production" ||
    url.origin !== env.FOILBURY_PUBLIC_ORIGIN ||
    headers.get("origin") !== url.origin ||
    (fetchSite && fetchSite !== "same-origin")
  )
    return reply(403);
  if (
    headers.get("dnt") === "1" ||
    headers.get("sec-gpc") === "1" ||
    /bot|crawler|spider|headless|playwright/i.test(headers.get("user-agent") ?? "")
  )
    return reply(204);

  if (url.search || !(await hasEmptyCabinetVisitBody(request))) return reply(400);
  if (!headers.has("cf-connecting-ip")) return reply(403);

  try {
    const config = readConfig(env);
    const now = new Date();
    const client = await trustedClientKey(request, config);
    const day = now.toISOString().slice(0, 10);
    const bucket = await hmacHex(config.sessionSecret, `public-cabinet:${day}:${client}`);
    await checkRateLimit(env.DB, `public-cabinet:${bucket}`, 20, 60);
    await recordCabinetVisit(env.DB, now);
    return reply(204);
  } catch (error) {
    return reply(error instanceof ApiError && error.status === 429 ? 429 : 503);
  }
};
