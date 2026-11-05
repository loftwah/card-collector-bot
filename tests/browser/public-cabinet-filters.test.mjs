#!/usr/bin/env node
// Public read-only checks against a disposable local built Worker with synthetic data.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const base = new URL(process.env.FOILBURY_URL ?? 'http://127.0.0.1:5173');
assert.ok(base.protocol === 'http:' && ['127.0.0.1','localhost'].includes(base.hostname) && !base.username && !base.password && base.pathname === '/' && !base.search && !base.hash);
const status = await (await fetch(new URL('/api/v1/status',base),{redirect:'error',signal:AbortSignal.timeout(5000)})).json();
assert.ok(status.name === 'Foilbury' && status.environment === 'local' && status.local === true && status.dev_login === true && status.discord === 'disabled' && status.access === 'not_configured' && Object.values(status.providers).every(v => v === false));
const browser=await chromium.launch();
try {
 for (const js of [false,true]) {
  const context=await browser.newContext({baseURL:base.href,javaScriptEnabled:js,viewport:{width:390,height:844}});
  const page=await context.newPage();await page.goto('/cabinet');
  const collection=page.locator('a.chip[href*="collection="]').first();
  assert.equal(await collection.count(),1,'synthetic fixture must contain a public collection');
  const slug=new URL(await collection.getAttribute('href'),base).searchParams.get('collection');
  await collection.click();
  await page.getByLabel('Search cards').fill('sentinel');
  await page.getByRole('button',{name:'Search and filter'}).click();
  let url=new URL(page.url());assert.equal(url.searchParams.get('collection'),slug);assert.equal(url.searchParams.get('search'),'sentinel');
  const all=page.getByRole('link',{name:'All public'});await all.click();
  url=new URL(page.url());assert.equal(url.searchParams.get('collection'),null);assert.equal(url.searchParams.get('search'),'sentinel');
  await page.goto('/cabinet?category=unknown&tag=unknown');
  assert.equal(await page.locator('details').filter({hasText:'Category and tag filters'}).getAttribute('open'),'');
  await page.goto('/cabinet');
  for(const width of [320,390,1440]) {await page.setViewportSize({width,height:844});const geometry=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth}));assert.ok(geometry.scroll<=geometry.client+1,`${width}: ${JSON.stringify(geometry)}`);}
  const axe=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();assert.deepEqual(axe.violations.filter(v=>['serious','critical'].includes(v.impact)).map(v=>v.id),[]);
  console.log(`PASS public filters: JavaScript ${js?'on':'off'}, scope retention, responsive, axe`);await context.close();
 }
} finally {await browser.close();}
