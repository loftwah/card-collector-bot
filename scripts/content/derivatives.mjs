#!/usr/bin/env node
/**
 * Generate and upload responsive derivatives for published renders.
 * Safe to rerun: the server deduplicates by source + size + checksum.
 */
import sharp from "sharp";
import { apiForm, apiJson, BASE_URL, agentToken, accessHeaders } from "../lib/api.mjs";

const concurrency = Math.max(1, Number(process.env.DERIVATIVE_CONCURRENCY ?? 4));
const started = Date.now();
const cards = await apiJson("/api/v1/admin/cards?limit=2000");
const variants = [];
for (const card of cards.items) {
  for (const edition of card.editions) {
    for (const variant of edition.variants) {
      if (variant.status === "published" && variant.render_url) {
        variants.push({ id: variant.id, card: card.name, url: variant.render_url });
      }
    }
  }
}

async function fetchBytes(url) {
  const response = await fetch(`${BASE_URL}${url}`, { headers: { authorization: `Bearer ${agentToken()}`, ...accessHeaders() } });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function make(variant) {
  const assetId = variant.url.split("/").pop();
  const source = await fetchBytes(variant.url);
  for (const [sizeKey, width, height, quality] of [["thumb", 300, 420, 82], ["preview", 600, 840, 84]]) {
    const bytes = await sharp(source).resize(width, height, { fit: "cover", position: "attention" }).webp({ quality, effort: 5 }).toBuffer();
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: "image/webp" }), `${variant.id}-${sizeKey}.webp`);
    form.append("sizeKey", sizeKey);
    await apiForm(`/api/v1/admin/assets/${assetId}/derivatives`, form);
  }
  return variant;
}

let done = 0;
let failed = 0;
const queue = [...variants];
async function worker(index) {
  while (queue.length) {
    const variant = queue.shift();
    if (!variant) break;
    try {
      await make(variant);
      done += 1;
      if (done % 25 === 0) console.log(`[${index}] ${done}/${variants.length} (${((Date.now() - started) / 1000).toFixed(0)}s)`);
    } catch (error) {
      failed += 1;
      console.error(`[${index}] failed ${variant.card} ${variant.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, (_, index) => worker(index + 1)));
console.log(JSON.stringify({ variants: variants.length, done, failed, elapsed_ms: Date.now() - started }, null, 2));
if (failed) process.exitCode = 1;
