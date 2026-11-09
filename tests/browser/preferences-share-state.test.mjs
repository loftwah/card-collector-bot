import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';

test('share management reports loading and failure honestly and reconciles a partial revoke', async (t) => {
  const root = process.cwd();
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'foilbury-preferences-browser-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(fixture, 'node_modules'));
  fs.writeFileSync(path.join(fixture, 'index.html'), '<!doctype html><html><head><meta name="foilbury-csrf" content="fixture"></head><body><main id="root"></main><script type="module" src="/entry.jsx"></script></body></html>');
  fs.writeFileSync(path.join(fixture, 'entry.jsx'), `import React from 'react'; import {createRoot} from 'react-dom/client'; import PreferenceForm from ${JSON.stringify(`/@fs${path.join(root, 'src/components/player/PreferenceForm.tsx')}`)}; createRoot(document.getElementById('root')).render(<PreferenceForm initial={{hidden_collection_ids:[],hide_tags:[],reduced_motion:false,sound_enabled:false,sharing_enabled:true}} tags={[]} collections={[]}/>);`);
  const server = await createServer({ root: fixture, configFile: false, logLevel: 'silent', esbuild: { jsx: 'automatic' }, resolve: { alias: { '@': path.join(root, 'src') } }, server: { host: '127.0.0.1', port: 0, fs: { allow: [root, fixture] } } });
  t.after(() => server.close());
  await server.listen();
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 320, height: 568 } });
  let release;
  const first = new Promise(resolve => { release = resolve; });
  let reads = 0;
  const links = ['a', 'b'].map(id => ({ id, kind: 'card', status: 'active', created_at: '2026-01-01', expires_at: '2027-01-01', preview: { card_name: `Card ${id}` } }));
  await page.route('**/api/v1/shares**', async route => {
    const req = route.request();
    if (req.method() === 'GET') {
      reads++;
      if (reads === 1) { await first; return route.fulfill({ status: 503, json: { error: { message: 'Unavailable' } } }); }
      return route.fulfill({ json: { items: links } });
    }
    if (req.url().includes('/a/revoke')) { links[0].status = 'revoked'; return route.fulfill({ json: { ok: true } }); }
    return route.fulfill({ status: 503, json: { error: { message: 'Revoke failed' } } });
  });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
  await page.getByRole('status').getByText('Loading share links…').waitFor();
  assert.equal(await page.getByText('No share links have been created.').count(), 0);
  release();
  await page.getByRole('alert').getByText('Share links could not be loaded. Existing links may still be active.').waitFor();
  assert.equal(await page.getByText('No share links have been created.').count(), 0);
  const retry = page.getByRole('button', { name: 'Retry loading shares' });
  await retry.focus();
  await page.keyboard.press('Enter');
  await page.getByText('Card a').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Revoke', exact: true }).count(), 2);
  await page.getByRole('button', { name: 'Revoke all active' }).click();
  await page.getByRole('alert').getByText(/Some links may already have been revoked/).waitFor();
  await page.getByText(/card · revoked/).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Revoke', exact: true }).count(), 1);
  assert.equal(await page.getByText('Card b').count(), 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  links.splice(0);
  await page.reload();
  await page.getByText('No share links have been created.').waitFor();
});
