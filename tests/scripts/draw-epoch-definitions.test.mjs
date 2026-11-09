import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('scoped draw trigger definitions match the 0033 migration', () => {
  const migration = readFileSync(new URL('../../migrations/0033_draw_scope_epochs.sql', import.meta.url), 'utf8');
  const expected = [...migration.matchAll(/CREATE TRIGGER\s+(draw_epoch_\w+).*?\bEND;/gs)].map(match => [match[1], match[0].slice(0, -1)]);
  const source = readFileSync(new URL('../../src/server/modules/draw-epoch-trigger-definitions.ts', import.meta.url), 'utf8');
  const actual = JSON.parse(source.slice(source.indexOf('=') + 1).trim().replace(/;$/, ''));
  assert.ok(expected.length > 0);
  assert.deepEqual(actual, expected);
});
