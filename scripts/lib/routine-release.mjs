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
