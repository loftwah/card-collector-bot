import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

test('minimal Astro middleware and endpoint share the request reference', {timeout:30000}, async (t) => {
  const project=process.cwd(),root=fs.mkdtempSync(path.join(os.tmpdir(),'foilbury-request-astro-'));
  fs.mkdirSync(path.join(root,'src/pages'),{recursive:true});
  fs.symlinkSync(path.join(project,'node_modules'),path.join(root,'node_modules'));
  fs.copyFileSync(path.join(project,'src/server/ids.ts'),path.join(root,'src/ids.ts'));
  fs.writeFileSync(path.join(root,'astro.config.mjs'),`import {defineConfig} from 'astro/config';export default defineConfig({server:{host:'127.0.0.1',strictPort:true},vite:{cacheDir:${JSON.stringify(path.join(root,'.vite'))}}});`);
  fs.writeFileSync(path.join(root,'src/middleware.ts'),`import {defineMiddleware} from 'astro:middleware';import {requestReference} from './ids';export const onRequest=defineMiddleware(async (ctx,next)=>{ctx.locals.reference=requestReference(ctx.request);return next();});`);
  fs.writeFileSync(path.join(root,'src/pages/probe.ts'),`import {requestReference} from '../ids';export const prerender=false;export const GET=({request,locals})=>new Response(JSON.stringify({middleware:locals.reference,endpoint:requestReference(request)}),{headers:{'content-type':'application/json'}});`);
  const listener=net.createServer();await new Promise((resolve,reject)=>listener.once('error',reject).listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
  const child=spawn(path.join(project,'node_modules/.bin/astro'),['dev','--root',root,'--host','127.0.0.1','--port',String(port)],{cwd:root,stdio:['pipe','pipe','pipe']});
  let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{output=(output+String(chunk)).slice(-6000);});
  t.after(async()=>{if(child.exitCode===null && child.signalCode===null){child.kill('SIGTERM');await new Promise(resolve=>{child.once('exit',resolve);setTimeout(resolve,2000).unref();});}if(child.exitCode!==null || child.signalCode!==null)fs.rmSync(root,{recursive:true,force:true});});
  const url=`http://127.0.0.1:${port}/probe`;let ready=false;
  for(let i=0;i<100;i++){if(child.exitCode!==null)throw new Error(`Astro fixture exited ${child.exitCode}: ${output}`);try{const response=await fetch(url);if(response.ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
  assert.equal(ready,true,'isolated Astro fixture did not start');
  const seen=[];
  for(const ray of [null,'cookie=fixture-secret','x'.repeat(300),'0123456789abcdef-MEL']){
    const response=await fetch(url,{headers:ray?{'cf-ray':ray}:{}});assert.equal(response.status,200);
    const data=await response.json();assert.equal(data.middleware,data.endpoint);
    assert.match(data.endpoint,/^(?:0123456789abcdef-MEL|req_[0-9a-z]{24})$/);
    assert.ok(!JSON.stringify(data).includes('fixture-secret'));seen.push(data.endpoint);
  }
  assert.equal(new Set(seen).size,seen.length);
});
