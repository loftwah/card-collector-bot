#!/usr/bin/env node
// Read-only UI journey against a separately seeded, disposable CI Worker.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

assert.equal(process.env.CI, "true", "Use an isolated synthetic CI Worker");
const base = process.env.FOILBURY_URL ?? "http://127.0.0.1:5173";
const target = new URL(base);
assert.ok(
  target.protocol === "http:" &&
    ["127.0.0.1", "localhost"].includes(target.hostname) &&
    !target.username &&
    !target.password &&
    target.pathname === "/" &&
    !target.search &&
    !target.hash,
);
const preflight = await fetch(new URL("/api/v1/status", target), {
  redirect: "error",
  signal: AbortSignal.timeout(10000),
});
assert.equal(preflight.status, 200);
const status = await preflight.json();
assert.ok(
  status.name === "Foilbury" &&
    status.environment === "local" &&
    status.local === true &&
    status.dev_login === true &&
    status.configured === true &&
    status.email === "outbox_only" &&
    status.discord === "disabled" &&
    status.access === "not_configured",
);
const providers = [
  "fal",
  "elevenlabs",
  "resend",
  "adminWebhook",
  "discordApplication",
  "discordBot",
  "discordOAuth",
  "cloudflareAccess",
];
assert.ok(
  status.providers &&
    providers.every((key) => status.providers[key] === false) &&
    Object.values(status.providers).every((value) => value === false),
);
const evidence = fs.mkdtempSync(
  path.join(
    fs.mkdirSync(".foilbury/tmp", { recursive: true }) || ".foilbury/tmp",
    "api-dispatch-journey-",
  ),
);
const browser = await chromium.launch();
try {
  for (const [label, email] of [
    ["proposer", "owner@foilbury.local"],
    ["recipient", "player@foilbury.local"],
  ]) {
    const context = await browser.newContext({
      baseURL: base,
      viewport: { width: 390, height: 844 },
      reducedMotion: "reduce",
    });
    try {
      assert.equal(
        (await context.request.post("/api/v1/dev/login", { data: { email } })).status(),
        200,
      );
      const listResponse = await context.request.get("/api/v1/trades");
      assert.equal(listResponse.status(), 200);
      const list = await listResponse.json();
      assert.equal(list.items.length, 1, "fixture must have exactly one synthetic trade");
      const id = list.items[0].id;
      const detailResponse = await context.request.get(`/api/v1/trades/${id}`);
      assert.equal(detailResponse.status(), 200);
      const detail = await detailResponse.json();
      assert.equal(detail.id, id);
      assert.equal(detail.items.length, 2, "fixture must contain one card on each side");
      const proposerItem = detail.items.find((row) => row.side === "proposer");
      const recipientItem = detail.items.find((row) => row.side === "recipient");
      assert.ok(
        proposerItem &&
          recipientItem &&
          typeof proposerItem.serial === "string" &&
          typeof recipientItem.serial === "string",
      );
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("/play/trades");
      await page.getByRole("button", { name: "View", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      for (const [item, expectedSide] of [
        [proposerItem, label === "proposer" ? "You offer" : "They offer"],
        [recipientItem, label === "recipient" ? "You offer" : "They offer"],
      ]) {
        const side = dialog
          .locator(".label")
          .filter({ hasText: expectedSide })
          .first()
          .locator("..");
        assert.equal(
          await side.getByText(item.serial, { exact: true }).count(),
          1,
          `${label}: ${item.side} card must appear under ${expectedSide}`,
        );
      }
      await page.screenshot({ path: path.join(evidence, `${label}-trade.png`) });
      assert.deepEqual(errors, []);
      if (label === "recipient") {
        const [sent, received] = await Promise.all([
          context.request.get("/api/v1/gifts"),
          context.request.get("/api/v1/gifts/received"),
        ]);
        assert.equal(sent.status(), 200);
        assert.equal(received.status(), 200);
        const sentBody = await sent.json(),
          receivedBody = await received.json();
        assert.equal(
          sentBody.items.some((row) => row.id === "award_dispatch_fixture"),
          false,
        );
        assert.equal(
          receivedBody.items.filter((row) => row.id === "award_dispatch_fixture").length,
          1,
        );
        await page.goto("/play/gifts");
        assert.equal(
          await page.getByRole("heading", { name: "Synthetic dispatch gift" }).count(),
          1,
        );
        await page.screenshot({ path: path.join(evidence, "recipient-gifts.png") });
      }
      console.log(
        `PASS ${label}: actual HTTP and trade detail${label === "recipient" ? ", received gift page" : ""}`,
      );
    } finally {
      await context.close();
    }
  }
  console.log(`Evidence: ${evidence}`);
} finally {
  await browser.close();
}
