#!/usr/bin/env node
/**
 * Builds the web-only card layer derivatives used by the live composition
 * preview (admin artwork editor). The PNG originals remain the deterministic
 * renderer sources. A half-resolution WebP keeps the admin preview from
 * downloading 5 MB of textures for one card while remaining 2x for a 190px
 * preview.
 *
 *   node scripts/brand/optimize-card-layers.mjs
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const dir = path.join("public", "art", "layers");
const files = [
  "material-plain",
  "material-silver",
  "material-gold",
  "material-diamond",
  "frame-plain",
  "frame-silver",
  "frame-gold",
  "frame-diamond",
  "effect-holographic",
  "effect-prismatic",
];
let saved = 0;
for (const name of files) {
  const source = path.join(dir, `${name}.png`);
  const target = path.join(dir, `${name}.webp`);
  if (!fs.existsSync(source)) continue;
  await sharp(source)
    .resize(375, 525, { fit: "fill" })
    .webp({ quality: 82, alphaQuality: 90, effort: 6 })
    .toFile(target);
  const before = fs.statSync(source).size;
  const after = fs.statSync(target).size;
  saved += before - after;
  console.log(`${name}.webp · ${(before / 1024).toFixed(0)} KB → ${(after / 1024).toFixed(0)} KB`);
}
console.log(`saved ${(saved / 1024 / 1024).toFixed(2)} MB across ${files.length} derivatives`);
