import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  expireStaleDiscordInteractions,
  handleDiscordInteraction,
} from "../../src/server/discord/handler";
import { signDiscordRequest } from "../../src/server/discord/signature";
import type { DiscordEnv } from "../../src/server/discord/types";
import { bootstrap, ctxFor, fixturePool, makeInstance, runtime, setBalance } from "./helpers";
import { addCollectionCards, createCollection } from "../../src/server/modules/collections";
import { assertDiscordMessage } from "../../src/server/discord/presentation";
import { createNpc } from "../../src/server/modules/npcs";
import { DiscordTransport } from "./discord-transport";

const APPLICATION_ID = "1566702936615026769";
const GUILD_ID = "997734945206313041";
const CHANNEL_ID = "1566700752385081355";
const DISCORD_USER_ID = "707281352818425929";

function expectUniqueComponentIds(payload: { components?: Array<{ components?: Array<{ custom_id?: string }> }> }) {
  const ids = (payload.components ?? [])
    .flatMap((row) => row.components ?? [])
    .map((component) => component.custom_id)
    .filter(Boolean);
  expect(new Set(ids).size).toBe(ids.length);
  assertDiscordMessage(payload as never);
}

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

async function send(
  body: Record<string, unknown>,
  options: {
    timestamp?: number;
    signatureBody?: string;
    channelId?: string;
    guildId?: string;
  } = {},
) {
  const raw = JSON.stringify(body);
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const signature = await signDiscordRequest({
    body: options.signatureBody ?? raw,
    timestamp,
    privateKey,
  });
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
  const payload = (await response.json()) as {
    type?: number;
    data?: {
      content?: string;
      embeds?: Array<{ title?: string; description?: string }>;
      flags?: number;
      components?: Array<{ components?: Array<{ type?: number; style?: number; url?: string }> }>;
    };
    error?: string;
  };
  return { response, payload };
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
    options: [{ name, type: name === "admin" ? 2 : 1, options }],
  };
}

async function install() {
  const player = await ctxFor("cabinet", "player@foilbury.local");
  await runtime.DB.prepare(
    `INSERT INTO fb_discord_installations
      (id, tenant_id, application_id, guild_id, guild_name, channel_allowlist_json, game_enabled, website_enabled, api_enabled, public_catalogue_enabled, admin_gui_enabled, active, created_at, updated_at)
     VALUES ('dci_test', ?, ?, ?, 'Loftwah', ?, 1, 1, 1, 1, 1, 1, ?, ?)`,
  )
    .bind(
      player.tenant.id,
      APPLICATION_ID,
      GUILD_ID,
      JSON.stringify([CHANNEL_ID]),
      new Date().toISOString(),
      new Date().toISOString(),
    )
    .run();
  return player;
}

describe("Discord HTTP interactions", () => {
  beforeEach(async () => {
    await bootstrap();
    await makeKeys();
    await install();
  });

  it("answers Discord's endpoint PING without requiring a guild", async () => {
    const { response, payload } = await send({
      id: "ping-1",
      application_id: APPLICATION_ID,
      type: 1,
      token: "t",
    });
    expect(response.status).toBe(200);
    expect(payload.type).toBe(1);
  });

  it("rejects invalid signatures and stale timestamps before parsing the body", async () => {
    const body = interaction(command("help"), { id: "bad-signature" });
    const { response } = await send(body, { signatureBody: `${JSON.stringify(body)}tampered` });
    expect(response.status).toBe(401);

    const stale = await send(interaction(command("help"), { id: "stale" }), { timestamp: 1 });
    expect(stale.response.status).toBe(401);
    expect(stale.payload.error).toMatch(/timestamp|signature/i);
  });

  it("creates one player from a verified interaction and reuses the same inventory", async () => {
    const first = await send(interaction(command("daily"), { id: "daily-1" }));
    expect(first.response.status).toBe(200);
    expect(first.payload.type).toBe(4);
    expect(first.payload.data?.embeds?.[0]?.title).toMatch(/claimed/i);
    const identity = await runtime.DB.prepare(
      "SELECT COUNT(*) AS count FROM fb_discord_identities WHERE discord_user_id = ?",
    )
      .bind(DISCORD_USER_ID)
      .first<{ count: number }>();
    expect(identity?.count).toBe(1);

    const replay = await send(interaction(command("daily"), { id: "daily-1" }));
    expect(replay.payload.data?.embeds?.[0]?.title).toMatch(/already claimed/i);
    const claims = await runtime.DB.prepare(
      "SELECT COUNT(*) AS count FROM fb_reward_claims WHERE user_id = (SELECT user_id FROM fb_discord_identities WHERE discord_user_id = ?)",
    )
      .bind(DISCORD_USER_ID)
      .first<{ count: number }>();
    expect(claims?.count).toBe(1);
  });

  it("draws once, reveals the card, and replays the same outcome without a second award", async () => {
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await fixturePool(player);
    const body = interaction(command("open", [{ name: "pool", type: 3, value: "test-pool" }]), {
      id: "draw-1",
    });
    const first = await send(body);
    expect(first.payload.type).toBe(4);
    expect(first.payload.data?.embeds?.[0]?.title).toContain("Test One");
    const draw = await runtime.DB.prepare(
      "SELECT d.instance_id, d.receipt_json, ci.user_id, ci.serial FROM fb_draws d JOIN fb_card_instances ci ON ci.id = d.instance_id WHERE d.idempotency_key = ?",
    )
      .bind("discord:draw-1:open")
      .first<{ instance_id: string; user_id: string; serial: string }>();
    expect(draw?.instance_id).toBeTruthy();
    const identity = await runtime.DB.prepare(
      "SELECT user_id FROM fb_discord_identities WHERE discord_user_id = ?",
    )
      .bind(DISCORD_USER_ID)
      .first<{ user_id: string }>();
    expect(draw?.user_id).toBe(identity?.user_id);

    const replay = await send(body);
    expect(replay.payload.data?.embeds?.[0]?.title).toContain("Test One");
    const draws = await runtime.DB.prepare(
      "SELECT COUNT(*) AS count FROM fb_draws WHERE idempotency_key = ?",
    )
      .bind("discord:draw-1:open")
      .first<{ count: number }>();
    const instances = await runtime.DB.prepare(
      "SELECT COUNT(*) AS count FROM fb_card_instances WHERE user_id = ?",
    )
      .bind(identity?.user_id)
      .first<{ count: number }>();
    expect(draws?.count).toBe(1);
    expect(instances?.count).toBe(1);
  });

  it("routes every user-facing command through the shared presentation builders", async () => {
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const fixture = await fixturePool(player);
    await setBalance(player, player.user!.id, 1000);
    await send(interaction(command("daily"), { id: "presentation-bootstrap" }));
    // Clear the bootstrap claim so this test exercises the successful daily
    // builder rather than the cooldown state.
    await runtime.DB.prepare(
      "DELETE FROM fb_reward_claims WHERE user_id = (SELECT user_id FROM fb_discord_identities WHERE discord_user_id = ?)",
    )
      .bind(DISCORD_USER_ID)
      .run();
    const identity = await runtime.DB.prepare(
      "SELECT user_id FROM fb_discord_identities WHERE discord_user_id = ?",
    )
      .bind(DISCORD_USER_ID)
      .first<{ user_id: string }>();
    await makeInstance(player, identity!.user_id, fixture, "TEST-PRESENT-01");

    const help = await send(interaction(command("help"), { id: "presentation-help" }));
    expect(help.payload.data?.embeds?.[0]?.title).toBe("Welcome to Foilbury");
    expect(JSON.stringify(help.payload.data)).toContain("Commands");

    const daily = await send(interaction(command("daily"), { id: "presentation-daily" }));
    expect(daily.payload.data?.embeds?.[0]?.fields?.map((field) => field.name)).toContain(
      "Credited",
    );
    expect(daily.payload.data?.flags).toBe(64);

    const packs = await send(interaction(command("packs"), { id: "presentation-packs" }));
    expect(packs.payload.data?.embeds?.[0]?.title).toBe("Choose a capsule");
    expect(JSON.stringify(packs.payload.data)).toContain("eligible card");
    expect(packs.payload.data?.flags).toBe(64);

    const open = await send(
      interaction(command("open", [{ name: "pool", type: 3, value: "test-pool" }]), {
        id: "presentation-open",
      }),
    );
    const openFields = open.payload.data?.embeds?.[0]?.fields?.map((field) => field.name) ?? [];
    expect(openFields).toEqual(
      expect.arrayContaining(["Opening debit", "Settled balance", "Serial"]),
    );
    expect(open.payload.data?.flags).toBe(64);

    const card = await send(
      interaction(command("card", [{ name: "query", type: 3, value: "Test One" }]), {
        id: "presentation-card",
      }),
    );
    expect(card.payload.data?.embeds?.[0]?.fields?.map((field) => field.name)).toEqual(
      expect.arrayContaining(["Collection", "Side", "Source"]),
    );
    expect(JSON.stringify(card.payload.data)).toContain("View back");

    const collection = await send(interaction(command("collection"), { id: "presentation-collection" }));
    expect(collection.payload.data?.embeds?.[0]?.title).toBe("Your cabinet");
    expect(JSON.stringify(collection.payload.data)).toContain("Open cabinet on the web");

    const achievements = await send(
      interaction(command("achievements"), { id: "presentation-achievements" }),
    );
    expect(achievements.payload.data?.embeds?.[0]?.title).toBe("Achievements");
    expect(JSON.stringify(achievements.payload.data)).toContain("Closest next");

    const profile = await send(interaction(command("profile"), { id: "presentation-profile" }));
    expect(profile.payload.data?.embeds?.[0]?.title).toContain("Dean");
    expect(JSON.stringify(profile.payload.data)).toContain("This Bot across every server");

    const denied = await send(
      interaction(command("admin", [{ name: "status", type: 1, options: [] }]), {
        id: "presentation-denied",
      }),
    );
    expect(denied.payload.data?.embeds?.[0]?.title).toBe("Administration is private");
    expect(denied.payload.data?.flags).toBe(64);
  });

  it("shows the same awarded instance in a later collection lookup", async () => {
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await fixturePool(player);
    const draw = await send(
      interaction(command("open", [{ name: "pool", type: 3, value: "test-pool" }]), {
        id: "draw-collection",
      }),
    );
    const title = draw.payload.data?.embeds?.[0]?.title ?? "";
    const collection = await send(interaction(command("collection"), { id: "collection-1" }));
    const text = JSON.stringify(collection.payload.data);
    expect(text).toContain("Your cabinet");
    expect(text).toContain("Test One");
    expect(title).toContain("Test One");
    const card = await send(
      interaction(command("card", [{ name: "query", type: 3, value: "Test One" }]), {
        id: "card-link",
      }),
    );
    const actionRow = card.payload.data?.components?.[0];
    const link = actionRow?.components?.find((component) => component.style === 5);
    expect(link?.type).toBe(2);
    expect(link?.style).toBe(5);
    expect(link?.url).toContain("/play/collection");
  });

  it("opens the default capsule without a pool argument", async () => {
    await fixturePool(await ctxFor("cabinet", "player@foilbury.local"));
    const now = new Date().toISOString();
    const fixture = await runtime.DB.prepare("SELECT variant_id FROM fb_pool_entries WHERE pool_id = 'pool_test_open' LIMIT 1").first<{ variant_id: string }>();
    await runtime.DB.batch([
      runtime.DB.prepare("INSERT INTO fb_pools (id, tenant_id, slug, name, description, status, revision, price, created_at, updated_at, published_at) VALUES ('pool_default_cabinet', (SELECT tenant_id FROM fb_pools WHERE id = 'pool_test_open'), 'cabinet-draw', 'Cabinet draw', 'Default capsule', 'active', 1, 80, ?, ?, ?)").bind(now, now, now),
      runtime.DB.prepare("INSERT INTO fb_pool_entries (id, tenant_id, pool_id, pool_revision, variant_id, weight, enabled, created_at) VALUES ('poe_default', (SELECT tenant_id FROM fb_pools WHERE id = 'pool_test_open'), 'pool_default_cabinet', 1, ?, 100, 1, ?)").bind(fixture!.variant_id, now),
    ]);
    const opened = await send(interaction(command("open"), { id: "default-open" }));
    expect(opened.response.status).toBe(200);
    expect(JSON.stringify(opened.payload.data)).toContain("Test One");
    const draw = await runtime.DB.prepare("SELECT price, pool_id FROM fb_draws WHERE idempotency_key = 'discord:default-open:open'").first<{ price: number; pool_id: string }>();
    expect(draw).toMatchObject({ price: 80, pool_id: "pool_default_cabinet" });
  });

  it("offers real eligible capsules when the default is empty", async () => {
    await fixturePool(await ctxFor("cabinet", "player@foilbury.local"));
    const now = new Date().toISOString();
    await runtime.DB.prepare("INSERT INTO fb_pools (id, tenant_id, slug, name, description, status, revision, price, created_at, updated_at, published_at) VALUES ('pool_empty_default', (SELECT tenant_id FROM fb_pools WHERE id = 'pool_test_open'), 'cabinet-draw', 'Cabinet draw', 'Default capsule with no entries', 'active', 1, 80, ?, ?, ?)").bind(now, now, now).run();
    const picker = await send(interaction(command("open"), { id: "default-empty" }));
    expect(JSON.stringify(picker.payload.data)).toContain("Choose a capsule");
    const ids = (picker.payload.data?.components ?? []).flatMap((row) => row.components ?? []).map((component) => component.custom_id);
    expect(ids).toContain("foilbury:open:test-pool");
    expect(picker.payload.data?.flags).toBe(64);
    const draws = await runtime.DB.prepare("SELECT COUNT(*) AS count FROM fb_draws").first<{ count: number }>();
    expect(draws?.count ?? 0).toBe(0);
  });

  it("explains insufficient funds with a daily-claim next step", async () => {
    const player = await fixturePool(await ctxFor("cabinet", "player@foilbury.local"));
    await send(interaction(command("profile"), { id: "funds-profile" }));
    const identity = await runtime.DB.prepare("SELECT user_id FROM fb_discord_identities WHERE discord_user_id = ?").bind(DISCORD_USER_ID).first<{ user_id: string }>();
    expect(identity?.user_id).toBeTruthy();
    const playerCtx = await ctxFor("cabinet", "player@foilbury.local");
    await setBalance({ ...playerCtx, user: { ...playerCtx.user!, id: identity!.user_id } }, identity!.user_id, 0);
    const failed = await send(interaction(command("open", [{ name: "pool", type: 3, value: "test-pool" }]), { id: "no-funds" }));
    expect(JSON.stringify(failed.payload.data)).toContain("Not enough Foil");
    expect(JSON.stringify(failed.payload.data)).toContain("/foilbury daily");
    const draws = await runtime.DB.prepare("SELECT COUNT(*) AS count FROM fb_draws").first<{ count: number }>();
    expect(draws?.count ?? 0).toBe(0);
    expect(player.variantId).toBeTruthy();
  });

  it("rejects the wrong guild, the wrong channel, and unbound installations", async () => {
    const wrongGuild = await send(
      interaction(command("daily"), { guildId: "111111111111111111", id: "wrong-guild" }),
    );
    expect(wrongGuild.payload.data?.embeds?.[0]?.description).toMatch(/not bound/i);
    const wrongChannel = await send(
      interaction(command("daily"), { channelId: "222222222222222222", id: "wrong-channel" }),
    );
    expect(wrongChannel.payload.data?.embeds?.[0]?.description).toMatch(
      /not enabled in this channel/i,
    );
    const claims = await runtime.DB.prepare(
      "SELECT COUNT(*) AS count FROM fb_reward_claims",
    ).first<{ count: number }>();
    expect(claims?.count).toBe(0);
  });

  it("denies admin commands to ordinary players and allows a Bot Owner", async () => {
    const denied = await send(
      interaction(command("admin", [{ name: "status", type: 1, options: [] }]), {
        id: "admin-denied",
      }),
    );
    expect(denied.payload.data?.embeds?.[0]?.description).toMatch(/Owner or Admin/i);

    const identity = await runtime.DB.prepare(
      "SELECT user_id FROM fb_discord_identities WHERE discord_user_id = ?",
    )
      .bind(DISCORD_USER_ID)
      .first<{ user_id: string }>();
    await runtime.DB.prepare("UPDATE fb_memberships SET role = 'owner' WHERE user_id = ?")
      .bind(identity?.user_id)
      .run();
    const allowed = await send(
      interaction(command("admin", [{ name: "status", type: 1, options: [] }]), {
        id: "admin-allowed",
      }),
    );
    expect(allowed.payload.data?.embeds?.[0]?.title).toContain("Bot status");
  });

  it("defers privately and delivers the committed reveal through the private original", async () => {
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await fixturePool(player);
    await runtime.MEDIA.put("test/render.webp", new Uint8Array([82, 73, 70, 70, 1, 2, 3]));
    const body = interaction(command("open", [{ name: "pool", type: 3, value: "test-pool" }]), {
      id: "deferred-draw",
    });
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

    const transport = new DiscordTransport();
    const pending: Promise<unknown>[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = transport.fetch as typeof fetch;
    let ackFlags: number | undefined;
    try {
      const response = await handleDiscordInteraction(request, env(), {
        publicKey: publicKeyHex,
        waitUntil: (promise) => pending.push(promise),
      });
      const ack = (await response.json()) as { type?: number; data?: { flags?: number } };
      ackFlags = ack.data?.flags;
      expect(ack.type).toBe(5);
      transport.acknowledge("test-interaction-token", ackFlags);
      await Promise.all(pending);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(ackFlags).toBe(64);
    const original = transport.original("test-interaction-token")!;
    expect(original.visibility).toBe("ephemeral");
    expect(original.loading).toBe(false);
    expect(original.files).toBe(1);
    expect(JSON.stringify(original.payload)).toContain("Test One");
    expect(JSON.stringify(original.payload)).toContain("attachment://foilbury-reveal-card.webp");
    expect(JSON.stringify(original.payload)).toContain('"width":750');
    // A private reveal must not create a channel-visible follow-up.
    expect(transport.publicMessages()).toHaveLength(0);
    expect(transport.requests.map((entry) => `${entry.method} ${entry.target}`)).toEqual([
      "PATCH original",
    ]);
    const record = await runtime.DB.prepare(
      "SELECT status, error_code, delivery_visibility, receipt_json FROM fb_discord_interactions WHERE interaction_id = ?",
    )
      .bind("deferred-draw")
      .first<{
        status: string;
        error_code: string | null;
        delivery_visibility: string | null;
        receipt_json: string | null;
      }>();
    expect(record?.status).toBe("completed");
    expect(record?.error_code).toBeNull();
    expect(record?.delivery_visibility).toBe("private");
    expect(record?.receipt_json).toContain("Test One");
  });

  it("posts a public share only after the private original is settled", async () => {
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const fixture = await fixturePool(player);
    // The signed interaction creates or reuses the Discord-linked player, so
    // resolve that durable identity before attaching a controlled owned card.
    await send(interaction(command("daily"), { id: "share-bootstrap" }));
    const identity = await runtime.DB.prepare(
      "SELECT user_id FROM fb_discord_identities WHERE discord_user_id = ?",
    )
      .bind(DISCORD_USER_ID)
      .first<{ user_id: string }>();
    expect(identity?.user_id).toBeTruthy();
    const instance = await makeInstance(player, identity!.user_id, fixture, "TEST-SHARE-001");
    const body = interaction(
      { custom_id: `foilbury:tourshare:card:${instance}`, component_type: 2 },
      { id: "deferred-share", type: 3 },
    );
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

    const transport = new DiscordTransport();
    const pending: Promise<unknown>[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = transport.fetch as typeof fetch;
    let ackFlags: number | undefined;
    try {
      const response = await handleDiscordInteraction(request, env(), {
        publicKey: publicKeyHex,
        waitUntil: (promise) => pending.push(promise),
      });
      const ack = (await response.json()) as { type?: number; data?: { flags?: number } };
      ackFlags = ack.data?.flags;
      transport.acknowledge("test-interaction-token", ackFlags);
      await Promise.all(pending);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(ackFlags).toBe(64);
    const original = transport.original("test-interaction-token")!;
    expect(original.visibility).toBe("ephemeral");
    expect(original.loading).toBe(false);
    expect(JSON.stringify(original.payload)).toContain("TEST-SHARE-001");
    const publicMessages = transport.publicMessages();
    expect(publicMessages).toHaveLength(1);
    expect(publicMessages[0]!.payload.flags).toBeUndefined();
    expect(JSON.stringify(publicMessages[0]!.payload)).toContain("Shared by");
    expect(transport.requests.map((entry) => `${entry.method} ${entry.target}`)).toEqual([
      "PATCH original",
      "POST followup",
    ]);
  });

  it("never creates a public message for a restricted reveal", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const fixture = await fixturePool(owner);
    const collection = await createCollection(owner, {
      name: "Restricted Deferred",
      scope: "global",
      status: "published",
      viewAudience: "members",
    });
    await addCollectionCards(owner, collection.id, [fixture.cardId]);
    await runtime.DB.prepare("DELETE FROM fb_collection_cards WHERE collection_id = 'col_test_public'").run();
    await runtime.DB.prepare(
      "INSERT OR REPLACE INTO fb_bot_collections (bot_id, collection_id, enabled, updated_at) SELECT b.id, ?, 1, ? FROM fb_bots b WHERE b.tenant_id = ?",
    )
      .bind(collection.id, new Date().toISOString(), owner.tenant.id)
      .run();
    await setBalance(owner, owner.user!.id, 1000);
    await runtime.DB.prepare(
      "UPDATE fb_discord_installations SET channel_audience_json = ? WHERE id = 'dci_test'",
    )
      .bind(JSON.stringify({ [CHANNEL_ID]: "members" }))
      .run();
    const body = interaction(command("open", [{ name: "pool", type: 3, value: "test-pool" }]), {
      id: "deferred-private",
    });
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
    const transport = new DiscordTransport();
    const pending: Promise<unknown>[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = transport.fetch as typeof fetch;
    let ackFlags: number | undefined;
    try {
      const response = await handleDiscordInteraction(request, env(), {
        publicKey: publicKeyHex,
        waitUntil: (promise) => pending.push(promise),
      });
      const ack = (await response.json()) as { type?: number; data?: { flags?: number } };
      ackFlags = ack.data?.flags;
      transport.acknowledge("test-interaction-token", ackFlags);
      await Promise.all(pending);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(ackFlags).toBe(64);
    expect(transport.original("test-interaction-token")!.visibility).toBe("ephemeral");
    expect(transport.publicMessages()).toHaveLength(0);
    expect(JSON.stringify(transport.original("test-interaction-token")!.payload)).toContain(
      "Test One",
    );
  });

  it("retries a rate-limited original edit and never logs the interaction token", async () => {
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await fixturePool(player);
    await runtime.MEDIA.put("test/render.webp", new Uint8Array([82, 73, 70, 70, 1, 2, 3]));
    const body = interaction(command("open", [{ name: "pool", type: 3, value: "test-pool" }]), {
      id: "rate-limited-draw",
    });
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
    const token = "test-interaction-token";
    const transport = new DiscordTransport();
    transport.failNext({
      method: "PATCH",
      target: "original",
      status: 429,
      body: `rate limited for https://discord.com/api/v10/webhooks/${APPLICATION_ID}/${token}/messages/@original`,
      times: 1,
    });
    const failures: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((value) => {
      failures.push(String(value));
    });
    const pending: Promise<unknown>[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = transport.fetch as typeof fetch;
    try {
      const response = await handleDiscordInteraction(request, env(), {
        publicKey: publicKeyHex,
        waitUntil: (promise) => pending.push(promise),
      });
      const ack = (await response.json()) as { data?: { flags?: number } };
      transport.acknowledge(token, ack.data?.flags);
      await Promise.all(pending);
    } finally {
      globalThis.fetch = originalFetch;
      errorSpy.mockRestore();
    }
    const original = transport.original(token)!;
    expect(original.loading).toBe(false);
    expect(original.edits).toBe(1);
    const record = await runtime.DB.prepare(
      "SELECT status, error_code FROM fb_discord_interactions WHERE interaction_id = ?",
    )
      .bind("rate-limited-draw")
      .first<{ status: string; error_code: string | null }>();
    expect(record?.status).toBe("completed");
    expect(record?.error_code).toBeNull();
    expect(failures.join("\n")).not.toContain(token);
  });

  it("keeps a committed draw truthful when delivery fails and re-sends only the receipt", async () => {
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await fixturePool(player);
    await runtime.MEDIA.put("test/render.webp", new Uint8Array([82, 73, 70, 70, 1, 2, 3]));
    const body = interaction(command("open", [{ name: "pool", type: 3, value: "test-pool" }]), {
      id: "commit-delivery-fail",
    });
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
    const token = "test-interaction-token";
    const transport = new DiscordTransport();
    transport.failNext({ method: "PATCH", target: "original", status: 503, times: 3 });
    const errors: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((value) => {
      errors.push(String(value));
    });
    const pending: Promise<unknown>[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = transport.fetch as typeof fetch;
    try {
      const response = await handleDiscordInteraction(request, env(), {
        publicKey: publicKeyHex,
        waitUntil: (promise) => pending.push(promise),
      });
      const ack = (await response.json()) as { data?: { flags?: number } };
      transport.acknowledge(token, ack.data?.flags);
      await Promise.all(pending);
    } finally {
      globalThis.fetch = originalFetch;
      errorSpy.mockRestore();
    }
    const record = await runtime.DB.prepare(
      "SELECT status, error_code, receipt_json, delivery_visibility FROM fb_discord_interactions WHERE interaction_id = ?",
    )
      .bind("commit-delivery-fail")
      .first<{
        status: string;
        error_code: string | null;
        receipt_json: string | null;
        delivery_visibility: string | null;
      }>();
    expect(record?.status).toBe("completed");
    expect(record?.error_code).toBe("delivery_failed");
    expect(record?.receipt_json).toContain("Test One");
    const drawsBefore = await runtime.DB.prepare("SELECT COUNT(*) AS count FROM fb_draws").first<{
      count: number;
    }>();
    expect(drawsBefore?.count).toBe(1);
    expect(errors.join("\n")).not.toContain(token);

    // A deliberate retry targets the persisted receipt, not the draw service.
    const retryTransport = new DiscordTransport();
    const retryBody = interaction(
      { custom_id: "foilbury:redeliver:commit-delivery-fail", component_type: 2 },
      { id: "redeliver-receipt", type: 3 },
    );
    const retryRaw = JSON.stringify(retryBody);
    const retryTimestamp = String(Math.floor(Date.now() / 1000));
    const retrySignature = await signDiscordRequest({
      body: retryRaw,
      timestamp: retryTimestamp,
      privateKey,
    });
    const retryRequest = new Request("https://foilbury.test/api/discord/interactions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature-ed25519": retrySignature,
        "x-signature-timestamp": retryTimestamp,
      },
      body: retryRaw,
    });
    const retryPending: Promise<unknown>[] = [];
    globalThis.fetch = retryTransport.fetch as typeof fetch;
    try {
      const response = await handleDiscordInteraction(retryRequest, env(), {
        publicKey: publicKeyHex,
        waitUntil: (promise) => retryPending.push(promise),
      });
      const ack = (await response.json()) as { data?: { flags?: number } };
      retryTransport.acknowledge("test-interaction-token", ack.data?.flags);
      await Promise.all(retryPending);
    } finally {
      globalThis.fetch = originalFetch;
    }
    const retried = retryTransport.original("test-interaction-token")!;
    expect(JSON.stringify(retried.payload)).toContain("recorded result");
    expect(JSON.stringify(retried.payload)).toContain("No second pull");
    const drawsAfter = await runtime.DB.prepare("SELECT COUNT(*) AS count FROM fb_draws").first<{
      count: number;
    }>();
    expect(drawsAfter?.count).toBe(1);
  });

  it("delivers a visible text receipt when the card render cannot be attached", async () => {
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await fixturePool(player);
    await runtime.MEDIA.delete("test/render.webp");
    const raw = JSON.stringify(
      interaction(command("open", [{ name: "pool", type: 3, value: "test-pool" }]), {
        id: "missing-render",
      }),
    );
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
    const pending: Promise<unknown>[] = [];
    const payloads: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const form = init?.body instanceof FormData ? init.body : null;
      payloads.push(form ? String(form.get("payload_json") ?? "") : String(init?.body ?? ""));
      const id = String(input).includes("?wait=true") ? "follow-up-message" : "original-message";
      return new Response(JSON.stringify({ id }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      await handleDiscordInteraction(request, env(), {
        publicKey: publicKeyHex,
        waitUntil: (promise) => pending.push(promise),
      });
      await Promise.all(pending);
    } finally {
      globalThis.fetch = originalFetch;
    }
    const receipt = payloads.find((payload) => payload.includes("Test One")) ?? "";
    expect(receipt).not.toContain("attachment://");
    expect(receipt).toContain("card artwork could not be attached");
    const record = await runtime.DB.prepare(
      "SELECT status, error_code FROM fb_discord_interactions WHERE interaction_id = ?",
    )
      .bind("missing-render")
      .first<{ status: string; error_code: string | null }>();
    expect(record?.status).toBe("completed");
    expect(record?.error_code).toBeNull();
  });

  it("records a committed draw with a delivery failure instead of a false failed draw", async () => {
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await fixturePool(player);
    await runtime.MEDIA.put("test/render.webp", new Uint8Array([82, 73, 70, 70, 1, 2, 3]));
    const raw = JSON.stringify(
      interaction(command("open", [{ name: "pool", type: 3, value: "test-pool" }]), {
        id: "dead-webhook",
      }),
    );
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
    const pending: Promise<unknown>[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("simulated Discord outage");
    }) as typeof fetch;
    try {
      await handleDiscordInteraction(request, env(), {
        publicKey: publicKeyHex,
        waitUntil: (promise) => pending.push(promise),
      });
      await Promise.all(pending);
    } finally {
      globalThis.fetch = originalFetch;
    }
    const record = await runtime.DB.prepare(
      "SELECT status, error_code, receipt_json FROM fb_discord_interactions WHERE interaction_id = ?",
    )
      .bind("dead-webhook")
      .first<{ status: string; error_code: string | null; receipt_json: string | null }>();
    // The domain committed even though no message could be delivered. The
    // operational row keeps that distinction visible.
    expect(record?.status).toBe("completed");
    expect(record?.error_code).toBe("delivery_failed");
    expect(record?.receipt_json).toContain("Test One");
    const draws = await runtime.DB.prepare("SELECT COUNT(*) AS count FROM fb_draws").first<{
      count: number;
    }>();
    expect(draws?.count).toBe(1);
  });

  it("expires stale processing interactions but leaves recent work alone", async () => {
    const old = new Date(Date.now() - 60 * 60_000).toISOString();
    const now = new Date().toISOString();
    for (const [id, createdAt] of [
      ["stale-processing", old],
      ["recent-processing", now],
    ] as const) {
      await runtime.DB.prepare(
        `INSERT INTO fb_discord_interactions
          (interaction_id, application_id, guild_id, channel_id, discord_user_id, command_name, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'foilbury', 'processing', ?)`,
      )
        .bind(id, APPLICATION_ID, GUILD_ID, CHANNEL_ID, DISCORD_USER_ID, createdAt)
        .run();
    }
    const changed = await expireStaleDiscordInteractions(runtime.DB, 10);
    expect(changed).toBeGreaterThanOrEqual(1);
    const stale = await runtime.DB.prepare(
      "SELECT status, error_code FROM fb_discord_interactions WHERE interaction_id = 'stale-processing'",
    ).first<{ status: string; error_code: string | null }>();
    const recent = await runtime.DB.prepare(
      "SELECT status FROM fb_discord_interactions WHERE interaction_id = 'recent-processing'",
    ).first<{ status: string }>();
    expect(stale?.status).toBe("failed");
    expect(stale?.error_code).toBe("delivery_timeout");
    expect(recent?.status).toBe("processing");
  });

  it("does not double-award when the same interaction is delivered concurrently", async () => {
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await fixturePool(player);
    const body = interaction(command("open", [{ name: "pool", type: 3, value: "test-pool" }]), {
      id: "concurrent-draw",
    });
    const [first, second] = await Promise.all([send(body), send(body)]);
    expect(first.payload.type).toBe(4);
    expect(second.payload.type).toBe(4);
    const draws = await runtime.DB.prepare(
      "SELECT COUNT(*) AS count FROM fb_draws WHERE idempotency_key = ?",
    )
      .bind("discord:concurrent-draw:open")
      .first<{ count: number }>();
    const identity = await runtime.DB.prepare(
      "SELECT user_id FROM fb_discord_identities WHERE discord_user_id = ?",
    )
      .bind(DISCORD_USER_ID)
      .first<{ user_id: string }>();
    const instances = await runtime.DB.prepare(
      "SELECT COUNT(*) AS count FROM fb_card_instances WHERE user_id = ?",
    )
      .bind(identity?.user_id)
      .first<{ count: number }>();
    expect(draws?.count).toBe(1);
    expect(instances?.count).toBe(1);
  });

  it("finds a card by its display name as well as its slug", async () => {
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await fixturePool(player);
    const result = await send(
      interaction(command("card", [{ name: "query", type: 3, value: "Test One" }]), {
        id: "card-by-name",
      }),
    );
    expect(result.payload.data?.embeds?.[0]?.title).toContain("Test One");
  });

  it("directs Discord grants to strongly authenticated Studio and rejects old buttons", async () => {
    await send(interaction(command("daily"), { id: "grant-player-create" }));
    const identity = await runtime.DB.prepare("SELECT user_id,tenant_id FROM fb_discord_identities WHERE discord_user_id = ?").bind(DISCORD_USER_ID).first<{user_id:string;tenant_id:string}>();
    await runtime.DB.prepare("UPDATE fb_memberships SET role = 'owner' WHERE user_id = ?").bind(identity!.user_id).run();
    const before = await runtime.DB.prepare("SELECT balance FROM fb_wallets WHERE tenant_id=? AND user_id=?").bind(identity!.tenant_id,identity!.user_id).first<{balance:number}>();
    const requested = await send(interaction(command("admin", [{name:"grant",type:1,options:[{name:"user",type:3,value:DISCORD_USER_ID},{name:"amount",type:4,value:100},{name:"reason",type:3,value:"test grant"}]}]), {id:"grant-request"}));
    expect(requested.payload.data?.embeds?.[0]?.description).toMatch(/strong authentication.*Studio/i);
    expect(requested.payload.data?.components?.[0]?.components.map((item) => item.label)).toEqual(["Open Studio", "Account security"]);
    expect((await runtime.DB.prepare("SELECT COUNT(*) AS n FROM fb_discord_confirmations WHERE action='wallet.grant'").first<{n:number}>())?.n).toBe(0);
    await runtime.DB.prepare("INSERT INTO fb_discord_confirmations (id,tenant_id,discord_user_id,action,payload_json,expires_at,created_at) VALUES ('old-grant',?,?,'wallet.grant',?,?,?)").bind(identity!.tenant_id,DISCORD_USER_ID,JSON.stringify({targetUserId:identity!.user_id,amount:100,reason:'test grant'}),new Date(Date.now()+60000).toISOString(),new Date().toISOString()).run();
    const old = await send(interaction({custom_id:'foilbury:confirm:old-grant',component_type:2},{id:'old-grant-click',type:3}));
    expect(old.payload.data?.embeds?.[0]?.description).toMatch(/strong authentication.*Studio/i);
    const after=await runtime.DB.prepare("SELECT balance FROM fb_wallets WHERE tenant_id=? AND user_id=?").bind(identity!.tenant_id,identity!.user_id).first<{balance:number}>();
    expect(after?.balance).toBe(before?.balance);
  });

  it("handles a button interaction with the same idempotent draw path", async () => {
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await fixturePool(player);
    const click = await send(
      interaction(
        { custom_id: "foilbury:open:test-pool", component_type: 2 },
        { id: "button-draw", type: 3 },
      ),
    );
    expect(click.payload.type).toBe(4);
    expect(click.payload.data?.embeds?.[0]?.title).toContain("Test One");
    const unknown = await send(
      interaction(
        { custom_id: "foilbury:not-a-real-button", component_type: 2 },
        { id: "button-unknown", type: 3 },
      ),
    );
    expect(unknown.payload.data?.embeds?.[0]?.description).toMatch(/stale|not recognised/i);
  });

  it("never restores a revoked membership or lets its old confirmation act", async () => {
    await send(interaction(command("daily"), { id: "revoked-player-create" }));
    const identity = await runtime.DB.prepare(
      "SELECT user_id FROM fb_discord_identities WHERE discord_user_id = ?",
    )
      .bind(DISCORD_USER_ID)
      .first<{ user_id: string }>();
    expect(identity?.user_id).toBeTruthy();
    await runtime.DB.prepare("UPDATE fb_memberships SET role = 'owner' WHERE user_id = ?")
      .bind(identity?.user_id)
      .run();
    const tenant = await ctxFor("cabinet", "owner@foilbury.local");
    await runtime.DB.prepare("INSERT INTO fb_discord_confirmations (id,tenant_id,discord_user_id,action,payload_json,expires_at,created_at) VALUES ('revoked-old-grant',?,?,'wallet.grant',?,?,?)")
      .bind(tenant.tenant.id, DISCORD_USER_ID, JSON.stringify({targetUserId:identity!.user_id,amount:100,reason:'revocation test'}),new Date(Date.now()+60000).toISOString(),new Date().toISOString()).run();
    const confirmation = { id: 'revoked-old-grant' };
    const revokedAt = new Date().toISOString();
    const balanceBefore = await runtime.DB.prepare(
      "SELECT balance FROM fb_wallets WHERE user_id = ?",
    )
      .bind(identity?.user_id)
      .first<{ balance: number }>();
    await runtime.DB.prepare(
      "UPDATE fb_memberships SET status = 'revoked', revoked_at = ? WHERE user_id = ?",
    )
      .bind(revokedAt, identity?.user_id)
      .run();
    const blocked = await send(interaction(command("collection"), { id: "revoked-collection" }));
    expect(blocked.payload.data?.embeds?.[0]?.description).toMatch(/no longer an active member/i);
    const oldButton = await send(
      interaction(
        { custom_id: `foilbury:confirm:${confirmation?.id}`, component_type: 2 },
        { id: "revoked-confirm", type: 3 },
      ),
    );
    expect(oldButton.payload.data?.embeds?.[0]?.description).toMatch(/no longer an active member/i);
    const membership = await runtime.DB.prepare(
      "SELECT status, revoked_at FROM fb_memberships WHERE tenant_id = ? AND user_id = ?",
    )
      .bind((await ctxFor("cabinet", "owner@foilbury.local")).tenant.id, identity?.user_id)
      .first<{ status: string; revoked_at: string | null }>();
    expect(membership?.status).toBe("revoked");
    expect(membership?.revoked_at).toBe(revokedAt);
    const balance = await runtime.DB.prepare("SELECT balance FROM fb_wallets WHERE user_id = ?")
      .bind(identity?.user_id)
      .first<{ balance: number }>();
    expect(balance?.balance ?? 0).toBe(balanceBefore?.balance ?? 0);
  });

  it("lets an authorised owner re-enable a disabled installation", async () => {
    await send(interaction(command("daily"), { id: "disabled-player-create" }));
    const identity = await runtime.DB.prepare(
      "SELECT user_id FROM fb_discord_identities WHERE discord_user_id = ?",
    )
      .bind(DISCORD_USER_ID)
      .first<{ user_id: string }>();
    await runtime.DB.prepare("UPDATE fb_memberships SET role = 'owner' WHERE user_id = ?")
      .bind(identity?.user_id)
      .run();
    await runtime.DB.prepare(
      "UPDATE fb_discord_installations SET game_enabled = 0 WHERE id = 'dci_test'",
    ).run();
    const playerBlocked = await send(
      interaction(command("open", [{ name: "pool", type: 3, value: "test-pool" }]), {
        id: "disabled-open",
      }),
    );
    expect(playerBlocked.payload.data?.embeds?.[0]?.description).toMatch(/gameplay is paused/i);
    const requested = await send(
      interaction(
        command("admin", [
          { name: "enable", type: 1, options: [{ name: "surface", type: 3, value: "game" }] },
        ]),
        {
          id: "disabled-enable-request",
        },
      ),
    );
    expect(requested.payload.data?.embeds?.[0]?.title).toMatch(/Enable game/i);
    const confirmation = await runtime.DB.prepare(
      "SELECT id FROM fb_discord_confirmations WHERE discord_user_id = ? ORDER BY created_at DESC LIMIT 1",
    )
      .bind(DISCORD_USER_ID)
      .first<{ id: string }>();
    const confirmed = await send(
      interaction(
        { custom_id: `foilbury:confirm:${confirmation?.id}`, component_type: 2 },
        { id: "disabled-enable-confirm", type: 3 },
      ),
    );
    expect(confirmed.payload.data?.embeds?.[0]?.title).toMatch(/game enabled/i);
    const installation = await runtime.DB.prepare(
      "SELECT game_enabled FROM fb_discord_installations WHERE id = 'dci_test'",
    ).first<{ game_enabled: number }>();
    expect(installation?.game_enabled).toBe(1);
  });

  it("keeps restricted artwork ephemeral until the channel audience is verified", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const fixture = await fixturePool(owner);
    const collection = await createCollection(owner, {
      name: "Tour Members",
      scope: "global",
      status: "published",
      viewAudience: "members",
    });
    await addCollectionCards(owner, collection.id, [fixture.cardId]);
    await runtime.DB.prepare(
      "DELETE FROM fb_collection_cards WHERE collection_id = 'col_test_public'",
    ).run();
    await runtime.DB.prepare(
      "INSERT OR REPLACE INTO fb_bot_collections (bot_id, collection_id, enabled, updated_at) SELECT b.id, ?, 1, ? FROM fb_bots b WHERE b.tenant_id = ?",
    )
      .bind(collection.id, new Date().toISOString(), owner.tenant.id)
      .run();
    await setBalance(owner, owner.user!.id, 1000);
    const publicReveal = await send(
      interaction(command("open", [{ name: "pool", type: 3, value: "test-pool" }]), {
        id: "restricted-public-reveal",
      }),
    );
    expect(publicReveal.payload.data?.flags).toBe(64);
    expect(JSON.stringify(publicReveal.payload.data)).toMatch(
      /not enabled for this channel|no eligible cards|has no eligible collection/i,
    );
    const drawsBefore = await runtime.DB.prepare(
      "SELECT COUNT(*) AS count FROM fb_draws",
    ).first<{ count: number }>();
    expect(drawsBefore?.count).toBe(0);

    const share = await send(
      interaction(
        { custom_id: "foilbury:tourshare:card:not-owned", component_type: 2 },
        { id: "restricted-share", type: 3 },
      ),
    );
    expect(share.payload.data?.embeds?.[0]?.description).toMatch(
      /not owned|not in your cabinet|not available/i,
    );

    await runtime.DB.prepare(
      "UPDATE fb_discord_installations SET channel_audience_json = ? WHERE id = 'dci_test'",
    )
      .bind(JSON.stringify({ [CHANNEL_ID]: "members" }))
      .run();
    const memberReveal = await send(
      interaction(command("open", [{ name: "pool", type: 3, value: "test-pool" }]), {
        id: "restricted-member-reveal",
      }),
    );
    // The reveal stays private even when the channel audience would allow a
    // share. Posting is a separate, explicit Share to channel action.
    expect(memberReveal.payload.data?.flags).toBe(64);
    expect(memberReveal.payload.data?.embeds?.[0]?.title).toContain("Test One");
    expect(JSON.stringify(memberReveal.payload.data)).toContain("Share to channel");

    const instance = await runtime.DB.prepare(
      "SELECT ci.id FROM fb_card_instances ci JOIN fb_memberships m ON m.user_id = ci.user_id WHERE ci.card_id = ? AND ci.status = 'owned' LIMIT 1",
    )
      .bind(fixture.cardId)
      .first<{ id: string }>();
    expect(instance?.id).toBeTruthy();
    const shared = await send(
      interaction(
        { custom_id: `foilbury:tourshare:card:${instance?.id}`, component_type: 2 },
        { id: "verified-share", type: 3 },
      ),
    );
    expect(shared.payload.data?.flags).toBeUndefined();
    expect(JSON.stringify(shared.payload.data)).toContain("Shared by");
    const duplicate = await send(
      interaction(
        { custom_id: `foilbury:tourshare:card:${instance?.id}`, component_type: 2 },
        { id: "verified-share-2", type: 3 },
      ),
    );
    expect(duplicate.payload.data?.embeds?.[0]?.description).toMatch(/already shared/i);
  });

  it("selects the server's enabled album without a hard-coded slug", async () => {
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await fixturePool(player);
    const albums = await send(
      interaction(
        { custom_id: "foilbury:tour:albums", component_type: 2 },
        { id: "tour-scope-albums", type: 3 },
      ),
    );
    expect(albums.payload.data?.embeds?.[0]?.title).toBe("Test Public");
    expect(JSON.stringify(albums.payload.data)).not.toContain("Danganronpa");
  });

  it("starts the guided tour without drawing, spending or granting", async () => {
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await fixturePool(player);
    await send(interaction(command("daily"), { id: "tour-player-create" }));
    const before = await runtime.DB.prepare(
      "SELECT COUNT(*) AS count FROM fb_ledger_entries",
    ).first<{ count: number }>();
    const welcome = await send(interaction(command("tour"), { id: "tour-welcome" }));
    expect(welcome.payload.data?.flags).toBe(64);
    expect(welcome.payload.data?.embeds?.[0]?.title).toContain("guided tour");
    expect(JSON.stringify(welcome.payload.data)).toContain("Nothing in the tour spends");
    const welcomeIds = (welcome.payload.data?.components ?? [])
      .flatMap((row) => row.components ?? [])
      .map((component) => component.custom_id)
      .filter(Boolean);
    expect(new Set(welcomeIds).size).toBe(welcomeIds.length);
    // The persistent channel entry uses a bare component, not the slash
    // command. This is the exact custom id published in #card-collector-test.
    const entryButton = await send(
      interaction(
        { custom_id: "foilbury:tour:welcome", component_type: 2 },
        { id: "tour-entry-button", type: 3 },
      ),
    );
    expect(entryButton.payload.data?.flags).toBe(64);
    expect(entryButton.payload.data?.embeds?.[0]?.title).toContain("guided tour");
    expect(JSON.stringify(entryButton.payload.data)).toContain("Start with an album");
    const albums = await send(
      interaction(
        { custom_id: "foilbury:tour:albums", component_type: 2 },
        { id: "tour-albums", type: 3 },
      ),
    );
    expect(albums.payload.data?.embeds?.[0]?.title).toBeTruthy();
    const after = await runtime.DB.prepare(
      "SELECT COUNT(*) AS count FROM fb_ledger_entries",
    ).first<{ count: number }>();
    expect(after?.count).toBe(before?.count);
    const draws = await runtime.DB.prepare("SELECT COUNT(*) AS count FROM fb_draws").first<{
      count: number;
    }>();
    expect(draws?.count).toBe(0);
  });

  it("shows daily missions and claims exactly once from a button", async () => {
    await send(interaction(command("profile"), { id: "mission-profile" }));
    const identity = await runtime.DB.prepare("SELECT user_id FROM fb_discord_identities WHERE discord_user_id = ?").bind(DISCORD_USER_ID).first<{ user_id: string }>();
    const tenantId = (await ctxFor("cabinet", "player@foilbury.local")).tenant.id;
    await runtime.DB.prepare(
      "INSERT INTO fb_domain_events (id, tenant_id, user_id, event_type, object_type, object_id, dedupe_key, payload_json, created_at) VALUES ('evt_mission_explore', ?, ?, 'collection.explored', 'collection', 'col_test_public', ?, '{}', ?)",
    ).bind(tenantId, identity!.user_id, `mission-explore:${identity!.user_id}`, new Date().toISOString()).run();
    const view = await send(interaction(command("missions"), { id: "missions-view" }));
    expect(view.payload.data?.embeds?.[0]?.title).toContain("Daily missions");
    expect(view.payload.data?.flags).toBe(64);
    const claimButton = (view.payload.data?.components ?? []).flatMap((row) => row.components ?? []).find((component) => component.custom_id === "foilbury:mission:claim:explore");
    expect(claimButton).toBeTruthy();
    const before = await runtime.DB.prepare("SELECT balance FROM fb_wallets WHERE tenant_id = ? AND user_id = ?").bind(tenantId, identity!.user_id).first<{ balance: number }>();
    const claimed = await send(interaction({ custom_id: "foilbury:mission:claim:explore", component_type: 2 }, { id: "mission-claim", type: 3 }));
    expect(JSON.stringify(claimed.payload.data)).toContain("Foil credited");
    const after = await runtime.DB.prepare("SELECT balance FROM fb_wallets WHERE tenant_id = ? AND user_id = ?").bind(tenantId, identity!.user_id).first<{ balance: number }>();
    expect(after!.balance).toBe(before!.balance + 60);
    const replay = await send(interaction({ custom_id: "foilbury:mission:claim:explore", component_type: 2 }, { id: "mission-claim-replay", type: 3 }));
    expect(JSON.stringify(replay.payload.data)).toContain("Foil credited");
    const afterReplay = await runtime.DB.prepare("SELECT balance FROM fb_wallets WHERE tenant_id = ? AND user_id = ?").bind(tenantId, identity!.user_id).first<{ balance: number }>();
    expect(afterReplay!.balance).toBe(after!.balance);
    const claims = await runtime.DB.prepare("SELECT COUNT(*) AS count FROM fb_reward_claims WHERE tenant_id = ? AND user_id = ? AND rule_key LIKE '%:explore'").bind(tenantId, identity!.user_id).first<{ count: number }>();
    expect(claims?.count).toBe(1);
  });

  it("shows a labelled NPC profile and comparison on demand", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const npc = await createNpc(owner, { name: "Discord Rival", presetKey: "variety_collector", bio: "A clearly synthetic collector used only for the Discord inspection test." });
    const listed = await send(interaction(command("npc"), { id: "npc-list" }));
    expect(listed.payload.data?.embeds?.[0]?.title).toContain("NPC collectors");
    expect(JSON.stringify(listed.payload.data)).toContain("Discord Rival");
    expect(JSON.stringify(listed.payload.data)).toContain("synthetic collector");
    const detail = await send(interaction(command("npc", [{ name: "name", type: 3, value: npc.slug }]), { id: "npc-detail" }));
    expect(detail.payload.data?.embeds?.[0]?.title).toContain("Discord Rival");
    expect(JSON.stringify(detail.payload.data)).toContain("NPC");
    expect(JSON.stringify(detail.payload.data)).toContain("Your album");
    expect(detail.payload.data?.flags).toBe(64);
  });

  it("walks the guided tour from discovery through a genuine opening and private inspection", async () => {
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await fixturePool(player);
    const welcome = await send(interaction(command("tour"), { id: "tour-journey-welcome" }));
    expect(welcome.payload.data?.flags).toBe(64);
    expect(welcome.payload.data?.embeds?.[0]?.title).toContain("guided tour");

    const albums = await send(
      interaction(
        { custom_id: "foilbury:tour:albums", component_type: 2 },
        { id: "tour-journey-albums", type: 3 },
      ),
    );
    expect(albums.payload.data?.flags).toBe(64);
    expect(JSON.stringify(albums.payload.data)).toContain("Release roster");
    expectUniqueComponentIds(albums.payload.data ?? {});

    const fresh = await send(
      interaction(
        { custom_id: "foilbury:tour:fresh", component_type: 2 },
        { id: "tour-journey-fresh", type: 3 },
      ),
    );
    expect(JSON.stringify(fresh.payload.data)).toContain("Free play, first run");
    expectUniqueComponentIds(fresh.payload.data ?? {});

    const open = await send(
      interaction(
        { custom_id: "foilbury:tour:open", component_type: 2 },
        { id: "tour-journey-open", type: 3 },
      ),
    );
    expectUniqueComponentIds(open.payload.data ?? {});
    const openRow = open.payload.data?.components?.flatMap((row) => row.components ?? []) ?? [];
    const openButton = openRow.find(
      (component) => component.type === 2 && component.custom_id?.startsWith("foilbury:open:"),
    );
    expect(openButton?.custom_id).toBeTruthy();

    const before = await runtime.DB.prepare("SELECT COUNT(*) AS count FROM fb_draws").first<{
      count: number;
    }>();
    const draw = await send(
      interaction(
        { custom_id: openButton!.custom_id, component_type: 2 },
        { id: "tour-journey-draw", type: 3 },
      ),
    );
    const after = await runtime.DB.prepare("SELECT COUNT(*) AS count FROM fb_draws").first<{
      count: number;
    }>();
    expect(after?.count).toBe((before?.count ?? 0) + 1);
    expect([4, 7]).toContain(draw.payload.type);
    expect(draw.payload.data?.embeds?.[0]?.title).toContain("Test One");
    expect(JSON.stringify(draw.payload)).toContain("foilbury-reveal-card.webp");
    const drawRow = await runtime.DB.prepare(
      "SELECT d.id, d.instance_id, ci.serial FROM fb_draws d JOIN fb_card_instances ci ON ci.id = d.instance_id ORDER BY d.rowid DESC LIMIT 1",
    ).first<{ id: string; instance_id: string; serial: string }>();
    expect(drawRow?.serial).toMatch(/FB-/);
    const spend = await runtime.DB.prepare(
      "SELECT amount FROM fb_ledger_entries WHERE kind = 'spend' ORDER BY created_at DESC LIMIT 1",
    ).first<{ amount: number }>();
    expect(spend?.amount).toBe(-80);

    const inspect = await send(
      interaction(
        { custom_id: "foilbury:tour:inspect", component_type: 2 },
        { id: "tour-journey-inspect", type: 3 },
      ),
    );
    const inspectText = JSON.stringify(inspect.payload.data);
    expect(inspectText).toContain("Inspect ·");
    expectUniqueComponentIds(inspect.payload.data ?? {});
    expect(inspectText).toContain("Discord does not present native 3D");
    expect(inspectText).toMatch(/No published finish renders|Plain/);

    const progress = await send(
      interaction(
        { custom_id: "foilbury:tour:progress", component_type: 2 },
        { id: "tour-journey-progress", type: 3 },
      ),
    );
    expectUniqueComponentIds(progress.payload.data ?? {});
    expect(JSON.stringify(progress.payload.data)).toContain("Progress ·");
    expect(JSON.stringify(progress.payload.data)).toContain("Unique subjects");
  });
});
