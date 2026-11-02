#!/usr/bin/env node
/**
 * Privacy acceptance across anonymous, member, public-showcase and media
 * surfaces. This is intentionally an HTTP/browser test, not a schema check.
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
const anonymousContext = await browser.newContext({ baseURL });
const anonymous = await anonymousContext.newPage();

async function json(page, url) {
  const response = await page.request.get(url);
  return { status: response.status(), headers: response.headers(), body: await response.json().catch(() => null) };
}
async function text(page, url) {
  const response = await page.request.get(url);
  return { status: response.status(), headers: response.headers(), body: await response.text() };
}

try {
  const adminContext = await browser.newContext({ baseURL });
  await adminContext.request.post("/api/v1/dev/login", { data: { email: "owner@foilbury.local" } });
  const admin = await adminContext.newPage();
  const collections = await json(admin, "/api/v1/admin/collections");
  const nba = collections.body.items.find((item) => item.slug === "nba-opening-night");
  if (!nba) throw new Error("The NBA member collection was not found. Run the content provisioning first.");
  const cards = await json(admin, "/api/v1/admin/cards?limit=200");
  const memberCard = cards.body.items.find((card) => card.collections.some((collection) => collection.slug === "nba-opening-night"));
  if (!memberCard) throw new Error("The NBA member card was not found.");
  const memberVariant = memberCard.editions.flatMap((edition) => edition.variants).find((variant) => variant.render_url);
  const memberAsset = memberVariant.render_url.split("/").pop();
  const memberBack = memberVariant.back_render_url?.split("/").pop();
  const publicCard = cards.body.items.find((card) => card.slug === "tux");
  const publicVariant = publicCard.editions.flatMap((edition) => edition.variants).find((variant) => variant.render_url);
  const publicAsset = publicVariant.render_url.split("/").pop();

  const anonCollections = await json(anonymous, "/api/v1/collections");
  if (anonCollections.body.items?.some((item) => item.slug === "nba-opening-night")) throw new Error("Anonymous collection list contains the NBA member collection.");
  if (!anonCollections.body.items?.some((item) => item.slug === "bubbles")) throw new Error("Anonymous collection list is missing the public Bubbles collection.");
  pass("anonymous collection list contains public showcase only");

  const anonCatalogue = await json(anonymous, "/api/v1/catalogue?search=Shai");
  if (anonCatalogue.body.items?.length) throw new Error("Anonymous public catalogue search returned a member card.");
  const anonCard = await json(anonymous, `/api/v1/cards/${memberCard.id}`);
  if (anonCard.status !== 404) throw new Error(`Anonymous direct card read returned ${anonCard.status}, expected 404.`);
  pass("anonymous search and direct card reads are denied");

  const anonCabinet = await text(anonymous, "/cabinet");
  for (const secret of ["NBA", "Shai Gilgeous-Alexander", "nba-opening-night"]) {
    if (anonCabinet.body.includes(secret)) throw new Error(`Public cabinet HTML leaks ${secret}.`);
  }
  const anonCardPage = await anonymous.goto(`/cabinet/${memberCard.slug}`, { waitUntil: "domcontentloaded" });
  if (anonymous.url().includes(memberCard.slug)) throw new Error("Anonymous card page did not redirect away.");
  pass("public HTML and card routes do not contain member catalogue content");

  const anonRender = await anonymous.request.get(`/media/render/${memberAsset}`);
  if (anonRender.status() !== 404) throw new Error(`Anonymous member render returned ${anonRender.status()}, expected 404.`);
  const anonLegacy = await anonymous.request.get(`/media/public/${memberAsset}`);
  if (anonLegacy.status() !== 404) throw new Error(`Anonymous legacy public render returned ${anonLegacy.status()}, expected 404.`);
  if (memberBack) {
    const anonBack = await anonymous.request.get(`/media/back/${memberBack}`);
    if (anonBack.status() !== 404) throw new Error(`Anonymous member back returned ${anonBack.status()}, expected 404.`);
  }
  pass("member front, back and legacy public media URLs are denied while signed out");

  const anonPool = await json(anonymous, "/api/v1/pools/cabinet-draw");
  if (anonPool.status !== 401) throw new Error(`Anonymous pool preview returned ${anonPool.status}, expected 401.`);
  const sitemap = await text(anonymous, "/sitemap-public.xml");
  if (/nba-opening-night|shai-gilgeous-alexander/i.test(sitemap.body)) throw new Error("Sitemap includes member catalogue content.");
  if (!/cabinet\/tux/.test(sitemap.body)) throw new Error("Sitemap is missing the public Tux card.");
  pass("pool preview is authenticated and the sitemap is public-only");

  const publicRender = await anonymous.request.get(`/media/render/${publicAsset}`);
  if (publicRender.status() !== 200) throw new Error(`Public render returned ${publicRender.status()}.`);
  const publicCache = publicRender.headers()["cache-control"] ?? "";
  if (!publicCache.includes("public")) throw new Error(`Public render cache-control is ${publicCache}.`);
  const publicLegacy = await anonymous.request.get(`/media/public/${publicAsset}`);
  if (publicLegacy.status() !== 200) throw new Error(`Public legacy render returned ${publicLegacy.status()}.`);
  pass("approved public renders remain publicly readable and cacheable", publicCache);

  const memberContext = await browser.newContext({ baseURL });
  await memberContext.request.post("/api/v1/dev/login", { data: { email: "player@foilbury.local" } });
  const member = await memberContext.newPage();
  const memberCollections = await json(member, "/api/v1/collections");
  if (!memberCollections.body.items?.some((item) => item.slug === "nba-opening-night")) throw new Error("Member collection list is missing the NBA album.");
  const memberRead = await member.request.get(`/media/render/${memberAsset}`);
  if (memberRead.status() !== 200) throw new Error(`Member render returned ${memberRead.status()}.`);
  const memberCache = memberRead.headers()["cache-control"] ?? "";
  if (!memberCache.includes("private")) throw new Error(`Member render cache-control is ${memberCache}.`);
  const memberCardApi = await json(member, `/api/v1/cards/${memberCard.id}`);
  if (memberCardApi.status !== 200) throw new Error(`Member direct card read returned ${memberCardApi.status}.`);
  pass("member can read the entitled catalogue and private media with no-store", memberCache);

  const otherContext = await browser.newContext({ baseURL });
  const otherLogin = await otherContext.request.post("/api/v1/dev/login", { data: { email: "harbour.owner@foilbury.test", tenant: "harbour" } });
  if (otherLogin.status() !== 200) throw new Error(`Harbour dev login returned ${otherLogin.status()}`);
  const other = await otherContext.newPage();
  const otherCollections = await json(other, "/api/v1/collections");
  const otherPrivate = otherCollections.body.items?.find((item) => item.scope === "bot" && item.slug !== "first-cards");
  if (otherPrivate) throw new Error(`Unrelated Bot member can see a Bot-private collection: ${otherPrivate.slug}`);
  const otherMedia = await other.request.get(`/media/render/${memberAsset}`);
  if (otherMedia.status() !== 200) throw new Error(`Global member render is not reusable by another Bot member: ${otherMedia.status()}`);
  pass("global member catalogue media is reusable by an authorised Bot member", `render status ${otherMedia.status()}`);

  fs.writeFileSync(path.join(evidence, "privacy-browser.json"), JSON.stringify({
    generated_at: new Date().toISOString(),
    member_card: memberCard.slug,
    member_asset: memberAsset,
    public_card: publicCard.slug,
    results,
  }, null, 2));
  pass("privacy evidence written");
} catch (error) {
  console.error(error?.stack ?? error);
  fail("privacy acceptance", error);
  fs.writeFileSync(path.join(evidence, "privacy-browser.json"), JSON.stringify({ generated_at: new Date().toISOString(), results }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
