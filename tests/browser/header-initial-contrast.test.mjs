#!/usr/bin/env node
// Run against a disposable local built Worker. Delay its real stylesheet so the
// browser paints the unstyled link before the stylesheet is applied.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const base = new URL(process.env.FOILBURY_URL ?? 'http://127.0.0.1:5173');
assert.ok(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname) && !base.username && !base.password && base.pathname === '/' && !base.search && !base.hash);
const browser = await chromium.launch();
try {
  for (const negative of [true, false]) for (const scheme of ['light', 'dark']) {
    const context = await browser.newContext({baseURL: base.href, viewport:{width:1440,height:1000}, colorScheme:scheme});
    let release; const gate = new Promise(resolve => { release = resolve; });
    let sawStylesheet = false;
    await context.route('**/*.css', async route => {
      sawStylesheet = true;
      const response = await route.fetch();
      const css = await response.text();
      await gate;
      await route.fulfill({response, body: css + (negative ? '\n.site-header .btn-primary { transition: background 160ms ease, color 160ms ease; }' : '')});
    });
    await context.addInitScript(() => {
      window.__buttonTransitions = [];
      document.addEventListener('transitionrun', event => {
        if (event.target.matches('a.btn-primary[href="/login"]')) window.__buttonTransitions.push(event.propertyName);
      }, true);
    });
    const page = await context.newPage();
    const navigation = page.goto('/', {waitUntil:'load'});
    const link = page.locator('.site-header a.btn-primary[href="/login"]');
    await link.waitFor({state:'attached'});
    assert.equal(sawStylesheet, true, 'test must intercept the actual stylesheet');
    assert.equal(await link.evaluate(el => getComputedStyle(el).color), 'rgb(0, 0, 238)', 'negative control requires the unstyled browser link');
    release(); await navigation;
    await page.waitForTimeout(250);
    const events = await page.evaluate(() => window.__buttonTransitions);
    const colourEvents = events.filter(x => x === 'color' || x === 'background-color');
    if (negative) assert.ok(colourEvents.length > 0, `${scheme}: old transition must be observable`);
    else assert.deepEqual(colourEvents, [], `${scheme}: no colour animation on initial stylesheet arrival`);
    if (!negative) {
      const before = await link.evaluate(el => ({bg:getComputedStyle(el).backgroundColor, transition:getComputedStyle(el).transitionProperty}));
      await link.hover();
      const after = await link.evaluate(el => ({bg:getComputedStyle(el).backgroundColor, transition:getComputedStyle(el).transitionProperty}));
      assert.notEqual(before.bg, after.bg, `${scheme}: hover remains visible`);
      assert.match(after.transition, /transform/, `${scheme}: hover lift remains animated`);
    }
    console.log(`PASS ${scheme} ${negative ? 'negative control' : 'header initial and hover'}`);
    await context.close();
  }
} finally { await browser.close(); }
