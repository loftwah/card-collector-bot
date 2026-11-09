import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createServer} from 'vite';import tailwindcss from '@tailwindcss/vite';import {chromium} from '@playwright/test';

test('a reviewer sees the exact image and failed or revoked approvals require a fresh review',async(t)=>{
 const root=process.cwd(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'foilbury-brand-review-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.symlinkSync(path.join(root,'node_modules'),path.join(dir,'node_modules'));
 fs.writeFileSync(path.join(dir,'index.html'),'<div id="root"></div><script type="module" src="/entry.jsx"></script>');
 fs.writeFileSync(path.join(dir,'fixture.css'),`@import '/@fs${path.join(root,'src/styles/global.css')}';\n@source '${path.join(root,'src')}';`);
 fs.writeFileSync(path.join(dir,'entry.jsx'),`import './fixture.css';import React from 'react';import {createRoot} from 'react-dom/client';import AdminCollections from '/@fs${path.join(root,'src/components/admin/AdminCollections.tsx')}';window.__FOILBURY_STUDIO__=true;createRoot(document.getElementById('root')).render(<AdminCollections platformAdmin={true}/>);`);
 const server=await createServer({configFile:false,root:dir,plugins:[tailwindcss()],cacheDir:path.join(dir,'.vite'),esbuild:{jsx:'automatic'},resolve:{alias:{'@':path.join(root,'src')}},server:{host:'127.0.0.1',port:0,strictPort:true,fs:{allow:[root,dir]}}});t.after(()=>server.close());await server.listen();const port=server.httpServer.address().port;
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:375,height:800}});
 const sha='a'.repeat(64),review={collection_id:'col-review',collection_name:'Fixture world',collection_version:7,asset_id:'ast-review',asset_revision:3,object_version:'object-1',sha256:sha,slot:'logo',mime:'image/png',bytes:68,preview_url:'/media/asset/ast-review'};
 let posts=0,posted,cleared=false,clearBody,noCollections=false;await page.route('**/media/asset/ast-review',r=>r.fulfill({status:200,contentType:'image/png',body:fs.readFileSync(path.join(root,'public/brand/kit/systems/signal-fold/icon-512.png'))}));
 await page.route('**/api/v1/studio/**',async route=>{const req=route.request(),u=new URL(req.url());let body={items:[]};
  if(u.pathname.endsWith('/collections')) body={items:noCollections?[]:[{id:'col-review',slug:'fixture-world',name:'Fixture world',description:'A fixture',scope:'global',logo_url:null,banner_url:null,logo_asset_id:'ast-review',banner_asset_id:null,accent:'aqua',status:'published',view_audience:'public',public_approved_at:'2026-01-01',source_work:null,release_version:7,card_count:0,enabled:true,manageable:true,owner_name:'Fixture'}]};
  if(u.pathname.endsWith('/collections/col-review'))body={cards:[]};
  if(u.pathname.endsWith('/brand-reference-index/issues'))body={items:cleared?[]:[{collectionId:'foreign-col',collectionName:'Foreign fixture',tenantName:'Other Bot',currentTenant:false,collectionVersion:4,slot:'logo',canClear:true,reason:'Clear or replace the untracked image reference.'}],more:false};
  if(u.pathname.endsWith('/brand-reference-index/clear')){cleared=true;clearBody=req.postDataJSON();body={ok:true};}
  if(u.pathname.endsWith('/brand-release') && req.method()==='GET')body={review};
  if(u.pathname.endsWith('/brand-release') && req.method()==='POST'){posts++;posted=req.postDataJSON();if(posts<=2)return route.fulfill({status:posts===1?409:403,contentType:'application/json',body:JSON.stringify({error:{code:posts===1?'brand_release_changed':'collection_authority_changed',message:posts===1?'The image changed.':'Your access changed.'}})});body={ok:true};}
  return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
 });
 await page.goto(`http://127.0.0.1:${port}/`);await page.getByRole('button',{name:'Review logo'}).click();
 page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Start full recheck after repair'}).click();await page.getByRole('status').getByText(/Full recheck started/).waitFor();
 await page.getByAltText('Fixture world logo awaiting review').waitFor();const approve=page.getByRole('button',{name:'Approve this image for public showcase'});await approve.waitFor({state:'visible'});await page.waitForFunction(()=>![...document.querySelectorAll('button')].find(x=>x.textContent==='Approve this image for public showcase')?.disabled);
 await page.getByText(`SHA-256 ${sha}`).waitFor();await page.getByText(/Confirm its identity, rights and credit/).waitFor();
 const parent=path.join(root,'.foilbury/evidence');fs.mkdirSync(parent,{recursive:true});const evidence=fs.mkdtempSync(path.join(parent,'collection-brand-review-'));await page.getByRole('heading',{name:'Review public collection images'}).scrollIntoViewIfNeeded();await page.screenshot({path:path.join(evidence,'review-mobile.png'),fullPage:true});
 await page.getByRole('button',{name:'Inspect reference issues'}).click();await page.getByText('Foreign fixture · logo').waitFor();await page.getByText('Other Bot').waitFor();
 await page.getByText('Foreign fixture · logo').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(evidence,'issues-mobile.png'),fullPage:true});
 page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Clear this URL'}).click();await page.getByRole('status').getByText(/previous value is retained privately/).waitFor();
 assert.deepEqual(clearBody,{collectionId:'foreign-col',collectionVersion:4,slot:'logo'});
 await approve.click();await page.getByRole('alert').getByText('The image changed.').waitFor();assert.equal(await page.getByRole('button',{name:'Approve this image for public showcase'}).count(),0);
 await page.getByRole('button',{name:'Review logo'}).click();await page.waitForFunction(()=>![...document.querySelectorAll('button')].find(x=>x.textContent==='Approve this image for public showcase')?.disabled);await page.getByRole('button',{name:'Approve this image for public showcase'}).click();await page.getByRole('alert').getByText('Your access changed.').waitFor();
 await page.getByRole('button',{name:'Review logo'}).click();await page.waitForFunction(()=>![...document.querySelectorAll('button')].find(x=>x.textContent==='Approve this image for public showcase')?.disabled);await page.getByRole('button',{name:'Approve this image for public showcase'}).click();await page.getByRole('status').getByText(/reviewed image was approved/).waitFor();
 assert.deepEqual(posted,{assetId:'ast-review',collectionVersion:7,assetRevision:3,objectVersion:'object-1',sha256:sha});assert.equal(posts,3);
 noCollections=true;await page.reload();await page.getByRole('button',{name:'Inspect reference issues'}).waitFor();await page.getByRole('button',{name:'Check image references'}).waitFor();
});
