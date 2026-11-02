#!/usr/bin/env node
/**
 * SEO acceptance for the approved public surface only.
 */
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const baseURL = process.env.FOILBURY_URL ?? "http://localhost:5173";
const evidence = path.join(".foilbury", "evidence");
fs.mkdirSync(evidence, { recursive: true });
const results = [];
const pass = (name, detail = "") => { results.push({ name, status: "PASS", detail }); console.log(`PASS ${name}${detail ? ` · ${detail}` : ""}`); };
const fail = (name, error) => { results.push({ name, status: "FAIL", detail: String(error?.message ?? error) }); console.error(`FAIL ${name} · ${error?.message ?? error}`); };

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const banned = ["Shai Gilgeous-Alexander", "nba-opening-night", "Chainsaw Man", "Death Note", "Holographic Miku"];

try {
  for (const route of ["/", "/cabinet", "/cabinet/tux"]) {
    const response = await page.goto(`${baseURL}${route}`, { waitUntil: "networkidle" });
    if (!response || response.status() !== 200) throw new Error(`${route} returned ${response?.status()}`);
    const title = await page.title();
    const description = await page.locator('meta[name="description"]').getAttribute("content");
    const canonical = await page.locator('link[rel="canonical"]').getAttribute("href");
    const h1 = await page.locator("h1").first().innerText();
    if (!title || title.length < 10) throw new Error(`${route} has no useful title`);
    if (!description || description.length < 40) throw new Error(`${route} has no useful description`);
    if (!canonical?.startsWith("https://foilbury.loftwah.com")) throw new Error(`${route} canonical is ${canonical}`);
    if (!h1.trim()) throw new Error(`${route} has no h1`);
    const html = await page.content();
    for (const secret of banned) if (html.includes(secret)) throw new Error(`${route} leaks ${secret}`);
    pass(`${route} has title, description, canonical, h1 and no member catalogue text`, title.slice(0, 70));
  }

  const jsonLd = await page.locator('script[type="application/ld+json"]').first().textContent();
  const data = JSON.parse(jsonLd ?? "{}");
  if (data["@type"] !== "VisualArtwork") throw new Error(`Unexpected card JSON-LD type: ${data["@type"]}`);
  if (!data.image?.startsWith("https://")) throw new Error("Card JSON-LD image is not absolute");
  pass("public card emits valid VisualArtwork JSON-LD");

  const sitemap = await page.request.get(`${baseURL}/sitemap-public.xml`);
  const sitemapBody = await sitemap.text();
  if (sitemap.status() !== 200) throw new Error(`sitemap returned ${sitemap.status()}`);
  if (banned.some((secret) => sitemapBody.includes(secret))) throw new Error("sitemap contains member content");
  if (!sitemapBody.includes("cabinet/tux")) throw new Error("sitemap is missing a public card");
  pass("public sitemap is reachable and public-only");

  const robots = await page.request.get(`${baseURL}/robots.txt`);
  const robotsBody = await robots.text();
  for (const pathName of ["/admin", "/play", "/api", "/platform-admin"]) {
    if (!robotsBody.includes(`Disallow: ${pathName}`)) throw new Error(`robots.txt does not disallow ${pathName}`);
  }
  if (!robotsBody.includes("/sitemap-public.xml")) throw new Error("robots.txt does not reference the public sitemap");
  pass("robots.txt excludes private surfaces and references the public sitemap");

  fs.writeFileSync(path.join(evidence, "seo-browser.json"), JSON.stringify({ generated_at: new Date().toISOString(), results }, null, 2));
} catch (error) {
  console.error(error?.stack ?? error);
  fail("SEO acceptance", error);
  fs.writeFileSync(path.join(evidence, "seo-browser.json"), JSON.stringify({ generated_at: new Date().toISOString(), results }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
