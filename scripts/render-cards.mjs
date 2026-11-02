#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { composeCard } from "../art/compose.mjs";
import { apiForm, apiJson, ensureServer, BASE_URL, agentToken } from "./lib/api.mjs";

const args = new Set(process.argv.slice(2));
const json = args.has("--json");
const queueOnly = args.has("--queue-only");
const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const limit = limitArg ? Math.max(1, Number(limitArg.split("=")[1])) : undefined;
const tmpDir = path.join(process.cwd(), ".foilbury/tmp");
fs.mkdirSync(tmpDir, { recursive: true });

function log(message) {
  if (!json) console.log(message);
}

await ensureServer();
const queued = await apiJson("/api/v1/admin/renders/queue", { method: "POST", body: {} });
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
  const entry = index.get(payload.variant_id);
  if (!entry) {
    await apiJson(`/api/v1/admin/jobs/${job.id}/fail`, {
      method: "POST",
      body: { message: "Variant is no longer in the catalogue." },
    });
    failed++;
    continue;
  }
  try {
    const subject = await fetch(`${BASE_URL}/api/v1/admin/assets/${payload.subject_asset_id}/bytes`, {
      headers: { authorization: `Bearer ${agentToken()}` },
    });
    if (!subject.ok) throw new Error(`Subject asset fetch failed (${subject.status}).`);
    const background = payload.background_asset_id
      ? await fetch(`${BASE_URL}/api/v1/admin/assets/${payload.background_asset_id}/bytes`, {
          headers: { authorization: `Bearer ${agentToken()}` },
        })
      : null;
    if (background && !background.ok) throw new Error(`Background asset fetch failed (${background.status}).`);
    const subjectPath = path.join(tmpDir, `${payload.variant_id}-subject.png`);
    const backgroundPath = path.join(tmpDir, `${payload.variant_id}-background.png`);
    fs.writeFileSync(subjectPath, Buffer.from(await subject.arrayBuffer()));
    if (background) fs.writeFileSync(backgroundPath, Buffer.from(await background.arrayBuffer()));
    const outputPath = path.join(tmpDir, `${payload.variant_id}.webp`);
    await composeCard({
      subjectPath,
      backgroundPath,
      material: payload.material_key,
      effect: payload.effect_key ?? "none",
      name: entry.card.name,
      subtitle: entry.card.subtitle ?? "",
      setName: entry.card.sets[0]?.name ?? entry.card.category?.name ?? "Cabinet",
      serial: "CABINET PROOF",
      className: entry.card.class?.name ?? "",
      rarity: entry.card.rarity?.name ?? "",
      outputPath,
    });
    const renderBytes = fs.readFileSync(outputPath);
    const form = new FormData();
    form.append("file", new Blob([renderBytes], { type: "image/webp" }), `${payload.variant_id}.webp`);
    await apiForm(`/api/v1/admin/jobs/${job.id}/complete`, form);
    rendered++;
    log(`  rendered ${entry.card.name} — ${entry.variant.name}`);
    fs.rmSync(subjectPath, { force: true });
    fs.rmSync(backgroundPath, { force: true });
    fs.rmSync(outputPath, { force: true });
  } catch (error) {
    failed++;
    const message = error instanceof Error ? error.message : String(error);
    await apiJson(`/api/v1/admin/jobs/${job.id}/fail`, { method: "POST", body: { message } }).catch(() => undefined);
    log(`  failed ${entry.card.name} — ${entry.variant.name}: ${message}`);
  }
}

const outbox = await apiJson("/api/v1/admin/outbox/process", { method: "POST", body: {} }).catch(() => ({ delivered: 0, suppressed: 0 }));
const result = { queued: queued.queued, rendered, failed, outbox, elapsed_ms: Date.now() - started };
if (json) console.log(JSON.stringify(result, null, 2));
else console.log(`Rendered ${rendered}; failed ${failed}; elapsed ${(result.elapsed_ms / 1000).toFixed(1)}s.`);
if (failed > 0) process.exitCode = 1;
