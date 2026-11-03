#!/usr/bin/env node
/**
 * Foilbury product QA: journeys, geometry, state handling and negative controls.
 *
 * This is deliberately not a screenshot gallery. It drives the real product,
 * measures the rendered card contract, forces slow/failed requests, checks
 * role boundaries, and calibrates the detectors with broken UI.
 *
 *   FOILBURY_URL=http://localhost:5173 node scripts/test-product-qa.mjs
 */
import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs";
import path from "node:path";

const baseURL = process.env.FOILBURY_URL ?? "http://localhost:5173";
const evidenceDir = path.join(".foilbury", "evidence", "product-qa");
fs.mkdirSync(evidenceDir, { recursive: true });

const results = [];
let failures = 0;
function check(name, condition, detail = "") {
  if (condition) {
    results.push({ name, status: "PASS", detail });
    console.log(`PASS ${name}${detail ? ` · ${detail}` : ""}`);
  } else {
    failures++;
    results.push({ name, status: "FAIL", detail });
    console.error(`FAIL ${name}${detail ? ` · ${detail}` : ""}`);
  }
}
async function failOnThrow(name, fn) {
  try {
    await fn();
  } catch (error) {
    failures++;
    results.push({ name, status: "FAIL", detail: String(error?.message ?? error) });
    console.error(`FAIL ${name} · ${error?.message ?? error}`);
  }
}

const browser = await chromium.launch({ headless: true });
let expectingFailure = false;
const consoleErrors = [];
const pageErrors = [];
const failedRequests = [];
function watch(page) {
  page.on("console", (message) => {
    if (message.type() === "error" && !expectingFailure)
      consoleErrors.push({ url: page.url(), text: message.text() });
  });
  page.on("pageerror", (error) => pageErrors.push({ url: page.url(), text: error.message }));
  page.on("response", (response) => {
    if (
      !expectingFailure &&
      response.status() >= 400 &&
      !response.url().includes("/api/v1/dev/login")
    ) {
      failedRequests.push({ url: response.url(), status: response.status() });
    }
  });
}

async function login(context, email = "owner@foilbury.local") {
  const response = await context.request.post("/api/v1/dev/login", { data: { email } });
  if (response.status() !== 200) throw new Error(`Dev login returned ${response.status()}`);
}

async function geometry(page, selector = ".layered-card") {
  return page.evaluate((sel) => {
    const card = document.querySelector(sel);
    if (!card) return { present: false };
    const rect = (node) => (node ? node.getBoundingClientRect() : null);
    const cardRect = rect(card);
    const text = card.querySelector(".layered-card__text");
    const title = card.querySelector(".layered-card__text h3");
    const meta = card.querySelector(".layered-card__meta");
    const toolbar =
      card.parentElement?.querySelector(".card-toolbar__button") ??
      document.querySelector(".card-toolbar__button");
    const toolbarRect = rect(toolbar);
    const back = card.querySelector(".layered-card__back-copy");
    const backTitle = back?.querySelector("h3");
    const backBio = back?.querySelector(".layered-card__back-bio");
    const backSerial = back?.querySelector(".layered-card__back-serial");
    const visibleImage = [...card.querySelectorAll("img")].find((image) => {
      const style = getComputedStyle(image);
      return style.opacity !== "0" && image.getBoundingClientRect().width > 20;
    });
    return {
      present: true,
      ratio: cardRect.width / cardRect.height,
      card: {
        top: cardRect.top,
        bottom: cardRect.bottom,
        left: cardRect.left,
        right: cardRect.right,
      },
      text: rect(text),
      title: rect(title),
      meta: rect(meta),
      toolbar: toolbarRect,
      toolbarOverlapsCard: toolbarRect
        ? !(toolbarRect.top >= cardRect.bottom - 1 || toolbarRect.bottom <= cardRect.top + 1)
        : false,
      back: rect(back),
      backTitle: rect(backTitle),
      backBio: rect(backBio),
      backSerial: rect(backSerial),
      backOverflow: back ? back.scrollHeight > back.clientHeight + 2 : null,
      backTitleBioOverlap:
        backTitle && backBio
          ? backTitle.getBoundingClientRect().bottom > backBio.getBoundingClientRect().top + 1
          : false,
      imageLoaded: visibleImage ? visibleImage.complete && visibleImage.naturalWidth > 0 : false,
      nestedInteractive: card.querySelectorAll("a button, button a, a a, button button").length,
    };
  }, selector);
}

async function publishedGeometry(page, selector = ".published-card") {
  return page.evaluate((sel) => {
    const card = document.querySelector(sel);
    if (!card) return { present: false };
    const rect = (node) => (node ? node.getBoundingClientRect() : null);
    const cardRect = rect(card);
    const toolbar = card.parentElement?.querySelector(".card-toolbar__button") ?? null;
    const toolbarRect = rect(toolbar);
    const front = card.querySelector(".published-card__face:not(.published-card__back)");
    const back = card.querySelector(".published-card__back");
    return {
      present: true,
      ratio: cardRect.width / cardRect.height,
      card: {
        top: cardRect.top,
        bottom: cardRect.bottom,
        left: cardRect.left,
        right: cardRect.right,
      },
      toolbar: toolbarRect,
      toolbarOverlapsCard: toolbarRect
        ? !(toolbarRect.top >= cardRect.bottom - 1 || toolbarRect.bottom <= cardRect.top + 1)
        : false,
      imageLoaded: Boolean(front?.complete && front.naturalWidth > 0),
      backLoaded: Boolean(back?.complete && back.naturalWidth > 0),
      nestedInteractive: card.querySelectorAll("a button, button a, a a, button button").length,
    };
  }, selector);
}

function inside(inner, outer, tolerance = 1.5) {
  if (!inner || !outer) return false;
  return (
    inner.left >= outer.left - tolerance &&
    inner.right <= outer.right + tolerance &&
    inner.top >= outer.top - tolerance &&
    inner.bottom <= outer.bottom + tolerance
  );
}

async function audit(page, name) {
  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const serious = axe.violations.filter((violation) =>
    ["serious", "critical"].includes(violation.impact ?? ""),
  );
  check(
    `${name}: no serious axe findings`,
    serious.length === 0,
    serious.map((violation) => `${violation.id}(${violation.nodes.length})`).join(", "),
  );
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(evidenceDir, `${name}.png`), fullPage: false });
}

let owner;
try {
  /* ---------- Anonymous public journey ---------- */
  await failOnThrow("anonymous public journey", async () => {
    const context = await browser.newContext({
      baseURL,
      viewport: { width: 1440, height: 1000 },
      colorScheme: "light",
    });
    const page = await context.newPage();
    watch(page);
    await page.goto("/");
    await page.getByRole("heading", { name: /characters worth keeping/i }).waitFor();
    check(
      "public home has one clear primary action",
      (await page.getByRole("link", { name: /start collecting/i }).count()) === 1,
    );
    await page.getByRole("link", { name: /browse every public card/i }).click();
    await page.getByRole("heading", { name: /public showcase/i }).waitFor();
    check("public catalogue navigation resolves", page.url().endsWith("/cabinet"));
    const cardLink = page.locator('a[href^="/cabinet/"]').first();
    if (await cardLink.count()) {
      await cardLink.click();
      await page.waitForLoadState("networkidle");
      check(
        "public card detail opens from the catalogue",
        /\/cabinet\/[^/]+$/.test(new URL(page.url()).pathname),
      );
      await page.goBack();
      await page.waitForLoadState("networkidle");
      check("browser back returns to the catalogue", page.url().includes("/cabinet"));
    }
    await context.close();
  });

  /* ---------- Owner desktop journey ---------- */
  owner = await browser.newContext({
    baseURL,
    viewport: { width: 1440, height: 1000 },
    colorScheme: "light",
    reducedMotion: "no-preference",
  });
  await login(owner);
  const page = await owner.newPage();
  watch(page);

  await failOnThrow("cabinet overview and card contract", async () => {
    await page.goto("/play");
    await page.getByRole("heading", { name: /your cabinet/i }).waitFor();
    const geo = await publishedGeometry(page);
    check("featured card is present", geo.present);
    check(
      "featured card keeps 5:7 geometry",
      geo.present && Math.abs(geo.ratio - 5 / 7) < 0.006,
      `ratio ${geo.ratio?.toFixed(4)}`,
    );
    check("featured front render decoded", geo.imageLoaded);
    check("featured back render decoded", geo.backLoaded);
    check(
      "flip control is reserved outside the card face",
      geo.toolbar ? !geo.toolbarOverlapsCard : false,
    );
    check("no nested interactive card controls", geo.nestedInteractive === 0);

    await page.locator(".cabinet-more__summary").click();
    const menuBox = await page.locator(".cabinet-more__menu").boundingBox();
    check(
      "cabinet More menu is fully visible",
      Boolean(menuBox && menuBox.height > 100 && menuBox.y + menuBox.height <= 1000),
      menuBox ? `${Math.round(menuBox.height)}px` : "missing",
    );
    await page.keyboard.press("Escape");
    check(
      "Escape closes the cabinet menu",
      (await page.locator(".cabinet-more[open]").count()) === 0,
    );

    await page.getByRole("button", { name: /show .* back/i }).click();
    check(
      "back face is shown on demand",
      (await page.locator(".published-card__back").getAttribute("data-hidden")) === "false",
    );
    await page.getByRole("button", { name: /show .* front/i }).click();
    check(
      "front face returns",
      (await page.locator(".published-card__back").getAttribute("data-hidden")) === "true",
    );

    await page.locator(".published-card").click({ position: { x: 40, y: 40 } });
    await page.waitForURL(/\/play\/card\//);
    check("card body navigates to detail", page.url().includes("/play/card/"));
  });

  await failOnThrow("collection filters, totals and stale responses", async () => {
    await page.goto("/play/collection");
    await page.getByRole("heading", { name: /your drawers/i }).waitFor();
    await page.locator('[data-hydrated="true"]').waitFor();
    const totalLabel = await page.locator('[aria-live="polite"]').innerText();
    const apiTotal = await (await owner.request.get("/api/v1/inventory?limit=1")).json();
    check(
      "collection count is a real total, not the first page",
      totalLabel.includes(String(apiTotal.total)),
      `${totalLabel} vs ${apiTotal.total}`,
    );
    const firstFace = await page
      .locator(".card-face")
      .first()
      .evaluate((el) => {
        const rect = el.getBoundingClientRect();
        const image = el.querySelector("img");
        return {
          ratio: rect.width / rect.height,
          loaded: image ? image.complete && image.naturalWidth > 0 : false,
        };
      });
    check(
      "collection card keeps 5:7 geometry",
      Math.abs(firstFace.ratio - 5 / 7) < 0.006,
      `ratio ${firstFace.ratio.toFixed(4)}`,
    );
    check("collection card image decoded", firstFace.loaded);

    /* Empty is not an error. */
    await page.getByLabel("Search your collection").fill("zzzz-no-such-card");
    await page.getByRole("button", { name: "Apply" }).click();
    await page.getByText(/no cards match this view/i).waitFor({ timeout: 15000 });
    check(
      "empty filter is described as empty, not failure",
      (await page.getByRole("alert").count()) === 0,
    );

    /* Rapid A→B filter changes resolve to the latest request. */
    await page.route("**/api/v1/inventory*", async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("collection") === "protocol-11")
        await new Promise((resolve) => setTimeout(resolve, 900));
      await route.continue();
    });
    await page.getByLabel("Search your collection").fill("");
    const collectionSelect = page.getByLabel("Collection", { exact: true });
    const options = await collectionSelect
      .locator("option")
      .evaluateAll((items) => items.map((item) => item.value).filter(Boolean));
    if (options.length >= 2) {
      await collectionSelect.selectOption(options[0]);
      await new Promise((resolve) => setTimeout(resolve, 60));
      await collectionSelect.selectOption(options[1]);
      await page.waitForTimeout(1300);
      check(
        "latest collection filter wins over a slow earlier response",
        (await collectionSelect.inputValue()) === options[1],
      );
      const shown = await page.locator('[aria-live="polite"]').innerText();
      const expected = await (
        await owner.request.get(`/api/v1/inventory?limit=1&collection=${options[1]}`)
      ).json();
      check(
        "filtered count matches the selected collection",
        shown.includes(String(expected.total)),
        `${shown} vs ${expected.total}`,
      );
    }
    await page.unroute("**/api/v1/inventory*");
  });

  await failOnThrow("collection failure and retry", async () => {
    let forced = false;
    await page.route("**/api/v1/inventory*", async (route) => {
      if (!forced) {
        forced = true;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "unavailable", message: "Collection temporarily unavailable." },
          }),
        });
        return;
      }
      await route.continue();
    });
    await page.goto("/play/collection");
    await page.getByRole("heading", { name: /your drawers/i }).waitFor();
    await page.locator('[data-hydrated="true"]').waitFor();
    expectingFailure = true;
    await page.getByRole("button", { name: "Apply" }).click();
    await page.getByRole("alert").waitFor({ timeout: 15000 });
    check(
      "collection failure is visible, not an empty state",
      (await page.getByRole("alert").innerText()).includes("unavailable"),
    );
    await page.unroute("**/api/v1/inventory*");
    expectingFailure = false;
    await page.getByRole("button", { name: /try again/i }).click();
    await page.waitForTimeout(800);
    check("collection retry recovers the view", (await page.getByRole("alert").count()) === 0);
  });

  await failOnThrow("server-rendered collection filters work without JavaScript", async () => {
    const noJs = await browser.newContext({
      baseURL,
      viewport: { width: 1280, height: 900 },
      javaScriptEnabled: false,
    });
    await login(noJs);
    const bare = await noJs.newPage();
    await bare.goto("/play/collection");
    await bare.getByLabel("Search your collection").fill("zzzz-no-such-card");
    await Promise.all([
      bare.waitForNavigation(),
      bare.getByRole("button", { name: "Apply" }).click(),
    ]);
    check(
      "no-JS search returns a filtered server render",
      (await bare.getByText(/no cards match this view/i).count()) > 0,
    );
    check("no-JS filter URL is shareable", bare.url().includes("search=zzzz-no-such-card"));
    await noJs.close();
  });

  await failOnThrow("draw preview failure and retry", async () => {
    let forced = false;
    await page.route("**/api/v1/pools/*", async (route) => {
      if (!forced) {
        forced = true;
        await route.fulfill({
          status: 502,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "preview_unavailable", message: "Capsule preview is unavailable." },
          }),
        });
        return;
      }
      await route.continue();
    });
    expectingFailure = true;
    await page.goto("/play/draw");
    await page.getByRole("alert").waitFor();
    check(
      "draw failure is explicit",
      (await page.getByRole("alert").innerText()).includes("unavailable"),
    );
    await page.getByRole("button", { name: /retry this capsule preview/i }).click();
    await page.getByRole("heading", { name: /know the odds/i }).waitFor();
    check(
      "draw preview retry recovers",
      (await page.getByRole("heading", { name: /know the odds/i }).count()) === 1,
    );
    await page.unroute("**/api/v1/pools/*");
    expectingFailure = false;
    const rows = await page.locator("table tbody tr").count();
    check("odds are shown before opening", rows > 0, `${rows} rows`);
  });

  await failOnThrow("card inspection and keyboard controls", async () => {
    const inventory = await (await owner.request.get("/api/v1/inventory?limit=1")).json();
    await page.goto(`/play/card/${inventory.items[0].id}`);
    await page.getByRole("button", { name: /view back/i }).waitFor();
    const inspector = await page.evaluate(() => {
      const stage = document.querySelector(".card-inspector__stage");
      const controls = document.querySelector(".card-inspector__controls");
      const rect = stage?.getBoundingClientRect();
      const controlsRect = controls?.getBoundingClientRect();
      return {
        ratio: rect ? rect.width / rect.height : null,
        stageBottom: rect?.bottom ?? null,
        controlsBottom: controlsRect?.bottom ?? null,
        viewport: innerHeight,
      };
    });
    check(
      "inspector keeps 5:7 geometry",
      Math.abs(inspector.ratio - 5 / 7) < 0.006,
      `ratio ${inspector.ratio.toFixed(4)}`,
    );
    check(
      "inspector controls stay in the initial desktop viewport",
      inspector.controlsBottom <= inspector.viewport,
      `controls ${Math.round(inspector.controlsBottom)} / ${inspector.viewport}`,
    );
    await page.getByRole("button", { name: /view back/i }).click();
    check(
      "inspector back face is exposed to assistive tech",
      (await page.locator(".card-inspector__back").getAttribute("aria-hidden")) === "false",
    );
    await page.getByRole("button", { name: /inspect in 3d/i }).click();
    check(
      "3D inspection becomes interactive",
      (await page.locator(".card-inspector__stage").getAttribute("data-mode")) === "interactive",
    );
    await page.keyboard.press("Escape");
    check(
      "Escape returns to the static front",
      (await page.locator(".card-inspector__stage").getAttribute("data-flipped")) === "false",
    );

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.getByRole("button", { name: /view back/i }).waitFor();
    const mobileInspector = await page.evaluate(() => {
      const controls = document.querySelector(".card-inspector__controls")?.getBoundingClientRect();
      return {
        controlsBottom: controls?.bottom ?? 9999,
        viewport: innerHeight,
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      };
    });
    check(
      "mobile inspector controls fit the initial viewport",
      mobileInspector.controlsBottom <= mobileInspector.viewport,
      `${Math.round(mobileInspector.controlsBottom)} / ${mobileInspector.viewport}`,
    );
    check("mobile inspector has no horizontal overflow", mobileInspector.overflow === false);
    await page.setViewportSize({ width: 1440, height: 1000 });
  });

  await failOnThrow("admin artwork preview and edit preview", async () => {
    await page.goto("/admin/catalogue");
    await page.getByRole("heading", { name: /definitions and editions/i }).waitFor();
    await page.getByRole("button", { name: "Artwork" }).first().click();
    await page.getByRole("dialog").waitFor();
    const subject = page.getByLabel("Subject asset");
    const options = await subject
      .locator("option")
      .evaluateAll((items) => items.map((item) => item.value).filter(Boolean));
    await subject.selectOption(options[0]);
    const preview = page.locator('[role="dialog"] .layered-card');
    await preview.waitFor();
    await preview
      .locator(".layered-card__subject")
      .evaluate((image) =>
        image instanceof HTMLImageElement ? image.decode().catch(() => undefined) : undefined,
      );
    await page.waitForTimeout(250);
    const previewGeo = await preview.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const image = el.querySelector(".layered-card__subject");
      return {
        ratio: rect.width / rect.height,
        loaded: image ? image.complete && image.naturalWidth > 0 : false,
      };
    });
    check("artwork editor shows the actual selected artwork", previewGeo.loaded);
    check("artwork editor preview keeps 5:7 geometry", Math.abs(previewGeo.ratio - 5 / 7) < 0.006);
    await page.getByLabel("Artwork zoom").fill("1.2");
    await page.waitForTimeout(300);
    const transform = await preview
      .locator(".layered-card__subject")
      .evaluate((el) => getComputedStyle(el).transform);
    check("artwork zoom applies non-destructively in preview", transform.includes("1.2"));
    await page.getByRole("button", { name: /reset placement/i }).click();
    await page.getByRole("button", { name: "Close" }).click();
    await page.getByRole("button", { name: "Edit" }).first().click();
    await page.getByRole("dialog").waitFor();
    const publishedArt = await page.locator('[role="dialog"] img[src*="/media/render/"]').count();
    check(
      "edit dialog shows current published artwork",
      publishedArt > 0,
      `${publishedArt} renders`,
    );
    await page.getByRole("button", { name: "Cancel" }).click();
  });

  await failOnThrow("permission boundaries", async () => {
    const player = await browser.newContext({ baseURL, viewport: { width: 1280, height: 900 } });
    await login(player, "player@foilbury.local");
    const playerPage = await player.newPage();
    await playerPage.goto("/admin");
    await playerPage.waitForLoadState("networkidle");
    const body = await playerPage.locator("body").innerText();
    check(
      "ordinary player cannot read Bot administration",
      !/definitions and editions|cabinet at a glance/i.test(body),
    );
    await playerPage.goto("/platform-admin");
    await playerPage.waitForLoadState("networkidle");
    check(
      "ordinary player cannot read Platform administration",
      !/the platform desk/i.test(await playerPage.locator("body").innerText()),
    );
    await player.close();
  });

  await failOnThrow("mobile journeys", async () => {
    const mobile = await browser.newContext({
      baseURL,
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      colorScheme: "dark",
    });
    await login(mobile);
    const phone = await mobile.newPage();
    watch(phone);
    await phone.goto("/play");
    await phone.getByRole("heading", { name: /your cabinet/i }).waitFor();
    check(
      "mobile play has no horizontal document overflow",
      await phone.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      ),
    );
    const firstCard = phone.locator(".published-card-shell").first();
    const flip = firstCard.getByRole("button", { name: /show .* back/i }).first();
    check("mobile flip control is visible and reachable", await flip.isVisible());
    await flip.click();
    await phone.waitForFunction(
      () => document.querySelectorAll('.published-card__back[data-hidden="false"]').length > 0,
      null,
      { timeout: 3000 },
    );
    check(
      "mobile flip changes the face",
      (await phone.locator('.published-card__back[data-hidden="false"]').count()) > 0,
    );
    await phone.goto("/play/collections");
    await phone.getByRole("heading", { name: /every world you can enter/i }).waitFor();
    check(
      "mobile worlds paginate rather than stacking every collection",
      (await phone.locator(".world-card").count()) <= 9,
    );
    check(
      "mobile worlds have no horizontal overflow",
      await phone.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      ),
    );
    await phone.goto("/play/collection");
    await phone.getByRole("heading", { name: /your drawers/i }).waitFor();
    check(
      "mobile collection has no horizontal overflow",
      await phone.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      ),
    );
    await mobile.close();
  });

  await failOnThrow("accessibility checks on repaired journeys", async () => {
    for (const [name, url] of [
      ["player home", "/play"],
      ["worlds", "/play/collections"],
      ["collection", "/play/collection"],
      ["draw room", "/play/draw"],
      ["achievements", "/play/achievements"],
      ["admin catalogue", "/admin/catalogue"],
    ]) {
      await page.goto(url);
      await page.waitForLoadState("networkidle");
      await audit(page, name);
    }
  });

  await failOnThrow("deliberate negative controls calibrate the detectors", async () => {
    await page.goto("/play");
    await page.getByRole("heading", { name: /your cabinet/i }).waitFor();
    await page.addStyleTag({
      content: ".published-card{aspect-ratio:auto !important;height:120px !important}",
    });
    const broken = await publishedGeometry(page);
    check(
      "negative control: broken card geometry is detected",
      broken.present && Math.abs(broken.ratio - 5 / 7) > 0.05,
      `ratio ${broken.ratio?.toFixed(3)}`,
    );
    await page.reload();
    await page.getByRole("heading", { name: /your cabinet/i }).waitFor();
    await page.addStyleTag({ content: ".card-toolbar{display:none !important}" });
    const hiddenControls = await page.evaluate(() => {
      const toolbar = document.querySelector(".card-toolbar");
      return toolbar ? getComputedStyle(toolbar).display : "missing";
    });
    check("negative control: hidden card controls are detected", hiddenControls === "none");
  });

  check("no uncaught page errors", pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 3)));
  check("no console errors", consoleErrors.length === 0, JSON.stringify(consoleErrors.slice(0, 3)));
  check(
    "no unexpected failed responses",
    failedRequests.length === 0,
    JSON.stringify(failedRequests.slice(0, 4)),
  );
} finally {
  await owner.close().catch(() => undefined);
  await browser.close();
}

const report = {
  generated_at: new Date().toISOString(),
  base_url: baseURL,
  checks: results,
  failures,
  console_errors: consoleErrors,
  page_errors: pageErrors,
  failed_requests: failedRequests,
};
fs.writeFileSync(path.join(evidenceDir, "report.json"), JSON.stringify(report, null, 2));
console.log(`\n${results.length - failures}/${results.length} checks passed`);
if (failures) process.exitCode = 1;
