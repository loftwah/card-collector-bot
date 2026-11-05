import fs from 'node:fs';

export function processInfo(pid) {
  try {
    const stat=fs.readFileSync(`/proc/${pid}/stat`,'utf8');
    const fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');
    return {pid:Number(pid),state:fields[0],ppid:Number(fields[1]),group:Number(fields[2]),args:fs.readFileSync(`/proc/${pid}/cmdline`,'utf8').split('\0').filter(Boolean),cwd:fs.readlinkSync(`/proc/${pid}/cwd`)};
  } catch {return null;}
}
export function processes() {
  return fs.readdirSync('/proc').filter(x=>/^\d+$/.test(x)).map(processInfo).filter(Boolean);
}
export function portOwners(port) {
  const inodes=new Set();
  for(const file of ['/proc/net/tcp','/proc/net/tcp6']) {
    if(!fs.existsSync(file)) continue;
    for(const line of fs.readFileSync(file,'utf8').split('\n').slice(1)) {
      const fields=line.trim().split(/\s+/);
      if(fields[1]?.endsWith(`:${port.toString(16).toUpperCase().padStart(4,'0')}`) && fields[3]==='0A') inodes.add(fields[9]);
    }
  }
  const owners=[];
  for(const p of processes()) {
    try { if(fs.readdirSync(`/proc/${p.pid}/fd`).some(fd=>{try {const link=fs.readlinkSync(`/proc/${p.pid}/fd/${fd}`);return [...inodes].some(inode=>link===`socket:[${inode}]`);} catch{return false;}})) owners.push(p); } catch {}
  }
  if(inodes.size && owners.length===0) throw new Error('Listener ownership cannot be proven.');
  return owners;
}
export function assertBuiltListener() {
  const owners=portOwners(5173);
  if(owners.length!==1 || !owners[0].args[0]?.includes('workerd')) throw new Error('Built-worker listener ownership is ambiguous.');
  let current=owners[0], found=false;
  for(let i=0;i<12 && current;i++) {
    const args=current.args.join(' ');
    if(current.args.some(arg=>arg.includes('wrangler')) && current.args.includes('dev') && args.includes('--no-bundle') && args.includes('--persist-to /sandbox/project/.wrangler/state') && args.includes('--config dist/server/wrangler.json')) found=true;
    current=processInfo(current.ppid);
  }
  if(!found) throw new Error('Listener is not a child of the expected built-worker command.');
}
