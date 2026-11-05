import { beforeEach, expect, it } from 'vitest';
import { bootstrap, runtime, tenant } from './helpers';
import { ensureDiscordPlayer, linkDiscordIdentity } from '../../src/server/discord/context';
import type { DiscordEnv } from '../../src/server/discord/types';
import type { CurrentUser } from '../../src/server/context';

beforeEach(async()=>{await bootstrap();});

async function setup(){
 const a=await tenant('cabinet'),b=await tenant('harbour'),now=new Date().toISOString();
 for(const id of ['person_a','person_b'])await runtime.DB.prepare('INSERT INTO fb_users (id,email,display_name,password_hash,created_at) VALUES (?,?,?,\'test\',?)').bind(id,`${id}@fixture.invalid`,id,now).run();
 await runtime.DB.prepare("INSERT INTO fb_discord_binding_admissions (discord_user_id,user_id) VALUES ('111111111111111111','person_a')").run();
 const insert=(album:string,id:string,person:string)=>runtime.DB.prepare('INSERT INTO fb_discord_identities (id,tenant_id,discord_user_id,user_id,username,linked_at,last_seen_at) VALUES (?,?,\'111111111111111111\',?,\'fixture\',?,?)').bind(id,album,person,now,now);
 return {a,b,insert,now};
}

it('rejects competing legacy inserts atomically across Bots',async()=>{
 const {a,b,insert}=await setup();
 const results=await Promise.allSettled([insert(a.id,'identity_a','person_a').run(),insert(b.id,'identity_b','person_b').run()]);
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
 expect((await runtime.DB.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM fb_discord_identities WHERE discord_user_id=?').bind('111111111111111111').first<{n:number}>())?.n).toBe(1);
 expect((await runtime.DB.prepare('SELECT COUNT(*) AS n FROM fb_discord_global_bindings WHERE discord_user_id=?').bind('111111111111111111').first<{n:number}>())?.n).toBe(1);
});

it('allows the same account across Bots and retains its binding after revocation and deletion',async()=>{
 const {a,b,insert,now}=await setup();await insert(a.id,'identity_a','person_a').run();await insert(b.id,'identity_b','person_a').run();
 await runtime.DB.prepare('UPDATE fb_discord_identities SET revoked_at=? WHERE id=?').bind(now,'identity_a').run();
 await runtime.DB.prepare('DELETE FROM fb_discord_identities WHERE id IN (?,?)').bind('identity_a','identity_b').run();
 await expect(insert(b.id,'identity_c','person_b').run()).rejects.toThrow('discord_global_binding_not_admitted');
 expect((await runtime.DB.prepare('SELECT user_id FROM fb_discord_global_bindings WHERE discord_user_id=?').bind('111111111111111111').first<{user_id:string}>())?.user_id).toBe('person_a');
});

it('blocks an old Worker from binding an unverified orphan without a permit',async()=>{
 const {a,insert}=await setup();
 await runtime.DB.prepare('DELETE FROM fb_discord_binding_admissions').run();
 await expect(insert(a.id,'identity_a','person_a').run()).rejects.toThrow('discord_global_binding_not_admitted');
 expect(await runtime.DB.prepare('SELECT discord_user_id FROM fb_discord_global_bindings').first()).toBeNull();
});

it('serializes competing new-worker admission batches and rolls back the loser permit',async()=>{
 const {a,b,insert}=await setup();await runtime.DB.prepare('DELETE FROM fb_discord_binding_admissions').run();
 const permit=(id:string)=>runtime.DB.prepare("INSERT INTO fb_discord_binding_admissions (discord_user_id,user_id) VALUES ('111111111111111111',?)").bind(id);
 const results=await Promise.allSettled([
  runtime.DB.batch([permit('person_a'),insert(a.id,'identity_a','person_a')]),
  runtime.DB.batch([permit('person_b'),insert(b.id,'identity_b','person_b')]),
 ]);
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
 expect((await runtime.DB.prepare('SELECT COUNT(*) AS n FROM fb_discord_binding_admissions').first<{n:number}>())?.n).toBe(0);
 expect((await runtime.DB.prepare('SELECT COUNT(*) AS n FROM fb_discord_global_bindings').first<{n:number}>())?.n).toBe(1);
});

it('blocks identity reassignment and binding registry mutation',async()=>{
 const {a,insert}=await setup();await insert(a.id,'identity_a','person_a').run();
 await expect(runtime.DB.prepare("UPDATE fb_discord_identities SET user_id='person_b' WHERE id='identity_a'").run()).rejects.toThrow('discord_global_binding_immutable');
 await expect(runtime.DB.prepare("UPDATE fb_discord_global_bindings SET user_id='person_b'").run()).rejects.toThrow('discord_global_binding_immutable');
 await expect(runtime.DB.prepare('DELETE FROM fb_discord_global_bindings').run()).rejects.toThrow('discord_global_binding_retained');
});

it('rolls the registry insertion back when the original identity insert fails',async()=>{
 const {a,insert}=await setup();
 await runtime.DB.exec("CREATE TRIGGER fail_test_identity BEFORE INSERT ON fb_discord_identities BEGIN SELECT RAISE(ABORT,'fixture_failure'); END;");
 await expect(insert(a.id,'identity_a','person_a').run()).rejects.toThrow('fixture_failure');
 expect(await runtime.DB.prepare('SELECT discord_user_id FROM fb_discord_global_bindings').first()).toBeNull();
});

it('rolls back D1 schema statements when historical conflict preflight fails',async()=>{
 await runtime.DB.exec('CREATE TABLE migration_conflict_fixture (discord_user_id TEXT,user_id TEXT);');
 await runtime.DB.prepare("INSERT INTO migration_conflict_fixture VALUES ('discord','one'),('discord','two')").run();
 try {
  await expect(runtime.DB.batch([
   runtime.DB.prepare('CREATE INDEX migration_conflict_fixture_idx ON migration_conflict_fixture(discord_user_id,user_id)'),
   runtime.DB.prepare('CREATE TABLE migration_registry_fixture (discord_user_id TEXT PRIMARY KEY,user_id TEXT NOT NULL)'),
   runtime.DB.prepare("SELECT CASE WHEN EXISTS (SELECT discord_user_id FROM migration_conflict_fixture GROUP BY discord_user_id HAVING MIN(user_id)<>MAX(user_id)) THEN json('conflicting_discord_bindings') ELSE 1 END"),
  ])).rejects.toThrow();
  const objects=await runtime.DB.prepare("SELECT name FROM sqlite_master WHERE name IN ('migration_conflict_fixture_idx','migration_registry_fixture')").all();
  expect(objects.results).toEqual([]);
 } finally {await runtime.DB.exec('DROP TABLE migration_conflict_fixture;');}
});

it('onboards a first Discord player atomically and consumes the permit',async()=>{
 const a=await tenant('cabinet'),discord={id:'222222222222222222',username:'fixture'};
 const player=await ensureDiscordPlayer(runtime as unknown as DiscordEnv,a,discord);
 expect(player.created).toBe(true);
 expect((await runtime.DB.prepare('SELECT user_id FROM fb_discord_global_bindings WHERE discord_user_id=?').bind(discord.id).first<{user_id:string}>())?.user_id).toBe(player.user.id);
 expect((await runtime.DB.prepare('SELECT COUNT(*) AS n FROM fb_discord_binding_admissions').first<{n:number}>())?.n).toBe(0);
});

it('links an authenticated account through OAuth and consumes the permit',async()=>{
 const a=await tenant('cabinet'),now=new Date().toISOString(),discord={id:'222222222222222222',username:'fixture'};
 await runtime.DB.prepare("INSERT INTO fb_users (id,email,display_name,password_hash,created_at) VALUES ('oauth_user','real@fixture.invalid','Real','password',?)").bind(now).run();
 await runtime.DB.prepare("INSERT INTO fb_memberships (tenant_id,user_id,role,created_at,capabilities_json,status) VALUES (?,'oauth_user','player',?,'[]','active')").bind(a.id,now).run();
 const identity=await linkDiscordIdentity(runtime as unknown as DiscordEnv,a,{id:'oauth_user'} as CurrentUser,discord);
 expect(identity.user_id).toBe('oauth_user');
 expect((await runtime.DB.prepare('SELECT COUNT(*) AS n FROM fb_discord_binding_admissions').first<{n:number}>())?.n).toBe(0);
});

it('blocks the old first-user insert before it can leave an account or wallet',async()=>{
 const now=new Date().toISOString(),email='discord.222222222222222222@players.foilbury.invalid';
 await expect(runtime.DB.prepare("INSERT INTO fb_users (id,email,display_name,password_hash,platform_admin,created_at) VALUES ('legacy',?,'Legacy','discord_only$no_password',0,?)").bind(email,now).run()).rejects.toThrow('discord_global_binding_not_admitted');
 expect(await runtime.DB.prepare("SELECT id FROM fb_users WHERE id='legacy'").first()).toBeNull();
 expect(await runtime.DB.prepare("SELECT user_id FROM fb_wallets WHERE user_id='legacy'").first()).toBeNull();
});

it('blocks old setup of an already-existing reserved-email orphan before wallet credit',async()=>{
 const a=await tenant('cabinet'),now=new Date().toISOString(),discordId='222222222222222222',email=`discord.${discordId}@players.foilbury.invalid`;
 await runtime.DB.prepare("INSERT INTO fb_discord_binding_admissions VALUES (?,'legacy')").bind(discordId).run();
 await runtime.DB.prepare("INSERT INTO fb_users (id,email,display_name,password_hash,platform_admin,created_at) VALUES ('legacy',?,'Legacy','discord_only$no_password',0,?)").bind(email,now).run();
 await runtime.DB.prepare("INSERT INTO fb_memberships (tenant_id,user_id,role,created_at,capabilities_json,status) VALUES (?,'legacy','player',?,'[]','active')").bind(a.id,now).run();
 await runtime.DB.prepare('DELETE FROM fb_discord_binding_admissions WHERE discord_user_id=?').bind(discordId).run();
 await expect(runtime.DB.prepare("INSERT INTO fb_wallets (tenant_id,user_id,balance,updated_at) VALUES (?,'legacy',0,?) ON CONFLICT(tenant_id,user_id) DO NOTHING").bind(a.id,now).run()).rejects.toThrow('discord_global_binding_not_admitted');
 expect(await runtime.DB.prepare("SELECT user_id FROM fb_wallets WHERE user_id='legacy'").first()).toBeNull();
 expect(await runtime.DB.prepare("SELECT id FROM fb_ledger_entries WHERE user_id='legacy'").first()).toBeNull();
});

it('documents the old OAuth rollback limitation: its earlier ordinary wallet survives a rejected link',async()=>{
 const a=await tenant('cabinet'),now=new Date().toISOString();
 await runtime.DB.prepare("INSERT INTO fb_users (id,email,display_name,password_hash,created_at) VALUES ('legacy_oauth','real@fixture.invalid','Real','password',?)").bind(now).run();
 await runtime.DB.prepare("INSERT INTO fb_memberships (tenant_id,user_id,role,created_at,capabilities_json,status) VALUES (?,'legacy_oauth','player',?,'[]','active')").bind(a.id,now).run();
 // Old OAuth helper performs this separately, before the identity insert.
 await runtime.DB.prepare("INSERT INTO fb_wallets (tenant_id,user_id,balance,updated_at) VALUES (?,'legacy_oauth',0,?) ON CONFLICT(tenant_id,user_id) DO NOTHING").bind(a.id,now).run();
 await expect(runtime.DB.prepare("INSERT INTO fb_discord_identities (id,tenant_id,discord_user_id,user_id,username,linked_at,last_seen_at) VALUES ('legacy_oauth_link',?,'222222222222222222','legacy_oauth','fixture',?,?)").bind(a.id,now,now).run()).rejects.toThrow('discord_global_binding_not_admitted');
 expect((await runtime.DB.prepare("SELECT balance FROM fb_wallets WHERE tenant_id=? AND user_id='legacy_oauth'").bind(a.id).first<{balance:number}>())?.balance).toBe(0);
});

it('blocks the old wallet upsert even when an orphan wallet already exists',async()=>{
 const a=await tenant('cabinet'),now=new Date().toISOString(),discordId='222222222222222222',email=`discord.${discordId}@players.foilbury.invalid`;
 await runtime.DB.prepare("INSERT INTO fb_discord_binding_admissions VALUES (?,'legacy')").bind(discordId).run();
 await runtime.DB.prepare("INSERT INTO fb_users (id,email,display_name,password_hash,created_at) VALUES ('legacy',?,'Legacy','discord_only$no_password',?)").bind(email,now).run();
 await runtime.DB.prepare("INSERT INTO fb_wallets (tenant_id,user_id,balance,updated_at) VALUES (?,'legacy',0,?)").bind(a.id,now).run();
 await runtime.DB.prepare('DELETE FROM fb_discord_binding_admissions WHERE discord_user_id=?').bind(discordId).run();
 await expect(runtime.DB.prepare("INSERT INTO fb_wallets (tenant_id,user_id,balance,updated_at) VALUES (?,'legacy',0,?) ON CONFLICT(tenant_id,user_id) DO NOTHING").bind(a.id,now).run()).rejects.toThrow('discord_global_binding_not_admitted');
 expect((await runtime.DB.prepare("SELECT balance FROM fb_wallets WHERE tenant_id=? AND user_id='legacy'").bind(a.id).first<{balance:number}>())?.balance).toBe(0);
});
