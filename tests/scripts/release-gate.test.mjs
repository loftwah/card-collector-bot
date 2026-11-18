import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectBundle, artifactManifest } from "../../scripts/lib/release-artifact.mjs";
import { contentHashForFiles, workingTreeHash } from "../../scripts/lib/source-identity.mjs";
import { resolveRollback } from "../../scripts/lib/routine-release.mjs";

const TREE = "a".repeat(64);
const SHA = "b".repeat(40);

test("binds the emitted artifact and the complete deployed set to its exact source and bytes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foilbury-artifact-"));
  const serverDir = path.join(dir, "server");
  const clientDir = path.join(dir, "client", "assets");
  fs.mkdirSync(serverDir, { recursive: true });
  fs.mkdirSync(clientDir, { recursive: true });
  const entry = path.join(serverDir, "entry.mjs");
  fs.writeFileSync(entry, "export default { fetch() { return new Response('ok'); } };\n");
  fs.writeFileSync(path.join(serverDir, "chunk.mjs"), "export const chunk = 1;\n");
  fs.writeFileSync(path.join(clientDir, "app.css"), "body{color:#000}\n");
  const bytes = fs.statSync(entry).size;
  const sha256 = crypto.createHash("sha256").update(fs.readFileSync(entry)).digest("hex");
  const manifest = artifactManifest(dir);
  const meta = {
    schema_version: 2,
    source_sha: SHA,
    source_tree_hash: TREE,
    source_content_hash: "e".repeat(64),
    bundle: { file: "dist/server/entry.mjs", sha256, bytes },
    artifact: manifest,
  };
  fs.writeFileSync(path.join(serverDir, "build-meta.json"), JSON.stringify(meta));
  try {
    const result = inspectBundle({
      treeHash: TREE,
      contentHash: "e".repeat(64),
      sha: SHA,
      distDir: dir,
    });
    assert.equal(result.sha256, sha256);
    assert.equal(result.artifact.file_count, 3);

    // A changed chunk or client asset must fail even when entry.mjs is intact.
    fs.writeFileSync(path.join(serverDir, "chunk.mjs"), "export const chunk = 2;\n");
    assert.throws(
      () => inspectBundle({ treeHash: TREE, contentHash: "e".repeat(64), sha: SHA, distDir: dir }),
      /deployed module\/asset set does not match|changed after the build/,
    );
    fs.writeFileSync(path.join(serverDir, "chunk.mjs"), "export const chunk = 1;\n");
    fs.writeFileSync(path.join(clientDir, "extra.css"), "body{color:#fff}\n");
    assert.throws(
      () => inspectBundle({ treeHash: TREE, contentHash: "e".repeat(64), sha: SHA, distDir: dir }),
      /does not match|not recorded/,
    );
    fs.rmSync(path.join(clientDir, "extra.css"));

    fs.appendFileSync(entry, "// replaced\n");
    assert.throws(
      () => inspectBundle({ treeHash: TREE, contentHash: "e".repeat(64), sha: SHA, distDir: dir }),
      /bundle hash does not match/,
    );

    // Working-tree content changing after the build is rejected even when the
    // committed/index tree hash is unchanged.
    assert.throws(
      () => inspectBundle({ treeHash: TREE, contentHash: "f".repeat(64), sha: SHA, distDir: dir }),
      /working-tree content/,
    );

    fs.writeFileSync(entry, "// stale build\n");
    const staleMeta = { ...meta, source_tree_hash: "c".repeat(64) };
    fs.writeFileSync(path.join(serverDir, "build-meta.json"), JSON.stringify(staleMeta));
    assert.throws(
      () => inspectBundle({ treeHash: TREE, contentHash: "e".repeat(64), sha: SHA, distDir: dir }),
      /built from tree/,
    );

    fs.rmSync(path.join(serverDir, "build-meta.json"));
    assert.throws(
      () => inspectBundle({ treeHash: TREE, contentHash: "e".repeat(64), sha: SHA, distDir: dir }),
      /No build-meta.json/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("content identity hashes working bytes, not only Git index blobs", () => {
  const original = [{ file: "src/a.ts", sha256: "1".repeat(64) }];
  const modified = [{ file: "src/a.ts", sha256: "2".repeat(64) }];
  assert.notEqual(contentHashForFiles(original), contentHashForFiles(modified));
  assert.match(workingTreeHash(), /^[0-9a-f]{64}$/);
});

test("refuses an unreadable or versionless rollback target", () => {
  assert.throws(() => resolveRollback(null), /deployment identity/);
  assert.throws(() => resolveRollback({ id: "dep_1", versions: [] }), /sole serving Worker/);
  const current = {
    id: "dep_current",
    created_on: "2026-11-04T00:00:00.000Z",
    versions: [{ version_id: "11111111-1111-1111-1111-111111111111", percentage: 100 }],
  };
  const rollback = resolveRollback(current);
  // The deploy gate runs before upload, so the newest deployment is the
  // version currently serving production and the correct immediate rollback.
  assert.equal(rollback.version_id, "11111111-1111-1111-1111-111111111111");
  assert.match(rollback.command, /^wrangler rollback 11111111/);
});
