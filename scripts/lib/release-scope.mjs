import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./local.mjs";
import { sha256File } from "./source-identity.mjs";

/**
 * A release declares what it can affect. The gate then requires at least one
 * passing, tree-bound criterion for each affected scope. This is deliberately
 * coarser than issue labels: it is a release safety net, not issue closure.
 */
const SCOPE_RULES = [
  { scope: "discord", issues: [7, 15, 22, 24, 34], pattern: /^(src\/server\/discord|scripts\/discord|tests\/workers\/discord|src\/components\/player\/.*[Ss]hare)/ },
  { scope: "effect", issues: [35], pattern: /^(src\/server\/effect|docs\/EFFECT)/ },
  { scope: "web", issues: [8, 10, 11, 12, 13, 14, 27, 30, 32], pattern: /^(src\/components|src\/pages|public\/brand|brand\/)/ },
  { scope: "content", issues: [2, 28, 29], pattern: /^(content|docs\/(COLLECTION|CONTENT)|scripts\/content|\.foilbury\/content)/ },
  { scope: "schema", issues: [19, 34], pattern: /^migrations\// },
  { scope: "observability", issues: [3, 33], pattern: /^(src\/server\/observability|src\/server\/scheduled|scripts\/observability)/ },
  { scope: "release", issues: [19], pattern: /^(scripts\/(deploy-production|build-production|record-release-acceptance|lib\/release-)|tests\/scripts\/release-gate)/ },
];

export function scopeForPaths(paths) {
  const scopes = new Set();
  const issues = new Set();
  for (const file of paths) {
    for (const rule of SCOPE_RULES) {
      if (rule.pattern.test(file)) {
        scopes.add(rule.scope);
        for (const issue of rule.issues) issues.add(issue);
      }
    }
  }
  // Documentation-only changes do not claim product scope. They still need
  // source/build/deployment identity, but not a product criterion.
  const documentationOnly =
    paths.length > 0 &&
    paths.every((file) => file.startsWith("docs/") || file.endsWith(".md"));
  return {
    files: [...paths].sort(),
    scopes: [...scopes].sort(),
    issues: [...issues].sort((left, right) => left - right),
    documentation_only: documentationOnly,
  };
}

export function changedPaths({ from, to = "HEAD", capture }) {
  if (!from) return [];
  return capture("git", ["diff", "--name-only", `${from}..${to}`])
    .split(/\r?\n/)
    .filter(Boolean);
}

export function requireScopeEvidence(scope, criteria) {
  if (scope.documentation_only || scope.scopes.length === 0) return;
  const passing = criteria.filter(
    (criterion) =>
      criterion.result === "pass" &&
      Array.isArray(criterion.issue) &&
      criterion.issue.some((issue) => scope.issues.includes(issue)),
  );
  const covered = new Set(passing.flatMap((criterion) => criterion.issue ?? []));
  const missing = scope.issues.filter((issue) => !covered.has(issue));
  if (passing.length === 0) {
    throw new Error(
      `The release affects ${scope.scopes.join(", ")} but the acceptance manifest has no passing criterion for its issues (${scope.issues.join(", ")}). Add the applicable evidence or narrow the release.`,
    );
  }
  // A scope can be covered by one criterion for one related issue; do not
  // require every issue, which would turn a release gate into issue closure.
  return { criteria: passing.map((criterion) => criterion.id), missing_issue_evidence: missing };
}

/**
 * Resolve the actual previous Worker version. An unreadable deployment list,
 * or one without a version id, must not silently become "no rollback".
 */
export function resolveRollback(deployments) {
  if (!Array.isArray(deployments) || deployments.length === 0) {
    throw new Error(
      "Previous production deployments could not be read, so a rollback target cannot be proven. Refusing to change the Worker.",
    );
  }
  const sorted = [...deployments].sort(
    (left, right) => Date.parse(right.created_on ?? 0) - Date.parse(left.created_on ?? 0),
  );
  const previous = sorted[1] ?? sorted[0];
  const versionId = previous?.versions?.[0]?.version_id ?? previous?.version_id ?? null;
  if (!versionId || !/^[0-9a-f-]{36}$/i.test(versionId)) {
    throw new Error(
      "The previous production deployment has no readable Worker version id. Refusing to change the Worker without a concrete rollback target.",
    );
  }
  return {
    deployment_id: previous.id ?? null,
    version_id: versionId,
    created_on: previous.created_on ?? null,
    command: `wrangler rollback ${versionId} --name foilbury --config wrangler.production.jsonc --yes`,
    note: "Rollback restores the previous Worker version. Additive schema migrations are not reversed automatically.",
  };
}

export function verifyFreshRemote({
  localOriginMain,
  remoteSha,
  fetchedAt,
  now = new Date(),
  maxAgeMinutes = 10,
}) {
  if (!remoteSha) throw new Error("The remote main ref could not be read. Refusing release.");
  if (!localOriginMain) throw new Error("origin/main is missing locally. Refusing release.");
  if (localOriginMain !== remoteSha) {
    throw new Error(
      `origin/main ${localOriginMain.slice(0, 12)}… does not match the freshly fetched remote ${remoteSha.slice(0, 12)}…. Fetch and reconcile first.`,
    );
  }
  const fetched = Date.parse(fetchedAt);
  if (!Number.isFinite(fetched) || (now.getTime() - fetched) / 60_000 > maxAgeMinutes) {
    throw new Error("The remote ref read is stale. Fetch again before releasing.");
  }
  return { local: localOriginMain, remote: remoteSha, fetched_at: fetchedAt };
}

export function evidenceArtifacts(criteria) {
  const candidates = new Set();
  for (const criterion of criteria) {
    for (const value of [criterion.test_command, criterion.evidence]) {
      if (typeof value !== "string") continue;
      for (const token of value.matchAll(/[\w./-]+\.(?:mjs|ts|tsx|js|json|png|webp|mp4|md)/g)) {
        const file = token[0].replace(/^\.\//, "");
        if (file.startsWith("docs/") || file.startsWith("tests/") || file.startsWith("scripts/") || file.startsWith(".foilbury/")) {
          if (fs.existsSync(path.join(ROOT, file))) candidates.add(file);
        }
      }
    }
  }
  return [...candidates]
    .sort()
    .map((file) => ({ path: file, sha256: sha256File(path.join(ROOT, file)) }));
}

export function manifestDigest(entries) {
  const hash = crypto.createHash("sha256");
  for (const entry of entries) hash.update(`${entry.path}\0${entry.sha256}\n`);
  return hash.digest("hex");
}
