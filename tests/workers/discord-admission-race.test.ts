import { beforeEach, expect, it } from 'vitest';
import { ensureDiscordPlayer, linkDiscordIdentity } from '../../src/server/discord/context';
import type { CurrentUser } from '../../src/server/context';
import { createSession } from '../../src/server/modules/identity';
import { handleDiscordInteraction } from '../../src/server/discord/handler';
import { signDiscordRequest } from '../../src/server/discord/signature';
import type { DiscordEnv } from '../../src/server/discord/types';
import { bootstrap, runtime, tenant } from './helpers';

const discord={id:'111111111111111111',username:'fixture',global_name:'Fixture'};
beforeEach(async()=>{await bootstrap();});

async function fixture(active=false){
  const album=await tenant('cabinet'),now=new Date().toISOString();
  await runtime.DB.prepare("INSERT INTO fb_discord_binding_admissions (discord_user_id,user_id) VALUES (?,'admission_user')").bind(discord.id).run();
  await runtime.DB.prepare("INSERT INTO fb_users (id,email,display_name,password_hash,platform_admin,created_at) VALUES ('admission_user',?,'Fixture','discord_only$no_password',0,?)").bind(`discord.${discord.id}@players.foilbury.invalid`,now).run();
  const other=await tenant('harbour');
  await runtime.DB.prepare("INSERT INTO fb_discord_identities (id,tenant_id,discord_user_id,user_id,username,linked_at,last_seen_at) VALUES ('verified_fixture',?,?,'admission_user','Fixture',?,?)").bind(other.id,discord.id,now,now).run();
  if(active)await runtime.DB.prepare("INSERT INTO fb_memberships (tenant_id,user_id,role,created_at,capabilities_json,status) VALUES (?,'admission_user','player',?,'[]','active')").bind(album.id,now).run();
  return album;
}
function env(db:D1Database):DiscordEnv {return new Proxy(runtime as unknown as DiscordEnv,{get(target,key){if(key==='DB')return db;return Reflect.get(target,key,target);}});}
async function seedLegacyConflict(write:()=>Promise<unknown>){
 const row=await runtime.DB.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='fb_discord_global_bind_insert'").first<{sql:string}>();
 if(!row)throw new Error('expected global binding trigger');
 await runtime.DB.exec('DROP TRIGGER fb_discord_global_bind_insert;');
 try {await write();} finally {await runtime.DB.prepare(row.sql).run();}
}
function raceBeforeBatch(mutate:()=>Promise<unknown>):{db:D1Database;injected:()=>boolean}{
  let did=false;
  const db=new Proxy(runtime.DB,{get(target,key){
    if(key==='batch')return async(statements:D1PreparedStatement[])=>{if(!did){did=true;await mutate();}return target.batch(statements);};
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
  return {db,injected:()=>did};
}
async function assertNoSetup(tenantId:string){
  expect(await runtime.DB.prepare("SELECT id FROM fb_discord_identities WHERE tenant_id=? AND discord_user_id=?").bind(tenantId,discord.id).first()).toBeNull();
  expect(await runtime.DB.prepare("SELECT user_id FROM fb_wallets WHERE tenant_id=? AND user_id='admission_user'").bind(tenantId).first()).toBeNull();
  expect((await runtime.DB.prepare("SELECT COUNT(*) AS n FROM fb_ledger_entries WHERE tenant_id=? AND user_id='admission_user' AND reference_type='welcome_reward'").bind(tenantId).first<{n:number}>())!.n).toBe(0);
}

it('does not restore a revoked membership inserted after the absence read',async()=>{
 const album=await fixture(),now=new Date().toISOString();
 const race=raceBeforeBatch(()=>runtime.DB.prepare("INSERT INTO fb_memberships (tenant_id,user_id,role,created_at,capabilities_json,status,revoked_at) VALUES (?,'admission_user','editor',?,'[\"members\"]','revoked',?)").bind(album.id,now,now).run());
 await expect(ensureDiscordPlayer(env(race.db),album,discord)).rejects.toMatchObject({code:'discord_setup_changed'});
 expect(race.injected()).toBe(true);await assertNoSetup(album.id);
 const row=await runtime.DB.prepare("SELECT role,status,capabilities_json FROM fb_memberships WHERE tenant_id=? AND user_id='admission_user'").bind(album.id).first();
 expect(row).toEqual({role:'editor',status:'revoked',capabilities_json:'["members"]'});
});

it.each(['revoked','disabled','synthetic'])('rejects %s before the atomic setup',async(change)=>{
 const album=await fixture(true),now=new Date().toISOString();
 const race=raceBeforeBatch(()=>change==='revoked'
   ? runtime.DB.prepare("UPDATE fb_memberships SET status='revoked',revoked_at=? WHERE tenant_id=? AND user_id='admission_user'").bind(now,album.id).run()
   : runtime.DB.prepare(change==='disabled'?"UPDATE fb_users SET disabled_at=? WHERE id='admission_user'":"UPDATE fb_users SET is_synthetic=1 WHERE id='admission_user'").bind(...(change==='disabled'?[now]:[])).run());
 await expect(ensureDiscordPlayer(env(race.db),album,discord)).rejects.toMatchObject({code:'discord_setup_changed'});
 expect(race.injected()).toBe(true);await assertNoSetup(album.id);
});

it('concurrent first interactions produce one identity and one starter ledger credit',async()=>{
 const album=await fixture();
 const results=await Promise.all([ensureDiscordPlayer(env(runtime.DB),album,discord),ensureDiscordPlayer(env(runtime.DB),album,discord)]);
 expect(results.map(result=>result.user.id)).toEqual(['admission_user','admission_user']);
 expect((await runtime.DB.prepare("SELECT COUNT(*) AS n FROM fb_discord_identities WHERE tenant_id=? AND discord_user_id=?").bind(album.id,discord.id).first<{n:number}>())!.n).toBe(1);
 expect((await runtime.DB.prepare("SELECT COUNT(*) AS n FROM fb_ledger_entries WHERE tenant_id=? AND user_id='admission_user' AND reference_type='welcome_reward'").bind(album.id).first<{n:number}>())!.n).toBe(1);
 const wallet=await runtime.DB.prepare("SELECT w.balance,e.starter_grant FROM fb_wallets w JOIN fb_economy_settings e ON e.tenant_id=w.tenant_id WHERE w.tenant_id=? AND w.user_id='admission_user'").bind(album.id).first<{balance:number;starter_grant:number}>();
 expect(wallet!.balance).toBe(wallet!.starter_grant);
});

it('does not return a usable context if revocation follows the committed setup',async()=>{
 const album=await fixture();let injected=false;
 const db=new Proxy(runtime.DB,{get(target,key){
  if(key==='batch')return async(statements:D1PreparedStatement[])=>{const result=await target.batch(statements);if(!injected){injected=true;await runtime.DB.prepare("UPDATE fb_memberships SET status='revoked',revoked_at=? WHERE tenant_id=? AND user_id='admission_user'").bind(new Date().toISOString(),album.id).run();}return result;};
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
 }});
 await expect(ensureDiscordPlayer(env(db),album,discord)).rejects.toMatchObject({code:'membership_revoked'});
 expect(injected).toBe(true);
 // The starter grant linearized before the revocation and is not rolled back.
 expect((await runtime.DB.prepare("SELECT COUNT(*) AS n FROM fb_ledger_entries WHERE tenant_id=? AND user_id='admission_user' AND reference_type='welcome_reward'").bind(album.id).first<{n:number}>())!.n).toBe(1);
});

it('rolls back membership, wallet and credit if identity insertion fails',async()=>{
 const album=await fixture();
 await runtime.DB.exec("CREATE TRIGGER admission_identity_fail BEFORE INSERT ON fb_discord_identities BEGIN SELECT RAISE(ABORT,'identity_fixture_failure'); END;");
 try {
  await expect(ensureDiscordPlayer(env(runtime.DB),album,discord)).rejects.toThrow('identity_fixture_failure');
  await assertNoSetup(album.id);
  expect(await runtime.DB.prepare("SELECT user_id FROM fb_memberships WHERE tenant_id=? AND user_id='admission_user'").bind(album.id).first()).toBeNull();
 } finally {await runtime.DB.exec('DROP TRIGGER admission_identity_fail;');}
});

it('rolls back setup when the starter balance update is ignored',async()=>{
 const album=await fixture();
 await runtime.DB.exec("CREATE TRIGGER admission_wallet_ignore BEFORE UPDATE ON fb_wallets WHEN NEW.user_id='admission_user' BEGIN SELECT RAISE(IGNORE); END;");
 try {
  await expect(ensureDiscordPlayer(env(runtime.DB),album,discord)).rejects.toMatchObject({code:'discord_setup_changed'});
  await assertNoSetup(album.id);
  expect(await runtime.DB.prepare("SELECT user_id FROM fb_memberships WHERE tenant_id=? AND user_id='admission_user'").bind(album.id).first()).toBeNull();
 } finally {await runtime.DB.exec('DROP TRIGGER admission_wallet_ignore;');}
});

it('does not credit the wrong account when the Discord identity is linked concurrently',async()=>{
 const album=await fixture(),now=new Date().toISOString();
 await runtime.DB.prepare("INSERT INTO fb_users (id,email,display_name,password_hash,created_at) VALUES ('other_user','other@fixture.invalid','Other','test',?)").bind(now).run();
 await runtime.DB.prepare("INSERT INTO fb_memberships (tenant_id,user_id,role,created_at,capabilities_json,status) VALUES (?,'other_user','player',?,'[]','active')").bind(album.id,now).run();
 const race=raceBeforeBatch(()=>seedLegacyConflict(()=>runtime.DB.prepare("INSERT INTO fb_discord_identities (id,tenant_id,discord_user_id,user_id,username,linked_at,last_seen_at) VALUES ('other_identity',?,?,'other_user','Other',?,?)").bind(album.id,discord.id,now,now).run()));
 await expect(ensureDiscordPlayer(env(race.db),album,discord)).rejects.toMatchObject({code:'discord_setup_changed'});
 expect(race.injected()).toBe(true);
 expect((await runtime.DB.prepare("SELECT user_id FROM fb_discord_identities WHERE tenant_id=? AND discord_user_id=?").bind(album.id,discord.id).first<{user_id:string}>())?.user_id).toBe('other_user');
 expect(await runtime.DB.prepare("SELECT user_id FROM fb_wallets WHERE tenant_id=? AND user_id='admission_user'").bind(album.id).first()).toBeNull();
 expect((await runtime.DB.prepare("SELECT COUNT(*) AS n FROM fb_ledger_entries WHERE tenant_id=? AND user_id='admission_user'").bind(album.id).first<{n:number}>())!.n).toBe(0);
 expect(await runtime.DB.prepare("SELECT user_id FROM fb_memberships WHERE tenant_id=? AND user_id='admission_user'").bind(album.id).first()).toBeNull();
});

it('does not return an existing linked player if membership is revoked before profile refresh',async()=>{
 const album=await fixture();await ensureDiscordPlayer(env(runtime.DB),album,discord);
 let injected=false;
 const db=new Proxy(runtime.DB,{get(target,key){
  if(key==='prepare')return(sql:string)=>{
   const raw=target.prepare(sql);
   if(!sql.includes('UPDATE fb_discord_identities SET username='))return raw;
   return new Proxy(raw,{get(statement,method){
    if(method==='bind')return(...args:unknown[])=>{
     const bound=statement.bind(...args);
     return new Proxy(bound,{get(item,member){
      if(member==='first')return async()=>{if(!injected){injected=true;await runtime.DB.prepare("UPDATE fb_memberships SET status='revoked',revoked_at=? WHERE tenant_id=? AND user_id='admission_user'").bind(new Date().toISOString(),album.id).run();}return item.first();};
      const value=Reflect.get(item,member,item);return typeof value==='function'?value.bind(item):value;
     }});
    };
    const value=Reflect.get(statement,method,statement);return typeof value==='function'?value.bind(statement):value;
   }});
  };
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
 }});
 await expect(ensureDiscordPlayer(env(db),album,{...discord,username:'should-not-write'})).rejects.toMatchObject({code:'membership_revoked'});
 expect(injected).toBe(true);
 expect((await runtime.DB.prepare("SELECT username FROM fb_discord_identities WHERE tenant_id=? AND discord_user_id=?").bind(album.id,discord.id).first<{username:string}>())?.username).toBe('fixture');
});

it('rejects a signed Discord first interaction when membership is revoked at setup',async()=>{
 const album=await fixture(true),now=new Date().toISOString(),applicationId='123456789012345670',guildId='123456789012345671',channelId='123456789012345672';
 await runtime.DB.prepare(`INSERT INTO fb_discord_installations (id,tenant_id,application_id,guild_id,guild_name,channel_allowlist_json,game_enabled,active,created_at,updated_at)
  VALUES ('admission_install',?,?,?,'Fixture',?,1,1,?,?)`).bind(album.id,applicationId,guildId,JSON.stringify([channelId]),now,now).run();
 const pair=await crypto.subtle.generateKey({name:'Ed25519'},true,['sign','verify']) as CryptoKeyPair;
 const publicKey=Array.from(new Uint8Array(await crypto.subtle.exportKey('raw',pair.publicKey)),b=>b.toString(16).padStart(2,'0')).join('');
 const race=raceBeforeBatch(()=>runtime.DB.prepare("UPDATE fb_memberships SET status='revoked',revoked_at=? WHERE tenant_id=? AND user_id='admission_user'").bind(now,album.id).run());
 const raw=JSON.stringify({id:'123456789012345673',application_id:applicationId,type:2,token:'fixture-token',guild_id:guildId,channel_id:channelId,member:{user:discord,roles:[]},data:{name:'foilbury',type:1,options:[{name:'profile',type:1,options:[]}]}});
 const timestamp=String(Math.floor(Date.now()/1000)),signature=await signDiscordRequest({body:raw,timestamp,privateKey:pair.privateKey});
 const wrapped=new Proxy(env(race.db),{get(target,key){if(key==='DISCORD_APPLICATION_ID')return applicationId;if(key==='DISCORD_PUBLIC_KEY')return publicKey;return Reflect.get(target,key,target);}});
 const response=await handleDiscordInteraction(new Request('https://foilbury.test/api/discord/interactions',{method:'POST',headers:{'content-type':'application/json','x-signature-ed25519':signature,'x-signature-timestamp':timestamp},body:raw}),wrapped,{publicKey});
 const payload=await response.json() as {type:number;data?:{flags?:number}};
 expect(payload.type).toBe(4);expect(payload.data?.flags).toBe(64);expect(race.injected()).toBe(true);
 await assertNoSetup(album.id);
});

it('does not leave a new user behind when first setup rolls back',async()=>{
 const album=await tenant('cabinet');
 await runtime.DB.exec("CREATE TRIGGER admission_identity_fail BEFORE INSERT ON fb_discord_identities BEGIN SELECT RAISE(ABORT,'identity_fixture_failure'); END;");
 try {
  await expect(ensureDiscordPlayer(env(runtime.DB),album,discord)).rejects.toThrow('identity_fixture_failure');
  expect(await runtime.DB.prepare('SELECT id FROM fb_users WHERE email=?').bind(`discord.${discord.id}@players.foilbury.invalid`).first()).toBeNull();
  expect(await runtime.DB.prepare('SELECT id FROM fb_discord_identities WHERE discord_user_id=?').bind(discord.id).first()).toBeNull();
 } finally {await runtime.DB.exec('DROP TRIGGER admission_identity_fail;');}
});

it('reuses a globally linked real account in a second Bot without creating a duplicate',async()=>{
 const first=await tenant('cabinet'),second=await tenant('harbour'),now=new Date().toISOString();
 await runtime.DB.prepare("INSERT INTO fb_users (id,email,display_name,password_hash,created_at) VALUES ('real_person','real@fixture.invalid','Real','password',?)").bind(now).run();
 await runtime.DB.prepare("INSERT INTO fb_memberships (tenant_id,user_id,role,created_at,capabilities_json,status) VALUES (?,'real_person','player',?,'[]','active')").bind(first.id,now).run();
 await runtime.DB.prepare("INSERT INTO fb_discord_binding_admissions VALUES (?,'real_person')").bind(discord.id).run();
 await runtime.DB.prepare("INSERT INTO fb_discord_identities (id,tenant_id,discord_user_id,user_id,username,linked_at,last_seen_at) VALUES ('existing_real',?,?,'real_person','Fixture',?,?)").bind(first.id,discord.id,now,now).run();
 const result=await ensureDiscordPlayer(env(runtime.DB),second,discord);
 expect(result.user.id).toBe('real_person');expect(result.created).toBe(false);
 expect(await runtime.DB.prepare('SELECT id FROM fb_users WHERE email=?').bind(`discord.${discord.id}@players.foilbury.invalid`).first()).toBeNull();
 const links=await runtime.DB.prepare('SELECT DISTINCT user_id FROM fb_discord_identities WHERE discord_user_id=?').bind(discord.id).all<{user_id:string}>();
 expect(links.results).toEqual([{user_id:'real_person'}]);
 expect((await runtime.DB.prepare("SELECT status FROM fb_memberships WHERE tenant_id=? AND user_id='real_person'").bind(second.id).first<{status:string}>())?.status).toBe('active');
});

it('fails closed for conflicting global identity mappings',async()=>{
 const one=await tenant('cabinet'),two=await tenant('harbour'),target=await tenant('attic'),now=new Date().toISOString();
 for(const [id,album] of [['person_a',one],['person_b',two]] as const){
  await runtime.DB.prepare('INSERT INTO fb_users (id,email,display_name,password_hash,created_at) VALUES (?,?,?,\'password\',?)').bind(id,`${id}@fixture.invalid`,id,now).run();
  await runtime.DB.prepare("INSERT INTO fb_memberships (tenant_id,user_id,role,created_at,capabilities_json,status) VALUES (?,?,'player',?,'[]','active')").bind(album.id,id,now).run();
  await seedLegacyConflict(()=>runtime.DB.prepare('INSERT INTO fb_discord_identities (id,tenant_id,discord_user_id,user_id,username,linked_at,last_seen_at) VALUES (?,?,?,?,?,?,?)').bind(`identity_${id}`,album.id,discord.id,id,id,now,now).run());
 }
 await expect(ensureDiscordPlayer(env(runtime.DB),target,discord)).rejects.toMatchObject({code:'discord_link_conflict'});
 await expect(ensureDiscordPlayer(env(runtime.DB),one,discord)).rejects.toMatchObject({code:'discord_link_conflict'});
 expect(await runtime.DB.prepare('SELECT id FROM fb_users WHERE email=?').bind(`discord.${discord.id}@players.foilbury.invalid`).first()).toBeNull();
 expect((await runtime.DB.prepare('SELECT COUNT(*) AS n FROM fb_discord_identities WHERE tenant_id=? AND discord_user_id=?').bind(target.id,discord.id).first<{n:number}>())!.n).toBe(0);
});

it('does not create a duplicate when only a revoked global identity exists',async()=>{
 const first=await tenant('cabinet'),second=await tenant('harbour'),now=new Date().toISOString();
 await runtime.DB.prepare("INSERT INTO fb_users (id,email,display_name,password_hash,created_at) VALUES ('prior_person','prior@fixture.invalid','Prior','password',?)").bind(now).run();
 await runtime.DB.prepare("INSERT INTO fb_discord_binding_admissions VALUES (?,'prior_person')").bind(discord.id).run();
 await runtime.DB.prepare("INSERT INTO fb_discord_identities (id,tenant_id,discord_user_id,user_id,username,linked_at,last_seen_at,revoked_at) VALUES ('revoked_identity',?,?,'prior_person','Prior',?,?,?)").bind(first.id,discord.id,now,now,now).run();
 await expect(ensureDiscordPlayer(env(runtime.DB),second,discord)).rejects.toMatchObject({code:'discord_link_conflict'});
 expect(await runtime.DB.prepare('SELECT id FROM fb_users WHERE email=?').bind(`discord.${discord.id}@players.foilbury.invalid`).first()).toBeNull();
});

it('never links an unrelated account solely because it has the reserved email',async()=>{
 const album=await tenant('cabinet'),now=new Date().toISOString();
 await runtime.DB.prepare("INSERT INTO fb_discord_binding_admissions VALUES (?,'unrelated')").bind(discord.id).run();
 await runtime.DB.prepare("INSERT INTO fb_users (id,email,display_name,password_hash,created_at) VALUES ('unrelated',?,'Unrelated','password',?)").bind(`discord.${discord.id}@players.foilbury.invalid`,now).run();
 await runtime.DB.prepare('DELETE FROM fb_discord_binding_admissions WHERE discord_user_id=?').bind(discord.id).run();
 await expect(ensureDiscordPlayer(env(runtime.DB),album,discord)).rejects.toMatchObject({code:'discord_link_conflict'});
 expect(await runtime.DB.prepare('SELECT id FROM fb_discord_identities WHERE discord_user_id=?').bind(discord.id).first()).toBeNull();
});

it('does not infer a Discord link from an orphan with the Discord-only password sentinel',async()=>{
 const album=await tenant('cabinet'),now=new Date().toISOString();
 await runtime.DB.prepare("INSERT INTO fb_discord_binding_admissions VALUES (?,'orphan')").bind(discord.id).run();
 await runtime.DB.prepare("INSERT INTO fb_users (id,email,display_name,password_hash,created_at) VALUES ('orphan',?,'Orphan','discord_only$no_password',?)").bind(`discord.${discord.id}@players.foilbury.invalid`,now).run();
 await runtime.DB.prepare('DELETE FROM fb_discord_binding_admissions WHERE discord_user_id=?').bind(discord.id).run();
 await expect(ensureDiscordPlayer(env(runtime.DB),album,discord)).rejects.toMatchObject({code:'discord_link_conflict'});
 expect(await runtime.DB.prepare('SELECT id FROM fb_discord_identities WHERE discord_user_id=?').bind(discord.id).first()).toBeNull();
 expect(await runtime.DB.prepare("SELECT user_id FROM fb_memberships WHERE tenant_id=? AND user_id='orphan'").bind(album.id).first()).toBeNull();
});

it('concurrent first interactions across Bots resolve one new person',async()=>{
 const one=await tenant('cabinet'),two=await tenant('harbour');
 const results=await Promise.all([ensureDiscordPlayer(env(runtime.DB),one,discord),ensureDiscordPlayer(env(runtime.DB),two,discord)]);
 expect(results[0].user.id).toBe(results[1].user.id);
 expect((await runtime.DB.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM fb_discord_identities WHERE discord_user_id=?').bind(discord.id).first<{n:number}>())!.n).toBe(1);
 expect((await runtime.DB.prepare('SELECT COUNT(*) AS n FROM fb_users WHERE email=?').bind(`discord.${discord.id}@players.foilbury.invalid`).first<{n:number}>())!.n).toBe(1);
});

it('serializes competing OAuth links across Bots to one Foilbury account',async()=>{
 const one=await tenant('cabinet'),two=await tenant('harbour'),now=new Date().toISOString();
 for(const id of ['oauth_a','oauth_b']) await runtime.DB.prepare('INSERT INTO fb_users (id,email,display_name,password_hash,created_at) VALUES (?,?,?,\'password\',?)').bind(id,`${id}@fixture.invalid`,id,now).run();
 for(const [id,album] of [['oauth_a',one],['oauth_b',two]] as const) await runtime.DB.prepare("INSERT INTO fb_memberships (tenant_id,user_id,role,created_at,capabilities_json,status) VALUES (?,?,'player',?,'[]','active')").bind(album.id,id,now).run();
 const results=await Promise.allSettled([linkDiscordIdentity(env(runtime.DB),one,{id:'oauth_a'} as CurrentUser,discord),linkDiscordIdentity(env(runtime.DB),two,{id:'oauth_b'} as CurrentUser,discord)]);
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
 expect((await runtime.DB.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM fb_discord_identities WHERE discord_user_id=?').bind(discord.id).first<{n:number}>())!.n).toBe(1);
});

it('serializes OAuth linking against a first interaction in another Bot',async()=>{
 const one=await tenant('cabinet'),two=await tenant('harbour'),now=new Date().toISOString();
 await runtime.DB.prepare("INSERT INTO fb_users (id,email,display_name,password_hash,created_at) VALUES ('oauth_a','oauth@fixture.invalid','OAuth','password',?)").bind(now).run();
 await runtime.DB.prepare("INSERT INTO fb_memberships (tenant_id,user_id,role,created_at,capabilities_json,status) VALUES (?,'oauth_a','player',?,'[]','active')").bind(one.id,now).run();
 const results=await Promise.allSettled([linkDiscordIdentity(env(runtime.DB),one,{id:'oauth_a'} as CurrentUser,discord),ensureDiscordPlayer(env(runtime.DB),two,discord)]);
 expect(results.some(r=>r.status==='fulfilled')).toBe(true);
 expect((await runtime.DB.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM fb_discord_identities WHERE discord_user_id=?').bind(discord.id).first<{n:number}>())!.n).toBe(1);
});

it.each(['revoked','disabled'])('refuses OAuth linking when authority is %s before the insert',async(change)=>{
 const album=await tenant('cabinet'),now=new Date().toISOString();
 await runtime.DB.prepare("INSERT INTO fb_users (id,email,display_name,password_hash,created_at) VALUES ('oauth_a','oauth@fixture.invalid','OAuth','password',?)").bind(now).run();
 await runtime.DB.prepare("INSERT INTO fb_memberships (tenant_id,user_id,role,created_at,capabilities_json,status) VALUES (?,'oauth_a','player',?,'[]','active')").bind(album.id,now).run();
 let injected=false;
 const db=new Proxy(runtime.DB,{get(target,key){
  if(key==='batch') return async(statements:D1PreparedStatement[])=>{injected=true;if(change==='revoked')await runtime.DB.prepare("UPDATE fb_memberships SET status='revoked',revoked_at=? WHERE tenant_id=? AND user_id='oauth_a'").bind(now,album.id).run();else await runtime.DB.prepare("UPDATE fb_users SET disabled_at=? WHERE id='oauth_a'").bind(now).run();return target.batch(statements);};
  const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v;
 }});
 await expect(linkDiscordIdentity(env(db),album,{id:'oauth_a'} as CurrentUser,discord)).rejects.toMatchObject({code:'discord_link_conflict'});
 expect(injected).toBe(true);expect(await runtime.DB.prepare('SELECT id FROM fb_discord_identities WHERE discord_user_id=?').bind(discord.id).first()).toBeNull();
});

it.each(['membership','identity','disabled'])('does not issue a Discord session after %s revocation',async(change)=>{
 const album=await tenant('cabinet'),player=await ensureDiscordPlayer(env(runtime.DB),album,discord),now=new Date().toISOString();
 if(change==='membership')await runtime.DB.prepare("UPDATE fb_memberships SET status='revoked',revoked_at=? WHERE tenant_id=? AND user_id=?").bind(now,album.id,player.user.id).run();
 else if(change==='identity')await runtime.DB.prepare('UPDATE fb_discord_identities SET revoked_at=? WHERE tenant_id=? AND discord_user_id=?').bind(now,album.id,discord.id).run();
 else await runtime.DB.prepare('UPDATE fb_users SET disabled_at=? WHERE id=?').bind(now,player.user.id).run();
 await expect(createSession(runtime.DB,album,player.user,{authMethod:'discord',assurance:'discord',requireActiveMembership:true,requireDiscordIdentity:discord.id})).rejects.toMatchObject({code:'membership_inactive'});
 expect((await runtime.DB.prepare('SELECT COUNT(*) AS n FROM fb_sessions WHERE tenant_id=? AND user_id=?').bind(album.id,player.user.id).first<{n:number}>())!.n).toBe(0);
});

it('does not create the OAuth wallet after membership is revoked following the link',async()=>{
 const album=await tenant('cabinet'),now=new Date().toISOString();
 await runtime.DB.prepare("INSERT INTO fb_users (id,email,display_name,password_hash,created_at) VALUES ('oauth_a','oauth@fixture.invalid','OAuth','password',?)").bind(now).run();
 await runtime.DB.prepare("INSERT INTO fb_memberships (tenant_id,user_id,role,created_at,capabilities_json,status) VALUES (?,'oauth_a','player',?,'[]','active')").bind(album.id,now).run();
 let injected=false;
 const db=new Proxy(runtime.DB,{get(target,key){
  if(key==='prepare')return (sql:string)=>{const stmt=target.prepare(sql);if(!sql.includes('INSERT INTO fb_wallets'))return stmt;
   return new Proxy(stmt,{get(st,k){if(k==='bind')return (...args:unknown[])=>{const bound=st.bind(...args);return new Proxy(bound,{get(b,method){if(method==='run')return async()=>{injected=true;await runtime.DB.prepare("UPDATE fb_memberships SET status='revoked',revoked_at=? WHERE tenant_id=? AND user_id='oauth_a'").bind(now,album.id).run();return b.run();};const v=Reflect.get(b,method,b);return typeof v==='function'?v.bind(b):v;}});};const v=Reflect.get(st,k,st);return typeof v==='function'?v.bind(st):v;}});};
  const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v;
 }});
 await linkDiscordIdentity(env(db),album,{id:'oauth_a'} as CurrentUser,discord);
 expect(injected).toBe(true);expect(await runtime.DB.prepare("SELECT user_id FROM fb_wallets WHERE tenant_id=? AND user_id='oauth_a'").bind(album.id).first()).toBeNull();
 await expect(createSession(runtime.DB,album,{id:'oauth_a'} as CurrentUser,{requireActiveMembership:true,requireDiscordIdentity:discord.id})).rejects.toMatchObject({code:'membership_inactive'});
});

it('does not issue a Discord session when a conflicting global binding appears',async()=>{
 const album=await tenant('cabinet'),other=await tenant('harbour'),player=await ensureDiscordPlayer(env(runtime.DB),album,discord),now=new Date().toISOString();
 await runtime.DB.prepare("INSERT INTO fb_users (id,email,display_name,password_hash,created_at) VALUES ('conflict','conflict@fixture.invalid','Conflict','password',?)").bind(now).run();
 await seedLegacyConflict(()=>runtime.DB.prepare("INSERT INTO fb_discord_identities (id,tenant_id,discord_user_id,user_id,username,linked_at,last_seen_at) VALUES ('conflicting',?,?,'conflict','Conflict',?,?)").bind(other.id,discord.id,now,now).run());
 await expect(createSession(runtime.DB,album,player.user,{authMethod:'discord',assurance:'discord',requireActiveMembership:true,requireDiscordIdentity:discord.id})).rejects.toMatchObject({code:'membership_inactive'});
});

it('fails closed when the global identity index is absent',async()=>{
 const album=await tenant('cabinet');await runtime.DB.exec('DROP INDEX fb_discord_identity_global_lookup_idx;');
 await expect(ensureDiscordPlayer(env(runtime.DB),album,discord)).rejects.toMatchObject({code:'discord_identity_unavailable'});
 expect(await runtime.DB.prepare('SELECT id FROM fb_users WHERE email=?').bind(`discord.${discord.id}@players.foilbury.invalid`).first()).toBeNull();
});
