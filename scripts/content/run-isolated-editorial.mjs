#!/usr/bin/env node
// Launch only an overlay-owned, network-none fixture; never target an existing
// listener. The runner independently verifies the process and exact D1 draft.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { editorialIsolation, verifyEditorialServer } from './editorial-isolation.mjs';

const isolated=editorialIsolation(process.env);
const project=path.join(isolated.root,'project');
const astroConfig=fs.readFileSync(path.join(project,'astro.config.mjs'),'utf8');
if (!astroConfig.includes('configPath: "./wrangler.jsonc"') || !astroConfig.includes(`persistState: { path: ${JSON.stringify(isolated.persist)} }`) || !astroConfig.includes('remoteBindings: false'))
  throw new Error('The isolated Astro configuration does not bind the reviewed local config and state.');
const astro=fs.realpathSync(path.join(project,'node_modules','astro','bin','astro.mjs'));
if (fs.realpathSync(project) !== project || !astro.startsWith(`${project}${path.sep}`)) throw new Error('Astro must be inside the isolated project.');
const port=new URL(isolated.origin).port;
const childEnv={PATH:process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',HOME:isolated.root,TMPDIR:'/tmp',NODE_ENV:'development',FOILBURY_ENV:'local',CI:'1',NO_COLOR:'1'};
const server=spawn(process.execPath,[astro,'dev','--host','127.0.0.1','--port',port],{cwd:project,env:childEnv,stdio:'inherit'});
try {
  let ready=false;
  for (let attempt=0;attempt<200;attempt++) {
    if (server.exitCode !== null || server.signalCode !== null) throw new Error('The isolated server exited before binding.');
    try { verifyEditorialServer(isolated,server.pid); ready=true; break; } catch { await new Promise((resolve)=>setTimeout(resolve,100)); }
  }
  if (!ready) throw new Error('Could not establish the owned listener and process binding.');
  const runner=spawn(process.execPath,[path.join(project,'scripts','test-emdash-editorial.mjs')],{
    cwd:project,stdio:'inherit',env:{...childEnv,FOILBURY_ISOLATION_ROOT:isolated.root,FOILBURY_ISOLATED_D1:isolated.db,FOILBURY_URL:isolated.origin,FOILBURY_ISOLATED_SERVER_PID:String(server.pid)},
  });
  const exitCode=await new Promise((resolve,reject)=>{runner.once('error',reject);runner.once('exit',(code,signal)=>resolve(signal ? 1 : code ?? 1));});
  process.exitCode=exitCode;
} finally {
  if (server.exitCode===null && server.signalCode===null) {
    server.kill('SIGTERM');
    await Promise.race([new Promise((resolve)=>server.once('exit',resolve)),new Promise((resolve)=>setTimeout(resolve,5000))]);
    if (server.exitCode===null && server.signalCode===null) server.kill('SIGKILL');
  }
}
