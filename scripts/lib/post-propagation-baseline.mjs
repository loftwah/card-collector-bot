import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { singleServingVersion } from './technical-release-receipt.mjs';

// Reviewed immutable evidence from the 2026-11-05 release. These pins are
// deliberately source-controlled: a local file cannot attest itself by naming
// its own hash. This is a single recovery record, not a general bypass.
export const FOLLOW_UP_FILES = Object.freeze({
  receipt: ['release-receipt-ae1c074d3f38-3881ab24-c0a0-4114-a928-bd6158b3c397.json','e0c6ab3ec769a5e0782f768fbb7642a5a24271f53230e27295809bf8f77a4e59'],
  failed: ['deployed-smoke-3881ab24-c0a0-4114-a928-bd6158b3c397.json','ad08cce8236da3d646a284a01aa7bba85a4badd1c28590b27c37e80bafd308b7'],
  passed: ['deployed-smoke-4613aba4-0e15-446b-82f2-580b898410ef.json','b1f51633592e5a9843cdfc6fa008d72a0684cd1978869c2d3b781ac461954484'],
  followup: ['live-verification-425598c1-722a-49ec-8127-5934676e88d0.json','412b32c1df3a3740c569cf0443ab993d7be1907f0e84d0cf4852d0237c16ffcf'],
});
const SOURCE='ae1c074d3f383880dc9aa47455c4d7817ae91483';
const VERSION='1bf907c5-ee50-48c4-8dd5-bbedf3eb2896';
const DEPLOYMENT='bf9bcf8a-cf73-4ec2-9b03-df61debee51d';
const ORIGIN='https://foilbury.loftwah.com';

export function readPostPropagationBaseline(dir, deployment, liveSource) {
  const values={};
  for (const [key,[name,digest]] of Object.entries(FOLLOW_UP_FILES)) {
    const file=path.join(dir,name);
    let fd;
    try {
      fd=fs.openSync(file,fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      if(!fs.fstatSync(fd).isFile()) throw new Error('not a regular file');
      const bytes=fs.readFileSync(fd);
      if(createHash('sha256').update(bytes).digest('hex')!==digest) throw new Error('digest mismatch');
      values[key]=JSON.parse(bytes.toString('utf8'));
    } catch { throw new Error(`Post-propagation ${key} evidence is missing or changed.`); }
    finally { if(fd!==undefined) fs.closeSync(fd); }
  }
  return validatePostPropagationBaseline(values, deployment, liveSource);
}

export function validatePostPropagationBaseline(values, deployment, liveSource) {
  const {receipt,failed,passed,followup}=values;
  const chronological=[failed.generated_at,receipt.generated_at,passed.generated_at,followup.generated_at].map(Date.parse);
  if(chronological.some(n=>!Number.isFinite(n)) || chronological.some((n,i)=>i>0 && n<chronological[i-1])) throw new Error('Post-propagation evidence is out of order.');
  if(receipt.schema_version!==2 || receipt.environment!=='production' || receipt.origin!==ORIGIN || receipt.verified!==false || receipt.source_sha!==SOURCE || receipt.deployment_status!=='matched_upload' || receipt.upload_version!==VERSION || receipt.deployment_version!==VERSION || receipt.active_version_after_smoke!==VERSION || receipt.deployment?.id!==DEPLOYMENT || singleServingVersion(receipt.deployment)!==VERSION) throw new Error('Original release receipt is not the expected unverified deployment.');
  if(receipt.smoke?.sha256!==FOLLOW_UP_FILES.failed[1] || JSON.stringify(receipt.smoke.results)!==JSON.stringify(failed) || failed.base!==ORIGIN || failed.expected_build!==SOURCE || failed.results?.length!==1 || failed.results[0].name!=='deployed smoke' || failed.results[0].status!=='FAIL') throw new Error('Original failed smoke is not preserved.');
  if(passed.base!==ORIGIN || passed.expected_build!==SOURCE || passed.results?.length!==18 || passed.results.some(r=>r.status!=='PASS') || passed.results[0].name!=='production answers with the expected source build identity' || passed.results[0].detail!==SOURCE.slice(0,12)) throw new Error('Follow-up smoke is incomplete or mismatched.');
  if(followup.kind!=='post-propagation-live-verification' || followup.source_sha!==SOURCE || followup.worker_version!==VERSION || followup.deployment_id!==DEPLOYMENT || followup.original_receipt?.file!==FOLLOW_UP_FILES.receipt[0] || followup.original_receipt?.sha256!==FOLLOW_UP_FILES.receipt[1] || followup.subsequent_smoke?.file!==FOLLOW_UP_FILES.passed[0] || followup.subsequent_smoke?.sha256!==FOLLOW_UP_FILES.passed[1] || followup.subsequent_smoke?.pass_count!==18) throw new Error('Supplemental verification does not link the preserved records.');
  if(deployment?.id!==DEPLOYMENT || singleServingVersion(deployment)!==VERSION || liveSource!==SOURCE) throw new Error('Live Worker or source header no longer matches this baseline.');
  if(!Array.isArray(receipt.migrations?.remote) || receipt.migrations.pending?.length!==0 || receipt.migrations.error) throw new Error('Original migration record is incomplete.');
  return {kind:'post-propagation-baseline',source_sha:SOURCE,deployment_version:VERSION,migrations:receipt.migrations, evidence_sha256:Object.fromEntries(Object.entries(FOLLOW_UP_FILES).map(([key,value])=>[key,value[1]])), original_receipt_verified:false};
}
