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

/**
 * Bind the emitted production artifact to an exact source tree. A stale dist
 * directory, a replaced bundle or a missing build stamp is a hard failure.
 */
export function inspectBundle({ treeHash, sha, distDir = path.join(ROOT, "dist") }) {
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
  const files = [server, path.join(distDir, "server", "index.js")].filter((file) =>
    fs.existsSync(file),
  );
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
    secret_markers: 0,
  };
}
