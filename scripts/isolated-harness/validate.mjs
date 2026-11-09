/** Structural checks only: this does not authenticate a report or qualify a release. */
const hash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function validateIsolationReport(report, expected) {
  if (!report || !expected || !hash(expected.source) || !hash(expected.artifact)) throw new Error('Expected source and artifact digests are required.');
  if (report.sourceBefore !== expected.source || report.sourceAfter !== expected.source) throw new Error('Source identity changed or is unbound.');
  if (report.artifactBefore !== expected.artifact || report.artifactAfter !== expected.artifact) throw new Error('Artifact identity changed or is unbound.');
  if (report.network !== 'none' || !Array.isArray(report.mounts) || report.mounts.length !== 0) throw new Error('Container must have no network and no mounts.');
  if (report.disposableStorage !== true || report.containsOwnerData !== false || report.containsCredentials !== false) throw new Error('Disposable storage and absence of owner data and credentials must be proven.');
  if (!Array.isArray(expected.tests) || expected.tests.length === 0 || new Set(expected.tests).size !== expected.tests.length) throw new Error('An explicit unique test list is required.');
  if (!Array.isArray(report.tests) || report.tests.length !== expected.tests.length) throw new Error('Test results do not match the requested test list.');
  for (const name of expected.tests) {
    const matches = report.tests.filter((item) => item?.name === name);
    if (matches.length !== 1 || matches[0].exitCode !== 0 || matches[0].skipped !== false || matches[0].reused !== false) throw new Error(`Test not freshly passed: ${name}`);
  }
  return true;
}
