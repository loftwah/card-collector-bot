import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {composeCard} from '../../art/compose.mjs';

test('zoomed contain artwork stays in its window for both offset extremes',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'foilbury-art-window-'));
 const background=await sharp({create:{width:48,height:48,channels:3,background:'#202020'}}).png().toBuffer();
 const bg=path.join(root,'bg.png');fs.writeFileSync(bg,background);
 for(const offset of [-20,0,20]){
  const raws=[];
  for(const colour of ['#ff0000','#00ff00']){
   const subject=await sharp({create:{width:24,height:24,channels:4,background:colour}}).png().toBuffer();
   const input=path.join(root,`${offset}-${colour.slice(1)}.png`),output=path.join(root,`${offset}-${colour.slice(1)}-out.png`);fs.writeFileSync(input,subject);
   await composeCard({subjectPath:input,backgroundPath:bg,outputPath:output,composition:{mode:'contain',zoom:1.2,offsetX:offset,offsetY:offset}});
   raws.push(await sharp(output).ensureAlpha().raw().toBuffer({resolveWithObject:true}));
  }
  assert.equal(raws[0].info.width,750);assert.equal(raws[0].info.height,1050);
  let inside=0,outside=0;
  for(let y=0;y<1050;y++)for(let x=0;x<750;x++){
   const i=(y*750+x)*4;
   if(raws[0].data[i]!==raws[1].data[i]||raws[0].data[i+1]!==raws[1].data[i+1]||raws[0].data[i+2]!==raws[1].data[i+2]){
    if(x>=30&&x<720&&y>=34&&y<790)inside++;else outside++;
   }
  }
  assert.ok(inside>10000,`art must remain visible at offset ${offset}`);
  assert.equal(outside,0,`art escaped reserved window at offset ${offset}`);
 }
});

test('tall, wide and medallion artwork remain renderable at zoom bounds',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'foilbury-art-shapes-'));
 const bg=path.join(root,'bg.png');fs.writeFileSync(bg,await sharp({create:{width:48,height:48,channels:3,background:'#404040'}}).png().toBuffer());
 const fixtures=[{w:24,h:64,mode:'contain',zoom:1.6},{w:64,h:24,mode:'contain',zoom:1.6},{w:24,h:24,mode:'medallion',zoom:1.6},{w:24,h:64,mode:'fill',zoom:1.6},{w:64,h:24,mode:'contain',zoom:0.6}];
 for(let i=0;i<fixtures.length;i++){
  const f=fixtures[i],subject=path.join(root,`${i}.png`),output=path.join(root,`${i}-out.png`);
  fs.writeFileSync(subject,await sharp({create:{width:f.w,height:f.h,channels:f.mode==='medallion'?3:4,background:'#a2511f'}}).png().toBuffer());
  await composeCard({subjectPath:subject,backgroundPath:bg,outputPath:output,composition:{mode:f.mode,zoom:f.zoom,offsetX:20,offsetY:-20}});
  const meta=await sharp(output).metadata();assert.equal(meta.width,750);assert.equal(meta.height,1050);
 }
});

test('rectangular fill and transparent medallion requests fall back to contain',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'foilbury-art-modes-'));
 const bg=path.join(root,'bg.png');fs.writeFileSync(bg,await sharp({create:{width:48,height:48,channels:3,background:'#303030'}}).png().toBuffer());
 for(const [i,width,height,mode] of [[0,24,64,'fill'],[1,64,24,'fill'],[2,40,40,'medallion']]){
  const raw=Buffer.alloc(width*height*4);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){const p=(y*width+x)*4;raw[p]=x*255/width;raw[p+1]=y*255/height;raw[p+2]=(x+y)%2?250:20;raw[p+3]=mode==='medallion'&&x<width/2?128:255;}
  const subject=path.join(root,`${i}.png`);fs.writeFileSync(subject,await sharp(raw,{raw:{width,height,channels:4}}).png().toBuffer());
  const outputs=[];
  for(const requested of [mode,'contain']){const out=path.join(root,`${i}-${requested}.png`);await composeCard({subjectPath:subject,backgroundPath:bg,outputPath:out,composition:{mode:requested,zoom:1}});outputs.push(fs.readFileSync(out));}
  assert.deepEqual(outputs[0],outputs[1],`${width}x${height} ${mode} must use contain`);
 }
});
