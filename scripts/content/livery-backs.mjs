#!/usr/bin/env node
/**
 * Publish the card-language designed backs for the proof collections.
 * Fronts are queued and rendered by scripts/render-cards.mjs; this only writes
 * the reverse so an existing front is not re-rolled.
 *
 *   node scripts/content/livery-backs.mjs --collection=doki-doki-literature-club
 *   node scripts/content/livery-backs.mjs --apply
 */
import fs from "node:fs";
import path from "node:path";
import { composeCardBack } from "../../art/compose.mjs";
import { hasLivery } from "../../art/card-render.mjs";
import {
  apiForm,
  apiJson,
  agentToken,
  accessHeaders,
  ensureServer,
  BASE_URL,
} from "../lib/api.mjs";

const apply = process.argv.includes("--apply");
const collectionArg = process.argv.find((arg) => arg.startsWith("--collection="));
const only = collectionArg?.split("=")[1]?.trim() || "";

await ensureServer();
const cards = await apiJson("/api/v1/admin/cards?limit=2000");
const presentations = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "src/data/collection-presentations.json"), "utf8"),
);

const counts = new Map();
const codes = new Map();
for (const card of cards.items) {
  const slug = card.collections?.[0]?.slug ?? "";
  const prefix = slug
    .split("-")
    .map((part) => part[0])
    .join("")
    .toUpperCase();
  const count = (counts.get(slug) ?? 0) + 1;
  counts.set(slug, count);
  codes.set(card.id, `FB-${prefix}-${String(count).padStart(3, "0")}`);
}

const logoCache = new Map();
async function logoBytes(card) {
  const logoUrl = card.collections?.[0]?.logo_url;
  if (!logoUrl) return null;
  if (logoCache.has(logoUrl)) return logoCache.get(logoUrl);
  const assetId = logoUrl.match(/^\/media\/asset\/([A-Za-z0-9_-]+)$/)?.[1];
  const route = assetId ? `/api/v1/admin/assets/${assetId}/bytes` : logoUrl;
  const response = await fetch(`${BASE_URL}${route}`, {
    headers: { authorization: `Bearer ${agentToken()}`, ...accessHeaders() },
  });
  const result = response.ok
    ? {
        buffer: Buffer.from(await response.arrayBuffer()),
        mime: (response.headers.get("content-type") ?? "image/png").includes("svg")
          ? "image/svg+xml"
          : "image/png",
      }
    : null;
  logoCache.set(logoUrl, result);
  return result;
}

let done = 0;
let failed = 0;
const rows = [];
for (const card of cards.items) {
  const collectionSlug = card.collections?.[0]?.slug ?? "";
  if (!hasLivery(collectionSlug)) continue;
  if (only && collectionSlug !== only) continue;
  const logo = await logoBytes(card);
  for (const edition of card.editions) {
    for (const variant of edition.variants) {
      if (variant.status !== "published") continue;
      rows.push({ card, edition, variant, logo, collectionSlug });
    }
  }
}

for (const row of rows) {
  const { card, edition, variant, logo, collectionSlug } = row;
  try {
    const result = await composeCardBack({
      collectionSlug,
      collectionTheme: presentations[collectionSlug]?.theme ?? "",
      material: variant.material_key,
      effect: variant.effect_key ?? "none",
      name: card.name,
      subtitle: card.subtitle ?? "",
      rarity: card.rarity?.name ?? "",
      catalogueCode: codes.get(card.id),
      bio: card.bio_safe ?? card.description ?? "",
      edition: "Member archive · First printing",
      provenance: "MEMBER ARCHIVE · THIRD-PARTY ART · NOT OFFICIAL",
      provenanceLong:
        "Third-party character art, sourced and credited. Private, non-commercial member album; not official or licensed.",
      markBuffer: logo?.buffer,
      markMime: logo?.mime,
      returnBytes: true,
    });
    if (!apply) {
      console.log(`[dry] ${card.name} ${variant.material_key}`);
      done += 1;
      continue;
    }
    const form = new FormData();
    form.append(
      "back",
      new Blob([result.buffer], { type: "image/webp" }),
      `${variant.id}-back.webp`,
    );
    await apiForm(`/api/v1/admin/variants/${variant.id}/back`, form);
    done += 1;
    console.log(`[${done}/${rows.length}] ${card.name} ${variant.material_key}`);
  } catch (error) {
    failed += 1;
    console.error(
      `failed ${card.name} ${variant.id}: ${error instanceof Error ? error.message : error}`,
    );
  }
}

console.log(
  JSON.stringify({ mode: apply ? "apply" : "dry", variants: rows.length, done, failed }, null, 2),
);
if (failed) process.exitCode = 1;
