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
  "pnpm test:artwork",
  "node scripts/test-album-e2e.mjs",
  "node scripts/test-privacy.mjs",
  "pnpm perf:local",
  "pnpm demo:discord:check --json",
];
// This baseline is owned by the validator, not by the manifest being checked.
// A manifest must not be able to make a required criterion disappear or mark
// it optional. Additional scoped requirements are checked by release-scope.
const REQUIRED_CRITERIA = [
  "discord.deferred-private", "discord.token-redaction", "discord.committed-receipt-recovery",
  "discord.production-entry-lifecycle", "discord.presentation-adoption", "eligibility.authoritative-list",
  "economy.settled-balance", "admin.scoped-grants", "state.render-fencing", "effect.discord-transport",
  "share.privacy-lifecycle", "ui.rendered-a11y", "product.browser-journeys", "release.gate",
  "discord.tour-entry-live", "discord.acceptance-runner", "observability.scheduled-isolation",
  "release.source-and-artifact",
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
  contentHash,
  requiredChecks = REQUIRED_CHECKS,
  requiredCriteria = REQUIRED_CRITERIA,
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
  if (contentHash && evidence.source_content_hash !== contentHash) {
    throw fail(
      `Acceptance evidence was recorded from working-tree content ${String(evidence.source_content_hash ?? "unknown").slice(0, 12)}… but the current content is ${contentHash.slice(0, 12)}…. Regenerate the evidence.`,
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
    const matching = evidence.checks.filter((entry) => entry?.command === command);
    if (matching.length === 0) throw fail(`Required check missing: ${command}`);
    if (matching.length !== 1) throw fail(`Required check is ambiguous: ${command}`);
    const [check] = matching;
    if (check.reused === true || check.skipped === true) {
      throw fail(`Required check ${command} was skipped or reused; run it for this source.`);
    }
    if (check.exit_code !== 0) throw fail(`Required check failed: ${command}`);
    if (check.tree_hash !== treeHash) {
      throw fail(`Required check ${command} was run against another source tree.`);
    }
    const completed = Date.parse(check.completed_at);
    const completionAgeDays = (now.getTime() - completed) / 86_400_000;
    if (!Number.isFinite(completed) || completionAgeDays < -0.25 || completionAgeDays > MAX_AGE_DAYS) {
      throw fail(`Required check ${command} has no recent completion time.`);
    }
    if (contentHash && check.source_content_hash !== contentHash) {
      throw fail(`Required check ${command} was run against different working-tree content.`);
    }
  }
  if (!Array.isArray(evidence.criteria) || evidence.criteria.length === 0) {
    throw fail("Acceptance criteria must be a non-empty array.");
  }
  const criterionIds = evidence.criteria.map((criterion) => criterion?.id);
  if (criterionIds.some((id) => typeof id !== "string" || !id.trim()) || new Set(criterionIds).size !== criterionIds.length) {
    throw fail("Acceptance criteria must have unique, non-empty IDs.");
  }
  for (const id of requiredCriteria) {
    const criterion = evidence.criteria.find((item) => item.id === id);
    if (!criterion || criterion.required !== true) throw fail(`Required acceptance criterion missing or optional: ${id}`);
  }
  const required = evidence.criteria.filter((criterion) => criterion.required === true);
  if (required.length === 0) throw fail("At least one required acceptance criterion is needed.");
  // A passing optional criterion may still be used by release-scope. It must
  // carry the same source binding and evidence as a required passing entry.
  const checkedCriteria = evidence.criteria.filter((criterion) => criterion.required === true || criterion.result === "pass");
  for (const criterion of checkedCriteria) {
    if (!criterion.id || !criterion.issue || !criterion.test_command || !criterion.evidence) {
      throw fail(`Passing or required criterion ${criterion.id ?? "(unnamed)"} is incomplete.`);
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
