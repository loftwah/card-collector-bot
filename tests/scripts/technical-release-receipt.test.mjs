import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {artifactManifest} from '../../scripts/lib/release-artifact.mjs';
import {sha256File} from '../../scripts/lib/source-identity.mjs';
import {TECHNICAL_CHECKS,TECHNICAL_IMAGE,signTechnicalReceipt,validateTechnicalReceipt} from '../../scripts/lib/technical-release-receipt.mjs';
const source={sha:'a'.repeat(40),tree_hash:'b'.repeat(64),content_hash:'c'.repeat(64),dirty:''};
function fixture(fn) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'technical-receipt-test-'));
  try {
    const dist=path.join(dir,'dist'),server=path.join(dist,'server'),client=path.join(dist,'client');
    fs.mkdirSync(server,{recursive:true});fs.mkdirSync(client,{recursive:true});
    const entry=path.join(server,'entry.mjs'); fs.writeFileSync(entry,'export default {}');fs.writeFileSync(path.join(client,'app.css'),'body{}');
    const manifest=artifactManifest(dist),bundle=sha256File(entry);
    fs.writeFileSync(path.join(server,'build-meta.json'),JSON.stringify({source_sha:source.sha,source_tree_hash:source.tree_hash,source_content_hash:source.content_hash,bundle:{sha256:bundle,bytes:fs.statSync(entry).size},artifact:manifest}));
    const logs=path.join(dir,'logs');fs.mkdirSync(logs);const logDigest=[];
    TECHNICAL_CHECKS.forEach((name,index)=>{const file=path.join(logs,`${name}-${index}.log`);fs.writeFileSync(file,`${name} output`);logDigest[index]=sha256File(file);});
    const payload={schema_version:1,kind:'technical-candidate',generated_at:new Date().toISOString(),source,artifact:{bundle_sha256:bundle,artifact_sha256:manifest.sha256,artifact_files:manifest.file_count},artifact_directory:'dist',container:{image:TECHNICAL_IMAGE,network:'none',host_mounts:0},checks:TECHNICAL_CHECKS.map((name,index)=>({name,exit_code:0,signal:null,output_sha256:logDigest[index]})),product_acceptance:'not_claimed',live_discord:'not_tested',deployment:'not_performed'};
    const file=path.join(dir,'receipt.json');const save=value=>fs.writeFileSync(file,JSON.stringify(value));save(signTechnicalReceipt(payload));
    fn({dir,dist,file,payload,save,validate:()=>validateTechnicalReceipt({file,receiptSha256:sha256File(file),source})});
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
}
test('binds receipt to source, complete checks and tested artifact',()=>fixture(f=>{
  assert.equal(f.validate().dist,f.dist);
  fs.writeFileSync(path.join(f.dist,'client','app.css'),'changed');
  assert.throws(()=>f.validate(),/artifact|changed/i);
}));
test('rejects fake, failed, missing and duplicate checks',()=>fixture(f=>{
  for(const mutate of [p=>p.checks.pop(),p=>p.checks[0].exit_code=1,p=>p.checks.push(p.checks[0]),p=>p.product_acceptance='pass']) {
    const copy=structuredClone(f.payload);mutate(copy);f.save(signTechnicalReceipt(copy));assert.throws(()=>f.validate());
  }
}));
test('requires pinned digest and rejects signature or source changes',()=>fixture(f=>{
  assert.throws(()=>validateTechnicalReceipt({file:f.file,receiptSha256:'0'.repeat(64),source}),/digest/);
  const value=JSON.parse(fs.readFileSync(f.file));value.payload.source.sha='f'.repeat(40);f.save(value);assert.throws(()=>f.validate(),/signature/);
  f.save(signTechnicalReceipt(f.payload));assert.throws(()=>validateTechnicalReceipt({file:f.file,receiptSha256:sha256File(f.file),source:{...source,content_hash:'0'.repeat(64)}}),/source/);
}));
test('rejects artifact symlinks and stale receipts',()=>fixture(f=>{
  fs.symlinkSync('/tmp',path.join(f.dist,'client','link'));assert.throws(()=>f.validate(),/symbolic/);
  fs.unlinkSync(path.join(f.dist,'client','link'));const old={...f.payload,generated_at:'2000-01-01T00:00:00Z'};f.save(signTechnicalReceipt(old));assert.throws(()=>f.validate(),/stale/);
}));

test('corrective scope and prior production identity fail closed',async()=>{
  const {requireCorrectivePaths,priorVerifiedSource}=await import('../../scripts/lib/technical-release-receipt.mjs');
  assert.deepEqual(requireCorrectivePaths(['src/pages/index.astro']),['src/pages/index.astro']);
  for(const paths of [[],['src/server/api/router.ts'],['migrations/0999.sql'],['src/pages/index.astro','wrangler.production.jsonc']]) assert.throws(()=>requireCorrectivePaths(paths));
  const version='12345678-1234-1234-1234-123456789abc',sha='a'.repeat(40);
  assert.equal(priorVerifiedSource([{verified:true,deployment_version:version,source_sha:sha}],version),sha);
  assert.throws(()=>priorVerifiedSource([],version));
  assert.throws(()=>priorVerifiedSource([{verified:true,deployment_version:version,source_sha:sha},{verified:true,deployment_version:version,source_sha:'b'.repeat(40)}],version));
});

test('rejects altered command output',()=>fixture(f=>{
  fs.writeFileSync(path.join(f.dir,'logs','ui-16.log'),'different output');
  assert.throws(()=>f.validate(),/log/);
}));

test('legacy acceptance recorder cannot self-attest or skip checks',()=>{
  for(const args of [[],['--skip-checks']]) {
    const result=spawnSync(process.execPath,['scripts/record-release-acceptance.mjs',...args],{encoding:'utf8'});
    assert.equal(result.status,2);assert.match(result.stderr,/held/);
  }
});
