import { processes, portOwners } from './technical-release-process.mjs';
import { setTimeout as delay } from 'node:timers/promises';
const matches=processes().filter(p=>p.cwd==='/sandbox/project' && p.args.some(arg=>arg.endsWith('/astro.mjs')) && p.args.includes('dev') && p.args.includes('5173'));
if(matches.length!==1 || matches[0].group!==matches[0].pid) throw new Error('Cannot identify the owned detached Astro process group.');
process.kill(-matches[0].group,'SIGTERM');
for(let i=0;i<40;i++) { if(portOwners(5173).length===0) process.exit(0); await delay(250); }
throw new Error('Astro did not release its listener.');
