import { beforeEach, describe, expect, it } from "vitest";
import type { APIContext } from "astro";
import { ALL } from "../../src/pages/api/v1/[...path]";
import { createAgentGrant, createSession } from "../../src/server/modules/identity";
import { buildContext } from "../../src/server/context";
import { getMemberTradeInventory } from "../../src/server/modules/collection";
import { bootstrap, ctxFor, fixturePool, makeInstance, runtime } from "./helpers";

async function client(email: string, tenant = "cabinet") {
  const ctx = await ctxFor(tenant, email);
  const session = await createSession(runtime.DB, ctx.tenant, ctx.user!, {
    authMethod: "mfa",
    assurance: "mfa",
  });
  return async (path: string, method = "GET", body?: unknown) => {
    const request = new Request(`http://localhost:5173/api/v1/${path}`, {
      method,
      headers: {
        cookie: `fb_session=${session.token}; fb_csrf=${session.csrf}`,
        "x-foilbury-csrf": session.csrf,
        "content-type": "application/json",
        "idempotency-key": "route-contract-test-key",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const response = await ALL({ request, params: { path } } as unknown as APIContext);
    return { status: response.status, json: (await response.json()) as Record<string, any> };
  };
}

function beforeInventoryRead(db: D1Database, inject: () => Promise<void>): D1Database {
  return new Proxy(db, {
    get(target, key) {
      if (key !== "prepare") return Reflect.get(target, key, target);
      return (sql: string) => {
        const statement = target.prepare(sql);
        if (!sql.includes("WITH principal AS")) return statement;
        return new Proxy(statement, {
          get(original, prop) {
            if (prop !== "bind") return Reflect.get(original, prop, original);
            return (...values: unknown[]) => {
              const bound = original.bind(...values);
              return new Proxy(bound, {
                get(row, method) {
                  if (method !== "all") return Reflect.get(row, method, row);
                  return async () => {
                    await inject();
                    return row.all();
                  };
                },
              });
            };
          },
        });
      };
    },
  }) as D1Database;
}

describe("HTTP trade peer visibility", () => {
  beforeEach(async () => {
    await bootstrap();
  });
  it("returns only the fields needed to select a currently visible unlocked card", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const fixture = await fixturePool(owner);
    const instance = await makeInstance(owner, owner.user!.id, fixture, "VISIBLE-SERIAL");
    const locked = await makeInstance(owner, owner.user!.id, fixture, "LOCKED-SERIAL");
    await runtime.DB.prepare("UPDATE fb_card_instances SET locked = 1 WHERE id = ?")
      .bind(locked)
      .run();
    const player = await client("player@foilbury.local");
    const result = await player(`members/${owner.user!.id}/trade-items`);
    expect(result.status).toBe(200);
    expect(result.json.items).toEqual([
      {
        id: instance,
        card_name: "Test One",
        variant_name: "Plain",
        serial: "VISIBLE-SERIAL",
        material_key: "plain",
        effect_key: "none",
        render_url: "/media/public/test",
      },
    ]);
  });
  it("keeps a shared global card visible when it is owned in another Bot", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const fixture = await fixturePool(owner);
    const now = new Date().toISOString();
    await runtime.DB.batch([
      runtime.DB.prepare(
        "INSERT INTO fb_tenants (id,slug,name,created_at) VALUES ('ten_peer','peer','Peer Bot',?)",
      ).bind(now),
      runtime.DB.prepare(
        "INSERT INTO fb_bots (id,tenant_id,owner_user_id,slug,name,status,created_at,updated_at) VALUES ('bot_peer','ten_peer',?,'peer','Peer Bot','active',?,?)",
      ).bind(owner.user!.id, now, now),
      runtime.DB.prepare(
        "INSERT INTO fb_memberships (tenant_id,user_id,role,created_at,status) VALUES ('ten_peer',?,'owner',?,'active')",
      ).bind(owner.user!.id, now),
      runtime.DB.prepare(
        "INSERT INTO fb_memberships (tenant_id,user_id,role,created_at,status) VALUES ('ten_peer',?,'player',?,'active')",
      ).bind(player.user!.id, now),
    ]);
    const peerOwner = await ctxFor("peer", "owner@foilbury.local");
    await makeInstance(peerOwner, owner.user!.id, fixture, "SHARED-BOT-SERIAL");
    const peerPlayer = await client("player@foilbury.local", "peer");
    const result = await peerPlayer(`members/${owner.user!.id}/trade-items`);
    expect(result.status).toBe(200);
    expect(result.json.items.map((item: { serial: string }) => item.serial)).toEqual([
      "SHARED-BOT-SERIAL",
    ]);
  });
  it("allows current explicit viewers and withholds after that grant is revoked", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const playerCtx = await ctxFor("cabinet", "player@foilbury.local");
    const fixture = await fixturePool(owner);
    const now = new Date().toISOString();
    await runtime.DB.batch([
      runtime.DB.prepare(
        `INSERT INTO fb_collections (id,slug,name,description,scope,owner_tenant_id,accent,status,view_audience,created_by,created_at,updated_at) VALUES ('col_peer_grant','peer-grant','Private','Private','bot',?,'brass','published','private','test',?,?)`,
      ).bind(owner.tenant.id, now, now),
      runtime.DB.prepare(
        `INSERT INTO fb_collection_cards (collection_id,card_id,tenant_id,sort,added_by,added_at) VALUES ('col_peer_grant',?,?,0,'test',?)`,
      ).bind(fixture.cardId, owner.tenant.id, now),
      runtime.DB.prepare(
        `INSERT INTO fb_collection_viewers (collection_id,user_id,granted_by,created_at) VALUES ('col_peer_grant',?,?,?)`,
      ).bind(playerCtx.user!.id, owner.user!.id, now),
    ]);
    await makeInstance(owner, owner.user!.id, fixture, "SHARED-SERIAL");
    const player = await client("player@foilbury.local");
    expect((await player(`members/${owner.user!.id}/trade-items`)).json.items).toHaveLength(1);
    await runtime.DB.prepare(
      "UPDATE fb_collection_viewers SET revoked_at = ? WHERE collection_id = 'col_peer_grant'",
    )
      .bind(now)
      .run();
    expect((await player(`members/${owner.user!.id}/trade-items`)).json.items).toEqual([]);
  });
  it("rechecks the exact agent token and grant at the inventory read", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const fixture = await fixturePool(owner);
    await makeInstance(owner, owner.user!.id, fixture, "AGENT-SERIAL");
    const grant = await createAgentGrant(owner, {
      agentName: "peer-reader",
      representedUserId: player.user!.id,
      scopes: ["inventory:read"],
      expiresInDays: 1,
    });
    const request = new Request("http://localhost:5173/api/v1/members/x/trade-items", {
      headers: { authorization: `Bearer ${grant.token}` },
    });
    const ctx = await buildContext(request);
    expect(ctx.agentTokenId).toBeTruthy();
    expect(await getMemberTradeInventory(ctx, owner.user!.id)).toHaveLength(1);
    await runtime.DB.prepare("UPDATE fb_agent_tokens SET revoked_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), ctx.agentTokenId)
      .run();
    expect(await getMemberTradeInventory(ctx, owner.user!.id)).toEqual([]);
  });
  it("returns the same neutral shelf for missing and inactive targets", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const player = await client("player@foilbury.local");
    const missing = await player("members/usr_missing/trade-items");
    await runtime.DB.prepare(
      "UPDATE fb_memberships SET status = 'suspended' WHERE tenant_id = ? AND user_id = ?",
    )
      .bind(owner.tenant.id, owner.user!.id)
      .run();
    const inactive = await player(`members/${owner.user!.id}/trade-items`);
    expect(missing).toEqual({ status: 200, json: { items: [] } });
    expect(inactive).toEqual(missing);
  });
  it("withholds the shelf if the session is revoked between target check and final read", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const fixture = await fixturePool(owner);
    await makeInstance(owner, owner.user!.id, fixture, "SESSION-RACE");
    const session = await createSession(runtime.DB, player.tenant, player.user!);
    const ctx = await buildContext(
      new Request("http://localhost:5173/api/v1/members/x/trade-items", {
        headers: { cookie: `fb_session=${session.token}` },
      }),
    );
    let injected = false;
    ctx.db = beforeInventoryRead(runtime.DB, async () => {
      injected = true;
      await runtime.DB.prepare("UPDATE fb_sessions SET revoked_at = ? WHERE id = ?")
        .bind(new Date().toISOString(), ctx.sessionId)
        .run();
    });
    expect(await getMemberTradeInventory(ctx, owner.user!.id)).toEqual([]);
    expect(injected).toBe(true);
  });
  it("withholds a formerly public card if its collection becomes private before the read", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const fixture = await fixturePool(owner);
    await makeInstance(owner, owner.user!.id, fixture, "AUDIENCE-RACE");
    const session = await createSession(runtime.DB, player.tenant, player.user!);
    const ctx = await buildContext(
      new Request("http://localhost:5173/api/v1/members/x/trade-items", {
        headers: { cookie: `fb_session=${session.token}` },
      }),
    );
    let injected = false;
    ctx.db = beforeInventoryRead(runtime.DB, async () => {
      injected = true;
      await runtime.DB.prepare(
        "UPDATE fb_collections SET view_audience = 'private', public_approved_at = NULL WHERE id = 'col_test_public'",
      ).run();
    });
    expect(await getMemberTradeInventory(ctx, owner.user!.id)).toEqual([]);
    expect(injected).toBe(true);
  });
  it.each(["disabled", "synthetic"] as const)(
    "withholds the shelf when a principal becomes %s before the read",
    async (change) => {
      const owner = await ctxFor("cabinet", "owner@foilbury.local");
      const player = await ctxFor("cabinet", "player@foilbury.local");
      const fixture = await fixturePool(owner);
      await makeInstance(owner, owner.user!.id, fixture, "IDENTITY-RACE");
      const session = await createSession(runtime.DB, player.tenant, player.user!);
      const ctx = await buildContext(
        new Request("http://localhost:5173/api/v1/members/x/trade-items", {
          headers: { cookie: `fb_session=${session.token}` },
        }),
      );
      let injected = false;
      ctx.db = beforeInventoryRead(runtime.DB, async () => {
        injected = true;
        if (change === "disabled")
          await runtime.DB.prepare("UPDATE fb_users SET disabled_at = ? WHERE id = ?")
            .bind(new Date().toISOString(), player.user!.id)
            .run();
        else
          await runtime.DB.prepare("UPDATE fb_users SET is_synthetic = 1 WHERE id = ?")
            .bind(player.user!.id)
            .run();
      });
      expect(await getMemberTradeInventory(ctx, owner.user!.id)).toEqual([]);
      expect(injected).toBe(true);
    },
  );
  it("withholds the shelf when an agent's represented user becomes synthetic before the read", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const fixture = await fixturePool(owner);
    await makeInstance(owner, owner.user!.id, fixture, "AGENT-SYNTHETIC-RACE");
    const grant = await createAgentGrant(owner, {
      agentName: "synthetic-race",
      representedUserId: player.user!.id,
      scopes: ["inventory:read"],
      expiresInDays: 1,
    });
    const ctx = await buildContext(
      new Request("http://localhost:5173/api/v1/members/x/trade-items", {
        headers: { authorization: `Bearer ${grant.token}` },
      }),
    );
    let injected = false;
    ctx.db = beforeInventoryRead(runtime.DB, async () => {
      injected = true;
      await runtime.DB.prepare("UPDATE fb_users SET is_synthetic = 1 WHERE id = ?")
        .bind(player.user!.id)
        .run();
    });
    expect(await getMemberTradeInventory(ctx, owner.user!.id)).toEqual([]);
    expect(injected).toBe(true);
  });
  it("does not expose an NPC collector through the human peer shelf", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const fixture = await fixturePool(owner);
    await makeInstance(owner, owner.user!.id, fixture, "NPC-PRIVATE");
    const player = await client("player@foilbury.local");
    await runtime.DB.prepare("UPDATE fb_users SET is_synthetic = 1 WHERE id = ?")
      .bind(owner.user!.id)
      .run();
    const result = await player(`members/${owner.user!.id}/trade-items`);
    expect(result.status).toBe(200);
    expect(result.json.items).toEqual([]);
  });
  it("rechecks agent scopes at the final read and rejects malformed scope objects", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const fixture = await fixturePool(owner);
    await makeInstance(owner, owner.user!.id, fixture, "SCOPE-RACE");
    const grant = await createAgentGrant(owner, {
      agentName: "scope-reader",
      representedUserId: player.user!.id,
      scopes: ["inventory:read"],
      expiresInDays: 1,
    });
    const ctx = await buildContext(
      new Request("http://localhost:5173/api/v1/members/x/trade-items", {
        headers: { authorization: `Bearer ${grant.token}` },
      }),
    );
    let injected = false;
    ctx.db = beforeInventoryRead(runtime.DB, async () => {
      injected = true;
      await runtime.DB.prepare("UPDATE fb_agent_grants SET scopes_json = ? WHERE id = ?")
        .bind('{"scope":"inventory:read"}', grant.grantId)
        .run();
    });
    expect(await getMemberTradeInventory(ctx, owner.user!.id)).toEqual([]);
    expect(injected).toBe(true);
  });
  it("does not disclose a private card via another member's trade items", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const fixture = await fixturePool(owner);
    const now = new Date().toISOString();
    await runtime.DB.batch([
      runtime.DB.prepare(
        `INSERT INTO fb_collections (id,slug,name,description,scope,owner_tenant_id,accent,status,view_audience,created_by,created_at,updated_at) VALUES ('col_private_peer','private-peer','Secret World','Secret World details','bot',?,'brass','published','private','test',?,?)`,
      ).bind(owner.tenant.id, now, now),
      runtime.DB.prepare(
        `INSERT INTO fb_collection_cards (collection_id,card_id,tenant_id,sort,added_by,added_at) VALUES ('col_private_peer',?,?,0,'test',?)`,
      ).bind(fixture.cardId, owner.tenant.id, now),
    ]);
    await makeInstance(owner, owner.user!.id, fixture, "PRIVATE-SERIAL-1");
    const player = await client("player@foilbury.local");
    const card = await player(`cards/${fixture.cardId}`);
    expect(card.status).toBe(404);
    const result = await player(`members/${owner.user!.id}/trade-items`);
    expect(result.status).toBe(200);
    expect(JSON.stringify(result.json)).not.toContain("PRIVATE-SERIAL-1");
    expect(JSON.stringify(result.json)).not.toContain("Test One");
  });
});
