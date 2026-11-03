import crypto from "node:crypto";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { ROOT } from "./local.mjs";

/** Files whose contents describe or record a release rather than define it. */
export const RELEASE_METADATA_FILES = new Set([
  "docs/release-acceptance.json",
  "docs/acceptance-report.json",
]);

/** Screenshots/logs are evidence output, not source that changes behaviour. */
export function isReleaseMetadataPath(file) {
  return RELEASE_METADATA_FILES.has(file) || file.startsWith("docs/evidence/");
}

export function capture(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

/**
 * Content identity for the exact reviewed source tree. The acceptance
 * manifest itself is excluded so a manifest can describe the tree that
 * contains it without a circular hash.
 */
export function sourceTreeHash() {
  const listing = execFileSync("git", ["ls-files", "-s", "-z"], {
    cwd: ROOT,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const entries = listing
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const [meta, file] = line.split("\t");
      const [, blob] = meta.split(/\s+/);
      return { file, blob };
    })
    .filter((entry) => !isReleaseMetadataPath(entry.file))
    .sort((left, right) => left.file.localeCompare(right.file));
  const hash = crypto.createHash("sha256");
  for (const entry of entries) hash.update(`${entry.file}\0${entry.blob}\n`);
  return hash.digest("hex");
}

export function sourceState() {
  const sha = capture("git", ["rev-parse", "HEAD"]);
  const branch = capture("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  const dirty = capture("git", ["status", "--porcelain"]);
  let ahead = null;
  let behind = null;
  let originMain = null;
  try {
    originMain = capture("git", ["rev-parse", "origin/main"]);
    ahead = Number(capture("git", ["rev-list", "--count", "origin/main..HEAD"]));
    behind = Number(capture("git", ["rev-list", "--count", "HEAD..origin/main"]));
  } catch {
    ahead = null;
    behind = null;
  }
  return {
    sha,
    branch,
    dirty,
    origin_main: originMain,
    ahead,
    behind,
    tree_hash: sourceTreeHash(),
  };
}

export function sha256File(file) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
