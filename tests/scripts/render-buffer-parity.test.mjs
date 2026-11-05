import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { composeCard, composeCardBack } from '../../art/compose.mjs';
import { readRenderSource, MAX_RENDER_SOURCE_BYTES } from '../../scripts/content/render-bytes.mjs';

test('buffer front and back preserve file-render bytes for marks and finishes', async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'foilbury-render-buffer-'));
 const subject=await sharp({create:{width:40,height:80,channels:3,background:'#c14a25'}}).png().toBuffer();
 const background=await sharp({create:{width:40,height:40,channels:3,background:'#24677a'}}).png().toBuffer();
 const mark=await sharp({create:{width:24,height:24,channels:3,background:'#282828'}}).png().toBuffer();
 const svg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle cx="10" cy="10" r="8" fill="black"/></svg>');
 for (const [name,bytes] of [['subject.png',subject],['background.png',background],['mark.png',mark],['mark.svg',svg]]) fs.writeFileSync(path.join(dir,name),bytes);
 for (const [material,effect,markName,markData,markMime] of [['plain','none','mark.png',mark,'image/png'],['gold','holographic','mark.svg',svg,'image/svg+xml']]) {
  const outputPath=path.join(dir,`${material}.webp`);
  const common={material,effect,name:'Fixture',composition:{mode:'contain',zoom:1,offsetX:0,offsetY:0}};
  await composeCard({...common,subjectPath:path.join(dir,'subject.png'),backgroundPath:path.join(dir,'background.png'),markPath:path.join(dir,markName),outputPath});
  const result=await composeCard({...common,subjectPath:subject,backgroundPath:background,markBuffer:markData,markMime,returnBytes:true});
  assert.deepEqual(result.buffer,fs.readFileSync(outputPath),`${material} front`);
  const backPath=path.join(dir,`${material}-back.webp`);
  await composeCardBack({backPath:path.join(dir,'background.png'),material,effect,outputPath:backPath});
  const back=await composeCardBack({backPath:background,material,effect,returnBytes:true});
  assert.deepEqual(back,fs.readFileSync(backPath),`${material} back`);
 }
 console.log(`Synthetic buffer parity evidence: ${dir}`);
});

test('render source reader bounds chunked data and rejects empty sources', async()=>{
 await assert.rejects(readRenderSource(new Response(new Uint8Array())),/empty/);
 const stream=new ReadableStream({start(c){c.enqueue(new Uint8Array(MAX_RENDER_SOURCE_BYTES));c.enqueue(new Uint8Array(1));c.close();}});
 await assert.rejects(readRenderSource(new Response(stream)),/bounded size/);
 let count=0;const tiny=new ReadableStream({pull(c){if(count++<16385)c.enqueue(new Uint8Array());else c.close();}});
 await assert.rejects(readRenderSource(new Response(tiny)),/bounded size/);
});
