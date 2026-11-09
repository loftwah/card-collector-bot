import { describe, expect, it, vi } from 'vitest';
import { bootstrap, ctxFor, runtime } from './helpers';
import { requestMagicLink } from '../../src/server/modules/magic-links';
import { rateLimitEmailKey } from '../../src/server/context';
import { sha256Hex } from '../../src/server/ids';
import { apiErrorResponse } from '../../src/server/http';

vi.mock('../../src/server/email', async (load) => ({ ...(await load<typeof import('../../src/server/email')>()), sendEmail: vi.fn(async () => ({ ok: false })) }));

describe('magic-link bucket allocation', () => {
  it('does not create address buckets or consume service allowance for an already-blocked client', async () => {
    await bootstrap();
    const ctx=await ctxFor('cabinet','owner@foilbury.local');
    const start=Math.floor(Date.now()/1000/900)*900;
    await runtime.DB.prepare('INSERT INTO fb_rate_limits(key,window_start,count) VALUES (?,?,20)').bind(`magic:client:${ctx.clientKey}`,start).run();
    const fetch=vi.spyOn(globalThis,'fetch');
    try {
      for(let i=0;i<5;i++) await expect(requestMagicLink(ctx,{email:`different-${i}@example.test`,purpose:'signin'})).rejects.toMatchObject({code:'rate_limited',status:429});
      const rows=await runtime.DB.prepare('SELECT key,count FROM fb_rate_limits ORDER BY key').all<{key:string;count:number}>();
      expect(rows.results).toEqual([{key:`magic:client:${ctx.clientKey}`,count:25}]);
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });

  it('does not allocate new client or email buckets after the service ceiling is reached', async () => {
    await bootstrap();
    const ctx=await ctxFor('cabinet','owner@foilbury.local');
    const start=Math.floor(Date.now()/1000/900)*900;
    await runtime.DB.prepare("INSERT INTO fb_rate_limits(key,window_start,count) VALUES ('magic:service',?,120)").bind(start).run();
    const fetch=vi.spyOn(globalThis,'fetch');
    try {
      for(let i=0;i<5;i++) await expect(requestMagicLink({...ctx,clientKey:`client-${i}`},{email:`different-${i}@example.test`,purpose:'signin'})).rejects.toMatchObject({code:'rate_limited',status:429});
      const rows=await runtime.DB.prepare('SELECT key,count FROM fb_rate_limits').all<{key:string;count:number}>();
      expect(rows.results).toEqual([{key:'magic:service',count:120}]);
      expect(fetch).not.toHaveBeenCalled();
      try { await requestMagicLink(ctx,{email:'private@example.test',purpose:'signin'});throw new Error('expected rate limit'); }
      catch (error) {
        const response=apiErrorResponse(error,'test-request');
        expect(response.status).toBe(429);
        expect(Number(response.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
        expect(Number(response.headers.get('retry-after'))).toBeLessThanOrEqual(900);
        expect(await response.text()).not.toContain('private@example.test');
      }
    } finally { fetch.mockRestore(); }
  });

  it('bounds concurrent requests from one client while another client remains independent', async () => {
    await bootstrap();
    const ctx=await ctxFor('cabinet','owner@foilbury.local');
    const outcomes=await Promise.allSettled(Array.from({length:25},(_,i)=>requestMagicLink(ctx,{email:`parallel-${i}@example.test`,purpose:'signin'})));
    expect(outcomes.filter(result=>result.status==='fulfilled')).toHaveLength(20);
    expect(outcomes.filter(result=>result.status==='rejected' && result.reason?.code==='rate_limited')).toHaveLength(5);
    const rows=await runtime.DB.prepare('SELECT key,count FROM fb_rate_limits').all<{key:string;count:number}>();
    expect(rows.results.filter(row=>row.key.startsWith('magic:email:'))).toHaveLength(20);
    expect(rows.results.find(row=>row.key==='magic:service')?.count).toBe(20);
    expect(rows.results.every(row=>!row.key.includes('@'))).toBe(true);
    expect((await requestMagicLink({...ctx,clientKey:'another-client'},{email:'another@example.test',purpose:'signin'})).ok).toBe(true);
  });

  it('atomically admits only remaining service slots across distinct concurrent clients', async () => {
    await bootstrap();const ctx=await ctxFor('cabinet','owner@foilbury.local');
    const start=Math.floor(Date.now()/1000/900)*900;
    await runtime.DB.prepare("INSERT INTO fb_rate_limits(key,window_start,count) VALUES ('magic:service',?,118)").bind(start).run();
    const outcomes=await Promise.allSettled(Array.from({length:5},(_,i)=>requestMagicLink({...ctx,clientKey:`concurrent-${i}`},{email:`service-${i}@example.test`,purpose:'signin'})));
    expect(outcomes.filter(item=>item.status==='fulfilled')).toHaveLength(2);
    expect(outcomes.filter(item=>item.status==='rejected' && item.reason?.code==='rate_limited')).toHaveLength(3);
    const rows=await runtime.DB.prepare('SELECT key,count FROM fb_rate_limits').all<{key:string;count:number}>();
    expect(rows.results.filter(row=>row.key.startsWith('magic:client:'))).toHaveLength(2);
    expect(rows.results.filter(row=>row.key.startsWith('magic:email:'))).toHaveLength(2);
    expect(rows.results.find(row=>row.key==='magic:service')?.count).toBe(120);
  });

  it('retains the normalized email limit across a legacy bucket and stale new bucket', async () => {
    await bootstrap();const ctx=await ctxFor('cabinet','owner@foilbury.local');
    const start=Math.floor(Date.now()/1000/900)*900,email='case@example.test';
    const key=await rateLimitEmailKey(ctx.config,'magic:email',email),legacy=`magic:email:${await sha256Hex(email)}`;
    await runtime.DB.batch([
      runtime.DB.prepare('INSERT INTO fb_rate_limits(key,window_start,count) VALUES (?,?,4)').bind(legacy,start),
      runtime.DB.prepare('INSERT INTO fb_rate_limits(key,window_start,count) VALUES (?,?,1)').bind(key,start-900),
    ]);
    expect((await requestMagicLink(ctx,{email:'  CASE@example.test ',purpose:'signin'})).ok).toBe(true);
    await expect(requestMagicLink({...ctx,clientKey:'other-client'},{email,purpose:'signin'})).rejects.toMatchObject({code:'rate_limited',status:429});
    expect((await runtime.DB.prepare('SELECT count FROM fb_rate_limits WHERE key=?').bind(key).first<{count:number}>())?.count).toBe(6);
  });
});
