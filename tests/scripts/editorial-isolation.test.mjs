import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { editorialIsolation, verifyEditorialServer, verifyEditorialDraft, verifiedEditorialCleanupIds, resolveEditorialPreview } from '../../scripts/content/editorial-isolation.mjs';

test('preview accepts a same-origin relative URL and rejects another origin', () => {
  const origin = 'http://127.0.0.1:5191';
  assert.equal(resolveEditorialPreview('/journal/example?_preview=fixture', origin).origin, origin);
  for (const url of ['https://outside.invalid/journal/example', '//outside.invalid/path', '', 'http://user@127.0.0.1:5191/path'])
    assert.throws(() => resolveEditorialPreview(url, origin), /same-origin/);
});

test('editorial acceptance requires explicit isolated configuration', () => {
  const root = fs.mkdtempSync(path.join('/', 'foilbury-editorial-isolation-'));
  try {
    fs.mkdirSync(path.join(root, 'project'));
    fs.mkdirSync(path.join(root, 'state'));
    const db = 'foilbury-isolated-test-12345678';
    const config = { d1_databases: [{ binding: 'DB', database_name: db }], r2_buckets: [], vars: { FOILBURY_ENV: 'local', FOILBURY_PUBLIC_ORIGIN: 'http://127.0.0.1:5191', EMDASH_SITE_URL: 'http://127.0.0.1:5191' } };
    const configPath = path.join(root, 'project', 'wrangler.jsonc');
    fs.writeFileSync(configPath, JSON.stringify(config));
    const env = { FOILBURY_ISOLATION_ROOT: root, FOILBURY_ISOLATED_D1: db, FOILBURY_URL: 'http://127.0.0.1:5191' };
    assert.equal(editorialIsolation(env, { lo: [] }).db, db);
    for (const changes of [
      { FOILBURY_URL: undefined }, { FOILBURY_URL: 'http://127.0.0.1:5173' },
      { FOILBURY_URL: 'https://example.com' }, { FOILBURY_ISOLATED_D1: 'foilbury-local' },
    ]) assert.throws(() => editorialIsolation({ ...env, ...changes }, { lo: [] }));
    assert.throws(() => editorialIsolation(env, { lo: [], eth0: [] }));
    assert.throws(() => editorialIsolation({ ...env, FOILBURY_ISOLATION_ROOT: '/check' }, { lo: [] }), /overlay/);
    fs.writeFileSync(configPath, JSON.stringify({ ...config, account_id: 'remote' }));
    assert.throws(() => editorialIsolation(env, { lo: [] }));
    fs.writeFileSync(configPath, JSON.stringify({ ...config, d1_databases: [{ database_name: db, remote: true }] }));
    assert.throws(() => editorialIsolation(env, { lo: [] }));
    fs.writeFileSync(configPath, JSON.stringify(config));
    fs.rmSync(path.join(root, 'state'), { recursive: true });
    fs.symlinkSync('/tmp', path.join(root, 'state'));
    assert.throws(() => editorialIsolation(env, { lo: [] }), /inside their root/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('draft proof rejects missing, mismatched or already published records', () => {
  const id='draft-id',slug='unique-draft';
  assert.doesNotThrow(()=>verifyEditorialDraft([{results:[{id,slug,status:'draft'}]}],id,slug));
  for (const rows of [[],[{results:[]}],[{results:[{id:'other',slug,status:'draft'}]}],[{results:[{id,slug,status:'published'}]}]])
    assert.throws(()=>verifyEditorialDraft(rows,id,slug),/stopping before preview or publish/);
});

test('wrong D1 proof prevents all server cleanup calls', () => {
  let deletes=0;
  const cleanup=()=>{for (const id of verifiedEditorialCleanupIds(true,[{id:'draft-id',slug:'unique-draft'}],'unique-draft')) { assert.ok(id);deletes++; }};
  assert.throws(cleanup,/do not send cleanup mutations/);
  assert.equal(deletes,0);
  assert.deepEqual(verifiedEditorialCleanupIds(false,[{id:'draft-id',slug:'unique-draft'}],'unique-draft'),['draft-id']);
});

test('owned listener proof rejects a different process', async () => {
  const root=fs.mkdtempSync(path.join('/','foilbury-listener-proof-'));
  const project=path.join(root,'project'), astroDir=path.join(project,'node_modules','astro','bin');
  fs.mkdirSync(astroDir,{recursive:true});fs.mkdirSync(path.join(root,'state'));
  fs.writeFileSync(path.join(project,'wrangler.jsonc'),JSON.stringify({d1_databases:[{binding:'DB',database_name:'foilbury-isolated-test-12345678'}],vars:{FOILBURY_ENV:'local',FOILBURY_PUBLIC_ORIGIN:'http://127.0.0.1:5192',EMDASH_SITE_URL:'http://127.0.0.1:5192'}}));
  const astro=path.join(astroDir,'astro.mjs');
  fs.writeFileSync(astro,"import net from 'node:net';net.createServer().listen(5192,'127.0.0.1');");
  const isolated=editorialIsolation({FOILBURY_ISOLATION_ROOT:root,FOILBURY_ISOLATED_D1:'foilbury-isolated-test-12345678',FOILBURY_URL:'http://127.0.0.1:5192'},{lo:[]});
  const child=spawn(process.execPath,[astro,'dev','--host','127.0.0.1','--port','5192'],{cwd:project,stdio:'ignore'});
  try {
    let valid=false;
    for(let i=0;i<100;i++){try{verifyEditorialServer(isolated,child.pid);valid=true;break;}catch{await new Promise(resolve=>setTimeout(resolve,20));}}
    assert.equal(valid,true);
    assert.throws(()=>verifyEditorialServer(isolated,process.pid));
    fs.unlinkSync(astro);
    fs.symlinkSync('/app/node_modules/astro/bin/astro.mjs',astro);
    assert.throws(()=>verifyEditorialServer(isolated,child.pid),/inside the root/);
  } finally {child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));fs.rmSync(root,{recursive:true,force:true});}
});
