/** A historical tour-entry claim is not current release evidence. */
export function requireLiveTourEvidence(report, now = Date.now()) {
  if (!report || report.mode !== "production" || report.origin !== "https://foilbury.loftwah.com")
    throw new Error("Discord tour preflight did not inspect the production origin.");
  const generated = Date.parse(report.generated_at);
  if (!Number.isFinite(generated) || generated > now + 60_000 || now - generated > 10 * 60_000)
    throw new Error("Discord tour preflight is missing or stale.");
  const entries = Array.isArray(report.checks) ? report.checks.filter((item) => item.id === "tour entry") : [];
  if (entries.length !== 1 || entries[0].status !== "PASS")
    throw new Error("Discord tour entry was not verified by the live preflight.");
  return { generatedAt: report.generated_at, status: "PASS" };
}
