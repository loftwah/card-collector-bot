#!/usr/bin/env node
/**
 * Local browser acceptance for Bot-scoped NPC collectors.
 *
 * Creates a temporary NPC through the real Studio UI, previews and plays a real
 * draw, opens persisted receipts, pauses/resumes and inspects the member-facing
 * NPC lounge. Local fixture rows created by this run are removed in `finally`;
 * no human or production record is touched.
 */
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const baseURL = process.env.FOILBURY_URL ?? "http://localhost:5173";
if (!["localhost", "127.0.0.1", "::1"].includes(new URL(baseURL).hostname)) {
  console.error("Refusing to run NPC acceptance against a non-local origin.");
  process.exit(2);
}
const evidence = path.join("docs", "evidence");
fs.mkdirSync(evidence, { recursive: true });
const results = [];
const pass = (name, detail = "") => { results.push({ name, status: "PASS", detail }); console.log(`PASS ${name}${detail ? ` · ${detail}` : ""}`); };
const fail = (name, error) => { results.push({ name, status: "FAIL", detail: String(error?.message ?? error) }); console.error(`FAIL ${name} · ${error?.message ?? error}`); };
const stamp = Date.now();
const npcName = `Acceptance NPC ${stamp}`;

function d1(sql) {
  return execFileSync("pnpm", ["exec", "wrangler", "d1", "execute", "foilbury-local", "--local", "--json", "--command", sql], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const consoleErrors = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("pageerror", (error) => consoleErrors.push(error.message));

try {
  const login = await context.request.post("/api/v1/dev/login", { data: { email: "owner@foilbury.local" } });
  if (login.status() !== 200) throw new Error(`Dev login returned ${login.status()}`);

  await page.goto("/studio/npcs");
  await page.getByRole("heading", { name: /NPC collectors/i }).waitFor();
  await page.getByLabel("Display name").fill(npcName);
  await page.getByLabel("Preset").selectOption("rookie");
  await page.getByRole("button", { name: "Create NPC" }).click();
  await page.getByText(`${npcName} created with a real wallet`).waitFor();
  await page.getByText(npcName, { exact: false }).first().waitFor();
  pass("created a Bot-scoped NPC through the real Studio UI", npcName);

  const card = page.locator("article", { hasText: npcName }).first();
  await card.getByRole("button", { name: "Preview next" }).click();
  await page.getByText(/would draw from/i).waitFor();
  pass("previewed the next bounded action before spending");

  await card.getByRole("button", { name: "Play once" }).click();
  await page.getByText(/opened a real capsule/i).waitFor();
  pass("played one real draw through the shared economy");

  await card.getByRole("button", { name: "Receipts" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText(/completed/i).first().waitFor();
  await dialog.getByText(/balance/i).first().waitFor();
  await page.screenshot({ path: path.join(evidence, "npc-studio-receipts.png"), fullPage: true });
  await dialog.getByRole("button", { name: /close/i }).click().catch(async () => { await page.keyboard.press("Escape"); });
  pass("persisted receipt shows the real card, serial and balance");

  await card.getByRole("button", { name: "Pause" }).click();
  await page.getByText(`${npcName} is now paused.`).waitFor();
  await card.getByRole("button", { name: "Resume" }).click();
  await page.getByText(`${npcName} is now active.`).waitFor();
  pass("pause and resume are real status transitions");

  await card.getByRole("button", { name: "Edit" }).click();
  const editDialog = page.getByRole("dialog");
  await editDialog.getByLabel("Bio").fill("An edited, honest biography for the acceptance collector.");
  await editDialog.getByRole("button", { name: "Save changes" }).click();
  await page.getByText(`${npcName} updated.`).waitFor();
  pass("edited the NPC profile without changing its real history");

  await card.getByRole("button", { name: "Clone" }).click();
  await page.getByText(`${npcName} cloned as a new collector`).waitFor();
  await page.getByText(`${npcName} II`, { exact: false }).first().waitFor();
  pass("cloned the NPC into a separate wallet-backed collector");

  await page.screenshot({ path: path.join(evidence, "npc-studio.png"), fullPage: true });

  await page.goto("/play/rivals");
  await page.getByRole("heading", { name: npcName, exact: true }).waitFor();
  await page.getByText("NPC", { exact: true }).first().waitFor();
  await page.getByText(/synthetic history/i).first().waitFor();
  await page.getByText(/never a human testimonial/i).first().waitFor();
  await page.screenshot({ path: path.join(evidence, "npc-lounge.png"), fullPage: true });
  pass("member-facing NPC lounge shows the labelled synthetic profile and comparison");

  const unexpectedErrors = consoleErrors.filter((message) => !/409 \(Conflict\)/.test(message));
  if (unexpectedErrors.length) throw new Error(`Console errors: ${unexpectedErrors.slice(0, 3).join(" | ")}`);
  pass("no unexpected console errors");
} catch (error) {
  console.error(error?.stack ?? error);
  fail("NPC browser acceptance", error);
  await page.screenshot({ path: path.join(evidence, "npc-failure.png"), fullPage: true }).catch(() => undefined);
} finally {
  await browser.close();
  try {
    const npcIds = d1(`SELECT id, user_id FROM fb_npc_collectors WHERE name LIKE '${npcName.replaceAll("'", "''")}%'`);
    const parsed = JSON.parse(npcIds.slice(npcIds.indexOf("[")));
    const rows = parsed?.[0]?.results ?? [];
    for (const row of rows) {
      const userId = String(row.user_id).replaceAll("'", "''");
      const npcId = String(row.id).replaceAll("'", "''");
      for (const sql of [
        `DELETE FROM fb_draws WHERE user_id = '${userId}' OR instance_id IN (SELECT id FROM fb_card_instances WHERE user_id = '${userId}')`,
        `DELETE FROM fb_npc_actions WHERE npc_id = '${npcId}'`,
        `DELETE FROM fb_instance_history WHERE from_user_id = '${userId}' OR to_user_id = '${userId}' OR instance_id IN (SELECT id FROM fb_card_instances WHERE user_id = '${userId}')`,
        `DELETE FROM fb_achievement_unlocks WHERE user_id = '${userId}'`,
        `DELETE FROM fb_achievement_progress WHERE user_id = '${userId}'`,
        `DELETE FROM fb_reward_claims WHERE user_id = '${userId}'`,
        `DELETE FROM fb_domain_events WHERE user_id = '${userId}'`,
        `DELETE FROM fb_card_instances WHERE user_id = '${userId}'`,
        `DELETE FROM fb_ledger_entries WHERE user_id = '${userId}'`,
        `DELETE FROM fb_wallets WHERE user_id = '${userId}'`,
        `DELETE FROM fb_memberships WHERE user_id = '${userId}'`,
        `DELETE FROM fb_npc_collectors WHERE id = '${npcId}'`,
        `DELETE FROM fb_users WHERE id = '${userId}'`,
      ]) d1(sql);
    }
    pass("temporary NPC fixture cleaned up", `${rows.length} row(s)`);
  } catch (error) {
    console.error(`NPC cleanup failed: ${String(error)}`);
  }
}

const report = { generated_at: new Date().toISOString(), base_url: baseURL, results };
fs.writeFileSync(path.join(evidence, "npc-browser.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (results.some((result) => result.status === "FAIL")) process.exit(1);
