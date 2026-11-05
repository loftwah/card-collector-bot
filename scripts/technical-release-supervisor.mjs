#!/usr/bin/env node
/** Disposable, offline technical qualification. This does not deploy or claim
 * product/demo acceptance. It records only commands that actually completed. */
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sourceState, sha256File } from './lib/source-identity.mjs';
import { signTechnicalReceipt, validateTechnicalReceipt, TECHNICAL_IMAGE } from './lib/technical-release-receipt.mjs';

const image = process.argv[2];
if (image !== TECHNICAL_IMAGE || process.argv.length !== 3) {
  console.error('Supply the reviewed local immutable Docker image ID.'); process.exit(2);
}
const before=sourceState();
if (before.dirty) { console.error('A clean source checkout is required.'); process.exit(2); }
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'foilbury-technical-'));
const bundle=path.join(tmp,'source.bundle');
const name=`foilbury-technical-${randomUUID()}`;
const checks=[];
let created=false, success=false;
function call(bin,args,opts={}) {
  const r=spawnSync(bin,args,{encoding:'utf8',maxBuffer:32*1024*1024,...opts});
  if(r.error) throw r.error;
  return r;
}
function must(bin,args) {
  const r=call(bin,args); if(r.status!==0) throw new Error(`${bin} ${args[0]} failed (${r.status ?? 'signal'}).`); return r.stdout.trim();
}
function step(name,args) {
  const started=new Date().toISOString();
  const r=call('docker',['exec','--workdir','/sandbox/project','--env','CI=true',nameOfContainer(),...args],{timeout:600_000});
  const bytes=Buffer.from(`${r.stdout ?? ''}\n${r.stderr ?? ''}`);
  fs.writeFileSync(path.join(tmp,`${name}-${checks.length}.log`),bytes,{mode:0o600,flag:'wx'});
  checks.push({name,started_at:started,completed_at:new Date().toISOString(),exit_code:r.status,signal:r.signal,output_sha256:createHash('sha256').update(bytes).digest('hex')});
  console.log(`${name}: ${r.status===0?'PASS':'FAIL'}`);
  if(r.status!==0) throw new Error(`${name} failed; no technical pass was issued.`);
}
function nameOfContainer(){return name;}
try {
  const imageId=must('docker',['image','inspect','--format','{{.Id}}',image]);
  if(imageId!==image) throw new Error('Image identity did not match.');
  must('git',['bundle','create',bundle,'HEAD']);
  must('docker',['create','--name',name,'--network','none','--entrypoint','sleep','--workdir','/sandbox/project',image,'infinity']); created=true;
  must('docker',['start',name]);
  const inspect=JSON.parse(must('docker',['inspect',name]));
  const c=inspect[0];
  if(c.Image!==image || c.HostConfig.NetworkMode!=='none' || c.Mounts.length!==0 || c.HostConfig.Privileged || c.HostConfig.Binds?.length) throw new Error('Container isolation mismatch.');
  const allowedEnv=new Set(['PATH','LANG','LC_ALL','PLAYWRIGHT_BROWSERS_PATH']);
  if((c.Config.Env??[]).some(entry=>!allowedEnv.has(entry.split('=',1)[0]))) throw new Error('Container image has unexpected environment variables.');
  must('docker',['cp',bundle,`${name}:/tmp/source.bundle`]);
  const imageLock=must('docker',['exec',name,'sha256sum','/sandbox/project/pnpm-lock.yaml']).split(/\s+/)[0];
  if(imageLock!==sha256File('pnpm-lock.yaml')) throw new Error('Dependency image lockfile differs from the source.');
  step('checkout', ['sh','-c',`set -eu; test ! -e .git; test ! -e .env; test ! -e .dev.vars; test ! -e .wrangler; test ! -e .foilbury; git init -q; git fetch -q /tmp/source.bundle HEAD; git reset -q --hard FETCH_HEAD; test "$(git rev-parse HEAD)" = '${before.sha}'; test -z "$(git status --porcelain)"; corepack enable pnpm`]);
  step('setup', ['pnpm','setup:local','--skip-sources']);
  step('synthetic-fixtures', ['node','scripts/setup-ci-fixtures.mjs']);
  step('technical-gate-tests', ['node','--test','tests/scripts/technical-release-receipt.test.mjs']);
  step('check', ['pnpm','check']);
  step('built-worker-test', ['pnpm','test:production-path']);
  step('stop-dev', ['node','scripts/technical-release-stop-dev.mjs']);
  step('start-built-worker', ['sh','-c','set -eu; nohup pnpm exec wrangler dev --config dist/server/wrangler.json --local --no-bundle --port 5173 --persist-to /sandbox/project/.wrangler/state --env-file /sandbox/project/.dev.vars >/tmp/built-worker.log 2>&1 </dev/null & echo $! >/tmp/foilbury-worker.pid']);
  step('worker-ready', ['node','scripts/technical-release-worker-ready.mjs']);
  step('synthetic-auth', ['node','scripts/test-auth-e2e.mjs']);
  step('synthetic-owner-copy', ['node','scripts/technical-release-seed-copy.mjs']);
  for (const [name,cmd] of [
    ['landing-loading',['node','scripts/test-landing-loading.mjs']],['inspector-component',['node','--test','tests/browser/public-inspector.test.mjs']],
    ['ui',['pnpm','test:ui']],['product',['pnpm','test:product']],['artwork',['pnpm','test:artwork']],
    ['album',['node','scripts/test-album-e2e.mjs']],['privacy',['node','scripts/test-privacy.mjs']],['performance',['pnpm','perf:local']],
  ]) { step('worker-still-owned', ['node','scripts/technical-release-worker-ready.mjs']); step(name,cmd); }
  step('worker-final-owned', ['node','scripts/technical-release-worker-ready.mjs']);
  const artifact=JSON.parse(must('docker',['exec','--workdir','/sandbox/project',name,'node','scripts/technical-release-inspect.mjs']));
  const after=sourceState();
  if(after.sha!==before.sha || after.dirty || after.tree_hash!==before.tree_hash || after.content_hash!==before.content_hash) throw new Error('Host source changed during qualification.');
  const base=path.join(process.cwd(),'.foilbury');
  const out=path.join(base,'evidence');
  for(const directory of [base,out]) {
    try {if(!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) throw new Error('Evidence destination is not a real directory.');}
    catch(error) {if(error.code!=='ENOENT') throw error; fs.mkdirSync(directory,{mode:0o700});}
  }
  const runDir=fs.mkdtempSync(path.join(out,'technical-candidate-'));
  must('docker',['cp',`${name}:/sandbox/project/dist`,path.join(runDir,'dist')]);
  const logs=path.join(runDir,'logs'); fs.mkdirSync(logs,{mode:0o700});
  for(const entry of fs.readdirSync(tmp)) if(entry.endsWith('.log')) fs.copyFileSync(path.join(tmp,entry),path.join(logs,entry),fs.constants.COPYFILE_EXCL);
  const receipt={schema_version:1,kind:'technical-candidate',generated_at:new Date().toISOString(),source:{sha:before.sha,tree_hash:before.tree_hash,content_hash:before.content_hash},artifact,artifact_directory:'dist',container:{image,network:'none',host_mounts:0},checks,product_acceptance:'not_claimed',live_discord:'not_tested',deployment:'not_performed'};
  const file=path.join(runDir,'receipt.json'); fs.writeFileSync(file,`${JSON.stringify(signTechnicalReceipt(receipt),null,2)}\n`,{mode:0o600,flag:'wx'});
  const digest=sha256File(file);
  validateTechnicalReceipt({file,receiptSha256:digest,source:after});
  console.log(`Technical candidate receipt: ${file} · sha256 ${digest}`);
  success=true;
} catch(error) {
  console.error(`Technical qualification incomplete: ${error.message}`); process.exitCode=1;
} finally {
  if(success) {
    if(created) { const result=call('docker',['rm','-f',name]); if(result.status!==0){console.error(`Owned container retained: ${name}`);process.exitCode=1;} }
    try {fs.rmSync(tmp,{recursive:true,force:true});} catch {console.error(`Owned temporary bundle retained: ${tmp}`);process.exitCode=1;}
  } else {
    if(created) console.error(`Incomplete run retained for diagnosis: ${name}`);
    console.error(`Source bundle retained for diagnosis: ${tmp}`);
  }
}
