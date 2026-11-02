#!/usr/bin/env node
/**
 * Build contact sheets: one representative card per collection, with all four
 * finishes on both sides. Output stays in .foilbury/evidence (gitignored).
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { apiJson, ensureServer, BASE_URL, agentToken, accessHeaders } from "../lib/api.mjs";

const outDir = path.join(".foilbury", "evidence", "contact-sheets");
fs.mkdirSync(outDir, { recursive: true });
await ensureServer();
const [collections, cards] = await Promise.all([
  apiJson("/api/v1/admin/collections"),
  apiJson("/api/v1/admin/cards?limit=2000"),
]);
const targetSlugs = new Set(collections.items.map((collection) => collection.slug));
const byCollection = new Map();
for (const card of cards.items) {
  for (const collection of card.collections) {
    if (!targetSlugs.has(collection.slug)) continue;
    if (!byCollection.has(collection.slug)) byCollection.set(collection.slug, []);
    byCollection.get(collection.slug).push(card);
  }
}

async function bytes(url) {
  const response = await fetch(`${BASE_URL}${url}`, { headers: { authorization: `Bearer ${agentToken()}`, ...accessHeaders() } });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

const finishOrder = ["plain", "silver", "gold", "holographic"];
for (const collection of collections.items) {
  const cardsInCollection = byCollection.get(collection.slug) ?? [];
  const candidate = cardsInCollection.find((card) => {
    const variants = card.editions.flatMap((edition) => edition.variants);
    const has = (material, effect) => variants.some((variant) => {
      const effectMatches = effect ? variant.effect_key === effect : (!variant.effect_key || variant.effect_key === "none");
      return variant.material_key === material && effectMatches && variant.render_url;
    });
    return has("plain") && has("silver") && has("gold") && has("gold", "holographic");
  });
  if (!candidate) {
    console.log(`skip ${collection.slug}: no four-finish card`);
    continue;
  }
  const variants = candidate.editions.flatMap((edition) => edition.variants);
  const chosen = [
    variants.find((variant) => variant.material_key === "plain" && (!variant.effect_key || variant.effect_key === "none")),
    variants.find((variant) => variant.material_key === "silver" && (!variant.effect_key || variant.effect_key === "none")),
    variants.find((variant) => variant.material_key === "gold" && (!variant.effect_key || variant.effect_key === "none")),
    variants.find((variant) => variant.material_key === "gold" && variant.effect_key === "holographic") ?? variants.find((variant) => variant.material_key === "diamond"),
  ].filter(Boolean);
  if (chosen.length !== 4) continue;
  const width = 300;
  const height = 420;
  const gap = 14;
  const margin = 40;
  const header = 118;
  const sheetWidth = margin * 2 + width * 4 + gap * 3;
  const sheetHeight = header + margin + height * 2 + gap + 54;
  const composites = [];
  for (let row = 0; row < 2; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      const variant = chosen[column];
      const url = row === 0 ? variant.render_url : variant.back_render_url;
      if (!url) continue;
      const image = await bytes(url);
      composites.push({
        input: await sharp(image).resize(width, height, { fit: "cover" }).png().toBuffer(),
        left: margin + column * (width + gap),
        top: header + row * (height + gap),
      });
    }
  }
  const labels = ["BASE / PLAIN", "SILVER", "GOLD", "HOLOGRAPHIC"];
  const labelSvg = labels.map((label, index) => `<text x="${margin + index * (width + gap) + width / 2}" y="${header - 18}" text-anchor="middle" font-family="Manrope, sans-serif" font-size="16" letter-spacing="2" fill="#f4f0e6">${label}</text>`).join("");
  const overlay = Buffer.from(`<svg width="${sheetWidth}" height="${sheetHeight}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${sheetWidth}" height="${sheetHeight}" fill="#141512"/>
    <text x="${margin}" y="42" font-family="Georgia, serif" font-size="30" fill="#f4f0e6">${collection.name.replaceAll("&", "&amp;")}</text>
    <text x="${margin}" y="68" font-family="monospace" font-size="12" letter-spacing="3" fill="#c69a58">${candidate.name.toUpperCase()} · FRONT / BACK</text>
    ${labelSvg}
    <text x="${margin}" y="${sheetHeight - 18}" font-family="monospace" font-size="11" letter-spacing="2" fill="#9a9385">FOILBURY CONTACT SHEET · ORIGINAL INTERPRETATION · 750×1050 OUTPUT</text>
    <text x="${sheetWidth - margin}" y="${sheetHeight - 18}" text-anchor="end" font-family="monospace" font-size="11" letter-spacing="2" fill="#9a9385">${new Date().toISOString().slice(0, 10)}</text>
  </svg>`);
  const output = path.join(outDir, `${collection.slug}.jpg`);
  await sharp({ create: { width: sheetWidth, height: sheetHeight, channels: 3, background: "#141512" } })
    .composite([{ input: overlay, left: 0, top: 0 }, ...composites])
    .jpeg({ quality: 88 })
    .toFile(output);
  console.log(`wrote ${output}`);
}
