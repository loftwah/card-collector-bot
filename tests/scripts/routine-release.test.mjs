import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertMigrationParity,
  assertReleaseBudget,
  needsDrawLoadingCheck,
  releaseBudget,
  PRE_DEPLOY_BUDGET_SECONDS,
  RELEASE_BUDGET_SECONDS,
} from '../../scripts/lib/routine-release.mjs';

test('routine release rejects unreadable, changed, duplicated or reordered production migrations', () => {
  const schema = ['0001_first.sql', '0002_second.sql'];
  assert.deepEqual(assertMigrationParity(schema, schema), schema);
  for (const remote of [null, [], ['0001_first.sql'], [...schema].reverse(), [...schema, schema[0]], ['0001_first.sql', '../escape.sql']]) {
    assert.throws(() => assertMigrationParity(schema, remote), /migrations differ/);
  }
});

test('draw loading verification follows either affected route or component', () => {
  assert.equal(needsDrawLoadingCheck(['src/components/player/DrawStudio.tsx']), true);
  assert.equal(needsDrawLoadingCheck(['src/pages/play/draw.astro']), true);
  assert.equal(needsDrawLoadingCheck(['docs/AGENT_GUIDE.md']), false);
});

test('release budget is five minutes and fails closed before deployment', () => {
  assert.equal(RELEASE_BUDGET_SECONDS, 300);
  assert.equal(PRE_DEPLOY_BUDGET_SECONDS, 240);
  assert.deepEqual(releaseBudget(120), {
    limit_seconds: 300,
    elapsed_seconds: 120,
    remaining_seconds: 180,
    within_budget: true,
  });
  assert.equal(releaseBudget(300).within_budget, true);
  assert.equal(releaseBudget(300.1).within_budget, false);
  assert.equal(assertReleaseBudget(120).remaining_seconds, 180);
  assert.throws(() => assertReleaseBudget(301), /over its 300s budget/);
  assert.throws(() => assertReleaseBudget(241, PRE_DEPLOY_BUDGET_SECONDS), /over its 240s budget/);
});
