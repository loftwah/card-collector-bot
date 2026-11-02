#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { apiJson, agentToken, ensureServer, BASE_URL } from "./lib/api.mjs";

const root = process.cwd();
const json = process.argv.includes("--json");
const stamp = new Date().toISOString().replace(/[:.]/g, "").replace("Z", "Z");
const dir = path.join(root, ".foilbury/backups", stamp);
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
fs.chmodSync(dir, 0o700);
const emptyEnv = path.join(root, ".foilbury/empty.env");
fs.writeFileSync(emptyEnv, "# intentionally empty; prevents unrelated dotenv loading\n", { mode: 0o600 });

function wrangler(args, options = {}) {
  const result = spawnSync(path.join(root, "node_modules/.bin/wrangler"), [...args, "--env-file", emptyEnv], {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    env: { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false" },
  });
  if (result.status !== 0) throw new Error(`wrangler ${args.slice(0, 2).join(" ")} failed: ${(result.stderr || result.stdout).trim().slice(0, 500)}`);
  return result.stdout;
}
function hash(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}
function writeSecret(file, data) {
  fs.writeFileSync(file, data, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

try {
  await ensureServer();
  const manifestInfo = await apiJson("/api/v1/admin/backup/manifest");
  const assets = await apiJson("/api/v1/admin/assets");
  const tableJson = JSON.parse(wrangler(["d1", "execute", "DB", "--local", "--command", "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name", "--json"]));
  const tables = (tableJson[0]?.results ?? []).map((row) => row.name).filter((name) => name.startsWith("fb_"));
  const tableArgs = tables.flatMap((table) => ["--table", table]);
  const schemaFile = path.join(dir, "d1-schema.sql");
  const dataFile = path.join(dir, "d1-data.sql");
  wrangler(["d1", "export", "DB", "--local", "--output", schemaFile, "--no-data", "--skip-confirmation", ...tableArgs]);
  wrangler(["d1", "export", "DB", "--local", "--output", dataFile, "--no-schema", "--skip-confirmation", ...tableArgs]);
  const triggerJson = JSON.parse(wrangler(["d1", "execute", "DB", "--local", "--command", "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND sql IS NOT NULL AND tbl_name LIKE 'fb_%' ORDER BY name", "--json"]));
  const triggers = (triggerJson[0]?.results ?? []).map((row) => ({ name: row.name, sql: `${row.sql};` }));
  const triggersFile = path.join(dir, "triggers.sql");
  writeSecret(triggersFile, triggers.map((trigger) => trigger.sql).join("\n\n") + "\n");
  const schemaBuffer = fs.readFileSync(schemaFile);
  const dataBuffer = fs.readFileSync(dataFile);
  const triggersBuffer = fs.readFileSync(triggersFile);
  const assetDir = path.join(dir, "assets");
  fs.mkdirSync(assetDir, { recursive: true, mode: 0o700 });
  const files = [];
  for (const asset of assets.items) {
    const response = await fetch(`${BASE_URL}/api/v1/admin/assets/${asset.id}/bytes`, { headers: { authorization: `Bearer ${agentToken("owner")}` } });
    if (!response.ok) throw new Error(`Could not back up asset ${asset.id}: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const digest = hash(bytes);
    if (asset.sha256 && digest !== asset.sha256) throw new Error(`Asset checksum mismatch for ${asset.id}`);
    const ext = asset.mime === "image/png" ? "png" : asset.mime === "image/webp" ? "webp" : asset.mime === "image/jpeg" ? "jpg" : "bin";
    const file = path.join(assetDir, `${asset.id}.${ext}`);
    writeSecret(file, bytes);
    files.push({ id: asset.id, kind: asset.kind, name: asset.name, mime: asset.mime, width: asset.width, height: asset.height, bytes: bytes.length, sha256: digest, r2_key: asset.r2_key, visibility: asset.visibility, source_repo: asset.source_repo, source_path: asset.source_path, source_commit: asset.source_commit, relative_path: path.relative(dir, file) });
  }
  let sourceCommits = null;
  const discoveryFile = path.join(root, ".foilbury/sources/discovered.json");
  if (fs.existsSync(discoveryFile)) {
    const discovery = JSON.parse(fs.readFileSync(discoveryFile, "utf8"));
    sourceCommits = Object.fromEntries(Object.entries(discovery.sources ?? {}).map(([name, source]) => [name, source.commit]));
  }
  const manifest = {
    format: "foilbury-local-backup",
    version: 1,
    createdAt: new Date().toISOString(),
    testedRevision: spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim(),
    workingTree: spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).stdout.trim() ? "dirty" : "clean",
    database: { schemaFile: "d1-schema.sql", schemaSha256: hash(schemaBuffer), schemaBytes: schemaBuffer.length, dataFile: "d1-data.sql", dataSha256: hash(dataBuffer), dataBytes: dataBuffer.length, triggersFile: "triggers.sql", triggersSha256: hash(triggersBuffer), triggers: triggers.map((trigger) => trigger.name), tables, scope: "Foilbury domain tables only", note: "D1 cannot export FTS5 virtual tables. EmDash editorial tables are excluded from this domain backup; use an EmDash site export for the CMS. Domain data is imported with triggers dropped, then the recorded triggers are restored." },
    library: manifestInfo,
    sourceCommits,
    assets: files,
    exclusions: [".env", ".dev.vars", ".foilbury/local-credentials.json", ".foilbury/agents.json", "provider secrets"],
  };
  writeSecret(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const result = { ok: true, directory: path.relative(root, dir), databaseBytes: schemaBuffer.length + dataBuffer.length, assets: files.length, assetBytes: files.reduce((sum, file) => sum + file.bytes, 0), counts: manifestInfo.counts, release: manifestInfo.release?.version ?? null };
  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Backup written to ${path.relative(root, dir)}`);
    console.log(`  database: schema ${schemaBuffer.length} bytes + data ${dataBuffer.length} bytes, sha256 ${manifest.database.dataSha256.slice(0, 16)}…`);
    console.log(`  assets:   ${files.length} files, ${result.assetBytes} bytes`);
    console.log(`  library:  ${manifestInfo.counts.cards} cards, ${manifestInfo.counts.instances} instances, ${manifestInfo.counts.ledger} ledger entries`);
    console.log("  secrets:  excluded by design");
  }
} catch (error) {
  console.error(`backup failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
