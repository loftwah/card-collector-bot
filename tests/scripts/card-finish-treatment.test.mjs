import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { composeCard, composeCardBack } from "../../art/compose.mjs";
import { publicBackHtml } from "../../scripts/content/public-back-template.mjs";

test("holographic back retains a visible but bounded effect", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "foilbury-finish-"));
  try {
    const source = path.join(dir, "source.png");
    await sharp({ create: { width: 750, height: 1050, channels: 3, background: "#303030" } })
      .png()
      .toFile(source);
    const variants = [];
    for (const effect of ["none", "holographic"]) {
      const output = path.join(dir, `${effect}.webp`);
      await composeCardBack({ backPath: source, material: "diamond", effect, outputPath: output });
      variants.push(
        await sharp(output)
          .extract({ left: 100, top: 150, width: 550, height: 600 })
          .removeAlpha()
          .raw()
          .toBuffer(),
      );
    }
    let difference = 0,
      changed = 0;
    for (let i = 0; i < variants[0].length; i++) {
      const d = Math.abs(variants[0][i] - variants[1][i]);
      difference += d;
      if (d > 3) changed++;
    }
    const mean = difference / variants[0].length;
    assert.ok(
      mean > 1 && mean < 10,
      `effect should be visible without washing out the back (mean ${mean})`,
    );
    assert.ok(
      changed / variants[0].length > 0.1,
      "the finish must differ from the no-effect control",
    );
    const fronts = [];
    for (const effect of ["none", "holographic"]) {
      const output = path.join(dir, `front-${effect}.png`);
      await composeCard({
        subjectPath: source,
        backgroundPath: source,
        material: "diamond",
        effect,
        name: "Fixture",
        outputPath: output,
      });
      fronts.push(
        await sharp(output)
          .extract({ left: 100, top: 150, width: 550, height: 600 })
          .removeAlpha()
          .raw()
          .toBuffer(),
      );
    }
    let frontDifference = 0;
    for (let i = 0; i < fronts[0].length; i++)
      frontDifference += Math.abs(fronts[0][i] - fronts[1][i]);
    const frontMean = frontDifference / fronts[0].length;
    assert.ok(
      frontMean > 1 && frontMean < 10,
      `front effect must be visible and bounded (mean ${frontMean})`,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("back template escapes metadata and preserves complete normal credit", () => {
  const html = publicBackHtml({
    card: { name: "Test <card>", subtitle: "A & B", description: "Bio", credit: "Credit <artist>" },
    collection: { name: "Set & friends" },
    logo: "",
    manrope: "",
    fraunces: "",
  });
  assert.match(html, /Test &lt;card&gt;/);
  assert.match(html, /A &amp; B/);
  assert.match(html, /Credit &lt;artist&gt;/);
  assert.doesNotMatch(html, /<artist>/);
});

test("missing provenance is not presented as an affirmative claim", () => {
  for (const empty of [undefined, "", "   "]) {
    const html = publicBackHtml({
      card: { name: "Unknown", source_work: empty, credit: empty },
      collection: { name: "Fixture" },
      logo: "",
      manrope: "",
      fraunces: "",
    });
    assert.match(html, /Source not specified/);
    assert.match(html, /Credit not supplied/);
    assert.doesNotMatch(html, /Foilbury original|Source art credited by the owner/);
  }
  const known = publicBackHtml({
    card: { name: "Known", source_work: "Known source", credit: "Artist credit" },
    collection: { name: "Fixture" },
    logo: "",
    manrope: "",
    fraunces: "",
  });
  assert.match(known, /Known source/);
  assert.match(known, /Artist credit/);
});
