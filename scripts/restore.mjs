#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const json = process.argv.includes("--json");
const backupEquals = process.argv.find((arg) => arg.startsWith("--backup="));
const backupIndex = process.argv.indexOf("--backup");
const backupArg = backupEquals?.split("=")[1] ?? (backupIndex >= 0 ? process.argv[backupIndex + 1] : undefined);
const backupsDir = path.join(root, ".foilbury/backups");
if (!fs.existsSync(backupsDir)) {
  console.error("restore failed: no backups directory. Run pnpm backup first.");
  process.exit(1);
}
const backupDir = backupArg
  ? path.resolve(root, backupArg)
  : path.join(backupsDir, fs.readdirSync(backupsDir).filter((name) => fs.statSync(path.join(backupsDir, name)).isDirectory()).sort().at(-1) ?? "");
if (!backupDir || !fs.existsSync(path.join(backupDir, "manifest.json"))) {
  console.error("restore failed: backup manifest not found.");
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(path.join(backupDir, "manifest.json"), "utf8"));
const target = path.join(root, ".foilbury/restore", new Date().toISOString().replace(/[:.]/g, "").replace("Z", "Z"));
if (fs.existsSync(target)) {
  console.error("restore failed: isolated target already exists; refusing to overwrite.");
  process.exit(1);
}
fs.mkdirSync(target, { recursive: true, mode: 0o700 });
const persist = path.join(target, "persist");
const emptyEnv = path.join(root, ".foilbury/empty.env");
fs.writeFileSync(emptyEnv, "# intentionally empty\n", { mode: 0o600 });

function hash(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}
function wrangler(args, cwd = target, allowFailure = false) {
  const result = spawnSync(path.join(root, "node_modules/.bin/wrangler"), [...args, "--env-file", emptyEnv], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false" },
  });
  if (result.status !== 0 && !allowFailure) throw new Error(`wrangler ${args.slice(0, 2).join(" ")} failed: ${(result.stderr || result.stdout).trim().slice(0, 600)}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

try {
  const schemaFile = path.join(backupDir, manifest.database.schemaFile);
  const dataFile = path.join(backupDir, manifest.database.dataFile);
  const triggersFile = path.join(backupDir, manifest.database.triggersFile);
  const schemaBuffer = fs.readFileSync(schemaFile);
  const dataBuffer = fs.readFileSync(dataFile);
  const triggersBuffer = fs.readFileSync(triggersFile);
  if (hash(schemaBuffer) !== manifest.database.schemaSha256) throw new Error("D1 schema backup checksum does not match the manifest");
  if (hash(dataBuffer) !== manifest.database.dataSha256) throw new Error("D1 data backup checksum does not match the manifest");
  if (hash(triggersBuffer) !== manifest.database.triggersSha256) throw new Error("D1 trigger backup checksum does not match the manifest");
  for (const asset of manifest.assets) {
    const file = path.join(backupDir, asset.relative_path);
    const bytes = fs.readFileSync(file);
    if (hash(bytes) !== asset.sha256) throw new Error(`Asset checksum mismatch: ${asset.id}`);
  }

  const config = {
    $schema: path.join(root, "node_modules/wrangler/config-schema.json"),
    name: "foilbury-restore",
    main: path.join(root, "tests/workers/worker.ts"),
    compatibility_date: "2026-11-01",
    compatibility_flags: ["nodejs_compat"],
    workers_dev: false,
    preview_urls: false,
    d1_databases: [{ binding: "DB", database_name: "foilbury-restore" }],
    r2_buckets: [{ binding: "MEDIA", bucket_name: "foilbury-restore-media" }],
    vars: { FOILBURY_ENV: "test", FOILBURY_LOCAL_MODE: "false", FOILBURY_PUBLIC_ORIGIN: "http://127.0.0.1:4321", FOILBURY_TENANT_SLUG: "cabinet" },
  };
  const configPath = path.join(target, "wrangler.restore.jsonc");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  fs.copyFileSync(schemaFile, path.join(target, "d1-schema.sql"));
  fs.copyFileSync(dataFile, path.join(target, "d1-data.sql"));
  fs.copyFileSync(triggersFile, path.join(target, "triggers.sql"));
  wrangler(["d1", "execute", "DB", "--local", "--file", path.join(target, "d1-schema.sql"), "--config", configPath, "--persist-to", persist, "--yes"]);
  const dropTriggers = manifest.database.triggers.map((name) => `DROP TRIGGER IF EXISTS "${name}";`).join("\n");
  fs.writeFileSync(path.join(target, "drop-triggers.sql"), dropTriggers + "\n", { mode: 0o600 });
  wrangler(["d1", "execute", "DB", "--local", "--file", path.join(target, "drop-triggers.sql"), "--config", configPath, "--persist-to", persist, "--yes"]);
  wrangler(["d1", "execute", "DB", "--local", "--file", path.join(target, "d1-data.sql"), "--config", configPath, "--persist-to", persist, "--yes"]);
  wrangler(["d1", "execute", "DB", "--local", "--file", path.join(target, "triggers.sql"), "--config", configPath, "--persist-to", persist, "--yes"]);
  for (const asset of manifest.assets) {
    wrangler(["r2", "object", "put", `foilbury-restore-media/${asset.r2_key}`, "--local", "--file", path.join(backupDir, asset.relative_path), "--config", configPath, "--persist-to", persist, "--content-type", asset.mime, "--force"]);
  }
  const countQuery = "SELECT (SELECT COUNT(*) FROM fb_tenants) AS tenants, (SELECT COUNT(*) FROM fb_card_definitions WHERE tenant_id = (SELECT id FROM fb_tenants WHERE slug = 'cabinet')) AS cards, (SELECT COUNT(*) FROM fb_card_instances WHERE tenant_id = (SELECT id FROM fb_tenants WHERE slug = 'cabinet')) AS instances, (SELECT COUNT(*) FROM fb_ledger_entries WHERE tenant_id = (SELECT id FROM fb_tenants WHERE slug = 'cabinet')) AS ledger, (SELECT COALESCE(SUM(balance),0) FROM fb_wallets WHERE tenant_id = (SELECT id FROM fb_tenants WHERE slug = 'cabinet')) AS wallet_total, (SELECT COUNT(*) FROM fb_assets WHERE tenant_id = (SELECT id FROM fb_tenants WHERE slug = 'cabinet')) AS assets";
  const raw = wrangler(["d1", "execute", "DB", "--local", "--command", countQuery, "--config", configPath, "--persist-to", persist, "--json"]);
  const parsed = JSON.parse(raw.stdout);
  const row = parsed[0]?.results?.[0] ?? {};
  const expected = manifest.library.counts;
  if (Number(row.cards) !== expected.cards) throw new Error(`Restored card count ${row.cards} != ${expected.cards}`);
  if (Number(row.instances) !== expected.instances) throw new Error(`Restored instance count ${row.instances} != ${expected.instances}`);
  if (Number(row.ledger) !== expected.ledger) throw new Error(`Restored ledger count ${row.ledger} != ${expected.ledger}`);
  if (Number(row.wallet_total) !== manifest.library.walletTotal) throw new Error(`Restored wallet total ${row.wallet_total} != ${manifest.library.walletTotal}`);
  if (Number(row.assets) !== expected.assets) throw new Error(`Restored asset count ${row.assets} != ${expected.assets}`);

  let verifiedAssets = 0;
  for (const asset of manifest.assets) {
    const destination = path.join(target, "verify", `${asset.id}.${asset.mime === "image/png" ? "png" : asset.mime === "image/webp" ? "webp" : "bin"}`);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    wrangler(["r2", "object", "get", `foilbury-restore-media/${asset.r2_key}`, "--local", "--file", destination, "--config", configPath, "--persist-to", persist]);
    if (hash(fs.readFileSync(destination)) !== asset.sha256) throw new Error(`Restored asset bytes mismatch: ${asset.id}`);
    verifiedAssets++;
  }
  const report = {
    ok: true,
    restoredAt: new Date().toISOString(),
    target: path.relative(root, target),
    backup: path.relative(root, backupDir),
    checks: { databaseChecksum: "matched", assetsChecksummed: verifiedAssets, counts: row, expectedCounts: expected, walletTotal: manifest.library.walletTotal, release: manifest.library.release?.version ?? null, sourceCommits: manifest.sourceCommits },
    note: "Isolated local target. No remote D1/R2 binding, no deployment and no secrets were restored.",
  };
  fs.writeFileSync(path.join(target, "restore-report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`Restore verified in ${report.target}`);
    console.log(`  cards ${row.cards}, instances ${row.instances}, ledger ${row.ledger}, wallets total ${row.wallet_total}`);
    console.log(`  assets ${verifiedAssets} checksummed`);
    console.log("  isolated target · no remote binding · no secrets restored");
  }
} catch (error) {
  console.error(`restore failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
