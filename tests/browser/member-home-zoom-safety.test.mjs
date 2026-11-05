import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';

function run(url) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['tests/browser/member-home-zoom.test.mjs'], { env: { ...process.env, FOILBURY_URL: url }, stdio: 'ignore' });
    child.on('error', reject); child.on('exit', code => resolve(code));
  });
}
test('rejects non-loopback, non-HTTP, and non-origin targets before contacting them', async () => {
  for (const url of ['https://127.0.0.1:5173', 'http://example.com', 'http://127.0.0.1:5173/path', 'http://user@localhost:5173']) {
    assert.notEqual(await run(url), 0, url);
  }
});
test('rejects unsafe status and redirects before login', async () => {
  let loginCount = 0;
  let status = { name:'Foilbury', environment:'local', local:true, dev_login:true, configured:true, email:'outbox_only', discord:'disabled', access:'not_configured', providers:{ fal:false, elevenlabs:false, resend:false, adminWebhook:false, discordApplication:false, discordBot:false, discordOAuth:false, cloudflareAccess:false } };
  const server = http.createServer((req, res) => {
    if (req.url === '/api/v1/status') { if (status === 'redirect') { res.writeHead(302, { location: 'http://example.com/' }); res.end(); } else { res.writeHead(200, { 'content-type':'application/json' }); res.end(JSON.stringify(status)); } }
    else { loginCount++; res.writeHead(500); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    for (const invalid of [ { ...status, environment:'production' }, { ...status, local:false }, { ...status, providers:{ ...status.providers, resend:true } }, { ...status, providers:{} }, 'redirect' ]) {
      const old = status; status = invalid;
      assert.notEqual(await run(url), 0);
      status = old;
    }
    assert.equal(loginCount, 0, 'preflight failures must never reach login');
  } finally { await new Promise(resolve => server.close(resolve)); }
});
