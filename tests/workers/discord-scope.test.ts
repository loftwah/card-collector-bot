import { beforeEach, describe, expect, it } from "vitest";
import { handleDiscordInteraction } from "../../src/server/discord/handler";
import { signDiscordRequest } from "../../src/server/discord/signature";
import type { DiscordEnv } from "../../src/server/discord/types";
import { bootstrap, ctxFor, fixturePool, makeInstance, runtime, setBalance, walletBalance } from "./helpers";
import { addCollectionCards, createCollection } from "../../src/server/modules/collections";
import { resolveDiscordScope } from "../../src/server/discord/scope";
import type { DiscordInstallation } from "../../src/server/discord/types";
import { routeApi } from "../../src/server/api/router";
import type { Ctx } from "../../src/server/context";
import { readDrawScopeEpoch } from "../../src/server/modules/draw-scope-epoch";

async function withStrongSession(ctx: Ctx): Promise<Ctx> {
  const now = new Date().toISOString();
  await runtime.DB.prepare(
    `INSERT INTO fb_sessions (id, token_hash, user_id, tenant_id, csrf_token, created_at, expires_at, last_seen_at, assurance, auth_time)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind("scope_owner_session", "scope_owner_hash", ctx.user!.id, ctx.tenant.id, "fixture", now,
    new Date(Date.now() + 3600000).toISOString(), now, "mfa", now).run();
  return { ...ctx, sessionId: "scope_owner_session", sessionAssurance: "mfa", sessionAuthTime: now };
}

async function ownerWithStrongSession(): Promise<Ctx> {
  return withStrongSession(await ctxFor("cabinet", "owner@foilbury.local"));
}

const APPLICATION_ID = "1566702936615026769";
const GUILD_ID = "997734945206313041";
const CHANNEL_ID = "1566700752385081355";
const DISCORD_USER_ID = "707281352818425929";

let privateKey: CryptoKey;
let publicKeyHex: string;

async function makeKeys() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  privateKey = pair.privateKey;
  const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
  publicKeyHex = Array.from(new Uint8Array(raw), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function env(): DiscordEnv {
  return new Proxy(runtime as unknown as DiscordEnv, {
    get(target, property) {
      if (property === "DISCORD_APPLICATION_ID") return APPLICATION_ID;
      if (property === "DISCORD_PUBLIC_KEY") return publicKeyHex;
      if (property === "FOILBURY_PUBLIC_ORIGIN") return "https://foilbury.test";
      return (target as unknown as Record<PropertyKey, unknown>)[property];
    },
  });
}

function interaction(
  data: Record<string, unknown>,
  overrides: { id?: string; type?: number; channelId?: string; guildId?: string } = {},
) {
  return {
    id: overrides.id ?? `interaction-${Math.random().toString(36).slice(2)}`,
    application_id: APPLICATION_ID,
    type: overrides.type ?? 2,
    token: "test-interaction-token",
    guild_id: overrides.guildId ?? GUILD_ID,
    channel_id: overrides.channelId ?? CHANNEL_ID,
    member: {
      user: { id: DISCORD_USER_ID, username: "dean", global_name: "Dean" },
      roles: [],
    },
    data,
  };
}

function command(name: string, options: Array<Record<string, unknown>> = []) {
  return {
    name: "foilbury",
    type: 1,
    options: [{ name, type: 1, options }],
  };
}

async function send(body: Record<string, unknown>, testEnv: DiscordEnv = env()) {
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await signDiscordRequest({ body: raw, timestamp, privateKey });
  const request = new Request("https://foilbury.test/api/discord/interactions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-signature-ed25519": signature,
      "x-signature-timestamp": timestamp,
    },
    body: raw,
  });
  const response = await handleDiscordInteraction(request, testEnv, { publicKey: publicKeyHex });
  return (await response.json()) as {
    type?: number;
    data?: {
      content?: string;
      embeds?: Array<{ title?: string; description?: string; fields?: Array<{ name: string; value: string }> }>;
      flags?: number;
      components?: Array<{ components?: Array<{ custom_id?: string; label?: string }> }>;
    };
  };
}

async function install(allowlist: string[] | null = null) {
  const player = await ctxFor("cabinet", "player@foilbury.local");
  await runtime.DB.prepare(
    `INSERT INTO fb_discord_installations
      (id, tenant_id, application_id, guild_id, guild_name, channel_allowlist_json,
       collection_allowlist_json, game_enabled, website_enabled, api_enabled,
       public_catalogue_enabled, admin_gui_enabled, active, created_at, updated_at)
     VALUES ('dci_scope', ?, ?, ?, 'Loftwah', ?, ?, 1, 1, 1, 1, 1, 1, ?, ?)`,
  )
    .bind(
      player.tenant.id,
      APPLICATION_ID,
      GUILD_ID,
      JSON.stringify([CHANNEL_ID]),
      allowlist === null ? null : JSON.stringify(allowlist),
      new Date().toISOString(),
      new Date().toISOString(),
    )
    .run();
  return player;
}

async function draws(): Promise<number> {
  const row = await runtime.DB.prepare("SELECT COUNT(*) AS count FROM fb_draws").first<{
    count: number;
  }>();
  return row?.count ?? 0;
}

async function installation(): Promise<DiscordInstallation> {
  const row = await runtime.DB.prepare(
    "SELECT * FROM fb_discord_installations WHERE id = 'dci_scope'",
  ).first<DiscordInstallation>();
  if (!row) throw new Error("Installation fixture missing.");
  return row;
}

async function setAudience(audience: "public" | "members" | "private") {
  await runtime.DB.prepare(
    "UPDATE fb_discord_installations SET channel_audience_json = ?, configuration_revision = configuration_revision + 1 WHERE id = 'dci_scope'",
  )
    .bind(JSON.stringify({ [CHANNEL_ID]: audience }))
    .run();
}

async function setAllowlist(ids: string[]) {
  await runtime.DB.prepare(
    "UPDATE fb_discord_installations SET collection_allowlist_json = ?, configuration_revision = configuration_revision + 1 WHERE id = 'dci_scope'",
  )
    .bind(JSON.stringify(ids))
    .run();
}

describe("Discord configured-server scope", () => {
  beforeEach(async () => {
    await bootstrap();
    await makeKeys();
  });

  it('enforces and validates the installation channel policy for scoped API reads',async()=>{
    const player=await withStrongSession(await install());
    await fixturePool(player);
    const request=(channel:string)=>new Request(`https://foilbury.test/api/v1/pools/test-pool?installation=dci_scope${channel}`);
    await expect(routeApi(request(''),player,'pools/test-pool')).rejects.toMatchObject({code:'discord_channel_not_enabled'});
    await expect(routeApi(request('&channel=999999999999999999'),player,'pools/test-pool')).rejects.toMatchObject({code:'discord_channel_not_enabled'});
    const valid=await routeApi(request(`&channel=${CHANNEL_ID}`),player,'pools/test-pool');
    expect(valid.status).toBe(200);
    await runtime.DB.prepare("UPDATE fb_discord_installations SET channel_allowlist_json='{}' WHERE id='dci_scope'").run();
    await expect(routeApi(request(`&channel=${CHANNEL_ID}`),player,'pools/test-pool')).rejects.toMatchObject({code:'discord_channel_not_enabled'});
    await runtime.DB.prepare("UPDATE fb_discord_installations SET channel_allowlist_json='[]' WHERE id='dci_scope'").run();
    expect((await routeApi(request(''),player,'pools/test-pool')).status).toBe(200);
    await runtime.DB.prepare("UPDATE fb_discord_installations SET collection_allowlist_json='' WHERE id='dci_scope'").run();
    await expect(routeApi(request(''),player,'pools/test-pool')).rejects.toMatchObject({code:'discord_scope_empty'});
    await runtime.DB.prepare("UPDATE fb_discord_installations SET collection_allowlist_json=NULL WHERE id='dci_scope'").run();
    expect((await routeApi(request(''),player,'pools/test-pool')).status).toBe(200);
    await runtime.DB.prepare("UPDATE fb_discord_installations SET collection_allowlist_json='[]' WHERE id='dci_scope'").run();
    await expect(routeApi(request(''),player,'pools/test-pool')).rejects.toMatchObject({code:'discord_scope_empty'});
  });

  it("fails closed with a useful explanation for an explicit empty server configuration", async () => {
    await install([]);
    const welcome = await send(interaction(command("tour")));
    expect(welcome.data?.flags).toBe(64);
    expect(welcome.data?.embeds?.[0]?.title).toBe("This server has no eligible collection");
    expect(JSON.stringify(welcome.data)).toContain("explicit empty collection allowlist");
    expect(await draws()).toBe(0);
  });

  it("excludes a disabled Bot collection from the tour, packs and draw without spending", async () => {
    const player = await install();
    await fixturePool(player);
    await setBalance(player, player.user!.id, 1000);
    await runtime.DB.prepare(
      "UPDATE fb_bot_collections SET enabled = 0 WHERE collection_id = 'col_test_public'",
    ).run();
    const welcome = await send(interaction(command("tour")));
    expect(JSON.stringify(welcome.data)).toContain("This server has no eligible collection");
    expect(JSON.stringify(welcome.data)).not.toContain("Test Public");
    const open = await send(interaction(command("open", [{ name: "pool", type: 3, value: "test-pool" }])));
    expect(JSON.stringify(open.data)).not.toContain("Test One");
    expect(await draws()).toBe(0);
  });

  it("does not draw members-only artwork into a public channel", async () => {
    const owner = await install();
    const ownerCtx = await ownerWithStrongSession();
    const fixture = await fixturePool(owner);
    const collection = await createCollection(ownerCtx, {
      name: "Scoped Members",
      scope: "global",
      status: "published",
      viewAudience: "members",
    });
    await addCollectionCards(ownerCtx, collection.id, [fixture.cardId]);
    await runtime.DB.prepare(
      "DELETE FROM fb_collection_cards WHERE collection_id = 'col_test_public'",
    ).run();
    await runtime.DB.prepare(
      "INSERT OR REPLACE INTO fb_bot_collections (bot_id, collection_id, enabled, updated_at) SELECT b.id, ?, 1, ? FROM fb_bots b WHERE b.tenant_id = ?",
    )
      .bind(collection.id, new Date().toISOString(), owner.tenant.id)
      .run();
    await setBalance(owner, owner.user!.id, 1000);
    const denied = await send(
      interaction(command("open", [{ name: "pool", type: 3, value: "test-pool" }]), {
        id: "scope-public-denied",
      }),
    );
    expect(denied.data?.flags).toBe(64);
    expect(JSON.stringify(denied.data)).toMatch(/not enabled for this channel|no eligible|cannot/i);
    expect(await draws()).toBe(0);
    const publicPacks = await send(interaction(command("packs")));
    expect(JSON.stringify(publicPacks.data)).not.toContain("test-pool");
    await setAudience("members");
    const memberPacks = await send(interaction(command("packs")));
    expect(JSON.stringify(memberPacks.data)).toContain("test-pool");
    const packsButton = await send(interaction({ custom_id: "foilbury:packs", component_type: 2 }, { type: 3 }));
    expect(JSON.stringify(packsButton.data)).toContain("test-pool");
    const allowed = await send(
      interaction(command("open", [{ name: "pool", type: 3, value: "test-pool" }]), {
        id: "scope-members-allowed",
      }),
    );
    expect(allowed.data?.flags).toBe(64);
    expect(JSON.stringify(allowed.data)).toContain("Test One");
    expect(await draws()).toBe(1);
    const memberCollection = await send(interaction(command("collection")));
    expect(JSON.stringify(memberCollection.data)).toContain("Test One");
    const collectionButton = await send(interaction({ custom_id: "foilbury:collection", component_type: 2 }, { type: 3 }));
    expect(JSON.stringify(collectionButton.data)).toContain("Test One");
    for (const id of ["scope-member-duplicate-1", "scope-member-duplicate-2"]) {
      await send(interaction(command("open", [{ name: "pool", type: 3, value: "test-pool" }]), { id }));
    }
    const duplicates = await send(interaction(command("collection")));
    expect(duplicates.data?.embeds?.[0]?.fields?.find((field) => field.name === "Duplicates")?.value).toBe("2");
    const collector = await runtime.DB.prepare("SELECT user_id FROM fb_card_instances WHERE card_id=? LIMIT 1").bind(fixture.cardId).first<{ user_id: string }>();
    expect(collector?.user_id).toBeTruthy();
    await runtime.DB.batch(Array.from({ length: 498 }, (_, index) => runtime.DB.prepare(
      `INSERT INTO fb_card_instances (id, tenant_id, user_id, card_id, variant_id, serial, acquired_via, acquired_at, status, favourite, locked, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'test', ?, 'owned', 0, 0, ?)`,
    ).bind(`scope_extra_${index}`, owner.tenant.id, collector!.user_id, fixture.cardId, fixture.variantId, `SCOPE-${index}`, new Date().toISOString(), new Date().toISOString())));
    const largeCollection = await send(interaction(command("collection")));
    const largeFields = largeCollection.data?.embeds?.[0]?.fields ?? [];
    expect(largeFields.find((field) => field.name === "Owned")?.value).toBe("501");
    expect(largeFields.find((field) => field.name === "Duplicates")?.value).toBe("500");
    const largeProfile = await send(interaction(command("profile")));
    expect(largeProfile.data?.embeds?.[0]?.fields?.find((field) => field.name === "Owned cards")?.value).toBe("501");
    await runtime.DB.prepare("UPDATE fb_assets SET origin='ai_generated' WHERE id=?").bind(fixture.subjectAsset).run();
    const excluded = await send(interaction(command("collection")));
    expect(excluded.data?.embeds?.[0]?.fields?.find((field) => field.name === "Owned")?.value).toBe("0");
    expect(excluded.data?.embeds?.[0]?.title).toBe("No cards available here");
    expect(excluded.data?.embeds?.[0]?.description).toContain("501 historical copies");
    await runtime.DB.prepare("UPDATE fb_assets SET origin='unknown' WHERE id=?").bind(fixture.subjectAsset).run();
    await setAudience("public");
    const publicCollection = await send(interaction(command("collection")));
    expect(JSON.stringify(publicCollection.data)).not.toContain("Test One");
    const publicButton = await send(interaction({ custom_id: "foilbury:collection", component_type: 2 }, { type: 3 }));
    expect(JSON.stringify(publicButton.data)).not.toContain("Test One");
  });

  it.each([
    ["collection", "installation allowlist", "UPDATE fb_discord_installations SET collection_allowlist_json='[]', configuration_revision=configuration_revision+1 WHERE id='dci_scope'"],
    ["profile", "installation allowlist", "UPDATE fb_discord_installations SET collection_allowlist_json='[]', configuration_revision=configuration_revision+1 WHERE id='dci_scope'"],
    ["collection", "Bot collection availability", "UPDATE fb_bot_collections SET enabled=0 WHERE collection_id='col_test_public'"],
    ["profile", "Bot collection availability", "UPDATE fb_bot_collections SET enabled=0 WHERE collection_id='col_test_public'"],
    ["collection", "channel audience", "UPDATE fb_discord_installations SET channel_audience_json='{}', configuration_revision=configuration_revision+1 WHERE id='dci_scope'"],
    ["profile", "Bot artwork policy", "UPDATE fb_bots SET ai_art_enabled=1 WHERE tenant_id=(SELECT tenant_id FROM fb_discord_installations WHERE id='dci_scope')"],
    ["collection", "subject origin", "UPDATE fb_assets SET origin='ai_generated' WHERE id='ast_test_subject'"],
    ["profile", "subject origin", "UPDATE fb_assets SET origin='ai_generated' WHERE id='ast_test_subject'"],
  ])("does not return stale %s after %s changes between scope and inventory", async (action, _change, mutation) => {
    const player = await install();
    const fixture = await fixturePool(player);
    // The verified Discord identity may map to a different account than install().
    await send(interaction(command("profile")));
    const identity = await runtime.DB.prepare("SELECT user_id FROM fb_discord_identities WHERE tenant_id=? AND discord_user_id=? AND revoked_at IS NULL")
      .bind(player.tenant.id, DISCORD_USER_ID).first<{ user_id: string }>();
    expect(identity?.user_id).toBeTruthy();
    await makeInstance(player, identity!.user_id, fixture, "SCOPE-RACE-COPY");
    let injected = false;
    const db = new Proxy(runtime.DB, { get(target, key) {
      if (key === "prepare") return (sql: string) => {
        const statement = target.prepare(sql);
        if (!sql.includes("SELECT DISTINCT cc.card_id")) return statement;
        return new Proxy(statement, { get(prepared, method) {
          if (method === "bind") return (...args: unknown[]) => {
            const bound = prepared.bind(...args);
            return new Proxy(bound, { get(query, operation) {
              if (operation === "all") return async (...queryArgs: []) => {
                const result = await query.all(...queryArgs);
                if (!injected) { injected = true; await target.prepare(mutation).run(); }
                return result;
              };
              const value = Reflect.get(query, operation, query);
              return typeof value === "function" ? value.bind(query) : value;
            }});
          };
          const value = Reflect.get(prepared, method, prepared);
          return typeof value === "function" ? value.bind(prepared) : value;
        }});
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    }});
    const base = env();
    const raceEnv = new Proxy(base, { get(target, key) { return key === "DB" ? db : Reflect.get(target, key, target); } });
    const response = await send(interaction(command(action)), raceEnv);
    expect(injected).toBe(true);
    expect(response.data?.flags).toBe(64);
    expect(JSON.stringify(response.data)).not.toContain("Test One");
    const fields = response.data?.embeds?.[0]?.fields ?? [];
    expect(fields.find(field => field.name === (action === "collection" ? "Owned" : "Owned cards"))?.value).not.toBe("1");
  });

  it.each(["collection", "profile"])("fails closed for %s inventory when epoch schema is missing", async (action) => {
    const player = await install();
    const fixture = await fixturePool(player);
    await send(interaction(command("profile")));
    const identity = await runtime.DB.prepare("SELECT user_id FROM fb_discord_identities WHERE tenant_id=? AND discord_user_id=? AND revoked_at IS NULL")
      .bind(player.tenant.id, DISCORD_USER_ID).first<{ user_id: string }>();
    expect(identity?.user_id).toBeTruthy();
    await makeInstance(player, identity!.user_id, fixture, "SCOPE-MISSING-EPOCH");
    await runtime.DB.prepare("DROP TABLE fb_draw_scope_global_epoch").run();
    const response = await send(interaction(command(action)));
    expect(response.data?.flags).toBe(64);
    expect(JSON.stringify(response.data)).not.toContain("Test One");
    const fields = response.data?.embeds?.[0]?.fields ?? [];
    expect(fields.find(field => field.name === (action === "collection" ? "Owned" : "Owned cards"))?.value).not.toBe("1");
  });

  it.each([
    ["collection", "revoke"], ["collection", "relink"],
    ["profile", "revoke"], ["profile", "relink"],
  ])("does not return %s inventory after Discord identity %s during the final check", async (action, change) => {
    const player = await install();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const fixture = await fixturePool(player);
    await send(interaction(command("profile")));
    const identity = await runtime.DB.prepare("SELECT user_id FROM fb_discord_identities WHERE tenant_id=? AND discord_user_id=? AND revoked_at IS NULL")
      .bind(player.tenant.id, DISCORD_USER_ID).first<{ user_id: string }>();
    expect(identity?.user_id).toBeTruthy();
    await makeInstance(player, identity!.user_id, fixture, "SCOPE-IDENTITY-RACE");
    const replacementId = identity!.user_id === player.user!.id ? owner.user!.id : player.user!.id;
    expect(replacementId).not.toBe(identity!.user_id);
    let inventoryRead = false, injected = false;
    const db = new Proxy(runtime.DB, { get(target, key) {
      if (key === "prepare") return (sql: string) => {
        const statement = target.prepare(sql);
        const isCount = sql.includes("COUNT(DISTINCT ci.card_id) AS unique_cards");
        const isFinal = sql.includes("AS ok") && sql.includes("fb_draw_scope_global_epoch") && sql.includes("fb_discord_identities");
        if (!isCount && !isFinal) return statement;
        return new Proxy(statement, { get(prepared, method) {
          if (method === "bind") return (...args: unknown[]) => {
            const bound = prepared.bind(...args);
            return new Proxy(bound, { get(query, operation) {
              if (operation === "first") return async (...queryArgs: []) => {
                if (isFinal && !injected) {
                  expect(inventoryRead).toBe(true);
                  injected = true;
                  if (change === "revoke") await target.prepare("UPDATE fb_discord_identities SET revoked_at=? WHERE tenant_id=? AND discord_user_id=?").bind(new Date().toISOString(),player.tenant.id,DISCORD_USER_ID).run();
                  else await target.prepare("UPDATE fb_discord_identities SET user_id=? WHERE tenant_id=? AND discord_user_id=?").bind(replacementId,player.tenant.id,DISCORD_USER_ID).run();
                }
                const result = await query.first(...queryArgs);
                if (isCount) inventoryRead = true;
                return result;
              };
              const value = Reflect.get(query, operation, query);
              return typeof value === "function" ? value.bind(query) : value;
            }});
          };
          const value = Reflect.get(prepared, method, prepared);
          return typeof value === "function" ? value.bind(prepared) : value;
        }});
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    }});
    const base = env();
    const raceEnv = new Proxy(base, { get(target, key) { return key === "DB" ? db : Reflect.get(target, key, target); } });
    const response = await send(interaction(command(action)), raceEnv);
    expect(inventoryRead).toBe(true);
    expect(injected).toBe(true);
    expect(response.data?.flags).toBe(64);
    expect(JSON.stringify(response.data)).not.toContain("Test One");
    const fields = response.data?.embeds?.[0]?.fields ?? [];
    expect(fields.find(field => field.name === (action === "collection" ? "Owned" : "Owned cards"))?.value).not.toBe("1");
  });

  it("excludes AI-assisted artwork when the Bot preference is off and includes it when on", async () => {
    const player = await install();
    const fixture = await fixturePool(player);
    await setBalance(player, player.user!.id, 1000);
    await runtime.DB.prepare(
      "UPDATE fb_assets SET origin = 'ai_assisted' WHERE id = (SELECT subject_asset_id FROM fb_artwork_editions WHERE card_id = ?)",
    )
      .bind(fixture.cardId)
      .run();
    const off = await send(
      interaction(command("open", [{ name: "pool", type: 3, value: "test-pool" }]), {
        id: "ai-off",
      }),
    );
    expect(off.data?.flags).toBe(64);
    expect(JSON.stringify(off.data)).toMatch(/AI-assisted artwork|no eligible/i);
    expect(await draws()).toBe(0);
    await runtime.DB.prepare(
      "UPDATE fb_bots SET ai_art_enabled = 1 WHERE tenant_id = ?",
    )
      .bind(player.tenant.id)
      .run();
    const on = await send(
      interaction(command("open", [{ name: "pool", type: 3, value: "test-pool" }]), {
        id: "ai-on",
      }),
    );
    expect(on.data?.flags).toBe(64);
    expect(JSON.stringify(on.data)).toContain("Test One");
    expect(await draws()).toBe(1);
  });

  it("keeps a collection outside the server allowlist out of the welcome and packs", async () => {
    const player = await install();
    const ownerCtx = await ownerWithStrongSession();
    const fixture = await fixturePool(player);
    const extra = await createCollection(ownerCtx, {
      name: "Other Server Collection",
      scope: "global",
      status: "published",
      viewAudience: "public",
    });
    await addCollectionCards(ownerCtx, extra.id, [fixture.cardId]);
    await runtime.DB.prepare(
      "INSERT OR REPLACE INTO fb_bot_collections (bot_id, collection_id, enabled, updated_at) SELECT b.id, ?, 1, ? FROM fb_bots b WHERE b.tenant_id = ?",
    )
      .bind(extra.id, new Date().toISOString(), player.tenant.id)
      .run();
    await setAllowlist([extra.id]);
    // The fixture card now belongs to both collections, so the all-collections
    // rule excludes it from the allowlist that names only one.
    const welcome = await send(interaction(command("tour")));
    const text = JSON.stringify(welcome.data);
    expect(text).toContain("Other Server Collection");
    expect(text).not.toContain("Test One");
    const open = await send(
      interaction(command("open", [{ name: "pool", type: 3, value: "test-pool" }]), {
        id: "allowlist-open",
      }),
    );
    expect(JSON.stringify(open.data)).not.toContain("Test One");
    expect(await draws()).toBe(0);
  });

  it("fails the API draw closed after the installation configuration changes", async () => {
    const player = await install();
    await fixturePool(player);
    await setBalance(player, player.user!.id, 1000);
    const before = await resolveDiscordScope(player, await installation(), CHANNEL_ID);
    expect(before.collectionIds).toContain("col_test_public");
    const spendBefore = await walletBalance(player, player.user!.id);
    await runtime.DB.prepare(
      "UPDATE fb_discord_installations SET collection_allowlist_json = '[]', configuration_revision = configuration_revision + 1 WHERE id = 'dci_scope'",
    ).run();
    const after = await resolveDiscordScope(player, await installation(), CHANNEL_ID);
    expect(after.emptyReason).toContain("explicit empty collection allowlist");
    const agentCtx = await ctxFor("cabinet", "player@foilbury.local");
    agentCtx.actor = {
      type: "agent",
      id: "test-agent",
      representedUserId: agentCtx.user!.id,
      label: "test agent",
    };
    agentCtx.scopes = ["draw:execute"];
    const request = new Request("https://foilbury.test/api/v1/draws", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "scope-stale-config-1",
      },
      body: JSON.stringify({
        pool: "test-pool",
        expectedRevision: 1,
        expectedDistribution: "a".repeat(64),
        installationId: "dci_scope",
        channelId: CHANNEL_ID,
      }),
    });
    await expect(routeApi(request, agentCtx, "draws")).rejects.toMatchObject({
      code: "discord_scope_empty",
      status: 403,
    });
    expect(await draws()).toBe(0);
    expect(await walletBalance(player, player.user!.id)).toBe(spendBefore);
  });

  it("explains an opening unavailable because the epoch schema is missing", async () => {
    const player = await install();
    await fixturePool(player);
    await setBalance(player, player.user!.id, 1000);
    await send(interaction(command("tour"), { id: "prepare-missing-schema" }));
    const before = await walletBalance(player, player.user!.id);
    await runtime.DB.prepare("DROP TABLE fb_draw_scope_user_epochs").run();
    const response = await send(interaction(command("open", [{ name: "pool", type: 3, value: "test-pool" }]), { id: "missing-schema-opening" }));
    expect(response.data?.flags).toBe(64);
    expect(JSON.stringify(response.data)).toContain("Capsules temporarily unavailable");
    expect(JSON.stringify(response.data)).toContain("An opening with this request may have completed");
    expect(await draws()).toBe(0);
    expect(await walletBalance(player, player.user!.id)).toBe(before);
  });

  it("uses the current role when deriving a server's eligible collections", async () => {
    await install();
    const owner = await ownerWithStrongSession();
    const collection = await createCollection(owner, { name: "Private owner fixture", scope: "global", status: "published", viewAudience: "private" });
    await runtime.DB.prepare("INSERT OR REPLACE INTO fb_bot_collections (bot_id,collection_id,enabled,updated_at) SELECT id,?,1,? FROM fb_bots WHERE tenant_id=?")
      .bind(collection.id, new Date().toISOString(), owner.tenant.id).run();
    await setAudience("private");
    const staleCtx = { ...owner, user: { ...owner.user!, role: "player" as const, platformAdmin: false } };
    const scope = await resolveDiscordScope(staleCtx, await installation(), CHANNEL_ID);
    expect(scope.collectionIds).toContain(collection.id);
    // Revoke before epoch capture while preserving the formerly privileged
    // request context: it must not restore a now-ineligible collection.
    await runtime.DB.prepare("UPDATE fb_memberships SET role='player' WHERE tenant_id=? AND user_id=?")
      .bind(owner.tenant.id, owner.user!.id).run();
    await runtime.DB.prepare("UPDATE fb_users SET platform_admin=0 WHERE id=?").bind(owner.user!.id).run();
    const revoked = await resolveDiscordScope(owner, await installation(), CHANNEL_ID);
    expect(revoked.collectionIds).not.toContain(collection.id);
  });

  it("captures the epoch before a role revocation during scope resolution", async () => {
    await install();
    const owner = await ownerWithStrongSession();
    await fixturePool(owner);
    let injected = false;
    const db = new Proxy(runtime.DB, { get(target, key) {
      if (key === "prepare") return (sql: string) => {
        const stmt = target.prepare(sql);
        if (!sql.startsWith("SELECT * FROM fb_bots WHERE tenant_id")) return stmt;
        return new Proxy(stmt, { get(s, prop) {
          if (prop === "bind") return (...args: unknown[]) => {
            const bound = s.bind(...args);
            return new Proxy(bound, { get(b, method) {
              if (method === "first") return async (...args: unknown[]) => {
                if (!injected) {
                  injected = true;
                  await target.prepare("UPDATE fb_memberships SET role='player' WHERE tenant_id=? AND user_id=?").bind(owner.tenant.id, owner.user!.id).run();
                }
                return b.first(...args);
              };
              const value = Reflect.get(b, method, b);
              return typeof value === "function" ? value.bind(b) : value;
            }});
          };
          const value = Reflect.get(s, prop, s);
          return typeof value === "function" ? value.bind(s) : value;
        }});
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    }});
    const scope = await resolveDiscordScope({ ...owner, db }, await installation(), CHANNEL_ID);
    expect(injected).toBe(true);
    expect(scope.drawEpoch).not.toEqual(await readDrawScopeEpoch(owner));
  });
});
