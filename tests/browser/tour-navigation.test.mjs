#!/usr/bin/env node
// Read-only, against a disposable local built Worker with synthetic fixtures.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const base=new URL(process.env.FOILBURY_URL??'http://127.0.0.1:5173');
assert.ok(base.protocol==='http:' && ['127.0.0.1','localhost'].includes(base.hostname) && !base.username && !base.password && base.pathname==='/' && !base.search && !base.hash);
const status=await (await fetch(new URL('/api/v1/status',base),{redirect:'error',signal:AbortSignal.timeout(5000)})).json();
assert.ok(status.name==='Foilbury' && status.environment==='local' && status.local===true && status.dev_login===true && status.discord==='disabled' && status.access==='not_configured' && Object.values(status.providers).every(v=>v===false));
const browser=await chromium.launch();
try {
 for(const js of [false,true]) {
  const context=await browser.newContext({baseURL:base.href,javaScriptEnabled:js,viewport:{width:390,height:844},reducedMotion:'reduce'});
  const page=await context.newPage();await page.goto('/tour');
  const start=page.getByRole('link',{name:'Start the tour'});assert.equal(await start.getAttribute('href'),'#step-1');
  const names=['What Foilbury is','A real set','Free play','Inspect the object','Progress and mastery','Show it off'];
  for(let i=0;i<6;i++) { const link=page.getByRole('link',{name:names[i],exact:true}); assert.equal(await link.getAttribute('href'),`#step-${i+1}`); assert.equal(await page.locator(`#step-${i+1}`).count(),1); const r=await link.boundingBox();assert.ok(r && r.height>=44,`section ${i+1} touch target`); }
  await start.focus();assert.equal(await start.evaluate(el=>document.activeElement===el),true);await page.keyboard.press('Enter');assert.equal(new URL(page.url()).hash,'#step-1');assert.equal(await page.evaluate(()=>document.activeElement?.id),'step-1');
  await page.getByRole('link',{name:'Show it off',exact:true}).click();assert.equal(new URL(page.url()).hash,'#step-6');
  const end=page.getByRole('navigation',{name:'End of tour'});assert.equal(await end.getByText("You've reached the end of the tour.").count(),1);assert.equal(await end.getByRole('link',{name:'Back to the start'}).getAttribute('href'),'#step-1');
  await page.goto('/tour?step=3.8');assert.equal(await page.getByRole('link',{name:'Go to section 3'}).getAttribute('href'),'#step-3');
  for(const width of [320,390,1440]){await page.setViewportSize({width,height:844});const d=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth}));assert.ok(d.scroll<=d.client+1,`${width}: ${JSON.stringify(d)}`);}
  for (const width of [320,390]) for (const zoom of [1,2]) {
    await page.setViewportSize({width,height:844}); await page.goto('/tour');
    await page.evaluate(value=>document.body.style.zoom=String(value),zoom);
    const section=page.locator('#step-1');
    const layout=await section.evaluate(e=>({index:e.children[0].getBoundingClientRect().top,content:e.children[1].getBoundingClientRect().top}));
    assert.ok(layout.content>layout.index, `${width} at ${zoom}x: section index should stack above content`);
    await page.getByRole('link',{name:'Start the tour'}).click();
    const geometry=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth,header:document.querySelector('.site-header').getBoundingClientRect().bottom,heading:document.querySelector('#step-1 h2').getBoundingClientRect().top,viewport:innerHeight,active:document.activeElement?.id}));
    assert.ok(geometry.scroll<=geometry.client+1,`${width} at ${zoom}x: ${JSON.stringify(geometry)}`);
    assert.equal(geometry.active,'step-1');
    assert.ok(geometry.heading>=geometry.header-1 && geometry.heading<geometry.viewport,`${width} at ${zoom}x: heading covered by header or outside viewport: ${JSON.stringify(geometry)}`);
  }
  await page.evaluate(()=>document.body.style.zoom='');
  if(js){const a=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();assert.deepEqual(a.violations.filter(v=>['serious','critical'].includes(v.impact)).map(v=>v.id),[]);}
  console.log(`PASS tour anchors and keyboard, JavaScript ${js?'on':'off'}, responsive${js?', axe':''}`);await context.close();
 }
} finally {await browser.close();}
