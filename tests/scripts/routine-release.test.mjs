import test from 'node:test';
import assert from 'node:assert/strict';
import { assertMigrationParity, needsDrawLoadingCheck } from '../../scripts/lib/routine-release.mjs';

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
