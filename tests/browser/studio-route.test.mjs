#!/usr/bin/env node
// Synthetic local Worker only; no mutation other than a disposable dev login.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const base=new URL(process.env.FOILBURY_URL??'http://127.0.0.1:5173');
assert.ok(base.protocol==='http:' && ['127.0.0.1','localhost'].includes(base.hostname) && !base.username && !base.password && base.pathname==='/' && !base.search && !base.hash);
const status=await (await fetch(new URL('/api/v1/status',base),{redirect:'error',signal:AbortSignal.timeout(5000)})).json();
const providers=['fal','elevenlabs','resend','adminWebhook','discordApplication','discordBot','discordOAuth','cloudflareAccess'];
assert.ok(status.name==='Foilbury' && status.environment==='local' && status.local===true && status.dev_login===true && status.configured===true && status.email==='outbox_only' && status.discord==='disabled' && status.access==='not_configured' && status.providers && providers.every(k=>status.providers[k]===false) && Object.values(status.providers).every(v=>v===false));
const browser=await chromium.launch();
try {
 const context=await browser.newContext({baseURL:base.href,viewport:{width:390,height:844}});
 assert.equal((await context.request.post('/api/v1/dev/login',{data:{email:'owner@foilbury.local'}})).status(),200);
 const page=await context.newPage(), seen=[];
 page.on('request',req=>{const url=new URL(req.url());if(url.origin===base.origin && url.pathname.startsWith('/api/v1/'))seen.push({path:url.pathname,method:req.method()});});
 await page.route('**/studio/collections',async route=>{const response=await route.fetch();await route.fulfill({response,headers:{...response.headers(),'content-security-policy':"script-src 'self'; object-src 'none'"}});});
 const collections=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/studio/collections' && r.request().method()==='GET');
 const cards=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/studio/cards' && r.request().method()==='GET');
 await page.goto('/studio/collections');
 assert.equal((await collections).status(),200);assert.equal((await cards).status(),200);
 await page.getByText('Bubbles',{exact:false}).first().waitFor();
 assert.equal(await page.evaluate(()=>typeof window.__FOILBURY_STUDIO__), 'undefined');
 assert.equal(seen.some(r=>r.path.startsWith('/api/v1/admin/')),false,'Studio must not call Access-only admin API');
 assert.equal(seen.some(r=>r.path==='/api/v1/admin/access-session'),false);
 assert.equal(seen.some(r=>r.method!=='GET'),false,'The journey must not mutate API state');
 console.log('PASS synthetic built Studio under strict script CSP: scoped collections/cards GETs succeed without inline flag or admin API calls');
 await context.close();
} finally {await browser.close();}
