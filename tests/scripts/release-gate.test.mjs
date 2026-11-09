import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { inspectBundle, artifactManifest } from "../../scripts/lib/release-artifact.mjs";
import { validateReleaseEvidence } from "../../scripts/lib/release-evidence.mjs";
import { requireLiveTourEvidence } from "../../scripts/lib/live-tour-evidence.mjs";
import { requireCandidateServer } from "../../scripts/lib/candidate-server-evidence.mjs";
import {
  contentHashForFiles,
  workingTreeHash,
} from "../../scripts/lib/source-identity.mjs";
import {
  requireScopeEvidence,
  resolveRollback,
  scopeForPaths,
  verifyFreshRemote,
} from "../../scripts/lib/release-scope.mjs";

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
    const result = validateReleaseEvidence({ treeHash: TREE, requiredChecks: REQUIRED, requiredCriteria: ["discord.deferred-private"], file });
    assert.equal(result.source_tree_hash, TREE);
    assert.equal(result.criteria.length, 2);
  });
});

test("requires the validator's baseline and refuses to make it optional", () => {
  const incomplete = manifest();
  withManifest(incomplete, (file) => assert.throws(
    () => validateReleaseEvidence({ treeHash: TREE, requiredChecks: REQUIRED, file }),
    /Required acceptance criterion missing or optional/,
  ));
  const optional = manifest();
  optional.criteria[0].required = false;
  withManifest(optional, (file) => assert.throws(
    () => validateReleaseEvidence({ treeHash: TREE, requiredChecks: REQUIRED, requiredCriteria: ["discord.deferred-private"], file }),
    /Required acceptance criterion missing or optional/,
  ));
});

test("rejects a fabricated pass that reused skipped checks", () => {
  const value = manifest();
  value.checks[0].reused = true;
  withManifest(value, (file) => {
    assert.throws(
      () => validateReleaseEvidence({ treeHash: TREE, requiredChecks: REQUIRED, requiredCriteria: ["discord.deferred-private"], file }),
      /skipped or reused/,
    );
  });
});

test("rejects ambiguous checks, future checks and duplicate criteria", () => {
  const duplicateCheck = manifest();
  duplicateCheck.checks.push({ ...duplicateCheck.checks[0], exit_code: 1 });
  withManifest(duplicateCheck, (file) => assert.throws(
    () => validateReleaseEvidence({ treeHash: TREE, requiredChecks: REQUIRED, requiredCriteria: ["discord.deferred-private"], file }), /ambiguous/,
  ));
  const futureCheck = manifest();
  futureCheck.checks[0].completed_at = new Date(Date.now() + 86_400_000).toISOString();
  withManifest(futureCheck, (file) => assert.throws(
    () => validateReleaseEvidence({ treeHash: TREE, requiredChecks: REQUIRED, requiredCriteria: ["discord.deferred-private"], file }), /no recent completion time/,
  ));
  const duplicateCriterion = manifest();
  duplicateCriterion.criteria.push({ ...duplicateCriterion.criteria[0], result: "fail" });
  withManifest(duplicateCriterion, (file) => assert.throws(
    () => validateReleaseEvidence({ treeHash: TREE, requiredChecks: REQUIRED, requiredCriteria: ["discord.deferred-private"], file }), /unique, non-empty IDs/,
  ));
});

test("binds each required check to working-tree content when supplied", () => {
  const contentHash = "1".repeat(64);
  const value = manifest({ source_content_hash: contentHash });
  value.checks = value.checks.map((check) => ({ ...check, source_content_hash: contentHash }));
  value.checks[0].source_content_hash = "2".repeat(64);
  withManifest(value, (file) => assert.throws(
    () => validateReleaseEvidence({ treeHash: TREE, contentHash, requiredChecks: REQUIRED, requiredCriteria: ["discord.deferred-private"], file }), /different working-tree content/,
  ));
});

test("rejects unbound optional passes that could satisfy release scope", () => {
  const value = manifest();
  value.criteria.push({ id: "observability.fake", required: false, result: "pass", issue: [33] });
  withManifest(value, (file) => assert.throws(
    () => validateReleaseEvidence({ treeHash: TREE, requiredChecks: REQUIRED, requiredCriteria: ["discord.deferred-private"], file }),
    /criterion observability.fake is incomplete/,
  ));
  value.criteria[2].test_command = "node fake.mjs";
  value.criteria[2].evidence = "A claim without the tested tree.";
  withManifest(value, (file) => assert.throws(
    () => validateReleaseEvidence({ treeHash: TREE, requiredChecks: REQUIRED, requiredCriteria: ["discord.deferred-private"], file }),
    /was not tested against this tree/,
  ));
});

test("release recorder refuses to fabricate skipped checks", () => {
  const result = spawnSync(process.execPath, ["scripts/record-release-acceptance.mjs", "--skip-checks"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Refusing to record acceptance with skipped checks/);
});

test("release recorder refuses an unverified browser and database harness", () => {
  const result = spawnSync(process.execPath, ["scripts/record-release-acceptance.mjs"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /isolated, artifact-bound browser and database harness has not been verified/);
});

test("deployment check refuses an unverified browser and database harness", () => {
  const result = spawnSync(process.execPath, ["scripts/deploy-production.mjs", "--check"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /isolated, artifact-bound browser and database harness has not been verified/);
});

test("live tour evidence must be fresh, production-specific and unambiguous", () => {
  const now = Date.now();
  const report = { mode: "production", origin: "https://foilbury.loftwah.com", generated_at: new Date(now).toISOString(), checks: [{ id: "tour entry", status: "PASS" }] };
  assert.equal(requireLiveTourEvidence(report, now).status, "PASS");
  assert.throws(() => requireLiveTourEvidence({ ...report, mode: "local" }, now), /production origin/);
  assert.throws(() => requireLiveTourEvidence({ ...report, origin: "https://example.com" }, now), /production origin/);
  assert.throws(() => requireLiveTourEvidence({ ...report, generated_at: new Date(now - 11 * 60_000).toISOString() }, now), /stale/);
  assert.throws(() => requireLiveTourEvidence({ ...report, checks: [{ id: "tour entry", status: "BLOCKED" }] }, now), /not verified/);
  assert.throws(() => requireLiveTourEvidence({ ...report, checks: [report.checks[0], report.checks[0]] }, now), /not verified/);
});

test("browser evidence requires a loopback server reporting the candidate revision", () => {
  assert.doesNotThrow(() => requireCandidateServer("http://localhost:5173", SHA, SHA));
  assert.throws(() => requireCandidateServer("https://foilbury.loftwah.com", SHA, SHA), /loopback/);
  assert.throws(() => requireCandidateServer("http://127.0.0.1:5173", SHA, "c".repeat(40)), /exact candidate/);
  assert.throws(() => requireCandidateServer("http://localhost:5173", SHA, null), /exact candidate/);
});

test("rejects evidence for another tree", () => {
  const value = manifest({ source_tree_hash: "c".repeat(64) });
  withManifest(value, (file) => {
    assert.throws(
      () => validateReleaseEvidence({ treeHash: TREE, requiredChecks: REQUIRED, requiredCriteria: ["discord.deferred-private"], file }),
      /targets .* but the reviewed tree/,
    );
  });
});

test("rejects evidence recorded from different working-tree content", () => {
  const value = manifest({ source_content_hash: "1".repeat(64) });
  withManifest(value, (file) => {
    assert.throws(
      () =>
        validateReleaseEvidence({
          treeHash: TREE,
          contentHash: "2".repeat(64),
          requiredChecks: REQUIRED, requiredCriteria: ["discord.deferred-private"],
          file,
        }),
      /working-tree content/,
    );
  });
});

test("rejects a stale manifest", () => {
  const stale = new Date(Date.now() - 20 * 86_400_000).toISOString();
  const value = manifest({ generated_at: stale });
  value.checks = value.checks.map((check) => ({ ...check, completed_at: stale }));
  withManifest(value, (file) => {
    assert.throws(
      () => validateReleaseEvidence({ treeHash: TREE, requiredChecks: REQUIRED, requiredCriteria: ["discord.deferred-private"], file }),
      /stale/,
    );
  });
});

test("rejects a missing or failed required check", () => {
  const missing = manifest();
  missing.checks = missing.checks.slice(0, 1);
  withManifest(missing, (file) => {
    assert.throws(
      () => validateReleaseEvidence({ treeHash: TREE, requiredChecks: REQUIRED, requiredCriteria: ["discord.deferred-private"], file }),
      /Required check missing/,
    );
  });
  const failed = manifest();
  failed.checks[0].exit_code = 1;
  withManifest(failed, (file) => {
    assert.throws(
      () => validateReleaseEvidence({ treeHash: TREE, requiredChecks: REQUIRED, requiredCriteria: ["discord.deferred-private"], file }),
      /Required check failed/,
    );
  });
});

test("rejects a required criterion that is partial, blocked or tested elsewhere", () => {
  const partial = manifest();
  partial.criteria[0].result = "partial";
  withManifest(partial, (file) => {
    assert.throws(
      () => validateReleaseEvidence({ treeHash: TREE, requiredChecks: REQUIRED, requiredCriteria: ["discord.deferred-private"], file }),
      /cannot be released as pass/,
    );
  });
  const elsewhere = manifest();
  elsewhere.criteria[0].tested_tree_hash = "d".repeat(64);
  withManifest(elsewhere, (file) => {
    assert.throws(
      () => validateReleaseEvidence({ treeHash: TREE, requiredChecks: REQUIRED, requiredCriteria: ["discord.deferred-private"], file }),
      /not tested against this tree/,
    );
  });
});

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
    const result = inspectBundle({ treeHash: TREE, contentHash: "e".repeat(64), sha: SHA, distDir: dir });
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
  assert.throws(() => resolveRollback(null), /could not be read|rollback target/);
  assert.throws(() => resolveRollback([]), /could not be read|rollback target/);
  assert.throws(
    () => resolveRollback([{ id: "dep_1", created_on: new Date().toISOString(), versions: [] }]),
    /no readable Worker version id/,
  );
  const current = {
    id: "dep_current",
    created_on: "2026-11-04T00:00:00.000Z",
    versions: [{ version_id: "11111111-1111-1111-1111-111111111111", percentage: 100 }],
  };
  const previous = {
    id: "dep_previous",
    created_on: "2026-11-03T00:00:00.000Z",
    versions: [{ version_id: "22222222-2222-2222-2222-222222222222", percentage: 100 }],
  };
  const rollback = resolveRollback([previous, current]);
  // The deploy gate runs before upload, so the newest deployment is the
  // version currently serving production and the correct immediate rollback.
  assert.equal(rollback.version_id, "11111111-1111-1111-1111-111111111111");
  assert.match(rollback.command, /^wrangler rollback 11111111/);
});

test("rejects stale or mismatched remote refs", () => {
  const now = new Date("2026-11-04T00:00:00.000Z");
  assert.throws(
    () =>
      verifyFreshRemote({
        localOriginMain: SHA,
        remoteSha: "c".repeat(40),
        fetchedAt: now.toISOString(),
        now,
      }),
    /does not match/,
  );
  assert.throws(
    () =>
      verifyFreshRemote({
        localOriginMain: SHA,
        remoteSha: SHA,
        fetchedAt: "2026-11-03T00:00:00.000Z",
        now,
        maxAgeMinutes: 10,
      }),
    /stale/,
  );
  assert.equal(
    verifyFreshRemote({
      localOriginMain: SHA,
      remoteSha: SHA,
      fetchedAt: now.toISOString(),
      now,
    }).remote,
    SHA,
  );
});

test("requires applicable evidence for the affected release scope", () => {
  const scope = scopeForPaths(["src/server/discord/handler.ts", "tests/workers/discord.test.ts"]);
  assert.deepEqual(scope.scopes, ["discord"]);
  assert.throws(
    () => requireScopeEvidence(scope, []),
    /no passing criterion|affects discord/,
  );
  const evidence = [
    {
      id: "discord.deferred-private",
      issue: [22, 24],
      result: "pass",
      tested_tree_hash: TREE,
    },
  ];
  assert.equal(requireScopeEvidence(scope, evidence).criteria[0], "discord.deferred-private");
  const docs = scopeForPaths(["docs/ACCEPTANCE_CURRENT.md"]);
  assert.equal(docs.documentation_only, true);
  assert.doesNotThrow(() => requireScopeEvidence(docs, []));
});
