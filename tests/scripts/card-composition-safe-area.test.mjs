import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { composeCard, finishLabels, footerLabels, wrapName } from "../../art/compose.mjs";

test("long footer metadata is explicitly abbreviated", () => {
  const labels = footerLabels("W".repeat(100), "class", "rare", "W".repeat(100));
  assert.equal(labels.meta.length, 42);
  assert.ok(labels.meta.endsWith("…"));
  assert.equal(labels.serial.length, 40);
  assert.ok(labels.serial.endsWith("…"));
  assert.deepEqual(footerLabels("Fighter", "Print", "Rare", "42"), {
    meta: "FIGHTER · PRINT · RARE",
    serial: "42",
  });
});

test("canonical finish labels remain complete", () => {
  assert.deepEqual(finishLabels("plain", "none"), ["PLAIN", ""]);
  assert.deepEqual(finishLabels("silver", "none"), ["SILVER", ""]);
  assert.deepEqual(finishLabels("gold", "none"), ["GOLD", ""]);
  assert.deepEqual(finishLabels("diamond", "holographic"), ["HOLOGRAPHIC", ""]);
});

test("long and unbroken names wrap without silent truncation", () => {
  const unbroken = "W".repeat(45);
  assert.equal(wrapName(unbroken).join(""), unbroken);
  assert.ok(wrapName(unbroken).every((line) => Array.from(line).length <= 20));
  const overflow = wrapName("W".repeat(100));
  assert.equal(overflow.length, 3);
  assert.ok(overflow[2].endsWith("…"));
});

test("wrapped names reserve the subject area, including zoomed compositions", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "foilbury-card-safe-area-"));
  try {
    const subject = path.join(dir, "subject.png");
    const background = path.join(dir, "background.png");
    await sharp({ create: { width: 200, height: 300, channels: 3, background: "#ff0000" } })
      .png()
      .toFile(subject);
    await sharp({ create: { width: 200, height: 300, channels: 3, background: "#000000" } })
      .png()
      .toFile(background);
    for (const [name, limit] of [
      ["A short name", 800],
      ["A reasonably long name", 780],
      ["The Extraordinary Guardian of the Eucalyptus Forest", 750],
    ]) {
      for (const mode of ["contain", "fill", "medallion"]) {
        const output = path.join(dir, "output.png");
        await composeCard({
          subjectPath: subject,
          backgroundPath: background,
          name,
          composition: { mode, zoom: 1.6, offsetX: 20, offsetY: 20 },
          outputPath: output,
        });
        const { data, info } = await sharp(output)
          .removeAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        let redPixels = 0;
        for (let y = 0; y < info.height; y++)
          for (let x = 0; x < info.width; x++) {
            const i = (y * info.width + x) * info.channels;
            if (data[i] > 180 && data[i + 1] < 60 && data[i + 2] < 60) {
              redPixels++;
              assert.ok(y < limit, `${name} / ${mode}: subject reached row ${y}`);
            }
          }
        assert.ok(redPixels > 100, `${name} / ${mode}: subject should be visible`);
      }
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("source shape governs cropping and all subject pixels stay in the art window", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "foilbury-card-shapes-"));
  try {
    const background = path.join(dir, "background.png");
    await sharp({ create: { width: 200, height: 300, channels: 3, background: "#000" } })
      .png()
      .toFile(background);
    for (const [shape, width, height, alpha] of [
      ["tall", 100, 200, false],
      ["wide", 200, 100, false],
      ["square", 160, 160, false],
      ["alpha", 160, 160, true],
    ]) {
      const source = path.join(dir, `${shape}.png`);
      const inset = alpha ? 20 : 0;
      const w = width - 2 * inset,
        h = height - 2 * inset;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect x="${inset}" y="${inset}" width="${w / 2}" height="${h / 2}" fill="red"/><rect x="${inset + w / 2}" y="${inset}" width="${w / 2}" height="${h / 2}" fill="lime"/><rect x="${inset}" y="${inset + h / 2}" width="${w / 2}" height="${h / 2}" fill="blue"/><rect x="${inset + w / 2}" y="${inset + h / 2}" width="${w / 2}" height="${h / 2}" fill="yellow"/></svg>`;
      let input = sharp(Buffer.from(svg));
      if (!alpha) input = input.removeAlpha();
      await input.png().toFile(source);
      const results = {};
      for (const mode of ["contain", "fill", "medallion"]) {
        const output = path.join(dir, `${shape}-${mode}.png`);
        await composeCard({
          subjectPath: source,
          backgroundPath: background,
          name: "Test",
          composition: { mode, zoom: 1.6, offsetX: 20, offsetY: 20 },
          outputPath: output,
        });
        results[mode] = await fs.readFile(output);
        const { data, info } = await sharp(output)
          .removeAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        const counts = [0, 0, 0, 0];
        for (let y = 0; y < info.height; y++)
          for (let x = 0; x < info.width; x++) {
            const i = (y * info.width + x) * info.channels,
              r = data[i],
              g = data[i + 1],
              b = data[i + 2];
            const colour =
              r > 180 && g < 60 && b < 60
                ? 0
                : g > 180 && r < 60 && b < 60
                  ? 1
                  : b > 180 && r < 60 && g < 60
                    ? 2
                    : r > 180 && g > 180 && b < 60
                      ? 3
                      : -1;
            if (colour >= 0) {
              counts[colour]++;
              assert.ok(
                x >= 30 && x < 720 && y >= 150 && y < 790,
                `${shape}/${mode} escaped at ${x},${y}`,
              );
            }
          }
        if (shape !== "square" || mode === "contain")
          for (const count of counts)
            assert.ok(count > 100, `${shape}/${mode} lost a source quadrant`);
      }
      if (shape !== "square") {
        assert.deepEqual(results.fill, results.contain, `${shape} fill must contain`);
        assert.deepEqual(results.medallion, results.contain, `${shape} medallion must contain`);
      } else {
        assert.notDeepEqual(
          results.medallion,
          results.contain,
          "square opaque medallion remains available",
        );
        assert.notDeepEqual(results.fill, results.contain, "square opaque fill remains available");
        const output = path.join(dir, "square-default.png");
        await composeCard({
          subjectPath: source,
          backgroundPath: background,
          name: "Test",
          composition: { zoom: 1.6, offsetX: 20, offsetY: 20 },
          outputPath: output,
        });
        assert.deepEqual(
          await fs.readFile(output),
          results.contain,
          "a square source is not automatically an avatar",
        );
      }
    }
    const textOutput = path.join(dir, "wide-name.png");
    await composeCard({
      subjectPath: path.join(dir, "tall.png"),
      backgroundPath: background,
      name: "W".repeat(45),
      subtitle: "W".repeat(100),
      outputPath: textOutput,
    });
    const { data: pixels, info: dimensions } = await sharp(textOutput)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    for (let y = 760; y < 910; y++)
      for (let x = 686; x < dimensions.width; x++) {
        const i = (y * dimensions.width + x) * dimensions.channels;
        assert.ok(
          !(pixels[i] > 200 && pixels[i + 1] > 200 && pixels[i + 2] > 200),
          `name overflow at ${x},${y}`,
        );
      }
    for (let y = 915; y < 940; y++)
      for (let x = 686; x < dimensions.width; x++) {
        const i = (y * dimensions.width + x) * dimensions.channels;
        assert.ok(
          !(pixels[i] > 200 && pixels[i + 1] > 200 && pixels[i + 2] > 200),
          `subtitle overflow at ${x},${y}`,
        );
      }
    const headerOutput = path.join(dir, "long-header.png");
    await composeCard({
      subjectPath: path.join(dir, "tall.png"),
      backgroundPath: background,
      markPath: path.join(dir, "square.png"),
      setName: "W".repeat(100),
      material: "diamond",
      effect: "holographic",
      name: "Test",
      className: "W".repeat(100),
      rarity: "W".repeat(100),
      serial: "W".repeat(100),
      outputPath: headerOutput,
    });
    const header = await sharp(headerOutput)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    for (let y = 60; y < 90; y++)
      for (let x = 430; x < 458; x++) {
        const i = (y * header.info.width + x) * header.info.channels;
        assert.ok(
          !(header.data[i] > 125 && header.data[i + 1] > 125 && header.data[i + 2] > 90),
          `header lanes overlap at ${x},${y}`,
        );
      }
    for (let y = 953; y < 975; y++)
      for (let x = 686; x < 698; x++) {
        const i = (y * header.info.width + x) * header.info.channels;
        assert.ok(
          !(header.data[i] > 125 && header.data[i + 1] > 125 && header.data[i + 2] > 90),
          `footer metadata overflows at ${x},${y}`,
        );
      }
    for (let y = 1005; y < 1020; y++)
      for (let x = 165; x < 210; x++) {
        const i = (y * header.info.width + x) * header.info.channels;
        assert.ok(
          !(header.data[i] > 125 && header.data[i + 1] > 125 && header.data[i + 2] > 125),
          `serial overlaps branding at ${x},${y}`,
        );
      }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
