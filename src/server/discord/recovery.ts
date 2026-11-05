import { ApiError, requireRecentStrongAuth, type Ctx } from '../context';
import { newId,sha256Hex,token } from '../ids';
import { auditStatement } from '../http';
import type { DiscordUser } from './types';

export function discordRecoveryEnabled(env:unknown):boolean {
  return (env as {FOILBURY_DISCORD_RECOVERY_ENABLED?:string}|null)?.FOILBURY_DISCORD_RECOVERY_ENABLED==='1';
}

// Internal prototype only. Callers must prove Discord OAuth and explicit
// linking intent; no public route currently invokes this function.
function principal(ctx:Ctx):{session:string;user:string} {
  requireRecentStrongAuth(ctx);
  if(!ctx.user || !ctx.sessionId || !['passkey','mfa'].includes(ctx.sessionAssurance??''))
    throw new ApiError(403,'recovery_auth_required','Confirm with your passkey or authenticator to link Discord.');
  return {session:ctx.sessionId,user:ctx.user.id};
}

function times(){
  const now=new Date();
  return {now:now.toISOString(),cutoff:new Date(now.getTime()-20*60_000).toISOString(),expiry:new Date(now.getTime()+5*60_000).toISOString()};
}

// A session's strong assurance, Bot membership and enabled human status are
// re-read inside each database mutation; a cached context is not authority.
const liveSession=`EXISTS (SELECT 1 FROM fb_sessions s JOIN fb_users u ON u.id=s.user_id
  JOIN fb_memberships m ON m.user_id=s.user_id AND m.tenant_id=s.tenant_id
  WHERE s.id=? AND s.user_id=? AND s.tenant_id=? AND s.revoked_at IS NULL AND s.expires_at>?
    AND s.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND s.assurance IN ('passkey','mfa') AND s.auth_time>=? AND s.auth_time<=?
    AND s.auth_time>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-20 minutes') AND s.auth_time<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND u.disabled_at IS NULL AND u.is_synthetic=0 AND m.status='active' AND m.revoked_at IS NULL)`;

// This must only be invoked by an explicit, CSRF-checked initiation route.
export async function startDiscordRecoveryIntent(ctx:Ctx):Promise<string>{
  const {session,user}=principal(ctx), t=times(),state=token('recovery');
  const stateHash=await sha256Hex(state),windowCutoff=new Date(Date.parse(t.now)-24*60*60_000).toISOString();
  try {
   await ctx.db.batch([
    ctx.db.prepare(`INSERT INTO fb_discord_recovery_rate_limits (tenant_id,user_id,window_started_at,attempts)
      SELECT ?,?,?,1 WHERE ${liveSession}
      ON CONFLICT(tenant_id,user_id) DO UPDATE SET window_started_at=CASE WHEN window_started_at<=? THEN excluded.window_started_at ELSE window_started_at END,
        attempts=CASE WHEN window_started_at<=? THEN 1 ELSE attempts+1 END
      WHERE window_started_at<=? OR attempts<10 RETURNING attempts`)
      .bind(ctx.tenant.id,user,t.now,session,user,ctx.tenant.id,t.now,t.cutoff,t.now,windowCutoff,windowCutoff,windowCutoff),
    ctx.db.prepare(`INSERT INTO fb_discord_recovery_intents (state_hash,session_id,tenant_id,user_id,created_at,expires_at)
      SELECT ?,?,?,?,?,? WHERE changes()=1 AND ${liveSession} AND
        (SELECT COUNT(*) FROM (SELECT 1 FROM fb_discord_recovery_intents WHERE tenant_id=? AND user_id=? AND expires_at>? AND consumed_at IS NULL LIMIT 5))<5 RETURNING state_hash`)
      .bind(stateHash,session,ctx.tenant.id,user,t.now,t.expiry,session,user,ctx.tenant.id,t.now,t.cutoff,t.now,ctx.tenant.id,user,t.now),
    ctx.db.prepare("SELECT CASE WHEN EXISTS (SELECT 1 FROM fb_discord_recovery_intents WHERE state_hash=? AND session_id=?) THEN 1 ELSE json('discord_recovery_intent_limited') END").bind(stateHash,session),
   ]);
  }catch(error){if(String(error).includes('malformed JSON'))throw new ApiError(403,'recovery_auth_required','Your session changed or recovery is temporarily limited.');throw error;}
  return state;
}

// `discord` must come from the verified Discord OAuth token exchange for this
// exact state. State is single-use and session-bound, not an identity proof by itself.
export async function beginVerifiedDiscordRecovery(ctx:Ctx,state:string,discord:DiscordUser):Promise<string>{
  const {session,user}=principal(ctx), t=times();
  if(typeof discord.id!=='string'||!/^\d{15,22}$/.test(discord.id)||typeof discord.username!=='string'||
    !discord.username.trim()||discord.username.length>80||/[\u0000-\u001f\u007f]/.test(discord.username)||
    (discord.global_name!=null && (typeof discord.global_name!=='string'||discord.global_name.length>80||/[\u0000-\u001f\u007f]/.test(discord.global_name))))
    throw new ApiError(400,'discord_identity_invalid','Discord identity could not be verified.');
  const id=newId('drc'),stateHash=await sha256Hex(state);
  try {
   await ctx.db.batch([
    ctx.db.prepare(`UPDATE fb_discord_recovery_intents SET consumed_at=? WHERE state_hash=? AND session_id=? AND tenant_id=? AND user_id=?
      AND consumed_at IS NULL AND expires_at>? AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND ${liveSession} RETURNING state_hash`)
      .bind(t.now,stateHash,session,ctx.tenant.id,user,t.now,session,user,ctx.tenant.id,t.now,t.cutoff,t.now),
    ctx.db.prepare(`INSERT INTO fb_discord_recovery_challenges
    (id,session_id,tenant_id,user_id,discord_user_id,username,global_name,created_at,expires_at)
    SELECT ?,?,?,?,?,?,?,?,? WHERE changes()=1 AND ${liveSession} AND
      (SELECT COUNT(*) FROM (SELECT 1 FROM fb_discord_recovery_challenges WHERE tenant_id=? AND user_id=? AND expires_at>? AND consumed_at IS NULL LIMIT 5))<5
    RETURNING id`).bind(id,session,ctx.tenant.id,user,discord.id,discord.username,discord.global_name??null,t.now,t.expiry,
      session,user,ctx.tenant.id,t.now,t.cutoff,t.now,ctx.tenant.id,user,t.now),
    ctx.db.prepare("SELECT CASE WHEN EXISTS (SELECT 1 FROM fb_discord_recovery_challenges WHERE id=? AND session_id=?) THEN 1 ELSE json('discord_recovery_intent_changed') END").bind(id,session),
   ]);
  } catch(error){
   if(String(error).includes('malformed JSON'))throw new ApiError(403,'recovery_auth_required','Your session changed. Confirm your identity again.');
   throw error;
  }
  return id;
}

/** Explicit local prototype; wire to trusted scheduling before exposing routes. */
export async function expireDiscordRecoveryArtifacts(db:D1Database,now=new Date()):Promise<void>{
  const cutoff=new Date(now.getTime()-24*60*60_000).toISOString();
  const rateCutoff=new Date(now.getTime()-48*60*60_000).toISOString();
  await db.batch([
    db.prepare('DELETE FROM fb_discord_recovery_intents WHERE rowid IN (SELECT rowid FROM fb_discord_recovery_intents WHERE expires_at<? ORDER BY expires_at LIMIT 100)').bind(cutoff),
    db.prepare('DELETE FROM fb_discord_recovery_challenges WHERE rowid IN (SELECT rowid FROM fb_discord_recovery_challenges WHERE expires_at<? ORDER BY expires_at LIMIT 100)').bind(cutoff),
    db.prepare('DELETE FROM fb_discord_recovery_rate_limits WHERE rowid IN (SELECT rowid FROM fb_discord_recovery_rate_limits WHERE window_started_at<? ORDER BY window_started_at LIMIT 100)').bind(rateCutoff),
  ]);
}

export async function expireDiscordRecoveryArtifactsIfInstalled(db:D1Database):Promise<void>{
  const row=await db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('fb_discord_recovery_intents','fb_discord_recovery_challenges','fb_discord_recovery_rate_limits')").first<{n:number}>();
  if(Number(row?.n)===0)return;
  if(Number(row?.n)!==3)throw new Error('Discord recovery cleanup schema is incomplete');
  await expireDiscordRecoveryArtifacts(db);
}

export async function recoveryPreview(ctx:Ctx,challengeId:string):Promise<{username:string;global_name:string|null}|null>{
  const {session,user}=principal(ctx),t=times();
  return ctx.db.prepare(`SELECT c.username,c.global_name FROM fb_discord_recovery_challenges c
    WHERE c.id=? AND c.session_id=? AND c.tenant_id=? AND c.user_id=? AND c.consumed_at IS NULL AND c.expires_at>?
      AND c.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND ${liveSession}`).bind(challengeId,session,ctx.tenant.id,user,t.now,session,user,ctx.tenant.id,t.now,t.cutoff,t.now)
    .first<{username:string;global_name:string|null}>();
}

async function recoveredLinkStillAuthorized(ctx:Ctx,challengeId:string,session:string,user:string):Promise<boolean>{
  const t=times();
  const row=await ctx.db.prepare(`SELECT 1 AS ok FROM fb_discord_recovery_challenges c JOIN fb_discord_identities di
    ON di.tenant_id=c.tenant_id AND di.user_id=c.user_id AND di.discord_user_id=c.discord_user_id
    JOIN fb_discord_global_bindings g ON g.discord_user_id=c.discord_user_id AND g.user_id=c.user_id
    WHERE c.id=? AND c.session_id=? AND c.tenant_id=? AND c.user_id=? AND c.consumed_at IS NOT NULL
      AND di.revoked_at IS NULL AND ${liveSession} LIMIT 1`)
    .bind(challengeId,session,ctx.tenant.id,user,session,user,ctx.tenant.id,t.now,t.cutoff,t.now).first<{ok:number}>();
  return Boolean(row);
}

export async function recoveryResult(ctx:Ctx,challengeId:string):Promise<boolean>{
  const {session,user}=principal(ctx);
  return recoveredLinkStillAuthorized(ctx,challengeId,session,user);
}

export async function confirmDiscordRecovery(ctx:Ctx,challengeId:string):Promise<void>{
  const {session,user}=principal(ctx),t=times(),identityId=newId('dci');
  try {
    await ctx.db.batch([
      ctx.db.prepare(`UPDATE fb_discord_recovery_challenges SET consumed_at=? WHERE id=? AND session_id=? AND tenant_id=? AND user_id=?
        AND consumed_at IS NULL AND expires_at>? AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND ${liveSession} RETURNING id`)
        .bind(t.now,challengeId,session,ctx.tenant.id,user,t.now,session,user,ctx.tenant.id,t.now,t.cutoff,t.now),
      ctx.db.prepare(`INSERT INTO fb_discord_binding_admissions (discord_user_id,user_id)
        SELECT discord_user_id,user_id FROM fb_discord_recovery_challenges WHERE id=? AND session_id=? AND consumed_at=? AND changes()=1`)
        .bind(challengeId,session,t.now),
      ctx.db.prepare(`INSERT INTO fb_discord_identities (id,tenant_id,discord_user_id,user_id,username,global_name,linked_at,last_seen_at)
        SELECT ?,tenant_id,discord_user_id,user_id,username,global_name,?,? FROM fb_discord_recovery_challenges
        WHERE id=? AND session_id=? AND consumed_at=? AND EXISTS (SELECT 1 FROM fb_discord_binding_admissions p
          WHERE p.discord_user_id=fb_discord_recovery_challenges.discord_user_id AND p.user_id=fb_discord_recovery_challenges.user_id)`)
        .bind(identityId,t.now,t.now,challengeId,session,t.now),
      ctx.db.prepare(`SELECT CASE WHEN EXISTS (SELECT 1 FROM fb_discord_identities di JOIN fb_discord_recovery_challenges c
        ON c.discord_user_id=di.discord_user_id AND c.user_id=di.user_id AND c.tenant_id=di.tenant_id
        WHERE c.id=? AND c.session_id=? AND c.consumed_at=? AND di.id=? AND di.revoked_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM fb_discord_binding_admissions p JOIN fb_discord_recovery_challenges c ON c.discord_user_id=p.discord_user_id WHERE c.id=?)
        THEN 1 ELSE json('discord_recovery_changed') END`).bind(challengeId,session,t.now,identityId,challengeId),
      auditStatement(ctx,'discord.identity.recovered','discord_identity',identityId,{source:'verified_recovery'}),
    ]);
  } catch(error){
    if(String(error).includes('SQLITE_CONSTRAINT')||String(error).includes('malformed JSON')){
      if(await recoveredLinkStillAuthorized(ctx,challengeId,session,user))return;
      throw new ApiError(409,'recovery_unavailable','That link could not be completed. Confirm your account and try again.');
    }
    throw error;
  }
}
