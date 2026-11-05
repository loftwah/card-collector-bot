import type { APIRoute } from 'astro';
import { buildContext, runtimeEnv } from '../../../../server/context';
import { readRecoveryForm } from '../../../../server/discord/recovery-form';
import { discordRecoveryEnabled,startDiscordRecoveryIntent } from '../../../../server/discord/recovery';
import { base64url } from '../../../../server/ids';

export const prerender=false;
export const POST:APIRoute=async({request,cookies})=>{
 try{
  const ctx=await buildContext(request);await readRecoveryForm(ctx,request);
  const raw=runtimeEnv(),clientId=raw.DISCORD_CLIENT_ID?.trim()||raw.DISCORD_APPLICATION_ID?.trim();
  if(!discordRecoveryEnabled(raw))throw new Error('recovery unavailable');
  if(!clientId||!raw.DISCORD_CLIENT_SECRET?.trim())throw new Error('discord unavailable');
  const state=await startDiscordRecoveryIntent(ctx),verifier=base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest=base64url(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))));
  const options={path:'/auth/discord',httpOnly:true,sameSite:'lax' as const,secure:ctx.config.environment==='production',maxAge:300};
  cookies.set('fb_oauth_state',state,options);cookies.set('fb_oauth_verifier',verifier,options);cookies.set('fb_oauth_recovery','1',options);
  const authorize=new URL('https://discord.com/oauth2/authorize');
  authorize.search=new URLSearchParams({client_id:clientId,response_type:'code',redirect_uri:raw.DISCORD_REDIRECT_URI?.trim()||`${ctx.config.publicOrigin}/auth/discord/callback`,scope:'identify',state,code_challenge:digest,code_challenge_method:'S256'}).toString();
  return new Response(null,{status:303,headers:{location:authorize.toString(),'cache-control':'no-store'}});
 }catch{return new Response(null,{status:303,headers:{location:'/auth/discord/recovery?error=unavailable','cache-control':'no-store'}});}
};
