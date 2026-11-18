export const RELEASE_BUDGET_SECONDS = 120;

export function releaseBudget(elapsedSeconds) {
  const round = (value) => Math.round(value * 10) / 10;
  return {
    limit_seconds: RELEASE_BUDGET_SECONDS,
    elapsed_seconds: round(elapsedSeconds),
    remaining_seconds: round(Math.max(0, RELEASE_BUDGET_SECONDS - elapsedSeconds)),
    within_budget: elapsedSeconds <= RELEASE_BUDGET_SECONDS,
  };
}

/** Fail closed when a routine deployment would require any D1 migration. */
export function assertMigrationParity(local, remote) {
  const valid = (list) =>
    Array.isArray(list) &&
    list.length > 0 &&
    list.every((name) => typeof name === "string" && /^\d{4}_[a-z0-9_]+\.sql$/.test(name)) &&
    new Set(list).size === list.length;
  if (!valid(local) || !valid(remote) || JSON.stringify(local) !== JSON.stringify(remote)) {
    throw new Error("Production migrations differ from local; use the data migration workflow.");
  }
  return remote;
}

export function resolveRollback(deployment) {
  if (!deployment?.id) throw new Error("Previous production deployment identity is missing.");
  const versionId = singleServingVersion(deployment);
  return {
    deployment_id: deployment.id,
    version_id: versionId,
    command: `wrangler rollback ${versionId} --name foilbury --config wrangler.production.jsonc --yes`,
  };
}

export function singleServingVersion(deployment) {
  const versions = deployment?.versions;
  if (
    !Array.isArray(versions) ||
    versions.length !== 1 ||
    versions[0]?.percentage !== 100 ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(versions[0]?.version_id ?? "")
  )
    throw new Error("Production must have a sole serving Worker version.");
  return versions[0].version_id.toLowerCase();
}

export function reportedUploadVersion(stdout) {
  const matches = [
    ...String(stdout ?? "").matchAll(
      /^Current Version ID:\s*([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\s*$/gim,
    ),
  ].map((match) => match[1].toLowerCase());
  return matches.length === 1 ? matches[0] : null;
}

export function requireSameSource(initial, current) {
  if (
    !initial ||
    !current ||
    current.dirty ||
    initial.sha !== current.sha ||
    initial.tree_hash !== current.tree_hash ||
    initial.content_hash !== current.content_hash
  )
    throw new Error("Source changed during release.");
}
export function requireSameDeployment(initial, current) {
  if (
    !initial?.id ||
    current?.id !== initial.id ||
    singleServingVersion(current) !== singleServingVersion(initial)
  )
    throw new Error("Production deployment changed during release.");
}
