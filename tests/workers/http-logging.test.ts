import { describe, expect, it, vi } from 'vitest';
import { apiErrorResponse } from '../../src/server/http';
import { ApiError } from '../../src/server/context';
import { buildContext } from '../../src/server/context';
import { requestReference } from '../../src/server/ids';
import { ALL as routeEntry } from '../../src/pages/api/v1/[...path]';
import { bootstrap } from './helpers';

describe('API error diagnostics', () => {
  it('retains a bounded request reference without exposing exception or header data', async () => {
    const log=vi.spyOn(console,'error').mockImplementation(()=>{});
    try {
      const response=apiErrorResponse(new Error('cookie=fixture-secret https://private.invalid/signed?token=fixture-secret'),'untrusted fixture-secret');
      const body=await response.text();
      expect(response.status).toBe(500);
      expect(body).not.toContain('fixture-secret');
      expect(JSON.stringify(log.mock.calls)).not.toContain('fixture-secret');
      const event=JSON.parse(String(log.mock.calls[0]?.[0]));
      expect(event).toMatchObject({level:'error',event_code:'api.unexpected_failure',error:'operation_failed'});
      expect(event.request_id).toMatch(/^req_[A-Za-z0-9_-]+$/);
    } finally { log.mockRestore(); }
  });

  it('keeps valid correlation and 429 Retry-After without logging expected errors', async () => {
    const log=vi.spyOn(console,'error').mockImplementation(()=>{});
    try {
      const response=apiErrorResponse(new ApiError(429,'rate_limited','Try again.',{retryAfterSeconds:45}),'0123456789abcdef-MEL');
      expect(response.status).toBe(429);expect(response.headers.get('retry-after')).toBe('45');
      expect(await response.json()).toMatchObject({request_id:'0123456789abcdef-MEL'});
      expect(log).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });

  it.each([null,'cookie=fixture-secret','x'.repeat(300)])('uses one safe reference throughout a request with hostile or absent Ray header', async (ray) => {
    await bootstrap();
    const request=new Request('http://localhost:5173/api/v1/nonexistent-route',{headers:ray?{'cf-ray':ray}:{}});
    const reference=requestReference(request);
    expect(reference).toMatch(/^req_[0-9a-z]{24}$/);
    expect(requestReference(request)).toBe(reference);
    expect((await buildContext(request)).requestId).toBe(reference);
    const response=await routeEntry({request,params:{path:'nonexistent-route'}} as never);
    expect((await response.json() as {request_id:string}).request_id).toBe(reference);
    const log=vi.spyOn(console,'error').mockImplementation(()=>{});
    try {
      const failed=apiErrorResponse(new Error('cookie=fixture-secret'),reference);
      expect((await failed.json() as {request_id:string}).request_id).toBe(reference);
      expect(JSON.parse(String(log.mock.calls[0]?.[0])).request_id).toBe(reference);
      expect(JSON.stringify(log.mock.calls)).not.toContain('fixture-secret');
    } finally { log.mockRestore(); }
  });
});
