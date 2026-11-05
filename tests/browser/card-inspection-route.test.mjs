#!/usr/bin/env node
// Only run against a disposable, seeded local Worker; uses one synthetic owned copy.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const base=new URL(process.env.FOILBURY_URL??'http://127.0.0.1:5173');
assert.ok(base.protocol==='http:' && ['127.0.0.1','localhost'].includes(base.hostname) && !base.username && !base.password && base.pathname==='/' && !base.search && !base.hash);
const status=await (await fetch(new URL('/api/v1/status',base),{redirect:'error',signal:AbortSignal.timeout(5000)})).json();
const providers=['fal','elevenlabs','resend','adminWebhook','discordApplication','discordBot','discordOAuth','cloudflareAccess'];
assert.ok(status.name==='Foilbury' && status.environment==='local' && status.local===true && status.dev_login===true && status.configured===true && status.email==='outbox_only' && status.discord==='disabled' && status.access==='not_configured' && status.providers && providers.every(k=>status.providers[k]===false) && Object.values(status.providers).every(v=>v===false));
const browser=await chromium.launch();
try {
 const context=await browser.newContext({baseURL:base.href,javaScriptEnabled:false,viewport:{width:390,height:844}});
 assert.equal((await context.request.post('/api/v1/dev/login',{data:{email:'owner@foilbury.local'}})).status(),200);
 const inventory=await (await context.request.get('/api/v1/inventory?limit=1')).json();assert.equal(inventory.items.length,1,'fixture needs a synthetic owned copy');
 const id=inventory.items[0].id, card=`/play/card/${encodeURIComponent(id)}`, post=`${card}/inspect`;
 async function progress(){const data=await (await context.request.get('/api/v1/missions/daily')).json();const item=data.missions.find(m=>m.key==='inspect');assert.ok(item,'fixture must assign inspect mission');return item.progress;}
 assert.equal(await progress(),0,'fresh fixture must have no inspection');
 assert.equal((await context.request.get(card,{headers:{purpose:'prefetch'}})).status(),200);
 assert.equal(await progress(),0,'GET/prefetch must not record an inspection');
 assert.equal((await context.request.get(post)).status(),405);
 assert.equal((await context.request.post(post,{form:{csrf:'incorrect'}})).status(),403);
 assert.equal(await progress(),0,'invalid CSRF must not record an inspection');
 const page=await context.newPage();await page.goto(card);assert.equal(await progress(),0,'page rendering without JavaScript must not record');
 await page.getByRole('button',{name:'Record inspection for daily missions'}).click();
 await page.getByRole('heading',{name:'Inspection recorded'}).waitFor();assert.equal(await progress(),1);
 assert.equal((await context.request.post(post,{form:{csrf:'incorrect'}})).status(),403);
 await context.close();
 const js=await browser.newContext({baseURL:base.href,viewport:{width:390,height:844}});assert.equal((await js.request.post('/api/v1/dev/login',{data:{email:'owner@foilbury.local'}})).status(),200);
 const interactive=await js.newPage();
 let releaseHydration; const hydrationGate = new Promise(resolve => { releaseHydration = resolve; });
 await interactive.route('**/_astro/CardInspector*.js', async route => { await hydrationGate; await route.continue(); });
 await interactive.goto(card, {waitUntil:'domcontentloaded'});
 await interactive.getByRole('button',{name:'View back'}).waitFor();
 assert.equal(await interactive.getByRole('button',{name:'View back'}).isDisabled(), true, 'pre-hydration control must not accept a lost click');
 assert.equal(await interactive.getByRole('button',{name:'Inspect in 3D'}).isDisabled(), true);
 releaseHydration();await interactive.locator('astro-island[component-export=default]').first().waitFor({state:'attached'});await interactive.waitForFunction(() => [...document.querySelectorAll('astro-island')].every(island => !island.hasAttribute('ssr')));await interactive.getByRole('button',{name:'View back'}).click();
 await interactive.getByText('Inspection recorded for today’s missions.').waitFor();
 console.log('PASS real synthetic card route: GET/prefetch and bad CSRF do not record; no-JS and JS deliberate actions confirm the same daily inspection');
 await js.close();
} finally {await browser.close();}
