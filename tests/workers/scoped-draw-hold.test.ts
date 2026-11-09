import { beforeEach, describe, expect, it } from "vitest";
import { bootstrap, ctxFor, fixturePool, runtime, walletBalance } from "./helpers";
import { executeDraw, getPoolPreview } from "../../src/server/modules/pools";
import type { Ctx } from "../../src/server/context";
import { readDrawScopeEpoch, repairDrawEpochTriggers } from "../../src/server/modules/draw-scope-epoch";

async function session(ctx: Ctx): Promise<Ctx> {
  const now = new Date().toISOString(),
    id = "scoped_hold_session";
  await runtime.DB.prepare(
    `INSERT INTO fb_sessions (id,token_hash,user_id,tenant_id,csrf_token,created_at,expires_at,last_seen_at,assurance,auth_time) VALUES (?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      id,
      "scoped_hold_hash",
      ctx.user!.id,
      ctx.tenant.id,
      "fixture",
      now,
      new Date(Date.now() + 3600000).toISOString(),
      now,
      "mfa",
      now,
    )
    .run();
  return { ...ctx, sessionId: id, sessionAssurance: "mfa", sessionAuthTime: now };
}

describe("scoped draws without the epoch schema", () => {
  beforeEach(async () => {
    await bootstrap();
  });
  it("detects missing or altered trigger definitions and fences pre-repair epochs", async () => {
    const ctx = await session(await ctxFor("cabinet", "owner@foilbury.local"));
    await fixturePool(ctx);
    const before = await readDrawScopeEpoch(ctx);
    expect(before).not.toBeNull();
    const original = await runtime.DB.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='draw_epoch_fb_pool_entries_update'").first<{sql:string}>();
    expect(original?.sql).toBeTruthy();
    await runtime.DB.prepare("DROP TRIGGER draw_epoch_fb_pool_entries_update").run();
    expect(await readDrawScopeEpoch(ctx)).toBeNull();
    await runtime.DB.prepare("UPDATE fb_pool_entries SET weight=weight+99 WHERE pool_id='pool_test_open'").run();
    await runtime.DB.prepare("CREATE TRIGGER draw_epoch_fb_pool_entries_update AFTER UPDATE ON fb_pool_entries BEGIN SELECT 1; END").run();
    expect(await readDrawScopeEpoch(ctx)).toBeNull();
    await repairDrawEpochTriggers(runtime.DB);
    const repaired = await readDrawScopeEpoch(ctx);
    expect(repaired).not.toBeNull();
    expect(repaired!.global).toBeGreaterThan(before!.global);
  });
  it("rolls back trigger replacement when the epoch row is missing", async () => {
    const ctx = await session(await ctxFor("cabinet", "owner@foilbury.local"));
    await fixturePool(ctx);
    await runtime.DB.prepare("DROP TRIGGER draw_epoch_fb_pool_entries_update").run();
    await runtime.DB.prepare("DELETE FROM fb_draw_scope_global_epoch WHERE id=1").run();
    await expect(repairDrawEpochTriggers(runtime.DB)).rejects.toThrow();
    expect(await runtime.DB.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='draw_epoch_fb_pool_entries_update'").first()).toBeNull();
    expect(await readDrawScopeEpoch(ctx)).toBeNull();
  });
  it("rejects new scoped draws without the epoch schema, with no charge", async () => {
    const ctx = await session(await ctxFor("cabinet", "owner@foilbury.local"));
    const fixture = await fixturePool(ctx);
    const preview = await getPoolPreview(ctx, "test-pool");
    const balance = await walletBalance(ctx, ctx.user!.id);
    const now = new Date().toISOString();
    const bot = await runtime.DB.prepare("SELECT id FROM fb_bots WHERE tenant_id=?").bind(ctx.tenant.id).first<{id:string}>();
    await runtime.DB.prepare("INSERT INTO fb_discord_installations (id,tenant_id,bot_id,application_id,guild_id,guild_name,channel_allowlist_json,game_enabled,active,created_at,updated_at) VALUES ('missing_schema_install',?,?,'123','456','fixture','[]',1,1,?,?)")
      .bind(ctx.tenant.id,bot!.id,now,now).run();
    const installation = { id:"missing_schema_install", revision:1, botId:bot!.id, channelAllowlist:"[]", collectionAllowlist:null, channelAudience:null, channelKey:null };
    const scope = {
      collectionIds: ["col_test_public"],
      audience: "public" as const,
      digest: "fixture",
      requireFiled: true,
      aiArtEnabled: true,
    };
    expect(fixture.poolId).toBeTruthy();
    await runtime.DB.prepare("DROP TABLE fb_draw_scope_user_epochs").run();
    expect(await readDrawScopeEpoch(ctx)).toBeNull();
    await expect(executeDraw(ctx, {
      pool: "test-pool", expectedRevision: preview.revision,
      expectedDistribution: preview.distribution_fingerprint,
      scope: { ...scope, drawEpoch: await readDrawScopeEpoch(ctx), drawInstallation:installation },
      discordInstallation:installation, authorizedReplayOnly:true,
      idempotency: { key: "held-missing-schema", digest: "held-missing-schema" },
    })).rejects.toMatchObject({ code: "scoped_draw_temporarily_unavailable" });
    expect(await walletBalance(ctx, ctx.user!.id)).toBe(balance);
    expect(
      (
        await runtime.DB.prepare(
          "SELECT COUNT(*) n FROM fb_draws WHERE idempotency_key LIKE 'held-%'",
        ).first<{ n: number }>()
      )?.n,
    ).toBe(0);
  });
  it("returns an authorised pre-existing same-key receipt, but not after session revocation", async () => {
    const ctx = await session(await ctxFor("cabinet", "owner@foilbury.local"));
    await fixturePool(ctx);
    const preview = await getPoolPreview(ctx, "test-pool");
    const key = { key: "prior-draw", digest: "prior-draw" };
    const original = await executeDraw(ctx, {
      pool: "test-pool",
      expectedRevision: preview.revision,
      expectedDistribution: preview.distribution_fingerprint,
      idempotency: key,
    });
    await runtime.DB.prepare("DROP TABLE fb_draw_scope_user_epochs").run();
    expect(await readDrawScopeEpoch(ctx)).toBeNull();
    const balance = await walletBalance(ctx, ctx.user!.id);
    const replay = await executeDraw(ctx, {
      pool: "test-pool",
      expectedRevision: preview.revision,
      expectedDistribution: preview.distribution_fingerprint,
      authorizedReplayOnly: true,
      idempotency: key,
    });
    expect(replay).toMatchObject({ draw_id: original.draw_id, replayed: true });
    await runtime.DB.prepare("UPDATE fb_sessions SET revoked_at=? WHERE id=?")
      .bind(new Date().toISOString(), ctx.sessionId)
      .run();
    await expect(
      executeDraw(ctx, {
        pool: "test-pool",
        expectedRevision: preview.revision,
        expectedDistribution: preview.distribution_fingerprint,
        authorizedReplayOnly: true,
        idempotency: key,
      }),
    ).rejects.toMatchObject({ code: "scoped_draw_temporarily_unavailable" });
    expect(await walletBalance(ctx, ctx.user!.id)).toBe(balance);
  });
});
