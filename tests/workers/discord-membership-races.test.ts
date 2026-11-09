import { describe, expect, it } from "vitest";
import { bootstrap, ctxFor, runtime } from "./helpers";
import { buildDiscordContext, discordAdminHasCapabilities, ensureDiscordPlayer } from "../../src/server/discord/context";
import type { DiscordEnv } from "../../src/server/discord/types";
import { addMembership, createUser, ensureWallet } from "../../src/server/modules/identity";

function envWith(db: typeof runtime.DB): DiscordEnv {
  return new Proxy(runtime as unknown as DiscordEnv,{get(target,key){if(key==='DB') return db;return Reflect.get(target,key,target);}});
}
function injectBefore(db: typeof runtime.DB, needle:string, operation:'run'|'first', mutation:()=>Promise<unknown>) {
  let fired=false;
  return new Proxy(db,{get(target,key){
    if(key==='prepare') return (sql:string)=>{
      const stmt=target.prepare(sql);if(!sql.includes(needle)) return stmt;
      return new Proxy(stmt,{get(inner,method){
        if(method==='bind') return (...values:unknown[])=>{
          const bound=inner.bind(...values);
          return new Proxy(bound,{get(result,action){
            if(action===operation) return async()=>{if(!fired){fired=true;await mutation();}return result[operation]();};
            const v=Reflect.get(result,action,result);return typeof v==='function'?v.bind(result):v;
          }});
        };
        const v=Reflect.get(inner,method,inner);return typeof v==='function'?v.bind(inner):v;
      }});
    };
    const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v;
  }});
}

describe('Discord membership boundaries',()=>{
  it('binds the Discord principal to the actual guild or DM user, not the interaction ID', async()=>{
    await bootstrap();
    const player=await ctxFor('cabinet','player@foilbury.local');
    const base={id:'987654321098765432',application_id:'111111111111111111',type:2,token:'fixture',version:1};
    const guild=buildDiscordContext(envWith(runtime.DB),player.tenant,player.user!,{...base,member:{user:{id:'123456789012345678',username:'fixture'}}});
    expect(guild.discordPrincipal).toEqual({discordUserId:'123456789012345678'});
    expect(guild.clientKey).toBe('discord:123456789012345678');
    const dm=buildDiscordContext(envWith(runtime.DB),player.tenant,player.user!,{...base,user:{id:'234567890123456789',username:'fixture'}});
    expect(dm.discordPrincipal).toEqual({discordUserId:'234567890123456789'});
    expect(()=>buildDiscordContext(envWith(runtime.DB),player.tenant,player.user!,{...base,member:{user:{id:'invalid',username:'fixture'}}})).toThrow();
  });
  it('does not create the first identity after membership is revoked at insertion',async()=>{
    await bootstrap();
    const owner=await ctxFor('cabinet','owner@foilbury.local'), now=new Date().toISOString();
    const discord={id:'899111222333444555',username:'race-player'};
    const user=await createUser(runtime.DB,{email:`discord.${discord.id}@players.foilbury.invalid`,displayName:'Race',password:'a-long-test-password'});
    await addMembership(runtime.DB,owner.tenant.id,user.id,'player');
    await ensureWallet(runtime.DB,owner.tenant.id,user.id);
    await runtime.DB.prepare('UPDATE fb_economy_settings SET starter_grant=0 WHERE tenant_id=?').bind(owner.tenant.id).run();
    const db=injectBefore(runtime.DB,'INSERT INTO fb_discord_identities','run',()=>runtime.DB.prepare("UPDATE fb_memberships SET status='revoked',revoked_at=? WHERE tenant_id=? AND user_id=?").bind(now,owner.tenant.id,user.id).run());
    await expect(ensureDiscordPlayer(envWith(db),owner.tenant,discord)).rejects.toMatchObject({code:'membership_revoked'});
    expect((await runtime.DB.prepare('SELECT COUNT(*) n FROM fb_discord_identities WHERE tenant_id=? AND discord_user_id=?').bind(owner.tenant.id,discord.id).first<{n:number}>())?.n).toBe(0);
  });
  it('does not update an existing identity or return a context after revocation',async()=>{
    await bootstrap();
    const player=await ctxFor('cabinet','player@foilbury.local'), now=new Date().toISOString();
    const discord={id:'899111222333444556',username:'new-name'};
    await runtime.DB.prepare("INSERT INTO fb_discord_identities (id,tenant_id,discord_user_id,user_id,username,linked_at,last_seen_at) VALUES ('race_identity',?,?,?,'old-name',?,?)").bind(player.tenant.id,discord.id,player.user!.id,now,now).run();
    const db=injectBefore(runtime.DB,'UPDATE fb_discord_identities SET username','run',()=>runtime.DB.prepare("UPDATE fb_memberships SET status='revoked',revoked_at=? WHERE tenant_id=? AND user_id=?").bind(now,player.tenant.id,player.user!.id).run());
    await expect(ensureDiscordPlayer(envWith(db),player.tenant,discord)).rejects.toMatchObject({code:'membership_revoked'});
    expect((await runtime.DB.prepare("SELECT username FROM fb_discord_identities WHERE id='race_identity'").first<{username:string}>())?.username).toBe('old-name');
  });
  it('does not return former owner authority after transfer during identity refresh',async()=>{
    await bootstrap();
    const owner=await ctxFor('cabinet','owner@foilbury.local'), player=await ctxFor('cabinet','player@foilbury.local'), now=new Date().toISOString();
    const discord={id:'899111222333444557',username:'owner-name'};
    await runtime.DB.prepare("INSERT INTO fb_discord_identities (id,tenant_id,discord_user_id,user_id,username,linked_at,last_seen_at) VALUES ('owner_identity',?,?,?,?,?,?)").bind(owner.tenant.id,discord.id,owner.user!.id,'old-name',now,now).run();
    const db=injectBefore(runtime.DB,'SELECT m.role,m.capabilities_json','first',()=>runtime.DB.prepare('UPDATE fb_bots SET owner_user_id=? WHERE tenant_id=?').bind(player.user!.id,owner.tenant.id).run());
    await expect(ensureDiscordPlayer(envWith(db),owner.tenant,discord)).rejects.toMatchObject({code:'membership_revoked'});
  });
  it('returns current membership role and capabilities after an in-flight reduction',async()=>{
    await bootstrap();
    const player=await ctxFor('cabinet','player@foilbury.local'), now=new Date().toISOString();
    const discord={id:'899111222333444558',username:'editor-name'};
    await runtime.DB.prepare("UPDATE fb_memberships SET role='editor',capabilities_json='[\"content\",\"grants\"]' WHERE tenant_id=? AND user_id=?").bind(player.tenant.id,player.user!.id).run();
    await runtime.DB.prepare("INSERT INTO fb_discord_identities (id,tenant_id,discord_user_id,user_id,username,linked_at,last_seen_at) VALUES ('editor_identity',?,?,?,?,?,?)").bind(player.tenant.id,discord.id,player.user!.id,'old-name',now,now).run();
    const db=injectBefore(runtime.DB,'SELECT m.role,m.capabilities_json','first',()=>runtime.DB.prepare("UPDATE fb_memberships SET role='player',capabilities_json='[]' WHERE tenant_id=? AND user_id=?").bind(player.tenant.id,player.user!.id).run());
    expect((await ensureDiscordPlayer(envWith(db),player.tenant,discord)).user).toMatchObject({role:'player',capabilities:[],platformAdmin:false});
  });
  it('returns current delegated capabilities on first link and rejects malformed capabilities safely',async()=>{
    await bootstrap();
    const owner=await ctxFor('cabinet','owner@foilbury.local');
    const discord={id:'899111222333444559',username:'new-editor'};
    const user=await createUser(runtime.DB,{email:`discord.${discord.id}@players.foilbury.invalid`,displayName:'Editor',password:'a-long-test-password'});
    await addMembership(runtime.DB,owner.tenant.id,user.id,'editor',{capabilities:['content','grants']});
    await runtime.DB.prepare("UPDATE fb_memberships SET self_grants_enabled=1,grant_limit=120,capability_revision=3 WHERE tenant_id=? AND user_id=?").bind(owner.tenant.id,user.id).run();
    await ensureWallet(runtime.DB,owner.tenant.id,user.id);
    await runtime.DB.prepare('UPDATE fb_economy_settings SET starter_grant=0 WHERE tenant_id=?').bind(owner.tenant.id).run();
    const first=await ensureDiscordPlayer(envWith(runtime.DB),owner.tenant,discord);
    expect(first.user).toMatchObject({role:'editor',capabilities:['content','grants'],selfGrantsEnabled:true,grantLimit:120,capabilityRevision:3});
    await runtime.DB.prepare("UPDATE fb_memberships SET capabilities_json='not-json' WHERE tenant_id=? AND user_id=?").bind(owner.tenant.id,user.id).run();
    expect((await ensureDiscordPlayer(envWith(runtime.DB),owner.tenant,discord)).user.capabilities).toEqual([]);
  });
  it('does not retain platform authority when its explicit assignment was revoked',async()=>{
    await bootstrap();
    const owner=await ctxFor('cabinet','owner@foilbury.local'), now=new Date().toISOString();
    const discord={id:'899111222333444560',username:'owner-name'};
    await runtime.DB.prepare("INSERT INTO fb_discord_identities (id,tenant_id,discord_user_id,user_id,username,linked_at,last_seen_at) VALUES ('owner_platform_identity',?,?,?,?,?,?)").bind(owner.tenant.id,discord.id,owner.user!.id,'owner-name',now,now).run();
    await runtime.DB.prepare("UPDATE fb_platform_admins SET status='revoked',revoked_at=? WHERE user_id=?").bind(now,owner.user!.id).run();
    expect((await ensureDiscordPlayer(envWith(runtime.DB),owner.tenant,discord)).user).toMatchObject({role:'owner',platformAdmin:false});
  });
  it('separates live delegated content and economy capabilities and owner transfer',async()=>{
    await bootstrap();
    const owner=await ctxFor('cabinet','owner@foilbury.local'), player=await ctxFor('cabinet','player@foilbury.local'), now=new Date().toISOString();
    const bot=await runtime.DB.prepare('SELECT id FROM fb_bots WHERE tenant_id=?').bind(owner.tenant.id).first<{id:string}>();
    await runtime.DB.prepare("UPDATE fb_memberships SET role='editor',capabilities_json='[\"content\"]' WHERE tenant_id=? AND user_id=?").bind(player.tenant.id,player.user!.id).run();
    await runtime.DB.prepare("INSERT INTO fb_bot_admins (id,bot_id,user_id,role,capabilities_json,status,created_at) VALUES ('caps_admin',?,?,'admin','[\"content\"]','active',?)").bind(bot!.id,player.user!.id,now).run();
    expect(await discordAdminHasCapabilities(player,['content'])).toBe(true);
    expect(await discordAdminHasCapabilities(player,['economy'])).toBe(false);
    await runtime.DB.prepare("UPDATE fb_memberships SET capabilities_json='[\"economy\"]' WHERE tenant_id=? AND user_id=?").bind(player.tenant.id,player.user!.id).run();
    await runtime.DB.prepare("UPDATE fb_bot_admins SET capabilities_json='[\"economy\"]' WHERE id='caps_admin'").run();
    expect(await discordAdminHasCapabilities(player,['content'])).toBe(false);
    expect(await discordAdminHasCapabilities(player,['economy'])).toBe(true);
    await runtime.DB.prepare("UPDATE fb_bot_admins SET status='revoked',revoked_at=? WHERE id='caps_admin'").bind(now).run();
    expect(await discordAdminHasCapabilities(player,['economy'])).toBe(false);
    await runtime.DB.prepare('UPDATE fb_users SET platform_admin=0 WHERE id=?').bind(owner.user!.id).run();
    await runtime.DB.prepare('UPDATE fb_bots SET owner_user_id=? WHERE id=?').bind(player.user!.id,bot!.id).run();
    expect(await discordAdminHasCapabilities(owner,['content'])).toBe(false);
  });
});
