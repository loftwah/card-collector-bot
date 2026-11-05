import { describe, expect, it, vi } from 'vitest';
import { withDiscordQuarantine } from '../../src/server/discord/quarantine';

describe('dedicated Discord rollback quarantine',()=>{
 it.each(['/api/discord/interactions','/api/discord/interactions/','/auth/discord/start','/auth/discord/start/','/auth/discord/callback','/auth/discord/callback/','/auth/%64iscord/%63allback','/api//discord/interactions','/api%252fdiscord/interactions'])('stops %s before the application delegate',async(path)=>{
  const fetch=vi.fn(async()=>new Response('called'));
  const handler=withDiscordQuarantine({fetch});
  for(const method of ['GET','POST']){
   const response=await handler.fetch!(new Request(`https://example.test${path}`,{method}),{},{} as ExecutionContext);
   expect(response.status).toBe(503);expect(response.headers.get('cache-control')).toBe('no-store');
  }
  expect(fetch).not.toHaveBeenCalled();
 });
 it('passes unrelated routes and scheduled work through',async()=>{
  const fetch=vi.fn(async()=>new Response('cabinet'));
  const scheduled=vi.fn();
  const handler=withDiscordQuarantine({fetch,scheduled});
  expect(await (await handler.fetch!(new Request('https://example.test/play'),{},{} as ExecutionContext)).text()).toBe('cabinet');
  expect(fetch).toHaveBeenCalledOnce();expect(handler.scheduled).toBe(scheduled);
 });
});
