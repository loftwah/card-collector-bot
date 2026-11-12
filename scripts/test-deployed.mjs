#!/usr/bin/env node
/**
 * Read-only production HTTP smoke. No credentials required.
 * This verifies transport, source identity and the explicit checks below;
 * it does not verify signed-in interactions, visual quality or product acceptance.
 */
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

const base = process.env.FOILBURY_URL ?? "https://foilbury.loftwah.com";
const expectedBuild = process.env.FOILBURY_EXPECTED_BUILD?.trim() || null;
const evidence = path.join(".foilbury", "evidence");
fs.mkdirSync(evidence, { recursive: true });
const runId=process.env.FOILBURY_SMOKE_RUN_ID ?? randomUUID();
if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) throw new Error("Invalid smoke run identifier.");
const smokeFile=path.join(evidence,`deployed-smoke-${runId}.json`);
const verificationScope = "read-only HTTP smoke; signed-in browser journeys, visual quality and product acceptance are not assessed";
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
  // #26 rejects Signal Fold. HTTP smoke must not require that rejected identity
  // or historical alternatives to remain selected. The route check above is
  // availability evidence only; inspect current artwork in its real UI separately.
  const tour = await get("/tour");
  if (!tour.body.includes("Hold it to the light") && !tour.body.includes("Inspect both faces")) throw new Error("Website tour is missing its inspection stage.");
  pass("production website tour contains its inspection-stage text");
  const showcase = await get("/showcase");
  if (!showcase.body.includes("foilbury-trailer-16x9.mp4")) throw new Error("Showcase page is missing the trailer reference.");
  pass("production showcase HTML references the trailer; playback is not assessed");
  const studio = await get("/studio");
  if (![301, 302, 303, 307, 308].includes(studio.status)) throw new Error(`/studio returned ${studio.status}, expected a login redirect.`);
  const studioApi = await get("/api/v1/studio/collections");
  if (studioApi.status !== 401) throw new Error(`/api/v1/studio/collections returned ${studioApi.status}, expected 401.`);
  pass("production Studio rejects these signed-out page and API requests");
  const home = await get("/");
  for (const secret of ["Shai Gilgeous-Alexander", "nba-opening-night", "Chainsaw Man", "Death Note"]) {
    if (home.body.includes(secret)) throw new Error(`Production homepage leaks ${secret}`);
  }
  pass("production public HTML excludes the checked member catalogue markers");

  const collections = JSON.parse((await get("/api/v1/collections")).body);
  if (collections.items.some((item) => item.slug === "nba-opening-night")) throw new Error("Signed-out collection API includes NBA.");
  if (!collections.items.some((item) => item.slug === "bubbles")) throw new Error("Signed-out collection API is missing Bubbles.");
  pass("production signed-out collection API excludes NBA and includes Bubbles", `${collections.items.length} returned collections`);

  const pool = await get("/api/v1/pools/cabinet-draw");
  if (pool.status !== 401) throw new Error(`Signed-out pool preview returned ${pool.status}, expected 401.`);
  const admin = await get("/admin");
  if (![301, 302, 303, 307, 308, 403].includes(admin.status)) throw new Error(`/admin returned ${admin.status}`);
  pass("production pool preview and administration reject these signed-out requests", `admin ${admin.status}`);

  const sitemap = await get("/sitemap-public.xml");
  if (/nba-opening-night|shai-gilgeous-alexander/i.test(sitemap.body)) throw new Error("Production sitemap leaks member content.");
  if (!sitemap.body.includes("cabinet/tux")) throw new Error("Production sitemap is missing a public card.");
  const sitemapLocations = [...sitemap.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => new URL(match[1]));
  if (!sitemapLocations.some((url) => url.pathname === "/cabinet" && !url.search)) throw new Error("Production sitemap is missing the canonical cabinet.");
  if (sitemapLocations.some((url) => url.pathname === "/login" || url.search)) throw new Error("Production sitemap includes the noindex login or a filtered URL.");
  pass("production sitemap includes the public cabinet and card and excludes login, filters, and member content");

  fs.writeFileSync(smokeFile, JSON.stringify({ generated_at: new Date().toISOString(), base, expected_build: expectedBuild, verification_scope: verificationScope, product_acceptance: "not_assessed", results }, null, 2),{flag:"wx",mode:0o600});
} catch (error) {
  console.error(error?.stack ?? error);
  fail("deployed HTTP smoke", error);
  fs.writeFileSync(smokeFile, JSON.stringify({ generated_at: new Date().toISOString(), base, expected_build: expectedBuild, verification_scope: verificationScope, product_acceptance: "not_assessed", results }, null, 2),{flag:"wx",mode:0o600});
  process.exitCode = 1;
}
