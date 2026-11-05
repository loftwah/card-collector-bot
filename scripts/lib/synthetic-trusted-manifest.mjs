/** Local fixture experiment. A trusted signer must establish graph completeness
 * independently; signature and hashes alone cannot establish provenance. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const canonical=x=>Array.isArray(x)?`[${x.map(canonical).join(',')}]`:x&&typeof x==='object'?`{${Object.keys(x).sort().map(k=>`${JSON.stringify(k)}:${canonical(x[k])}`).join(',')}}`:JSON.stringify(x);
const name=s=>typeof s==='string'&&/^[a-z0-9][a-z0-9_-]{0,79}$/.test(s);
const hex=s=>typeof s==='string'&&/^[0-9a-f]{64}$/.test(s);
const keys=(o,k)=>o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).sort().join(',')===k.slice().sort().join(',');
const fail=()=>{throw new Error('untrusted_manifest');};
/** Verify signed canonical bytes against a separately provided issuer key and
 * expected operation; then capture all named bytes into a fresh local snapshot.
 * No network, D1, R2 or production authorisation is provided by this module. */
export function createManifestSandbox(){const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'foilbury-manifest-test-'));const secret=crypto.randomBytes(24).toString('hex');fs.writeFileSync(path.join(root,'.synthetic-only'),secret,{flag:'wx',mode:0o600});return {root,secret};}
export function verifyAndCaptureSynthetic({root,secret,manifestBytes,signature,publicKey,expected,sourceDir,snapshotDir,now=Date.now()}){
 const realRoot=fs.realpathSync(root);if(realRoot!==path.resolve(root)||path.dirname(realRoot)!==fs.realpathSync(os.tmpdir())||!path.basename(realRoot).startsWith('foilbury-manifest-test-'))fail();const marker=fs.openSync(path.join(realRoot,'.synthetic-only'),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{if(fs.readFileSync(marker,'utf8')!==secret)fail();}finally{fs.closeSync(marker);}if(!path.resolve(sourceDir).startsWith(realRoot+path.sep)||path.dirname(path.resolve(snapshotDir))!==realRoot)fail();
 if(!Buffer.isBuffer(manifestBytes)||manifestBytes.length>100_000||!Buffer.isBuffer(signature)||signature.length!==64||!keys(expected,['issuer','operation','toolchainSha256'])||!hex(expected.toolchainSha256))fail();
 let m;try{m=JSON.parse(manifestBytes.toString('utf8'));}catch{fail();}
 if(Buffer.from(canonical(m)).compare(manifestBytes)!==0||!keys(m,['version','issuer','operation','expiresAt','toolchainSha256','variants','files'])||m.version!==1||m.issuer!==expected.issuer||m.operation!==expected.operation||m.toolchainSha256!==expected.toolchainSha256||!Number.isSafeInteger(m.expiresAt)||m.expiresAt<=now)fail();
 try{const key=publicKey?.type==='public'?publicKey:crypto.createPublicKey(publicKey);if(key.asymmetricKeyType!=='ed25519'||!crypto.verify(null,manifestBytes,key,signature))fail();}catch{fail();}
 if(!Array.isArray(m.variants)||!m.variants.length||m.variants.length>10||m.variants.some(v=>!name(v))||new Set(m.variants).size!==m.variants.length||!Array.isArray(m.files)||!m.files.length||m.files.length>64)fail();
 let total=0;const ids=new Set();for(const f of m.files){if(!keys(f,['id','sha256','size','kind'])||!name(f.id)||ids.has(f.id)||!hex(f.sha256)||!Number.isSafeInteger(f.size)||f.size<1||f.size>10_000_000||!['input','toolchain'].includes(f.kind))fail();ids.add(f.id);total+=f.size;}
 if(total>50_000_000||m.files.filter(f=>f.kind==='toolchain'&&f.sha256===m.toolchainSha256).length!==1)fail();
 const source=fs.realpathSync(sourceDir);if(source!==path.resolve(sourceDir))fail();
 // Exclusive new directory; never overwrite an existing snapshot or source.
 fs.mkdirSync(snapshotDir,{mode:0o700});const snapshot=fs.realpathSync(snapshotDir);if(snapshot!==path.resolve(snapshotDir)||snapshot===source||snapshot.startsWith(source+path.sep))fail();
 for(const f of m.files){const p=path.join(source,f.id);if(fs.realpathSync(p)!==p)fail();const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let b;try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size!==f.size)fail();b=fs.readFileSync(fd);}finally{fs.closeSync(fd);}if(b.length!==f.size||hash(b)!==f.sha256)fail();fs.writeFileSync(path.join(snapshot,f.id),b,{flag:'wx',mode:0o400});}
 return {manifestSha256:hash(manifestBytes),snapshot,variants:m.variants,toolchainSha256:m.toolchainSha256};
}
export const canonicalSyntheticManifest=canonical;
