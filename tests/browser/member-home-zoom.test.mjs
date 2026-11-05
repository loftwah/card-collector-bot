#!/usr/bin/env node
// Built local Worker; FOILBURY_URL must point to an isolated, seeded instance.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const baseURL = process.env.FOILBURY_URL ?? 'http://127.0.0.1:5173';
const browser = await chromium.launch();
try {
  for (const scheme of ['light', 'dark']) {
    const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, colorScheme: scheme });
    const login = await context.request.post('/api/v1/dev/login', { data: { email: 'owner@foilbury.local' } });
    assert.equal(login.status(), 200, 'requires an isolated seeded dev-login fixture');
    const page = await context.newPage();
    await page.goto('/play', { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: /your cabinet/i }).waitFor();
    const claim = page.getByRole('button', { name: /claim daily allowance/i });
    assert.equal(await claim.count(), 1, 'fixture must have a claimable positive allowance');
    const measure = () => page.evaluate(() => ({ viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
    for (const width of [320, 720, 390]) {
      await page.setViewportSize({ width, height: 844 });
      const normal = await measure();
      assert.ok(normal.content <= normal.viewport + 1, `${scheme} ${width}px: ${JSON.stringify(normal)}`);
    }
    await page.evaluate(() => { document.body.style.zoom = '2'; });
    const actual = await measure();
    assert.ok(actual.content <= actual.viewport + 1, `${scheme}: ${JSON.stringify(actual)}`);
    const bounds = await claim.evaluate((el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, height: r.height, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }; });
    assert.ok(bounds.left >= 0 && bounds.right <= 391 && bounds.scrollHeight <= bounds.clientHeight + 1, `claim control clips: ${JSON.stringify(bounds)}`);
    await page.locator('body').focus();
    let reached = false;
    for (let i = 0; i < 50; i++) {
      await page.keyboard.press('Tab');
      if (await claim.evaluate(el => document.activeElement === el)) { reached = true; break; }
    }
    assert.ok(reached, 'allowance button must be reachable by keyboard');
    const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    assert.deepEqual(axe.violations.filter(v => ['serious', 'critical'].includes(v.impact)).map(v => v.id), []);
    // Prove this fixture detects the original unbreakable button regression.
    await claim.evaluate(el => { el.style.whiteSpace = 'nowrap'; el.style.maxWidth = 'none'; });
    const negative = await measure();
    assert.ok(negative.content > negative.viewport + 1, `negative control failed: ${JSON.stringify(negative)}`);
    console.log(`PASS ${scheme}: 200% zoom, reachable control, axe and overflow negative control`);
    await context.close();
  }
} finally { await browser.close(); }
