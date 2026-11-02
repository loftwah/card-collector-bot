#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { ROOT } from "./lib/local.mjs";

const localDb = execFileSync("find", [".wrangler/state/v3/d1", "-name", "*.sqlite", "-type", "f"], { cwd: ROOT, encoding: "utf8" })
  .split(/\r?\n/)
  .map((value) => value.trim())
  .find((file) => {
    try {
      return execFileSync("sqlite3", [file, "SELECT COUNT(*) FROM fb_tenants;"], { encoding: "utf8" }).trim() === "3";
    } catch {
      return false;
    }
  });
if (!localDb) throw new Error("Could not find the local Foilbury D1 database.");

const CABINET = "ten_mvyy304wagy8asnga8tg7r3f";
const tables = [
  ["fb_tenants", (line) => line.includes("cabinet")],
  ["fb_economy_settings", (line) => line.includes(CABINET)],
  ["fb_classes", () => true],
  ["fb_categories", () => true],
  ["fb_tags", () => true],
  ["fb_rarities", () => true],
  ["fb_materials", () => true],
  ["fb_effects", () => true],
  ["fb_assets", () => true],
  ["fb_recipes", () => true],
  ["fb_card_definitions", () => true],
  ["fb_card_tags", () => true],
  ["fb_artwork_editions", () => true],
  ["fb_variants", () => true],
  ["fb_sets", () => true],
  ["fb_set_memberships", () => true],
  ["fb_set_reward_rules", () => true],
  ["fb_pools", () => true],
  ["fb_pool_entries", () => true],
  ["fb_variant_renders", () => true],
  ["fb_catalogue_releases", () => true],
];

const inserts = [];
let rowCount = 0;
for (const [table, filter] of tables) {
  const dump = execFileSync("sqlite3", [localDb, `.dump ${table}`], { encoding: "utf8" });
  const lines = dump.split(/\r?\n/).filter((line) => line.startsWith("INSERT INTO ") && filter(line));
  rowCount += lines.length;
  inserts.push(...lines.map((line) => line.replace(/^INSERT INTO /, "INSERT OR IGNORE INTO ")));
}

const now = new Date().toISOString();
const ownerPassword = crypto.randomBytes(18).toString("base64url");
const salt = crypto.randomBytes(16);
const derived = crypto.pbkdf2Sync(ownerPassword, salt, 100_000, 32, "sha256");
const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const passwordHash = `pbkdf2_sha256$100000$${b64url(salt)}$${b64url(derived)}`;
const owner = {
  url: "https://foilbury.loftwah.com",
  createdAt: now,
  note: "Bootstrap production owner. Replace this password with the verified Discord/magic-link identity flow when provisioning Super Admin. Never commit this file.",
  email: "owner@foilbury.loftwah.com",
  password: ownerPassword,
  discordUserId: "707281352818425929",
  role: "Bot Owner for the Loftwah test installation; platform_admin=0",
};
fs.writeFileSync(path.join(ROOT, ".foilbury/production-owner.json"), `${JSON.stringify(owner, null, 2)}\n`, { mode: 0o600 });

const special = [
  `INSERT OR IGNORE INTO fb_users (id, email, display_name, password_hash, platform_admin, created_at) VALUES ('usr_prod_owner', 'owner@foilbury.loftwah.com', 'Dean', '${passwordHash}', 0, '${now}');`,
  `INSERT OR IGNORE INTO fb_memberships (tenant_id, user_id, role, created_at) VALUES ('${CABINET}', 'usr_prod_owner', 'owner', '${now}');`,
  `INSERT OR IGNORE INTO fb_wallets (tenant_id, user_id, balance, updated_at) VALUES ('${CABINET}', 'usr_prod_owner', 350, '${now}');`,
  `INSERT OR IGNORE INTO fb_ledger_entries (id, tenant_id, user_id, kind, amount, balance_after, reference_type, reference_id, description, idempotency_key, metadata_json, actor_type, actor_id, created_at) VALUES ('led_prod_welcome', '${CABINET}', 'usr_prod_owner', 'issue', 350, 350, 'welcome_reward', NULL, 'Starter cabinet grant', 'starter:${CABINET}:usr_prod_owner', '{"source":"production_bootstrap"}', 'system', 'bootstrap', '${now}');`,
  `INSERT OR IGNORE INTO fb_discord_identities (id, tenant_id, discord_user_id, user_id, username, global_name, linked_at, last_seen_at) VALUES ('dci_prod_owner', '${CABINET}', '707281352818425929', 'usr_prod_owner', 'loftwah', 'Dean', '${now}', '${now}');`,
  `INSERT OR IGNORE INTO fb_discord_installations (id, tenant_id, application_id, guild_id, guild_name, channel_allowlist_json, channel_key, game_enabled, website_enabled, api_enabled, public_catalogue_enabled, admin_gui_enabled, active, installed_by_discord_id, created_at, updated_at) VALUES ('dci_loftwah_test', '${CABINET}', '1566702936615026769', '997734945206313041', 'Loftwah', '["1566700752385081355"]', NULL, 1, 1, 1, 1, 1, 1, '707281352818425929', '${now}', '${now}');`,
  `INSERT OR IGNORE INTO fb_schema_meta (key, value) VALUES ('domain_schema_version', '1');`,
  `INSERT OR IGNORE INTO fb_schema_meta (key, value) VALUES ('bootstrap_complete', '1');`,
];

const sql = ["PRAGMA foreign_keys = OFF;", ...inserts, ...special, ""].join("\n");
const file = path.join(ROOT, ".foilbury/production-seed.sql");
fs.writeFileSync(file, sql, { mode: 0o600 });
fs.chmodSync(file, 0o600);
console.log(JSON.stringify({ localDb, file, rows: rowCount, owner: "owner@foilbury.loftwah.com", credentials: ".foilbury/production-owner.json" }, null, 2));
