#!/usr/bin/env node
/**
 * Read-only production smoke test. No credentials required.
 */
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { assertCurrentBrandPage } from "./lib/brand-smoke.mjs";

const base = process.env.FOILBURY_URL ?? "https://foilbury.loftwah.com";
const expectedBuild = process.env.FOILBURY_EXPECTED_BUILD?.trim() || null;
const evidence = path.join(".foilbury", "evidence");
fs.mkdirSync(evidence, { recursive: true });
const runId=process.env.FOILBURY_SMOKE_RUN_ID ?? randomUUID();
if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) throw new Error("Invalid smoke run identifier.");
const smokeFile=path.join(evidence,`deployed-smoke-${runId}.json`);
const results = [];
const pass = (name, detail = "") => { results.push({ name, status: "PASS", detail }); console.log(`PASS ${name}${detail ? ` · ${detail}` : ""}`); };
const fail = (name, error) => { results.push({ name, status: "FAIL", detail: String(error?.message ?? error) }); console.error(`FAIL ${name} · ${error?.message ?? error}`); };

async function get(url, options = {}) {
  const response = await fetch(`${base}${url}`, { redirect: "manual", ...options });
  return { status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() };
}

try {
  const homeResponse = await get("/");
  if (expectedBuild) {
    const actual = homeResponse.headers["x-foilbury-build"];
    if (actual !== expectedBuild) {
      throw new Error(
        `Production build identity is ${actual ?? "missing"}, expected ${expectedBuild}.`,
      );
    }
    pass("production answers with the expected source build identity", expectedBuild.slice(0, 12));
  }
  for (const route of ["/", "/cabinet", "/cabinet/tux", "/login", "/tour", "/brand-kit", "/showcase", "/sitemap-public.xml", "/robots.txt"]) {
    const response = await get(route);
    if (response.status !== 200) throw new Error(`${route} returned ${response.status}`);
    pass(`production ${route} responds 200`);
  }
  const brand = await get("/brand-kit");
  assertCurrentBrandPage(brand.body);
  for (const asset of [
    "/brand/kit/colophon/mark.svg",
    "/brand/kit/colophon/wordmark-ink.svg",
    "/brand/kit/colophon/discord-avatar-1024.png",
    "/brand/kit/colophon/social-preview.png",
    "/brand/kit/colophon/artwork-unavailable.svg",
    "/brand/kit/systems/signal-fold/icon-512.png",
    "/brand/kit/systems/signal-fold/banner-960x540.png",
    "/brand/kit/systems/bastion/icon-512.png",
    "/brand/kit/systems/aperture/icon-512.png",
    "/brand/kit/selection.json",
  ]) {
    const response = await get(asset);
    if (response.status !== 200) throw new Error(`${asset} returned ${response.status}`);
  }
  pass("production brand assets and retained archive respond");
  const tour = await get("/tour");
  if (!tour.body.includes("Hold it to the light") && !tour.body.includes("Inspect both faces")) throw new Error("Website tour is missing its inspection stage.");
  pass("production website tour is present and uses real public cards");
  const showcase = await get("/showcase");
  if (!showcase.body.includes("foilbury-trailer-16x9.mp4")) throw new Error("Showcase page is missing the playable trailer.");
  pass("production showcase exposes playable public video");
  const studio = await get("/studio");
  if (![301, 302, 303, 307, 308].includes(studio.status)) throw new Error(`/studio returned ${studio.status}, expected a login redirect.`);
  const studioApi = await get("/api/v1/studio/collections");
  if (studioApi.status !== 401) throw new Error(`/api/v1/studio/collections returned ${studioApi.status}, expected 401.`);
  pass("production Studio requires a signed-in scoped session");
  const home = await get("/");
  for (const secret of ["Shai Gilgeous-Alexander", "nba-opening-night", "Chainsaw Man", "Death Note"]) {
    if (home.body.includes(secret)) throw new Error(`Production homepage leaks ${secret}`);
  }
  pass("production public HTML contains no member catalogue content");

  const collections = JSON.parse((await get("/api/v1/collections")).body);
  if (collections.items.some((item) => item.slug === "nba-opening-night")) throw new Error("Signed-out collection API includes NBA.");
  if (!collections.items.some((item) => item.slug === "bubbles")) throw new Error("Signed-out collection API is missing Bubbles.");
  pass("production signed-out collection API is public-only", `${collections.items.length} public collections`);

  const pool = await get("/api/v1/pools/cabinet-draw");
  if (pool.status !== 401) throw new Error(`Signed-out pool preview returned ${pool.status}, expected 401.`);
  const admin = await get("/admin");
  if (![301, 302, 303, 307, 308, 403].includes(admin.status)) throw new Error(`/admin returned ${admin.status}`);
  pass("production pool preview and administration are protected", `admin ${admin.status}`);

  const sitemap = await get("/sitemap-public.xml");
  if (/nba-opening-night|shai-gilgeous-alexander/i.test(sitemap.body)) throw new Error("Production sitemap leaks member content.");
  if (!sitemap.body.includes("cabinet/tux")) throw new Error("Production sitemap is missing a public card.");
  pass("production sitemap is public-only");

  fs.writeFileSync(smokeFile, JSON.stringify({ generated_at: new Date().toISOString(), base, expected_build: expectedBuild, results }, null, 2),{flag:"wx",mode:0o600});
} catch (error) {
  console.error(error?.stack ?? error);
  fail("deployed smoke", error);
  fs.writeFileSync(smokeFile, JSON.stringify({ generated_at: new Date().toISOString(), base, expected_build: expectedBuild, results }, null, 2),{flag:"wx",mode:0o600});
  process.exitCode = 1;
}
