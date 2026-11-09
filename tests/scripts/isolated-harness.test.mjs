import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { validateIsolationReport } from '../../scripts/isolated-harness/validate.mjs';

const source = 'a'.repeat(64), artifact = 'b'.repeat(64);
const expected = { source, artifact, tests: ['browser'] };
const report = () => ({sourceBefore:source,sourceAfter:source,artifactBefore:artifact,artifactAfter:artifact,network:'none',mounts:[],disposableStorage:true,containsOwnerData:false,containsCredentials:false,tests:[{name:'browser',exitCode:0,skipped:false,reused:false}]});

test('prototype remains held without attempting container or test execution', () => {
  const result = spawnSync(process.execPath, ['scripts/isolated-harness/run.mjs'], { encoding:'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /held/);
});
test('structural validation rejects drift, access and incomplete tests', () => {
  assert.equal(validateIsolationReport(report(), expected), true);
  for (const mutation of [
    r => r.sourceAfter='c'.repeat(64), r => r.artifactAfter='c'.repeat(64),
    r => r.network='bridge', r => r.mounts.push('/host'), r => r.disposableStorage=false,
    r => r.containsOwnerData=true, r => r.containsCredentials=true,
    r => r.tests[0].skipped=true, r => r.tests[0].reused=true, r => r.tests[0].exitCode=1,
    r => r.tests.push({...r.tests[0]}), r => delete r.tests[0].skipped,
  ]) { const candidate=report(); mutation(candidate); assert.throws(() => validateIsolationReport(candidate, expected)); }
  assert.throws(() => validateIsolationReport(report(), {...expected,tests:[]}));
});
