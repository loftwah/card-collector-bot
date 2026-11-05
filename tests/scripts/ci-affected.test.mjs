import test from 'node:test';
import assert from 'node:assert/strict';
import { affectedJourneys } from '../../scripts/ci-affected.mjs';
test('scope browser checks to affected product behavior', () => {
  assert.deepEqual(affectedJourneys(['docs/AGENT_GUIDE.md']), {auth:false,editorial:false,album:false,privacy:false,browser:false});
  assert.equal(affectedJourneys(['src/pages/api/v1/auth/login.ts']).auth, true);
  assert.equal(affectedJourneys(['src/pages/journal/index.astro']).editorial, true);
  assert.equal(affectedJourneys(['src/server/modules/visibility.ts']).privacy, true);
  assert.equal(affectedJourneys(['src/server/modules/pools.ts']).album, true);
  assert.equal(affectedJourneys(['src/server/discord/scope.ts']).privacy, true);
  assert.equal(affectedJourneys(['src/server/api/public.ts']).privacy, true);
  assert.equal(affectedJourneys(['src/pages/s/[token].astro']).privacy, true);
  assert.equal(affectedJourneys(['src/server/modules/imports.ts']).album, true);
  assert.equal(affectedJourneys(['src/styles/global.css']).browser, false);
  assert.equal(affectedJourneys(['src/components/player/DrawStudio.tsx']).browser, false);
  assert.equal(affectedJourneys(['src/components/player/CollectionBrowser.tsx']).privacy, true);
  assert.deepEqual(affectedJourneys(['migrations/0028_new.sql']), {auth:true,editorial:true,album:true,privacy:true,browser:true});
  assert.deepEqual(affectedJourneys(['pnpm-lock.yaml']), {auth:true,editorial:true,album:true,privacy:true,browser:true});
});
