import { beforeEach, expect, it } from "vitest";
import { bootstrap, ctxFor, fixturePool, runtime, setBalance, walletBalance } from "./helpers";
import { getPoolPreview, executeDraw } from "../../src/server/modules/pools";
import { poolScopeFromDiscord, resolveDiscordScope } from "../../src/server/discord/scope";
import type { DiscordInstallation } from "../../src/server/discord/types";
import { ensureWallet } from "../../src/server/modules/identity";
import { liveViewerContext } from "../../src/server/modules/live-viewer";
import { readDrawScopeEpoch } from "../../src/server/modules/draw-scope-epoch";
import { getCard } from "../../src/server/modules/catalogue";
import { DRAW_TERMINAL_TRIGGER_DEFINITIONS } from "../../src/server/modules/draw-terminal-retention";

beforeEach(async () => { await bootstrap(); });

it('rebuilds cached owner and platform authority after revocation',async()=>{
  const {ctx}=await fixture('owner');
  expect(ctx.user!.platformAdmin).toBe(true);
  expect(ctx.user!.role).toBe('owner');
  await runtime.DB.prepare("UPDATE fb_platform_admins SET status='revoked',revoked_at='2026-01-01' WHERE user_id='usr_prod_owner'").run();
  await runtime.DB.prepare("UPDATE fb_memberships SET role='player' WHERE tenant_id=? AND user_id='usr_prod_owner'").bind(ctx.tenant.id).run();
  const live=await liveViewerContext(ctx,ctx.user!.id);
  expect(live?.user?.platformAdmin).toBe(false);
  expect(live?.user?.role).toBe('player');
  const installation=await runtime.DB.prepare("SELECT * FROM fb_discord_installations WHERE id='epoch_install'").first<DiscordInstallation>();
  const scope=await resolveDiscordScope(ctx,installation!,ctx.discordPrincipal.channelId);
  expect(scope.collectionIds).not.toContain('col_test_public');
});

it('does not let a cached human admin preview a private card after authority was revoked before capture',async()=>{
  const {ctx,scope}=await fixture('grant');
  const now=new Date().toISOString();
  await runtime.DB.prepare("INSERT INTO fb_collections (id,slug,name,description,scope,owner_tenant_id,accent,status,view_audience,created_by,created_at,updated_at) VALUES ('epoch_hidden','epoch-hidden','Private title','','global',?,'brass','published','private',?,?,?)").bind(ctx.tenant.id,ctx.user!.id,now,now).run();
  await runtime.DB.prepare("INSERT INTO fb_collection_cards (collection_id,card_id,tenant_id,sort,added_by,added_at) VALUES ('epoch_hidden','crd_test_card',?,0,?,?)").bind(ctx.tenant.id,ctx.user!.id,now).run();
  await runtime.DB.prepare("INSERT INTO fb_bot_collections (bot_id,collection_id,enabled,updated_at) SELECT id,'epoch_hidden',1,? FROM fb_bots WHERE tenant_id=?").bind(now,ctx.tenant.id).run();
  // The context was constructed before an authority change; the database now
  // says ordinary player and no platform assignment before the epoch is read.
  const stale={...ctx,user:{...ctx.user!,role:'owner' as const,platformAdmin:true}};
  const freshEpoch=await readDrawScopeEpoch(stale);
  const installation=await runtime.DB.prepare("SELECT * FROM fb_discord_installations WHERE id='epoch_install'").first<DiscordInstallation>();
  const resolved=await resolveDiscordScope(stale,installation!,ctx.discordPrincipal.channelId);
  expect(resolved.collectionIds).not.toContain('epoch_hidden');
  const preview=await getPoolPreview(stale,'test-pool',undefined,{scope:{...scope,collectionIds:['col_test_public','epoch_hidden'],drawEpoch:freshEpoch}});
  expect(preview.entries).toEqual([]);
  expect(JSON.stringify(preview)).not.toContain('Private title');
  expect(JSON.stringify(preview)).not.toContain('Test One');
});

it('rejects a stale installation channel key changed before epoch capture',async()=>{
  const {ctx}=await fixture();
  const stale=await runtime.DB.prepare("SELECT * FROM fb_discord_installations WHERE id='epoch_install'").first<DiscordInstallation>();
  await runtime.DB.prepare("UPDATE fb_discord_installations SET channel_key='new-policy' WHERE id='epoch_install'").run();
  const scope=await resolveDiscordScope(ctx,stale!,ctx.discordPrincipal.channelId);
  expect(scope.collectionIds).toEqual([]);
  expect(scope.emptyReason).toMatch(/access changed/i);
  expect((await runtime.DB.prepare("SELECT COUNT(*) AS n FROM fb_draws WHERE tenant_id=?").bind(ctx.tenant.id).first<{n:number}>())!.n).toBe(0);
});

it.each(['editor','economy_admin'])('does not admit a %s with a revoked Bot grant to a private collection',async(role)=>{
  const {ctx}=await fixture('grant');
  const now=new Date().toISOString();
  await runtime.DB.prepare("UPDATE fb_collections SET scope='bot',view_audience='private' WHERE id='col_test_public'").run();
  await runtime.DB.prepare("UPDATE fb_collection_viewers SET revoked_at=? WHERE collection_id='col_test_public' AND user_id=?").bind(now,ctx.user!.id).run();
  await runtime.DB.prepare("UPDATE fb_memberships SET role=? WHERE tenant_id=? AND user_id=?").bind(role,ctx.tenant.id,ctx.user!.id).run();
  await runtime.DB.prepare("INSERT INTO fb_bot_admins (id,bot_id,user_id,role,capabilities_json,status,created_at,revoked_at) SELECT 'revoked-content',id,?,'admin','[\"content\"]','revoked',?,? FROM fb_bots WHERE tenant_id=?").bind(ctx.user!.id,now,now,ctx.tenant.id).run();
  await runtime.DB.prepare("UPDATE fb_discord_installations SET channel_audience_json='{\"123456789012345678\":\"private\"}' WHERE id='epoch_install'").run();
  const installation=await runtime.DB.prepare("SELECT * FROM fb_discord_installations WHERE id='epoch_install'").first<DiscordInstallation>();
  const scope=await resolveDiscordScope(ctx,installation!,ctx.discordPrincipal.channelId);
  expect(scope.collectionIds).not.toContain('col_test_public');
  expect(scope.collections).toEqual([]);
  expect(JSON.stringify(scope.collections)).not.toContain('Test Public');
  await expect(getCard(ctx,'crd_test_card')).rejects.toMatchObject({code:'card_not_found'});
  await runtime.DB.prepare("UPDATE fb_collection_viewers SET revoked_at=NULL WHERE collection_id='col_test_public' AND user_id=?").bind(ctx.user!.id).run();
  expect((await getCard(ctx,'crd_test_card')).id).toBe('crd_test_card');
  await runtime.DB.prepare("UPDATE fb_collection_viewers SET revoked_at=? WHERE collection_id='col_test_public' AND user_id=?").bind(now,ctx.user!.id).run();
  await runtime.DB.prepare("UPDATE fb_bot_admins SET status='active',revoked_at=NULL WHERE id='revoked-content'").run();
  await runtime.DB.prepare("UPDATE fb_memberships SET capabilities_json='[\"content\"]' WHERE tenant_id=? AND user_id=?").bind(ctx.tenant.id,ctx.user!.id).run();
  expect((await getCard(ctx,'crd_test_card')).id).toBe('crd_test_card');
  await runtime.DB.prepare("UPDATE fb_memberships SET capabilities_json='[]' WHERE tenant_id=? AND user_id=?").bind(ctx.tenant.id,ctx.user!.id).run();
  await expect(getCard(ctx,'crd_test_card')).rejects.toMatchObject({code:'card_not_found'});
  await runtime.DB.prepare("UPDATE fb_memberships SET capabilities_json='[\"content\"]' WHERE tenant_id=? AND user_id=?").bind(ctx.tenant.id,ctx.user!.id).run();
  await runtime.DB.prepare("UPDATE fb_bot_admins SET capabilities_json='{\"content\":true}' WHERE id='revoked-content'").run();
  await expect(getCard(ctx,'crd_test_card')).rejects.toMatchObject({code:'card_not_found'});
  expect((await runtime.DB.prepare("SELECT COUNT(*) AS n FROM fb_draws WHERE tenant_id=?").bind(ctx.tenant.id).first<{n:number}>())!.n).toBe(0);
});

async function fixture(mode: "public" | "grant" | "owner" = "public") {
  let base = await ctxFor("cabinet", "owner@foilbury.local");
  await fixturePool(base);
  const now = new Date().toISOString();
  if (mode === "owner") {
    await runtime.DB.prepare("UPDATE fb_users SET platform_admin=0 WHERE platform_admin=1").run();
    await runtime.DB.prepare("INSERT INTO fb_users (id,email,display_name,password_hash,platform_admin,created_at) VALUES ('usr_prod_owner','epoch-owner@fixture.invalid','Owner','test',1,?)").bind(now).run();
    await runtime.DB.prepare("INSERT INTO fb_platform_admins (user_id,provisioned_by,provisioned_at,reason,status) VALUES ('usr_prod_owner','fixture',?,'test','active')").bind(now).run();
    await runtime.DB.prepare("INSERT INTO fb_memberships (tenant_id,user_id,role,status,created_at) VALUES (?,'usr_prod_owner','owner','active',?)").bind(base.tenant.id,now).run();
    await ensureWallet(runtime.DB,base.tenant.id,'usr_prod_owner');
    base = await ctxFor("cabinet", "epoch-owner@fixture.invalid");
  }
  if (mode === "grant") base = await ctxFor("cabinet", "player@foilbury.local");
  await setBalance(base, base.user!.id, 500);
  if (mode !== "public") await runtime.DB.prepare("UPDATE fb_collections SET view_audience='members',public_approved_at=NULL WHERE id='col_test_public'").run();
  if (mode === "grant") await runtime.DB.prepare("INSERT INTO fb_collection_viewers (collection_id,user_id,granted_by,created_at) VALUES ('col_test_public',?,?,?)").bind(base.user!.id,base.user!.id,now).run();
  const bot = await runtime.DB.prepare("SELECT id FROM fb_bots WHERE tenant_id=?").bind(base.tenant.id).first<{id:string}>();
  await runtime.DB.prepare("INSERT INTO fb_discord_installations (id,tenant_id,bot_id,application_id,guild_id,guild_name,channel_allowlist_json,game_enabled,active,created_at,updated_at) VALUES ('epoch_install',?,?,'123','456','Fixture','[]',1,1,?,?)").bind(base.tenant.id,bot!.id,now,now).run();
  if (mode !== "public") await runtime.DB.prepare("UPDATE fb_discord_installations SET channel_audience_json='{\"123456789012345678\":\"members\"}' WHERE id='epoch_install'").run();
  await runtime.DB.prepare("INSERT INTO fb_discord_identities (id,tenant_id,discord_user_id,user_id,linked_at,last_seen_at) VALUES ('epoch_identity',?,'789',?,?,?)").bind(base.tenant.id,base.user!.id,now,now).run();
  const installation = await runtime.DB.prepare("SELECT * FROM fb_discord_installations WHERE id='epoch_install'").first<DiscordInstallation>();
  const ctx = { ...base, discordPrincipal: { discordUserId:"789", guildId:"456", applicationId:"123", channelId:"123456789012345678" } };
  const scope = poolScopeFromDiscord(await resolveDiscordScope(ctx, installation!, "123456789012345678"));
  const preview = await getPoolPreview(ctx,"test-pool",undefined,{scope});
  return { ctx, scope, preview };
}

it.each([
  ["collection disable", "UPDATE fb_bot_collections SET enabled=0 WHERE collection_id='col_test_public'"],
  ["identity revoke", "UPDATE fb_discord_identities SET revoked_at='2026-01-01' WHERE id='epoch_identity'"],
  ["membership revoke", "UPDATE fb_memberships SET status='revoked' WHERE user_id=(SELECT user_id FROM fb_discord_identities WHERE id='epoch_identity')"],
  ["channel policy", "UPDATE fb_discord_installations SET channel_allowlist_json='[\"other\"]' WHERE id='epoch_install'"],
  ["pool weight", "UPDATE fb_pool_entries SET weight=weight+1 WHERE id='poe_test'"],
  ["card lifecycle", "UPDATE fb_card_definitions SET status='draft' WHERE id='crd_test_card'"],
  ["missing trigger", "DROP TRIGGER draw_epoch_fb_collection_cards_insert"],
])("rejects %s between preview and draw batch", async (_label, mutation) => {
  const {ctx,scope,preview} = await fixture();
  const before = await walletBalance(ctx,ctx.user!.id);
  let injected = false;
  const db = new Proxy(runtime.DB, {get(target,key) {
    if (key === 'batch') return async (statements:D1PreparedStatement[]) => {
      if (!injected) { injected = true; await target.prepare(mutation).run(); }
      return target.batch(statements);
    };
    const value=Reflect.get(target,key,target); return typeof value === 'function' ? value.bind(target) : value;
  }});
  await expect(executeDraw({...ctx,db},{pool:'test-pool',expectedRevision:preview.revision,expectedDistribution:preview.distribution_fingerprint,scope,idempotency:{key:`epoch-${_label}`,digest:`epoch-${_label}`}})).rejects.toMatchObject({code:'draw_scope_changed'});
  expect(injected).toBe(true);
  expect(await walletBalance(ctx,ctx.user!.id)).toBe(before);
  expect((await runtime.DB.prepare("SELECT COUNT(*) AS n FROM fb_draws WHERE tenant_id=?").bind(ctx.tenant.id).first<{n:number}>())!.n).toBe(0);
});

it("allows an unchanged authorized snapshot to commit once", async () => {
  const {ctx,scope,preview} = await fixture();
  const result = await executeDraw(ctx,{pool:'test-pool',expectedRevision:preview.revision,expectedDistribution:preview.distribution_fingerprint,scope,idempotency:{key:'epoch-success',digest:'epoch-success'}});
  expect(result.draw_id).toBeTruthy();
  const debit=await runtime.DB.prepare("SELECT amount FROM fb_ledger_entries WHERE reference_type='draw' AND reference_id=? AND kind='spend'").bind(result.draw_id).first<{amount:number}>();
  expect(Math.abs(debit!.amount)).toBe(preview.price);
  expect((await runtime.DB.prepare("SELECT COUNT(*) AS n FROM fb_draws WHERE tenant_id=?").bind(ctx.tenant.id).first<{n:number}>())!.n).toBe(1);
});

it.each([
  ["explicit grant", "grant", "UPDATE fb_collection_viewers SET revoked_at='2026-01-01' WHERE collection_id='col_test_public'"],
  ["owner assignment", "owner", "UPDATE fb_platform_admins SET status='revoked',revoked_at='2026-01-01' WHERE user_id='usr_prod_owner'"],
])("rejects %s revoked at commit", async (_label, mode, mutation) => {
  const {ctx,scope,preview} = await fixture(mode as "grant" | "owner");
  expect(scope.collectionIds).toContain('col_test_public');
  expect(preview.eligible_count).toBeGreaterThan(0);
  const before=await walletBalance(ctx,ctx.user!.id);
  let injected=false;
  const db=new Proxy(runtime.DB,{get(target,key){
    if(key==='batch') return async (statements:D1PreparedStatement[]) => {
      if(!injected){injected=true;await target.prepare(mutation).run();}
      return target.batch(statements);
    };
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
  await expect(executeDraw({...ctx,db},{pool:'test-pool',expectedRevision:preview.revision,expectedDistribution:preview.distribution_fingerprint,scope,idempotency:{key:`revoke-${mode}`,digest:`revoke-${mode}`}})).rejects.toMatchObject({code:'draw_scope_changed'});
  expect(injected).toBe(true);
  expect(await walletBalance(ctx,ctx.user!.id)).toBe(before);
  expect((await runtime.DB.prepare("SELECT COUNT(*) AS n FROM fb_draws WHERE tenant_id=?").bind(ctx.tenant.id).first<{n:number}>())!.n).toBe(0);
});

it("rejects a new draft collection link at commit", async () => {
  const {ctx,scope,preview}=await fixture();
  const now=new Date().toISOString();
  await runtime.DB.prepare("INSERT INTO fb_collections (id,slug,name,description,scope,owner_tenant_id,accent,status,view_audience,created_by,created_at,updated_at) VALUES ('epoch_draft','epoch-draft','Draft','','global',?,'brass','draft','members',?,?,?)").bind(ctx.tenant.id,ctx.user!.id,now,now).run();
  // Resolve again after creating the unrelated draft, then race only the link.
  const installation=await runtime.DB.prepare("SELECT * FROM fb_discord_installations WHERE id='epoch_install'").first<DiscordInstallation>();
  const currentScope=poolScopeFromDiscord(await resolveDiscordScope(ctx,installation!,"123456789012345678"));
  const currentPreview=await getPoolPreview(ctx,'test-pool',undefined,{scope:currentScope});
  expect(currentPreview.distribution_fingerprint).toBe(preview.distribution_fingerprint);
  const before=await walletBalance(ctx,ctx.user!.id);
  let injected=false;
  const db=new Proxy(runtime.DB,{get(target,key){
    if(key==='batch') return async (statements:D1PreparedStatement[]) => {
      if(!injected){injected=true;await target.prepare("INSERT INTO fb_collection_cards (collection_id,card_id,tenant_id,sort,added_by,added_at) VALUES ('epoch_draft','crd_test_card',?,0,?,?)").bind(ctx.tenant.id,ctx.user!.id,now).run();}
      return target.batch(statements);
    };
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
  await expect(executeDraw({...ctx,db},{pool:'test-pool',expectedRevision:currentPreview.revision,expectedDistribution:currentPreview.distribution_fingerprint,scope:currentScope,idempotency:{key:'draft-race',digest:'draft-race'}})).rejects.toMatchObject({code:'draw_scope_changed'});
  expect(injected).toBe(true);
  expect(await walletBalance(ctx,ctx.user!.id)).toBe(before);
});

it("denies historical receipt after explicit viewer grant is revoked", async () => {
  const {ctx,scope,preview}=await fixture('grant');
  const idempotency={key:'replay-revoked-grant',digest:'replay-revoked-grant'};
  const input={pool:'test-pool',expectedRevision:preview.revision,expectedDistribution:preview.distribution_fingerprint,scope,idempotency};
  await executeDraw(ctx,input);
  await runtime.DB.prepare("UPDATE fb_collection_viewers SET revoked_at='2026-01-01' WHERE collection_id='col_test_public'").run();
  const installation=await runtime.DB.prepare("SELECT * FROM fb_discord_installations WHERE id='epoch_install'").first<DiscordInstallation>();
  const currentScope=poolScopeFromDiscord(await resolveDiscordScope(ctx,installation!,"123456789012345678"));
  expect(currentScope.collectionIds).not.toContain('col_test_public');
  await expect(executeDraw(ctx,{...input,scope:currentScope})).rejects.toMatchObject({code:'draw_outcome_unavailable'});
});

it("does not transfer twice for concurrent identical requests", async () => {
  const {ctx,scope,preview}=await fixture();
  const input={pool:'test-pool',expectedRevision:preview.revision,expectedDistribution:preview.distribution_fingerprint,scope,idempotency:{key:'same-key-concurrent',digest:'same-key-concurrent'}};
  const results=await Promise.allSettled([executeDraw(ctx,input),executeDraw(ctx,input)]);
  const success=results.filter((result):result is PromiseFulfilledResult<Awaited<ReturnType<typeof executeDraw>>> => result.status==='fulfilled');
  const uncertain=results.filter((result):result is PromiseRejectedResult => result.status==='rejected');
  expect(success).toHaveLength(1);
  expect(uncertain).toHaveLength(1);
  expect(uncertain[0]!.reason).toMatchObject({code:'draw_outcome_unavailable'});
  expect((await runtime.DB.prepare("SELECT COUNT(*) AS n FROM fb_draws WHERE tenant_id=?").bind(ctx.tenant.id).first<{n:number}>())!.n).toBe(1);
  expect((await runtime.DB.prepare("SELECT COUNT(*) AS n FROM fb_ledger_entries WHERE reference_type='draw' AND reference_id=? AND kind='spend'").bind(success[0]!.value.draw_id).first<{n:number}>())!.n).toBe(1);
});

it("reports uncertainty when the same key commits before a later low-balance read", async () => {
  const {ctx,scope,preview}=await fixture();
  const input={pool:'test-pool',expectedRevision:preview.revision,expectedDistribution:preview.distribution_fingerprint,scope,idempotency:{key:'same-key-low-balance',digest:'same-key-low-balance'}};
  let injected=false;
  const db=new Proxy(runtime.DB,{get(target,key){
    if(key==='prepare') return (sql:string) => {
      const wrap=(statement:D1PreparedStatement):D1PreparedStatement => new Proxy(statement,{get(original,method){
        if(method==='bind') return (...args:unknown[]) => wrap(original.bind(...args));
        if(method==='first' && sql.includes('FROM fb_wallets w JOIN fb_economy_settings')) return async (...args:[]) => {
          if(!injected){injected=true;await executeDraw(ctx,input);await setBalance(ctx,ctx.user!.id,0);}
          return original.first(...args);
        };
        const value=Reflect.get(original,method,original);return typeof value==='function'?value.bind(original):value;
      }});
      return wrap(target.prepare(sql));
    };
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
  await expect(executeDraw({...ctx,db},input)).rejects.toMatchObject({code:'draw_outcome_unavailable'});
  expect(injected).toBe(true);
  expect((await runtime.DB.prepare("SELECT COUNT(*) AS n FROM fb_draws WHERE tenant_id=?").bind(ctx.tenant.id).first<{n:number}>())!.n).toBe(1);
});

it('records a same-key terminal insufficient-funds outcome once and cannot draw after funds arrive',async()=>{
  const {ctx,scope,preview}=await fixture();
  await setBalance(ctx,ctx.user!.id,0);
  const input={pool:'test-pool',expectedRevision:preview.revision,expectedDistribution:preview.distribution_fingerprint,scope,idempotency:{key:'terminal-low-funds',digest:'terminal-low-funds'}};
  const attempts=await Promise.allSettled([executeDraw(ctx,input),executeDraw(ctx,input)]);
  for(const result of attempts){expect(result.status).toBe('rejected');if(result.status==='rejected')expect(result.reason).toMatchObject({code:'draw_terminal_insufficient_funds'});}
  const marker=await runtime.DB.prepare("SELECT status,response_json FROM fb_idempotency_keys WHERE operation='draw.execute' AND idempotency_key=?").bind(input.idempotency.key).first<{status:string;response_json:string}>();
  expect(marker?.status).toBe('failed');
  expect(JSON.parse(marker!.response_json)).toEqual({kind:'draw_terminal_failure',version:2,code:'insufficient_funds',epoch:{global:scope.drawEpoch!.global,tenant:scope.drawEpoch!.tenant,user:scope.drawEpoch!.user}});
  await setBalance(ctx,ctx.user!.id,500);
  await expect(executeDraw(ctx,input)).rejects.toMatchObject({code:'draw_terminal_insufficient_funds'});
  expect((await runtime.DB.prepare("SELECT COUNT(*) AS n FROM fb_draws WHERE tenant_id=?").bind(ctx.tenant.id).first<{n:number}>())!.n).toBe(0);
});

it('does not write an experimental terminal marker in production mode',async()=>{
  const {ctx,scope,preview}=await fixture();await setBalance(ctx,ctx.user!.id,0);
  const production={...ctx,config:{...ctx.config,environment:'production' as const}};
  const input={pool:'test-pool',expectedRevision:preview.revision,expectedDistribution:preview.distribution_fingerprint,scope,idempotency:{key:'production-writer-held',digest:'production-writer-held'}};
  await expect(executeDraw(production,input)).rejects.toMatchObject({code:'draw_outcome_unavailable'});
  expect(await runtime.DB.prepare("SELECT status FROM fb_idempotency_keys WHERE idempotency_key=?").bind(input.idempotency.key).first()).toBeNull();
  expect((await runtime.DB.prepare("SELECT COUNT(*) AS n FROM fb_draws WHERE tenant_id=?").bind(ctx.tenant.id).first<{n:number}>())!.n).toBe(0);
});

it('does not interpret malformed terminal data or a conflicting digest as a definite outcome',async()=>{
  const {ctx,scope,preview}=await fixture();await setBalance(ctx,ctx.user!.id,0);
  const input={pool:'test-pool',expectedRevision:preview.revision,expectedDistribution:preview.distribution_fingerprint,scope,idempotency:{key:'terminal-malformed',digest:'original'}};
  await expect(executeDraw(ctx,input)).rejects.toMatchObject({code:'draw_terminal_insufficient_funds'});
  await expect(executeDraw(ctx,{...input,idempotency:{...input.idempotency,digest:'different'}})).rejects.toMatchObject({code:'idempotency_conflict'});
  const e=scope.drawEpoch!;
  const insertBad=async(key:string,payload:string)=>runtime.DB.prepare(`INSERT INTO fb_idempotency_keys
    (tenant_id,actor_type,actor_id,operation,idempotency_key,request_digest,status,response_json,created_at)
    VALUES (?,?,?,'draw.execute',?,'original','failed',?,?)`).bind(ctx.tenant.id,ctx.actor.type,ctx.actor.id,key,payload,new Date().toISOString()).run();
  const extra=JSON.stringify({kind:'draw_terminal_failure',version:2,code:'insufficient_funds',epoch:{global:e.global,tenant:e.tenant,user:e.user},unexpected:'private'});
  await insertBad('terminal-extra',extra);
  await expect(executeDraw(ctx,{...input,idempotency:{key:'terminal-extra',digest:'original'}})).rejects.toMatchObject({code:'draw_outcome_unavailable'});
  const duplicate=`{"kind":"draw_terminal_failure","version":2,"code":"insufficient_funds","code":"insufficient_funds","epoch":{"global":${e.global},"tenant":${e.tenant},"user":${e.user}}}`;
  await insertBad('terminal-duplicate',duplicate);
  await expect(executeDraw(ctx,{...input,idempotency:{key:'terminal-duplicate',digest:'original'}})).rejects.toMatchObject({code:'draw_outcome_unavailable'});
});

it('makes recorded failed draw keys immutable and fails closed if retention is absent',async()=>{
 const {ctx,scope,preview}=await fixture();await setBalance(ctx,ctx.user!.id,0);
 const input={pool:'test-pool',expectedRevision:preview.revision,expectedDistribution:preview.distribution_fingerprint,scope,idempotency:{key:'immutable-terminal',digest:'immutable-terminal'}};
 await expect(executeDraw(ctx,input)).rejects.toMatchObject({code:'draw_terminal_insufficient_funds'});
 await expect(runtime.DB.prepare("DELETE FROM fb_idempotency_keys WHERE idempotency_key=?").bind(input.idempotency.key).run()).rejects.toThrow('draw_terminal_immutable');
 await expect(runtime.DB.prepare("UPDATE fb_idempotency_keys SET status='completed' WHERE idempotency_key=?").bind(input.idempotency.key).run()).rejects.toThrow('draw_terminal_immutable');
 await runtime.DB.prepare('DROP TRIGGER draw_terminal_no_delete').run();
 await expect(executeDraw(ctx,input)).rejects.toMatchObject({code:'draw_outcome_unavailable'});
 const noMarker={...input,idempotency:{key:'missing-retention',digest:'missing-retention'}};
 await expect(executeDraw(ctx,noMarker)).rejects.toMatchObject({code:'draw_outcome_unavailable'});
 expect(await runtime.DB.prepare("SELECT status FROM fb_idempotency_keys WHERE idempotency_key=?").bind(noMarker.idempotency.key).first()).toBeNull();
});

it('does not report a deleted marker after a drop-delete-reinstall race between reads',async()=>{
 const {ctx,scope,preview}=await fixture();await setBalance(ctx,ctx.user!.id,0);
 const e=scope.drawEpoch!,input={pool:'test-pool',expectedRevision:preview.revision,expectedDistribution:preview.distribution_fingerprint,scope,idempotency:{key:'terminal-delete-race',digest:'terminal-delete-race'}};
 const marker=JSON.stringify({kind:'draw_terminal_failure',version:2,code:'insufficient_funds',epoch:{global:e.global,tenant:e.tenant,user:e.user}});
 await runtime.DB.prepare(`INSERT INTO fb_idempotency_keys (tenant_id,actor_type,actor_id,operation,idempotency_key,request_digest,status,response_json,created_at)
   VALUES (?,?,?,'draw.execute',?,?,'failed',?,?)`).bind(ctx.tenant.id,ctx.actor.type,ctx.actor.id,input.idempotency.key,input.idempotency.digest,marker,new Date().toISOString()).run();
 let injected=false;
 const db=new Proxy(runtime.DB,{get(target,key){
  if(key==='prepare')return(sql:string)=>{
   const wrap=(raw:D1PreparedStatement):D1PreparedStatement=>new Proxy(raw,{get(statement,method){
    if(method==='bind')return(...args:unknown[])=>wrap(statement.bind(...args));
    if(method==='first'&&sql.includes('SELECT EXISTS (SELECT 1 FROM fb_draw_scope_global_epoch'))return async(...args:[])=>{
      if(!injected){injected=true;await runtime.DB.prepare('DROP TRIGGER draw_terminal_no_delete').run();await runtime.DB.prepare("DELETE FROM fb_idempotency_keys WHERE idempotency_key=?").bind(input.idempotency.key).run();await runtime.DB.prepare(DRAW_TERMINAL_TRIGGER_DEFINITIONS[0][1]).run();}
      return statement.first(...args);
    };
    const value=Reflect.get(statement,method,statement);return typeof value==='function'?value.bind(statement):value;
   }});
   return wrap(target.prepare(sql));
  };
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
 }});
 await expect(executeDraw({...ctx,db},input)).rejects.toMatchObject({code:'draw_outcome_unavailable'});
 expect(injected).toBe(true);
});

it.each([
 ['identity',"UPDATE fb_discord_identities SET revoked_at='2026-01-01' WHERE id='epoch_identity'"],
 ['membership',"UPDATE fb_memberships SET status='revoked' WHERE user_id=(SELECT user_id FROM fb_discord_identities WHERE id='epoch_identity')"],
 ['installation',"UPDATE fb_discord_installations SET game_enabled=0 WHERE id='epoch_install'"],
 ['viewer grant',"UPDATE fb_collection_viewers SET revoked_at='2026-01-01' WHERE collection_id='col_test_public'"],
])('withholds terminal insufficient-funds outcome after %s revocation',async(_label,mutation)=>{
 const {ctx,scope,preview}=await fixture('grant');await setBalance(ctx,ctx.user!.id,0);
 const input={pool:'test-pool',expectedRevision:preview.revision,expectedDistribution:preview.distribution_fingerprint,scope,idempotency:{key:`terminal-${_label}`,digest:`terminal-${_label}`}};
 await expect(executeDraw(ctx,input)).rejects.toMatchObject({code:'draw_terminal_insufficient_funds'});
 await runtime.DB.prepare(mutation).run();
 await expect(executeDraw(ctx,input)).rejects.toMatchObject({code:'draw_outcome_unavailable'});
 const freshEpoch=await readDrawScopeEpoch(ctx);
 if(freshEpoch) await expect(executeDraw(ctx,{...input,scope:{...scope,drawEpoch:freshEpoch}})).rejects.toMatchObject({code:'draw_outcome_unavailable'});
});
