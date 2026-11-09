import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium } from "@playwright/test";
import { publicBackHtml } from "../../scripts/content/public-back-template.mjs";

test("public back keeps long copy out of the credit and footer", async (t) => {
  const manrope = fs.readFileSync("public/fonts/manrope-latin.woff2").toString("base64");
  const fraunces = fs.readFileSync("public/fonts/Fraunces.ttf").toString("base64");
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 750, height: 1050 } });
  const card = {
    name: "W".repeat(120),
    subtitle: "Long subtitle ".repeat(50),
    description: "Long biography ".repeat(150),
    credit: "Long credit ".repeat(150),
    attributes_json: JSON.stringify(
      Array.from({ length: 4 }, () => ({
        label: "Long label ".repeat(30),
        value: "Long value ".repeat(30),
      })),
    ),
  };
  await page.setContent(
    publicBackHtml({
      card,
      collection: { name: "Long collection ".repeat(100) },
      logo: "",
      manrope,
      fraunces,
    }),
    { waitUntil: "load" },
  );
  await page.evaluate(() => document.fonts.ready);
  const layout = await page.evaluate(() => {
    const rect = (s) => {
      const r = document.querySelector(s).getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    };
    const credit = document.querySelector(".credit"),
      bio = document.querySelector(".bio");
    return {
      content: rect("dl"),
      credit: rect(".credit"),
      foot: rect(".foot"),
      topName: rect(".top>div"),
      stamp: rect(".stamp"),
      creditSize: getComputedStyle(credit).fontSize,
      creditClipped: credit.scrollHeight > credit.clientHeight,
      bioClipped: bio.scrollHeight > bio.clientHeight,
    };
  });
  assert.equal(layout.creditSize, "16px");
  assert.ok(layout.content.bottom < layout.credit.top, "long content must end before credit");
  assert.ok(layout.credit.bottom < layout.foot.top, "credit must end before footer");
  assert.ok(layout.foot.bottom <= 970, "footer must clear the finish frame's lower ornament");
  assert.ok(layout.topName.right < layout.stamp.left, "collection label must not touch stamp");
  assert.ok(
    layout.creditClipped && layout.bioClipped,
    "long-copy negative control must exercise the clamps",
  );
});
