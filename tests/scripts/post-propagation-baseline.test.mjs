import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FOLLOW_UP_FILES, readPostPropagationBaseline, validatePostPropagationBaseline } from '../../scripts/lib/post-propagation-baseline.mjs';
import { priorVerifiedSource, requireUnchangedMigrations } from '../../scripts/lib/technical-release-receipt.mjs';
const source='ae1c074d3f383880dc9aa47455c4d7817ae91483',version='1bf907c5-ee50-48c4-8dd5-bbedf3eb2896',id='bf9bcf8a-cf73-4ec2-9b03-df61debee51d',origin='https://foilbury.loftwah.com';
const deployment={id,versions:[{version_id:version,percentage:100}]};
function fixture() {
 const failed={generated_at:'2026-11-05T12:57:08Z',base:origin,expected_build:source,results:[{name:'deployed smoke',status:'FAIL'}]};
 const receipt={schema_version:2,generated_at:'2026-11-05T12:57:09Z',environment:'production',origin,verified:false,source_sha:source,deployment_status:'matched_upload',upload_version:version,deployment_version:version,active_version_after_smoke:version,deployment,smoke:{sha256:FOLLOW_UP_FILES.failed[1],results:failed},migrations:{remote:['0001_init.sql'],pending:[],error:null}};
 const passed={generated_at:'2026-11-05T12:58:05Z',base:origin,expected_build:source,results:[{name:'production answers with the expected source build identity',status:'PASS',detail:source.slice(0,12)},...Array.from({length:17},()=>({name:'check',status:'PASS'}))]};
 const followup={generated_at:'2026-11-05T13:01:09Z',kind:'post-propagation-live-verification',source_sha:source,worker_version:version,deployment_id:id,original_receipt:{file:FOLLOW_UP_FILES.receipt[0],sha256:FOLLOW_UP_FILES.receipt[1]},subsequent_smoke:{file:FOLLOW_UP_FILES.passed[0],sha256:FOLLOW_UP_FILES.passed[1],pass_count:18}};
 return {receipt,failed,passed,followup};
}
test('only a consistent later smoke and live source form a separate baseline',()=>{
 const f=fixture(), baseline=validatePostPropagationBaseline(f,deployment,source);
 assert.equal(f.receipt.verified,false);assert.equal(baseline.original_receipt_verified,false);
 assert.equal(priorVerifiedSource([baseline],version),source);
 assert.deepEqual(requireUnchangedMigrations(['0001_init.sql'],['0001_init.sql'],[baseline],version),['0001_init.sql']);
});
test('rejects changed, incomplete, out-of-order, or conflicting evidence',()=>{
 const mutations=[
 f=>f.receipt.verified=true, f=>f.receipt.upload_version='bad', f=>f.receipt.smoke.sha256='0'.repeat(64),
 f=>f.failed.results[0].status='PASS', f=>f.passed.results.pop(), f=>f.passed.results[3].status='FAIL',
 f=>f.passed.expected_build='bad', f=>f.followup.original_receipt.sha256='bad', f=>f.followup.subsequent_smoke.sha256='bad',
 f=>f.followup.generated_at='2026-11-05T12:00:00Z', f=>f.receipt.migrations.pending=['0002_x.sql'],
 ];
 for(const change of mutations) {const f=fixture();change(f);assert.throws(()=>validatePostPropagationBaseline(f,deployment,source));}
 for(const live of ['bad',null]) assert.throws(()=>validatePostPropagationBaseline(fixture(),deployment,live));
 for(const current of [{...deployment,id:'other'},{...deployment,versions:[{version_id:version,percentage:50}]}]) assert.throws(()=>validatePostPropagationBaseline(fixture(),current,source));
});
test('loader rejects fabricated files and symlinks before parsing',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'foilbury-baseline-'));
 try {fs.writeFileSync(path.join(dir,FOLLOW_UP_FILES.receipt[0]),'{}');assert.throws(()=>readPostPropagationBaseline(dir,deployment,source),/missing or changed/);fs.unlinkSync(path.join(dir,FOLLOW_UP_FILES.receipt[0]));fs.symlinkSync('/dev/null',path.join(dir,FOLLOW_UP_FILES.receipt[0]));assert.throws(()=>readPostPropagationBaseline(dir,deployment,source),/missing or changed/);} finally {fs.rmSync(dir,{recursive:true,force:true});}
});
