import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function editorialIsolation(env, interfaces = os.networkInterfaces()) {
  if (process.platform !== 'linux' || !fs.existsSync('/.dockerenv') || Object.keys(interfaces).some((name) => name !== 'lo'))
    throw new Error('Editorial acceptance requires a network-none Linux container.');
  const root = fs.realpathSync(env.FOILBURY_ISOLATION_ROOT || '');
  // Disposable data must live in the container's writable overlay, not in a
  // host bind mount or separate mounted volume. Also reject nested mounts.
  const mounts = fs.readFileSync('/proc/self/mountinfo', 'utf8').trim().split('\n')
    .map((line) => line.split(' ')[4]?.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8))))
    .filter(Boolean);
  if (root === '/' || mounts.some((mount) => mount !== '/' && (root === mount || root.startsWith(`${mount}/`) || mount.startsWith(`${root}/`))))
    throw new Error('Isolated root must be wholly inside the disposable container overlay.');
  const db = env.FOILBURY_ISOLATED_D1 || '';
  if (!/^foilbury-isolated-[a-z0-9-]{8,64}$/.test(db)) throw new Error('An explicitly named isolated D1 is required.');
  const origin = new URL(env.FOILBURY_URL || '');
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port || origin.port === '5173' || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password)
    throw new Error('An explicit isolated loopback origin is required.');
  const configPath = fs.realpathSync(path.join(root, 'project', 'wrangler.jsonc'));
  const persist = fs.realpathSync(path.join(root, 'state'));
  for (const candidate of [configPath, persist]) {
    if (!candidate.startsWith(`${root}${path.sep}`)) throw new Error('Isolated paths must remain inside their root.');
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (config.account_id || config.env || config.triggers?.crons?.length || config.d1_databases?.length !== 1 || config.d1_databases[0].binding !== 'DB' || config.d1_databases[0].database_name !== db || config.d1_databases[0].remote || config.r2_buckets?.some((item) => item.remote) || config.vars?.FOILBURY_ENV !== 'local' || config.vars?.FOILBURY_PUBLIC_ORIGIN !== origin.origin || config.vars?.EMDASH_SITE_URL !== origin.origin)
    throw new Error('Wrangler configuration does not match the isolated D1 contract.');
  const evidenceParent = path.join(root, 'evidence');
  if (fs.existsSync(evidenceParent) && fs.realpathSync(evidenceParent) !== evidenceParent) throw new Error('Evidence parent cannot be a link.');
  fs.mkdirSync(evidenceParent, { mode: 0o700, recursive: true });
  const evidence = path.join(evidenceParent, 'emdash-editorial');
  if (fs.existsSync(evidence) && fs.realpathSync(evidence) !== evidence) throw new Error('Evidence cannot be a link.');
  fs.mkdirSync(evidence, { mode: 0o700, recursive: true });
  if (!fs.realpathSync(evidence).startsWith(`${root}${path.sep}`)) throw new Error('Evidence path must remain inside the isolated root.');
  return { origin: origin.origin, root, db, configPath, persist, evidence };
}

/** Verify the exact owned Astro process is the only listener at the test port. */
export function verifyEditorialServer(isolated, pidValue) {
  if (!/^[1-9][0-9]*$/.test(String(pidValue ?? ''))) throw new Error('An owned server PID is required.');
  const pid=Number(pidValue), port=Number(new URL(isolated.origin).port);
  const args=fs.readFileSync(`/proc/${pid}/cmdline`).toString().split('\0').filter(Boolean);
  const project=fs.realpathSync(path.join(isolated.root,'project'));
  const astro=fs.realpathSync(path.join(project,'node_modules','astro','bin','astro.mjs'));
  if (project !== path.join(isolated.root,'project') || !astro.startsWith(`${project}${path.sep}`))
    throw new Error('The isolated project and Astro executable must stay inside the root.');
  if (args.length !== 7 || fs.realpathSync(args[0]) !== fs.realpathSync(process.execPath) || fs.realpathSync(args[1]) !== astro ||
      args[2] !== 'dev' || args[3] !== '--host' || args[4] !== '127.0.0.1' || args[5] !== '--port' || args[6] !== String(port) ||
      fs.realpathSync(`/proc/${pid}/cwd`) !== path.join(isolated.root,'project'))
    throw new Error('The server process does not match the owned isolated launch.');
  const portHex=port.toString(16).toUpperCase().padStart(4,'0');
  const listeners=['/proc/net/tcp','/proc/net/tcp6'].flatMap((file)=>fs.readFileSync(file,'utf8').trim().split('\n').slice(1).map((line)=>line.trim().split(/\s+/)))
    .filter((parts)=>parts[1]?.endsWith(`:${portHex}`) && parts[3] === '0A');
  const fds=fs.readdirSync(`/proc/${pid}/fd`).flatMap((fd)=>{try{return [fs.readlinkSync(`/proc/${pid}/fd/${fd}`)];}catch{return [];}});
  if (listeners.length !== 1 || listeners[0][1] !== `0100007F:${portHex}` || !fds.includes(`socket:[${listeners[0][9]}]`)) throw new Error('The test port is not owned by the verified server.');
}

export function verifyEditorialDraft(d1Result, id, slug) {
  const rows=Array.isArray(d1Result) ? d1Result.flatMap((result)=>result.results ?? []) : [];
  if (rows.length !== 1 || rows[0].id !== id || rows[0].slug !== slug || rows[0].status !== 'draft')
    throw new Error('Draft is not present in the exact isolated D1; stopping before preview or publish.');
}

export function resolveEditorialPreview(value, origin) {
  if (typeof value !== 'string' || !value) throw new Error('A same-origin signed draft preview was not returned.');
  let url;
  try { url = new URL(value, origin); } catch { throw new Error('A same-origin signed draft preview was not returned.'); }
  if (url.origin !== origin || url.username || url.password) throw new Error('A same-origin signed draft preview was not returned.');
  return url;
}

export function verifiedEditorialCleanupIds(bindingFailed, rows, slug) {
  if (bindingFailed) throw new Error('The server-to-D1 binding was not established; do not send cleanup mutations.');
  if (!Array.isArray(rows) || rows.length>2 || new Set(rows.map((row)=>row.slug)).size !== rows.length || rows.some((row)=>![slug,`${slug}-scheduled`].includes(row.slug) || !/^[a-zA-Z0-9_-]+$/.test(row.id)))
    throw new Error('Unexpected isolated cleanup records.');
  return rows.map((row)=>row.id);
}
