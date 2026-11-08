import { beforeEach, describe, expect, it } from "vitest";
import { handleDiscordInteraction } from "../../src/server/discord/handler";
import { signDiscordRequest } from "../../src/server/discord/signature";
import type { DiscordEnv } from "../../src/server/discord/types";
import {
  bootstrap,
  ctxFor,
  fixturePool,
  makeInstance,
  runtime,
  setBalance,
  walletBalance,
} from "./helpers";
import { addCollectionCards, createCollection } from "../../src/server/modules/collections";
import { createNpc } from "../../src/server/modules/npcs";
import { npcTradeOffers } from "../../src/server/modules/npc-trades";
import { discordScopeCardIds, resolveDiscordScope } from "../../src/server/discord/scope";
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

function revealButton(originalInteractionId: string) {
  return interaction(
    { custom_id: `foilbury:reveal:${originalInteractionId}`, component_type: 2 },
    { id: `reveal-${originalInteractionId}`, type: 3 },
  );
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
      embeds?: Array<{
        title?: string;
        description?: string;
        fields?: Array<{ name: string; value: string }>;
      }>;
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
    const open = await send(
      interaction(command("open", [{ name: "pool", type: 3, value: "test-pool" }])),
    );
    expect(JSON.stringify(open.data)).not.toContain("Test One");
    expect(await draws()).toBe(0);
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
    const denied = await send(
      interaction(command("open", [{ name: "pool", type: 3, value: "test-pool" }]), {
        id: "scope-public-denied",
      }),
    );
    expect(denied.data?.flags).toBe(64);
    expect(JSON.stringify(denied.data)).toMatch(/not enabled for this channel|no eligible|cannot/i);
    expect(await draws()).toBe(0);
    await setAudience("members");
    const allowed = await send(
      interaction(command("open", [{ name: "pool", type: 3, value: "test-pool" }]), {
        id: "scope-members-allowed",
      }),
    );
    expect(allowed.data?.flags).toBe(64);
    expect(JSON.stringify(allowed.data)).toContain("sealed");
    const revealed = await send(revealButton("scope-members-allowed"));
    expect(JSON.stringify(revealed.data)).toContain("Test One");
    expect(await draws()).toBe(1);
  });

  it("limits the NPC tradeable list to cards filed only in this server's configured collections", async () => {
    const player = await install(["col_test_public"]);
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const fixture = await fixturePool(owner);
    const npc = await createNpc(owner, {
      name: "Scope Curator",
      presetKey: "completionist",
      goalCollectionId: "col_test_public",
      startingBalance: 0,
    });
    const npcRow = await runtime.DB.prepare("SELECT user_id FROM fb_npc_collectors WHERE id = ?")
      .bind(npc.id)
      .first<{ user_id: string }>();
    await makeInstance(owner, npcRow!.user_id, fixture, "NPC-SCOPE-1");
    const scoped = await resolveDiscordScope(player, await installation(), CHANNEL_ID);
    const allowed = await discordScopeCardIds(player, scoped);
    const before = await npcTradeOffers(player, npc.id, { allowedCardIds: allowed });
    expect(before.copies.map((copy) => copy.card_name)).toEqual(["Test One"]);

    const outside = await createCollection(owner, {
      name: "Outside Server Scope",
      scope: "global",
      status: "published",
      viewAudience: "members",
    });
    await addCollectionCards(owner, outside.id, [fixture.cardId]);
    const refreshed = await resolveDiscordScope(player, await installation(), CHANNEL_ID);
    const narrowed = await discordScopeCardIds(player, refreshed);
    // A card filed in a collection outside the installation allowlist is not
    // presented as tradeable, even though the Bot still enables the collection.
    const after = await npcTradeOffers(player, npc.id, { allowedCardIds: narrowed });
    expect(after.copies).toEqual([]);
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
    await runtime.DB.prepare("UPDATE fb_bots SET ai_art_enabled = 1 WHERE tenant_id = ?")
      .bind(player.tenant.id)
      .run();
    const on = await send(
      interaction(command("open", [{ name: "pool", type: 3, value: "test-pool" }]), {
        id: "ai-on",
      }),
    );
    expect(on.data?.flags).toBe(64);
    expect(JSON.stringify(on.data)).toContain("sealed");
    const revealed = await send(revealButton("ai-on"));
    expect(JSON.stringify(revealed.data)).toContain("Test One");
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
