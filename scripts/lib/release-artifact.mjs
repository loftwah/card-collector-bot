import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./local.mjs";
import { readJson, sha256File } from "./source-identity.mjs";

const SECRET_MARKERS = [
  "FB_BOOTSTRAP_TOKEN=",
  "DISCORD_BOT_TOKEN=",
  "RESEND_API_KEY=",
  "FAL_AI_API_KEY=",
  "CF_API_TOKEN=",
  "EMDASH_ENCRYPTION_KEY=",
];

function walkFiles(directory, base = directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(target, base));
    } else if (entry.isFile()) {
      files.push(path.relative(base, target).split(path.sep).join("/"));
    }
  }
  return files;
}

/**
 * The deployed set is more than entry.mjs: chunks and the client asset tree
 * are part of the release identity. Hash every file so a replaced chunk or a
 * stale asset cannot ride along with an unchanged entry bundle.
 */
export function artifactManifest(distDir = path.join(ROOT, "dist")) {
  const files = [];
  for (const subtree of ["server", "client"]) {
    const root = path.join(distDir, subtree);
    if (!fs.existsSync(root)) continue;
    for (const relative of walkFiles(root)) {
      const file = path.join(root, relative);
      const deployedPath = `${subtree}/${relative}`;
      if (deployedPath === "server/build-meta.json") continue;
      files.push({
        path: deployedPath,
        sha256: sha256File(file),
        bytes: fs.statSync(file).size,
      });
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  const digest = crypto.createHash("sha256");
  for (const file of files) digest.update(`${file.path}\0${file.sha256}\0${file.bytes}\n`);
  return { sha256: digest.digest("hex"), file_count: files.length, files };
}

export function verifyArtifactManifest(manifest, distDir = path.join(ROOT, "dist")) {
  if (!manifest || !Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error("build-meta.json has no complete deployed artifact manifest. Rebuild before releasing.");
  }
  const actual = artifactManifest(distDir);
  if (actual.sha256 !== manifest.sha256) {
    throw new Error(
      "The deployed module/asset set does not match build-meta.json. A module, chunk or asset was added, changed or removed after the build.",
    );
  }
  if (actual.file_count !== manifest.file_count) {
    throw new Error("The deployed artifact file count does not match build-meta.json.");
  }
  const expected = new Map(manifest.files.map((file) => [file.path, file]));
  for (const file of actual.files) {
    const recorded = expected.get(file.path);
    if (!recorded) {
      throw new Error(`Deployed artifact ${file.path} is not recorded in build-meta.json.`);
    }
    if (recorded.sha256 !== file.sha256 || recorded.bytes !== file.bytes) {
      throw new Error(`Deployed artifact ${file.path} changed after the build.`);
    }
  }
  return actual;
}

/**
 * Bind the emitted production artifact to an exact source tree. A stale dist
 * directory, a replaced bundle, a changed chunk/asset or a missing build stamp
 * is a hard failure.
 */
export function inspectBundle({
  treeHash,
  contentHash,
  sha,
  distDir = path.join(ROOT, "dist"),
}) {
  const server = path.join(distDir, "server", "entry.mjs");
  const metaFile = path.join(distDir, "server", "build-meta.json");
  if (!fs.existsSync(server)) throw new Error("No production server bundle exists. Run pnpm build.");
  if (!fs.existsSync(metaFile)) {
    throw new Error(
      "No build-meta.json exists. Build with pnpm build so the artifact is source-bound.",
    );
  }
  const leakedEnv = path.join(distDir, "server", ".dev.vars");
  if (fs.existsSync(leakedEnv)) {
    throw new Error("dist/server/.dev.vars is present. It must not be uploaded.");
  }
  const meta = readJson(metaFile);
  if (meta.source_tree_hash !== treeHash) {
    throw new Error(
      `The dist artifact was built from tree ${String(meta.source_tree_hash).slice(0, 12)}…, not ${treeHash.slice(0, 12)}…. Rebuild before releasing.`,
    );
  }
  if (contentHash && meta.source_content_hash !== contentHash) {
    throw new Error(
      `The dist artifact was built from working-tree content ${String(meta.source_content_hash).slice(0, 12)}…, not ${contentHash.slice(0, 12)}…. A reviewed file changed after the build.`,
    );
  }
  if (meta.source_sha !== sha) {
    throw new Error(
      `The dist artifact records source ${String(meta.source_sha).slice(0, 12)}…, not ${sha.slice(0, 12)}…. Rebuild before releasing.`,
    );
  }
  const actualBundleHash = sha256File(server);
  if (meta.bundle?.sha256 !== actualBundleHash) {
    throw new Error(
      "The emitted bundle hash does not match build-meta.json. The artifact was altered or replaced.",
    );
  }
  if (meta.bundle?.bytes !== fs.statSync(server).size) {
    throw new Error("The emitted bundle size does not match build-meta.json.");
  }
  const manifest = verifyArtifactManifest(meta.artifact, distDir);
  const files = actualModuleFiles(distDir);
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const marker of SECRET_MARKERS) {
      if (text.includes(marker)) {
        throw new Error(`Secret marker ${marker} appears in the production bundle.`);
      }
    }
  }
  return {
    server,
    bytes: fs.statSync(server).size,
    sha256: actualBundleHash,
    build: meta,
    artifact: manifest,
    secret_markers: 0,
  };
}

function actualModuleFiles(distDir) {
  const root = path.join(distDir, "server");
  return walkFiles(root)
    .filter((relative) => relative.endsWith(".mjs") || relative.endsWith(".js"))
    .map((relative) => path.join(root, relative));
}
