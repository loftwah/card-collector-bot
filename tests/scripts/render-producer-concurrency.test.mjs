import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { composeCard } from '../../art/compose.mjs';

// Run the real CLI twice with an entirely local, injected API and source bytes.
// No server, credentials, D1 or R2 are accessed by either process.
test('overlapping canonical jobs cannot exchange source or output files', {timeout: 30000}, async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'foilbury-producer-overlap-'));
  const subject=await sharp({create:{width:40,height:80,channels:3,background:'#a07020'}}).png().toBuffer();
  fs.writeFileSync(path.join(dir,'subject.png'),subject);
  for (const [name,color] of [['a','#cc1122'],['b','#1177dd']]) fs.writeFileSync(path.join(dir,`${name}.png`),await sharp({create:{width:50,height:50,channels:3,background:color}}).png().toBuffer());
  const api=path.join(dir,'api.mjs'), loader=path.join(dir,'loader.mjs'), bootstrap=path.join(dir,'bootstrap.mjs');
  fs.writeFileSync(api,`import fs from 'node:fs'; let calls=0; export const BASE_URL='http://fixture.invalid'; export const agentToken=()=> 'fixture'; export const ensureServer=async()=>{}; export const accessHeaders=()=>({}); export async function apiJson(route){if(route.includes('/cards?'))return {items:[{id:'card',name:'Fixture',subtitle:null,sets:[],collections:[],class:null,rarity:null,editions:[{name:'Fixture',variants:[{id:'same-variant',name:'Plain'}]}]}]};if(route.includes('/renders/queue'))return {queued:1};if(route.includes('/jobs?'))return {items:calls++===0?[{id:'job'}]:[]};if(route.endsWith('/claim'))return {job:{attempts:1,payload:{variant_id:'same-variant',subject_asset_id:'subject',background_asset_id:'background',material_key:'plain',effect_key:null,composition_json:null}}};if(route.endsWith('/fail'))throw Error('unexpected failure');throw Error('unexpected '+route)} export async function apiForm(route,form){fs.writeFileSync(process.env.FIXTURE_RESULT,Buffer.from(await form.get('file').arrayBuffer())); return {};}`);
  fs.writeFileSync(loader,`export async function resolve(specifier,context,next){const r=await next(specifier,context);if(r.url.endsWith('/scripts/lib/api.mjs'))return {url:${JSON.stringify(pathToFileURL(api).href)},shortCircuit:true};return r}`);
  fs.writeFileSync(bootstrap,`import fs from 'node:fs/promises';globalThis.fetch=async url=>{const file=String(url).includes('/subject/')?process.env.FIXTURE_SUBJECT:process.env.FIXTURE_BACKGROUND;await new Promise(r=>setTimeout(r,100));return new Response(await fs.readFile(file),{status:200})}`);
  const run=name=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--no-warnings','--import',bootstrap,'--experimental-loader',loader,'scripts/render-cards.mjs','--limit=1','--json'],{cwd:process.cwd(),env:{PATH:process.env.PATH,FIXTURE_RESULT:path.join(dir,`${name}-result.webp`),FIXTURE_SUBJECT:path.join(dir,'subject.png'),FIXTURE_BACKGROUND:path.join(dir,`${name}.png`)}});let output='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);child.on('error',reject);child.on('exit',code=>code===0?resolve(output):reject(Error(`fixture ${name} exited ${code}: ${output}`)))});
  await Promise.all([run('a'),run('b')]);
  const a=await sharp(path.join(dir,'a-result.webp')).raw().toBuffer(), b=await sharp(path.join(dir,'b-result.webp')).raw().toBuffer();
  assert.notDeepEqual(a,b,'the two outputs must retain their different source backgrounds');
  for (const [name,actual] of [['a',a],['b',b]]) {
    const expected=path.join(dir,`${name}-expected.webp`);
    await composeCard({subjectPath:path.join(dir,'subject.png'),backgroundPath:path.join(dir,`${name}.png`),material:'plain',effect:'none',name:'Fixture',subtitle:'',setName:'Cabinet',serial:'MEMBER EDITION',className:'',rarity:'',markPath:'',outputPath:expected});
    assert.deepEqual(actual,await sharp(expected).raw().toBuffer(),`producer ${name} must retain its own sources`);
  }
  console.log(`Synthetic concurrent producer evidence: ${dir}`);
});
