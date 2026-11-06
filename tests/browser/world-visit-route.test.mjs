#!/usr/bin/env node
// Only run against a disposable, seeded local Worker.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const base=new URL(process.env.FOILBURY_URL??'http://127.0.0.1:5173');
assert.ok(base.protocol==='http:' && ['127.0.0.1','localhost'].includes(base.hostname) && !base.username && !base.password && base.pathname==='/' && !base.search && !base.hash);
const status=await (await fetch(new URL('/api/v1/status',base),{redirect:'error',signal:AbortSignal.timeout(5000)})).json();
const providers=['fal','elevenlabs','resend','adminWebhook','discordApplication','discordBot','discordOAuth','cloudflareAccess'];
assert.ok(status.name==='Foilbury' && status.environment==='local' && status.local===true && status.dev_login===true && status.configured===true && status.email==='outbox_only' && status.discord==='disabled' && status.access==='not_configured' && status.providers && providers.every(k=>status.providers[k]===false) && Object.values(status.providers).every(v=>v===false));
await mkdir('.foilbury/tmp',{recursive:true}); const evidence=await mkdtemp(path.resolve('.foilbury/tmp/world-visit-'));
const browser=await chromium.launch();
try {
 const context=await browser.newContext({baseURL:base.href,javaScriptEnabled:false,viewport:{width:390,height:844}});
 assert.equal((await context.request.post('/api/v1/dev/login',{data:{email:'owner@foilbury.local'}})).status(),200);
 const list=await (await context.request.get('/api/v1/collections')).json(); const world=list.items.find(c=>c.slug==='bubbles'); assert.ok(world?.id);
 const detail=`/api/v1/collections/${encodeURIComponent(world.id)}`, post=`/play/world/${encodeURIComponent(world.id)}/explore`, pageUrl=`/play/collection?collection=${encodeURIComponent(world.slug)}`;
 async function progress(){const data=await (await context.request.get('/api/v1/missions/daily')).json();const item=data.missions.find(m=>m.key==='explore');assert.ok(item);return item.progress;}
 assert.equal(await progress(),0,'fixture needs a fresh visit');
 assert.equal((await context.request.get(detail,{headers:{purpose:'prefetch'}})).status(),200); assert.equal(await progress(),0,'GET/prefetch must not record');
 assert.equal((await context.request.get(post)).status(),405);assert.equal((await context.request.post(post,{form:{csrf:'invalid'}})).status(),403);assert.equal(await progress(),0);
 const page=await context.newPage();await page.goto(pageUrl);await page.getByRole('button',{name:'Record world visit'}).waitFor();assert.equal(await progress(),0);
 const violations=(await new AxeBuilder({page}).analyze()).violations.filter(v=>['serious','critical'].includes(v.impact));assert.deepEqual(violations,[]);
 await page.screenshot({path:path.join(evidence,'no-js-before.png'),fullPage:true});
 await page.getByRole('button',{name:'Record world visit'}).click();await page.getByRole('heading',{name:'World visit recorded'}).waitFor();assert.equal(await progress(),1);
 await page.screenshot({path:path.join(evidence,'no-js-confirmed.png'),fullPage:true});await context.close();
 const js=await browser.newContext({baseURL:base.href,viewport:{width:320,height:700}});assert.equal((await js.request.post('/api/v1/dev/login',{data:{email:'owner@foilbury.local'}})).status(),200);
 const interactive=await js.newPage();await interactive.goto(pageUrl);const action=interactive.getByRole('button',{name:'Record world visit'});await action.focus();assert.equal(await action.evaluate(el=>document.activeElement===el),true);assert.equal(await interactive.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await interactive.screenshot({path:path.join(evidence,'keyboard-focused.png'),fullPage:true});await interactive.keyboard.press('Enter');await interactive.getByRole('heading',{name:'World visit recorded'}).waitFor();
 await interactive.screenshot({path:path.join(evidence,'keyboard-confirmed.png'),fullPage:true});await js.close();
 console.log(`PASS synthetic Worker GET/prefetch, CSRF, no-JS and keyboard visit; evidence ${evidence}`);
} finally {await browser.close();}
