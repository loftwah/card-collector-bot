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
import { spawn } from "node:child_process";
import { once } from "node:events";
import { ROOT } from "./lib/local.mjs";
import { sourceState, sha256File, workingTreeHash } from "./lib/source-identity.mjs";
import { artifactManifest } from "./lib/release-artifact.mjs";

const contentBefore = workingTreeHash();
const isolatedGroup = process.platform !== "win32";
const build = spawn("pnpm", ["exec", "astro", "build"], {
  cwd: ROOT,
  stdio: "inherit",
  detached: isolatedGroup,
});
function stopBuild() {
  // Astro can launch its own workers. Cancel the build group with the release.
  try {
    if (isolatedGroup && build.pid) process.kill(-build.pid, "SIGKILL");
    else build.kill("SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
process.once("SIGTERM", stopBuild);
process.once("SIGINT", stopBuild);
const [status] = await once(build, "close");
process.removeListener("SIGTERM", stopBuild);
process.removeListener("SIGINT", stopBuild);
if (status !== 0) process.exit(status ?? 1);

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
if (source.content_hash !== contentBefore) {
  console.error(
    "The tracked working-tree content changed during the production build. Refusing to stamp an artifact that does not match the reviewed source.",
  );
  process.exit(1);
}
const bundleHash = sha256File(server);
const artifact = artifactManifest();
const meta = {
  schema_version: 2,
  source_sha: source.sha,
  source_tree_hash: source.tree_hash,
  source_content_hash: source.content_hash,
  branch: source.branch,
  package_version: pkg.version,
  built_at: new Date().toISOString(),
  bundle: {
    file: "dist/server/entry.mjs",
    sha256: bundleHash,
    bytes: fs.statSync(server).size,
  },
  artifact,
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
    source_content_hash: meta.source_content_hash,
    bundle_sha256: meta.bundle.sha256,
    artifact_sha256: meta.artifact.sha256,
    artifact_files: meta.artifact.file_count,
    bytes: meta.bundle.bytes,
  }),
);
