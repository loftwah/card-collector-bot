#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { renderBack, renderFront } from "../../art/card-render.mjs";

const manifestArg = process.argv[2];
if (!manifestArg || process.argv.length !== 3) {
  throw new Error("Usage: node scripts/art/render-print.mjs <private-print-manifest.json>");
}

const manifestPath = path.resolve(manifestArg);
const directory = path.dirname(manifestPath);
const { slug, finishes, ...card } = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const supported = ["plain", "silver", "gold", "holographic"];
if (
  typeof slug !== "string" ||
  !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ||
  !Array.isArray(finishes) ||
  finishes.length === 0 ||
  new Set(finishes).size !== finishes.length ||
  finishes.some((finish) => !supported.includes(finish))
) {
  throw new Error("Provide a kebab-case slug and a unique list of supported finishes.");
}
for (const key of [
  "collectionSlug",
  "collectionName",
  "name",
  "subtitle",
  "rarity",
  "bio",
  "printTitle",
  "catalogueCode",
  "provenanceLong",
  "subjectPath",
  "backgroundPath",
  "markPath",
]) {
  if (typeof card[key] !== "string" || !card[key].trim()) {
    throw new Error(`The print manifest requires ${key}.`);
  }
}

const input = {
  ...card,
  subjectPath: path.resolve(directory, card.subjectPath),
  backgroundPath: path.resolve(directory, card.backgroundPath),
  markPath: path.resolve(directory, card.markPath),
  subjectOverride: true,
  backgroundOverride: true,
  returnBytes: true,
};
for (const finish of finishes) {
  const options = {
    ...input,
    material: finish === "holographic" ? "gold" : finish,
    effect: finish === "holographic" ? "holographic" : "none",
  };
  const [front, back] = await Promise.all([renderFront(options), renderBack(options)]);
  const base = path.join(directory, `${slug}-${finish}`);
  await Promise.all([
    fs.writeFile(`${base}-front.webp`, front.buffer),
    fs.writeFile(`${base}-back.webp`, back.buffer),
    fs.writeFile(`${base}-master.png`, front.masterPng),
    sharp(front.masterPng).resize(400, 560).webp({ quality: 92 }).toFile(`${base}-400.webp`),
    sharp(front.masterPng).resize(128, 179).png().toFile(`${base}-128.png`),
  ]);
  console.log(`${slug} · ${finish} · ${front.width}×${front.height}`);
}
