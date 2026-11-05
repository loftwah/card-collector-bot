import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {composeCard} from '../../art/compose.mjs';

test('zoomed contain artwork remains within the canvas at offset extremes',async()=>{
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
    if(y<800)inside++;else outside++;
   }
  }
  assert.ok(inside>10000,`art must remain visible at offset ${offset}`);
  assert.equal(outside,0,`art escaped its existing canvas at offset ${offset}`);
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

test('oversized artwork preserves the direction of horizontal offsets',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'foilbury-art-offset-'));
 const bg=path.join(root,'bg.png');fs.writeFileSync(bg,await sharp({create:{width:48,height:48,channels:3,background:'#202020'}}).png().toBuffer());
 const w=64,h=64,pixels=Buffer.alloc(w*h*3);
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=(y*w+x)*3;pixels[i]=x<w/2?255:0;pixels[i+1]=x<w/2?0:255;}
 const subject=path.join(root,'subject.png');fs.writeFileSync(subject,await sharp(pixels,{raw:{width:w,height:h,channels:3}}).png().toBuffer());
 // Independently resize the pattern, then compare landmarks from the
 // compositor against the corresponding pixels in a reference crop.
 const source=await sharp(subject).png().toBuffer();
 const ref=await sharp(source).resize({width:828,height:907,fit:'inside',withoutEnlargement:false}).ensureAlpha().raw().toBuffer({resolveWithObject:true});
 assert.ok(ref.info.width>750 && ref.info.height>800);
 for(const offsetX of [-20,20]){
  const output=path.join(root,`${offsetX}.png`);
  await composeCard({subjectPath:subject,backgroundPath:bg,outputPath:output,composition:{mode:'contain',zoom:1.2,offsetX}});
  const raw=await sharp(output).ensureAlpha().raw().toBuffer();
  const left=30+Math.round((690-ref.info.width)/2)+Math.round(offsetX/100*690);
  const top=34+Math.round((756-ref.info.height)/2);
  for(const x of [120,250,375,500,630]){
   const referenceX=x-left,referenceY=400-top;
   assert.ok(referenceX>=0&&referenceX<ref.info.width&&referenceY>=0&&referenceY<ref.info.height);
   const ri=(referenceY*ref.info.width+referenceX)*4,oi=(400*750+x)*4;
   const expected=ref.data[ri]>ref.data[ri+1]?'red':'green';
   const actual=raw[oi]>raw[oi+1]?'red':'green';
   assert.equal(actual,expected,`offset ${offsetX}, x=${x} should match reference crop`);
  }
 }
});
