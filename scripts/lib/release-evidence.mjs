import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./local.mjs";
import { readJson, sha256File } from "./source-identity.mjs";

export const ACCEPTANCE_FILE = "docs/release-acceptance.json";
const MAX_AGE_DAYS = 14;
const REQUIRED_CHECKS = [
  "pnpm check",
  "pnpm test:production-path",
  "pnpm test:access-config",
  "pnpm test:ui",
  "pnpm test:product",
];

function fail(message) {
  const error = new Error(message);
  error.code = "release_evidence_invalid";
  return error;
}

/**
 * Validate the one current acceptance manifest. A required criterion cannot be
 * stale, cannot target another tree, and cannot be "blocked" or "partial" while
 * the release claims to satisfy it.
 */
export function validateReleaseEvidence({
  treeHash,
  requiredChecks = REQUIRED_CHECKS,
  now = new Date(),
  file = path.join(ROOT, ACCEPTANCE_FILE),
}) {
  if (!fs.existsSync(file)) throw fail(`${ACCEPTANCE_FILE} is missing.`);
  const evidence = readJson(file);
  if (evidence.schema_version !== 1) throw fail("Acceptance evidence must use schema_version 1.");
  if (evidence.environment !== "production") {
    throw fail("Acceptance evidence must target production.");
  }
  if (evidence.source_tree_hash !== treeHash) {
    throw fail(
      `Acceptance evidence targets ${String(evidence.source_tree_hash).slice(0, 12)}… but the reviewed tree is ${treeHash.slice(0, 12)}…. Regenerate the evidence.`,
    );
  }
  const generated = Date.parse(evidence.generated_at);
  if (!Number.isFinite(generated)) throw fail("Acceptance evidence has no valid generated_at.");
  const ageDays = (now.getTime() - generated) / 86_400_000;
  if (ageDays < -0.25 || ageDays > MAX_AGE_DAYS) {
    throw fail(`Acceptance evidence is stale (${ageDays.toFixed(1)} days old).`);
  }
  if (!Array.isArray(evidence.checks)) throw fail("Acceptance checks must be an array.");
  for (const command of requiredChecks) {
    const check = evidence.checks.find((entry) => entry.command === command);
    if (!check) throw fail(`Required check missing: ${command}`);
    if (check.exit_code !== 0) throw fail(`Required check failed: ${command}`);
    if (check.tree_hash !== treeHash) {
      throw fail(`Required check ${command} was run against another source tree.`);
    }
    const completed = Date.parse(check.completed_at);
    if (!Number.isFinite(completed) || (now.getTime() - completed) / 86_400_000 > MAX_AGE_DAYS) {
      throw fail(`Required check ${command} has no recent completion time.`);
    }
  }
  if (!Array.isArray(evidence.criteria) || evidence.criteria.length === 0) {
    throw fail("Acceptance criteria must be a non-empty array.");
  }
  const required = evidence.criteria.filter((criterion) => criterion.required === true);
  if (required.length === 0) throw fail("At least one required acceptance criterion is needed.");
  for (const criterion of required) {
    if (!criterion.id || !criterion.issue || !criterion.test_command || !criterion.evidence) {
      throw fail(`Required criterion ${criterion.id ?? "(unnamed)"} is incomplete.`);
    }
    if (criterion.result !== "pass") {
      throw fail(
        `Required criterion ${criterion.id} is ${criterion.result}; a required criterion cannot be released as pass.`,
      );
    }
    if (criterion.tested_tree_hash !== treeHash) {
      throw fail(`Required criterion ${criterion.id} was not tested against this tree.`);
    }
  }
  const unresolved = evidence.criteria.filter(
    (criterion) => criterion.required === false && criterion.result === "fail",
  );
  if (unresolved.length) {
    throw fail(
      `A recorded optional criterion is a hard failure: ${unresolved.map((item) => item.id).join(", ")}. Mark it partial/blocked with the exact residual instead.`,
    );
  }
  for (const artifact of evidence.evidence_files ?? []) {
    const target = path.isAbsolute(artifact.path)
      ? artifact.path
      : path.join(ROOT, artifact.path);
    if (!fs.existsSync(target)) throw fail(`Evidence artifact missing: ${artifact.path}`);
    if (artifact.sha256 && sha256File(target) !== artifact.sha256) {
      throw fail(`Evidence artifact changed after it was recorded: ${artifact.path}`);
    }
  }
  return {
    file,
    sha256: sha256File(file),
    generated_at: evidence.generated_at,
    source_tree_hash: evidence.source_tree_hash,
    criteria: evidence.criteria,
    checks: evidence.checks,
    required_checks: requiredChecks,
  };
}

export function evidenceSummary(evidence) {
  return {
    file: ACCEPTANCE_FILE,
    sha256: evidence.sha256,
    generated_at: evidence.generated_at,
    source_tree_hash: evidence.source_tree_hash,
    required_checks: evidence.required_checks,
    criteria: evidence.criteria.map((criterion) => ({
      id: criterion.id,
      issue: criterion.issue,
      required: criterion.required,
      result: criterion.result,
      residual: criterion.residual ?? null,
    })),
  };
}
