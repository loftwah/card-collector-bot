import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('NPC reconciliation asks explicitly and reports the real result', async (t) => {
  const root=process.cwd(), dir=fs.mkdtempSync(path.join(os.tmpdir(),'foilbury-npc-ui-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.symlinkSync(path.join(root,'node_modules'),path.join(dir,'node_modules'));
  fs.writeFileSync(path.join(dir,'index.html'),'<!doctype html><html lang="en"><head><title>NPC collectors</title></head><body><div id="root"></div><script type="module" src="/entry.jsx"></script></body></html>');
  fs.writeFileSync(path.join(dir,'fixture.css'),`@import '/@fs${path.join(root,'src/styles/global.css')}';\n@source '${path.join(root,'src')}';`);
  fs.writeFileSync(path.join(dir,'entry.jsx'),`import './fixture.css';import React from 'react';import {createRoot} from 'react-dom/client';import Studio from '/@fs${path.join(root,'src/components/admin/NpcStudio.tsx')}';createRoot(document.getElementById('root')).render(<Studio/>);`);
  const server=await createServer({configFile:false,root:dir,plugins:[tailwindcss()],cacheDir:path.join(dir,'.vite'),esbuild:{jsx:'automatic'},resolve:{alias:{'@':path.join(root,'src')}},server:{host:'127.0.0.1',port:0,strictPort:true,fs:{allow:[root,dir]}}});
  t.after(()=>server.close());await server.listen();
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  const context=await browser.newContext({viewport:{width:375,height:800}});const page=await context.newPage();
  const npc={id:'npc-fixture',name:'Orbit',slug:'orbit',preset_key:'rookie',preset_label:'Rookie',avatar_url:null,bio:'A fictional collector.',status:'active',goals:{},schedule:{},actions_count:0,last_action_at:null,synthetic_label:'NPC',cards:0,subjects:0,gold:0,holographic:0,balance:100};
  let status='planned', legacyStatus='failed', calls=0;
  await page.route('**/api/v1/**',async route=>{
    const url=new URL(route.request().url());let body;
    if(url.pathname==='/api/v1/npcs/admin') body={items:[npc],presets:[{key:'rookie',label:'Rookie',description:'',behaviour:''}],limits:{max_npcs:20,max_draws_per_day:40,paused_all:0},action_counts:{},cap:{max_batch:10,synthetic_label:'NPC'}};
    else if(url.pathname==='/api/v1/collections') body={items:[]};
    else if(url.pathname.endsWith('/actions')) body={items:[{id:'action-fixture',status,reason:'Previously planned',pool_slug:'starter',amount:80,created_at:'2026-11-04T00:00:00Z',after:{}},{id:'legacy-fixture',status:legacyStatus,reason:'Legacy failure',pool_slug:'legacy',amount:80,created_at:'2026-11-04T00:00:00Z',after:legacyStatus==='skipped'?{previous_status:'failed'}:{}}]};
    else if(url.pathname.endsWith('/reconcile')) { calls++;const {actionId}=route.request().postDataJSON();assert.ok(['action-fixture','legacy-fixture'].includes(actionId));if(actionId==='action-fixture') status='skipped';else legacyStatus='skipped';body={status:'skipped',resolution:'no_draw_committed'}; }
    else return route.fulfill({status:404,body:'{}'});
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
  await page.getByRole('button',{name:'Receipts'}).click();
  const dialog=page.getByRole('dialog');await dialog.getByText('Outcome not yet confirmed.').first().waitFor();
  await dialog.getByRole('button',{name:'Review unresolved action'}).first().click();
  await dialog.getByText(/may stop an opening still in progress/i).waitFor();assert.equal(calls,0);
  await dialog.getByRole('button',{name:'Confirm reconciliation'}).focus();
  await page.keyboard.press('Enter');
  await dialog.getByRole('status').getByText(/No draw was committed/).waitFor();assert.equal(calls,1);
  await dialog.getByRole('button',{name:'Review unresolved action'}).click();
  await dialog.getByRole('button',{name:'Confirm reconciliation'}).click();
  await dialog.getByText(/previously failed/).waitFor();assert.equal(calls,2);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),true);
  const axe=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();
  assert.deepEqual(axe.violations.filter(v=>['serious','critical'].includes(v.impact)).map(v=>v.id),[]);
  const parent=path.join(root,'.foilbury/evidence');fs.mkdirSync(parent,{recursive:true});const evidence=fs.mkdtempSync(path.join(parent,'npc-reconcile-'));
  await page.screenshot({path:path.join(evidence,'reconciled-mobile.png'),fullPage:true});
});
