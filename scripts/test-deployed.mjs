#!/usr/bin/env node
import { pathToFileURL } from "node:url";

export const PRODUCTION_ORIGIN = "https://foilbury.loftwah.com";

async function read(base, path, signal) {
  const response = await fetch(new URL(path, base), {
    redirect: "manual",
    cache: "no-store",
    signal,
  });
  const body = await response.text();
  return { status: response.status, build: response.headers.get("x-foilbury-build"), body };
}

export async function readLiveHome({ base = PRODUCTION_ORIGIN, signal } = {}) {
  const home = await read(base, "/", signal);
  if (home.status !== 200) throw new Error(`Production home returned ${home.status}.`);
  return home;
}

export async function verifyLive({ base = PRODUCTION_ORIGIN, home, expectedBuild, signal }) {
  if (expectedBuild && home.build !== expectedBuild) {
    throw new Error(`Production build is ${home.build ?? "missing"}, expected ${expectedBuild}.`);
  }
  const privateMarkers = /nba-opening-night|shai gilgeous-alexander|chainsaw man|death note/i;
  if (privateMarkers.test(home.body))
    throw new Error("Production homepage contains member catalogue content.");

  const routes = [
    ["/cabinet", [200]],
    ["/api/v1/collections", [200]],
    ["/studio", [301, 302, 303, 307, 308]],
    ["/api/v1/studio/collections", [401]],
    ["/api/v1/pools/cabinet-draw", [401]],
    ["/admin", [301, 302, 303, 307, 308, 403]],
    ["/sitemap-public.xml", [200]],
  ];
  const results = await Promise.all(
    routes.map(async ([route, statuses]) => {
      const response = await read(base, route, signal);
      if (!statuses.includes(response.status))
        throw new Error(`${route} returned ${response.status}, expected ${statuses.join(" or ")}.`);
      // Cloudflare Access may answer /admin before the request reaches the Worker.
      const accessResponse = route === "/admin" && !response.build;
      if (expectedBuild && !accessResponse && response.build !== expectedBuild) {
        throw new Error(`${route} did not serve the expected build.`);
      }
      return response;
    }),
  );
  const collections = JSON.parse(results[1].body);
  if (
    !collections.items.some((item) => item.slug === "bubbles") ||
    collections.items.some((item) => item.slug === "nba-opening-night")
  ) {
    throw new Error("Signed-out collection listing does not match its public audience.");
  }
  const sitemap = results.at(-1).body;
  if (privateMarkers.test(sitemap) || /shai-gilgeous-alexander/i.test(sitemap)) {
    throw new Error("Public sitemap contains member catalogue content.");
  }
  return [
    { route: "/", status: home.status },
    ...routes.map(([route], index) => ({ route, status: results[index].status })),
  ];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const base = process.env.FOILBURY_URL ?? PRODUCTION_ORIGIN;
  const signal = AbortSignal.timeout(15_000);
  const home = await readLiveHome({ base, signal });
  const results = await verifyLive({
    base,
    home,
    signal,
    expectedBuild: process.env.FOILBURY_EXPECTED_BUILD,
  });
  for (const { route, status } of results) console.log(`PASS ${route} ${status}`);
}
