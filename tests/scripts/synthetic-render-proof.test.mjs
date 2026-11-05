import {before,describe,it} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import sharp from 'sharp';
import {createSyntheticSandbox,produceSyntheticProof,initializeSyntheticPublisher,publishSynthetic,rollbackSynthetic} from '../../scripts/lib/synthetic-render-proof.mjs';

const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
let sandbox,manifest,proof;
before(async()=>{
 sandbox=createSyntheticSandbox();
 const subject=await sharp({create:{width:64,height:64,channels:4,background:'#fcaf57'}}).png().toBuffer();
 const background=await sharp({create:{width:64,height:96,channels:4,background:'#195d54'}}).png().toBuffer();
 fs.writeFileSync(path.join(sandbox.root,'subject.png'),subject);fs.writeFileSync(path.join(sandbox.root,'background.png'),background);
 const common={origin:'synthetic_fixture',subject:'subject',background:'background',material:'plain',effect:'none',name:'Synthetic fixture'};
 manifest={kind:'synthetic_only',assets:[{id:'subject',origin:'synthetic_fixture',path:'subject.png',sha256:hash(subject),dependencies:[],derivative:null},{id:'background',origin:'synthetic_fixture',path:'background.png',sha256:hash(background),dependencies:[],derivative:null}],variants:[{id:'alpha',...common},{id:'beta',...common}]};
 proof=produceSyntheticProof(sandbox.root,sandbox.secret,manifest);
});
function publisher(){
 const target=createSyntheticSandbox(),one=Buffer.from('synthetic prior alpha'),two=Buffer.from('synthetic prior beta');
 const expected=[{variantId:'alpha',hash:hash(one),revision:1},{variantId:'beta',hash:hash(two),revision:1}];
 initializeSyntheticPublisher(target.root,target.secret,[{...expected[0],bytes:one},{...expected[1],bytes:two}]);
 return {...target,expected};
}
function query(root,sql,...values){const db=new DatabaseSync(path.join(root,'synthetic-publisher.sqlite'));try{return db.prepare(sql).all(...values);}finally{db.close();}}

describe('synthetic deterministic render evidence',()=>{
 it('renders each recorded fixture twice and labels the receipt unverified',()=>{
  assert.equal(proof.receipt.kind,'synthetic_unverified');assert.equal(proof.outputs.length,2);
  assert.deepEqual(proof.receipt.outputs,proof.outputs.map(({variantId,sha256})=>({variantId,sha256})));
  assert.ok(proof.receipt.staticHashes['art/compose.mjs']);assert.ok(proof.receipt.staticHashes['art/fonts/Manrope.ttf']);
 });
 it('rejects more than ten variants and unknown contributor fields',()=>{
  assert.throws(()=>produceSyntheticProof(sandbox.root,sandbox.secret,{...manifest,variants:Array.from({length:11},(_,i)=>({...manifest.variants[0],id:`v${i}`}))}),/synthetic_variant_limit/);
  assert.throws(()=>produceSyntheticProof(sandbox.root,sandbox.secret,{...manifest,variants:[{...manifest.variants[0],extra_contributor:'unknown'}]}),/invalid_synthetic_variant/);
 });
 it('accepts the ten-variant ceiling with repeated deterministic renders',()=>{
  const result=produceSyntheticProof(sandbox.root,sandbox.secret,{...manifest,variants:Array.from({length:10},(_,i)=>({...manifest.variants[0],id:`bounded_${i}`}))});
  assert.equal(result.outputs.length,10);assert.equal(result.receipt.kind,'synthetic_unverified');
 });
 it('rejects changed inputs and a symlink escape',()=>{
  assert.throws(()=>produceSyntheticProof(sandbox.root,sandbox.secret,{...manifest,assets:manifest.assets.map((a,i)=>i?a:{...a,sha256:'0'.repeat(64)})}),/input_hash_changed/);
  fs.symlinkSync('/etc/passwd',path.join(sandbox.root,'escape'));
  assert.throws(()=>produceSyntheticProof(sandbox.root,sandbox.secret,{...manifest,assets:manifest.assets.map((a,i)=>i?a:{...a,path:'escape'})}),/input_path_invalid/);
 });
 it('rejects non-synthetic sources and non-sandbox locations',()=>{
  assert.throws(()=>produceSyntheticProof(sandbox.root,sandbox.secret,{...manifest,assets:manifest.assets.map((a,i)=>i?a:{...a,origin:'unknown'})}),/invalid_synthetic_graph/);
  assert.throws(()=>produceSyntheticProof('/tmp','wrong',manifest));
 });
 it('fails closed on missing, cyclic and AI-origin transitive contributors',()=>{
  assert.throws(()=>produceSyntheticProof(sandbox.root,sandbox.secret,{...manifest,assets:manifest.assets.map((a,i)=>i?a:{...a,dependencies:['missing']})}),/invalid_synthetic_graph/);
  assert.throws(()=>produceSyntheticProof(sandbox.root,sandbox.secret,{...manifest,assets:manifest.assets.map((a,i)=>i?a:{...a,dependencies:['subject']})}),/invalid_synthetic_graph/);
  assert.throws(()=>produceSyntheticProof(sandbox.root,sandbox.secret,{...manifest,assets:manifest.assets.map((a,i)=>i?{...a,origin:'ai_generated'}:{...a,dependencies:['background']})}),/invalid_synthetic_graph/);
 });
});

describe('synthetic immutable publication and conditional rollback',()=>{
 it('publishes both pointers atomically, retains old objects and retries idempotently',()=>{
  const target=publisher();assert.equal(publishSynthetic(target.root,target.secret,'run_one',proof,target.expected),'published');
  assert.equal(publishSynthetic(target.root,target.secret,'run_one',proof,target.expected),'published');
  const pointers=query(target.root,'SELECT variant_id,object_hash,revision FROM pointers ORDER BY variant_id');
  assert.deepEqual(pointers.map(r=>r.object_hash),proof.outputs.map(o=>o.sha256));assert.deepEqual(pointers.map(r=>r.revision),[2,2]);
  for(const old of target.expected)assert.ok(fs.existsSync(path.join(target.root,'objects',old.hash)));
  assert.equal(rollbackSynthetic(target.root,target.secret,'run_one'),'rolled_back');assert.equal(rollbackSynthetic(target.root,target.secret,'run_one'),'rolled_back');
  const restored=query(target.root,'SELECT variant_id,object_hash,revision FROM pointers ORDER BY variant_id');
  assert.deepEqual(restored.map(r=>r.object_hash),target.expected.map(e=>e.hash));assert.deepEqual(restored.map(r=>r.revision),[3,3]);
 });
 it('rolls back all pointer writes if any expected revision changed',()=>{
  const target=publisher(),db=new DatabaseSync(path.join(target.root,'synthetic-publisher.sqlite'));db.prepare("UPDATE pointers SET revision=2 WHERE variant_id='beta'").run();db.close();
  assert.throws(()=>publishSynthetic(target.root,target.secret,'run_two',proof,target.expected),/synthetic_pointer_changed/);
  const pointers=query(target.root,'SELECT variant_id,object_hash,revision FROM pointers ORDER BY variant_id');
  assert.equal(pointers[0].object_hash,target.expected[0].hash);assert.equal(pointers[0].revision,1);assert.equal(pointers[1].revision,2);
  assert.equal(query(target.root,'SELECT * FROM runs').length,0);
  for(const output of proof.outputs)assert.equal(hash(fs.readFileSync(path.join(target.root,'objects',output.sha256))),output.sha256);
  const restore=new DatabaseSync(path.join(target.root,'synthetic-publisher.sqlite'));restore.prepare("UPDATE pointers SET revision=1 WHERE variant_id='beta'").run();restore.close();
  assert.equal(publishSynthetic(target.root,target.secret,'run_two',proof,target.expected),'published');
 });
 it('refuses rollback after another writer changes a pointer',()=>{
  const target=publisher();publishSynthetic(target.root,target.secret,'run_three',proof,target.expected);
  const db=new DatabaseSync(path.join(target.root,'synthetic-publisher.sqlite'));db.prepare("UPDATE pointers SET revision=revision+1 WHERE variant_id='beta'").run();db.close();
  assert.throws(()=>rollbackSynthetic(target.root,target.secret,'run_three'),/synthetic_pointer_changed/);
  assert.deepEqual(query(target.root,'SELECT object_hash FROM pointers ORDER BY variant_id').map(r=>r.object_hash),proof.outputs.map(o=>o.sha256));
 });
 it('refuses publishing or rollback when a backed-up old object is missing or corrupted',()=>{
  const missing=publisher();fs.unlinkSync(path.join(missing.root,'objects',missing.expected[0].hash));
  assert.throws(()=>publishSynthetic(missing.root,missing.secret,'missing_old',proof,missing.expected));
  assert.deepEqual(query(missing.root,'SELECT object_hash FROM pointers ORDER BY variant_id').map(r=>r.object_hash),missing.expected.map(e=>e.hash));
  const changed=publisher();publishSynthetic(changed.root,changed.secret,'bad_backup',proof,changed.expected);
  fs.writeFileSync(path.join(changed.root,'objects',changed.expected[0].hash),'corrupt');
  assert.throws(()=>rollbackSynthetic(changed.root,changed.secret,'bad_backup'),/input_hash_changed/);
  assert.deepEqual(query(changed.root,'SELECT object_hash FROM pointers ORDER BY variant_id').map(r=>r.object_hash),proof.outputs.map(o=>o.sha256));
 });
 it('does not claim a prior publication is current after another pointer change',()=>{
  const target=publisher();publishSynthetic(target.root,target.secret,'run_retry',proof,target.expected);
  const db=new DatabaseSync(path.join(target.root,'synthetic-publisher.sqlite'));db.prepare("UPDATE pointers SET revision=revision+1 WHERE variant_id='alpha'").run();db.close();
  assert.throws(()=>publishSynthetic(target.root,target.secret,'run_retry',proof,target.expected),/synthetic_pointer_changed/);
 });
 it('keeps one atomic result under overlapping publisher processes and allows retry',async()=>{
  const target=publisher(),payload=path.join(target.root,'concurrent-fixture.json');
  fs.writeFileSync(payload,JSON.stringify({root:target.root,secret:target.secret,expected:target.expected,proof:{receipt:proof.receipt,outputs:proof.outputs.map(o=>({...o,bytes:o.bytes.toString('base64')}))}}));
  const moduleUrl=pathToFileURL(path.resolve('scripts/lib/synthetic-render-proof.mjs')).href;
  const code=`import fs from 'node:fs';import {publishSynthetic} from ${JSON.stringify(moduleUrl)};const p=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));p.proof.outputs=p.proof.outputs.map(o=>({...o,bytes:Buffer.from(o.bytes,'base64')}));try{process.stdout.write(publishSynthetic(p.root,p.secret,'concurrent_run',p.proof,p.expected));}catch(e){process.stderr.write(String(e.message));process.exitCode=1;}`;
  const run=()=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--input-type=module','-e',code,payload],{env:{NODE_ENV:'test',TMPDIR:process.env.TMPDIR||'/tmp'}});let out='',err='';child.stdout.on('data',s=>out+=s);child.stderr.on('data',s=>err+=s);child.on('error',reject);child.on('close',status=>resolve({status,out,err}));});
  const results=await Promise.all([run(),run()]);
  assert.ok(results.some(r=>r.status===0&&r.out==='published'),JSON.stringify(results));
  for(const result of results)if(result.status!==0)assert.match(result.err,/locked|busy/i);
  assert.equal(query(target.root,"SELECT COUNT(*) AS n FROM runs WHERE run_id='concurrent_run'")[0].n,1);
  assert.equal(publishSynthetic(target.root,target.secret,'concurrent_run',proof,target.expected),'published');
  assert.deepEqual(query(target.root,'SELECT object_hash FROM pointers ORDER BY variant_id').map(r=>r.object_hash),proof.outputs.map(o=>o.sha256));
 });
 it('rejects altered proof bytes and refuses reusing a run ID for different data',()=>{
  const target=publisher();assert.throws(()=>publishSynthetic(target.root,target.secret,'bad',{...proof,outputs:proof.outputs.map((o,i)=>i?o:{...o,bytes:Buffer.from('altered')})},target.expected),/invalid_synthetic_publication/);
  publishSynthetic(target.root,target.secret,'run_four',proof,target.expected);
  assert.throws(()=>publishSynthetic(target.root,target.secret,'run_four',proof,target.expected.map(e=>({...e,revision:e.revision+1}))),/synthetic_run_conflict/);
 });
});
