// Trusted operator executor for the held version-bound protocol. This module
// verifies what it consumes; it does not attest who ran it or publish anything.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { withOwnedRenderTemp } from "./owned-render-temp.mjs";

const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const digestPattern = /^[a-f0-9]{64}$/;
const bundleFiles = [
  "art/compose.mjs",
  "scripts/content/bound-render-executor.mjs",
  "scripts/content/bound-render-worker.mjs",
  "scripts/content/owned-render-temp.mjs",
];
const fontPaths = {
  fraunces: "art/fonts/Fraunces.ttf",
  manrope: "art/fonts/Manrope.ttf",
  monoRegular: "art/fonts/IBMPlexMono-Regular.ttf",
  monoSemibold: "art/fonts/IBMPlexMono-SemiBold.ttf",
};

/** Measure local code and lockfile. The runtime image digest is supplied by the
 * trusted launcher; it is an operator assertion, not an execution attestation. */
export function measureBoundRenderer(root) {
  const files = Object.fromEntries(
    bundleFiles.map((name) => [name, sha(fs.readFileSync(path.join(root, name)))]),
  );
  return {
    bundleSha256: sha(JSON.stringify(files)),
    lockfileSha256: sha(fs.readFileSync(path.join(root, "pnpm-lock.yaml"))),
  };
}

export function describeBoundRenderer(root, material, effect, runtimeImageSha256) {
  if (
    !["plain", "silver", "gold", "diamond"].includes(material) ||
    !["none", "holographic", "prismatic"].includes(effect) ||
    !digestPattern.test(runtimeImageSha256 ?? "")
  )
    throw new Error("Select a known finish and a trusted runtime image digest.");
  const fonts = Object.fromEntries(
    Object.entries(fontPaths).map(([role, file]) => [
      role,
      sha(fs.readFileSync(path.join(root, file))),
    ]),
  );
  const layer = (name) => sha(fs.readFileSync(path.join(root, "public/art/layers", name)));
  return {
    ...measureBoundRenderer(root),
    runtimeImageSha256,
    fonts,
    layers: {
      material: layer(`material-${material}.png`),
      frame: layer(`frame-${material}.png`),
      effect: effect === "none" ? null : layer(`effect-${effect}.png`),
    },
  };
}

export async function executeBoundRender({
  root,
  tempParent,
  manifest,
  inputs,
  trustedRuntimeImageSha256,
}) {
  if (
    !path.isAbsolute(root) ||
    !path.isAbsolute(tempParent) ||
    fs.realpathSync(root) !==
      fs.realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../..")) ||
    manifest?.protocol !== "foilbury-render-inputs-v1"
  )
    throw new Error("Invalid trusted renderer input.");
  const meta = manifest.metadata,
    renderer = manifest.renderer;
  if (
    !meta ||
    !renderer ||
    !["plain", "silver", "gold", "diamond"].includes(meta.material) ||
    !["none", "holographic", "prismatic"].includes(meta.effect)
  )
    throw new Error("Invalid render resources.");
  if (
    !digestPattern.test(trustedRuntimeImageSha256 ?? "") ||
    trustedRuntimeImageSha256 !== renderer.runtimeImageSha256
  )
    throw new Error("Trusted runtime image does not match the manifest.");
  const measured = measureBoundRenderer(root);
  if (
    measured.bundleSha256 !== renderer.bundleSha256 ||
    measured.lockfileSha256 !== renderer.lockfileSha256
  )
    throw new Error("Renderer code or lockfile changed.");
  const expectedLayers = {
    material: `material-${meta.material}.png`,
    frame: `frame-${meta.material}.png`,
    effect: meta.effect === "none" ? null : `effect-${meta.effect}.png`,
  };
  const layers = {};
  for (const [role, name] of Object.entries(expectedLayers)) {
    const expected = renderer.layers?.[role];
    if (!name) {
      if (expected !== null) throw new Error("Unexpected effect layer.");
      continue;
    }
    const data = fs.readFileSync(path.join(root, "public/art/layers", name));
    if (!digestPattern.test(expected ?? "") || sha(data) !== expected)
      throw new Error("A render layer changed.");
    layers[name] = data;
  }
  const fonts = {};
  for (const [role, file] of Object.entries(fontPaths)) {
    const data = fs.readFileSync(path.join(root, file));
    if (!digestPattern.test(renderer.fonts?.[role] ?? "") || sha(data) !== renderer.fonts[role])
      throw new Error("A render font changed.");
    fonts[role] = data;
  }
  const inputBytes = {};
  for (const role of ["subject", "background", "back", "mark"]) {
    const record = manifest.assets?.[role],
      bytes = inputs?.[role];
    if (!record && role === "mark" && bytes === null) continue;
    if (
      !record ||
      !(bytes instanceof Uint8Array) ||
      bytes.length !== record.bytes ||
      sha(bytes) !== record.sha256
    )
      throw new Error("A render input changed.");
    inputBytes[role] = Buffer.from(bytes);
  }
  // Trusted deployment must prevent mutation of the executable while this
  // process runs. The copied input buffers below are the only art consumed.
  const { composeCard, composeCardBack } = await import("../../art/compose.mjs");
  return withOwnedRenderTemp(tempParent, async (dir) => {
    const write = (name, bytes) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
      return file;
    };
    const layerDir = path.join(dir, "layers");
    fs.mkdirSync(layerDir, { mode: 0o700 });
    for (const [name, bytes] of Object.entries(layers))
      fs.writeFileSync(path.join(layerDir, name), bytes, { flag: "wx", mode: 0o600 });
    const fontFiles = Object.entries(fonts).map(([role, bytes]) =>
      write(`font-${role}.ttf`, bytes),
    );
    const subjectPath = write("subject", inputBytes.subject),
      backgroundPath = write("background", inputBytes.background),
      backPath = write("back", inputBytes.back);
    const markPath = inputBytes.mark
      ? write(
          manifest.assets.mark.mime === "image/svg+xml" ? "mark.svg" : "mark-image",
          inputBytes.mark,
        )
      : "";
    const frontPath = path.join(dir, "front.webp"),
      backOutputPath = path.join(dir, "back.webp");
    await composeCard({
      subjectPath,
      backgroundPath,
      markPath,
      material: meta.material,
      effect: meta.effect,
      name: meta.name,
      subtitle: meta.subtitle,
      setName: meta.setName,
      serial: meta.serial,
      className: meta.className,
      rarity: meta.rarity,
      composition: meta.composition,
      outputPath: frontPath,
      renderResources: { layerDir, fontFiles },
    });
    await composeCardBack({
      backPath,
      material: meta.material,
      effect: meta.effect,
      outputPath: backOutputPath,
      renderResources: { layerDir, fontFiles },
    });
    const front = fs.readFileSync(frontPath),
      back = fs.readFileSync(backOutputPath);
    const thumb = await sharp(front)
      .resize(300, 420, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82, effort: 5 })
      .toBuffer();
    const preview = await sharp(front)
      .resize(600, 840, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82, effort: 5 })
      .toBuffer();
    return {
      front,
      back,
      derivatives: { thumb, preview },
      frontSha256: sha(front),
      backSha256: sha(back),
      manifestProtocol: manifest.protocol,
    };
  });
}
