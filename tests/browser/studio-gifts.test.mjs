import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';

test('scoped gift composer uses minimal choices and binds the selected variant', async (t) => {
  const root=process.cwd(), dir=fs.mkdtempSync(path.join(os.tmpdir(),'foilbury-studio-gifts-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.symlinkSync(path.join(root,'node_modules'),path.join(dir,'node_modules'));
  fs.writeFileSync(path.join(dir,'index.html'),'<div id="root"></div><script type="module" src="/entry.jsx"></script>');
  fs.writeFileSync(path.join(dir,'entry.jsx'),`import React from 'react';import {createRoot} from 'react-dom/client';import GiftComposer from '/@fs${path.join(root,'src/components/admin/GiftComposer.tsx')}';window.__FOILBURY_STUDIO__=true;createRoot(document.getElementById('root')).render(<GiftComposer scoped platformAdmin={false}/>);`);
  const server=await createServer({configFile:false,root:dir,cacheDir:path.join(dir,"vite-cache"),esbuild:{jsx:'automatic'},resolve:{alias:{'@':path.join(root,'src')}},server:{host:'127.0.0.1',port:0,fs:{allow:[root,dir]}}});
  t.after(()=>server.close());await server.listen();const address=server.httpServer.address();assert.ok(address&&typeof address==='object');
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:375,height:800}});
  const paths=[];let previewBody;
  await page.route('**/api/v1/studio/**',async route=>{
    const request=route.request(),name=new URL(request.url()).pathname;paths.push(name);let body={items:[]};
    if(name.endsWith('/gifts/recipients')) body={items:[{id:'usr_fixture',display_name:'Sample member'}]};
    if(name.endsWith('/gifts/cards')) body={items:[{id:'card_fixture',name:'Sample card',variant_id:'var_fixture'}]};
    if(name.endsWith('/gifts/policy')) body={per_recipient_foil:100,self_grants_allowed:false};
    if(name.endsWith('/gifts/preview')) {previewBody=request.postDataJSON();body={recipient_count:1,recipient_digest:'a'.repeat(64),sample:[{user_id:'usr_fixture',display_name:'Sample member',tenant_name:'Test'}],per_recipient_foil:0,total_foil:0,openings_per_recipient:0,standard_opening_price:80,standard_opening_revision:1,message:null,limits:{max_recipients:500,per_recipient_foil:100,self_grants_allowed:false}};}
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.goto(`http://127.0.0.1:${address.port}/`);
  await page.getByText('Sample member').waitFor();
  assert.ok(paths.some(p=>p.endsWith('/gifts/recipients')) && paths.some(p=>p.endsWith('/gifts/cards')));
  assert.ok(!paths.some(p=>p.endsWith('/members')||p.endsWith('/cards')&&!p.includes('/gifts/')));
  await page.getByLabel('What are you sending?').selectOption('card');
  await page.getByLabel(/Card/).selectOption('card_fixture');
  assert.equal(await page.getByRole('option',{name:'Sample card'}).count(),1);
  await page.getByLabel(/Sample member/).check();
  await page.getByPlaceholder('e.g. Community night thank-you').fill('Fixture card');
  await page.getByRole('button',{name:/preview/i}).click();
  await page.getByText('Ready to send').waitFor();
  assert.equal(previewBody.cardId,'card_fixture');assert.equal(previewBody.variantId,'var_fixture');
});
