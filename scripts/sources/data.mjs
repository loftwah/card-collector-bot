import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { curated, backgrounds, sources } from "./curated.mjs";

export function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

export function discoverSources() {
  const sourceState = {};
  for (const [name, source] of Object.entries(sources)) {
    if (!fs.existsSync(source.root)) throw new Error(`Missing ${name} source at ${source.root}. Set FOILBURY_SOURCE_${name.toUpperCase().replace("-", "_")} if it moved.`);
    const root = fs.realpathSync(source.root);
    const remote = git(root, ["remote", "get-url", "origin"]);
    if (!remote.includes(source.expectedRemote)) {
      throw new Error(`${name} remote ${remote} does not identify ${source.expectedRemote}; refusing to import.`);
    }
    sourceState[name] = {
      root,
      remote,
      commit: git(root, ["rev-parse", "HEAD"]),
      branch: git(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
    };
  }
  const backgroundList = Object.entries(backgrounds).map(([key, background]) => {
    const state = sourceState[background.source];
    const absolute = fs.realpathSync(path.join(state.root, background.path));
    if (!absolute.startsWith(state.root + path.sep)) throw new Error(`Background ${key} escapes its source repository.`);
    return {
      key,
      ...background,
      absolutePath: absolute,
      sourceRepo: state.remote,
      sourceCommit: state.commit,
      sourcePath: background.path,
      sourceHash: sha256(fs.readFileSync(absolute)),
      bytes: fs.statSync(absolute).size,
    };
  });
  const items = curated.map((item) => {
    const state = sourceState[item.source];
    const absolute = fs.realpathSync(path.join(state.root, item.path));
    if (!absolute.startsWith(state.root + path.sep)) throw new Error(`${item.slug} escapes its source repository.`);
    if (!fs.statSync(absolute).isFile()) throw new Error(`${item.slug} is not a regular file.`);
    const buffer = fs.readFileSync(absolute);
    return {
      ...item,
      absolutePath: absolute,
      sourceRepo: state.remote,
      sourceCommit: state.commit,
      sourcePath: item.path,
      sourceHash: sha256(buffer),
      originalBytes: buffer.length,
    };
  });
  return {
    generatedAt: new Date().toISOString(),
    sources: sourceState,
    backgrounds: backgroundList,
    items,
  };
}

export function writeDiscovery(discovered, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(discovered, null, 2) + "\n");
  fs.chmodSync(file, 0o600);
}

export function toManifest(discovered, assetMap = {}) {
  return {
    source: "curated-sources",
    sourceRepo: Object.values(discovered.sources)
      .map((source) => source.remote)
      .join(", "),
    sourceCommit: Object.values(discovered.sources)
      .map((source) => source.commit)
      .join(", "),
    items: discovered.items.map((item) => ({
      source: item.source,
      sourceRepo: item.sourceRepo,
      sourceCommit: item.sourceCommit,
      sourcePath: item.sourcePath,
      sourceHash: item.sourceHash,
      logicalId: item.logicalId,
      slug: item.slug,
      name: item.name,
      subtitle: item.subtitle,
      description: item.description,
      categorySlug: item.categorySlug,
      classKey: item.className,
      rarityKey: item.rarityKey,
      tags: item.tags,
      credit: item.credit,
      subjectAssetId: assetMap[`subject:${item.logicalId}:${item.sourceHash}`] ?? "preview-subject",
      backgroundAssetId: assetMap[`background:${item.background}`] ?? "preview-background",
      variants: item.variants,
      sets: item.sets,
    })),
  };
}
