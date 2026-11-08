/** The whole test-and-release flow must stay inside five minutes. */
export const RELEASE_BUDGET_SECONDS = 300;
/** Leave room for upload, propagation and the live smoke inside that budget. */
export const PRE_DEPLOY_BUDGET_SECONDS = 240;

export function releaseBudget(elapsedSeconds, limitSeconds = RELEASE_BUDGET_SECONDS) {
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) {
    throw new TypeError('Release elapsed time must be a non-negative number.');
  }
  const round = (value) => Math.round(value * 10) / 10;
  const elapsed = round(elapsedSeconds);
  return {
    limit_seconds: limitSeconds,
    elapsed_seconds: elapsed,
    remaining_seconds: round(Math.max(0, limitSeconds - elapsed)),
    within_budget: elapsed <= limitSeconds,
  };
}

export function assertReleaseBudget(elapsedSeconds, limitSeconds = RELEASE_BUDGET_SECONDS) {
  const budget = releaseBudget(elapsedSeconds, limitSeconds);
  if (!budget.within_budget) {
    throw new Error(
      `Release took ${budget.elapsed_seconds}s, over its ${budget.limit_seconds}s budget.`,
    );
  }
  return budget;
}

/** Fail closed when a routine deployment would require any D1 migration. */
export function assertMigrationParity(local, remote) {
  const valid = list => Array.isArray(list) && list.length > 0 && list.every(name => typeof name === 'string' && /^\d{4}_[a-z0-9_]+\.sql$/.test(name)) && new Set(list).size === list.length;
  if (!valid(local) || !valid(remote) || JSON.stringify(local) !== JSON.stringify(remote)) {
    throw new Error('Production migrations differ from local; use the data migration workflow.');
  }
  return remote;
}

/** Changes to the draw route require its loading and stale-draw browser check. */
export function needsDrawLoadingCheck(paths) {
  return paths.some(p => p === 'src/components/player/DrawStudio.tsx' || p === 'src/pages/play/draw.astro');
}
