#!/usr/bin/env node
/** Build once, deploy that exact artifact and verify the live Worker. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { sourceState, sha256File } from './lib/source-identity.mjs';
import { inspectBundle } from './lib/release-artifact.mjs';
import { resolveRollback, verifyFreshRemote } from './lib/release-scope.mjs';
import {
  assertMigrationParity,
  assertReleaseBudget,
  needsDrawLoadingCheck,
  releaseBudget,
  PRE_DEPLOY_BUDGET_SECONDS,
} from './lib/routine-release.mjs';
import { singleServingVersion, reportedUploadVersion, requireSameSource, requireSameDeployment } from './lib/technical-release-receipt.mjs';

const args = process.argv.slice(2);
if (args.some(a => a !== '--check' && a !== '--technical')) throw new Error('Usage: deploy-production.mjs [--check]');
const checkOnly = args.includes('--check');
const root = process.cwd(), config = 'wrangler.production.jsonc';
const wrangler = path.join(root, 'node_modules/.bin/wrangler');
const env = { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false', CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false', FORCE_COLOR: '0' };
try {
  const vars=fs.readFileSync(path.join(root,'.env'),'utf8');
  for (const [key, target] of [['CF_API_TOKEN','CLOUDFLARE_API_TOKEN'],['CF_ACCOUNT_ID','CLOUDFLARE_ACCOUNT_ID']]) {
    const value=vars.match(new RegExp(`^${key}=(.*)$`,'m'))?.[1]?.trim();
    if (value && !env[target]) env[target]=value;
  }
} catch (e) { if(e.code !== 'ENOENT') throw e; }
function capture(cmd,argv,options={}) { return execFileSync(cmd,argv,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],...options}).trim(); }
function run(cmd,argv,options={}) {
  const start=Date.now();
  const result=spawnSync(cmd,argv,{cwd:root,stdio:'inherit',env,...options});
  const seconds=(Date.now()-start)/1000;
  console.log(`${cmd} ${argv.join(' ')}: ${seconds.toFixed(1)}s`);
  if(result.status!==0) throw new Error(`${cmd} failed (${result.status ?? result.signal})`);
  return seconds;
}
function deployments() {
  const text=capture(wrangler,['deployments','list','--config',config,'--json'],{env});
  const data=JSON.parse(text.slice(text.indexOf('[')));
  if(!Array.isArray(data)||!data.length) throw new Error('Cannot read production deployments.');
  return data.sort((a,b)=>Date.parse(b.created_on)-Date.parse(a.created_on));
}
function migrations() {
  const text=capture(wrangler,['d1','execute','foilbury','--remote','--config',config,'--json','--command','SELECT name FROM d1_migrations ORDER BY id;'],{env});
  const data=JSON.parse(text.slice(text.indexOf('[')));
  if(!Array.isArray(data)||data.length!==1||data[0].success!==true||!Array.isArray(data[0].results)) throw new Error('Cannot read production migrations.');
  const remote=data[0].results.map(r=>r.name);
  const local=fs.readdirSync('migrations').filter(n=>n.endsWith('.sql')).sort();
  return assertMigrationParity(local, remote);
}
async function liveBuild() {
  const response=await fetch('https://foilbury.loftwah.com/',{cache:'no-store',signal:AbortSignal.timeout(15000)});
  if(!response.ok) throw new Error(`Production home returned ${response.status}`);
  const sha=response.headers.get('x-foilbury-build');
  if(!/^[a-f0-9]{40}$/.test(sha??'')) throw new Error('Production build identity is missing.');
  return sha;
}
const started=Date.now();
const timings={};
capture('git',['fetch','--no-tags','--quiet','origin','main']);
const source=sourceState();
const remote=capture('git',['ls-remote','origin','refs/heads/main']).split(/\s+/)[0];
verifyFreshRemote({localOriginMain:source.origin_main,remoteSha:remote,fetchedAt:new Date().toISOString()});
if(source.dirty || source.ahead!==0 || source.behind!==0) throw new Error('Release requires clean current origin/main.');
const previous=deployments()[0], rollback=resolveRollback([previous]);
if(singleServingVersion(previous)!==rollback.version_id.toLowerCase()) throw new Error('Rollback target is not the only serving version.');
const beforeBuild=await liveBuild();
capture('git',['merge-base','--is-ancestor',beforeBuild,source.sha]);
const schema=migrations();
const changed=capture('git',['diff','--name-only',`${beforeBuild}..${source.sha}`]).split(/\r?\n/).filter(Boolean);
timings.check_seconds=run('pnpm',['check']);
if(needsDrawLoadingCheck(changed)) timings.draw_loading_seconds=run('node',['--test','tests/browser/draw-odds-loading.test.mjs']);
timings.build_seconds=run('node',['scripts/build-production.mjs','--skip-typecheck']);
requireSameSource(source,sourceState());
let bundle=inspectBundle({treeHash:source.tree_hash,contentHash:source.content_hash,sha:source.sha});
async function recheck() {
  requireSameSource(source,sourceState());
  const current=capture('git',['ls-remote','origin','refs/heads/main']).split(/\s+/)[0];
  if(current!==source.sha) throw new Error('origin/main changed during release.');
  requireSameDeployment(previous,deployments()[0]);
  if(await liveBuild()!==beforeBuild) throw new Error('Production build changed during release.');
  if(JSON.stringify(migrations())!==JSON.stringify(schema)) throw new Error('Production migrations changed during release.');
  const currentBundle=inspectBundle({treeHash:source.tree_hash,contentHash:source.content_hash,sha:source.sha});
  if(currentBundle.artifact.sha256!==bundle.artifact.sha256) throw new Error('Build changed after checks.');
}
await recheck();
const preDeploySeconds=(Date.now()-started)/1000;
timings.pre_deploy_seconds=preDeploySeconds;
assertReleaseBudget(preDeploySeconds, checkOnly ? undefined : PRE_DEPLOY_BUDGET_SECONDS);
if(checkOnly) {
  const budget=releaseBudget(preDeploySeconds);
  console.log(`Release check passed in ${budget.elapsed_seconds.toFixed(1)}s (${budget.limit_seconds}s budget); no deployment performed.`);
  process.exit(0);
}
const deployStarted=Date.now();
const result=spawnSync(wrangler,['deploy','--config',config,'--var',`FOILBURY_BUILD_SHA:${source.sha}`],{cwd:root,env,encoding:'utf8',maxBuffer:32*1024*1024});
timings.deploy_seconds=(Date.now()-deployStarted)/1000;
if(result.status!==0) { console.error(result.stderr); throw new Error('Deployment failed; inspect production before retrying.'); }
const uploaded=reportedUploadVersion(result.stdout);
const runId=randomUUID();
let after=null, verificationError=null;
try {
  after=deployments()[0];
  if(!uploaded||singleServingVersion(after)!==uploaded) throw new Error('Uploaded version is not the sole serving version.');
  let observed=false;
  for(let i=0;i<30;i++) {
    try { if(await liveBuild()===source.sha) { observed=true; break; } } catch {}
    await new Promise(resolve=>setTimeout(resolve,2000));
  }
  if(!observed) throw new Error('The expected build did not propagate within 60 seconds.');
  timings.smoke_seconds=run('node',['scripts/test-deployed.mjs'],{env:{...env,FOILBURY_URL:'https://foilbury.loftwah.com',FOILBURY_EXPECTED_BUILD:source.sha,FOILBURY_SMOKE_RUN_ID:runId}});
  requireSameDeployment(after,deployments()[0]);
} catch (error) { verificationError=String(error?.message ?? error); }
const dir=path.join(root,'.foilbury/evidence'); fs.mkdirSync(dir,{recursive:true,mode:0o700});
const roundedTimings=Object.fromEntries(Object.entries(timings).map(([key,value])=>[key,Math.round(value*10)/10]));
const budget={...releaseBudget((Date.now()-started)/1000),...roundedTimings};
const receipt={generated_at:new Date().toISOString(),source_sha:source.sha,deployment_version:uploaded,deployment:after,previous_deployment:previous,rollback,changed_paths:changed,migrations:schema,artifact_sha256:bundle.artifact.sha256,smoke:`deployed-smoke-${runId}.json`,verified:verificationError===null,verification_scope:'deployment identity and read-only HTTP smoke',product_acceptance:'not_assessed',unverified_reason:verificationError,elapsed_seconds:budget.elapsed_seconds,budget};
const file=path.join(dir,`release-receipt-${source.sha.slice(0,12)}-${runId}.json`);
fs.writeFileSync(file,JSON.stringify(receipt,null,2),{flag:'wx',mode:0o600});
if(verificationError) throw new Error(`Upload ${uploaded ?? 'unknown'} is unverified: ${verificationError}. Inspect ${file} before retrying.`);
console.log(`Production deployment identity and HTTP smoke verified: ${source.sha} / ${uploaded} (${receipt.elapsed_seconds.toFixed(1)}s of a ${budget.limit_seconds}s budget; ${budget.within_budget ? 'within budget' : 'OVER BUDGET'}). Product acceptance not assessed; exercise the affected live journey. Receipt: ${file}`);
