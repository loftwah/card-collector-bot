/** Pair published asset ids only with bytes from the same rendered side. */
export function derivativeSources(completed, frontPath, backPath) {
  const sources = [];
  if (completed?.assetId && frontPath) sources.push({ assetId: completed.assetId, sourcePath: frontPath });
  if (completed?.back?.assetId && backPath) {
    if (frontPath === backPath) throw new Error("Front and back derivatives require separate source files.");
    sources.push({ assetId: completed.back.assetId, sourcePath: backPath });
  }
  return sources;
}
