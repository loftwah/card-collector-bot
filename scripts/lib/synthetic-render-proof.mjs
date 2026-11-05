/**
 * SYNTHETIC LOCAL EXPERIMENT. This module cannot publish to D1 or R2. Its
 * receipts are not production provenance or authorisation. A separately
 * supervised network-disabled container and independently reviewed inputs are
 * required before using the underlying approach beyond disposable fixtures.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';

const REPO=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const MAX_VARIANTS=10,MAX_INPUT=5_000_000,MAX_TOTAL=50_000_000,MAX_OUTPUT=10_000_000,MAX_OUTPUT_TOTAL=50_000_000;
const digest=(value)=>crypto.createHash('sha256').update(value).digest('hex');
const token=()=>crypto.randomBytes(24).toString('hex');
const safeName=(name)=>typeof name==='string'&&/^[a-z0-9][a-z0-9_-]{0,79}$/.test(name);
const keysOnly=(obj,keys)=>obj && typeof obj==='object' && !Array.isArray(obj) && Object.keys(obj).every(key=>keys.includes(key));

export function createSyntheticSandbox(){
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'foilbury-synthetic-provenance-'));
 fs.chmodSync(root,0o700);const secret=token();fs.writeFileSync(path.join(root,'.synthetic-only'),secret,{mode:0o600,flag:'wx'});
 return {root,secret};
}
function sandbox(root,secret){
 const resolved=fs.realpathSync(root),base=fs.realpathSync(os.tmpdir());
 if(resolved!==path.resolve(root)||path.dirname(resolved)!==base||!path.basename(resolved).startsWith('foilbury-synthetic-provenance-'))throw new Error('synthetic_sandbox_required');
 const marker=fs.openSync(path.join(resolved,'.synthetic-only'),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{if(fs.readFileSync(marker,'utf8')!==secret)throw new Error('synthetic_sandbox_required');}finally{fs.closeSync(marker);}
 return resolved;
}
function publisherPath(root){
 const db=path.join(root,'synthetic-publisher.sqlite'),objects=path.join(root,'objects');
 if(fs.realpathSync(db)!==db||!fs.lstatSync(db).isFile()||fs.realpathSync(objects)!==objects||!fs.lstatSync(objects).isDirectory())throw new Error('synthetic_publisher_path_invalid');
 return db;
}
function readInput(root,rel,expected,maxBytes=MAX_INPUT){
 if(typeof rel!=='string'||path.isAbsolute(rel)||rel.includes('\\')||!rel||typeof expected!=='string'||!/^[a-f0-9]{64}$/.test(expected))throw new Error('invalid_input');
 const target=path.resolve(root,rel);
 if(!target.startsWith(root+path.sep)||fs.realpathSync(target)!==target)throw new Error('input_path_invalid');
 const fd=fs.openSync(target,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>maxBytes)throw new Error('input_too_large');const bytes=fs.readFileSync(fd);if(bytes.length!==stat.size||digest(bytes)!==expected)throw new Error('input_hash_changed');return bytes;}finally{fs.closeSync(fd);}
}
// Publish a complete local object atomically; a crash can leave only an unreferenced temporary file.
function writeSyntheticObject(root,hash,bytes){
 const dir=path.join(root,'objects'),temp=path.join(dir,`.temporary-${token()}`),dest=path.join(dir,hash);
 const fd=fs.openSync(temp,'wx',0o600);
 try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 try{try{fs.linkSync(temp,dest);}catch(e){if(e.code!=='EEXIST')throw e;readInput(root,`objects/${hash}`,hash,MAX_OUTPUT);}}
 finally{fs.unlinkSync(temp);}
}
function readStatic(rel){
 const target=path.resolve(REPO,rel);if(!target.startsWith(REPO+path.sep)||fs.realpathSync(target)!==target)throw new Error('renderer_path_invalid');
 const fd=fs.openSync(target,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>MAX_INPUT)throw new Error('input_too_large');const bytes=fs.readFileSync(fd);if(bytes.length!==stat.size)throw new Error('renderer_changed');return bytes;}finally{fs.closeSync(fd);}
}
function staticFiles(material,effect){
 if(!['plain','silver','gold','diamond'].includes(material)||!['none','holographic','prismatic'].includes(effect))throw new Error('unsupported_finish');
 return ['art/compose.mjs','pnpm-lock.yaml','art/fonts/Fraunces.ttf','art/fonts/Manrope.ttf','art/fonts/IBMPlexMono-Regular.ttf','art/fonts/IBMPlexMono-SemiBold.ttf',`public/art/layers/material-${material}.png`,`public/art/layers/frame-${material}.png`,...(effect==='none'?[]:[`public/art/layers/effect-${effect}.png`])];
}

/** Input files must be synthetic fixtures beneath the created sandbox. */
export function produceSyntheticProof(root,secret,manifest){
 root=sandbox(root,secret);
 if(!keysOnly(manifest,['kind','assets','variants'])||manifest.kind!=='synthetic_only'||!Array.isArray(manifest.variants)||!manifest.variants.length||manifest.variants.length>MAX_VARIANTS)throw new Error('synthetic_variant_limit');
 if(!Array.isArray(manifest.assets)||!manifest.assets.length||manifest.assets.length>64)throw new Error('invalid_synthetic_graph');
 const assetsById=new Map();
 for(const asset of manifest.assets){
  if(!keysOnly(asset,['id','origin','path','sha256','dependencies','derivative'])||!safeName(asset.id)||assetsById.has(asset.id)||asset.origin!=='synthetic_fixture'||!Array.isArray(asset.dependencies)||asset.dependencies.length>16||asset.dependencies.some(id=>!safeName(id))||(asset.derivative!==null&&!safeName(asset.derivative)))throw new Error('invalid_synthetic_graph');
  assetsById.set(asset.id,asset);
 }
 const names=new Set(),files=new Map(),visited=new Set(),visiting=new Set();let total=0;
 const visit=(id,depth)=>{
  if(depth>16||visiting.has(id))throw new Error('invalid_synthetic_graph');
  if(visited.has(id))return;
  const asset=assetsById.get(id);if(!asset)throw new Error('invalid_synthetic_graph');
  visiting.add(id);for(const child of [...asset.dependencies,...(asset.derivative?[asset.derivative]:[])])visit(child,depth+1);visiting.delete(id);visited.add(id);
  const bytes=readInput(root,asset.path,asset.sha256);total+=bytes.length;if(total>MAX_TOTAL)throw new Error('input_budget_exceeded');
  const existing=files.get(asset.path);if(existing&&!existing.equals(bytes))throw new Error('input_hash_changed');files.set(asset.path,bytes);
 };
 for(const variant of manifest.variants){
  if(!keysOnly(variant,['id','origin','subject','background','mark','material','effect','name','subtitle'])||!safeName(variant.id)||names.has(variant.id)||variant.origin!=='synthetic_fixture'||typeof variant.name!=='string'||!variant.name.trim()||variant.name.length>80||(variant.subtitle!==undefined&&(typeof variant.subtitle!=='string'||variant.subtitle.length>100)))throw new Error('invalid_synthetic_variant');names.add(variant.id);
  for(const id of [variant.subject,variant.background,...(variant.mark?[variant.mark]:[])]){if(!safeName(id))throw new Error('invalid_synthetic_graph');visit(id,0);}
  staticFiles(variant.material,variant.effect);
 }
 if(visited.size!==assetsById.size)throw new Error('invalid_synthetic_graph');
 const stage=fs.mkdtempSync(path.join(root,'render-'));fs.mkdirSync(path.join(stage,'art'),{recursive:true});
 const assets=new Set(manifest.variants.flatMap(v=>staticFiles(v.material,v.effect)));
 const staticHashes={};for(const rel of [...assets].sort()){const bytes=readStatic(rel);total+=bytes.length;if(total>MAX_TOTAL)throw new Error('input_budget_exceeded');staticHashes[rel]=digest(bytes);const target=path.join(stage,rel);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes,{flag:'wx'});}
 fs.symlinkSync(path.join(REPO,'node_modules'),path.join(stage,'node_modules'),'dir');
 for(const [rel,bytes] of files){const target=path.join(stage,'inputs',rel);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes,{flag:'wx'});}
 const worker=`import {composeCard} from './art/compose.mjs';import fs from 'node:fs';import sharp from 'sharp';const m=JSON.parse(fs.readFileSync('./manifest.json','utf8')),assets=new Map(m.assets.map(a=>[a.id,a]));for(const v of m.variants){for(let i=1;i<=2;i++)await composeCard({subjectPath:'inputs/'+assets.get(v.subject).path,backgroundPath:'inputs/'+assets.get(v.background).path,markPath:v.mark?'inputs/'+assets.get(v.mark).path:'',material:v.material,effect:v.effect,name:v.name,subtitle:v.subtitle??'',setName:'Synthetic fixture',serial:'SYNTHETIC',outputPath:'output/'+v.id+'-'+i+'.webp'});}fs.writeFileSync('toolchain.json',JSON.stringify({node:process.version,sharp:sharp.versions}));`;
 fs.mkdirSync(path.join(stage,'output'));fs.writeFileSync(path.join(stage,'manifest.json'),JSON.stringify(manifest));fs.writeFileSync(path.join(stage,'worker.mjs'),worker);
 const child=spawnSync(process.execPath,['worker.mjs'],{cwd:stage,env:{NODE_ENV:'test'},encoding:'utf8',timeout:55_000,maxBuffer:100_000});
 if(child.status!==0)throw new Error('synthetic_render_failed');
 const outputs=[];let outputTotal=0;for(const v of manifest.variants){const one=fs.readFileSync(path.join(stage,'output',`${v.id}-1.webp`)),two=fs.readFileSync(path.join(stage,'output',`${v.id}-2.webp`));outputTotal+=one.length;if(one.length>MAX_OUTPUT||outputTotal>MAX_OUTPUT_TOTAL||!one.equals(two))throw new Error('render_not_reproducible');outputs.push({variantId:v.id,sha256:digest(one),bytes:one});}
 for(const [rel,expected] of Object.entries(staticHashes))if(digest(readStatic(rel))!==expected)throw new Error('renderer_changed');
 for(const asset of manifest.assets)readInput(root,asset.path,asset.sha256);
 const receipt={kind:'synthetic_unverified',manifest,staticHashes,toolchain:JSON.parse(fs.readFileSync(path.join(stage,'toolchain.json'),'utf8')),outputs:outputs.map(({variantId,sha256})=>({variantId,sha256}))};
 return {receipt,outputs};
}

/** The following publisher is intentionally restricted to its own fresh,
 * synthetic SQLite database and local files. It is not a D1/R2 publisher. */
export function initializeSyntheticPublisher(root,secret,rows){
 root=sandbox(root,secret);if(!Array.isArray(rows)||rows.length>MAX_VARIANTS||new Set(rows.map(r=>r.variantId)).size!==rows.length||rows.some(r=>!safeName(r.variantId)||!Buffer.isBuffer(r.bytes)||r.bytes.length>MAX_OUTPUT||digest(r.bytes)!==r.hash||!Number.isSafeInteger(r.revision??1)||(r.revision??1)<1))throw new Error('invalid_synthetic_rows');
 fs.mkdirSync(path.join(root,'objects'),{mode:0o700});const dbPath=path.join(root,'synthetic-publisher.sqlite');
 for(const row of rows)writeSyntheticObject(root,row.hash,row.bytes);
 fs.closeSync(fs.openSync(dbPath,'wx',0o600));const db=new DatabaseSync(dbPath);
 try{db.exec('CREATE TABLE pointers (variant_id TEXT PRIMARY KEY, object_hash TEXT NOT NULL, revision INTEGER NOT NULL); CREATE TABLE runs (run_id TEXT PRIMARY KEY, digest TEXT NOT NULL, status TEXT NOT NULL, receipt TEXT NOT NULL);');const insert=db.prepare('INSERT INTO pointers VALUES (?,?,?)');for(const row of rows)insert.run(row.variantId,row.hash,row.revision??1);}finally{db.close();}
}
export function publishSynthetic(root,secret,runId,proof,expected){
 root=sandbox(root,secret);if(!safeName(runId)||proof?.receipt?.kind!=='synthetic_unverified'||!Array.isArray(proof.outputs)||!proof.outputs.length||proof.outputs.length>MAX_VARIANTS||!Array.isArray(expected)||expected.length!==proof.outputs.length)throw new Error('invalid_synthetic_publication');
 const expectedById=new Map(expected.map(e=>[e.variantId,e]));
 const actual=proof.outputs.map(({variantId,sha256})=>({variantId,sha256}));
 if(expectedById.size!==expected.length||new Set(proof.outputs.map(o=>o.variantId)).size!==proof.outputs.length||
   expected.some(e=>!safeName(e.variantId)||!/^[a-f0-9]{64}$/.test(e.hash)||!Number.isSafeInteger(e.revision)||e.revision<1)||
   proof.outputs.reduce((n,o)=>n+(Buffer.isBuffer(o.bytes)?o.bytes.length:0),0)>MAX_OUTPUT_TOTAL||
   JSON.stringify(proof.receipt.outputs)!==JSON.stringify(actual)||
   JSON.stringify(proof.receipt.manifest?.variants?.map(v=>v.id))!==JSON.stringify(actual.map(o=>o.variantId))||
   proof.outputs.some(o=>!safeName(o.variantId)||!expectedById.has(o.variantId)||!Buffer.isBuffer(o.bytes)||o.bytes.length>MAX_OUTPUT||digest(o.bytes)!==o.sha256))throw new Error('invalid_synthetic_publication');
 const runDigest=digest(JSON.stringify({receipt:proof.receipt,expected}));const db=new DatabaseSync(publisherPath(root));
 try{
  for(const old of expected)readInput(root,`objects/${old.hash}`,old.hash,MAX_OUTPUT);
  for(const output of proof.outputs)writeSyntheticObject(root,output.sha256,output.bytes);
  db.exec('BEGIN IMMEDIATE');try{
   const prior=db.prepare('SELECT digest,status FROM runs WHERE run_id=?').get(runId);
   if(prior){
    if(prior.digest!==runDigest)throw new Error('synthetic_run_conflict');
    for(const output of proof.outputs){const old=expectedById.get(output.variantId),current=db.prepare('SELECT object_hash,revision FROM pointers WHERE variant_id=?').get(output.variantId);
     const wantedHash=prior.status==='published'?output.sha256:old.hash,wantedRevision=old.revision+(prior.status==='published'?1:2);
     if(!['published','rolled_back'].includes(prior.status)||current?.object_hash!==wantedHash||current?.revision!==wantedRevision)throw new Error('synthetic_pointer_changed');
    }
    db.exec('COMMIT');return prior.status;
   }
   for(const output of proof.outputs){const old=expectedById.get(output.variantId);const updated=db.prepare('UPDATE pointers SET object_hash=?,revision=revision+1 WHERE variant_id=? AND object_hash=? AND revision=?').run(output.sha256,output.variantId,old.hash,old.revision);if(updated.changes!==1)throw new Error('synthetic_pointer_changed');}
   db.prepare('INSERT INTO runs VALUES (?,?,?,?)').run(runId,runDigest,'published',JSON.stringify({expected,outputs:proof.outputs.map(({variantId,sha256})=>({variantId,sha256}))}));db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}return 'published';
 }finally{db.close();}
}
export function rollbackSynthetic(root,secret,runId){
 root=sandbox(root,secret);if(!safeName(runId))throw new Error('invalid_synthetic_publication');const db=new DatabaseSync(publisherPath(root));
 try{db.exec('BEGIN IMMEDIATE');try{const run=db.prepare('SELECT status,receipt FROM runs WHERE run_id=?').get(runId);if(!run)throw new Error('synthetic_run_missing');
  if(run.status==='rolled_back'){const receipt=JSON.parse(run.receipt);for(const old of receipt.expected){readInput(root,`objects/${old.hash}`,old.hash,MAX_OUTPUT);const current=db.prepare('SELECT object_hash,revision FROM pointers WHERE variant_id=?').get(old.variantId);if(current?.object_hash!==old.hash||current?.revision!==old.revision+2)throw new Error('synthetic_pointer_changed');}db.exec('COMMIT');return 'rolled_back';}
  if(run.status!=='published')throw new Error('synthetic_run_invalid');
  const data=JSON.parse(run.receipt);for(const old of data.expected)readInput(root,`objects/${old.hash}`,old.hash,MAX_OUTPUT);
  for(const output of data.outputs){const old=data.expected.find(e=>e.variantId===output.variantId);const result=db.prepare('UPDATE pointers SET object_hash=?,revision=revision+1 WHERE variant_id=? AND object_hash=? AND revision=?').run(old.hash,output.variantId,output.sha256,old.revision+1);if(result.changes!==1)throw new Error('synthetic_pointer_changed');}
  db.prepare("UPDATE runs SET status='rolled_back' WHERE run_id=? AND status='published'").run(runId);db.exec('COMMIT');return 'rolled_back';
 }catch(e){db.exec('ROLLBACK');throw e;}}finally{db.close();}
}
