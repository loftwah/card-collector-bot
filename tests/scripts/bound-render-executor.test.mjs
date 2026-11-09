import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
import {
  executeBoundRender,
  measureBoundRenderer,
} from "../../scripts/content/bound-render-executor.mjs";

const root = process.cwd();
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const fileDigest = (file) => digest(fs.readFileSync(path.join(root, file)));

test("trusted executor consumes checked buffers and selected resources for both sides", async () => {
  const image = await sharp({
    create: { width: 64, height: 64, channels: 4, background: "#263549" },
  })
    .png()
    .toBuffer();
  const record = { bytes: image.length, sha256: digest(image), mime: "image/png" };
  const runtime = "a".repeat(64);
  const manifest = {
    protocol: "foilbury-render-inputs-v1",
    metadata: {
      material: "plain",
      effect: "none",
      name: "Fixture",
      subtitle: "Test",
      setName: "Test",
      serial: "MEMBER EDITION",
      className: "",
      rarity: "",
      composition: { mode: "contain", zoom: 1, offsetX: 0, offsetY: 0 },
    },
    assets: { subject: record, background: record, back: record, mark: null },
    renderer: {
      ...measureBoundRenderer(root),
      runtimeImageSha256: runtime,
      fonts: {
        fraunces: fileDigest("art/fonts/Fraunces.ttf"),
        manrope: fileDigest("art/fonts/Manrope.ttf"),
        monoRegular: fileDigest("art/fonts/IBMPlexMono-Regular.ttf"),
        monoSemibold: fileDigest("art/fonts/IBMPlexMono-SemiBold.ttf"),
      },
      layers: {
        material: fileDigest("public/art/layers/material-plain.png"),
        frame: fileDigest("public/art/layers/frame-plain.png"),
        effect: null,
      },
    },
  };
  const tempParent = path.join(root, ".foilbury", "tmp", "bound-render-executor-tests");
  fs.mkdirSync(tempParent, { recursive: true });
  const args = {
    root,
    tempParent,
    manifest,
    inputs: { subject: image, background: image, back: image, mark: null },
    trustedRuntimeImageSha256: runtime,
  };
  const result = await executeBoundRender(args);
  assert.deepEqual(
    [(await sharp(result.front).metadata()).width, (await sharp(result.front).metadata()).height],
    [750, 1050],
  );
  assert.deepEqual(
    [(await sharp(result.back).metadata()).width, (await sharp(result.back).metadata()).height],
    [750, 1050],
  );
  assert.equal(result.frontSha256, digest(result.front));
  assert.equal(result.backSha256, digest(result.back));
  await assert.rejects(
    () =>
      executeBoundRender({ ...args, inputs: { ...args.inputs, subject: Buffer.from("changed") } }),
    /input changed/,
  );
  await assert.rejects(
    () => executeBoundRender({ ...args, trustedRuntimeImageSha256: "b".repeat(64) }),
    /runtime image/,
  );
  await assert.rejects(
    () =>
      executeBoundRender({
        ...args,
        manifest: {
          ...manifest,
          renderer: {
            ...manifest.renderer,
            layers: { ...manifest.renderer.layers, frame: "b".repeat(64) },
          },
        },
      }),
    /layer changed/,
  );
  await assert.rejects(
    () =>
      executeBoundRender({
        ...args,
        manifest: { ...manifest, renderer: { ...manifest.renderer, bundleSha256: "b".repeat(64) } },
      }),
    /code or lockfile/,
  );
});
