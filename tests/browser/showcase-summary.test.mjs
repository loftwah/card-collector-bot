#!/usr/bin/env node
// Run only against a disposable local Worker seeded with synthetic fixtures.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import fs from 'node:fs';
import path from 'node:path';

const base = new URL(process.env.FOILBURY_URL ?? 'http://127.0.0.1:5173');
assert.ok(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname) && !base.username && !base.password && base.pathname === '/' && !base.search && !base.hash);
const response = await fetch(new URL('/api/v1/status', base), { redirect: 'error', signal: AbortSignal.timeout(5000) });
const status = await response.json();
const providers = ['fal', 'elevenlabs', 'resend', 'adminWebhook', 'discordApplication', 'discordBot', 'discordOAuth', 'cloudflareAccess'];
assert.ok(status.name === 'Foilbury' && status.environment === 'local' && status.local === true && status.dev_login === true && status.configured === true && status.email === 'outbox_only' && status.discord === 'disabled' && status.access === 'not_configured' && status.providers && providers.every((k) => status.providers[k] === false) && Object.values(status.providers).every((v) => v === false));
fs.mkdirSync('.foilbury/evidence', { recursive: true });
const evidence = fs.mkdtempSync(path.join('.foilbury/evidence/', 'showcase-summary-'));
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ baseURL: base.href, viewport: { width: 390, height: 844 } });
  assert.equal((await context.request.post('/api/v1/dev/login', { data: { email: 'owner@foilbury.local' } })).status(), 200);
  const page = await context.newPage();
  await page.goto('/play/collection');
  const prior = page.getByRole('button', { name: /^Remove .* from favourites/i });
  if (await prior.count()) {
    await prior.first().click();
    await page.getByRole('button', { name: /^Favourite /i }).first().waitFor();
  }
  for (const [label, expected] of [
    ['empty', 0],
    ['populated', 1],
  ]) {
    if (expected) {
      await page.goto('/play/collection');
      const favourite = page.getByRole('button', { name: /^Favourite /i }).first();
      await favourite.click();
      await page.getByRole('button', { name: /^Remove .* from favourites/i }).first().waitFor();
    }
    await page.goto('/play/profile', { waitUntil: 'networkidle' });
    const inventory = await (await context.request.get('/api/v1/inventory?favourite=true&limit=120')).json();
    const achievements = await (await context.request.get('/api/v1/achievements')).json();
    const collections = await (await context.request.get('/api/v1/collections')).json();
    assert.ok(Array.isArray(inventory.items) && Array.isArray(achievements.items) && Array.isArray(collections.items));
    assert.equal(inventory.items.length, expected, 'fixture must exercise both empty and populated favourites');
    assert.equal(
      await page.locator('.profile-stats div').filter({ hasText: 'Favourites' }).locator('dd').innerText(),
      String(inventory.items.length),
    );
    assert.equal(
      await page.locator('.profile-stats div').filter({ hasText: 'Badges' }).locator('dd').innerText(),
      String(achievements.items.filter((x) => x.state === 'earned').length),
    );
    assert.equal(await page.getByText('Subjects held', { exact: true }).count(), 0);
    assert.equal(await page.getByRole('heading', { name: 'Your shelf' }).count(), 1);
    assert.equal(await page.locator('.profile-look').count(), 4);
    for (const look of ['Quiet archive', 'Signal room', 'Binder desk', 'Night shelf']) {
      assert.equal(await page.locator('.profile-look').filter({ hasText: look }).count(), 1);
    }
    if (expected === 0) {
      assert.equal(await page.getByText('Your shelf is waiting.').count(), 1);
    } else {
      assert.ok((await page.locator('.profile-card').count()) > 0);
    }
    for (const collection of collections.items.slice(0, 3)) {
      assert.equal(await page.locator('.profile-worlds').getByText(collection.name, { exact: true }).count(), 1);
    }
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      const geom = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
      assert.ok(geom.scroll <= geom.width + 1, `${label} ${width}: ${JSON.stringify(geom)}`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => {
      document.body.style.zoom = '2';
    });
    const zoom = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
    assert.ok(zoom.scroll <= zoom.width + 1, `${label} 200%: ${JSON.stringify(zoom)}`);
    await page.evaluate(() => {
      document.body.style.zoom = '';
    });
    const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    assert.deepEqual(axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id), []);
    await page.screenshot({ path: path.join(evidence, `${label}.png`), fullPage: true });
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    const darkAxe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    assert.deepEqual(darkAxe.violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id), []);
    await page.screenshot({ path: path.join(evidence, `${label}-dark.png`), fullPage: true });
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
    console.log(`PASS ${label}: real synthetic inventory/achievement/collection data, responsive and axe`);
  }
  console.log(`Evidence: ${evidence}`);
  await context.close();
} finally {
  await browser.close();
}
