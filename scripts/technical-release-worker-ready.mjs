#!/usr/bin/env node
// The supervisor creates a fresh no-network/no-mount container before this runs.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { assertBuiltListener, processes } from './technical-release-process.mjs';
if(processes().some(p=>p.args.some(arg=>arg.endsWith('/astro.mjs')) && p.args.includes('dev'))) throw new Error('Competing Astro dev server is still running.');
let status;
for(let i=0;i<60;i++) {
  try { const response=await fetch('http://127.0.0.1:5173/api/v1/status',{redirect:'error',signal:AbortSignal.timeout(1000)}); if(response.ok){status=await response.json();break;} } catch {}
  await delay(500);
}
assertBuiltListener();
if(!status || status.local!==true || status.dev_login!==true || status.tenant!=='cabinet' || Object.values(status.providers ?? {}).some(Boolean)) throw new Error('Built Worker is not the expected local synthetic instance.');
const base=path.resolve('.wrangler/state/v3/d1');
const matches=[];
for(const entry of fs.readdirSync(base,{recursive:true})) {
  const file=path.join(base,String(entry)); if(!file.endsWith('.sqlite')||file.endsWith('metadata.sqlite')) continue;
  const stat=fs.lstatSync(file); if(!stat.isFile()||stat.isSymbolicLink()) throw new Error('Unexpected D1 path.');
  try { if(execFileSync('sqlite3',[file,"SELECT name FROM sqlite_master WHERE type='table' AND name='fb_totp_secrets';"],{encoding:'utf8'}).trim()) matches.push(file); } catch { throw new Error('Unreadable D1 file.'); }
}
if(matches.length!==1) throw new Error('Expected exactly one synthetic Foilbury D1 database.');
execFileSync(process.execPath,['scripts/technical-release-inspect.mjs'],{stdio:'inherit'});
