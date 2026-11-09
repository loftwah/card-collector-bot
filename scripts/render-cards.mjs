#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { composeCard } from "../art/compose.mjs";
import { requireQueuedBackground } from "./content/render-queued-front.mjs";
import { readRenderSource } from "./content/render-bytes.mjs";
import { apiForm, apiJson, ensureServer, BASE_URL, agentToken, accessHeaders } from "./lib/api.mjs";

const args = new Set(process.argv.slice(2));
const json = args.has("--json");
const queueOnly = args.has("--queue-only");
const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const limit = limitArg ? Math.max(1, Number(limitArg.split("=")[1])) : undefined;
const collectionArg = process.argv.find((arg) => arg.startsWith("--collection="));
const collectionSlug = collectionArg?.split("=")[1]?.trim() || "";
const presentations = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "src/data/collection-presentations.json"), "utf8"),
);

function log(message) {
  if (!json) console.log(message);
}

await ensureServer();
const queued = await apiJson("/api/v1/admin/renders/queue", {
  method: "POST",
  body: collectionSlug ? { collection: collectionSlug } : {},
});
log(`Render queue: ${queued.queued} new job${queued.queued === 1 ? "" : "s"}.`);
if (queueOnly) {
  if (json) console.log(JSON.stringify(queued, null, 2));
  process.exit(0);
}

const cards = await apiJson("/api/v1/admin/cards?limit=200");
const index = new Map();
for (const card of cards.items) {
  for (const edition of card.editions) {
    for (const variant of edition.variants) {
      index.set(variant.id, { card, edition, variant });
    }
  }
}

let rendered = 0;
let failed = 0;
const started = Date.now();
while (true) {
  if (limit && rendered + failed >= limit) break;
  const jobs = await apiJson("/api/v1/admin/jobs?status=pending");
  const job = jobs.items?.[0];
  if (!job) break;
  const claimed = await apiJson(`/api/v1/admin/jobs/${job.id}/claim`, { method: "POST", body: {} });
  if (!claimed.job) break;
  const payload = claimed.job.payload;
  const attempt = claimed.job.attempts;
  const entry = index.get(payload.variant_id);
  if (!entry) {
    await apiJson(`/api/v1/admin/jobs/${job.id}/fail`, {
      method: "POST",
      body: { message: "Variant is no longer in the catalogue.", attempt },
    });
    failed++;
    continue;
  }
  try {
    requireQueuedBackground(payload);
    const subject = await fetch(
      `${BASE_URL}/api/v1/admin/assets/${payload.subject_asset_id}/bytes`,
      {
        headers: { authorization: `Bearer ${agentToken()}`, ...accessHeaders() },
      },
    );
    if (!subject.ok) throw new Error(`Subject asset fetch failed (${subject.status}).`);
    const background = payload.background_asset_id
      ? await fetch(`${BASE_URL}/api/v1/admin/assets/${payload.background_asset_id}/bytes`, {
          headers: { authorization: `Bearer ${agentToken()}`, ...accessHeaders() },
        })
      : null;
    if (background && !background.ok)
      throw new Error(`Background asset fetch failed (${background.status}).`);
    const subjectPath = await readRenderSource(subject);
    const backgroundPath = await readRenderSource(background);
    let markBuffer;
    let markMime;
    const logoUrl = entry.card.collections?.[0]?.logo_url;
    if (logoUrl) {
      const assetId = logoUrl.match(/^\/media\/asset\/([A-Za-z0-9_-]+)$/)?.[1];
      const logoRoute = assetId ? `/api/v1/admin/assets/${assetId}/bytes` : logoUrl;
      const logo = await fetch(`${BASE_URL}${logoRoute}`, {
        headers: { authorization: `Bearer ${agentToken()}`, ...accessHeaders() },
      });
      const contentType = logo.headers.get("content-type") ?? "";
      if (logo.ok && contentType.startsWith("image/")) {
        markBuffer = await readRenderSource(logo);
        markMime =
          contentType.includes("svg") || logoUrl.endsWith(".svg") ? "image/svg+xml" : "image/png";
      }
    }
    // A multi-print edition is named "Subject — Print title". The face keeps
    // the subject name and uses the print title as its subtitle, so two prints
    // of the same subject are distinguishable without renaming the subject.
    const rawPrintTitle = entry.edition?.name?.includes(" — ")
      ? entry.edition.name.split(" — ").slice(1).join(" — ")
      : "";
    const printTitle = /^source edition$/i.test(rawPrintTitle.trim()) ? "" : rawPrintTitle;
    const storedComposition = payload.composition_json
      ? JSON.parse(payload.composition_json)
      : null;
    // A multi-print edition is a full-art object; only the square table-night
    // portraits use the coaster mount.
    const composition = printTitle
      ? { ...(storedComposition ?? {}), mode: "contain" }
      : storedComposition;
    const collectionSlugForCard = entry.card.collections?.[0]?.slug ?? "";
    const collectionTheme = presentations[collectionSlugForCard]?.theme ?? "";
    const { buffer: renderBytes } = await composeCard({
      subjectPath,
      backgroundPath,
      material: payload.material_key,
      effect: payload.effect_key ?? "none",
      name: entry.card.name,
      subtitle: printTitle || (entry.card.subtitle ?? ""),
      setName: entry.card.collections?.[0]?.name ?? entry.card.sets[0]?.name ?? "Cabinet",
      serial:
        entry.card.collections?.[0]?.view_audience === "public"
          ? "PUBLIC SHOWCASE"
          : "MEMBER EDITION",
      className: printTitle ? "Print" : (entry.card.class?.name ?? ""),
      rarity: entry.card.rarity?.name ?? "",
      composition,
      collectionTheme,
      markInvert: collectionTheme === "trial",
      markBuffer,
      markMime,
      returnBytes: true,
    });
    const form = new FormData();
    form.append(
      "file",
      new Blob([renderBytes], { type: "image/webp" }),
      `${payload.variant_id}.webp`,
    );
    form.append("attempt", String(attempt));
    const completed = await apiForm(`/api/v1/admin/jobs/${job.id}/complete`, form);
    /* Album grids should not download full 750x1050 renders. Derivatives are
       generated from the published bytes, never from the private source art. */
    if (completed?.assetId) await uploadDerivatives(completed.assetId, renderBytes);
    if (completed?.back?.assetId) await uploadDerivatives(completed.back.assetId, renderBytes);
    rendered++;
    log(`  rendered ${entry.card.name} — ${entry.variant.name}`);
  } catch (error) {
    failed++;
    const message = error instanceof Error ? error.message : String(error);
    await apiJson(`/api/v1/admin/jobs/${job.id}/fail`, {
      method: "POST",
      body: { message, attempt },
    }).catch(() => undefined);
    log(`  failed ${entry.card.name} — ${entry.variant.name}: ${message}`);
  }
}

async function uploadDerivatives(assetId, sourcePath) {
  for (const [sizeKey, width, height] of [
    ["thumb", 300, 420],
    ["preview", 600, 840],
  ]) {
    const bytes = await sharp(sourcePath)
      .resize(width, height, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82, effort: 5 })
      .toBuffer();
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: "image/webp" }), `${assetId}-${sizeKey}.webp`);
    form.append("sizeKey", sizeKey);
    await apiForm(`/api/v1/admin/assets/${assetId}/derivatives`, form);
  }
}

const outbox = await apiJson("/api/v1/admin/outbox/process", { method: "POST", body: {} }).catch(
  () => ({ delivered: 0, suppressed: 0 }),
);
const result = {
  queued: queued.queued,
  rendered,
  failed,
  outbox,
  elapsed_ms: Date.now() - started,
};
if (json) console.log(JSON.stringify(result, null, 2));
else
  console.log(
    `Rendered ${rendered}; failed ${failed}; elapsed ${(result.elapsed_ms / 1000).toFixed(1)}s.`,
  );
if (failed > 0) process.exitCode = 1;
