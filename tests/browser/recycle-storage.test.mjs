import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createServer} from 'vite';
import {chromium} from '@playwright/test';

test('pending recycle keys are serialized between tabs and isolated by account and copy',async t=>{
  const root=process.cwd(),fixture=fs.mkdtempSync(path.join(os.tmpdir(),'foilbury-recycle-storage-'));
  t.after(()=>fs.rmSync(fixture,{recursive:true,force:true}));
  fs.symlinkSync(path.join(root,'node_modules'),path.join(fixture,'node_modules'));
  fs.writeFileSync(path.join(fixture,'index.html'),'<script type="module" src="/entry.js"></script>');
  fs.writeFileSync(path.join(fixture,'entry.js'),`import * as api from ${JSON.stringify(`/@fs${path.join(root,'src/lib/recycle-pending.ts')}`)};window.pendingApi=api;`);
  const server=await createServer({root:fixture,cacheDir:path.join(fixture,'cache'),configFile:false,logLevel:'silent',server:{host:'127.0.0.1',port:0,fs:{allow:[root,fixture]}}});
  t.after(()=>server.close());await server.listen();const address=server.httpServer.address();assert.ok(address&&typeof address==='object');
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const context=await browser.newContext();
  const a=await context.newPage(),b=await context.newPage();await Promise.all([a.goto(`http://127.0.0.1:${address.port}`),b.goto(`http://127.0.0.1:${address.port}`)]);
  await Promise.all([a.waitForFunction(()=>window.pendingApi),b.waitForFunction(()=>window.pendingApi)]);
  const scope=JSON.stringify(['bot','user','copy']);
  const results=await Promise.all([a.evaluate(scope=>window.pendingApi.reserveRecyclePending(scope,{key:'recycle-a',preview:{credit:1}}),scope),b.evaluate(scope=>window.pendingApi.reserveRecyclePending(scope,{key:'recycle-b',preview:{credit:2}}),scope)]);
  assert.equal(results.filter(result=>result.created).length,1);assert.equal(results[0].pending.key,results[1].pending.key);
  const different=JSON.stringify(['bot','other-user','copy']);
  assert.equal(await b.evaluate(scope=>window.pendingApi.readRecyclePending(scope),different),null);
  await b.evaluate(({scope,key})=>window.pendingApi.clearRecyclePending(scope,key),{scope,key:'not-the-active-key'});
  assert.equal((await a.evaluate(scope=>window.pendingApi.readRecyclePending(scope),scope)).key,results[0].pending.key);
  await a.close();const reopened=await context.newPage();await reopened.goto(`http://127.0.0.1:${address.port}`);await reopened.waitForFunction(()=>window.pendingApi);
  assert.equal((await reopened.evaluate(scope=>window.pendingApi.readRecyclePending(scope),scope)).key,results[0].pending.key);
});
