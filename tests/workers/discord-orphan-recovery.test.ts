import { beforeEach, expect, it } from 'vitest';
import { bootstrap,ctxFor,runtime,tenant } from './helpers';
import { createSession } from '../../src/server/modules/identity';
import { beginVerifiedDiscordRecovery,confirmDiscordRecovery,expireDiscordRecoveryArtifacts,expireDiscordRecoveryArtifactsIfInstalled,startDiscordRecoveryIntent } from '../../src/server/discord/recovery';

const discord={id:'333333333333333333',username:'fixture'};
async function begin(ctx:Awaited<ReturnType<typeof fixture>>){const state=await startDiscordRecoveryIntent(ctx);return beginVerifiedDiscordRecovery(ctx,state,discord);}
beforeEach(async()=>{await bootstrap();});

async function fixture(){
 const album=await tenant('cabinet'),now=new Date().toISOString(),email=`discord.${discord.id}@players.foilbury.invalid`;
 await runtime.DB.prepare("INSERT INTO fb_discord_binding_admissions VALUES (?,'orphan')").bind(discord.id).run();
 await runtime.DB.prepare("INSERT INTO fb_users (id,email,display_name,password_hash,created_at) VALUES ('orphan',?,'Orphan','discord_only$no_password',?)").bind(email,now).run();
 await runtime.DB.prepare("INSERT INTO fb_memberships (tenant_id,user_id,role,created_at,capabilities_json,status) VALUES (?,'orphan','player',?,'[]','active')").bind(album.id,now).run();
 await runtime.DB.prepare('DELETE FROM fb_discord_binding_admissions WHERE discord_user_id=?').bind(discord.id).run();
 const ctx=await ctxFor('cabinet',email);
 await createSession(runtime.DB,album,ctx.user!,{authMethod:'passkey',assurance:'passkey',requireActiveMembership:true});
 const session=await runtime.DB.prepare("SELECT id,auth_time FROM fb_sessions WHERE tenant_id=? AND user_id='orphan' ORDER BY created_at DESC LIMIT 1").bind(album.id).first<{id:string;auth_time:string}>();
 ctx.sessionId=session!.id;ctx.sessionAssurance='passkey';ctx.sessionAuthTime=session!.auth_time;
 return ctx;
}

it('links an explicitly confirmed account with a fresh session and consumes its challenge and permit',async()=>{
 const ctx=await fixture(),id=await begin(ctx);
 await confirmDiscordRecovery(ctx,id);
 expect((await runtime.DB.prepare('SELECT user_id FROM fb_discord_identities WHERE discord_user_id=?').bind(discord.id).first<{user_id:string}>())?.user_id).toBe('orphan');
 expect((await runtime.DB.prepare('SELECT COUNT(*) AS n FROM fb_discord_binding_admissions').first<{n:number}>())?.n).toBe(0);
 await expect(confirmDiscordRecovery(ctx,id)).resolves.toBeUndefined();
 expect((await runtime.DB.prepare("SELECT COUNT(*) AS n FROM fb_audit_events WHERE action='discord.identity.recovered'").first<{n:number}>())?.n).toBe(1);
});

it.each(['session','membership','disabled','assurance'])('rejects %s revoked after OAuth proof without consuming the challenge',async(change)=>{
 const ctx=await fixture(),id=await begin(ctx),now=new Date().toISOString();
 if(change==='session')await runtime.DB.prepare('UPDATE fb_sessions SET revoked_at=? WHERE id=?').bind(now,ctx.sessionId).run();
 if(change==='membership')await runtime.DB.prepare("UPDATE fb_memberships SET status='revoked',revoked_at=? WHERE tenant_id=? AND user_id='orphan'").bind(now,ctx.tenant.id).run();
 if(change==='disabled')await runtime.DB.prepare("UPDATE fb_users SET disabled_at=? WHERE id='orphan'").bind(now).run();
 if(change==='assurance')await runtime.DB.prepare("UPDATE fb_sessions SET assurance='password' WHERE id=?").bind(ctx.sessionId).run();
 await expect(confirmDiscordRecovery(ctx,id)).rejects.toMatchObject({code:'recovery_unavailable'});
 expect((await runtime.DB.prepare('SELECT consumed_at FROM fb_discord_recovery_challenges WHERE id=?').bind(id).first<{consumed_at:string|null}>())?.consumed_at).toBeNull();
 expect(await runtime.DB.prepare('SELECT id FROM fb_discord_identities WHERE discord_user_id=?').bind(discord.id).first()).toBeNull();
 expect((await runtime.DB.prepare('SELECT COUNT(*) AS n FROM fb_discord_binding_admissions').first<{n:number}>())?.n).toBe(0);
});

it('rejects a different session and a conflicting established global binding',async()=>{
 const ctx=await fixture(),id=await begin(ctx),original=ctx.sessionId;
 ctx.sessionId='wrong_session';await expect(confirmDiscordRecovery(ctx,id)).rejects.toMatchObject({code:'recovery_unavailable'});ctx.sessionId=original;
 await runtime.DB.prepare("INSERT INTO fb_discord_global_bindings VALUES (?,'other')").bind(discord.id).run();
 await expect(confirmDiscordRecovery(ctx,id)).rejects.toMatchObject({code:'recovery_unavailable'});
 expect((await runtime.DB.prepare('SELECT consumed_at FROM fb_discord_recovery_challenges WHERE id=?').bind(id).first<{consumed_at:string|null}>())?.consumed_at).toBeNull();
});

it('accepts at most one of two concurrent confirmations',async()=>{
 const ctx=await fixture(),id=await begin(ctx);
 const results=await Promise.allSettled([confirmDiscordRecovery(ctx,id),confirmDiscordRecovery(ctx,id)]);
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(2);
 expect((await runtime.DB.prepare('SELECT COUNT(*) AS n FROM fb_discord_identities WHERE discord_user_id=?').bind(discord.id).first<{n:number}>())?.n).toBe(1);
});

it('binds OAuth state to the initiating session and consumes it only once',async()=>{
 const ctx=await fixture(),state=await startDiscordRecoveryIntent(ctx),session=ctx.sessionId;
 ctx.sessionId='wrong_session';await expect(beginVerifiedDiscordRecovery(ctx,state,discord)).rejects.toMatchObject({code:'recovery_auth_required'});ctx.sessionId=session;
 await expect(beginVerifiedDiscordRecovery(ctx,'other-state',discord)).rejects.toMatchObject({code:'recovery_auth_required'});
 await beginVerifiedDiscordRecovery(ctx,state,discord);
 await expect(beginVerifiedDiscordRecovery(ctx,state,discord)).rejects.toMatchObject({code:'recovery_auth_required'});
 expect((await runtime.DB.prepare('SELECT COUNT(*) AS n FROM fb_discord_recovery_challenges').first<{n:number}>())?.n).toBe(1);
});

it('refuses an expired challenge and stale strong authentication',async()=>{
 const ctx=await fixture(),id=await begin(ctx);
 await runtime.DB.prepare('UPDATE fb_discord_recovery_challenges SET expires_at=? WHERE id=?').bind('2000-01-01T00:00:00.000Z',id).run();
 await expect(confirmDiscordRecovery(ctx,id)).rejects.toMatchObject({code:'recovery_unavailable'});
 await runtime.DB.prepare('UPDATE fb_sessions SET auth_time=? WHERE id=?').bind('2000-01-01T00:00:00.000Z',ctx.sessionId).run();
 await expect(begin(ctx)).rejects.toMatchObject({code:'recovery_auth_required'});
});

it('never restores a revoked Discord identity',async()=>{
 const ctx=await fixture(),id=await begin(ctx),now=new Date().toISOString();
 await runtime.DB.prepare("INSERT INTO fb_discord_binding_admissions VALUES (?,'orphan')").bind(discord.id).run();
 await runtime.DB.prepare("INSERT INTO fb_discord_identities (id,tenant_id,discord_user_id,user_id,username,linked_at,last_seen_at,revoked_at) VALUES ('revoked',?,?,'orphan','fixture',?,?,?)").bind(ctx.tenant.id,discord.id,now,now,now).run();
 await expect(confirmDiscordRecovery(ctx,id)).rejects.toMatchObject({code:'recovery_unavailable'});
 expect((await runtime.DB.prepare("SELECT revoked_at FROM fb_discord_identities WHERE id='revoked'").first<{revoked_at:string}>())?.revoked_at).toBe(now);
});

it('bounds concurrent pending challenges for a session',async()=>{
 const ctx=await fixture();
 const results=await Promise.allSettled(Array.from({length:8},()=>begin(ctx)));
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(5);
 expect((await runtime.DB.prepare('SELECT COUNT(*) AS n FROM fb_discord_recovery_challenges WHERE session_id=?').bind(ctx.sessionId).first<{n:number}>())?.n).toBe(5);
 const plan=await runtime.DB.prepare('EXPLAIN QUERY PLAN SELECT 1 FROM fb_discord_recovery_challenges WHERE tenant_id=? AND user_id=? AND expires_at>? AND consumed_at IS NULL LIMIT 5').bind(ctx.tenant.id,ctx.user!.id,new Date().toISOString()).all<{detail:string}>();
 expect(plan.results?.map(row=>row.detail).join(' ')).toContain('fb_discord_recovery_user_idx');
});

it('persists a daily per-user initiation limit even when prior challenges expire',async()=>{
 const ctx=await fixture();
 for(let i=0;i<10;i++){
  await begin(ctx);
  await runtime.DB.prepare("UPDATE fb_discord_recovery_challenges SET expires_at='2000-01-01T00:00:00.000Z' WHERE session_id=?").bind(ctx.sessionId).run();
 }
 await expect(startDiscordRecoveryIntent(ctx)).rejects.toMatchObject({code:'recovery_auth_required'});
 expect((await runtime.DB.prepare('SELECT attempts FROM fb_discord_recovery_rate_limits WHERE tenant_id=? AND user_id=?').bind(ctx.tenant.id,ctx.user!.id).first<{attempts:number}>())?.attempts).toBe(10);
});

it('cleans at most 100 old challenges and leaves live challenges intact',async()=>{
 const ctx=await fixture(),id=await begin(ctx);
 const inserts=Array.from({length:101},(_,i)=>runtime.DB.prepare("INSERT INTO fb_discord_recovery_challenges (id,session_id,tenant_id,user_id,discord_user_id,username,created_at,expires_at) VALUES (?,?,?,?,?,'fixture','2000-01-01','2000-01-01')").bind(`old_${i}`,ctx.sessionId,ctx.tenant.id,ctx.user!.id,discord.id));
 await runtime.DB.batch(inserts);
 await expireDiscordRecoveryArtifacts(runtime.DB);
 expect((await runtime.DB.prepare("SELECT COUNT(*) AS n FROM fb_discord_recovery_challenges WHERE id LIKE 'old_%'").first<{n:number}>())?.n).toBe(1);
 expect(await runtime.DB.prepare('SELECT id FROM fb_discord_recovery_challenges WHERE id=?').bind(id).first()).not.toBeNull();
});

it('rolls back recovery if the required audit event cannot be recorded',async()=>{
 const ctx=await fixture(),id=await begin(ctx);
 await runtime.DB.exec("CREATE TRIGGER recovery_audit_fail BEFORE INSERT ON fb_audit_events BEGIN SELECT RAISE(ABORT,'audit_fixture_failure'); END;");
 try{
  await expect(confirmDiscordRecovery(ctx,id)).rejects.toThrow();
  expect(await runtime.DB.prepare('SELECT id FROM fb_discord_identities WHERE discord_user_id=?').bind(discord.id).first()).toBeNull();
  expect((await runtime.DB.prepare('SELECT consumed_at FROM fb_discord_recovery_challenges WHERE id=?').bind(id).first<{consumed_at:string|null}>())?.consumed_at).toBeNull();
  expect((await runtime.DB.prepare('SELECT COUNT(*) AS n FROM fb_discord_binding_admissions').first<{n:number}>())?.n).toBe(0);
 }finally{await runtime.DB.exec('DROP TRIGGER recovery_audit_fail;');}
});

it('keeps cleanup active when installed and fails visibly for a partial schema',async()=>{
 const ctx=await fixture(),id=await begin(ctx);
 await runtime.DB.prepare("UPDATE fb_discord_recovery_challenges SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").bind(id).run();
 await expireDiscordRecoveryArtifactsIfInstalled(runtime.DB);
 expect(await runtime.DB.prepare('SELECT id FROM fb_discord_recovery_challenges WHERE id=?').bind(id).first()).toBeNull();
 await runtime.DB.exec('DROP TABLE fb_discord_recovery_intents;');
 await expect(expireDiscordRecoveryArtifactsIfInstalled(runtime.DB)).rejects.toThrow('schema is incomplete');
});

it('rechecks session expiry inside the confirmation batch',async()=>{
 const ctx=await fixture(),id=await begin(ctx),originalDb=ctx.db;let injected=false;
 ctx.db=new Proxy(originalDb,{get(target,key){
  if(key==='batch')return async(statements:D1PreparedStatement[])=>{injected=true;await originalDb.prepare("UPDATE fb_sessions SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").bind(ctx.sessionId).run();return target.batch(statements);};
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
 }});
 await expect(confirmDiscordRecovery(ctx,id)).rejects.toMatchObject({code:'recovery_unavailable'});
 expect(injected).toBe(true);
 expect(await originalDb.prepare('SELECT id FROM fb_discord_identities WHERE discord_user_id=?').bind(discord.id).first()).toBeNull();
});

it.each([null,42,'','bad\nname','x'.repeat(81)])('rejects malformed Discord usernames before using them',async(username)=>{
 const ctx=await fixture(),state=await startDiscordRecoveryIntent(ctx);
 await expect(beginVerifiedDiscordRecovery(ctx,state,{id:discord.id,username} as never)).rejects.toMatchObject({code:'discord_identity_invalid'});
 expect((await runtime.DB.prepare('SELECT COUNT(*) AS n FROM fb_discord_recovery_challenges').first<{n:number}>())?.n).toBe(0);
});

it('keeps an active rate window and deletes only bounded stale rate rows',async()=>{
 const ctx=await fixture();await startDiscordRecoveryIntent(ctx);
 const inserts=Array.from({length:101},(_,i)=>runtime.DB.prepare("INSERT INTO fb_discord_recovery_rate_limits VALUES (?,?,?,10)").bind(ctx.tenant.id,`stale_${i}`,'2000-01-01T00:00:00.000Z'));
 await runtime.DB.batch(inserts);await expireDiscordRecoveryArtifacts(runtime.DB);
 expect((await runtime.DB.prepare("SELECT COUNT(*) AS n FROM fb_discord_recovery_rate_limits WHERE user_id LIKE 'stale_%'").first<{n:number}>())?.n).toBe(1);
 expect((await runtime.DB.prepare('SELECT attempts FROM fb_discord_recovery_rate_limits WHERE tenant_id=? AND user_id=?').bind(ctx.tenant.id,ctx.user!.id).first<{attempts:number}>())?.attempts).toBe(1);
 const plan=await runtime.DB.prepare("EXPLAIN QUERY PLAN SELECT rowid FROM fb_discord_recovery_rate_limits WHERE window_started_at<? ORDER BY window_started_at LIMIT 100").bind(new Date().toISOString()).all<{detail:string}>();
 expect(plan.results?.map(row=>row.detail).join(' ')).toContain('fb_discord_recovery_rate_expiry_idx');
});

it('does not erase a refreshed limit when cleanup overlaps a new intent',async()=>{
 const ctx=await fixture();await startDiscordRecoveryIntent(ctx);
 await runtime.DB.prepare("UPDATE fb_discord_recovery_rate_limits SET window_started_at='2000-01-01T00:00:00.000Z',attempts=10 WHERE tenant_id=? AND user_id=?").bind(ctx.tenant.id,ctx.user!.id).run();
 const results=await Promise.allSettled([startDiscordRecoveryIntent(ctx),expireDiscordRecoveryArtifacts(runtime.DB)]);
 expect(results.every(r=>r.status==='fulfilled')).toBe(true);
 expect((await runtime.DB.prepare('SELECT attempts FROM fb_discord_recovery_rate_limits WHERE tenant_id=? AND user_id=?').bind(ctx.tenant.id,ctx.user!.id).first<{attempts:number}>())?.attempts).toBe(1);
});
