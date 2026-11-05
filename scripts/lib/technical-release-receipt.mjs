import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { inspectBundle } from './release-artifact.mjs';
import { sha256File } from './source-identity.mjs';

export const TECHNICAL_PRIOR_RECEIPT_SHA256='8b04c8fe07ce6c7f782be4915a0a27faecb6315a0c46345de110a7512d6c3a0e';
export const TECHNICAL_IMAGE='sha256:045ab20ddbe8dfcc7f42f63ad18a2c4449a9fe5a10e023767321e2e0f261e579';
export const TECHNICAL_CHECKS=['checkout','setup','synthetic-fixtures','technical-gate-tests','check','built-worker-test','stop-dev','start-built-worker','worker-ready','synthetic-auth','synthetic-owner-copy',...['landing-loading','inspector-component','ui','product','artwork','album','privacy','performance'].flatMap(name=>['worker-still-owned',name]),'worker-final-owned'];
export function assertRegularArtifactTree(dir) {
  if(fs.lstatSync(dir).isSymbolicLink()) throw new Error('Artifact tree contains a symbolic link.');
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})) {
    const target=path.join(dir,entry.name);
    if(entry.isSymbolicLink()) throw new Error('Artifact tree contains a symbolic link.');
    if(entry.isDirectory()) assertRegularArtifactTree(target);
    else if(!entry.isFile()) throw new Error('Artifact tree contains a non-file entry.');
  }
}
export function signTechnicalReceipt(payload) {
  const {privateKey,publicKey}=crypto.generateKeyPairSync('ed25519');
  const bytes=Buffer.from(JSON.stringify(payload));
  return {payload,public_key:publicKey.export({type:'spki',format:'pem'}),signature:crypto.sign(null,bytes,privateKey).toString('base64')};
}
export function validateTechnicalReceipt({file,receiptSha256,source,now=new Date()}) {
  if(!/^[a-f0-9]{64}$/.test(receiptSha256??'') || sha256File(file)!==receiptSha256) throw new Error('Receipt digest is missing or does not match.');
  const value=JSON.parse(fs.readFileSync(file,'utf8'));
  if(!crypto.verify(null,Buffer.from(JSON.stringify(value.payload)),value.public_key,Buffer.from(value.signature,'base64'))) throw new Error('Technical receipt signature is invalid.');
  const r=value.payload;
  if(r.schema_version!==1 || r.kind!=='technical-candidate' || r.deployment!=='not_performed' || r.product_acceptance!=='not_claimed' || r.live_discord!=='not_tested') throw new Error('Technical receipt claims an unsupported outcome.');
  if(!source || source.dirty || r.source.sha!==source.sha || r.source.tree_hash!==source.tree_hash || r.source.content_hash!==source.content_hash) throw new Error('Technical receipt does not match clean source.');
  const age=(now.getTime()-Date.parse(r.generated_at))/3600000;
  if(!Number.isFinite(age)||age<0||age>24) throw new Error('Technical receipt is stale or future dated.');
  if(r.container.network!=='none'||r.container.host_mounts!==0||r.container.image!==TECHNICAL_IMAGE) throw new Error('Technical receipt lacks isolated container identity.');
  if(!Array.isArray(r.checks)) throw new Error('Technical checks are missing.');
  assertRegularArtifactTree(path.join(path.dirname(path.resolve(file)),'logs'));
  for(const [index,check] of r.checks.entries()) {
    if(!/^[a-z0-9-]+$/.test(check.name??'')) throw new Error('Invalid technical check name.');
    const log=path.join(path.dirname(path.resolve(file)),'logs',`${check.name}-${index}.log`);
    if(!fs.existsSync(log) || fs.lstatSync(log).isSymbolicLink() || sha256File(log)!==check.output_sha256) throw new Error(`Technical check log ${check.name} is missing or changed.`);
  }
  if(r.checks.length!==TECHNICAL_CHECKS.length) throw new Error('Technical check sequence is incomplete or ambiguous.');
  for(const [index,name] of TECHNICAL_CHECKS.entries()) {
    const check=r.checks[index];
    if(check?.name!==name || check.exit_code!==0 || check.signal || !/^[a-f0-9]{64}$/.test(check.output_sha256??'')) throw new Error(`Technical check ${name} is absent, out of order or failed.`);
  }
  if(r.artifact_directory!=='dist') throw new Error('Unexpected artifact directory.');
  const dist=path.join(path.dirname(path.resolve(file)),'dist');
  assertRegularArtifactTree(dist);
  const actual=inspectBundle({treeHash:source.tree_hash,contentHash:source.content_hash,sha:source.sha,distDir:dist});
  if(actual.sha256!==r.artifact.bundle_sha256 || actual.artifact.sha256!==r.artifact.artifact_sha256 || actual.artifact.file_count!==r.artifact.artifact_files) throw new Error('Tested artifact digest does not match receipt.');
  return {receipt:value,dist,artifact:actual};
}

// This emergency-sized path is deliberately an explicit file set, not a broad
// extension or directory allowlist. Anything else uses ordinary release gates.
const CORRECTIVE_PATHS=new Set([
  'src/components/LogoutButton.tsx','src/components/SiteHeader.astro','src/components/PublicVariantViewer.tsx','src/components/player/CardInspector.tsx','src/layouts/PlayerLayout.astro','src/pages/index.astro','src/styles/global.css',
  'package.json','pnpm-lock.yaml','docs/SKILLS.md','docs/pending/TECHNICAL_RELEASE_PROTOTYPE.md',
  'tests/workers/observability.test.ts','scripts/test-landing-loading.mjs','scripts/test-product-qa.mjs','scripts/test-auth-e2e.mjs','tests/browser/public-inspector.test.mjs','tests/scripts/technical-release-receipt.test.mjs','scripts/test-album-e2e.mjs',
  'scripts/deploy-production.mjs','scripts/test-deployed.mjs','scripts/record-release-acceptance.mjs','scripts/lib/technical-release-receipt.mjs',
  'scripts/technical-release-inspect.mjs','scripts/technical-release-process.mjs','scripts/technical-release-seed-copy.mjs',
  'scripts/technical-release-stop-dev.mjs','scripts/technical-release-supervisor.mjs','scripts/technical-release-worker-ready.mjs',
]);
const OPERATIONAL_ONLY_PATHS=new Set([
  'docs/ACCEPTANCE_CURRENT.md','docs/DISCORD_TOUR.md','docs/PERSISTENT_DEMO_2026-11-04.md','docs/RELEASE_2026-11-04.md',
  'scripts/discord/persistent-demo.mjs','scripts/discord/preflight.mjs','scripts/discord/verify-persistent-demo.mjs',
]);
export function requireCorrectivePaths(files) {
  if(!Array.isArray(files)||!files.length||files.some(file=>!CORRECTIVE_PATHS.has(file)&&!OPERATIONAL_ONLY_PATHS.has(file))) throw new Error('Technical corrective release includes paths outside its reviewed website scope.');
  return {corrective:files.filter(file=>CORRECTIVE_PATHS.has(file)),operational_only:files.filter(file=>OPERATIONAL_ONLY_PATHS.has(file)),operational_note:'Historical docs and operator scripts are not bundled or run by this release; Discord acceptance remains open.'};
}
export function priorVerifiedSource(receipts,currentVersion) {
  if(!/^[0-9a-f-]{36}$/i.test(currentVersion??'')) throw new Error('Current deployed Worker version is unknown.');
  const matches=receipts.filter(receipt=>receipt?.verified===true && receipt.deployment_version===currentVersion && /^[a-f0-9]{40}$/i.test(receipt.source_sha??''));
  const shas=[...new Set(matches.map(receipt=>receipt.source_sha))];
  if(shas.length!==1) throw new Error('Current Worker version has no unique verified source receipt.');
  return shas[0];
}

export function requireUnchangedMigrations(local,remote,priorReceipts,version) {
  const matches=priorReceipts.filter(r=>r?.verified===true && r.deployment_version===version);
  if(!Array.isArray(local)||!Array.isArray(remote)||!local.length||!remote.length || matches.length===0) throw new Error('Migration baseline is unavailable.');
  const valid=list=>Array.isArray(list)&&list.length>0&&list.every(name=>typeof name==='string'&&/^\d{4}_[a-z0-9_]+\.sql$/.test(name))&&new Set(list).size===list.length;
  if(!valid(local)||!valid(remote)||JSON.stringify(local)!==JSON.stringify(remote)) throw new Error('Production migrations differ from the candidate.');
  for(const receipt of matches) if(!valid(receipt.migrations?.remote)||JSON.stringify(receipt.migrations.remote)!==JSON.stringify(remote)) throw new Error('Production migrations differ from the verified deployed baseline.');
  return remote;
}

export function singleServingVersion(deployment) {
  const versions=deployment?.versions;
  if(!Array.isArray(versions)||versions.length!==1||versions[0]?.percentage!==100||!/^[0-9a-f-]{36}$/i.test(versions[0]?.version_id??'')) throw new Error('Production deployment is not a single fully serving Worker version.');
  return versions[0].version_id.toLowerCase();
}

export function reportedUploadVersion(stdout) {
  const matches=[...String(stdout??'').matchAll(/^Current Version ID:\s*([0-9a-f-]{36})\s*$/gim)].map(match=>match[1].toLowerCase());
  return matches.length===1 ? matches[0] : null;
}

export function requireSameSource(initial,current) {
  if(!initial||!current||current.dirty||initial.sha!==current.sha||initial.tree_hash!==current.tree_hash||initial.content_hash!==current.content_hash) throw new Error('Source changed during qualification.');
}
export function requireSameDeployment(initial,current) {
  if(!initial?.id || current?.id!==initial.id || singleServingVersion(current)!==singleServingVersion(initial)) throw new Error('Production deployment changed during qualification.');
}
