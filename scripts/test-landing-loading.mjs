#!/usr/bin/env node
/** Rendered landing-image loading, failure and no-JavaScript checks.
 * Uses the running local Worker and intercepts only public image bytes with a
 * tracked synthetic card back. It does not change the catalogue or wallet. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium } from "@playwright/test";

const baseURL = process.env.FOILBURY_URL ?? "http://localhost:5173";
const image = fs.readFileSync("public/brand/card-back.webp");
const browser = await chromium.launch({ headless: true });
const cardSelector = ".hero-card-frame";
async function fulfil(route) {
  if (!/\/media\/(render|derivative)\//.test(new URL(route.request().url()).pathname))
    return route.continue();
  return route.fulfill({ status: 200, contentType: "image/webp", body: image });
}
try {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 390, height: 844 },
    reducedMotion: "reduce",
  });
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  await context.route("**/media/**", async (route) => {
    await pending;
    return fulfil(route);
  });
  const page = await context.newPage();
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const frames = page.locator(cardSelector);
  const count = await frames.count();
  assert.ok(count > 0, "The local public fixture must include at least one hero card.");
  const geometry = () =>
    frames.evaluateAll((nodes) =>
      nodes.map((node) => {
        const box = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return {
          x: box.x,
          y: box.y,
          width: box.width,
          height: box.height,
          cssWidth: parseFloat(style.width),
          cssHeight: parseFloat(style.height),
          background: style.backgroundImage,
          animation: style.animationName,
          state: node.dataset.artState ?? "loading",
        };
      }),
    );
  const before = await geometry();
  assert.ok(
    before.every(
      (item) =>
        item.state === "loading" &&
        item.background.includes("gradient") &&
        item.animation === "none",
    ),
  );
  assert.ok(before.every((item) => Math.abs(item.cssWidth / item.cssHeight - 5 / 7) < 0.03));
  release();
  await page.waitForFunction(
    (expected) =>
      [...document.querySelectorAll(".hero-card-frame")].filter(
        (node) => node.dataset.artState === "loaded",
      ).length === expected,
    count,
  );
  const after = await geometry();
  for (let i = 0; i < count; i++)
    for (const key of ["x", "y", "width", "height"])
      assert.ok(
        Math.abs(before[i][key] - after[i][key]) < 1,
        `${key} shifted after artwork loaded`,
      );
  console.log("PASS reduced-motion skeleton keeps card geometry stable as images load");
  await context.close();

  const failedContext = await browser.newContext({
    baseURL,
    viewport: { width: 390, height: 844 },
  });
  await failedContext.route("**/media/**", (route) =>
    /\/media\/(render|derivative)\//.test(new URL(route.request().url()).pathname)
      ? route.fulfill({ status: 503, body: "" })
      : route.continue(),
  );
  const failed = await failedContext.newPage();
  await failed.goto("/", { waitUntil: "networkidle" });
  const errors = failed.locator('.hero-card-frame[data-art-state="error"]');
  assert.equal(await errors.count(), count);
  for (const item of await errors.all()) {
    assert.equal(await item.locator(".hero-card-error").innerText(), "Artwork unavailable");
    assert.match(
      await item.locator("xpath=..").getAttribute("aria-label"),
      /, artwork unavailable$/,
    );
  }
  console.log("PASS failed artwork is visibly and accessibly identified");
  const retryFrame = errors.first();
  const retryLink = retryFrame.locator("xpath=..");
  const failedLabel = await retryLink.getAttribute("aria-label");
  await retryFrame.locator("img").evaluate((element, dataUrl) => {
    element.removeAttribute("srcset");
    element.src = dataUrl;
  }, `data:image/webp;base64,${image.toString("base64")}`);
  await failed.waitForFunction(() => document.querySelector(".hero-card-frame")?.getAttribute("data-art-state") === "loaded");
  assert.equal(await retryLink.getAttribute("aria-label"), failedLabel.replace(/, artwork unavailable$/, ""));
  console.log("PASS recovered artwork restores its accessible name");
  await failedContext.close();

  const touch = await browser.newContext({
    baseURL,
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  await touch.route("**/media/**", fulfil);
  const tp = await touch.newPage();
  await tp.goto("/", { waitUntil: "networkidle" });
  await tp.locator("a.hero-card").first().evaluate((link) =>
    link.addEventListener("click", (event) => event.preventDefault()),
  );
  const touchFrame = tp.locator(cardSelector).first();
  const touchBefore = await touchFrame.boundingBox();
  await touchFrame.tap();
  assert.equal(await touchFrame.evaluate((node) => getComputedStyle(node).transform), "none");
  const touchAfter = await touchFrame.boundingBox();
  for (const key of ["x", "y", "width", "height"])
    assert.ok(Math.abs(touchBefore[key] - touchAfter[key]) < 1, `${key} shifted after touch`);
  console.log("PASS touch interaction does not leave card artwork shifted");
  await touch.close();

  for (const fail of [false, true]) {
    const noJs = await browser.newContext({
      baseURL,
      viewport: { width: 390, height: 844 },
      javaScriptEnabled: false,
    });
    await noJs.route("**/media/**", (route) =>
      fail && /\/media\/(render|derivative)\//.test(new URL(route.request().url()).pathname)
        ? route.fulfill({ status: 503, body: "" })
        : fulfil(route),
    );
    const np = await noJs.newPage();
    await np.goto("/", { waitUntil: "networkidle" });
    assert.equal(
      await np.locator("noscript p").innerText(),
      "If an image doesn't load, open its card page.",
    );
    assert.ok(await np.locator("noscript p").isVisible());
    assert.equal(await np.locator("a.hero-card").count(), count);
    if (!fail)
      for (const img of await np.locator(".hero-card img").all())
        assert.ok(await img.evaluate((element) => element.complete && element.naturalWidth > 0));
    console.log(
      `PASS no-JavaScript ${fail ? "failed" : "loaded"} artwork retains named card links and guidance`,
    );
    await noJs.close();
  }
} finally {
  await browser.close();
}
