import type { APIRoute } from "astro";
import { runtimeEnv } from "../../server/context";
import {
  cabinetReportingWindow,
  publicCabinetAnalytics,
} from "../../server/modules/cabinet-analytics";

export const prerender = false;

const unavailable = (status: number) =>
  Response.json({ available: false }, { status, headers: { "cache-control": "no-store" } });

export const GET: APIRoute = async ({ url }) => {
  const now = new Date();
  const period = cabinetReportingWindow(url.searchParams, now);
  if (!period) return unavailable(400);

  const env = runtimeEnv();
  try {
    const endpoint = new URL("/api/portfolio-analytics", env.FOILBURY_PUBLIC_ORIGIN ?? url.origin)
      .href;
    const report = await publicCabinetAnalytics(
      env.DB,
      period,
      now,
      endpoint,
      env.FOILBURY_BUILD_SHA ?? null,
    );
    return Response.json(report, {
      headers: { "cache-control": "public, max-age=60", "access-control-allow-origin": "*" },
    });
  } catch {
    return unavailable(503);
  }
};
