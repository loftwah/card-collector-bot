import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';

test('collection creation reuses its key after an ambiguous result and recovers after reload',async(t)=>{
  const root=process.cwd(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'foilbury-collection-ui-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.symlinkSync(path.join(root,'node_modules'),path.join(dir,'node_modules'));
  fs.writeFileSync(path.join(dir,'index.html'),'<div id="root"></div><script type="module" src="/entry.jsx"></script>');
  fs.writeFileSync(path.join(dir,'entry.jsx'),`import React from 'react';import {createRoot} from 'react-dom/client';import AdminCollections from '/@fs${path.join(root,'src/components/admin/AdminCollections.tsx')}';window.__FOILBURY_STUDIO__=true;createRoot(document.getElementById('root')).render(<AdminCollections platformAdmin={false} botAdmin={true}/>);`);
  const server=await createServer({configFile:false,root:dir,cacheDir:path.join(dir,'.vite'),esbuild:{jsx:'automatic'},resolve:{alias:{'@':path.join(root,'src')}},server:{host:'127.0.0.1',port:0,fs:{allow:[root,dir]}}});
  t.after(()=>server.close());await server.listen();
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:375,height:800}});
  const keys=[];let secondSent;const twice=new Promise(resolve=>{secondSent=resolve;});
  await page.route('**/api/v1/studio/**',async route=>{
    const request=route.request(),url=new URL(request.url());let body={items:[]};
    if(url.pathname.endsWith('/collections') && request.method()==='POST') {keys.push(request.headers()['idempotency-key']);if(keys.length===2)secondSent();return route.abort('connectionreset');}
    if(url.pathname.includes('/collections/recovery/')) {assert.equal(decodeURIComponent(url.pathname.split('/').at(-1)),keys[0]);body={found:true,collection:{id:'collection-fixture',name:'Fixture collection',scope:'bot'}};}
    if(url.pathname.endsWith('/collections/collection-fixture'))body={cards:[]};
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
  await page.getByLabel('Name').fill('Fixture collection');
  await page.getByRole('button',{name:'Create collection'}).click();
  await page.getByRole('button',{name:'Check previous collection'}).waitFor();
  await page.getByRole('button',{name:'Create collection'}).click();await twice;
  assert.equal(keys[0],keys[1]);
  await page.reload();
  await page.getByRole('button',{name:'Check previous collection'}).click();
  await page.getByText('The earlier collection was created.').waitFor();
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('foilbury.pending-collection')),null);
});

test('a known logo upload is reused after the cover upload fails',async(t)=>{
  const root=process.cwd(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'foilbury-collection-upload-ui-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.symlinkSync(path.join(root,'node_modules'),path.join(dir,'node_modules'));
  fs.writeFileSync(path.join(dir,'index.html'),'<div id="root"></div><script type="module" src="/entry.jsx"></script>');
  fs.writeFileSync(path.join(dir,'entry.jsx'),`import React from 'react';import {createRoot} from 'react-dom/client';import AdminCollections from '/@fs${path.join(root,'src/components/admin/AdminCollections.tsx')}';window.__FOILBURY_STUDIO__=true;createRoot(document.getElementById('root')).render(<AdminCollections platformAdmin={false} botAdmin={true}/>);`);
  const server=await createServer({configFile:false,root:dir,cacheDir:path.join(dir,'.vite'),esbuild:{jsx:'automatic'},resolve:{alias:{'@':path.join(root,'src')}},server:{host:'127.0.0.1',port:0,fs:{allow:[root,dir]}}});
  t.after(()=>server.close());await server.listen();const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:375,height:800}});let uploads=0,createdBody;
  await page.route('**/api/v1/studio/**',async route=>{
    const request=route.request(),url=new URL(request.url());let body={items:[]};
    if(url.pathname.endsWith('/assets') && request.method()==='POST') {
      uploads++;
      if(uploads===2)return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'upload_failed',message:'Cover upload failed'}})});
      body={asset:{id:uploads===1?'logo-fixture':'cover-fixture'}};
    }
    if(url.pathname.endsWith('/collections') && request.method()==='POST') {createdBody=request.postDataJSON();body={collection:{id:'collection-fixture',scope:'bot'}};}
    if(url.pathname.endsWith('/collections/collection-fixture'))body={cards:[]};
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);await page.getByLabel('Name').fill('Upload fixture');
  await page.getByLabel('Logo upload').setInputFiles({name:'logo.png',mimeType:'image/png',buffer:Buffer.from('fixture-logo')});
  await page.getByLabel('Cover upload').setInputFiles({name:'cover.png',mimeType:'image/png',buffer:Buffer.from('fixture-cover')});
  await page.getByRole('button',{name:'Create collection'}).click();await page.getByText('Cover upload failed').waitFor();
  await page.getByRole('button',{name:'Create collection'}).click();await page.getByText('Bot collection created.').waitFor();
  assert.equal(uploads,3);assert.equal(createdBody.logoUrl,'/media/asset/logo-fixture');assert.equal(createdBody.bannerUrl,'/media/asset/cover-fixture');
});

test('a lost image response retains the same request key across reload and reselect',async(t)=>{
  const root=process.cwd(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'foilbury-brand-retry-ui-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.symlinkSync(path.join(root,'node_modules'),path.join(dir,'node_modules'));
  fs.writeFileSync(path.join(dir,'index.html'),'<div id="root"></div><script type="module" src="/entry.jsx"></script>');
  fs.writeFileSync(path.join(dir,'entry.jsx'),`import React from 'react';import {createRoot} from 'react-dom/client';import AdminCollections from '/@fs${path.join(root,'src/components/admin/AdminCollections.tsx')}';window.__FOILBURY_STUDIO__=true;createRoot(document.getElementById('root')).render(<AdminCollections platformAdmin={false} botAdmin={true}/>);`);
  const server=await createServer({configFile:false,root:dir,cacheDir:path.join(dir,'.vite'),esbuild:{jsx:'automatic'},resolve:{alias:{'@':path.join(root,'src')}},server:{host:'127.0.0.1',port:0,fs:{allow:[root,dir]}}});
  t.after(()=>server.close());await server.listen();const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:375,height:800}}), keys=[];
  await page.route('**/api/v1/studio/**',async route=>{
    const request=route.request(),url=new URL(request.url());let body={items:[]};
    if(url.pathname.endsWith('/assets') && request.method()==='POST') {keys.push(request.headers()['idempotency-key']);if(keys.length===1)return route.abort('connectionreset');body={asset:{id:'logo-fixture'}};}
    if(url.pathname.endsWith('/collections') && request.method()==='POST')body={collection:{id:'collection-fixture',scope:'bot'}};
    if(url.pathname.endsWith('/collections/collection-fixture'))body={cards:[]};
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
  });
  const fill=async()=>{await page.getByLabel('Name').fill('Retry fixture');await page.getByLabel('Logo upload').setInputFiles({name:'logo.png',mimeType:'image/png',buffer:Buffer.from('same-logo')});};
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);await fill();await page.getByRole('button',{name:'Create collection'}).click();
  await page.waitForFunction(()=>Boolean(sessionStorage.getItem('foilbury.pending-brand-uploads')));await page.reload();await fill();
  await page.getByRole('button',{name:'Create collection'}).click();await page.getByText('Bot collection created.').waitFor();
  assert.equal(keys.length,2);assert.ok(keys[0]);assert.equal(keys[0],keys[1]);
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('foilbury.pending-brand-uploads')),null);
});

test('an explicitly held first image upload can be corrected without trapping the form',async(t)=>{
  const root=process.cwd(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'foilbury-brand-held-ui-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.symlinkSync(path.join(root,'node_modules'),path.join(dir,'node_modules'));
  fs.writeFileSync(path.join(dir,'index.html'),'<div id="root"></div><script type="module" src="/entry.jsx"></script>');
  fs.writeFileSync(path.join(dir,'entry.jsx'),`import React from 'react';import {createRoot} from 'react-dom/client';import AdminCollections from '/@fs${path.join(root,'src/components/admin/AdminCollections.tsx')}';window.__FOILBURY_STUDIO__=true;createRoot(document.getElementById('root')).render(<AdminCollections platformAdmin={false} botAdmin={true}/>);`);
  const server=await createServer({configFile:false,root:dir,cacheDir:path.join(dir,'.vite'),esbuild:{jsx:'automatic'},resolve:{alias:{'@':path.join(root,'src')}},server:{host:'127.0.0.1',port:0,fs:{allow:[root,dir]}}});
  t.after(()=>server.close());await server.listen();const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:375,height:800}});let uploads=0;
  await page.route('**/api/v1/studio/**',async route=>{
    const request=route.request(),url=new URL(request.url());let body={items:[]};
    if(url.pathname.endsWith('/assets') && request.method()==='POST') {uploads++;return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'brand_upload_unavailable',message:'Collection image uploads are temporarily unavailable.'}})});}
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);await page.getByLabel('Name').fill('Held image');
  await page.getByLabel('Logo upload').setInputFiles({name:'first.png',mimeType:'image/png',buffer:Buffer.from('first')});
  await page.getByRole('button',{name:'Create collection'}).click();await page.getByText('Collection image uploads are temporarily unavailable.').waitFor();
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('foilbury.pending-brand-uploads')),null);
  await page.getByLabel('Logo upload').setInputFiles({name:'second.png',mimeType:'image/png',buffer:Buffer.from('second')});
  await page.getByRole('button',{name:'Create collection'}).click();await page.waitForFunction(()=>!document.querySelector('button[disabled]'));
  assert.equal(uploads,2);
});

test('a changed image can be abandoned without deleting it and retried with a fresh key',async(t)=>{
  const root=process.cwd(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'foilbury-brand-abandon-ui-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.symlinkSync(path.join(root,'node_modules'),path.join(dir,'node_modules'));
  fs.writeFileSync(path.join(dir,'index.html'),'<div id="root"></div><script type="module" src="/entry.jsx"></script>');
  fs.writeFileSync(path.join(dir,'entry.jsx'),`import React from 'react';import {createRoot} from 'react-dom/client';import AdminCollections from '/@fs${path.join(root,'src/components/admin/AdminCollections.tsx')}';window.__FOILBURY_STUDIO__=true;createRoot(document.getElementById('root')).render(<AdminCollections platformAdmin={false} botAdmin={true}/>);`);
  const server=await createServer({configFile:false,root:dir,cacheDir:path.join(dir,'.vite'),esbuild:{jsx:'automatic'},resolve:{alias:{'@':path.join(root,'src')}},server:{host:'127.0.0.1',port:0,fs:{allow:[root,dir]}}});
  t.after(()=>server.close());await server.listen();const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:375,height:800}}), keys=[];let abandoned;
  await page.route('**/api/v1/studio/**',async route=>{
    const request=route.request(),url=new URL(request.url());let body={items:[]};
    if(url.pathname.endsWith('/assets') && request.method()==='POST') {keys.push(request.headers()['idempotency-key']);if(keys.length===1)return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:{code:'render_input_changed',message:'The image changed.'}})});body={asset:{id:'logo-fixture'}};}
    if(url.pathname.endsWith('/assets/uploads/abandon')) {abandoned=request.postDataJSON();body={ok:true};}
    if(url.pathname.endsWith('/collections') && request.method()==='POST')body={collection:{id:'collection-fixture',scope:'bot'}};
    if(url.pathname.endsWith('/collections/collection-fixture'))body={cards:[]};
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);await page.getByLabel('Name').fill('Changed image fixture');
  await page.getByLabel('Logo upload').setInputFiles({name:'logo.png',mimeType:'image/png',buffer:Buffer.from('image')});
  await page.getByRole('button',{name:'Create collection'}).click();await page.getByRole('button',{name:'Abandon changed logo upload'}).click();
  await page.getByText('The earlier image upload was abandoned and retained. Choose the image again to start a new upload.').waitFor();
  await page.getByRole('button',{name:'Create collection'}).click();await page.getByText('Bot collection created.').waitFor();
  assert.equal(abandoned.key,keys[0]);assert.equal(abandoned.scope,'bot');assert.equal(keys.length,2);assert.notEqual(keys[0],keys[1]);
});

test('a definitively rejected cover can be corrected without duplicating the successful logo',async(t)=>{
  const root=process.cwd(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'foilbury-brand-correct-ui-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.symlinkSync(path.join(root,'node_modules'),path.join(dir,'node_modules'));
  fs.writeFileSync(path.join(dir,'index.html'),'<div id="root"></div><script type="module" src="/entry.jsx"></script>');
  fs.writeFileSync(path.join(dir,'entry.jsx'),`import React from 'react';import {createRoot} from 'react-dom/client';import AdminCollections from '/@fs${path.join(root,'src/components/admin/AdminCollections.tsx')}';window.__FOILBURY_STUDIO__=true;createRoot(document.getElementById('root')).render(<AdminCollections platformAdmin={false} botAdmin={true}/>);`);
  const server=await createServer({configFile:false,root:dir,cacheDir:path.join(dir,'.vite'),esbuild:{jsx:'automatic'},resolve:{alias:{'@':path.join(root,'src')}},server:{host:'127.0.0.1',port:0,fs:{allow:[root,dir]}}});
  t.after(()=>server.close());await server.listen();const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:375,height:800}}), keys=[];
  await page.route('**/api/v1/studio/**',async route=>{const req=route.request(),url=new URL(req.url());let body={items:[]};
    if(url.pathname.endsWith('/assets') && req.method()==='POST') {keys.push(req.headers()['idempotency-key']);if(keys.length===2)return route.fulfill({status:422,contentType:'application/json',body:JSON.stringify({error:{code:'asset_corrupt',message:'Choose a readable cover.'}})});body={asset:{id:keys.length===1||keys.length===3?'logo-fixture':'cover-fixture'}};}
    if(url.pathname.endsWith('/collections') && req.method()==='POST')body={collection:{id:'collection-fixture',scope:'bot'}};
    if(url.pathname.endsWith('/collections/collection-fixture'))body={cards:[]};
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);await page.getByLabel('Name').fill('Correction fixture');
  await page.getByLabel('Logo upload').setInputFiles({name:'logo.png',mimeType:'image/png',buffer:Buffer.from('logo')});
  await page.getByLabel('Cover upload').setInputFiles({name:'cover.png',mimeType:'image/png',buffer:Buffer.from('bad-cover')});
  await page.getByRole('button',{name:'Create collection'}).click();await page.getByText('Choose a readable cover.').waitFor();
  await page.getByLabel('Cover upload').setInputFiles({name:'cover.png',mimeType:'image/png',buffer:Buffer.from('new-cover')});
  await page.getByRole('button',{name:'Create collection'}).click();await page.getByText('Bot collection created.').waitFor();
  assert.equal(keys.length,4);assert.equal(keys[0],keys[2]);assert.notEqual(keys[1],keys[3]);
});
