import { beforeEach, describe, expect, it } from "vitest";
import { bootstrap, ctxFor, fixturePool, makeInstance, runtime } from "./helpers";
import { createNpc, getNpc } from "../../src/server/modules/npcs";
import {
  npcTradeCandidateQuery,
  previewNpcTrade,
} from "../../src/server/modules/npc-trade-preview";
import { routeApi } from "../../src/server/api/router";
import pendingSchema from "../../docs/pending/npc-trade-schema.sql?raw";
import {
  cancelNpcTrade,
  confirmNpcTrade,
  createNpcTradeOffer,
  expireNpcTradeOffers,
  listNpcTradeOffers,
  suggestNpcTradeOffers,
} from "../../src/server/modules/npc-trades";
import { acceptTrade, cancelTrade, getTrade, listTrades } from "../../src/server/modules/trades";
import { handleDiscordInteraction } from "../../src/server/discord/handler";
import { signDiscordRequest } from "../../src/server/discord/signature";
import type { DiscordEnv } from "../../src/server/discord/types";

describe("NPC trade assessment", () => {
  beforeEach(async () => {
    await bootstrap();
  });

  async function setup() {
    await runtime.DB.batch(
      pendingSchema
        .replace(/^--.*$/gm, "")
        .split(";")
        .map((sql) => sql.trim())
        .filter(Boolean)
        .map((sql) => runtime.DB.prepare(sql)),
    );
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const now = new Date().toISOString();
    await runtime.DB.prepare(
      "INSERT INTO fb_sessions (id,token_hash,user_id,tenant_id,csrf_token,created_at,expires_at,last_seen_at) VALUES ('npc-preview-session','npc-preview-hash',?,?, 'test',?,?,?)",
    )
      .bind(
        player.user!.id,
        player.tenant.id,
        now,
        new Date(Date.now() + 60_000).toISOString(),
        now,
      )
      .run();
    player.sessionId = "npc-preview-session";
    const original = await fixturePool(owner);
    await runtime.DB.prepare(
      "UPDATE fb_assets SET origin='foilbury_original' WHERE id='ast_test_subject'",
    ).run();
    const npc = await createNpc(owner, { name: "Mira", presetKey: "completionist" });
    const npcUser = (await getNpc(owner, npc.id)).row.user_id;
    await runtime.DB.batch([
      runtime.DB.prepare(
        `INSERT INTO fb_card_definitions (id,tenant_id,logical_id,slug,name,description,status,created_at,updated_at)
        SELECT 'crd_npc_want',tenant_id,'npc:want','npc-want','Wanted Card',description,status,created_at,updated_at FROM fb_card_definitions WHERE id=?`,
      ).bind(original.cardId),
      runtime.DB.prepare(
        `INSERT INTO fb_artwork_editions (id,tenant_id,card_id,name,subject_asset_id,background_asset_id,recipe_id,status,created_at)
        SELECT 'edt_npc_want',tenant_id,'crd_npc_want',name,subject_asset_id,background_asset_id,recipe_id,status,created_at FROM fb_artwork_editions WHERE card_id=?`,
      ).bind(original.cardId),
      runtime.DB.prepare(
        `INSERT INTO fb_variants (id,tenant_id,card_id,edition_id,material_id,effect_id,name,status,created_at)
        SELECT 'var_npc_want',tenant_id,'crd_npc_want','edt_npc_want',material_id,effect_id,name,status,created_at FROM fb_variants WHERE id=?`,
      ).bind(original.variantId),
      runtime.DB.prepare(
        "INSERT INTO fb_collection_cards (collection_id,card_id,tenant_id,sort,added_by,added_at) SELECT collection_id,'crd_npc_want',tenant_id,1,'test',added_at FROM fb_collection_cards WHERE card_id=?",
      ).bind(original.cardId),
    ]);
    const offered = await makeInstance(
      player,
      player.user!.id,
      { cardId: "crd_npc_want", variantId: "var_npc_want" },
      "HUMAN-WANT",
    );
    const requested = await makeInstance(owner, npcUser, original, "NPC-SPARE-1");
    await makeInstance(owner, npcUser, original, "NPC-SPARE-2");
    return { owner, player, npc, npcUser, offered, requested };
  }

  async function hiddenPrint(
    cardId: string,
    variantId: string,
    origin: "foilbury_original" | "ai_generated",
  ) {
    await runtime.DB.batch([
      runtime.DB.prepare(
        `INSERT INTO fb_assets (id,tenant_id,kind,name,mime,width,height,bytes,r2_key,sha256,visibility,created_at,origin)
        SELECT 'ast_hidden_print',tenant_id,kind,'other print',mime,width,height,bytes,'test/hidden-print.png',sha256,visibility,created_at,? FROM fb_assets WHERE id='ast_test_subject'`,
      ).bind(origin),
      runtime.DB.prepare(
        `INSERT INTO fb_artwork_editions (id,tenant_id,card_id,name,subject_asset_id,background_asset_id,recipe_id,status,created_at)
        SELECT 'edt_hidden_print',tenant_id,card_id,'other edition','ast_hidden_print',background_asset_id,recipe_id,status,created_at FROM fb_artwork_editions WHERE card_id=? LIMIT 1`,
      ).bind(cardId),
      runtime.DB.prepare(
        `INSERT INTO fb_variants (id,tenant_id,card_id,edition_id,material_id,effect_id,name,status,created_at)
        SELECT 'var_hidden_print',tenant_id,card_id,'edt_hidden_print',material_id,effect_id,'other finish',status,created_at FROM fb_variants WHERE id=?`,
      ).bind(variantId),
    ]);
  }

  it("assesses real copies without reserving, transferring or writing a trade", async () => {
    const f = await setup();
    const preview = await previewNpcTrade(f.player, f.npc.id, f.offered, f.requested);
    expect(preview).toMatchObject({
      decision: "interested",
      preview_only: true,
      give: { serial: "HUMAN-WANT" },
      receive: { serial: "NPC-SPARE-1" },
    });
    const copies = await runtime.DB.prepare(
      "SELECT id,user_id,status,reserved_for FROM fb_card_instances WHERE id IN (?,?) ORDER BY id",
    )
      .bind(f.offered, f.requested)
      .all<{ id: string; user_id: string; status: string; reserved_for: string | null }>();
    expect(copies.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: f.offered,
          user_id: f.player.user!.id,
          status: "owned",
          reserved_for: null,
        }),
        expect.objectContaining({
          id: f.requested,
          user_id: f.npcUser,
          status: "owned",
          reserved_for: null,
        }),
      ]),
    );
    expect(
      (await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_trades").first<{ n: number }>())?.n,
    ).toBe(0);
    const path = `npcs/${f.npc.id}/trade-preview`;
    const response = await routeApi(
      new Request(`http://localhost/api/v1/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-foilbury-csrf": "test" },
        body: JSON.stringify({ offeredInstanceId: f.offered, requestedInstanceId: f.requested }),
      }),
      f.player,
      path,
    );
    expect(await response.json()).toMatchObject({ decision: "interested", preview_only: true });
  });

  it("persists the NPC decision and atomically exchanges exact copies on confirmation", async () => {
    const f = await setup();
    const offer = await createNpcTradeOffer(
      f.player,
      f.npc.id,
      f.offered,
      f.requested,
      "npc-trade-key-001",
    );
    expect(offer).toMatchObject({ decision: "interested", status: "open", replayed: false });
    await expect(acceptTrade(f.player, offer.trade_id)).rejects.toMatchObject({
      code: "trade_not_found",
    });
    await expect(cancelTrade(f.player, offer.trade_id)).rejects.toMatchObject({
      code: "trade_not_found",
    });
    const repeated = await createNpcTradeOffer(
      f.player,
      f.npc.id,
      f.offered,
      f.requested,
      "npc-trade-key-001",
    );
    expect(repeated).toMatchObject({ trade_id: offer.trade_id, status: "open", replayed: true });
    await expect(
      createNpcTradeOffer(f.player, f.npc.id, f.requested, f.offered, "npc-trade-key-001"),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(await confirmNpcTrade(f.player, offer.trade_id)).toMatchObject({
      status: "completed",
      replayed: false,
    });
    expect(await confirmNpcTrade(f.player, offer.trade_id)).toMatchObject({
      status: "completed",
      replayed: true,
    });
    const copies = await runtime.DB.prepare(
      "SELECT id,user_id,status,serial,reserved_for FROM fb_card_instances WHERE id IN (?,?)",
    )
      .bind(f.offered, f.requested)
      .all();
    expect(copies.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: f.offered,
          user_id: f.npcUser,
          status: "owned",
          serial: "HUMAN-WANT",
          reserved_for: null,
        }),
        expect.objectContaining({
          id: f.requested,
          user_id: f.player.user!.id,
          status: "owned",
          serial: "NPC-SPARE-1",
          reserved_for: null,
        }),
      ]),
    );
    expect(
      (
        await runtime.DB.prepare(
          "SELECT COUNT(*) n FROM fb_instance_history WHERE reference_type='npc_trade' AND reference_id=?",
        )
          .bind(offer.trade_id)
          .first<{ n: number }>()
      )?.n,
    ).toBe(2);
  });

  it("does not expose NPC items through generic trade reads after collection revocation", async () => {
    const f = await setup();
    const offer = await createNpcTradeOffer(
      f.player,
      f.npc.id,
      f.offered,
      f.requested,
      "npc-generic-hidden",
    );
    await runtime.DB.prepare(
      "UPDATE fb_bot_collections SET enabled=0 WHERE collection_id='col_test_public'",
    ).run();
    await expect(getTrade(f.player, offer.trade_id)).rejects.toMatchObject({
      code: "trade_not_found",
    });
    expect((await listTrades(f.player)).some((row) => row.id === offer.trade_id)).toBe(false);
  });

  it("runs a signed, private Discord suggestion → offer → confirmation with exact real copies", async () => {
    const f = await setup(),
      now = new Date().toISOString();
    const app = "1566702936615026769",
      guild = "997734945206313041",
      channel = "1566700752385081355",
      discordUser = "707281352818425929";
    await runtime.DB.prepare(
      `INSERT INTO fb_discord_installations (id,tenant_id,application_id,guild_id,guild_name,channel_allowlist_json,game_enabled,active,created_at,updated_at) VALUES ('npc-discord-install',?,?,?,'fixture',?,1,1,?,?)`,
    )
      .bind(f.player.tenant.id, app, guild, JSON.stringify([channel]), now, now)
      .run();
    await runtime.DB.prepare(
      "INSERT INTO fb_discord_identities (id,tenant_id,discord_user_id,user_id,linked_at,last_seen_at) VALUES ('npc-discord-user',?,?,?,?,?)",
    )
      .bind(f.player.tenant.id, discordUser, f.player.user!.id, now, now)
      .run();
    const keys = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const rawKey = await crypto.subtle.exportKey("raw", keys.publicKey);
    const publicKey = Array.from(new Uint8Array(rawKey), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const env = new Proxy(runtime as unknown as DiscordEnv, {
      get(target, key) {
        if (key === "DISCORD_APPLICATION_ID") return app;
        if (key === "DISCORD_PUBLIC_KEY") return publicKey;
        if (key === "FOILBURY_PUBLIC_ORIGIN") return "https://foilbury.test";
        return Reflect.get(target, key, target);
      },
    });
    async function send(customId: string, id: string, user = discordUser, signWrong = false) {
      const body = JSON.stringify({
        id,
        application_id: app,
        type: 3,
        token: "fixture-token",
        guild_id: guild,
        channel_id: channel,
        member: { user: { id: user, username: "fixture" } },
        data: { custom_id: customId, component_type: 2 },
      });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = await signDiscordRequest({
        body: signWrong ? body + "tampered" : body,
        timestamp,
        privateKey: keys.privateKey,
      });
      const response = await handleDiscordInteraction(
        new Request("https://foilbury.test/api/discord/interactions", {
          method: "POST",
          headers: { "x-signature-ed25519": signature, "x-signature-timestamp": timestamp },
          body,
        }),
        env,
        { publicKey },
      );
      return {
        status: response.status,
        payload: (await response.json()) as {
          data?: {
            flags?: number;
            content?: string;
            embeds?: Array<{ title?: string; description?: string }>;
            components?: Array<{ components?: Array<{ custom_id?: string; label?: string }> }>;
          };
        },
      };
    }
    const ideas = await send(`fnt:b:${f.npc.id}`, "123456789012345671");
    expect(ideas.payload.data?.flags).toBe(64);
    const offerButton = ideas.payload.data?.components
      ?.flatMap((row) => row.components ?? [])
      .find((item) => item.label === "Review idea 1")?.custom_id;
    expect(offerButton).toBeTruthy();
    expect((await send(offerButton!, "123456789012345672", discordUser, true)).status).toBe(401);
    const offered = await send(offerButton!, "123456789012345673");
    expect(offered.payload.data?.flags).toBe(64);
    expect(offered.payload.data?.embeds?.[0]?.title).toBe("Review your offer");
    const confirm = offered.payload.data?.components
      ?.flatMap((row) => row.components ?? [])
      .find((item) => item.label === "Confirm trade")?.custom_id;
    expect(confirm).toBeTruthy();
    const openOffers = await send("fnt:l", "123456789012345677");
    const review = openOffers.payload.data?.components
      ?.flatMap((row) => row.components ?? [])
      .find((item) => item.label === "Review offer 1")?.custom_id;
    expect(review).toBeTruthy();
    const reviewed = await send(review!, "123456789012345678");
    expect(reviewed.payload.data?.embeds?.[0]?.description).toContain("HUMAN-WANT");
    const other = await send(confirm!, "123456789012345674", "707281352818425930");
    expect(JSON.stringify(other.payload)).not.toContain("Trade complete");
    const completed = await send(confirm!, "123456789012345675");
    expect(completed.payload.data?.flags).toBe(64);
    expect(completed.payload.data?.embeds?.[0]?.title).toBe("Trade complete");
    expect(completed.payload.data?.embeds?.[0]?.description).toContain("HUMAN-WANT");
    expect((await send(confirm!, "123456789012345676")).payload.data?.embeds?.[0]?.title).toBe(
      "Trade complete",
    );
    expect(
      (
        await runtime.DB.prepare(
          "SELECT COUNT(*) n FROM fb_instance_history WHERE reference_type='npc_trade'",
        ).first<{ n: number }>()
      )?.n,
    ).toBe(2);
  });

  it("binds Discord offers to live identity, installation allowlist and channel audience", async () => {
    const f = await setup(),
      now = new Date().toISOString();
    const app = "1566702936615026769",
      guild = "997734945206313041",
      channel = "1566700752385081355",
      discordUser = "707281352818425929";
    await runtime.DB.prepare(
      `INSERT INTO fb_discord_installations (id,tenant_id,application_id,guild_id,guild_name,channel_allowlist_json,game_enabled,active,created_at,updated_at) VALUES ('npc-scope-install',?,?,?,'fixture',?,1,1,?,?)`,
    )
      .bind(f.player.tenant.id, app, guild, JSON.stringify([channel]), now, now)
      .run();
    await runtime.DB.prepare(
      "INSERT INTO fb_discord_identities (id,tenant_id,discord_user_id,user_id,linked_at,last_seen_at) VALUES ('npc-scope-user',?,?,?,?,?)",
    )
      .bind(f.player.tenant.id, discordUser, f.player.user!.id, now, now)
      .run();
    const discord = {
      ...f.player,
      sessionId: null,
      discordPrincipal: {
        discordUserId: discordUser,
        applicationId: app,
        guildId: guild,
        channelId: channel,
      },
    };
    expect((await suggestNpcTradeOffers(discord, f.npc.id)).length).toBeGreaterThan(0);
    await runtime.DB.prepare(
      "UPDATE fb_discord_installations SET collection_allowlist_json='[]' WHERE id='npc-scope-install'",
    ).run();
    expect(await suggestNpcTradeOffers(discord, f.npc.id)).toEqual([]);
    await runtime.DB.prepare(
      "UPDATE fb_discord_installations SET collection_allowlist_json=NULL WHERE id='npc-scope-install'",
    ).run();
    await runtime.DB.prepare(
      "UPDATE fb_collections SET view_audience='members',public_approved_at=NULL WHERE id='col_test_public'",
    ).run();
    expect(await suggestNpcTradeOffers(discord, f.npc.id)).toEqual([]);
    await runtime.DB.prepare(
      "UPDATE fb_discord_installations SET channel_audience_json=? WHERE id='npc-scope-install'",
    )
      .bind(JSON.stringify({ [channel]: "members" }))
      .run();
    expect((await suggestNpcTradeOffers(discord, f.npc.id)).length).toBeGreaterThan(0);
    for (const pair of [
      ["members", "public"],
      ["public", "members"],
    ]) {
      await runtime.DB.prepare(
        "UPDATE fb_discord_installations SET channel_audience_json=? WHERE id='npc-scope-install'",
      )
        .bind(`{"${channel}":"${pair[0]}","${channel}":"${pair[1]}"}`)
        .run();
      expect(await suggestNpcTradeOffers(discord, f.npc.id)).toEqual([]);
      await expect(
        createNpcTradeOffer(
          discord,
          f.npc.id,
          f.offered,
          f.requested,
          `discord-duplicate-${pair[0]}`,
        ),
      ).rejects.toMatchObject({ code: "npc_offer_unavailable" });
    }
    await runtime.DB.prepare(
      "UPDATE fb_discord_installations SET channel_audience_json=? WHERE id='npc-scope-install'",
    )
      .bind(JSON.stringify({ [channel]: "members" }))
      .run();
    const offer = await createNpcTradeOffer(
      discord,
      f.npc.id,
      f.offered,
      f.requested,
      "discord-scope-offer",
    );
    for (const pair of [
      ["members", "public"],
      ["public", "members"],
    ]) {
      await runtime.DB.prepare(
        "UPDATE fb_discord_installations SET channel_audience_json=? WHERE id='npc-scope-install'",
      )
        .bind(`{"${channel}":"${pair[0]}","${channel}":"${pair[1]}"}`)
        .run();
      await expect(confirmNpcTrade(discord, offer.trade_id)).rejects.toMatchObject({
        code: "npc_offer_changed",
      });
    }
    expect(
      (
        await runtime.DB.prepare(
          "SELECT COUNT(*) n FROM fb_instance_history WHERE reference_type='npc_trade'",
        ).first<{ n: number }>()
      )?.n,
    ).toBe(0);
    await runtime.DB.prepare(
      "UPDATE fb_discord_identities SET revoked_at=? WHERE id='npc-scope-user'",
    )
      .bind(now)
      .run();
    expect(await listNpcTradeOffers(discord)).toEqual([]);
  });

  it("limits suggestions after audience checks, so hidden newer copies cannot displace a valid offer", async () => {
    const f = await setup(),
      now = new Date().toISOString();
    await runtime.DB.batch([
      runtime.DB.prepare(
        "INSERT INTO fb_card_definitions (id,tenant_id,logical_id,slug,name,description,status,created_at,updated_at) SELECT 'hidden_npc_card',tenant_id,'hidden:npc','hidden-npc','SECRET HIDDEN',description,status,created_at,updated_at FROM fb_card_definitions WHERE id='crd_npc_want'",
      ),
      runtime.DB.prepare(
        "INSERT INTO fb_artwork_editions (id,tenant_id,card_id,name,subject_asset_id,background_asset_id,recipe_id,status,created_at) SELECT 'hidden_npc_edition',tenant_id,'hidden_npc_card',name,subject_asset_id,background_asset_id,recipe_id,status,created_at FROM fb_artwork_editions WHERE id='edt_npc_want'",
      ),
      runtime.DB.prepare(
        "INSERT INTO fb_variants (id,tenant_id,card_id,edition_id,material_id,effect_id,name,status,created_at) SELECT 'hidden_npc_variant',tenant_id,'hidden_npc_card','hidden_npc_edition',material_id,effect_id,name,status,created_at FROM fb_variants WHERE id='var_npc_want'",
      ),
      runtime.DB.prepare(
        "INSERT INTO fb_collections (id,slug,name,description,scope,owner_tenant_id,status,view_audience,created_by,created_at,updated_at) VALUES ('hidden_npc_collection','hidden-npc','Hidden','test','global',?,'published','private','fixture',?,?)",
      ).bind(f.player.tenant.id, now, now),
      runtime.DB.prepare(
        "INSERT INTO fb_collection_cards (collection_id,card_id,tenant_id,sort,added_by,added_at) VALUES ('hidden_npc_collection','hidden_npc_card',?,0,'fixture',?)",
      ).bind(f.player.tenant.id, now),
      runtime.DB.prepare(
        "INSERT INTO fb_bot_collections (bot_id,collection_id,enabled,updated_at) SELECT id,'hidden_npc_collection',1,? FROM fb_bots WHERE tenant_id=?",
      ).bind(now, f.player.tenant.id),
    ]);
    for (let index = 0; index < 7; index++) {
      const id = await makeInstance(
        f.player,
        f.player.user!.id,
        { cardId: "hidden_npc_card", variantId: "hidden_npc_variant" },
        `HIDDEN-${index}`,
      );
      await runtime.DB.prepare(
        "UPDATE fb_card_instances SET acquired_at='9999-01-01T00:00:00.000Z' WHERE id=?",
      )
        .bind(id)
        .run();
    }
    const suggestions = await suggestNpcTradeOffers(f.player, f.npc.id);
    expect(
      suggestions.some(
        (item) => item.give.instance_id === f.offered && item.receive.instance_id === f.requested,
      ),
    ).toBe(true);
    expect(JSON.stringify(suggestions)).not.toMatch(/SECRET HIDDEN|HIDDEN-/);
  });

  it("caps each authorized suggestion side with a 1,000-copy local latency budget", async () => {
    const f = await setup(),
      now = new Date().toISOString();
    for (const side of ["player", "npc"] as const) {
      const isPlayer = side === "player",
        userId = isPlayer ? f.player.user!.id : f.npcUser,
        card = isPlayer ? "crd_npc_want" : "crd_test_card",
        variant = isPlayer ? "var_npc_want" : "var_test_variant";
      await runtime.DB.batch(
        Array.from({ length: 500 }, (_, index) =>
          runtime.DB.prepare(
            "INSERT INTO fb_card_instances (id,tenant_id,user_id,card_id,variant_id,serial,acquired_via,acquired_at,status,favourite,locked,updated_at) VALUES (?,?,?,?,?,?,'test',?,'owned',0,0,?)",
          ).bind(
            `perf_${side}_${String(index).padStart(4, "0")}`,
            f.player.tenant.id,
            userId,
            card,
            variant,
            `PERF-${side}-${index}`,
            now,
            now,
          ),
        ),
      );
    }
    const playerQuery = npcTradeCandidateQuery(f.player, f.npc.id, "player"),
      npcQuery = npcTradeCandidateQuery(f.player, f.npc.id, "npc");
    const plan = await runtime.DB.prepare(`EXPLAIN QUERY PLAN ${playerQuery.sql}`)
      .bind(...playerQuery.args)
      .all<{ detail: string }>();
    expect(plan.results.some((row) => row.detail.includes("fb_npc_trade_candidate_idx"))).toBe(
      true,
    );
    const start = Date.now();
    const [mine, theirs, suggestions] = await Promise.all([
      runtime.DB.prepare(playerQuery.sql)
        .bind(...playerQuery.args)
        .all(),
      runtime.DB.prepare(npcQuery.sql)
        .bind(...npcQuery.args)
        .all(),
      suggestNpcTradeOffers(f.player, f.npc.id),
    ]);
    const elapsed = Date.now() - start;
    expect(mine.results).toHaveLength(24);
    expect(theirs.results).toHaveLength(24);
    expect(suggestions).toHaveLength(3);
    expect(elapsed).toBeLessThan(5000);
    console.info(`NPC suggestion fixture: 1000 added copies, 24×24 candidates, ${elapsed}ms`);
  });

  it("cancels an open offer and idempotently releases both reservations", async () => {
    const f = await setup();
    const offer = await createNpcTradeOffer(
      f.player,
      f.npc.id,
      f.offered,
      f.requested,
      "npc-cancel-001",
    );
    expect(await cancelNpcTrade(f.player, offer.trade_id)).toMatchObject({
      status: "cancelled",
      replayed: false,
    });
    expect(await cancelNpcTrade(f.player, offer.trade_id)).toMatchObject({
      status: "cancelled",
      replayed: true,
    });
    const copies = await runtime.DB.prepare(
      "SELECT user_id,status,reserved_for FROM fb_card_instances WHERE id IN (?,?)",
    )
      .bind(f.offered, f.requested)
      .all();
    expect(copies.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          user_id: f.player.user!.id,
          status: "owned",
          reserved_for: null,
        }),
        expect.objectContaining({ user_id: f.npcUser, status: "owned", reserved_for: null }),
      ]),
    );
    await expect(confirmNpcTrade(f.player, offer.trade_id)).rejects.toMatchObject({
      code: "trade_not_open",
    });
  });

  it("expires an old offer and releases its copies before declining confirmation", async () => {
    const f = await setup();
    const offer = await createNpcTradeOffer(
      f.player,
      f.npc.id,
      f.offered,
      f.requested,
      "npc-expiry-001",
    );
    await runtime.DB.prepare(
      "UPDATE fb_trades SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?",
    )
      .bind(offer.trade_id)
      .run();
    await expect(confirmNpcTrade(f.player, offer.trade_id)).rejects.toMatchObject({
      code: "trade_expired",
    });
    expect(
      (
        await runtime.DB.prepare("SELECT status FROM fb_trades WHERE id=?")
          .bind(offer.trade_id)
          .first<{ status: string }>()
      )?.status,
    ).toBe("expired");
    expect(
      (
        await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_card_instances WHERE reserved_for=?")
          .bind(offer.trade_id)
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
  });

  it("expires abandoned offers even after the player is revoked", async () => {
    const f = await setup();
    const offer = await createNpcTradeOffer(
      f.player,
      f.npc.id,
      f.offered,
      f.requested,
      "npc-abandoned-001",
    );
    await runtime.DB.prepare(
      "UPDATE fb_trades SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?",
    )
      .bind(offer.trade_id)
      .run();
    await runtime.DB.prepare(
      "UPDATE fb_memberships SET status='revoked' WHERE tenant_id=? AND user_id=?",
    )
      .bind(f.player.tenant.id, f.player.user!.id)
      .run();
    expect(await expireNpcTradeOffers(runtime.DB)).toMatchObject({ expired: 1 });
    expect(await expireNpcTradeOffers(runtime.DB)).toMatchObject({ expired: 0 });
    expect(
      (
        await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_card_instances WHERE reserved_for=?")
          .bind(offer.trade_id)
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
    expect(
      (
        await runtime.DB.prepare(
          "SELECT COUNT(*) n FROM fb_audit_events WHERE action='npc.trade.expired' AND object_id=?",
        )
          .bind(offer.trade_id)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
  });

  it("continues past a poisoned prefix while retaining its failed records for repair", async () => {
    const f = await setup(),
      now = new Date().toISOString();
    const offer = await createNpcTradeOffer(
      f.player,
      f.npc.id,
      f.offered,
      f.requested,
      "npc-poison-prefix",
    );
    await runtime.DB.prepare(
      "UPDATE fb_trades SET expires_at='2001-01-01T00:00:00.000Z' WHERE id=?",
    )
      .bind(offer.trade_id)
      .run();
    for (let index = 0; index < 20; index++) {
      const id = `poison-${String(index).padStart(2, "0")}`;
      await runtime.DB.batch([
        runtime.DB.prepare(
          "INSERT INTO fb_trades (id,tenant_id,proposer_id,recipient_id,status,revision,expires_at,created_at,updated_at) VALUES (?,?,?,?,'open',1,'2000-01-01T00:00:00.000Z',?,?)",
        ).bind(id, f.player.tenant.id, f.player.user!.id, f.npcUser, now, now),
        runtime.DB.prepare(
          "INSERT INTO fb_npc_trade_offers (trade_id,tenant_id,player_id,npc_id,offered_instance_id,requested_instance_id,idempotency_key,request_digest,decision,reason,created_at) VALUES (?,?,?,?,?,?,?,?,'interested','fixture',?)",
        ).bind(
          id,
          f.player.tenant.id,
          f.player.user!.id,
          f.npc.id,
          f.offered,
          f.requested,
          `poison-key-${index}`,
          `poison-digest-${index}`,
          now,
        ),
      ]);
    }
    await expect(expireNpcTradeOffers(runtime.DB)).rejects.toThrow(
      "could not safely release 20 offer(s)",
    );
    expect(await expireNpcTradeOffers(runtime.DB)).toMatchObject({ expired: 1 });
    expect(
      (
        await runtime.DB.prepare("SELECT status FROM fb_trades WHERE id=?")
          .bind(offer.trade_id)
          .first<{ status: string }>()
      )?.status,
    ).toBe("expired");
    expect(
      (
        await runtime.DB.prepare(
          "SELECT COUNT(*) n FROM fb_trades WHERE id LIKE 'poison-%' AND status='open'",
        ).first<{ n: number }>()
      )?.n,
    ).toBe(20);
  });

  it("does not overwrite a concurrent expiry cursor update", async () => {
    await setup();
    let injected = false;
    const db = new Proxy(runtime.DB, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (!sql.startsWith("UPDATE fb_npc_trade_expiry_cursor")) return statement;
            return new Proxy(statement, {
              get(prepared, method) {
                if (method === "bind")
                  return (...args: unknown[]) => {
                    const bound = prepared.bind(...args);
                    return new Proxy(bound, {
                      get(query, operation) {
                        if (operation === "all")
                          return async () => {
                            if (!injected) {
                              injected = true;
                              await target
                                .prepare(
                                  "UPDATE fb_npc_trade_expiry_cursor SET expires_at='2000-01-01T00:00:00.000Z',trade_id='another-run',revision=revision+1 WHERE id=1",
                                )
                                .run();
                            }
                            return query.all();
                          };
                        const value = Reflect.get(query, operation, query);
                        return typeof value === "function" ? value.bind(query) : value;
                      },
                    });
                  };
                const value = Reflect.get(prepared, method, prepared);
                return typeof value === "function" ? value.bind(prepared) : value;
              },
            });
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expireNpcTradeOffers(db);
    expect(injected).toBe(true);
    expect(
      await runtime.DB.prepare(
        "SELECT trade_id,revision FROM fb_npc_trade_expiry_cursor WHERE id=1",
      ).first(),
    ).toMatchObject({ trade_id: "another-run", revision: 1 });
  });

  it("alerts if the expiry cursor disappears during its update", async () => {
    await setup();
    const db = new Proxy(runtime.DB, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (!sql.startsWith("UPDATE fb_npc_trade_expiry_cursor")) return statement;
            return new Proxy(statement, {
              get(prepared, method) {
                if (method === "bind")
                  return (...args: unknown[]) => {
                    const bound = prepared.bind(...args);
                    return new Proxy(bound, {
                      get(query, operation) {
                        if (operation === "all")
                          return async () => {
                            await target
                              .prepare("DELETE FROM fb_npc_trade_expiry_cursor WHERE id=1")
                              .run();
                            return query.all();
                          };
                        const value = Reflect.get(query, operation, query);
                        return typeof value === "function" ? value.bind(query) : value;
                      },
                    });
                  };
                const value = Reflect.get(prepared, method, prepared);
                return typeof value === "function" ? value.bind(prepared) : value;
              },
            });
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(expireNpcTradeOffers(db)).rejects.toThrow("cursor could not be advanced");
  });

  it("does not double-release if cancellation wins the expiry race", async () => {
    const f = await setup();
    const offer = await createNpcTradeOffer(
      f.player,
      f.npc.id,
      f.offered,
      f.requested,
      "npc-expiry-cancel-race",
    );
    await runtime.DB.prepare(
      "UPDATE fb_trades SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?",
    )
      .bind(offer.trade_id)
      .run();
    let injected = false;
    const db = new Proxy(runtime.DB, {
      get(target, key) {
        if (key === "batch")
          return async (statements: D1PreparedStatement[]) => {
            if (!injected) {
              injected = true;
              await cancelNpcTrade(f.player, offer.trade_id);
            }
            return target.batch(statements);
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    expect(await expireNpcTradeOffers(db)).toMatchObject({ expired: 0 });
    expect(injected).toBe(true);
    expect(
      (
        await runtime.DB.prepare("SELECT status FROM fb_trades WHERE id=?")
          .bind(offer.trade_id)
          .first<{ status: string }>()
      )?.status,
    ).toBe("cancelled");
    expect(
      (
        await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_card_instances WHERE reserved_for=?")
          .bind(offer.trade_id)
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
  });

  it("does not transfer if expiry wins the confirmation race", async () => {
    const f = await setup();
    const offer = await createNpcTradeOffer(
      f.player,
      f.npc.id,
      f.offered,
      f.requested,
      "npc-expiry-confirm-race",
    );
    let injected = false;
    const db = new Proxy(runtime.DB, {
      get(target, key) {
        if (key === "batch")
          return async (statements: D1PreparedStatement[]) => {
            if (!injected) {
              injected = true;
              await target
                .prepare("UPDATE fb_trades SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?")
                .bind(offer.trade_id)
                .run();
              await expireNpcTradeOffers(target);
            }
            return target.batch(statements);
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(confirmNpcTrade({ ...f.player, db }, offer.trade_id)).rejects.toMatchObject({
      code: "npc_offer_changed",
    });
    expect(injected).toBe(true);
    expect(
      (
        await runtime.DB.prepare("SELECT status FROM fb_trades WHERE id=?")
          .bind(offer.trade_id)
          .first<{ status: string }>()
      )?.status,
    ).toBe("expired");
    const cards = await runtime.DB.prepare(
      "SELECT id,user_id,status FROM fb_card_instances WHERE id IN (?,?)",
    )
      .bind(f.offered, f.requested)
      .all();
    expect(cards.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: f.offered, user_id: f.player.user!.id, status: "owned" }),
        expect.objectContaining({ id: f.requested, user_id: f.npcUser, status: "owned" }),
      ]),
    );
  });

  it("lists only minimal offer state and stops after the player session is revoked", async () => {
    const f = await setup();
    const offer = await createNpcTradeOffer(
      f.player,
      f.npc.id,
      f.offered,
      f.requested,
      "npc-list-offer-001",
    );
    await runtime.DB.prepare(
      "UPDATE fb_bot_collections SET enabled=0 WHERE collection_id='col_test_public'",
    ).run();
    const listed = await listNpcTradeOffers(f.player);
    expect(listed).toEqual([expect.objectContaining({ trade_id: offer.trade_id, status: "open" })]);
    expect(JSON.stringify(listed)).not.toMatch(/HUMAN-WANT|NPC-SPARE|Wanted Card|Test One/);
    await runtime.DB.prepare("UPDATE fb_sessions SET revoked_at=? WHERE id=?")
      .bind(new Date().toISOString(), f.player.sessionId)
      .run();
    expect(await listNpcTradeOffers(f.player)).toEqual([]);
  });

  it.each([
    "NPC paused",
    "collection disabled",
    "player revoked",
    "session revoked",
    "copy locked",
    "AI dependency",
  ])("fails confirmation atomically if %s", async (condition) => {
    const f = await setup();
    const offer = await createNpcTradeOffer(
      f.player,
      f.npc.id,
      f.offered,
      f.requested,
      "npc-race-001",
    );
    if (condition === "NPC paused")
      await runtime.DB.prepare("UPDATE fb_npc_collectors SET status='paused' WHERE id=?")
        .bind(f.npc.id)
        .run();
    if (condition === "collection disabled")
      await runtime.DB.prepare(
        "UPDATE fb_bot_collections SET enabled=0 WHERE collection_id='col_test_public'",
      ).run();
    if (condition === "player revoked")
      await runtime.DB.prepare(
        "UPDATE fb_memberships SET status='revoked' WHERE tenant_id=? AND user_id=?",
      )
        .bind(f.player.tenant.id, f.player.user!.id)
        .run();
    if (condition === "session revoked")
      await runtime.DB.prepare("UPDATE fb_sessions SET revoked_at=? WHERE id=?")
        .bind(new Date().toISOString(), f.player.sessionId)
        .run();
    if (condition === "copy locked")
      await runtime.DB.prepare("UPDATE fb_card_instances SET locked=1 WHERE id=?")
        .bind(f.requested)
        .run();
    if (condition === "AI dependency")
      await runtime.DB.prepare(
        "UPDATE fb_assets SET dependencies_json='[\"unknown-asset\"]' WHERE id='ast_test_subject'",
      ).run();
    await expect(confirmNpcTrade(f.player, offer.trade_id)).rejects.toBeTruthy();
    const copies = await runtime.DB.prepare(
      "SELECT id,user_id,status,reserved_for FROM fb_card_instances WHERE id IN (?,?)",
    )
      .bind(f.offered, f.requested)
      .all();
    expect(copies.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: f.offered,
          user_id: f.player.user!.id,
          status: "reserved",
          reserved_for: offer.trade_id,
        }),
        expect.objectContaining({
          id: f.requested,
          user_id: f.npcUser,
          status: "reserved",
          reserved_for: offer.trade_id,
        }),
      ]),
    );
    expect(
      (
        await runtime.DB.prepare(
          "SELECT COUNT(*) n FROM fb_instance_history WHERE reference_type='npc_trade' AND reference_id=?",
        )
          .bind(offer.trade_id)
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
  });

  it.each(["create", "confirm"])(
    "rechecks collection state inside the %s batch",
    async (operation) => {
      const f = await setup();
      const offer =
        operation === "confirm"
          ? await createNpcTradeOffer(f.player, f.npc.id, f.offered, f.requested, "npc-batch-race")
          : null;
      let injected = false;
      const db = new Proxy(runtime.DB, {
        get(target, key) {
          if (key === "batch")
            return async (statements: D1PreparedStatement[]) => {
              if (!injected) {
                injected = true;
                await target
                  .prepare(
                    "UPDATE fb_bot_collections SET enabled=0 WHERE collection_id='col_test_public'",
                  )
                  .run();
              }
              return target.batch(statements);
            };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const player = { ...f.player, db };
      const result =
        operation === "create"
          ? createNpcTradeOffer(player, f.npc.id, f.offered, f.requested, "npc-batch-race")
          : confirmNpcTrade(player, offer!.trade_id);
      await expect(result).rejects.toMatchObject({ code: "npc_offer_changed" });
      expect(injected).toBe(true);
      const cards = await runtime.DB.prepare(
        "SELECT id,user_id,status FROM fb_card_instances WHERE id IN (?,?)",
      )
        .bind(f.offered, f.requested)
        .all();
      expect(cards.results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: f.offered,
            user_id: f.player.user!.id,
            status: offer ? "reserved" : "owned",
          }),
          expect.objectContaining({
            id: f.requested,
            user_id: f.npcUser,
            status: offer ? "reserved" : "owned",
          }),
        ]),
      );
      expect(
        (
          await runtime.DB.prepare(
            "SELECT COUNT(*) n FROM fb_instance_history WHERE reference_type='npc_trade'",
          ).first<{ n: number }>()
        )?.n,
      ).toBe(0);
    },
  );

  it("does not complete twice under simultaneous confirmation", async () => {
    const f = await setup();
    const offer = await createNpcTradeOffer(
      f.player,
      f.npc.id,
      f.offered,
      f.requested,
      "npc-concurrent-001",
    );
    const results = await Promise.all([
      confirmNpcTrade(f.player, offer.trade_id),
      confirmNpcTrade(f.player, offer.trade_id),
    ]);
    expect(results.every((result) => result.status === "completed")).toBe(true);
    expect(results.filter((result) => result.replayed)).toHaveLength(1);
    expect(
      (
        await runtime.DB.prepare(
          "SELECT COUNT(*) n FROM fb_instance_history WHERE reference_type='npc_trade' AND reference_id=?",
        )
          .bind(offer.trade_id)
          .first<{ n: number }>()
      )?.n,
    ).toBe(2);
  });

  it("does not claim no transfer when another confirmation commits and the caller is revoked", async () => {
    const f = await setup();
    const offer = await createNpcTradeOffer(
      f.player,
      f.npc.id,
      f.offered,
      f.requested,
      "npc-commit-revoke-race",
    );
    let injected = false;
    const db = new Proxy(runtime.DB, {
      get(target, key) {
        if (key === "batch")
          return async (statements: D1PreparedStatement[]) => {
            if (!injected) {
              injected = true;
              expect(await confirmNpcTrade(f.player, offer.trade_id)).toMatchObject({
                status: "completed",
              });
              await target
                .prepare("UPDATE fb_sessions SET revoked_at=? WHERE id=?")
                .bind(new Date().toISOString(), f.player.sessionId)
                .run();
            }
            return target.batch(statements);
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const error = await confirmNpcTrade({ ...f.player, db }, offer.trade_id).then(
      () => null,
      (e) => e,
    );
    expect(injected).toBe(true);
    expect(error).toMatchObject({ code: "npc_offer_changed" });
    expect(String(error.message)).not.toMatch(/nothing was transferred/i);
    expect(
      (
        await runtime.DB.prepare(
          "SELECT COUNT(*) n FROM fb_instance_history WHERE reference_type='npc_trade' AND reference_id=?",
        )
          .bind(offer.trade_id)
          .first<{ n: number }>()
      )?.n,
    ).toBe(2);
  });

  it("enforces the rolling player quota before reserving anything", async () => {
    const f = await setup();
    const now = new Date().toISOString();
    for (let index = 0; index < 3; index++) {
      const tradeId = `quota-trade-${index}`;
      await runtime.DB.batch([
        runtime.DB.prepare(
          "INSERT INTO fb_trades (id,tenant_id,proposer_id,recipient_id,status,revision,expires_at,created_at,updated_at,completed_at) VALUES (?,?,?,?,'completed',1,?,?,?,?)",
        ).bind(tradeId, f.player.tenant.id, f.player.user!.id, f.npcUser, now, now, now, now),
        runtime.DB.prepare(
          "INSERT INTO fb_npc_trade_offers (trade_id,tenant_id,player_id,npc_id,offered_instance_id,requested_instance_id,idempotency_key,request_digest,decision,reason,created_at) VALUES (?,?,?,?,?,?,?,?,'interested','fixture',?)",
        ).bind(
          tradeId,
          f.player.tenant.id,
          f.player.user!.id,
          f.npc.id,
          f.offered,
          f.requested,
          `quota-key-${index}`,
          `quota-digest-${index}`,
          now,
        ),
      ]);
    }
    await expect(
      createNpcTradeOffer(f.player, f.npc.id, f.offered, f.requested, "npc-quota-001"),
    ).rejects.toMatchObject({ code: "npc_offer_changed" });
    expect(
      (
        await runtime.DB.prepare(
          "SELECT COUNT(*) n FROM fb_card_instances WHERE id IN (?,?) AND status='owned'",
        )
          .bind(f.offered, f.requested)
          .first<{ n: number }>()
      )?.n,
    ).toBe(2);
  });

  it("bounds declined attempts even when two submissions race for the final slot", async () => {
    const f = await setup(),
      now = new Date().toISOString();
    await makeInstance(
      f.owner,
      f.npcUser,
      { cardId: "crd_npc_want", variantId: "var_npc_want" },
      "NPC-HAS-OFFER",
    );
    for (let index = 0; index < 19; index++) {
      const id = `attempt-${index}`;
      await runtime.DB.batch([
        runtime.DB.prepare(
          "INSERT INTO fb_trades (id,tenant_id,proposer_id,recipient_id,status,revision,expires_at,created_at,updated_at) VALUES (?,?,?,?,'declined',1,?,?,?)",
        ).bind(id, f.player.tenant.id, f.player.user!.id, f.npcUser, now, now, now),
        runtime.DB.prepare(
          "INSERT INTO fb_npc_trade_offers (trade_id,tenant_id,player_id,npc_id,offered_instance_id,requested_instance_id,idempotency_key,request_digest,decision,reason,created_at) VALUES (?,?,?,?,?,?,?,?,'declined','fixture',?)",
        ).bind(
          id,
          f.player.tenant.id,
          f.player.user!.id,
          f.npc.id,
          f.offered,
          f.requested,
          `attempt-key-${index}`,
          `attempt-digest-${index}`,
          now,
        ),
      ]);
    }
    const results = await Promise.allSettled([
      createNpcTradeOffer(f.player, f.npc.id, f.offered, f.requested, "npc-final-attempt-a"),
      createNpcTradeOffer(f.player, f.npc.id, f.offered, f.requested, "npc-final-attempt-b"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(
      (
        await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_npc_trade_offers WHERE player_id=?")
          .bind(f.player.user!.id)
          .first<{ n: number }>()
      )?.n,
    ).toBe(20);
  });

  it("blocks reusing a copy previously exchanged with the same NPC", async () => {
    const f = await setup();
    const now = new Date().toISOString(),
      tradeId = "past-npc-trade";
    await runtime.DB.batch([
      runtime.DB.prepare(
        "INSERT INTO fb_trades (id,tenant_id,proposer_id,recipient_id,status,revision,expires_at,created_at,updated_at,completed_at) VALUES (?,?,?,?,'completed',1,?,?,?,?)",
      ).bind(tradeId, f.player.tenant.id, f.player.user!.id, f.npcUser, now, now, now, now),
      runtime.DB.prepare(
        "INSERT INTO fb_npc_trade_offers (trade_id,tenant_id,player_id,npc_id,offered_instance_id,requested_instance_id,idempotency_key,request_digest,decision,reason,created_at) VALUES (?,?,?,?,?,?,'old-key','old-digest','interested','fixture',?)",
      ).bind(tradeId, f.player.tenant.id, f.player.user!.id, f.npc.id, f.offered, f.requested, now),
      runtime.DB.prepare(
        "INSERT INTO fb_instance_history (id,tenant_id,instance_id,event,from_user_id,to_user_id,reference_type,reference_id,metadata_json,created_at) VALUES ('past-trade-history',?,?,'traded',?,?,'npc_trade',?,'{}',?)",
      ).bind(f.player.tenant.id, f.offered, f.npcUser, f.player.user!.id, tradeId, now),
    ]);
    await expect(
      createNpcTradeOffer(f.player, f.npc.id, f.offered, f.requested, "npc-return-001"),
    ).rejects.toMatchObject({ code: "npc_offer_changed" });
    expect(
      (
        await runtime.DB.prepare(
          "SELECT COUNT(*) n FROM fb_card_instances WHERE id IN (?,?) AND status='owned'",
        )
          .bind(f.offered, f.requested)
          .first<{ n: number }>()
      )?.n,
    ).toBe(2);
  });

  it("persists a decline without reserving copies", async () => {
    const f = await setup();
    await makeInstance(
      f.owner,
      f.npcUser,
      { cardId: "crd_npc_want", variantId: "var_npc_want" },
      "NPC-ALREADY-WANTS",
    );
    const offer = await createNpcTradeOffer(
      f.player,
      f.npc.id,
      f.offered,
      f.requested,
      "npc-declined-001",
    );
    expect(offer).toMatchObject({ decision: "declined", status: "declined" });
    await expect(confirmNpcTrade(f.player, offer.trade_id)).rejects.toMatchObject({
      code: "trade_not_open",
    });
    expect(
      (
        await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_card_instances WHERE reserved_for=?")
          .bind(offer.trade_id)
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
  });

  it("does not persist a stale decline reason when holdings change before the batch", async () => {
    const f = await setup();
    const spare = await runtime.DB.prepare(
      "SELECT id FROM fb_card_instances WHERE user_id=? AND serial='NPC-SPARE-2'",
    )
      .bind(f.npcUser)
      .first<{ id: string }>();
    await runtime.DB.prepare("UPDATE fb_card_instances SET status='surrendered' WHERE id=?")
      .bind(spare!.id)
      .run();
    let injected = false;
    const db = new Proxy(runtime.DB, {
      get(target, key) {
        if (key === "batch")
          return async (statements: D1PreparedStatement[]) => {
            if (!injected) {
              injected = true;
              await target
                .prepare("UPDATE fb_card_instances SET status='owned' WHERE id=?")
                .bind(spare!.id)
                .run();
              await makeInstance(
                f.owner,
                f.npcUser,
                { cardId: "crd_npc_want", variantId: "var_npc_want" },
                "NPC-DECISION-RACE",
              );
            }
            return target.batch(statements);
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(
      createNpcTradeOffer(
        { ...f.player, db },
        f.npc.id,
        f.offered,
        f.requested,
        "npc-decline-race",
      ),
    ).rejects.toMatchObject({ code: "npc_offer_changed" });
    expect(injected).toBe(true);
    expect(
      (
        await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_npc_trade_offers").first<{
          n: number;
        }>()
      )?.n,
    ).toBe(0);
  });

  it("explains a decline when the NPC already owns the offered subject", async () => {
    const f = await setup();
    await makeInstance(
      f.owner,
      f.npcUser,
      { cardId: "crd_npc_want", variantId: "var_npc_want" },
      "NPC-HAS-WANT",
    );
    expect(await previewNpcTrade(f.player, f.npc.id, f.offered, f.requested)).toMatchObject({
      decision: "declined",
      reason: "This collector already has an eligible copy of that subject.",
    });
  });

  it("keeps the NPC's last copy", async () => {
    const f = await setup();
    await runtime.DB.prepare("UPDATE fb_card_instances SET locked=1 WHERE id=?")
      .bind(f.requested)
      .run();
    const spare = await runtime.DB.prepare(
      "SELECT id FROM fb_card_instances WHERE user_id=? AND serial='NPC-SPARE-2'",
    )
      .bind(f.npcUser)
      .first<{ id: string }>();
    await runtime.DB.prepare("UPDATE fb_card_instances SET status='surrendered' WHERE id=?")
      .bind(spare!.id)
      .run();
    await runtime.DB.prepare("UPDATE fb_card_instances SET locked=0 WHERE id=?")
      .bind(f.requested)
      .run();
    expect(await previewNpcTrade(f.player, f.npc.id, f.offered, f.requested)).toMatchObject({
      decision: "declined",
      reason: "This collector has no eligible spare to offer.",
    });
  });

  it("does not count an AI-only second print as a visible NPC spare", async () => {
    const f = await setup();
    await hiddenPrint("crd_test_card", "var_test_variant", "ai_generated");
    await runtime.DB.prepare(
      "UPDATE fb_card_instances SET variant_id='var_hidden_print' WHERE user_id=? AND serial='NPC-SPARE-2'",
    )
      .bind(f.npcUser)
      .run();
    expect(await previewNpcTrade(f.player, f.npc.id, f.offered, f.requested)).toMatchObject({
      decision: "declined",
      reason: "This collector has no eligible spare to offer.",
    });
    expect(await suggestNpcTradeOffers(f.player, f.npc.id)).toEqual([]);
  });

  it("does not reveal an AI-only owned copy through the NPC decision", async () => {
    const f = await setup();
    const before = await previewNpcTrade(f.player, f.npc.id, f.offered, f.requested);
    await hiddenPrint("crd_npc_want", "var_npc_want", "ai_generated");
    await makeInstance(
      f.owner,
      f.npcUser,
      { cardId: "crd_npc_want", variantId: "var_hidden_print" },
      "NPC-HIDDEN-OWNED",
    );
    expect(await previewNpcTrade(f.player, f.npc.id, f.offered, f.requested)).toEqual(before);
  });

  it("rechecks the visible spare when its second print becomes AI-only before confirmation", async () => {
    const f = await setup();
    await hiddenPrint("crd_test_card", "var_test_variant", "foilbury_original");
    await runtime.DB.prepare(
      "UPDATE fb_card_instances SET variant_id='var_hidden_print' WHERE user_id=? AND serial='NPC-SPARE-2'",
    )
      .bind(f.npcUser)
      .run();
    const offer = await createNpcTradeOffer(
      f.player,
      f.npc.id,
      f.offered,
      f.requested,
      "npc-hidden-spare-race",
    );
    let injected = false;
    const db = new Proxy(runtime.DB, {
      get(target, key) {
        if (key === "batch")
          return async (statements: D1PreparedStatement[]) => {
            if (!injected) {
              injected = true;
              await target
                .prepare("UPDATE fb_assets SET origin='ai_generated' WHERE id='ast_hidden_print'")
                .run();
            }
            return target.batch(statements);
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(confirmNpcTrade({ ...f.player, db }, offer.trade_id)).rejects.toMatchObject({
      code: "npc_offer_changed",
    });
    expect(injected).toBe(true);
    expect(
      (
        await runtime.DB.prepare(
          "SELECT COUNT(*) n FROM fb_instance_history WHERE reference_type='npc_trade' AND reference_id=?",
        )
          .bind(offer.trade_id)
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
  });

  it("rejects a different Bot and delegated agents", async () => {
    const f = await setup();
    const other = await ctxFor("harbour", "harbour.owner@foilbury.test");
    await expect(previewNpcTrade(other, f.npc.id, f.offered, f.requested)).rejects.toMatchObject({
      code: "npc_offer_unavailable",
    });
    const agent = {
      ...f.player,
      actor: {
        type: "agent" as const,
        id: "agent-fixture",
        representedUserId: f.player.user!.id,
        label: "fixture",
      },
      scopes: ["trade:write"],
    };
    await expect(previewNpcTrade(agent, f.npc.id, f.offered, f.requested)).rejects.toMatchObject({
      code: "human_player_required",
    });
  });

  it.each([
    "locked",
    "disabled collection",
    "private collection",
    "retired edition",
    "AI artwork",
    "AI dependency",
    "AI derivative",
    "malformed ancestry",
    "archived background",
    "foreign Bot collection",
    "revoked membership",
    "revoked session",
    "paused NPC",
    "foreign copy",
  ])("withholds unavailable offers: %s", async (condition) => {
    const f = await setup();
    if (condition === "locked")
      await runtime.DB.prepare("UPDATE fb_card_instances SET locked=1 WHERE id=?")
        .bind(f.requested)
        .run();
    if (condition === "disabled collection")
      await runtime.DB.prepare(
        "UPDATE fb_bot_collections SET enabled=0 WHERE collection_id='col_test_public'",
      ).run();
    if (condition === "private collection")
      await runtime.DB.prepare(
        "UPDATE fb_collections SET view_audience='private',public_approved_at=NULL WHERE id='col_test_public'",
      ).run();
    if (condition === "retired edition")
      await runtime.DB.prepare(
        "UPDATE fb_artwork_editions SET status='retired' WHERE id='edt_npc_want'",
      ).run();
    if (condition === "AI artwork")
      await runtime.DB.prepare(
        "UPDATE fb_assets SET origin='ai_generated' WHERE id='ast_test_subject'",
      ).run();
    if (["AI dependency", "AI derivative"].includes(condition)) {
      await runtime.DB.prepare(
        `INSERT INTO fb_assets (id,tenant_id,kind,name,mime,width,height,bytes,r2_key,sha256,visibility,created_at,origin)
        SELECT 'ast_ai_parent',tenant_id,kind,'AI ancestor',mime,width,height,bytes,'test/ai-parent.png',sha256,visibility,created_at,'ai_generated' FROM fb_assets WHERE id='ast_test_subject'`,
      ).run();
      await runtime.DB.prepare(
        condition === "AI dependency"
          ? "UPDATE fb_assets SET dependencies_json='[\"ast_ai_parent\"]' WHERE id='ast_test_subject'"
          : "UPDATE fb_assets SET derivative_of_asset_id='ast_ai_parent' WHERE id='ast_test_subject'",
      ).run();
    }
    if (condition === "malformed ancestry")
      await runtime.DB.prepare(
        "UPDATE fb_assets SET dependencies_json='{}' WHERE id='ast_test_subject'",
      ).run();
    if (condition === "archived background") {
      await runtime.DB.prepare(
        `INSERT INTO fb_assets (id,tenant_id,kind,name,mime,width,height,bytes,r2_key,sha256,visibility,created_at,origin,archived_at)
        SELECT 'ast_archived_bg',tenant_id,'background','old background',mime,width,height,bytes,'test/old-bg.png',sha256,visibility,created_at,'foilbury_original',datetime('now') FROM fb_assets WHERE id='ast_test_subject'`,
      ).run();
      await runtime.DB.prepare(
        "UPDATE fb_artwork_editions SET background_asset_id='ast_archived_bg' WHERE id='edt_npc_want'",
      ).run();
      await runtime.DB.prepare("UPDATE fb_bots SET ai_art_enabled=1 WHERE tenant_id=?")
        .bind(f.player.tenant.id)
        .run();
    }
    if (condition === "foreign Bot collection") {
      const other = await ctxFor("harbour", "harbour.owner@foilbury.test");
      const now = new Date().toISOString();
      await runtime.DB.prepare(
        `INSERT INTO fb_collections (id,slug,name,description,scope,owner_tenant_id,status,view_audience,public_approved_at,public_approved_by,created_by,created_at,updated_at)
        VALUES ('foreign_test','foreign-test','Foreign','test','bot',?,'published','public',?,'fixture','fixture',?,?)`,
      )
        .bind(other.tenant.id, now, now, now)
        .run();
      await runtime.DB.prepare(
        "INSERT INTO fb_collection_cards (collection_id,card_id,tenant_id,sort,added_by,added_at) VALUES ('foreign_test','crd_npc_want',?,1,'fixture',?)",
      )
        .bind(other.tenant.id, now)
        .run();
      await runtime.DB.prepare(
        "INSERT INTO fb_bot_collections (bot_id,collection_id,enabled,updated_at) SELECT id,'foreign_test',1,? FROM fb_bots WHERE tenant_id=?",
      )
        .bind(now, f.player.tenant.id)
        .run();
    }
    if (condition === "revoked membership")
      await runtime.DB.prepare(
        "UPDATE fb_memberships SET status='revoked' WHERE tenant_id=? AND user_id=?",
      )
        .bind(f.player.tenant.id, f.player.user!.id)
        .run();
    if (condition === "revoked session")
      await runtime.DB.prepare("UPDATE fb_sessions SET revoked_at=? WHERE id=?")
        .bind(new Date().toISOString(), f.player.sessionId)
        .run();
    if (condition === "paused NPC")
      await runtime.DB.prepare("UPDATE fb_npc_collectors SET status='paused' WHERE id=?")
        .bind(f.npc.id)
        .run();
    if (condition === "foreign copy")
      await runtime.DB.prepare("UPDATE fb_card_instances SET user_id=? WHERE id=?")
        .bind(f.owner.user!.id, f.offered)
        .run();
    await expect(previewNpcTrade(f.player, f.npc.id, f.offered, f.requested)).rejects.toMatchObject(
      { code: "npc_offer_unavailable" },
    );
  });
});
