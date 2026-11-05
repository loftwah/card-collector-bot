import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import path from 'node:path';
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('only an explicit card flip records inspection, with honest failure and retry', {timeout:60000}, async()=>{
  const cwd=process.cwd(); await mkdir(path.join(cwd,'.foilbury/tmp'),{recursive:true});
  const dir=await mkdtemp(path.join(cwd,'.foilbury/tmp/inspection-intent-'));
  const inspector=path.join(cwd,'src/components/player/CardInspector.tsx'), styles=path.join(cwd,'src/styles/global.css');
  await writeFile(path.join(dir,'index.html'),'<html lang="en"><head><title>Inspection fixture</title><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="foilbury-csrf" content="fixture"></head><body><main id="root"></main><script type="module" src="./main.tsx"></script></body></html>');
  await writeFile(path.join(dir,'main.tsx'),`import React from 'react';import {createRoot} from 'react-dom/client';import CardInspector from ${JSON.stringify(inspector)};import ${JSON.stringify(styles)};createRoot(document.getElementById('root')!).render(<CardInspector name="Synthetic card" finish="Plain" frontUrl="/brand/card-back.webp" backUrl="/brand/card-back.webp" inspectionInstanceId={location.search ? undefined : "fixture-copy"}/>);`);
  await writeFile(path.join(dir,'vite.config.mjs'),`import {defineConfig} from 'vite';import tailwindcss from '@tailwindcss/vite';export default defineConfig({plugins:[tailwindcss()],root:${JSON.stringify(cwd)},publicDir:${JSON.stringify(path.join(cwd,'public'))},esbuild:{jsx:'automatic',tsconfigRaw:{compilerOptions:{jsx:'react-jsx'}}},resolve:{alias:{'@':${JSON.stringify(path.join(cwd,'src'))}}},server:{host:'127.0.0.1',port:0}});`);
  const server=spawn(path.join(cwd,'node_modules/.bin/vite'),['--config',path.join(dir,'vite.config.mjs')],{cwd,stdio:['ignore','pipe','pipe']});let output='';
  const url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(`Vite did not start: ${output}`)),15000);const data=chunk=>{output=stripVTControlCharacters(output+String(chunk));const found=output.match(/http:\/\/127\.0\.0\.1:\d+\//);if(found){clearTimeout(timer);resolve(found[0]);}};server.stdout.on('data',data);server.stderr.on('data',data);server.once('exit',code=>{clearTimeout(timer);reject(Error(`Vite exited ${code}: ${output}`));});}).catch(error=>{server.kill('SIGTERM');throw error;});
  const browser=await chromium.launch();
  try {
    for(const [width,motion] of [[320,'no-preference'],[390,'reduce'],[1280,'no-preference']]) {
      const context=await browser.newContext({viewport:{width,height:844},reducedMotion:motion}); const page=await context.newPage();let calls=0;
      await page.route('**/api/v1/missions/inspect/fixture-copy',async route=>{calls++;assert.equal(route.request().method(),'POST');assert.equal(route.request().headers()['x-foilbury-csrf'],'fixture');await route.fulfill(calls===1?{status:503,json:{error:{message:'Unavailable'}}}:calls===2?{status:200,json:{}}:{status:200,json:{recorded:true,day:calls===3?'2026-11-05':'2026-11-06'}});});
      await page.goto(new URL(path.relative(cwd,dir)+'/index.html',url).href,{waitUntil:'networkidle'});assert.equal(calls,0,'load and hydration must not record inspection');
      const group=page.getByRole('group',{name:/card inspector/i});await group.focus();await page.keyboard.press('f');
      await page.getByText('Couldn’t record this inspection.').waitFor();assert.equal(calls,1);
      await page.getByRole('button',{name:'Retry',exact:true}).click();await page.getByText('Couldn’t record this inspection.').waitFor();assert.equal(calls,2,'malformed success is not confirmation');await page.getByRole('button',{name:'Retry',exact:true}).click();await page.getByText('Inspection recorded for today’s missions.').waitFor();assert.equal(calls,3);
      await page.getByRole('button',{name:'View front'}).click();await page.getByRole('button',{name:'View back'}).click();await page.getByText('Inspection recorded for today’s missions.').waitFor();assert.equal(calls,4,'a new deliberate flip rechecks the server period');
      const violations=(await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze()).violations.filter(v=>['serious','critical'].includes(v.impact));assert.deepEqual(violations.map(v=>v.id),[]);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1),`${width} overflow`);
      await page.screenshot({path:path.join(dir,`intent-${width}.png`),fullPage:true});await context.close();
    }
    const context=await browser.newContext({viewport:{width:390,height:844}});const page=await context.newPage();let requests=0;
    await page.route('**/api/v1/missions/inspect/**',async route=>{requests++;await route.abort();});
    await page.goto(new URL(path.relative(cwd,dir)+'/index.html?not-owned=1',url).href,{waitUntil:'networkidle'});
    await page.getByRole('button',{name:'View back'}).click();assert.equal(requests,0,'an inspector without an owned copy must never post');
    assert.equal(await page.getByText('Inspection recorded for today’s missions.').count(),0);
    await context.close();
    console.log(`Synthetic component evidence: ${dir}`);
  } finally {await browser.close();server.kill('SIGTERM');}
});
