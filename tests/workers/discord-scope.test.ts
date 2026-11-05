import { beforeEach, describe, expect, it } from "vitest";
import { handleDiscordInteraction } from "../../src/server/discord/handler";
import { signDiscordRequest } from "../../src/server/discord/signature";
import type { DiscordEnv } from "../../src/server/discord/types";
import { bootstrap, ctxFor, fixturePool, makeInstance, runtime, setBalance, walletBalance } from "./helpers";
import { addCollectionCards, createCollection } from "../../src/server/modules/collections";
import { ensureWallet } from "../../src/server/modules/identity";
import { resolveDiscordScope } from "../../src/server/discord/scope";
import type { DiscordInstallation } from "../../src/server/discord/types";
import { routeApi } from "../../src/server/api/router";

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

async function send(body: Record<string, unknown>) {
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
  const response = await handleDiscordInteraction(request, env(), { publicKey: publicKeyHex });
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

async function setAudience(audience: "public" | "members") {
  await runtime.DB.prepare(
    "UPDATE fb_discord_installations SET channel_audience_json = ?, configuration_revision = configuration_revision + 1 WHERE id = 'dci_scope'",
  )
    .bind(JSON.stringify({ [CHANNEL_ID]: audience }))
    .run();
}

async function admitLinkedPlayer(player:Awaited<ReturnType<typeof install>>, collectionId:string) {
  const now=new Date().toISOString();
  await runtime.DB.prepare("INSERT INTO fb_discord_identities (id,tenant_id,discord_user_id,user_id,linked_at,last_seen_at) VALUES ('scope_linked_player',?,?,?,?,?)")
    .bind(player.tenant.id,DISCORD_USER_ID,player.user!.id,now,now).run();
  const owner=await ctxFor("cabinet","owner@foilbury.local");
  await runtime.DB.prepare("INSERT INTO fb_collection_viewers (collection_id,user_id,granted_by,created_at) VALUES (?,?,?,?)")
    .bind(collectionId,player.user!.id,owner.user!.id,now).run();
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

  it("withholds historic receipt details after current authority changes", async () => {
    const player=await install(),owner=await ctxFor("cabinet","owner@foilbury.local"),fixture=await fixturePool(player);
    const opened=await send(interaction(command("open",[{name:"pool",type:3,value:"test-pool"}]),{id:"scoped-receipt-origin"}));
    expect(JSON.stringify(opened.data)).toContain("Test One");
    const identity=await runtime.DB.prepare("SELECT user_id FROM fb_discord_identities WHERE tenant_id=? AND discord_user_id=?").bind(player.tenant.id,DISCORD_USER_ID).first<{user_id:string}>();
    const draw=await runtime.DB.prepare("SELECT ci.serial FROM fb_draws d JOIN fb_card_instances ci ON ci.id=d.instance_id WHERE d.idempotency_key='discord:scoped-receipt-origin:open'").first<{serial:string}>();
    expect(identity?.user_id).toBeTruthy();expect(draw?.serial).toBeTruthy();
    const stolen=interaction({custom_id:"foilbury:redeliver:scoped-receipt-origin",component_type:2},{type:3});
    stolen.member.user={id:"111111111111111111",username:"another-player",global_name:"Another player"};
    const stolenReply=JSON.stringify((await send(stolen)).data);
    expect(stolenReply).not.toContain('Test One');
    expect(stolenReply).not.toContain(draw!.serial);
    const now=new Date().toISOString();
    await runtime.DB.prepare("UPDATE fb_collections SET view_audience='members',public_approved_at=NULL WHERE id='col_test_public'").run();
    await runtime.DB.prepare("INSERT INTO fb_collection_viewers (collection_id,user_id,granted_by,created_at) VALUES ('col_test_public',?,?,?)").bind(identity!.user_id,owner.user!.id,now).run();
    await setAudience("members");
    const retry=()=>send(interaction({custom_id:"foilbury:redeliver:scoped-receipt-origin",component_type:2},{type:3}));
    expect(JSON.stringify((await retry()).data)).toContain("Test One");
    const assertHidden=async()=>{const response=await retry(),body=JSON.stringify(response.data);expect(response.data?.flags).toBe(64);expect(body).not.toContain("Test One");expect(body).not.toContain(draw!.serial);expect(body).not.toContain("attachment://");};
    await runtime.DB.prepare("UPDATE fb_collection_viewers SET revoked_at=? WHERE collection_id='col_test_public' AND user_id=?").bind(now,identity!.user_id).run();
    await assertHidden();
    await runtime.DB.prepare("UPDATE fb_collection_viewers SET revoked_at=NULL WHERE collection_id='col_test_public' AND user_id=?").bind(identity!.user_id).run();
    await runtime.DB.prepare("UPDATE fb_bot_collections SET enabled=0 WHERE collection_id='col_test_public'").run();
    await assertHidden();
    await runtime.DB.prepare("UPDATE fb_bot_collections SET enabled=1 WHERE collection_id='col_test_public'").run();
    await setAudience("public");await assertHidden();await setAudience("members");
    await runtime.DB.prepare("UPDATE fb_memberships SET revoked_at=? WHERE tenant_id=? AND user_id=?").bind(now,player.tenant.id,identity!.user_id).run();
    await assertHidden();
    await runtime.DB.prepare("UPDATE fb_memberships SET revoked_at=NULL WHERE tenant_id=? AND user_id=?").bind(player.tenant.id,identity!.user_id).run();
    await runtime.DB.prepare("UPDATE fb_discord_identities SET revoked_at=? WHERE tenant_id=? AND discord_user_id=?").bind(now,player.tenant.id,DISCORD_USER_ID).run();
    await assertHidden();
    expect(await draws()).toBe(1);
  });

  it("does not let stale share controls bypass AI-off policy", async () => {
    const player=await install();
    const fixture=await fixturePool(player);
    await runtime.DB.prepare("UPDATE fb_bots SET ai_art_enabled=1 WHERE tenant_id=?").bind(player.tenant.id).run();
    const opened=await send(interaction(command("open",[{name:"pool",type:3,value:"test-pool"}]),{id:"ai-share-before"}));
    expect(JSON.stringify(opened.data)).toContain("Test One");
    const instance=await runtime.DB.prepare("SELECT instance_id FROM fb_draws WHERE idempotency_key='discord:ai-share-before:open'").first<{instance_id:string}>();
    expect(instance?.instance_id).toBeTruthy();
    await runtime.DB.prepare("UPDATE fb_bots SET ai_art_enabled=0 WHERE tenant_id=?").bind(player.tenant.id).run();
    for(const customId of [`foilbury:tourshare:card:${instance!.instance_id}`,"foilbury:tourshare:profile:any","foilbury:tourshare:completion:col_test_public"]) {
      const result=await send(interaction({custom_id:customId,component_type:2},{type:3}));
      expect(result.data?.flags).toBe(64);
      expect(JSON.stringify(result.data)).not.toMatch(/Test One|attachment:|Shared by/);
      expect(JSON.stringify(result.data)).toContain("Public sharing is unavailable");
    }
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_discord_shares").first<{n:number}>())?.n).toBe(0);
  });

  it("labels sampled inventory counts when the 500-copy limit is reached", async () => {
    const player=await install(),fixture=await fixturePool(player),now=new Date().toISOString();
    await send(interaction(command("help")));
    const identity=await runtime.DB.prepare("SELECT user_id FROM fb_discord_identities WHERE tenant_id=? AND discord_user_id=?").bind(player.tenant.id,DISCORD_USER_ID).first<{user_id:string}>();
    expect(identity?.user_id).toBeTruthy();
    for(let page=0;page<5;page++) await runtime.DB.batch(Array.from({length:100},(_,i)=>runtime.DB.prepare(
      "INSERT INTO fb_card_instances (id,tenant_id,user_id,card_id,variant_id,serial,acquired_via,acquired_at,status,favourite,locked,updated_at) VALUES (?,?,?,?,?,?,'test',?,'owned',0,0,?)",
    ).bind(`sample_${page}_${i}`,player.tenant.id,identity!.user_id,fixture.cardId,fixture.variantId,`SAMPLE-${page}-${i}`,now,now)));
    for(const name of ["collection","profile"]) {
      const result=await send(interaction(command(name)));
      expect(result.data?.flags).toBe(64);
      expect(JSON.stringify(result.data)).toMatch(/up to (?:the )?500 (?:most )?recent copies/i);
    }
    const progress=await send(interaction({custom_id:"foilbury:tour:progress",component_type:2},{type:3}));
    expect(progress.data?.flags).toBe(64);
    expect(JSON.stringify(progress.data)).toContain("Sample of up to 500 recent copies");
  });

  it.each(["draft","archived"])("hides a previously owned %s card from signed surfaces", async lifecycle => {
    const player=await install(),fixture=await fixturePool(player);
    const opened=await send(interaction(command("open",[{name:"pool",type:3,value:"test-pool"}]),{id:`lifecycle-${lifecycle}`}));
    expect(JSON.stringify(opened.data)).toContain("Test One");
    await runtime.DB.prepare(lifecycle==="draft" ? "UPDATE fb_card_definitions SET status='draft' WHERE id=?" : "UPDATE fb_card_definitions SET archived_at=? WHERE id=?")
      .bind(...(lifecycle==="draft" ? [fixture.cardId] : [new Date().toISOString(),fixture.cardId])).run();
    for(const data of [command("collection"),command("profile"),command("card",[{name:"query",type:3,value:"Test One"}])]) {
      const response=await send(interaction(data));
      expect(response.data?.flags).toBe(64);
      expect(JSON.stringify(response.data)).not.toMatch(/Test One|attachment:\/\//);
    }
    const retry=await send(interaction({custom_id:`foilbury:redeliver:lifecycle-${lifecycle}`,component_type:2},{type:3}));
    expect(JSON.stringify(retry.data)).not.toMatch(/Test One|attachment:\/\//);
  });

  it("hides a previously public card when it gains a draft collection link", async () => {
    const player=await install(),owner=await ctxFor("cabinet","owner@foilbury.local");
    const fixture=await fixturePool(player);
    const initial=await send(interaction(command("open",[{name:"pool",type:3,value:"test-pool"}]),{id:"draft-link-first"}));
    expect(JSON.stringify(initial.data)).toContain("Test One");
    const before=await draws();
    const draft=await createCollection(owner,{name:"Unreleased draft",scope:"global",status:"published",viewAudience:"members"});
    await addCollectionCards(owner,draft.id,[fixture.cardId]);
    await runtime.DB.prepare("UPDATE fb_collections SET status='draft' WHERE id=?").bind(draft.id).run();
    for(const data of [command("card",[{name:"query",type:3,value:"Test One"}]),command("collection"),command("profile"),command("packs"),command("open",[{name:"pool",type:3,value:"test-pool"}])]) {
      const result=await send(interaction(data));
      expect(result.data?.flags).toBe(64);
      expect(JSON.stringify(result.data)).not.toMatch(/Test One|attachment:\/\//);
    }
    for(const stage of ["welcome","albums","fresh","open","inspect","progress","share"]) {
      const result=await send(interaction({custom_id:`foilbury:tour:${stage}`,component_type:2},{type:3}));
      expect(result.data?.flags).toBe(64);
      expect(JSON.stringify(result.data)).not.toMatch(/Test One|attachment:\/\//);
    }
    const retry=await send(interaction({custom_id:"foilbury:redeliver:draft-link-first",component_type:2},{type:3}));
    expect(retry.data?.flags).toBe(64);
    expect(JSON.stringify(retry.data)).not.toMatch(/Test One|attachment:\/\//);
    expect(await draws()).toBe(before);
  });

  it("requires explicit restricted collection admission and rechecks revocations", async () => {
    const player=await install(),owner=await ctxFor("cabinet","owner@foilbury.local");
    const fixture=await fixturePool(player);
    const publicCard=await send(interaction(command("card",[{name:"query",type:3,value:"Test One"}])));
    expect(JSON.stringify(publicCard.data)).toContain("Test One");
    const members=await createCollection(owner,{name:"Admitted only",scope:"global",status:"published",viewAudience:"members"});
    await addCollectionCards(owner,members.id,[fixture.cardId]);
    await runtime.DB.prepare("DELETE FROM fb_collection_cards WHERE collection_id='col_test_public'").run();
    await runtime.DB.prepare("INSERT OR REPLACE INTO fb_bot_collections (bot_id,collection_id,enabled,updated_at) SELECT id,?,1,? FROM fb_bots WHERE tenant_id=?").bind(members.id,new Date().toISOString(),player.tenant.id).run();
    await setAudience("members");
    const card=()=>send(interaction(command("card",[{name:"query",type:3,value:"Test One"}])));
    const denied=await card();
    expect(denied.data?.flags).toBe(64);
    expect(JSON.stringify(denied.data)).not.toMatch(/Test One|attachment:\/\//);
    const auto=await runtime.DB.prepare("SELECT user_id FROM fb_discord_identities WHERE tenant_id=? AND discord_user_id=?").bind(player.tenant.id,DISCORD_USER_ID).first<{user_id:string}>();
    expect(auto?.user_id).toBeTruthy();
    const now=new Date().toISOString();
    await runtime.DB.prepare("INSERT INTO fb_collection_viewers (collection_id,user_id,granted_by,created_at) VALUES ('col_test_public',?,?,?)").bind(auto!.user_id,owner.user!.id,now).run();
    expect(JSON.stringify((await card()).data)).not.toContain("Test One");
    await runtime.DB.prepare("INSERT INTO fb_collection_viewers (collection_id,user_id,granted_by,created_at) VALUES (?,?,?,?)").bind(members.id,auto!.user_id,owner.user!.id,now).run();
    expect(JSON.stringify((await card()).data)).toContain("Test One");
    await runtime.DB.prepare("UPDATE fb_memberships SET revoked_at=? WHERE tenant_id=? AND user_id=?").bind(now,player.tenant.id,auto!.user_id).run();
    expect(JSON.stringify((await card()).data)).not.toMatch(/Test One|attachment:\/\//);
    await runtime.DB.prepare("UPDATE fb_memberships SET revoked_at=NULL WHERE tenant_id=? AND user_id=?").bind(player.tenant.id,auto!.user_id).run();
    await runtime.DB.prepare("UPDATE fb_discord_identities SET revoked_at=? WHERE tenant_id=? AND discord_user_id=?").bind(now,player.tenant.id,DISCORD_USER_ID).run();
    expect(JSON.stringify((await card()).data)).not.toMatch(/Test One|attachment:\/\//);
    await runtime.DB.prepare("UPDATE fb_discord_identities SET revoked_at=NULL WHERE tenant_id=? AND discord_user_id=?").bind(player.tenant.id,DISCORD_USER_ID).run();
    expect(JSON.stringify((await card()).data)).toContain("Test One");
    await runtime.DB.prepare("UPDATE fb_collection_viewers SET revoked_at=? WHERE collection_id=? AND user_id=?").bind(now,members.id,auto!.user_id).run();
    expect(JSON.stringify((await card()).data)).not.toMatch(/Test One|attachment:\/\//);
    expect(JSON.stringify((await send(interaction(command("card",[{name:"query",type:3,value:"Test One"}]),{guildId:"997734945206313042"}))).data)).not.toMatch(/Test One|attachment:\/\//);
  });

  it("rejects a stale installation snapshot before restricted scope is returned", async () => {
    const player=await install(),owner=await ctxFor("cabinet","owner@foilbury.local");
    const fixture=await fixturePool(player);
    const members=await createCollection(owner,{name:"Stale scope",scope:"global",status:"published",viewAudience:"members"});
    await addCollectionCards(owner,members.id,[fixture.cardId]);
    await runtime.DB.prepare("INSERT OR REPLACE INTO fb_bot_collections (bot_id,collection_id,enabled,updated_at) SELECT id,?,1,? FROM fb_bots WHERE tenant_id=?").bind(members.id,new Date().toISOString(),player.tenant.id).run();
    await admitLinkedPlayer(player,members.id);
    await setAudience("members");
    const stale=await installation();
    await setAudience("public");
    const ctx={...player,discordPrincipal:{discordUserId:DISCORD_USER_ID,applicationId:APPLICATION_ID,guildId:GUILD_ID,channelId:CHANNEL_ID}};
    const scope=await resolveDiscordScope(ctx,stale,CHANNEL_ID);
    expect(scope.collectionIds).toEqual([]);
    expect(scope.emptyReason).toMatch(/access changed/i);
  });

  it("allows the explicitly provisioned production owner when linked and active", async () => {
    const player=await install(),owner=await ctxFor("cabinet","owner@foilbury.local"),now=new Date().toISOString();
    const fixture=await fixturePool(player);
    const members=await createCollection(owner,{name:"Owner access",scope:"global",status:"published",viewAudience:"members"});
    await addCollectionCards(owner,members.id,[fixture.cardId]);
    await runtime.DB.prepare("DELETE FROM fb_collection_cards WHERE collection_id='col_test_public'").run();
    await runtime.DB.prepare("INSERT OR REPLACE INTO fb_bot_collections (bot_id,collection_id,enabled,updated_at) SELECT id,?,1,? FROM fb_bots WHERE tenant_id=?").bind(members.id,now,player.tenant.id).run();
    await runtime.DB.prepare("UPDATE fb_users SET platform_admin=0 WHERE platform_admin=1").run();
    await runtime.DB.prepare("INSERT INTO fb_users (id,email,display_name,password_hash,platform_admin,created_at) VALUES ('usr_prod_owner','owner-test@foilbury.invalid','Owner','test',1,?)").bind(now).run();
    await runtime.DB.prepare("INSERT INTO fb_platform_admins (user_id,provisioned_by,provisioned_at,reason,status) VALUES ('usr_prod_owner','fixture',?,'test','active')").bind(now).run();
    await runtime.DB.prepare("INSERT INTO fb_memberships (tenant_id,user_id,role,status,created_at) VALUES (?,'usr_prod_owner','owner','active',?)").bind(player.tenant.id,now).run();
    await runtime.DB.prepare("INSERT INTO fb_discord_identities (id,tenant_id,discord_user_id,user_id,linked_at,last_seen_at) VALUES ('owner_identity',?,?,'usr_prod_owner',?,?)").bind(player.tenant.id,DISCORD_USER_ID,now,now).run();
    await ensureWallet(runtime.DB,player.tenant.id,"usr_prod_owner");
    await makeInstance(player,"usr_prod_owner",fixture,"OWNER-EXACT");
    await setAudience("members");
    const packs=await send(interaction(command("packs")));
    const album=await send(interaction(command("collection")));
    const response=await send(interaction(command("card",[{name:"query",type:3,value:"Test One"}])));
    const achievements=await send(interaction(command("achievements")));
    const profile=await send(interaction(command("profile")));
    for(const result of [packs,album,response,achievements,profile]) expect(result.data?.flags).toBe(64);
    expect(JSON.stringify(packs.data)).toContain("test-pool");
    expect(JSON.stringify(album.data)).toContain("OWNER-EXACT");
    expect(JSON.stringify(response.data)).toContain("Test One");
    await runtime.DB.prepare("UPDATE fb_platform_admins SET status='revoked',revoked_at=? WHERE user_id='usr_prod_owner'").bind(now).run();
    expect(JSON.stringify((await send(interaction(command("card",[{name:"query",type:3,value:"Test One"}])))).data)).not.toMatch(/Test One|attachment:\/\//);
    await runtime.DB.prepare("UPDATE fb_platform_admins SET status='active',revoked_at=NULL WHERE user_id='usr_prod_owner'").run();
    await runtime.DB.prepare("UPDATE fb_users SET platform_admin=0 WHERE id='usr_prod_owner'").run();
    expect(JSON.stringify((await send(interaction(command("card",[{name:"query",type:3,value:"Test One"}])))).data)).not.toMatch(/Test One|attachment:\/\//);
  });

  it("does not draw members-only artwork into a public channel", async () => {
    const owner = await install();
    const ownerCtx = await ctxFor("cabinet", "owner@foilbury.local");
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
    await admitLinkedPlayer(owner,collection.id);
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
    await setAudience("public");
    const publicCollection = await send(interaction(command("collection")));
    expect(JSON.stringify(publicCollection.data)).not.toContain("Test One");
    const publicButton = await send(interaction({ custom_id: "foilbury:collection", component_type: 2 }, { type: 3 }));
    expect(JSON.stringify(publicButton.data)).not.toContain("Test One");
  });

  it("applies the invoking channel to card controls, achievements and profile", async () => {
    const player = await install();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const fixture = await fixturePool(player);
    const members = await createCollection(owner, {name:"Scoped Members",scope:"global",status:"published",viewAudience:"members"});
    await addCollectionCards(owner, members.id, [fixture.cardId]);
    await runtime.DB.prepare("DELETE FROM fb_collection_cards WHERE collection_id='col_test_public'").run();
    await runtime.DB.prepare("INSERT OR REPLACE INTO fb_bot_collections (bot_id,collection_id,enabled,updated_at) SELECT id,?,1,? FROM fb_bots WHERE tenant_id=?").bind(members.id,new Date().toISOString(),player.tenant.id).run();
    const now = new Date().toISOString();
    await runtime.DB.prepare("INSERT INTO fb_variant_back_renders(id,tenant_id,variant_id,recipe_id,asset_id,width,height,sha256,status,created_at,published_at) VALUES('scope_back',?,?,?,?,750,1050,'fixture','published',?,?)").bind(player.tenant.id,fixture.variantId,fixture.recipeId,fixture.renderAsset,now,now).run();
    await runtime.DB.prepare(`INSERT INTO fb_achievement_definitions(id,scope,tenant_id,key,version,name,description,criteria_json,reward_json,visibility,art_key,category,sort,status,created_by,created_at,updated_at) VALUES('ach_scope_member','bot',?,'scope-member',1,'Members-only achievement','Restricted fixture',?,'{"foil":0}','member','medal-test','collection',0,'active','test',?,?)`).bind(player.tenant.id,JSON.stringify({type:'collection_unique',collection_id:members.id,target:1,roster_card_ids:[fixture.cardId]}),now,now).run();
    await runtime.DB.prepare("INSERT INTO fb_achievement_progress(tenant_id,user_id,achievement_id,achievement_version,progress,target,state,updated_at) VALUES(?,?,'ach_scope_member',1,1,1,'earned',?)").bind(player.tenant.id,owner.user!.id,now).run();
    await runtime.DB.prepare("INSERT INTO fb_achievement_unlocks(id,tenant_id,user_id,achievement_id,achievement_version,earned_at,reward_state,reward_amount,notification_state,created_at) VALUES('unlock_scope',?,?,'ach_scope_member',1,?,'none',0,'suppressed',?)").bind(player.tenant.id,owner.user!.id,now,now).run();
    await admitLinkedPlayer(player,members.id);
    const invokeCard = () => send(interaction(command("card",[{name:"query",type:3,value:"Test One"}])));
    const invokeControl = (action:string) => send(interaction({custom_id:`foilbury:card:${fixture.cardId}:${fixture.variantId}:${action}`,component_type:2},{type:3}));
    await setAudience("members");
    for (const response of [await invokeCard(),await invokeControl("front"),await invokeControl("back"),await invokeControl("details")]) {
      expect(response.data?.flags).toBe(64);
      expect(JSON.stringify(response.data)).toContain("Test One");
    }
    const mapped = await runtime.DB.prepare("SELECT user_id FROM fb_discord_identities WHERE tenant_id=? AND discord_user_id=? AND revoked_at IS NULL").bind(player.tenant.id,DISCORD_USER_ID).first<{user_id:string}>();
    expect(mapped?.user_id).toBeTruthy();
    await runtime.DB.prepare("UPDATE fb_achievement_progress SET user_id=? WHERE achievement_id='ach_scope_member'").bind(mapped!.user_id).run();
    await runtime.DB.prepare("UPDATE fb_achievement_unlocks SET user_id=? WHERE achievement_id='ach_scope_member'").bind(mapped!.user_id).run();
    const memberAchievements=await send(interaction(command("achievements")));
    expect(memberAchievements.data?.flags).toBe(64);
    expect(JSON.stringify(memberAchievements.data)).toContain("Members-only achievement");
    const memberProfile=await send(interaction(command("profile")));
    expect(memberProfile.data?.flags).toBe(64);
    const memberBadges=memberProfile.data?.embeds?.[0]?.fields?.find(field=>field.name==="Badges")?.value;
    expect(memberBadges).toMatch(/^1 earned/);
    const assertPublic = async (channelId?:string) => {
      for (const response of [await send(interaction(command("card",[{name:"query",type:3,value:"Test One"}]),{channelId})), ...await Promise.all(["front","back","details"].map(action=>send(interaction({custom_id:`foilbury:card:${fixture.cardId}:${fixture.variantId}:${action}`,component_type:2},{type:3,channelId}))))]) {
        expect(response.data?.flags).toBe(64);
        expect(JSON.stringify(response.data)).not.toContain("Test One");
        expect(JSON.stringify(response.data)).not.toContain("attachment://");
      }
      const achievements=await send(interaction(command("achievements"),{channelId}));
      expect(achievements.data?.flags).toBe(64);
      expect(JSON.stringify(achievements.data)).not.toContain("Members-only achievement");
      const profile=await send(interaction(command("profile"),{channelId}));
      expect(profile.data?.flags).toBe(64);
      expect(JSON.stringify(profile.data)).not.toContain("Members-only achievement");
      expect(JSON.stringify(profile.data)).not.toContain("Test One");
    };
    await setAudience("public");await assertPublic();
    await runtime.DB.prepare("UPDATE fb_discord_installations SET channel_allowlist_json='[]', channel_audience_json=? WHERE id='dci_scope'").bind(JSON.stringify({[CHANNEL_ID]:'members'})).run();
    await assertPublic("1566700752385081356");
    await runtime.DB.prepare("UPDATE fb_discord_installations SET channel_audience_json='{broken' WHERE id='dci_scope'").run();
    for (const response of [await invokeCard(), await invokeControl("front"), await send(interaction(command("profile")))]) {
      expect(response.data?.flags).toBe(64);
      expect(JSON.stringify(response.data)).not.toContain("Test One");
      expect(JSON.stringify(response.data)).not.toContain("attachment://");
    }
  });

  it.each([
    ["object list", "{}", "{}"],
    ["mixed list", `["${CHANNEL_ID}",42]`, "{}"],
    ["bad channel ID", '["not-a-snowflake"]', "{}"],
    ["malformed list", "[", "{}"],
    ["array audience", "[]", "[]"],
    ["bad audience", "[]", `{"${CHANNEL_ID}":"team"}`],
    ["malformed audience", "[]", "{"],
    ["duplicate members-public", "[]", `{"${CHANNEL_ID}":"members","${CHANNEL_ID}":"public"}`],
    ["duplicate public-members", "[]", `{"${CHANNEL_ID}":"public","${CHANNEL_ID}":"members"}`],
    ["duplicate escaped key", "[]", `{"${CHANNEL_ID}":"public","\\u0031${CHANNEL_ID.slice(1)}":"members"}`],
  ])("signed interactions fail closed for %s", async (_label, channels, audiences) => {
    const player=await install();
    await fixturePool(player);
    await runtime.DB.prepare("UPDATE fb_discord_installations SET channel_allowlist_json=?,channel_audience_json=? WHERE id='dci_scope'").bind(channels,audiences).run();
    const before=await draws();
    for (const body of [interaction(command("card",[{name:"query",type:3,value:"Test One"}])),interaction(command("packs")),interaction(command("open",[{name:"pool",type:3,value:"test-pool"}]))]) {
      const response=await send(body);
      expect(response.data?.flags).toBe(64);
      expect(JSON.stringify(response.data)).not.toMatch(/Test One|attachment:\/\/|nothing (?:was )?charged/i);
      expect(JSON.stringify(response.data)).toContain("channel policy needs repair");
    }
    expect(await draws()).toBe(before);
  });
  it("rejects a duplicate decoded key consistently with SQLite JSON", async () => {
    const player=await install();
    const duplicate=`{"${CHANNEL_ID}":"public","\\u0031${CHANNEL_ID.slice(1)}":"members"}`;
    const sqlite=await runtime.DB.prepare("SELECT key FROM json_each(?)").bind(duplicate).all<{key:string}>();
    expect(sqlite.results.map(row=>row.key)).toEqual([CHANNEL_ID,CHANNEL_ID]);
    const row=await installation();
    await expect(resolveDiscordScope(player,{...row,channel_audience_json:duplicate},CHANNEL_ID)).rejects.toMatchObject({code:"discord_channel_policy_invalid"});
  });
  it("keeps a valid channel-less scoped HTTP preview public", async () => {
    const player=await install();
    await fixturePool(player);
    const row=await installation();
    const scope=await resolveDiscordScope(player,row,null);
    expect(scope.channelAudience).toBe("public");
    await expect(resolveDiscordScope(player,row,"1566700752385081356")).rejects.toMatchObject({code:"discord_channel_not_enabled"});
  });
  it("rejects invalid policy on the scoped HTTP preview too", async () => {
    const player=await install();
    await fixturePool(player);
    await runtime.DB.prepare("UPDATE fb_discord_installations SET channel_allowlist_json='{}' WHERE id='dci_scope'").run();
    await expect(routeApi(new Request(`https://foilbury.test/api/v1/pools/test-pool?installation=dci_scope&channelId=${CHANNEL_ID}`),player,"pools/test-pool")).rejects.toMatchObject({code:"discord_channel_policy_invalid"});
  });
  it.each(["public", "members", "private"])("accepts a valid %s channel policy", async audience => {
    const player=await install();
    await fixturePool(player);
    await setAudience(audience);
    const response=await send(interaction(command("card",[{name:"query",type:3,value:"Test One"}])));
    expect(response.data?.flags).toBe(64);
    expect(JSON.stringify(response.data)).toContain("Test One");
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
    const ownerCtx = await ctxFor("cabinet", "owner@foilbury.local");
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
});
