#!/usr/bin/env node
/**
 * Assisted Discord acceptance runner.
 *
 * It prepares a bounded, read-only verification session, prints the exact human
 * actions, then correlates real incoming interactions with durable receipts.
 * It does not impersonate a user, self-bot, harvest tokens or post messages.
 *
 *   node scripts/discord/assisted-acceptance.mjs --prepare
 *   node scripts/discord/assisted-acceptance.mjs --verify <interaction-id>
 *   node scripts/discord/assisted-acceptance.mjs --watch --minutes 10
 *   node scripts/discord/assisted-acceptance.mjs --spectator <evidence.json>
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT } from "../lib/local.mjs";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const local = args.includes("--local");
const prepare = args.includes("--prepare");
const watch = args.includes("--watch");
const minutes = Number(option("--minutes") ?? 10);
const verifyId = option("--verify");
const spectatorFile = option("--spectator");
const outputDir = path.join(ROOT, ".foilbury/evidence/discord-assisted");
fs.mkdirSync(outputDir, { recursive: true });
const startedAt = new Date().toISOString();

function findLocalDatabase() {
  const base = path.join(ROOT, ".wrangler/state/v3/d1");
  for (const entry of fs.readdirSync(base, { recursive: true })) {
    const file = path.join(base, String(entry));
    if (!file.endsWith(".sqlite") || file.endsWith("metadata.sqlite")) continue;
    try {
      const tables = execFileSync(
        "sqlite3",
        [file, "SELECT name FROM sqlite_master WHERE type='table' AND name='fb_discord_interactions';"],
        { encoding: "utf8" },
      ).trim();
      if (tables) return file;
    } catch {}
  }
  return null;
}

function rows(sql) {
  if (local) {
    const file = findLocalDatabase();
    if (!file) throw new Error("Local D1 database not found. Run pnpm setup:local.");
    const output = execFileSync("sqlite3", ["-json", file, sql], { encoding: "utf8" }).trim();
    return output ? JSON.parse(output) : [];
  }
  const output = execFileSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "execute",
      "foilbury",
      "--config",
      "wrangler.production.jsonc",
      "--remote",
      "--json",
      "--command",
      sql,
    ],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  const parsed = JSON.parse(output.slice(output.indexOf("[")));
  return Array.isArray(parsed) ? (parsed[0]?.results ?? []) : (parsed.results ?? []);
}

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function verify(interactionId) {
  const interaction = rows(
    `SELECT interaction_id, command_name, status, error_code, receipt_kind, receipt_json,
            delivery_visibility, created_at, completed_at
       FROM fb_discord_interactions WHERE interaction_id = '${interactionId.replaceAll("'", "''")}'`,
  )[0];
  if (!interaction) return { interaction_id: interactionId, result: "not_found" };
  const receipt = safeJson(interaction.receipt_json);
  let draw = null;
  let instance = null;
  let ledger = [];
  if (receipt?.draw_id) {
    draw = rows(
      `SELECT id, price, variant_id, instance_id, created_at FROM fb_draws WHERE id = '${String(receipt.draw_id).replaceAll("'", "''")}'`,
    )[0] ?? null;
    if (receipt.instance_id) {
      instance = rows(
        `SELECT id, serial, status, acquired_via FROM fb_card_instances WHERE id = '${String(receipt.instance_id).replaceAll("'", "''")}'`,
      )[0] ?? null;
    }
    if (instance?.id) {
      ledger = rows(
        `SELECT kind, amount, description, idempotency_key FROM fb_ledger_entries
          WHERE reference_id = '${String(receipt.draw_id).replaceAll("'", "''")}'
             OR description LIKE '%draw%' LIMIT 10`,
      );
    }
  }
  const checks = {
    acknowledged_privately: interaction.delivery_visibility === "private" || interaction.delivery_visibility === "private_fallback",
    terminal: ["completed", "failed"].includes(interaction.status),
    committed_receipt: Boolean(receipt),
    draw_matches_receipt: !receipt?.draw_id || draw?.id === receipt.draw_id,
    instance_matches_receipt: !receipt?.instance_id || instance?.id === receipt.instance_id,
    no_delivery_error: !["delivery_failed", "public_delivery_failed"].includes(interaction.error_code ?? ""),
  };
  return {
    interaction_id: interactionId,
    command: interaction.command_name,
    status: interaction.status,
    error_code: interaction.error_code,
    delivery_visibility: interaction.delivery_visibility,
    receipt,
    draw,
    instance,
    ledger,
    checks,
    result: Object.values(checks).every(Boolean) ? "pass" : "partial",
  };
}

function write(report) {
  const file = path.join(outputDir, `session-${startedAt.replaceAll(":", "-")}.json`);
  fs.writeFileSync(file, `${JSON.stringify({ generated_at: new Date().toISOString(), mode: local ? "local" : "production", started_at: startedAt, ...report }, null, 2)}\n`);
  console.log(`Evidence written to ${path.relative(ROOT, file)}`);
  return file;
}

if (prepare) {
  const instructions = [
    "In the authorised #card-collector-test channel, as the genuine signed-in account:",
    "1. /foilbury help — confirm the welcome and command guide; it must be private.",
    "2. /foilbury daily — claim once; record the interaction id from the assisted watcher.",
    "3. /foilbury packs — confirm real eligible capsules and prices.",
    "4. /foilbury open — confirm a private reveal, saved front/back, serial and settled balance.",
    "5. Press Share to channel only if the card is public-safe; confirm what posts before pressing.",
    "6. /foilbury collection — confirm the same serial and balance on the website wallet.",
    "7. /foilbury missions — complete one legitimate action, claim it on the web, then try the same claim in Discord; no second reward.",
    "8. Ask an independent authorised spectator to report what they can and cannot see.",
    "Never paste an interaction token, cookie, password or private message content into evidence.",
  ];
  console.log(`Assisted Discord acceptance · ${local ? "local" : "production"}\n`);
  instructions.forEach((line) => console.log(line));
  write({ phase: "prepare", instructions, performed: false });
  process.exit(0);
}

if (verifyId) {
  const report = verify(verifyId);
  console.log(JSON.stringify(report, null, 2));
  write({ phase: "verify", performed: true, report });
  process.exit(report.result === "pass" ? 0 : 2);
}

if (spectatorFile) {
  const evidence = JSON.parse(fs.readFileSync(spectatorFile, "utf8"));
  const valid =
    evidence.independent_identity === true &&
    evidence.observed_message_id &&
    evidence.actor_id &&
    evidence.observed_at;
  const report = { phase: "spectator", performed: Boolean(valid), evidence };
  console.log(JSON.stringify(report, null, 2));
  write(report);
  process.exit(valid ? 0 : 2);
}

if (watch) {
  const cutoff = new Date(Date.now() - minutes * 60_000).toISOString();
  const timeout = Date.now() + minutes * 60_000;
  const seen = new Set();
  const verified = [];
  while (Date.now() < timeout) {
    const interactions = rows(
      `SELECT interaction_id FROM fb_discord_interactions
        WHERE created_at >= '${cutoff}' ORDER BY created_at ASC`,
    );
    for (const row of interactions) {
      if (seen.has(row.interaction_id)) continue;
      seen.add(row.interaction_id);
      const report = verify(row.interaction_id);
      verified.push(report);
      console.log(`${report.result.toUpperCase()} ${report.command} · ${report.status} · ${report.delivery_visibility ?? "unknown"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  write({ phase: "watch", performed: verified.length > 0, verified });
  process.exit(verified.length && verified.every((item) => item.result === "pass") ? 0 : 2);
}

console.error("Use --prepare, --verify <id>, --watch or --spectator <file>.");
process.exit(1);
