#!/usr/bin/env node
/**
 * Rebuild card backs without touching fronts, draws or ownership.
 * The back source is the designed collection back; the finish treatment is
 * composed locally and uploaded through the authorised admin endpoint.
 */
import fs from "node:fs";
import path from "node:path";
import { composeCardBack } from "../../art/compose.mjs";
import { apiForm, apiJson, agentToken, accessHeaders } from "../lib/api.mjs";

const concurrency = Math.max(1, Number(process.env.BACK_CONCURRENCY ?? 4));
const tmpDir = path.join(process.cwd(), ".foilbury/tmp");
fs.mkdirSync(tmpDir, { recursive: true });
const cards = await apiJson("/api/v1/admin/cards?limit=2000");
const backBySlug = new Map();
const backByName = new Map();
const contentDir = path.join(process.cwd(), ".foilbury/content");
for (const file of fs.readdirSync(contentDir).filter((name) => name.endsWith(".json"))) {
  const manifest = JSON.parse(fs.readFileSync(path.join(contentDir, file), "utf8"));
  for (const card of manifest.cards) {
    const source = path.join(process.cwd(), ".foilbury/generated", manifest.collection.slug, `${card.slug}-back.png`);
    if (fs.existsSync(source)) {
      backBySlug.set(card.slug, source);
      backByName.set(card.name, source);
    }
  }
}
const variants = [];
for (const card of cards.items) {
  const source = backBySlug.get(card.slug) ?? backByName.get(card.name);
  if (!source) continue;
  for (const edition of card.editions) {
    for (const variant of edition.variants) {
      if (variant.status === "published") variants.push({ id: variant.id, material: variant.material_key, effect: variant.effect_key, source, card: card.name });
    }
  }
}

let done = 0;
let failed = 0;
const queue = [...variants];
async function worker(index) {
  while (queue.length) {
    const variant = queue.shift();
    if (!variant) break;
    try {
      const output = path.join(tmpDir, `${variant.id}-back-${index}.webp`);
      await composeCardBack({ backPath: variant.source, material: variant.material === "diamond" ? "diamond" : variant.material, effect: variant.effect ?? "none", outputPath: output });
      const form = new FormData();
      form.append("back", new Blob([fs.readFileSync(output)], { type: "image/webp" }), `${variant.id}-back.webp`);
      const response = await fetch(`${process.env.FOILBURY_URL ?? "http://localhost:5173"}/api/v1/admin/variants/${variant.id}/back`, {
        method: "POST",
        headers: { authorization: `Bearer ${agentToken()}`, ...accessHeaders(), "x-foilbury-csrf": "agent" },
        body: form,
      });
      if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
      fs.rmSync(output, { force: true });
      done += 1;
      if (done % 20 === 0) console.log(`[${index}] ${done}/${variants.length}`);
    } catch (error) {
      failed += 1;
      console.error(`[${index}] failed ${variant.card} ${variant.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
await Promise.all(Array.from({ length: concurrency }, (_, index) => worker(index + 1)));
console.log(JSON.stringify({ variants: variants.length, done, failed }, null, 2));
if (failed) process.exitCode = 1;
