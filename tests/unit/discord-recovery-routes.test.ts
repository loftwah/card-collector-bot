import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';

const st=vi.hoisted(()=>({
 raw:{FOILBURY_ENV:'test',FOILBURY_DISCORD_RECOVERY_ENABLED:'1',DISCORD_CLIENT_ID:'client',DISCORD_CLIENT_SECRET:'synthetic',FOILBURY_PUBLIC_ORIGIN:'https://foilbury.example'},
 ctx:{config:{publicOrigin:'https://foilbury.example',environment:'test'},tenant:{id:'tenant'},user:{id:'user'},sessionId:'session',csrfToken:'secret'},
 begin:vi.fn(),start:vi.fn(),session:vi.fn(),player:vi.fn(),link:vi.fn(),
}));
vi.mock('../../src/server/context',()=>({runtimeEnv:()=>st.raw,buildContext:async()=>st.ctx,ApiError:class extends Error{}}));
vi.mock('../../src/server/modules/identity',()=>({createSession:st.session}));
vi.mock('../../src/server/discord/context',()=>({ensureDiscordPlayer:st.player,linkDiscordIdentity:st.link}));
vi.mock('../../src/server/discord/recovery',()=>({
 discordRecoveryEnabled:(env:{FOILBURY_DISCORD_RECOVERY_ENABLED?:string})=>env.FOILBURY_DISCORD_RECOVERY_ENABLED==='1',
 beginVerifiedDiscordRecovery:st.begin,startDiscordRecoveryIntent:st.start,
}));
import { POST as start } from '../../src/pages/auth/discord/recovery/start';
import { GET as callback } from '../../src/pages/auth/discord/callback';

function cookies(values:Record<string,string>={}){
 const jar=new Map(Object.entries(values));
 return {get:(name:string)=>jar.has(name)?{value:jar.get(name)}:undefined,set:(name:string,value:string)=>jar.set(name,value),delete:(name:string)=>jar.delete(name),jar};
}
beforeEach(()=>{vi.clearAllMocks();st.raw.FOILBURY_DISCORD_RECOVERY_ENABLED='1';st.begin.mockResolvedValue('challenge');st.start.mockResolvedValue('intent-state');});
afterEach(()=>vi.unstubAllGlobals());

describe('Discord recovery route boundaries',()=>{
 it('requires CSRF before initiating OAuth and issues session-bound state with PKCE',async()=>{
  const jar=cookies();
  const request=new Request('https://foilbury.example/auth/discord/recovery/start',{method:'POST',headers:{origin:'https://foilbury.example','content-type':'application/x-www-form-urlencoded'},body:'csrf=secret'});
  const response=await start({request,cookies:jar} as never);
  const target=new URL(response.headers.get('location')!);
  expect(response.status).toBe(303);expect(target.origin).toBe('https://discord.com');
  expect(target.searchParams.get('state')).toBe('intent-state');expect(target.searchParams.get('code_challenge_method')).toBe('S256');
  expect(jar.jar.get('fb_oauth_recovery')).toBe('1');expect(st.start).toHaveBeenCalledOnce();
 });
 it('does not initiate recovery on a cross-origin form',async()=>{
  const request=new Request('https://foilbury.example/auth/discord/recovery/start',{method:'POST',headers:{origin:'https://attacker.example','content-type':'application/x-www-form-urlencoded'},body:'csrf=secret'});
  const response=await start({request,cookies:cookies()} as never);
  expect(response.headers.get('location')).toContain('error=unavailable');expect(st.start).not.toHaveBeenCalled();
 });
 it('passes only a verified token-exchange profile and the matching OAuth state to confirmation',async()=>{
  const fetch=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({access_token:'test-token'}),{status:200})).mockResolvedValueOnce(new Response(JSON.stringify({id:'333333333333333333',username:'Fixture'}),{status:200}));
  vi.stubGlobal('fetch',fetch);
  const jar=cookies({fb_oauth_state:'state',fb_oauth_verifier:'verifier',fb_oauth_recovery:'1'});
  const request=new Request('https://foilbury.example/auth/discord/callback?code=code&state=state');
  const response=await callback({request,cookies:jar} as never);
  expect(response.status).toBe(302);expect(response.headers.get('location')).toBe('/auth/discord/recovery/confirm?challenge=challenge');
  expect(st.begin).toHaveBeenCalledWith(st.ctx,'state',{id:'333333333333333333',username:'Fixture'});expect(st.session).not.toHaveBeenCalled();
 });
 it('does not silently link an ordinary signed-in OAuth callback',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({access_token:'test-token'}),{status:200})).mockResolvedValueOnce(new Response(JSON.stringify({id:'333333333333333333',username:'Fixture'}),{status:200})));
  const response=await callback({request:new Request('https://foilbury.example/auth/discord/callback?code=code&state=state'),cookies:cookies({fb_oauth_state:'state',fb_oauth_verifier:'verifier'})} as never);
  expect(response.headers.get('location')).toBe('/auth/discord/recovery?error=explicit');expect(st.begin).not.toHaveBeenCalled();expect(st.session).not.toHaveBeenCalled();
 });
 it('fails before token exchange for mismatched state',async()=>{
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  const response=await callback({request:new Request('https://foilbury.example/auth/discord/callback?code=code&state=wrong'),cookies:cookies({fb_oauth_state:'state',fb_oauth_verifier:'verifier',fb_oauth_recovery:'1'})} as never);
  expect(response.headers.get('location')).toContain('discord_state');expect(fetch).not.toHaveBeenCalled();
 });
 it('does not create a recovery challenge if the provider token exchange fails',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(new Response('denied',{status:401})));
  const response=await callback({request:new Request('https://foilbury.example/auth/discord/callback?code=bad&state=state'),cookies:cookies({fb_oauth_state:'state',fb_oauth_verifier:'verifier',fb_oauth_recovery:'1'})} as never);
  expect(response.headers.get('location')).toContain('discord_exchange');expect(st.begin).not.toHaveBeenCalled();
 });
 it('does not continue recovery after it has been switched off',async()=>{
  st.raw.FOILBURY_DISCORD_RECOVERY_ENABLED='0';
  vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({access_token:'test-token'}),{status:200})).mockResolvedValueOnce(new Response(JSON.stringify({id:'333333333333333333',username:'Fixture'}),{status:200})));
  const response=await callback({request:new Request('https://foilbury.example/auth/discord/callback?code=code&state=state'),cookies:cookies({fb_oauth_state:'state',fb_oauth_verifier:'verifier',fb_oauth_recovery:'1'})} as never);
  expect(response.headers.get('location')).toContain('discord_link');expect(st.begin).not.toHaveBeenCalled();
 });
 it('preserves the existing signed-in OAuth link journey while recovery is off',async()=>{
  st.raw.FOILBURY_DISCORD_RECOVERY_ENABLED='0';st.link.mockResolvedValue({});
  st.session.mockResolvedValue({token:'synthetic',csrf:'synthetic',expiresAt:'2099-01-01T00:00:00.000Z'});
  vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({access_token:'test-token'}),{status:200})).mockResolvedValueOnce(new Response(JSON.stringify({id:'333333333333333333',username:'Fixture'}),{status:200})));
  const response=await callback({request:new Request('https://foilbury.example/auth/discord/callback?code=code&state=state'),cookies:cookies({fb_oauth_state:'state',fb_oauth_verifier:'verifier'})} as never);
  expect(st.link).toHaveBeenCalledOnce();expect(st.session).toHaveBeenCalledOnce();expect(response.headers.get('location')).toBe('/play');
 });
});
