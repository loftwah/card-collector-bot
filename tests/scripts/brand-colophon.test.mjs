import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';

const root='public/brand/kit/colophon';
const manifest=JSON.parse(readFileSync(path.join(root,'manifest.json'),'utf8'));
test('candidate exports match the recorded reproducible manifest',()=>{
  assert.equal(manifest.status,'local-candidate');
  assert.ok(manifest.files.length>=18);
  for(const item of manifest.files) {
    assert.match(item.name,/^[A-Za-z0-9.-]+$/);
    const hash=createHash('sha256').update(readFileSync(path.join(root,item.name))).digest('hex');
    assert.equal(hash,item.sha256,`${item.name} differs from manifest`);
  }
});
test('destination raster sizes and social mask references remain correct',async()=>{
  for(const [file,width,height] of [['favicon-16.png',16,16],['favicon-32.png',32,32],['icon-192-maskable.png',192,192],['icon-512-maskable.png',512,512],['discord-avatar-1024.png',1024,1024],['social-preview.png',1200,630]]) {
    const metadata=await sharp(path.join(root,file)).metadata();
    assert.equal(metadata.width,width,file);assert.equal(metadata.height,height,file);
  }
  const svg=readFileSync(path.join(root,'social-master.svg'),'utf8');
  for(const suffix of ['header','card']) {
    assert.ok(svg.includes(`id="social-album-${suffix}"`));
    assert.ok(svg.includes(`url(#social-album-${suffix})`));
  }
});
