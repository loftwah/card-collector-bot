#!/usr/bin/env node
// Built, disposable local Worker only; this never sends a sign-in or draw action.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const target = new URL(process.env.FOILBURY_URL ?? 'http://127.0.0.1:5173');
assert.ok(target.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(target.hostname) && !target.username && !target.password && target.pathname === '/' && !target.search && !target.hash, 'HTTP loopback origin required');
const response = await fetch(new URL('/api/v1/status', target), { redirect:'error', signal:AbortSignal.timeout(5000) });
assert.equal(response.status, 200); const status = await response.json();
assert.ok(status.name === 'Foilbury' && status.environment === 'local' && status.local === true && status.dev_login === true && status.configured === true && status.email === 'outbox_only' && status.discord === 'disabled' && status.access === 'not_configured');
const providers=['fal','elevenlabs','resend','adminWebhook','discordApplication','discordBot','discordOAuth','cloudflareAccess'];
assert.ok(status.providers && providers.every(k=>status.providers[k]===false) && Object.values(status.providers).every(v=>v===false));
const browser=await chromium.launch();
try {
 for(const js of [true,false]) for(const scheme of ['light','dark']) {
  const c=await browser.newContext({baseURL:target.origin,viewport:{width:320,height:844},javaScriptEnabled:js,colorScheme:scheme});
  try {
   const p=await c.newPage();
   for(const [route,heading] of [['/login',/the cabinet is open/i],['/cabinet',/the public showcase/i],['/journal',/notes from the cabinet/i]]) {
    await p.goto(route,{waitUntil:'networkidle'}); await p.getByRole('heading',{name:heading}).waitFor();
    await p.evaluate(()=>{document.body.style.zoom='2'});await p.evaluate(()=>document.fonts.ready);
    const size=await p.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));assert.ok(size.scroll<=size.width+1,`${route} ${js} ${scheme}: ${JSON.stringify(size)}`);
    for(const width of [320,390,1440]) {await p.evaluate(()=>{document.body.style.zoom='1'});await p.setViewportSize({width,height:844});const normal=await p.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));assert.ok(normal.scroll<=normal.width+1,`${route} normal ${width}: ${JSON.stringify(normal)}`)}
    await p.setViewportSize({width:320,height:844});await p.evaluate(()=>{document.body.style.zoom='2'});
    if(route==='/cabinet') {const card=p.locator('.card-face').first();if(await card.count()){const r=await card.boundingBox();assert.ok(r&&Math.abs(r.width/r.height-5/7)<0.02,'public card must remain 5:7')}
      // Reintroduce the reported unbreakable heading to prove the fixture catches overflow.
      const heading=p.getByRole('heading',{name:/the public showcase/i});await heading.evaluate(el=>{el.style.whiteSpace='nowrap'});assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),'negative control must overflow');await heading.evaluate(el=>{el.style.whiteSpace=''})}
    if(route==='/login') {await p.locator('body').focus();let found=false;for(let i=0;i<45;i++){await p.keyboard.press('Tab');if(await p.locator('a[href="/admin"]').first().evaluate(el=>document.activeElement===el)){found=true;break}}assert.ok(found,'admin link must be keyboard reachable')}
    if(js){const axe=await new AxeBuilder({page:p}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();assert.deepEqual(axe.violations.filter(x=>['serious','critical'].includes(x.impact)).map(x=>x.id),[],`${route} axe`)}
    for(const selector of route==='/login'?['input[type=email]','a[href="/admin"]']:route==='/cabinet'?['input[name=search]','button[type=submit]']:['a[href="/admin/editorial"]']) {
     const control=p.locator(selector).first();if(await control.isVisible()){await control.focus();const rect=await control.boundingBox();assert.ok(rect && rect.x>=-1 && rect.x+rect.width<=321,`${route} ${selector} escapes viewport`);assert.equal(await control.evaluate(el=>document.activeElement===el),true)}
    }
   }
   if(!js) { await p.goto('/cabinet',{waitUntil:'networkidle'});const search=p.locator('input[name=search]');await search.fill('Tux');await search.press('Enter');await p.waitForURL(/search=Tux/); }
   const login=await c.request.post('/api/v1/dev/login',{data:{email:'owner@foilbury.local'},maxRedirects:0});assert.equal(login.status(),200);
   await p.goto('/play/collection',{waitUntil:'networkidle'});await p.getByRole('heading',{name:/your drawers/i}).waitFor();await p.evaluate(()=>{document.body.style.zoom='2'});await p.evaluate(()=>document.fonts.ready);
   const size=await p.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));assert.ok(size.scroll<=size.width+1,`collection ${js} ${scheme}: ${JSON.stringify(size)}`);
   for(const control of [p.locator('input[name=search]'),p.locator('select[name=collection]'),p.locator('button[type=submit]').filter({hasText:'Apply'})]) {const rect=await control.first().boundingBox();assert.ok(rect && rect.x>=-1&&rect.x+rect.width<=321);await control.first().focus();assert.equal(await control.first().evaluate(el=>document.activeElement===el),true)}
   if(js){const axe=await new AxeBuilder({page:p}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();assert.deepEqual(axe.violations.filter(x=>['serious','critical'].includes(x.impact)).map(x=>x.id),[])}
   if(!js) {const search=p.locator('input[name=search]');await search.fill('fixture');await search.press('Enter');await p.waitForURL(/search=fixture/);}
   // Synthetic selected-collection fixture exercises binder and share-preview geometry.
   const fixture = process.env.FOILBURY_TEST_COLLECTION;
   if (fixture) {
     await p.goto(`/play/collection?collection=${encodeURIComponent(fixture)}`,{waitUntil:'networkidle'});
     await p.evaluate(()=>{document.body.style.zoom='2'}); await p.evaluate(()=>document.fonts.ready);
     await p.locator('.share-panel').waitFor();
     assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'selected collection overflows');
     const preview=p.locator('.share-panel__preview > :first-child');const r=await preview.boundingBox();assert.ok(r && Math.abs(r.width/r.height-5/7)<0.02,'share preview must remain 5:7');
     if(js){await p.getByRole('button',{name:'Preview & create link'}).click();await p.getByRole('group',{name:'Confirm share link'}).waitFor();assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'share confirmation overflows');await p.getByRole('button',{name:'Cancel'}).click()}
   }
   console.log(`PASS 320px/200% ${scheme} JavaScript ${js?'on':'off'}: sign-in, showcase, journal and collection`);
  } finally { await c.close(); }
 }
} finally { await browser.close(); }
