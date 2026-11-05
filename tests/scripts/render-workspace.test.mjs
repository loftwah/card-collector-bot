import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createRenderWorkspace } from '../../scripts/content/render-workspace.mjs';
import { renderProvisionedFront } from '../../scripts/content/render-provisioned-front.mjs';

test('overlapping attempts use isolated files and one cleanup cannot remove the other', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foilbury-render-concurrency-'));
  const stale = path.join(root, 'same-variant-background.png'); fs.writeFileSync(stale, 'old attempt evidence');
  const a = createRenderWorkspace(root), b = createRenderWorkspace(root);
  assert.notEqual(a.directory, b.directory);
  const subject = await sharp({create:{width:40,height:80,channels:3,background:'#c78319'}}).png().toBuffer();
  for (const [workspace,color] of [[a,'#cc1111'],[b,'#1188dd']]) {
    fs.writeFileSync(workspace.subject,subject);
    fs.writeFileSync(workspace.background,await sharp({create:{width:40,height:40,channels:3,background:color}}).png().toBuffer());
  }
  const payload={background_asset_id:'bg',material_key:'plain',effect_key:null,composition_json:null};
  const card={name:'Synthetic fixture',subtitle:null,sets:[],collections:[],class:null,rarity:null};
  await Promise.all([a,b].map(workspace=>renderProvisionedFront({payload,card,subjectPath:workspace.subject,backgroundPath:workspace.background,outputPath:workspace.front})));
  const first=fs.readFileSync(a.front), second=fs.readFileSync(b.front);
  assert.notDeepEqual(first,second,'distinct backgrounds must produce distinct outputs');
  a.cleanup();
  assert.equal(fs.existsSync(a.directory),false);
  assert.deepEqual(fs.readFileSync(b.front),second);
  assert.equal(fs.readFileSync(stale,'utf8'),'old attempt evidence');
  b.cleanup();
  assert.equal(fs.existsSync(b.directory),false);
  console.log(`Synthetic workspace evidence: ${root}`);
});
