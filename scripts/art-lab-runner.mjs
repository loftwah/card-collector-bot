#!/usr/bin/env node
/**
 * Foilbury Art Lab runner.
 *
 * The browser queues a bounded job. This local worker claims one job at a time,
 * calls exactly the recorded provider/model, uploads the real bytes and records
 * what it observed. It never falls back to another provider and never tops up a
 * budget.
 *
 *   node scripts/art-lab-runner.mjs
 *   node scripts/art-lab-runner.mjs --job=artj_... --dry-run
 *   node scripts/art-lab-runner.mjs --limit=2
 *
 * Whole-card generation is a real method: the returned card is resized to the
 * 5:7 contract and uploaded as the candidate front. The composed methods invoke
 * the shared art/card-render.mjs renderer for comparison.
 */
import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { hasLivery } from "../art/card-render.mjs";
import { composeCard, composeCardBack } from "../art/compose.mjs";
import { accessHeaders, agentToken, apiForm, apiJson, BASE_URL, ensureServer } from "./lib/api.mjs";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const limit = Math.max(1, Number(limitArg?.split("=")[1] ?? 1) || 1);
const jobArg = process.argv.find((arg) => arg.startsWith("--job="));
const requestedJob = jobArg?.split("=")[1]?.trim() || undefined;
const presentations = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "src/data/collection-presentations.json"), "utf8"),
);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "foilbury-art-lab-"));
let generated = 0;
let failed = 0;

function log(message) {
  console.log(message);
}

async function binaryGet(route) {
  const response = await fetch(`${BASE_URL}${route}`, {
    headers: { authorization: `Bearer ${agentToken()}`, ...accessHeaders() },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status} ${route}: ${text.slice(0, 400)}`);
  }
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    mime: response.headers.get("content-type") ?? "image/png",
  };
}

function aspectFor(run) {
  if (run.brief.category !== "cards") {
    return ["banners", "og_images"].includes(run.brief.category) ? "16:9" : "1:1";
  }
  // FAL accepts 3:4; the result is normalised to the 5:7 card contract locally.
  return "3:4";
}

function providerKey(provider) {
  if (provider === "fal") return process.env.FAL_AI_API_KEY?.trim() ?? "";
  if (provider === "openai") return process.env.OPENAI_API_KEY?.trim() ?? "";
  return "";
}

async function callProvider(run, index) {
  const { provider, model } = run.job;
  const key = providerKey(provider);
  if (!key) {
    throw new Error(
      `Missing ${provider === "fal" ? "FAL_AI_API_KEY" : "OPENAI_API_KEY"}. No provider call was made.`,
    );
  }
  const seed = Math.floor(Date.now() / 1000) + index;
  if (provider === "fal") {
    const response = await fetch(`https://fal.run/${model}`, {
      method: "POST",
      headers: {
        authorization: `Key ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        prompt: run.job.prompt,
        num_images: 1,
        seed,
        output_format: "png",
        enable_safety_checker: true,
        aspect_ratio: aspectFor(run),
      }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`FAL ${model} failed (${response.status}): ${text.slice(0, 500)}`);
    }
    const payload = await response.json();
    const url = payload?.images?.[0]?.url ?? payload?.image?.url;
    if (!url) throw new Error(`FAL ${model} returned no image URL.`);
    const image = await fetch(url);
    if (!image.ok) throw new Error(`FAL output download failed (${image.status}).`);
    return {
      bytes: Buffer.from(await image.arrayBuffer()),
      seed: String(seed),
      provider: "fal",
      model,
    };
  }
  if (provider === "openai") {
    const response = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        prompt: run.job.prompt,
        n: 1,
        size: "1024x1536",
        output_format: "png",
      }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenAI ${model} failed (${response.status}): ${text.slice(0, 500)}`);
    }
    const payload = await response.json();
    const entry = payload?.data?.[0];
    if (entry?.b64_json) {
      return {
        bytes: Buffer.from(entry.b64_json, "base64"),
        seed: String(seed),
        provider: "openai",
        model,
      };
    }
    if (entry?.url) {
      const image = await fetch(entry.url);
      if (!image.ok) throw new Error(`OpenAI output download failed (${image.status}).`);
      return {
        bytes: Buffer.from(await image.arrayBuffer()),
        seed: String(seed),
        provider: "openai",
        model,
      };
    }
    throw new Error(`OpenAI ${model} returned no image data.`);
  }
  throw new Error(`No runner adapter exists for provider "${provider}".`);
}

async function cardSizes(raw) {
  const master = await sharp(raw)
    .resize(1500, 2100, { fit: "cover", position: "attention" })
    .png()
    .toBuffer();
  const front = await sharp(master).resize(750, 1050).webp({ quality: 92, effort: 5 }).toBuffer();
  const preview400 = await sharp(master).resize(400, 560).webp({ quality: 90 }).toBuffer();
  const thumb128 = await sharp(master).resize(128, 179).webp({ quality: 88 }).toBuffer();
  return { master, front, preview400, thumb128 };
}

function ensureRunData(run) {
  if (run.brief.category !== "cards") return;
  if (!run.card || !run.collection) {
    throw new Error("The card brief is missing its subject or collection.");
  }
  if (!run.variant) {
    throw new Error(
      "The card brief has no target variant. Pick a finish variant on the brief before generating.",
    );
  }
}

async function compose(run, rawScene) {
  ensureRunData(run);
  const presentation = presentations[run.collection.slug] ?? {};
  const subjectAssetId = run.source_assets?.subject_asset_id;
  const logoAssetId = run.source_assets?.logo_asset_id;
  if (!subjectAssetId) {
    throw new Error("The target edition has no subject asset to compose.");
  }
  const subject = await binaryGet(`/api/v1/admin/assets/${subjectAssetId}/bytes`);
  const subjectPath = path.join(tmpDir, `subject-${run.job.id}-${Date.now()}.png`);
  fs.writeFileSync(subjectPath, subject.bytes);
  const scenePath = path.join(tmpDir, `scene-${run.job.id}-${Date.now()}.png`);
  fs.writeFileSync(scenePath, rawScene);
  const mark = logoAssetId ? await binaryGet(`/api/v1/admin/assets/${logoAssetId}/bytes`) : null;
  const composition =
    run.edition?.composition_json &&
    (() => {
      try {
        return JSON.parse(run.edition.composition_json);
      } catch {
        return null;
      }
    })();
  const audience = run.brief.audience;
  const cardInput = {
    subjectPath,
    subjectOverride: true,
    backgroundPath: scenePath,
    backgroundOverride: true,
    material: run.variant.material_key,
    effect: run.variant.effect_key ?? "none",
    name: run.card.name,
    subtitle: run.card.subtitle ?? "",
    setName: presentation.cardSetName ?? run.collection.name ?? "Cabinet",
    serial: audience === "public" ? "PUBLIC SHOWCASE" : "MEMBER EDITION",
    className: run.card.class?.name ?? "",
    rarity: run.card.rarity?.name ?? "",
    composition,
    collectionTheme: presentation.theme ?? "",
    collectionSlug: run.collection.slug,
    cardSlug: run.card.slug,
    catalogueCode: run.catalogue_code ?? undefined,
    bio: run.card.bio_safe ?? run.card.description ?? "",
    edition: "Member archive · First printing",
    provenance:
      audience === "public"
        ? "PUBLIC SHOWCASE · ORIGINAL FOILBURY PROJECT"
        : "MEMBER ARCHIVE · THIRD-PARTY ART · NOT OFFICIAL",
    provenanceLong:
      "Provider-generated scene. Card composed by the shared Foilbury renderer. Not official or licensed third-party artwork.",
    markPlate: presentation.markPlate,
    markInvert: presentation.markInvert ?? false,
    markBuffer: mark?.bytes,
    markMime: mark?.mime,
    returnBytes: true,
  };
  const front = await composeCard(cardInput);
  // The v2 livery renderer has a designed back for its four proof collections.
  // Legacy collections keep their existing live back; the Art Lab publishes the
  // approved front and leaves that back in place rather than inventing one.
  const back = hasLivery(run.collection.slug) ? await composeCardBack(cardInput) : null;
  return {
    front: front.buffer ?? front,
    master: front.masterPng,
    back: back?.buffer ?? back ?? null,
  };
}

async function uploadCandidate(run, raw, extra, index) {
  const form = new FormData();
  form.append("raw", new Blob([raw], { type: "image/png" }), `raw-${index + 1}.png`);
  if (extra?.front) {
    form.append(
      "front",
      new Blob([extra.front], { type: "image/webp" }),
      `front-${index + 1}.webp`,
    );
  }
  if (extra?.back) {
    form.append("back", new Blob([extra.back], { type: "image/webp" }), `back-${index + 1}.webp`);
  }
  if (extra?.master) {
    form.append(
      "master",
      new Blob([extra.master], { type: "image/png" }),
      `master-${index + 1}.png`,
    );
  }
  if (extra?.preview400) {
    form.append(
      "preview400",
      new Blob([extra.preview400], { type: "image/webp" }),
      `preview-${index + 1}.webp`,
    );
  }
  if (extra?.thumb128) {
    form.append(
      "thumb128",
      new Blob([extra.thumb128], { type: "image/webp" }),
      `thumb-${index + 1}.webp`,
    );
  }
  form.append("seed", String(extra?.seed ?? ""));
  return apiForm(`/api/v1/admin/art/jobs/${run.job.id}/candidates`, form);
}

async function processJob(run, counters) {
  log(
    `Claimed ${run.job.id}: ${run.brief.title} · ${run.job.method} · ${run.job.count} candidate(s)`,
  );
  for (let index = 0; index < run.job.count; index += 1) {
    let attempted = false;
    try {
      const key = providerKey(run.job.provider);
      if (!key) {
        throw new Error(
          `Missing ${run.job.provider === "fal" ? "FAL_AI_API_KEY" : "OPENAI_API_KEY"}. No provider call was made.`,
        );
      }
      attempted = true;
      const result = await callProvider(run, index);
      counters.generated += 1;
      if (run.job.method === "whole_card") {
        const sizes = await cardSizes(result.bytes);
        await uploadCandidate(run, result.bytes, { ...sizes, seed: result.seed }, index);
      } else if (run.job.method === "raw_art") {
        await uploadCandidate(run, result.bytes, { seed: result.seed }, index);
      } else {
        const composed = await compose(run, result.bytes);
        const sizes = await cardSizes(composed.front);
        await uploadCandidate(
          run,
          result.bytes,
          {
            front: composed.front,
            back: composed.back,
            master: composed.master ?? sizes.master,
            preview400: sizes.preview400,
            thumb128: sizes.thumb128,
            seed: result.seed,
          },
          index,
        );
      }
      log(`  candidate ${index + 1} uploaded`);
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      const unit = run.price?.unit_cents ?? 0;
      const actual = unit * Math.max(counters.generated, attempted ? 1 : 0);
      await apiJson(`/api/v1/admin/art/jobs/${run.job.id}/fail`, {
        method: "POST",
        body: { message, actualCostCents: actual },
      }).catch(() => undefined);
      log(`  failed: ${message}`);
      return;
    }
  }
  const unit = run.price?.unit_cents ?? 0;
  await apiJson(`/api/v1/admin/art/jobs/${run.job.id}/complete`, {
    method: "POST",
    body: {
      actualCostCents: unit * counters.generated,
      costSource: "price_table",
      note: `${counters.generated} candidate(s) generated by scripts/art-lab-runner.mjs.`,
    },
  });
  log(
    `Completed ${run.job.id}: ${counters.generated} candidate(s), recorded US$${((unit * counters.generated) / 100).toFixed(2)}.`,
  );
}

async function main() {
  await ensureServer();
  if (dryRun) {
    const exportData = await apiJson("/api/v1/admin/art/agent?limit=20");
    const queued = [];
    for (const brief of exportData.briefs ?? []) {
      for (const job of brief.jobs ?? []) {
        if (job.status === "queued") queued.push({ brief, job });
      }
    }
    if (!queued.length) {
      log("No queued Art Lab jobs.");
      return;
    }
    for (const entry of queued.slice(0, limit)) {
      log(
        `\n${entry.brief.brief.title} · ${entry.job.method} · ${entry.job.provider}/${entry.job.model}`,
      );
      log(entry.job.prompt);
    }
    return;
  }
  for (let index = 0; index < limit; index += 1) {
    const claimed = await apiJson("/api/v1/admin/art/jobs/claim", {
      method: "POST",
      body: requestedJob && index === 0 ? { jobId: requestedJob } : {},
    });
    const run = claimed.job;
    if (!run) {
      log("No queued Art Lab jobs.");
      break;
    }
    const counters = { generated: 0 };
    await processJob(run, counters);
  }
}

try {
  await main();
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
