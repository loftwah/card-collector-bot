#!/usr/bin/env node
// Synthetic local Worker only; no mutation other than a disposable dev login.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
 // Astro currently emits inline hydration code. The fixture authorises the
 // exact scripts in this response by hash, not unsafe-inline; it does not
 // establish that the deployed CSP has those hashes configured.
 await page.route('**/studio/collections',async route=>{
  if (!route.request().isNavigationRequest()) return route.continue();
  const response=await route.fetch();const body=await response.text();
  const scripts=[...body.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter(match=>! /\bsrc\s*=/i.test(match[1])).map(match=>match[2]);
  assert.ok(scripts.length>0,'fixture expects Astro inline hydration');
  assert.ok(scripts.every(script=>!script.includes('__FOILBURY_STUDIO__')),'legacy inline routing flag must be absent');
  const hashes=scripts.map(script=>`'sha256-${createHash('sha256').update(script).digest('base64')}'`).join(' ');
  await route.fulfill({response,body,headers:{...response.headers(),'content-security-policy':`script-src 'self' ${hashes}; object-src 'none'`}});
 });
 const collections=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/studio/collections' && r.request().method()==='GET');
 const cards=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/studio/cards' && r.request().method()==='GET');
 await page.goto('/studio/collections');
 assert.equal((await collections).status(),200);assert.equal((await cards).status(),200);
 await page.getByText('Bubbles',{exact:false}).first().waitFor();
 assert.equal(await page.evaluate(()=>typeof window.__FOILBURY_STUDIO__), 'undefined');
 assert.equal(seen.some(r=>r.path.startsWith('/api/v1/admin/')),false,'Studio must not call Access-only admin API');
 assert.equal(seen.some(r=>r.path==='/api/v1/admin/access-session'),false);
 assert.equal(seen.some(r=>r.method!=='GET'),false,'The journey must not mutate API state');
 console.log('PASS synthetic built Studio under hash-authorised Astro CSP: scoped collections/cards GETs succeed without inline flag or admin API calls');
 await context.close();
} finally {await browser.close();}
