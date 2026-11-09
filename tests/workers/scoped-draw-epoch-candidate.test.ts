import { beforeEach, describe, expect, it } from "vitest";
import { executeDraw, getPoolPreview } from "../../src/server/modules/pools";
import { readDrawScopeEpoch, repairDrawEpochTriggers } from "../../src/server/modules/draw-scope-epoch";
import { bootstrap, ctxFor, fixturePool, runtime, walletBalance } from "./helpers";
import { createAgentGrant, markEmailVerified } from "../../src/server/modules/identity";
import { buildContext } from "../../src/server/context";
import { routeApi } from "../../src/server/api/router";
import { prepareDiscordDraw } from "../../src/server/discord/commands";
import { poolScopeFromDiscord, resolveDiscordScope } from "../../src/server/discord/scope";
import { sha256Hex } from "../../src/server/ids";
import type { DiscordInstallation, DiscordInteraction } from "../../src/server/discord/types";

async function scopedFixture() {
  const base = await ctxFor("cabinet", "owner@foilbury.local");
  await fixturePool(base);
  const now = new Date().toISOString();
  const bot = await runtime.DB.prepare("SELECT id FROM fb_bots WHERE tenant_id=?")
    .bind(base.tenant.id)
    .first<{ id: string }>();
  await runtime.DB.prepare(
    `INSERT INTO fb_discord_installations (id,tenant_id,bot_id,application_id,guild_id,guild_name,channel_allowlist_json,game_enabled,active,created_at,updated_at) VALUES ('epoch_install',?,?,'123','456','Fixture','[]',1,1,?,?)`,
  )
    .bind(base.tenant.id, bot!.id, now, now)
    .run();
  await runtime.DB.prepare(
    `INSERT INTO fb_sessions (id,token_hash,user_id,tenant_id,csrf_token,created_at,expires_at,last_seen_at,assurance,auth_time) VALUES ('epoch_session','epoch_hash',?,?,?,?,?,?,?,?)`,
  )
    .bind(
      base.user!.id,
      base.tenant.id,
      "fixture",
      now,
      new Date(Date.now() + 3600000).toISOString(),
      now,
      "mfa",
      now,
    )
    .run();
  const ctx = {
    ...base,
    sessionId: "epoch_session",
    sessionAssurance: "mfa" as const,
    sessionAuthTime: now,
  };
  const row = await runtime.DB.prepare(
    "SELECT bot_id,configuration_revision,channel_allowlist_json,collection_allowlist_json,channel_audience_json,channel_key FROM fb_discord_installations WHERE id='epoch_install'",
  ).first<{
    bot_id: string | null;
    configuration_revision: number;
    channel_allowlist_json: string;
    collection_allowlist_json: string | null;
    channel_audience_json: string | null;
    channel_key: string | null;
  }>();
  const installation = {
    id: "epoch_install",
    revision: row!.configuration_revision,
    botId: row!.bot_id,
    channelAllowlist: row!.channel_allowlist_json,
    collectionAllowlist: row!.collection_allowlist_json,
    channelAudience: row!.channel_audience_json,
    channelKey: row!.channel_key,
  };
  const scope = {
    collectionIds: ["col_test_public"],
    audience: "public" as const,
    digest: "fixture-scope",
    requireFiled: true,
    aiArtEnabled: true,
    drawEpoch: await readDrawScopeEpoch(ctx),
    drawInstallation: installation,
  };
  return { ctx, scope, installation };
}

describe("scoped-draw epoch fence", () => {
  beforeEach(async () => {
    await bootstrap();
  });
  it("rejects a missing required trigger immediately before the draw transaction", async () => {
    const { ctx, scope, installation } = await scopedFixture();
    const preview = await getPoolPreview(ctx, "test-pool", undefined, { scope });
    const balance = await walletBalance(ctx, ctx.user!.id);
    let injected = false;
    const db = new Proxy(runtime.DB, { get(target, key) {
      if (key === "batch") return async (...args: Parameters<typeof target.batch>) => {
        if (!injected) { injected = true; await target.prepare("DROP TRIGGER draw_epoch_fb_pool_entries_update").run(); }
        return target.batch(...args);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    }});
    await expect(executeDraw({ ...ctx, db }, {
      pool: "test-pool", expectedRevision: preview.revision, expectedDistribution: preview.distribution_fingerprint,
      scope, discordInstallation: installation, authorizedReplayOnly: true,
      idempotency: { key: "trigger-missing-at-commit", digest: "trigger-missing-at-commit" },
    })).rejects.toMatchObject({ code: "stale_distribution" });
    expect(injected).toBe(true);
    expect(await walletBalance(ctx, ctx.user!.id)).toBe(balance);
  });
  it("rejects a pre-repair preview after a dropped trigger missed a weight change", async () => {
    const { ctx, scope, installation } = await scopedFixture();
    const preview = await getPoolPreview(ctx, "test-pool", undefined, { scope });
    const balance = await walletBalance(ctx, ctx.user!.id);
    let injected = false;
    const db = new Proxy(runtime.DB, { get(target, key) {
      if (key === "batch") return async (...args: Parameters<typeof target.batch>) => {
        if (!injected) {
          injected = true;
          await target.prepare("DROP TRIGGER draw_epoch_fb_pool_entries_update").run();
          await target.prepare("UPDATE fb_pool_entries SET weight=weight+99 WHERE pool_id='pool_test_open'").run();
          await repairDrawEpochTriggers(target);
        }
        return target.batch(...args);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    }});
    await expect(executeDraw({ ...ctx, db }, {
      pool: "test-pool", expectedRevision: preview.revision, expectedDistribution: preview.distribution_fingerprint,
      scope, discordInstallation: installation, authorizedReplayOnly: true,
      idempotency: { key: "trigger-repaired-before-commit", digest: "trigger-repaired-before-commit" },
    })).rejects.toMatchObject({ code: "stale_distribution" });
    expect(injected).toBe(true);
    expect(await walletBalance(ctx, ctx.user!.id)).toBe(balance);
  });
  it("records D1 change metadata for an installation update with epoch triggers", async () => {
    await scopedFixture();
    const result = await runtime.DB.prepare("UPDATE fb_discord_installations SET configuration_revision=configuration_revision+1 WHERE id='epoch_install'").run();
    expect(result.meta.changes).toBe(3);
  });
  it("keeps SQL changes() scoped to the direct row and rolls epoch updates back on batch failure", async () => {
    const { ctx } = await scopedFixture();
    const before = await readDrawScopeEpoch(ctx);
    const results = await runtime.DB.batch([
      runtime.DB.prepare("UPDATE fb_discord_installations SET configuration_revision=configuration_revision+1 WHERE id='epoch_install'"),
      runtime.DB.prepare("SELECT changes() AS n"),
    ]);
    expect((results[1]?.results?.[0] as { n: number }).n).toBe(1);
    const after = await readDrawScopeEpoch(ctx);
    expect(after).not.toEqual(before);
    await expect(runtime.DB.batch([
      runtime.DB.prepare("UPDATE fb_discord_installations SET configuration_revision=configuration_revision+1 WHERE id='epoch_install'"),
      runtime.DB.prepare("SELECT json('deliberate_rollback')"),
    ])).rejects.toThrow();
    expect(await readDrawScopeEpoch(ctx)).toEqual(after);
    expect((await runtime.DB.prepare("SELECT configuration_revision FROM fb_discord_installations WHERE id='epoch_install'").first<{configuration_revision:number}>())?.configuration_revision).toBe(2);
  });
  it("isolates tenant-only mutations while shared catalogue changes invalidate both tenants", async () => {
    const { ctx } = await scopedFixture();
    const other = await ctxFor("harbour", "harbour.owner@foilbury.test");
    const before = await readDrawScopeEpoch(ctx), otherBefore = await readDrawScopeEpoch(other);
    await runtime.DB.prepare("UPDATE fb_bots SET ai_art_enabled=1 WHERE tenant_id=?").bind(other.tenant.id).run();
    expect(await readDrawScopeEpoch(ctx)).toEqual(before);
    const otherChanged = await readDrawScopeEpoch(other);
    expect(otherChanged?.tenant).toBeGreaterThan(otherBefore!.tenant);
    await runtime.DB.prepare("UPDATE fb_card_definitions SET name='Updated Test One' WHERE id='crd_test_card'").run();
    expect((await readDrawScopeEpoch(ctx))?.global).toBeGreaterThan(before!.global);
    expect((await readDrawScopeEpoch(other))?.global).toBeGreaterThan(otherChanged!.global);
  });
  it("ignores no-op and unrelated sign-in user updates while fencing disabled accounts", async () => {
    const { ctx } = await scopedFixture();
    const other = await ctxFor("harbour", "harbour.owner@foilbury.test");
    const before = await readDrawScopeEpoch(ctx);
    const otherBefore = await readDrawScopeEpoch(other);
    await markEmailVerified(runtime.DB, other.user!.id);
    expect(await readDrawScopeEpoch(ctx)).toEqual(before);
    await runtime.DB.prepare("UPDATE fb_users SET display_name=display_name,disabled_at=disabled_at WHERE id=?").bind(other.user!.id).run();
    expect(await readDrawScopeEpoch(ctx)).toEqual(before);
    await runtime.DB.prepare("UPDATE fb_users SET disabled_at=? WHERE id=?").bind(new Date().toISOString(), other.user!.id).run();
    const revoked = await readDrawScopeEpoch(other);
    expect(await readDrawScopeEpoch(ctx)).toEqual(before);
    expect(revoked?.user).toBeGreaterThan(otherBefore!.user);
    await runtime.DB.prepare("UPDATE fb_users SET disabled_at=NULL WHERE id=?").bind(other.user!.id).run();
    expect((await readDrawScopeEpoch(other))?.user).toBeGreaterThan(revoked!.user);
  });
  it("ignores irrelevant membership edits but advances on capability and revocation changes", async () => {
    const { ctx } = await scopedFixture();
    const before = await readDrawScopeEpoch(ctx);
    await runtime.DB.prepare("UPDATE fb_memberships SET created_at=created_at,role=role,revoked_at=revoked_at WHERE tenant_id=? AND user_id=?")
      .bind(ctx.tenant.id, ctx.user!.id).run();
    expect(await readDrawScopeEpoch(ctx)).toEqual(before);
    await runtime.DB.prepare("UPDATE fb_memberships SET capabilities_json='[]' WHERE tenant_id=? AND user_id=?")
      .bind(ctx.tenant.id, ctx.user!.id).run();
    const changed = await readDrawScopeEpoch(ctx);
    expect(changed?.user).toBeGreaterThan(before!.user);
    await runtime.DB.prepare("UPDATE fb_memberships SET revoked_at=? WHERE tenant_id=? AND user_id=?")
      .bind(new Date().toISOString(), ctx.tenant.id, ctx.user!.id).run();
    expect((await readDrawScopeEpoch(ctx))?.user).toBeGreaterThan(changed!.user);
  });
  it("isolates other users' Bot membership churn but fences this user's other-Bot revocation", async () => {
    const { ctx } = await scopedFixture();
    const other = await ctxFor("harbour", "harbour.owner@foilbury.test");
    const before = await readDrawScopeEpoch(ctx);
    for (let i = 0; i < 20; i++) {
      await runtime.DB.prepare("UPDATE fb_memberships SET status=? WHERE tenant_id=? AND user_id=?")
        .bind(i % 2 ? "active" : "revoked", other.tenant.id, other.user!.id).run();
    }
    expect(await readDrawScopeEpoch(ctx)).toEqual(before);
    await runtime.DB.prepare("INSERT INTO fb_memberships (tenant_id,user_id,role,created_at,status) VALUES (?,?,'player',?,'active')")
      .bind(other.tenant.id, ctx.user!.id, new Date().toISOString()).run();
    const added = await readDrawScopeEpoch(ctx);
    expect(added?.user).toBeGreaterThan(before!.user);
    await runtime.DB.prepare("UPDATE fb_memberships SET status='revoked' WHERE tenant_id=? AND user_id=?")
      .bind(other.tenant.id, ctx.user!.id).run();
    expect((await readDrawScopeEpoch(ctx))?.user).toBeGreaterThan(added!.user);
  });
  it("rejects a draw when the same user's other-Bot membership changes after preview", async () => {
    const { ctx, scope, installation } = await scopedFixture();
    const other = await ctxFor("harbour", "harbour.owner@foilbury.test");
    await runtime.DB.prepare("INSERT INTO fb_memberships (tenant_id,user_id,role,created_at,status) VALUES (?,?,'player',?,'active')")
      .bind(other.tenant.id, ctx.user!.id, new Date().toISOString()).run();
    scope.drawEpoch = await readDrawScopeEpoch(ctx);
    const preview = await getPoolPreview(ctx, "test-pool", undefined, { scope });
    const balance = await walletBalance(ctx, ctx.user!.id);
    let injected = false;
    const db = new Proxy(runtime.DB, { get(target, key) {
      if (key === "batch") return async (...args: Parameters<typeof target.batch>) => {
        if (!injected) {
          injected = true;
          await target.prepare("UPDATE fb_memberships SET status='revoked' WHERE tenant_id=? AND user_id=?").bind(other.tenant.id, ctx.user!.id).run();
        }
        return target.batch(...args);
      };
      const value=Reflect.get(target,key,target);
      return typeof value === "function" ? value.bind(target) : value;
    }});
    await expect(executeDraw({ ...ctx, db }, {
      pool:"test-pool", expectedRevision:preview.revision, expectedDistribution:preview.distribution_fingerprint,
      scope, discordInstallation:installation, authorizedReplayOnly:true,
      idempotency:{ key:"cross-bot-revocation", digest:"cross-bot-revocation" },
    })).rejects.toMatchObject({ code:"stale_distribution" });
    expect(injected).toBe(true);
    expect(await walletBalance(ctx,ctx.user!.id)).toBe(balance);
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_draws WHERE idempotency_key='cross-bot-revocation'").first<{n:number}>())?.n).toBe(0);
  });
  it.each(["archived", "owner transferred"])("rejects a mixed-card draw when the other Bot is %s after preview", async (change) => {
    const { ctx, scope, installation } = await scopedFixture();
    const other = await ctxFor("harbour", "harbour.owner@foilbury.test");
    const now = new Date().toISOString();
    await runtime.DB.prepare("UPDATE fb_users SET platform_admin=0 WHERE id=?").bind(ctx.user!.id).run();
    await runtime.DB.prepare("INSERT INTO fb_memberships (tenant_id,user_id,role,created_at,status,capabilities_json) VALUES (?,?,'owner',?,'active','[]')")
      .bind(other.tenant.id,ctx.user!.id,now).run();
    await runtime.DB.prepare("UPDATE fb_bots SET owner_user_id=? WHERE tenant_id=?").bind(ctx.user!.id,other.tenant.id).run();
    await runtime.DB.prepare("INSERT INTO fb_collections (id,slug,name,description,scope,owner_tenant_id,accent,status,view_audience,created_by,created_at,updated_at) VALUES ('foreign_private','foreign-private','Foreign private','fixture','bot',?,'brass','published','private',?,?,?)")
      .bind(other.tenant.id,ctx.user!.id,now,now).run();
    await runtime.DB.prepare("INSERT INTO fb_collection_cards (collection_id,card_id,tenant_id,sort,added_by,added_at) VALUES ('foreign_private','crd_test_card',?,0,?,?)")
      .bind(other.tenant.id,ctx.user!.id,now).run();
    scope.drawEpoch=await readDrawScopeEpoch(ctx);
    const preview=await getPoolPreview(ctx,"test-pool",undefined,{scope});
    expect(preview.eligible_count).toBe(1);
    const balance=await walletBalance(ctx,ctx.user!.id);
    let injected=false;
    const db=new Proxy(runtime.DB,{get(target,key){
      if(key==='batch') return async(...args:Parameters<typeof target.batch>)=>{
        if(!injected){injected=true;
          if(change==='archived') await target.prepare("UPDATE fb_bots SET status='archived' WHERE tenant_id=?").bind(other.tenant.id).run();
          else await target.prepare("UPDATE fb_bots SET owner_user_id=? WHERE tenant_id=?").bind(other.user!.id,other.tenant.id).run();
        }
        return target.batch(...args);
      };
      const value=Reflect.get(target,key,target); return typeof value==='function'?value.bind(target):value;
    }});
    await expect(executeDraw({...ctx,db},{pool:'test-pool',expectedRevision:preview.revision,expectedDistribution:preview.distribution_fingerprint,scope,discordInstallation:installation,authorizedReplayOnly:true,idempotency:{key:'foreign-bot-race',digest:'foreign-bot-race'}})).rejects.toMatchObject({code:'stale_distribution'});
    expect(injected).toBe(true);
    expect(await walletBalance(ctx,ctx.user!.id)).toBe(balance);
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_draws WHERE idempotency_key='foreign-bot-race'").first<{n:number}>())?.n).toBe(0);
    const refreshed = { ...scope, drawEpoch: await readDrawScopeEpoch(ctx) };
    expect((await getPoolPreview(ctx, "test-pool", undefined, { scope: refreshed })).eligible_count).toBe(0);
  });
  it("advances on actual viewer and delegated administrator changes, not metadata no-ops", async () => {
    const { ctx } = await scopedFixture();
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const now = new Date().toISOString();
    const bot = await runtime.DB.prepare("SELECT id FROM fb_bots WHERE tenant_id=?").bind(ctx.tenant.id).first<{id:string}>();
    await runtime.DB.prepare("INSERT INTO fb_collection_viewers (collection_id,user_id,granted_by,created_at) VALUES ('col_test_public',?,?,?)").bind(ctx.user!.id,ctx.user!.id,now).run();
    await runtime.DB.prepare("INSERT INTO fb_bot_admins (id,bot_id,user_id,role,capabilities_json,status,created_at) VALUES ('epoch_admin',?,?,'admin','[\"content\"]','active',?)").bind(bot!.id,player.user!.id,now).run();
    await runtime.DB.prepare("INSERT INTO fb_platform_role_assignments (id,user_id,role,scopes_json,status,granted_by,granted_at,reason) VALUES ('epoch_role',?,'global_collection_admin','{\"all\":true}','active',?,?,'fixture')").bind(ctx.user!.id,ctx.user!.id,now).run();
    for (const [noop, change, viewer] of [
      ["UPDATE fb_collection_viewers SET granted_by=granted_by WHERE collection_id='col_test_public'", "UPDATE fb_collection_viewers SET revoked_at='2026-01-01' WHERE collection_id='col_test_public'", ctx],
      ["UPDATE fb_bot_admins SET created_at=created_at WHERE id='epoch_admin'", "UPDATE fb_bot_admins SET capabilities_json='[]' WHERE id='epoch_admin'", player],
      ["UPDATE fb_platform_role_assignments SET reason=reason WHERE id='epoch_role'", "UPDATE fb_platform_role_assignments SET status='revoked' WHERE id='epoch_role'", ctx],
      ["UPDATE fb_platform_admins SET reason=reason WHERE user_id=?", "UPDATE fb_platform_admins SET revoked_at='2026-01-01' WHERE user_id=?", ctx],
    ] as const) {
      const before=await readDrawScopeEpoch(viewer);
      const noOpStatement=runtime.DB.prepare(noop!);
      await (noop!.includes("?") ? noOpStatement.bind(ctx.user!.id) : noOpStatement).run();
      expect(await readDrawScopeEpoch(viewer)).toEqual(before);
      const changeStatement=runtime.DB.prepare(change!);
      await (change!.includes("?") ? changeStatement.bind(ctx.user!.id) : changeStatement).run();
      expect((await readDrawScopeEpoch(viewer))?.user).toBeGreaterThan(before!.user);
    }
  });
  const mutations: Array<[string, string]> = [
    ["pool weight", "UPDATE fb_pool_entries SET weight=weight+1 WHERE pool_id='pool_test_open'"],
    ["pool entry enabled", "UPDATE fb_pool_entries SET enabled=0 WHERE pool_id='pool_test_open'"],
    [
      "Bot collection enabled",
      "UPDATE fb_bot_collections SET enabled=0 WHERE collection_id='col_test_public'",
    ],
    [
      "card audience",
      "UPDATE fb_collections SET view_audience='private' WHERE id='col_test_public'",
    ],
    ["pool price", "UPDATE fb_pools SET price=price+1 WHERE id='pool_test_open'"],
    ["art lineage", "UPDATE fb_assets SET origin='ai_assisted' WHERE id='ast_test_subject'"],
    ["card publication", "UPDATE fb_card_definitions SET status='draft' WHERE id='crd_test_card'"],
    [
      "member authority",
      "UPDATE fb_memberships SET status='revoked' WHERE tenant_id=(SELECT id FROM fb_tenants WHERE slug='cabinet') AND role='owner'",
    ],
    ["session authority", "UPDATE fb_sessions SET revoked_at=datetime('now') WHERE id='epoch_session'"],
  ];
  it.each(mutations)("rejects %s changed after preview, before debit", async (_label, sql) => {
    const { ctx, scope, installation } = await scopedFixture();
    expect(scope.drawEpoch).not.toBeNull();
    const preview = await getPoolPreview(ctx, "test-pool", undefined, { scope });
    const balance = await walletBalance(ctx, ctx.user!.id);
    let injected = false;
    const db = new Proxy(runtime.DB, {
      get(target, key) {
        if (key === "batch")
          return async (...args: Parameters<typeof target.batch>) => {
            if (!injected) {
              injected = true;
              await target.prepare(sql).run();
            }
            return target.batch(...args);
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(
      executeDraw(
        { ...ctx, db },
        {
          pool: "test-pool",
          expectedRevision: preview.revision,
          expectedDistribution: preview.distribution_fingerprint,
          scope,
          discordInstallation: installation,
          authorizedReplayOnly: true,
          idempotency: { key: "epoch-race", digest: "epoch-race" },
        },
      ),
    ).rejects.toMatchObject({
      code: _label.endsWith("authority") ? "draw_authority_changed" : "stale_distribution",
    });
    expect(injected).toBe(true);
    expect(await walletBalance(ctx, ctx.user!.id)).toBe(balance);
    expect(
      (
        await runtime.DB.prepare(
          "SELECT COUNT(*) n FROM fb_draws WHERE idempotency_key='epoch-race'",
        ).first<{ n: number }>()
      )?.n,
    ).toBe(0);
  });
  it.each(["revoked", "relinked"])("rejects a Discord identity %s after preview without debit", async (change) => {
    const { ctx, scope, installation } = await scopedFixture();
    const now = new Date().toISOString();
    await runtime.DB.prepare("INSERT INTO fb_discord_identities (id,tenant_id,discord_user_id,user_id,username,linked_at,last_seen_at) VALUES ('epoch_identity',?, '123456789012345678', ?, 'fixture', ?, ?)")
      .bind(ctx.tenant.id, ctx.user!.id, now, now).run();
    const discordCtx = { ...ctx, sessionId: null, discordPrincipal: { discordUserId: "123456789012345678" } };
    const preview = await getPoolPreview(discordCtx, "test-pool", undefined, { scope });
    const balance = await walletBalance(ctx, ctx.user!.id);
    let injected = false;
    const db = new Proxy(runtime.DB, {
      get(target, key) {
        if (key === "batch") return async (...args: Parameters<typeof target.batch>) => {
          if (!injected) {
            injected = true;
            if (change === "revoked") await target.prepare("UPDATE fb_discord_identities SET revoked_at=? WHERE id='epoch_identity'").bind(now).run();
            else await target.prepare("UPDATE fb_discord_identities SET user_id=(SELECT id FROM fb_users WHERE email='player@foilbury.local') WHERE id='epoch_identity'").run();
          }
          return target.batch(...args);
        };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(executeDraw({ ...discordCtx, db }, {
      pool: "test-pool", expectedRevision: preview.revision, expectedDistribution: preview.distribution_fingerprint,
      scope, discordInstallation: installation, authorizedReplayOnly: true,
      idempotency: { key: "discord-identity-race", digest: "discord-identity-race" },
    })).rejects.toMatchObject({ code: "draw_authority_changed" });
    expect(injected).toBe(true);
    expect(await walletBalance(ctx, ctx.user!.id)).toBe(balance);
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_draws WHERE idempotency_key='discord-identity-race'").first<{n:number}>())?.n).toBe(0);
  });
  it("rejects a Discord identity revoked before epoch capture", async () => {
    const { ctx, scope } = await scopedFixture();
    const now = new Date().toISOString();
    await runtime.DB.prepare("INSERT INTO fb_discord_identities (id,tenant_id,discord_user_id,user_id,username,linked_at,last_seen_at,revoked_at) VALUES ('pre_revoked_identity',?,'123456789012345678',?,'fixture',?,?,?)")
      .bind(ctx.tenant.id, ctx.user!.id, now, now, now).run();
    const discordCtx = { ...ctx, sessionId: null, discordPrincipal: { discordUserId: "123456789012345678" } };
    const freshScope = { ...scope, drawEpoch: await readDrawScopeEpoch(discordCtx) };
    await expect(getPoolPreview(discordCtx, "test-pool", undefined, { scope: freshScope })).rejects.toMatchObject({ code: "draw_authority_changed" });
  });
  it.each(["revoked", "scope changed"])("rejects an agent grant %s after preview without debit", async (change) => {
    const { ctx, scope, installation } = await scopedFixture();
    const grant = await createAgentGrant(ctx, { agentName: "epoch-agent", representedUserId: ctx.user!.id, scopes: ["draw:execute", "inventory:read"], expiresInDays: 1 });
    const agent = await buildContext(new Request("https://foilbury.test/api/v1/draws", { headers: { authorization: `Bearer ${grant.token}` } }));
    const preview = await getPoolPreview(agent, "test-pool", undefined, { scope });
    const balance = await walletBalance(ctx, ctx.user!.id);
    let injected = false;
    const db = new Proxy(runtime.DB, { get(target, key) {
      if (key === "batch") return async (...args: Parameters<typeof target.batch>) => {
        if (!injected) {
          injected = true;
          if (change === "revoked") await target.prepare("UPDATE fb_agent_grants SET status='revoked' WHERE id=?").bind(grant.grantId).run();
          else await target.prepare("UPDATE fb_agent_grants SET scopes_json='[\"draw:execute\"]' WHERE id=?").bind(grant.grantId).run();
        }
        return target.batch(...args);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    }});
    await expect(executeDraw({ ...agent, db }, {
      pool: "test-pool", expectedRevision: preview.revision, expectedDistribution: preview.distribution_fingerprint,
      scope, discordInstallation: installation, authorizedReplayOnly: true,
      idempotency: { key: "epoch-agent-race", digest: "epoch-agent-race" },
    })).rejects.toMatchObject({ code: "draw_authority_changed" });
    expect(injected).toBe(true);
    expect(await walletBalance(ctx, ctx.user!.id)).toBe(balance);
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_draws WHERE idempotency_key='epoch-agent-race'").first<{ n: number }>())?.n).toBe(0);
  });
  it("rejects a stale agent context whose grant changed before epoch capture", async () => {
    const { ctx, scope } = await scopedFixture();
    const grant = await createAgentGrant(ctx, { agentName: "stale-epoch-agent", representedUserId: ctx.user!.id, scopes: ["draw:execute", "inventory:read"], expiresInDays: 1 });
    const agent = await buildContext(new Request("https://foilbury.test/api/v1/draws", { headers: { authorization: `Bearer ${grant.token}` } }));
    await runtime.DB.prepare("UPDATE fb_agent_grants SET scopes_json='[\"draw:execute\"]' WHERE id=?").bind(grant.grantId).run();
    const freshScope = { ...scope, drawEpoch: await readDrawScopeEpoch(agent) };
    await expect(getPoolPreview(agent, "test-pool", undefined, { scope: freshScope })).rejects.toMatchObject({ code: "draw_authority_changed" });
  });
  it("allows a stable scoped draw and returns its same-key receipt exactly once", async () => {
    const { ctx, scope, installation } = await scopedFixture();
    const preview = await getPoolPreview(ctx, "test-pool", undefined, { scope });
    const input = {
      pool: "test-pool",
      expectedRevision: preview.revision,
      expectedDistribution: preview.distribution_fingerprint,
      scope,
      discordInstallation: installation,
      authorizedReplayOnly: true,
      idempotency: { key: "epoch-stable", digest: "epoch-stable" },
    };
    const first = await executeDraw(ctx, input);
    const after = await walletBalance(ctx, ctx.user!.id);
    const replay = await executeDraw(ctx, input);
    expect(replay).toMatchObject({ draw_id: first.draw_id, replayed: true });
    expect(await walletBalance(ctx, ctx.user!.id)).toBe(after);
    expect(
      (
        await runtime.DB.prepare(
          "SELECT COUNT(*) n FROM fb_ledger_entries WHERE reference_type='draw' AND reference_id=? AND amount=?",
        )
          .bind(first.draw_id, -preview.price)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
    expect(
      (
        await runtime.DB.prepare(
          "SELECT COUNT(*) n FROM fb_draws WHERE idempotency_key='epoch-stable'",
        ).first<{ n: number }>()
      )?.n,
    ).toBe(1);
  });
  it("recovers a same-key draw committed after the first replay lookup but before an early 503", async () => {
    const { ctx, scope, installation } = await scopedFixture();
    const preview = await getPoolPreview(ctx, "test-pool", undefined, { scope });
    const idempotency = { key: "early-replay-race", digest: "early-replay-race" };
    let injected = false;
    const db = new Proxy(runtime.DB, { get(target, key) {
      if (key === "prepare") return (sql: string) => {
        const statement = target.prepare(sql);
        if (!sql.includes("FROM fb_idempotency_keys k JOIN fb_draws")) return statement;
        return new Proxy(statement, { get(s, prop) {
          if (prop === "bind") return (...args: unknown[]) => {
            const bound = s.bind(...args);
            return new Proxy(bound, { get(b, method) {
              if (method === "first") return async (...args: unknown[]) => {
                const value = await b.first(...args);
                if (!injected) {
                  injected = true;
                  await executeDraw(ctx, { pool:"test-pool", expectedRevision:preview.revision,
                    expectedDistribution:preview.distribution_fingerprint, scope, discordInstallation:installation,
                    authorizedReplayOnly:true, idempotency });
                }
                return value;
              };
              const value=Reflect.get(b,method,b); return typeof value === "function" ? value.bind(b) : value;
            }});
          };
          const value=Reflect.get(s,prop,s); return typeof value === "function" ? value.bind(s) : value;
        }});
      };
      const value=Reflect.get(target,key,target); return typeof value === "function" ? value.bind(target) : value;
    }});
    const replay = await executeDraw({ ...ctx, db }, { pool:"test-pool", expectedRevision:preview.revision,
      expectedDistribution:preview.distribution_fingerprint, authorizedReplayOnly:true, idempotency });
    expect(injected).toBe(true);
    expect(replay.replayed).toBe(true);
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_draws WHERE idempotency_key='early-replay-race'").first<{n:number}>())?.n).toBe(1);
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_ledger_entries WHERE reference_type='draw' AND reference_id=? AND amount=?").bind(replay.draw_id,-preview.price).first<{n:number}>())?.n).toBe(1);
  });
  it.each(["stale preview", "insufficient funds"])("recovers a same-key peer before reporting %s", async (failure) => {
    const { ctx, scope, installation }=await scopedFixture();
    const preview=await getPoolPreview(ctx,"test-pool",undefined,{scope});
    const idempotency={key:`prebatch-${failure}`,digest:`prebatch-${failure}`};
    const valid={pool:"test-pool",expectedRevision:preview.revision,expectedDistribution:preview.distribution_fingerprint,
      scope,discordInstallation:installation,authorizedReplayOnly:true,idempotency};
    let injected=false;
    const db=new Proxy(runtime.DB,{get(target,key){
      if(key==='prepare') return (sql:string)=>{
        const statement=target.prepare(sql);
        const matches=failure==='stale preview'?sql.startsWith('SELECT * FROM fb_pools WHERE'):sql.includes('SELECT w.balance, e.currency_name');
        if(!matches) return statement;
        return new Proxy(statement,{get(s,prop){
          if(prop==='bind') return (...args:unknown[])=>{
            const bound=s.bind(...args);
            return new Proxy(bound,{get(b,method){
              if(method==='first') return async (...args:unknown[])=>{
                if(!injected){
                  injected=true;
                  await executeDraw(ctx,valid);
                  if(failure==='insufficient funds') await target.prepare("UPDATE fb_wallets SET balance=0 WHERE tenant_id=? AND user_id=?").bind(ctx.tenant.id,ctx.user!.id).run();
                }
                return b.first(...args);
              };
              const value=Reflect.get(b,method,b); return typeof value==='function'?value.bind(b):value;
            }});
          };
          const value=Reflect.get(s,prop,s); return typeof value==='function'?value.bind(s):value;
        }});
      };
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    const replay=await executeDraw({...ctx,db},{...valid,expectedRevision:failure==='stale preview'?preview.revision+1:preview.revision});
    expect(injected).toBe(true);
    expect(replay.replayed).toBe(true);
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_draws WHERE idempotency_key=?").bind(idempotency.key).first<{n:number}>())?.n).toBe(1);
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_ledger_entries WHERE reference_type='draw' AND reference_id=? AND amount=?").bind(replay.draw_id,-preview.price).first<{n:number}>())?.n).toBe(1);
  });
  it.each(["stale preview", "insufficient funds"])("reports an uncertain outcome when %s has no observable receipt", async (failure) => {
    const {ctx,scope,installation}=await scopedFixture();
    const preview=await getPoolPreview(ctx,"test-pool",undefined,{scope});
    if(failure==='insufficient funds') await runtime.DB.prepare("UPDATE fb_wallets SET balance=0 WHERE tenant_id=? AND user_id=?").bind(ctx.tenant.id,ctx.user!.id).run();
    await expect(executeDraw(ctx,{pool:"test-pool",expectedRevision:failure==='stale preview'?preview.revision+1:preview.revision,
      expectedDistribution:preview.distribution_fingerprint,scope,discordInstallation:installation,authorizedReplayOnly:true,
      idempotency:{key:`uncertain-${failure}`,digest:`uncertain-${failure}`}})).rejects.toMatchObject({
        code:failure==='stale preview'?'stale_pool_revision':'insufficient_funds',
        message:expect.stringContaining("outcome could not be confirmed"), details:{draw_outcome_uncertain:true},
      });
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_draws WHERE idempotency_key=?").bind(`uncertain-${failure}`).first<{n:number}>())?.n).toBe(0);
  });
  it.each(["disabled", "malformed"])("recovers the correct API receipt when the installation becomes %s after an initial empty lookup", async (change) => {
    const {ctx}=await scopedFixture();
    const get=await routeApi(new Request("https://foilbury.test/api/v1/pools/test-pool?installation=epoch_install"),ctx,"pools/test-pool");
    const preview=await get.json() as {revision:number;distribution_fingerprint:string};
    const body=JSON.stringify({pool:"test-pool",expectedRevision:preview.revision,expectedDistribution:preview.distribution_fingerprint,installationId:"epoch_install"});
    const request=()=>new Request("https://foilbury.test/api/v1/draws",{method:"POST",headers:{"content-type":"application/json","x-foilbury-csrf":"test","idempotency-key":"api-scope-race"},body});
    let injected=false;
    const db=new Proxy(runtime.DB,{get(target,key){
      if(key==='prepare') return (sql:string)=>{
        const statement=target.prepare(sql);
        if(!sql.includes('SELECT * FROM fb_discord_installations')) return statement;
        return new Proxy(statement,{get(s,prop){
          if(prop==='bind') return (...args:unknown[])=>{
            const bound=s.bind(...args);
            return new Proxy(bound,{get(b,method){
              if(method==='first') return async (...args:unknown[])=>{
                if(!injected){injected=true; await routeApi(request(),ctx,"draws");
                  await target.prepare(change==='disabled' ? "UPDATE fb_discord_installations SET game_enabled=0 WHERE id='epoch_install'" : "UPDATE fb_discord_installations SET channel_allowlist_json='{}' WHERE id='epoch_install'").run();}
                return b.first(...args);
              };
              const value=Reflect.get(b,method,b);return typeof value==='function'?value.bind(b):value;
            }});
          };
          const value=Reflect.get(s,prop,s);return typeof value==='function'?value.bind(s):value;
        }});
      }
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    const response=await routeApi(request(),{...ctx,db},"draws");
    const replay=await response.json() as {draw_id:string;replayed:boolean};
    expect(injected).toBe(true);
    expect(replay.replayed).toBe(true);
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_draws WHERE idempotency_key='api-scope-race'").first<{n:number}>())?.n).toBe(1);
    const other=await ctxFor("cabinet","player@foilbury.local");
    const now=new Date().toISOString();
    await runtime.DB.prepare("INSERT INTO fb_sessions (id,token_hash,user_id,tenant_id,csrf_token,created_at,expires_at,last_seen_at,assurance,auth_time) VALUES ('race_other_session','race_other_hash',?,?,'test',?,?,?,'mfa',?)")
      .bind(other.user!.id,other.tenant.id,now,new Date(Date.now()+3600000).toISOString(),now,now).run();
    const otherCtx={...other,sessionId:'race_other_session',sessionAssurance:'mfa' as const,sessionAuthTime:now};
    await expect(routeApi(request(),otherCtx,"draws")).rejects.toMatchObject({code:change==='disabled'?'discord_game_disabled':'discord_channel_not_enabled',details:{draw_outcome_uncertain:true}});
  });
  it("recovers a Discord peer when scope is disabled during preparation, but not after identity revocation", async () => {
    const {ctx}=await scopedFixture();
    const now=new Date().toISOString(), interactionId="123456789012345678";
    await runtime.DB.prepare("INSERT INTO fb_discord_identities (id,tenant_id,discord_user_id,user_id,username,linked_at,last_seen_at) VALUES ('prepare_identity',?,'234567890123456789',?,'fixture',?,?)")
      .bind(ctx.tenant.id,ctx.user!.id,now,now).run();
    const discordCtx={...ctx,sessionId:null,discordPrincipal:{discordUserId:'234567890123456789'}};
    const installation=(await runtime.DB.prepare("SELECT * FROM fb_discord_installations WHERE id='epoch_install'").first<DiscordInstallation>())!;
    const discordScope=await resolveDiscordScope(discordCtx,installation,null);
    const scope=poolScopeFromDiscord(discordScope);
    const preview=await getPoolPreview(discordCtx,"test-pool",undefined,{scope});
    const idempotency={key:`discord:${interactionId}:open`,digest:await sha256Hex(`discord-open:${ctx.tenant.id}:${ctx.user!.id}:test-pool:${interactionId}`)};
    const interaction={id:interactionId,application_id:'123',type:2,token:'fixture',user:{id:'234567890123456789',username:'fixture'},data:{name:'foilbury'}} as DiscordInteraction;
    let injected=false;
    const db=new Proxy(runtime.DB,{get(target,key){
      if(key==='prepare') return (sql:string)=>{
        const statement=target.prepare(sql);
        if(!sql.includes('JOIN fb_discord_installations di ON di.id=?')) return statement;
        return new Proxy(statement,{get(s,prop){
          if(prop==='bind') return (...args:unknown[])=>{
            const bound=s.bind(...args);
            return new Proxy(bound,{get(b,method){
              if(method==='first') return async (...args:unknown[])=>{
                if(!injected){injected=true;
                  await executeDraw(discordCtx,{pool:'test-pool',expectedRevision:preview.revision,expectedDistribution:preview.distribution_fingerprint,scope,discordInstallation:scope.drawInstallation,idempotency});
                  await target.prepare("UPDATE fb_discord_installations SET game_enabled=0 WHERE id='epoch_install'").run();
                }
                return b.first(...args);
              };
              const value=Reflect.get(b,method,b);return typeof value==='function'?value.bind(b):value;
            }});
          };
          const value=Reflect.get(s,prop,s);return typeof value==='function'?value.bind(s):value;
        }});
      }
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    const prepared=await prepareDiscordDraw({...discordCtx,db},interaction,installation,'test-pool',idempotency.key,discordScope);
    expect(injected).toBe(true);
    expect(prepared.kind).toBe('respond');
    expect(JSON.stringify(prepared)).toContain('Test One');
    expect(JSON.stringify(prepared)).toContain('"flags":64');
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_draws WHERE idempotency_key=?").bind(idempotency.key).first<{n:number}>())?.n).toBe(1);
    await runtime.DB.prepare("UPDATE fb_discord_identities SET revoked_at=? WHERE id='prepare_identity'").bind(now).run();
    await expect(prepareDiscordDraw(discordCtx,interaction,installation,'test-pool',idempotency.key,discordScope)).rejects.toMatchObject({details:{draw_outcome_uncertain:true}});
  });
  it("returns a committed Discord receipt only while the same identity remains linked", async () => {
    const { ctx, scope, installation } = await scopedFixture();
    const now = new Date().toISOString();
    await runtime.DB.prepare("INSERT INTO fb_discord_identities (id,tenant_id,discord_user_id,user_id,username,linked_at,last_seen_at) VALUES ('replay_identity',?,'123456789012345678',?,'fixture',?,?)")
      .bind(ctx.tenant.id, ctx.user!.id, now, now).run();
    const discordCtx = { ...ctx, sessionId: null, discordPrincipal: { discordUserId: "123456789012345678" } };
    const preview = await getPoolPreview(discordCtx, "test-pool", undefined, { scope });
    const input = { pool: "test-pool", expectedRevision: preview.revision, expectedDistribution: preview.distribution_fingerprint,
      scope, discordInstallation: installation, authorizedReplayOnly: true, idempotency: { key: "discord-replay", digest: "discord-replay" } };
    const first = await executeDraw(discordCtx, input);
    const balance = await walletBalance(ctx, ctx.user!.id);
    expect(await executeDraw(discordCtx, input)).toMatchObject({ draw_id: first.draw_id, replayed: true });
    await runtime.DB.prepare("UPDATE fb_discord_identities SET revoked_at=? WHERE id='replay_identity'").bind(now).run();
    await expect(executeDraw(discordCtx, input)).rejects.toMatchObject({ code: "draw_authority_changed" });
    expect(await walletBalance(ctx, ctx.user!.id)).toBe(balance);
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_draws WHERE idempotency_key='discord-replay'").first<{ n: number }>())?.n).toBe(1);
  });
  it("rejects without debit when another copy arrives before commit", async () => {
    const { ctx, scope, installation } = await scopedFixture();
    const preview = await getPoolPreview(ctx, "test-pool", undefined, { scope });
    const entry = preview.entries[0]!;
    const balance = await walletBalance(ctx, ctx.user!.id);
    const now = new Date().toISOString();
    let injected = false;
    const db = new Proxy(runtime.DB, {
      get(target, key) {
        if (key === "batch") return async (...args: Parameters<typeof target.batch>) => {
          if (!injected) {
            injected = true;
            await target.prepare("INSERT INTO fb_card_instances (id,tenant_id,user_id,card_id,variant_id,serial,acquired_via,acquired_at,status,favourite,locked,updated_at) VALUES ('epoch_other_copy',?,?,?,?,'EPOCH-OTHER','test',?,'owned',0,0,?)")
              .bind(ctx.tenant.id, ctx.user!.id, entry.card_id, entry.variant_id, now, now).run();
          }
          return target.batch(...args);
        };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(executeDraw({ ...ctx, db }, {
      pool: "test-pool", expectedRevision: preview.revision, expectedDistribution: preview.distribution_fingerprint,
      scope, discordInstallation: installation, authorizedReplayOnly: true,
      idempotency: { key: "epoch-inventory-race", digest: "epoch-inventory-race" },
    })).rejects.toMatchObject({ code: "draw_inventory_changed" });
    expect(injected).toBe(true);
    expect(await walletBalance(ctx, ctx.user!.id)).toBe(balance);
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_draws WHERE idempotency_key='epoch-inventory-race'").first<{n:number}>())?.n).toBe(0);
  });
});
