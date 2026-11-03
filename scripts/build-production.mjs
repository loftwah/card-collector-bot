#!/usr/bin/env node
/**
 * Production build with a source-to-artifact binding.
 *
 * `dist/server/entry.mjs` alone cannot prove which source produced it. This
 * wrapper records the exact git content tree, emitted bundle hash, package
 * version and local migration set beside the artifact. The release check
 * refuses an artifact whose stamp does not match the reviewed tree.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT } from "./lib/local.mjs";
import { sourceState, sha256File } from "./lib/source-identity.mjs";

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("pnpm", ["exec", "astro", "check"]);
run("pnpm", ["exec", "astro", "build"]);

const server = path.join(ROOT, "dist", "server", "entry.mjs");
if (!fs.existsSync(server)) {
  console.error("The build completed without dist/server/entry.mjs.");
  process.exit(1);
}
const leaked = path.join(ROOT, "dist", "server", ".dev.vars");
if (fs.existsSync(leaked)) fs.rmSync(leaked, { force: true });

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const migrations = fs
  .readdirSync(path.join(ROOT, "migrations"))
  .filter((name) => name.endsWith(".sql"))
  .sort();
const source = sourceState();
const bundleHash = sha256File(server);
const meta = {
  schema_version: 1,
  source_sha: source.sha,
  source_tree_hash: source.tree_hash,
  branch: source.branch,
  package_version: pkg.version,
  built_at: new Date().toISOString(),
  bundle: {
    file: "dist/server/entry.mjs",
    sha256: bundleHash,
    bytes: fs.statSync(server).size,
  },
  migrations,
  build_nonce: crypto.randomUUID(),
};
fs.writeFileSync(
  path.join(ROOT, "dist", "server", "build-meta.json"),
  `${JSON.stringify(meta, null, 2)}\n`,
);
console.log(
  JSON.stringify({
    event: "production_build",
    source_sha: meta.source_sha,
    source_tree_hash: meta.source_tree_hash,
    bundle_sha256: meta.bundle.sha256,
    bytes: meta.bundle.bytes,
  }),
);
