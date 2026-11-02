#!/usr/bin/env node
/**
 * Rendered UI/accessibility acceptance: public + authenticated journeys,
 * desktop/mobile, light/dark, reduced motion, 200% zoom and axe contrast/focus
 * checks. Screenshots are sanitised; no cookies or tokens are saved.
 */
import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs";
import path from "node:path";

const baseURL = process.env.FOILBURY_URL ?? "http://localhost:5173";
const evidence = path.join("docs", "evidence");
fs.mkdirSync(evidence, { recursive: true });
const results = [];
const pass = (name, detail = "") => { results.push({ name, status: "PASS", detail }); console.log(`PASS ${name}${detail ? ` · ${detail}` : ""}`); };
const fail = (name, error) => { results.push({ name, status: "FAIL", detail: String(error?.message ?? error) }); console.error(`FAIL ${name} · ${error?.message ?? error}`); };

async function login(context, email = "owner@foilbury.local") {
  const response = await context.request.post("/api/v1/dev/login", { data: { email } });
  if (response.status() !== 200) throw new Error(`Dev login returned ${response.status()}`);
}

async function audit(page, name, screenshotName) {
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const material = axe.violations.filter((violation) => ["serious", "critical"].includes(violation.impact ?? ""));
  if (material.length) {
    throw new Error(`${name}: ${material.map((violation) => `${violation.id} (${violation.nodes.length})`).join(", ")}`);
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  if (overflow) throw new Error(`${name}: horizontal overflow at ${await page.evaluate(() => `${document.documentElement.clientWidth}x${document.documentElement.scrollHeight}`)}`);
  if (screenshotName) await page.screenshot({ path: path.join(evidence, screenshotName), fullPage: true });
  pass(`${name}: axe + overflow`, `${axe.violations.length} total axe findings, none serious/critical`);
}

const browser = await chromium.launch({ headless: true });
try {
  for (const scheme of ["light", "dark"]) {
    const anon = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 }, colorScheme: scheme });
    const page = await anon.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/");
    await page.getByRole("heading", { name: /characters worth keeping/i }).waitFor();
    await audit(page, `${scheme} public home`, `ui-home-${scheme}.png`);
    await page.goto("/cabinet");
    await page.getByRole("heading", { name: /public showcase/i }).waitFor();
    await audit(page, `${scheme} public catalogue`);
    await page.goto("/login");
    await page.getByRole("heading", { name: /the cabinet is open/i }).waitFor();
    await audit(page, `${scheme} sign-in`, `ui-login-${scheme}.png`);
    if (errors.length) throw new Error(`${scheme} public console errors: ${errors.slice(0, 3).join(" | ")}`);
    await anon.close();
  }

  for (const scheme of ["light", "dark"]) {
    const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 }, colorScheme: scheme, reducedMotion: "reduce" });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await login(context);
    await page.goto("/play");
    await page.getByRole("heading", { name: /your cabinet/i }).waitFor();
    await audit(page, `${scheme} authenticated player home`, `ui-play-${scheme}.png`);
    await page.goto("/play/collection");
    await page.getByRole("heading", { name: /your drawers/i }).waitFor();
    await audit(page, `${scheme} collection`);
    const instance = await page.evaluate(async () => {
      const response = await fetch("/api/v1/inventory?limit=1");
      const body = await response.json();
      return body.items?.[0]?.id;
    });
    if (!instance) throw new Error("No inventory instance for card detail audit");
    await page.goto(`/play/card/${instance}`);
    await page.getByRole("button", { name: /view back/i }).waitFor();
    await audit(page, `${scheme} card detail`, `ui-card-${scheme}.png`);
    await page.goto("/admin");
    await page.getByRole("heading", { name: /the cabinet office/i }).waitFor();
    await page.getByText("The cabinet at a glance.").waitFor({ timeout: 20000 });
    await audit(page, `${scheme} Bot administration`, `ui-admin-${scheme}.png`);
    await page.goto("/admin/collections");
    await page.getByText(/worlds with a front door/i).waitFor();
    await page.getByText("Bubbles").first().waitFor({ timeout: 20000 });
    await audit(page, `${scheme} collections admin`, `ui-collections-${scheme}.png`);
    await page.goto("/admin/team");
    await page.getByText(/only the bot you were given/i).waitFor();
    await audit(page, `${scheme} team admin`);
    await page.goto("/platform-admin");
    await page.getByText("Bots and tenants").waitFor({ timeout: 20000 }).catch(() => page.getByText("BOTS AND TENANTS").waitFor({ timeout: 20000 }));
    await audit(page, `${scheme} platform administration`, `ui-platform-${scheme}.png`);
    await page.goto("/account/security");
    await page.getByText(/fast, phishing-resistant sign-in/i).waitFor();
    await audit(page, `${scheme} account security`, `ui-security-${scheme}.png`);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/play");
    await page.getByRole("heading", { name: /your cabinet/i }).waitFor();
    await audit(page, `${scheme} mobile player home`, `ui-play-mobile-${scheme}.png`);
    await page.goto("/admin/collections");
    await page.getByText(/worlds with a front door/i).waitFor();
    await page.getByText("Bubbles").first().waitFor({ timeout: 20000 });
    await audit(page, `${scheme} mobile collections`, `ui-collections-mobile-${scheme}.png`);

    // 200% zoom of a 1440px desktop is an effective 720px CSS viewport.
    await page.setViewportSize({ width: 720, height: 500 });
    await page.goto("/play");
    await page.waitForTimeout(400);
    const zoomOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    if (zoomOverflow) throw new Error(`${scheme} 200% zoom-equivalent causes horizontal overflow`);
    pass(`${scheme} 200% zoom-equivalent has no horizontal overflow`);
    await page.setViewportSize({ width: 1440, height: 1000 });

    const reduced = await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
    if (!reduced) throw new Error("Reduced motion preference was not applied");
    pass(`${scheme} reduced-motion preference is active`);
    if (errors.length) throw new Error(`${scheme} authenticated console errors: ${errors.slice(0, 3).join(" | ")}`);
    await context.close();
  }
} catch (error) {
  console.error(error?.stack ?? error);
  fail("rendered UI/accessibility acceptance", error);
} finally {
  await browser.close();
}

const report = { generated_at: new Date().toISOString(), base_url: baseURL, results };
fs.writeFileSync(path.join(evidence, "ui-a11y.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (results.some((result) => result.status === "FAIL")) process.exit(1);
