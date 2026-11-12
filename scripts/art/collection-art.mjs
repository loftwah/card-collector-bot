#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";

const [mode, file, ...extra] = process.argv.slice(2);
if (!["plan", "proof", "stage"].includes(mode) || !file || extra.length)
  throw Error("Usage: pnpm art:collection <plan|proof|stage> <collection-art.json>");

const text = z.string().trim().min(1);
const id = z.string().regex(/^[a-z][a-z0-9]*_[a-z0-9_]+$/);
const key = z.string().max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const schema = z.object({
  collection: z.object({ name: text, id: id.optional(), mark: text, direction: text, anchor: text.optional() }).strict(),
  cards: z.array(z.object({
    key, name: text, role: text, rarity: text, finish: text.default("Plain"), description: text,
    credit: text, scene: text, motif: text, source: text, front: text, back: text,
    cardId: id.optional(), variantId: id.optional(),
  }).strict()).min(1).max(60),
}).strict();
const manifest = path.resolve(file);
const directory = path.dirname(manifest);
const output = path.join(directory, path.basename(file, path.extname(file)) + "-proof");
const { collection, cards } = schema.parse(JSON.parse(await fs.readFile(manifest, "utf8")));
assert.equal(new Set(cards.map((card) => card.key)).size, cards.length, "Duplicate card/finish key");

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const image = async (filename) => {
  const absolute = path.resolve(directory, filename);
  const bytes = await fs.readFile(absolute);
  const info = await sharp(bytes).metadata();
  assert(["png", "webp", "jpeg"].includes(info.format) && (info.orientation ?? 1) === 1 && (info.pages ?? 1) === 1,
    filename + " must be a single upright PNG, WebP or JPEG");
  return { file: absolute, bytes, sha256: digest(bytes), width: info.width, height: info.height, format: info.format };
};
const reference = ({ file, sha256, width, height }) => ({ file, sha256, width, height });
const mark = await image(collection.mark);
const anchor = collection.anchor ? await image(collection.anchor) : null;
const jobs = await Promise.all(cards.map(async (card) => {
  const subject = await image(card.source);
  const front = path.resolve(directory, card.front);
  const back = path.resolve(directory, card.back);
  assert.notEqual(front, back, card.key + " needs distinct front and back paths");
  const common = "Generate one face-on, edge-to-edge 5:7 collectible card image. Keep names, rarity and finish legible at 214 pixels. Use only the exact supplied copy and the real supplied mark. No invented text, serials or official claims.";
  const copy = [card.name, card.role, collection.name, card.rarity, card.finish, "Foilbury · Unofficial"];
  const references = [subject, mark, ...(anchor ? [anchor] : [])].map(reference);
  return { card, front, back, references,
    frontPrompt: `${common} Reference 1 is the subject; retain likeness, clothing and recognisable features. Reference 2 is the collection mark.${anchor ? " Reference 3 sets the card's frame, materials and type hierarchy." : ""} Collection direction: ${collection.direction}. Subject scene: ${card.scene}. Exact copy: ${JSON.stringify(copy)}.`,
    backPrompt: `${common} Reference 1 is the selected front; retain its frame, materials and type hierarchy. Reference 2 is the collection mark. Reverse motif: ${card.motif}. Exact copy: ${JSON.stringify([...copy, card.description, card.credit])}.`,
  };
}));
assert.equal(new Set(jobs.flatMap((job) => [job.front, job.back])).size, jobs.length * 2,
  "Each selected face needs its own path");

if (mode === "plan") {
  console.log(JSON.stringify(jobs.map(({ card, front, back, references, frontPrompt, backPrompt }) => ({
    key: card.key,
    front: { output: front, references, prompt: frontPrompt },
    back: { output: back, references: [{ file: front }, reference(mark)], prompt: backPrompt },
  })), null, 2));
} else {
  // Read and validate the full selection before writing any proofs or Studio jobs.
  for (const job of jobs) {
    const pair = await Promise.all([image(job.front), image(job.back)]);
    assert(pair.every(({ width, height }) => width >= 750 && width * 7 === height * 5),
      job.card.key + " requires two exact 5:7 faces at least 750 pixels wide");
    assert.notEqual(pair[0].sha256, pair[1].sha256, job.card.key + " has identical faces");
    job.pair = pair;
  }
  if (mode === "proof") {
    await fs.mkdir(output, { recursive: true, mode: 0o700 });
    for (const job of jobs) {
      await Promise.all(job.pair.flatMap((face, i) => [400, 214, 128].map((width) =>
        render(face, width).toFile(path.join(output, `${job.card.key}-${i ? "back" : "front"}-${width}.webp`)))));
    }
    console.log(JSON.stringify({ directory: output, pairs: jobs.map(({ card, pair }) => ({
      key: card.key, front: reference(pair[0]), back: reference(pair[1]),
    })) }, null, 2));
  } else {
    assert(collection.id && cards.every((card) => card.cardId && card.variantId),
      "Stage requires the existing Studio collection, card and target variant IDs");
    assert.equal(new Set(cards.map((card) => card.variantId)).size, cards.length, "Duplicate Studio target variant");
    const { apiFetch, BASE_URL } = await import("../lib/api.mjs");
    const target = new URL(BASE_URL);
    const api = (route, options) => apiFetch("/api/v1/studio/art" + route, {
      ...options, startLocal: target.hostname === "localhost" || target.hostname === "127.0.0.1",
    });
    await fs.mkdir(output, { recursive: true, mode: 0o700 });
    const lock = path.join(output, "stage.lock");
    const handle = await fs.open(lock, "wx", 0o600);
    try {
      const { briefs } = await api("?category=cards&limit=200");
      for (const job of jobs) await stage(api, briefs, job, target.origin);
    } finally {
      await handle.close();
      await fs.unlink(lock);
    }
  }
}

function render(face, width) {
  return sharp(face.bytes).resize(width).webp({ quality: 92 });
}

async function stage(api, briefs, job, origin) {
  const { card, pair, references, frontPrompt, backPrompt } = job;
  const [front, back] = pair;
  const signature = digest(JSON.stringify([
    collection.id, card.cardId, card.variantId, front.sha256, back.sha256,
    frontPrompt, backPrompt, references.map((ref) => ref.sha256),
  ]));
  const title = `Codex · ${card.name.slice(0, 90)} · ${card.finish.slice(0, 30)} · ${signature.slice(0, 16)}`;
  const receipt = path.join(output, "stage-" + digest(origin + signature) + ".json");
  const saved = await fs.readFile(receipt, "utf8").then(JSON.parse).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  const matches = briefs.filter((brief) => brief.title === title);
  assert(matches.length <= 1, "Multiple Studio briefs match " + card.key);
  const briefId = saved?.briefId ?? matches[0]?.id ?? (await api("/briefs", { body: {
    category: "cards", collectionId: collection.id, cardId: card.cardId, targetVariantId: card.variantId,
    title, intent: "Review a complete front and back prepared locally with Codex ImageGen.",
    audience: "members", candidateCount: 2, provider: "openai", model: "gpt-image-2.6-sunburst",
    methods: ["whole_card"], styleKeys: ["atelier"], outputSizes: ["750x1050", "400x560", "128x179"],
  } })).brief.brief.id;
  if (!saved) {
    const temporary = receipt + ".next";
    await fs.writeFile(temporary, JSON.stringify({ briefId }) + "\n", { mode: 0o600 });
    await fs.rename(temporary, receipt);
  }
  const route = "/briefs/" + briefId;
  let detail = await api(route);
  assert(detail.brief.title === title && detail.brief.collection_id === collection.id && detail.brief.card_id === card.cardId &&
    detail.brief.target_variant_id === card.variantId && detail.brief.audience === "members",
  "Studio brief scope differs for " + card.key);
  assert(detail.collection?.name === collection.name && detail.collection.view_audience === "members" &&
    detail.card?.name === card.name, "Studio member collection or card differs for " + card.key);
  assert.equal(detail.target_variant?.finish_label.toLowerCase(), card.finish.toLowerCase(),
    "Studio target finish differs for " + card.key);
  const jobRow = detail.jobs[0] ?? (await api(route + "/import", { method: "POST" })).jobs[0];
  assert(jobRow && detail.jobs.length <= 1, "Reconcile Studio jobs for " + card.key);
  assert(["running", "succeeded"].includes(jobRow.status), "Reconcile Studio job for " + card.key);
  assert(jobRow.status === "succeeded" || jobRow.cost_estimate_cents === 0,
    "Reconcile the paid generation job for " + card.key);
  const jobPath = "/jobs/" + jobRow.id;
  const existing = detail.candidates.filter((candidate) => candidate.job_id === jobRow.id);
  assert(existing.length <= 1, "Multiple Studio candidates match " + card.key);
  let candidate = existing[0];
  const displayFront = await render(front, 750).toBuffer();
  if (candidate) {
    assert.equal(candidate.sha256, digest(displayFront), "Studio display front differs for " + card.key);
    const lineage = candidate.metadata?.layers?.find((layer) => layer.role === "whole_card_back");
    assert.equal(lineage?.sha256, back.sha256, "Studio back provenance differs for " + card.key);
    assert.equal(candidate.metadata?.back_asset_id, candidate.render_back_asset_id,
      "Studio back was replaced after staging " + card.key);
  }
  else {
    const form = new FormData();
    const provenance = { provider: "OpenAI", model: "Native Codex ImageGen",
      resolved_model: null, seed: null, cost: null, audience: "members", official: false, credit: card.credit };
    const metadata = ({ sha256, width, height }) => ({ ...provenance, sha256, width, height });
    const refHashes = references.map(({ sha256 }) => ({ sha256 }));
    form.set("label", "Codex ImageGen · " + signature.slice(0, 16));
    form.set("prompt", frontPrompt);
    form.set("layers", JSON.stringify([
      { role: "whole_card_front", ...metadata(front), prompt: frontPrompt, references: refHashes },
      { role: "whole_card_back", ...metadata(back), prompt: backPrompt, references: [{ sha256: front.sha256 }, refHashes[1]] },
    ]));
    const add = (field, bytes, format) => form.set(field, new File([bytes], field + "." + format, { type: "image/" + format }));
    add("raw", front.bytes, front.format);
    add("front", displayFront, "webp");
    for (const [field, face, width] of [["back", back, 750], ["preview400", front, 400], ["thumb128", front, 128]]) {
      add(field, await render(face, width).toBuffer(), "webp");
    }
    ({ candidate } = await api(jobPath + "/candidates", { form }));
  }
  assert(candidate.render_asset_id && candidate.render_back_asset_id, "Studio did not save both faces");
  if (jobRow.status !== "succeeded") await api(jobPath + "/complete", { body: {
    actualCostCents: 0, costSource: "runner_recorded", note: "Imported existing Codex ImageGen output. No provider request.",
  } });
  detail = await api(route);
  assert(detail.jobs.some((row) => row.id === jobRow.id && row.status === "succeeded"));
  console.log(JSON.stringify({ key: card.key, briefId, candidateId: candidate.id, status: candidate.status }));
}
