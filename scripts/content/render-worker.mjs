#!/usr/bin/env node
/**
 * Parallel render worker. Claims one durable render job at a time, composes the
 * front and back locally, and uploads both to the managed render endpoint.
 * Run several workers; the claim is atomic and each job is completed once.
 */
import fs from "node:fs";
import path from "node:path";
import { composeCard, composeCardBack } from "../../art/compose.mjs";
import { apiForm, apiJson, BASE_URL, agentToken, accessHeaders } from "../lib/api.mjs";
import { withOwnedRenderTemp } from "./owned-render-temp.mjs";

const root = process.cwd();
const contentDir = path.join(root, ".foilbury/content");
const generatedDir = path.join(root, ".foilbury/generated");
const tmpDir = path.join(root, ".foilbury/tmp");
fs.mkdirSync(tmpDir, { recursive: true });
const worker = process.argv.find((arg) => arg.startsWith("--worker="))?.split("=")[1] ?? "1";
const jsonOut = process.argv.includes("--json");

function log(message) {
  if (!jsonOut) console.log(`[${worker}] ${message}`);
}

const cards = await apiJson("/api/v1/admin/cards?limit=2000");
const cardMeta = new Map(cards.items.map((card) => [card.id, card]));
const backBySlug = new Map();
const backByName = new Map();
if (fs.existsSync(contentDir)) {
  for (const file of fs.readdirSync(contentDir).filter((name) => name.endsWith(".json"))) {
    const manifest = JSON.parse(fs.readFileSync(path.join(contentDir, file), "utf8"));
    for (const card of manifest.cards) {
      const back = path.join(generatedDir, manifest.collection.slug, `${card.slug}-back.png`);
      if (fs.existsSync(back)) {
        backBySlug.set(card.slug, back);
        backByName.set(card.name, back);
      }
    }
  }
}

async function fetchBytes(url) {
  const response = await fetch(`${BASE_URL}${url}`, {
    headers: { authorization: `Bearer ${agentToken()}`, ...accessHeaders() },
  });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

let rendered = 0;
let failed = 0;
const started = Date.now();
while (true) {
  const jobs = await apiJson("/api/v1/admin/jobs?status=pending");
  const job = jobs.items?.[0];
  if (!job) break;
  const claimed = await apiJson(`/api/v1/admin/jobs/${job.id}/claim`, { method: "POST", body: {} });
  if (!claimed.job) continue;
  const payload = claimed.job.payload;
  const attempt = claimed.job.attempts;
  try {
    await withOwnedRenderTemp(tmpDir, async (jobDir) => {
      const subjectPath = path.join(jobDir, "subject.png");
      const backgroundPath = path.join(jobDir, "background.png");
      fs.writeFileSync(subjectPath, await fetchBytes(`/api/v1/admin/assets/${payload.subject_asset_id}/bytes`), { flag: "wx" });
      if (payload.background_asset_id) {
        fs.writeFileSync(backgroundPath, await fetchBytes(`/api/v1/admin/assets/${payload.background_asset_id}/bytes`), { flag: "wx" });
      }
      const outputPath = path.join(jobDir, "front.webp");
      const meta = cardMeta.get(payload.card_id);
      let markPath = "";
      const logoUrl = meta?.collections?.[0]?.logo_url;
      if (logoUrl) {
        try {
          const ext = logoUrl.endsWith(".svg") ? "svg" : "png";
          markPath = path.join(jobDir, `mark.${ext}`);
          fs.writeFileSync(markPath, await fetchBytes(logoUrl), { flag: "wx" });
        } catch {
          markPath = "";
        }
      }
      await composeCard({
        subjectPath,
        backgroundPath: payload.background_asset_id ? backgroundPath : null,
        material: payload.material_key,
        effect: payload.effect_key ?? "none",
        name: payload.card_name,
        subtitle: meta?.subtitle ?? "",
        setName: meta?.collections?.[0]?.name ?? "Cabinet",
        serial: meta?.collections?.[0]?.view_audience === "public" ? "PUBLIC SHOWCASE" : "MEMBER EDITION",
        className: meta?.class?.name ?? "",
        rarity: meta?.rarity?.name ?? "",
        markPath,
        outputPath,
      });
      const backSource = backBySlug.get(payload.card_slug) ?? backByName.get(payload.card_name);
      let backBytes;
      if (backSource) {
        const backPath = path.join(jobDir, "back.webp");
        await composeCardBack({ backPath: backSource, material: payload.material_key, effect: payload.effect_key ?? "none", outputPath: backPath });
        backBytes = fs.readFileSync(backPath);
      }
      const form = new FormData();
      form.append("file", new Blob([fs.readFileSync(outputPath)], { type: "image/webp" }), `${payload.variant_id}.webp`);
      if (backBytes) form.append("back", new Blob([backBytes], { type: "image/webp" }), `${payload.variant_id}-back.webp`);
      form.append("attempt", String(attempt));
      await apiForm(`/api/v1/admin/jobs/${job.id}/complete`, form);
      rendered += 1;
    });
    if (rendered % 10 === 0) log(`rendered ${rendered} (${((Date.now() - started) / 1000).toFixed(0)}s)`);
  } catch (error) {
    failed += 1;
    const message = error instanceof Error ? error.message : String(error);
    await apiJson(`/api/v1/admin/jobs/${job.id}/fail`, { method: "POST", body: { message, attempt } }).catch(() => undefined);
    log(`failed ${payload.variant_id}: ${message}`);
  }
}
const result = { worker, rendered, failed, elapsed_ms: Date.now() - started };
if (jsonOut) console.log(JSON.stringify(result));
else log(`done: ${rendered} rendered, ${failed} failed`);
