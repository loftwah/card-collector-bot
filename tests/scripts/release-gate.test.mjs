import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectBundle } from "../../scripts/lib/release-artifact.mjs";
import { validateReleaseEvidence } from "../../scripts/lib/release-evidence.mjs";

const TREE = "a".repeat(64);
const SHA = "b".repeat(40);
const REQUIRED = ["pnpm check", "pnpm test:production-path"];

function manifest(overrides = {}) {
  const now = new Date().toISOString();
  return {
    schema_version: 1,
    environment: "production",
    generated_at: now,
    source_tree_hash: TREE,
    checks: REQUIRED.map((command) => ({
      command,
      exit_code: 0,
      completed_at: now,
      tree_hash: TREE,
    })),
    criteria: [
      {
        id: "discord.deferred-private",
        issue: [22, 24],
        required: true,
        result: "pass",
        test_command: "pnpm test:workers --run tests/workers/discord.test.ts",
        tested_tree_hash: TREE,
        evidence: "Deferred acknowledgement is private; restricted content never posts.",
      },
      {
        id: "live.spectator",
        issue: [24],
        required: false,
        result: "blocked",
        test_command: "pnpm demo:discord:check",
        tested_tree_hash: TREE,
        evidence: "No second authorised identity.",
        residual: "Real spectator observation.",
      },
    ],
    ...overrides,
  };
}

function withManifest(value, callback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foilbury-release-"));
  const file = path.join(dir, "release-acceptance.json");
  fs.writeFileSync(file, JSON.stringify(value));
  try {
    return callback(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("accepts current, tree-bound, passing evidence", () => {
  withManifest(manifest(), (file) => {
    const result = validateReleaseEvidence({ treeHash: TREE, requiredChecks: REQUIRED, file });
    assert.equal(result.source_tree_hash, TREE);
    assert.equal(result.criteria.length, 2);
  });
});

test("rejects evidence for another tree", () => {
  const value = manifest({ source_tree_hash: "c".repeat(64) });
  withManifest(value, (file) => {
    assert.throws(
      () => validateReleaseEvidence({ treeHash: TREE, requiredChecks: REQUIRED, file }),
      /targets .* but the reviewed tree/,
    );
  });
});

test("rejects a stale manifest", () => {
  const stale = new Date(Date.now() - 20 * 86_400_000).toISOString();
  const value = manifest({ generated_at: stale });
  value.checks = value.checks.map((check) => ({ ...check, completed_at: stale }));
  withManifest(value, (file) => {
    assert.throws(
      () => validateReleaseEvidence({ treeHash: TREE, requiredChecks: REQUIRED, file }),
      /stale/,
    );
  });
});

test("rejects a missing or failed required check", () => {
  const missing = manifest();
  missing.checks = missing.checks.slice(0, 1);
  withManifest(missing, (file) => {
    assert.throws(
      () => validateReleaseEvidence({ treeHash: TREE, requiredChecks: REQUIRED, file }),
      /Required check missing/,
    );
  });
  const failed = manifest();
  failed.checks[0].exit_code = 1;
  withManifest(failed, (file) => {
    assert.throws(
      () => validateReleaseEvidence({ treeHash: TREE, requiredChecks: REQUIRED, file }),
      /Required check failed/,
    );
  });
});

test("rejects a required criterion that is partial, blocked or tested elsewhere", () => {
  const partial = manifest();
  partial.criteria[0].result = "partial";
  withManifest(partial, (file) => {
    assert.throws(
      () => validateReleaseEvidence({ treeHash: TREE, requiredChecks: REQUIRED, file }),
      /cannot be released as pass/,
    );
  });
  const elsewhere = manifest();
  elsewhere.criteria[0].tested_tree_hash = "d".repeat(64);
  withManifest(elsewhere, (file) => {
    assert.throws(
      () => validateReleaseEvidence({ treeHash: TREE, requiredChecks: REQUIRED, file }),
      /not tested against this tree/,
    );
  });
});

test("binds the emitted artifact to its exact source and bytes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foilbury-artifact-"));
  fs.mkdirSync(path.join(dir, "server"), { recursive: true });
  const entry = path.join(dir, "server", "entry.mjs");
  fs.writeFileSync(entry, "export default { fetch() { return new Response('ok'); } };\n");
  const bytes = fs.statSync(entry).size;
  const sha256 = crypto.createHash("sha256").update(fs.readFileSync(entry)).digest("hex");
  const meta = {
    schema_version: 1,
    source_sha: SHA,
    source_tree_hash: TREE,
    bundle: { file: "dist/server/entry.mjs", sha256, bytes },
  };
  fs.writeFileSync(path.join(dir, "server", "build-meta.json"), JSON.stringify(meta));
  try {
    const result = inspectBundle({ treeHash: TREE, sha: SHA, distDir: dir });
    assert.equal(result.sha256, sha256);

    fs.appendFileSync(entry, "// replaced\n");
    assert.throws(
      () => inspectBundle({ treeHash: TREE, sha: SHA, distDir: dir }),
      /bundle hash does not match/,
    );

    fs.writeFileSync(entry, "// stale build\n");
    const staleMeta = { ...meta, source_tree_hash: "c".repeat(64) };
    fs.writeFileSync(path.join(dir, "server", "build-meta.json"), JSON.stringify(staleMeta));
    assert.throws(
      () => inspectBundle({ treeHash: TREE, sha: SHA, distDir: dir }),
      /built from tree/,
    );

    fs.rmSync(path.join(dir, "server", "build-meta.json"));
    assert.throws(
      () => inspectBundle({ treeHash: TREE, sha: SHA, distDir: dir }),
      /No build-meta.json/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
