import { describe,expect,it } from 'vitest';
import { readRecoveryForm } from '../../src/server/discord/recovery-form';
import type { Ctx } from '../../src/server/context';

const ctx={config:{publicOrigin:'https://foilbury.example'},user:{id:'user'},sessionId:'session',csrfToken:'secret'} as Ctx;
function form(body:string,origin='https://foilbury.example'){
 return new Request('https://foilbury.example/auth/discord/recovery/start',{method:'POST',headers:{origin,'content-type':'application/x-www-form-urlencoded'},body});
}
describe('Discord recovery form boundary',()=>{
 it('accepts the same-origin session token',async()=>expect((await readRecoveryForm(ctx,form('csrf=secret'))).get('csrf')).toBe('secret'));
 it.each([['csrf=secret','https://attacker.example'],['csrf=wrong','https://foilbury.example'],['csrf=secret&csrf=secret','https://foilbury.example'],[`csrf=secret&pad=${'x'.repeat(4096)}`,'https://foilbury.example']])('rejects an invalid form',async(body,origin)=>{
  await expect(readRecoveryForm(ctx,form(body,origin))).rejects.toThrow();
 });
 it('rejects a form without an authenticated session',async()=>{
  await expect(readRecoveryForm({...ctx,sessionId:null},form('csrf=secret'))).rejects.toThrow();
 });
});
