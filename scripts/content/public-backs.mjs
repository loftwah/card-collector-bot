#!/usr/bin/env node
/**
 * Build designed public-safe card backs from the approved public catalogue and
 * publish them through the same authenticated back-render endpoint.
 *
 * This does not change fronts, variants, ownership, serials or the award ledger.
 * Run against the local server first; production requires a backup and approval.
 *
 *   node scripts/content/public-backs.mjs --dry-run
 *   node scripts/content/public-backs.mjs --apply
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { publicBackHtml } from "./public-back-template.mjs";
import { composeCardBack } from "../../art/compose.mjs";
import {
  apiForm,
  apiJson,
  agentToken,
  accessHeaders,
  ensureServer,
  BASE_URL,
} from "../lib/api.mjs";

const apply = process.argv.includes("--apply");
const root = process.cwd();
const outDir = path.join(root, ".foilbury", "generated", "public-backs");
const tmpDir = path.join(root, ".foilbury", "tmp");
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(tmpDir, { recursive: true });

await ensureServer();
const catalogue = await apiJson("/api/v1/catalogue?limit=2000");
const cards = catalogue.items.filter(
  (card) =>
    card.editions.some((edition) => edition.variants.some((variant) => variant.render_url)) &&
    card.collections.length > 0 &&
    card.collections.every((collection) => collection.view_audience === "public"),
);
const manrope = fs
  .readFileSync(path.join(root, "public", "fonts", "manrope-latin.woff2"))
  .toString("base64");
const fraunces = fs
  .readFileSync(path.join(root, "public", "fonts", "Fraunces.ttf"))
  .toString("base64");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ deviceScaleFactor: 1 });
await page.setViewportSize({ width: 750, height: 1050 });

const rows = [];
for (const card of cards) {
  const collection = card.collections[0];
  let logo = "";
  if (collection?.logo_url) {
    try {
      const response = await fetch(`${BASE_URL}${collection.logo_url}`, {
        headers: { authorization: `Bearer ${agentToken()}`, ...accessHeaders() },
      });
      if (response.ok)
        logo = `data:${collection.logo_url.endsWith(".svg") ? "image/svg+xml" : "image/png"};base64,${Buffer.from(await response.arrayBuffer()).toString("base64")}`;
    } catch {}
  }
  const html = publicBackHtml({ card, collection, logo, manrope, fraunces });
  const file = path.join(outDir, `${card.slug}-back.png`);
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: file, omitBackground: false });
  for (const edition of card.editions) {
    for (const variant of edition.variants) {
      if (!variant.render_url) continue;
      rows.push({
        card: card.name,
        slug: card.slug,
        variantId: variant.id,
        material: variant.material_key,
        effect: variant.effect_key,
        source: file,
      });
    }
  }
}
await browser.close();
console.log(
  JSON.stringify(
    {
      mode: apply ? "APPLY" : "DRY RUN",
      cards: cards.length,
      variants: rows.length,
      output: outDir,
    },
    null,
    2,
  ),
);
if (!apply) {
  console.log(
    "\nDry run only. Re-run with --apply to publish designed backs through the authenticated endpoint.",
  );
  process.exit(0);
}
let done = 0;
let failed = 0;
for (const row of rows) {
  try {
    const output = path.join(tmpDir, `${row.variantId}-public-back.webp`);
    await composeCardBack({
      backPath: row.source,
      material: row.material === "diamond" ? "diamond" : row.material,
      effect: row.effect ?? "none",
      outputPath: output,
    });
    const form = new FormData();
    form.append(
      "back",
      new Blob([fs.readFileSync(output)], { type: "image/webp" }),
      `${row.variantId}-back.webp`,
    );
    await apiForm(`/api/v1/admin/variants/${row.variantId}/back`, form);
    fs.rmSync(output, { force: true });
    done += 1;
  } catch (error) {
    failed += 1;
    console.error(
      `failed ${row.card} ${row.variantId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
console.log(JSON.stringify({ applied: true, done, failed }, null, 2));
