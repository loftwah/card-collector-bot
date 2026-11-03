import { beforeEach, describe, expect, it } from "vitest";
import { handleDiscordInteraction } from "../../src/server/discord/handler";
import { signDiscordRequest } from "../../src/server/discord/signature";
import type { DiscordEnv } from "../../src/server/discord/types";
import { bootstrap, ctxFor, fixturePool, runtime, setBalance } from "./helpers";
import { addCollectionCards, createCollection } from "../../src/server/modules/collections";
import { createNpc } from "../../src/server/modules/npcs";

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
    expect(text).toContain("Your collection");
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

  it("acknowledges immediately and edits the original response after deferred work", async () => {
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

    const pending: Promise<unknown>[] = [];
    const calls: Array<{ url: string; body: string; method: string; files: number }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method ?? "GET");
      const form = init?.body instanceof FormData ? init.body : null;
      calls.push({
        url,
        body: form ? String(form.get("payload_json") ?? "") : String(init?.body ?? ""),
        method,
        files: form ? form.getAll("files[0]").length : 0,
      });
      const id =
        method === "GET" && url.includes("/messages/@original")
          ? "original-message"
          : "follow-up-message";
      return new Response(JSON.stringify({ id }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const response = await handleDiscordInteraction(request, env(), {
        publicKey: publicKeyHex,
        waitUntil: (promise) => pending.push(promise),
      });
      const ack = (await response.json()) as { type?: number; data?: { flags?: number } };
      expect(ack.type).toBe(5);
      expect(ack.data?.flags).toBeUndefined();
      await Promise.all(pending);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(calls).toHaveLength(3);
    expect(calls[0]!.url).toContain(
      "/webhooks/1566702936615026769/test-interaction-token?wait=true",
    );
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toContain("Test One");
    expect(calls[0]!.body).toContain("attachment://foilbury-card.webp");
    expect(calls[0]!.body).toContain('"width":750');
    expect(calls[0]!.files).toBe(1);
    expect(calls[1]!.url).toContain("/messages/@original");
    expect(calls[1]!.method).toBe("GET");
    expect(calls[2]!.url).toContain("/messages/@original");
    expect(calls[2]!.method).toBe("DELETE");
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
    expect(result.payload.data?.embeds?.[0]?.title).toBe("Test One");
  });

  it("requires a confirmation button for a sensitive admin grant and records it once", async () => {
    const first = await send(interaction(command("daily"), { id: "grant-player-create" }));
    expect(first.payload.type).toBe(4);
    const identity = await runtime.DB.prepare(
      "SELECT user_id FROM fb_discord_identities WHERE discord_user_id = ?",
    )
      .bind(DISCORD_USER_ID)
      .first<{ user_id: string }>();
    await runtime.DB.prepare("UPDATE fb_memberships SET role = 'owner' WHERE user_id = ?")
      .bind(identity?.user_id)
      .run();

    const requested = await send(
      interaction(
        command("admin", [
          {
            name: "grant",
            type: 1,
            options: [
              { name: "user", type: 3, value: DISCORD_USER_ID },
              { name: "amount", type: 4, value: 100 },
              { name: "reason", type: 3, value: "test grant" },
            ],
          },
        ]),
        { id: "grant-request" },
      ),
    );
    expect(requested.payload.data?.embeds?.[0]?.title).toMatch(/Confirm admin grant/i);
    const confirmation = await runtime.DB.prepare(
      "SELECT id, used_at FROM fb_discord_confirmations WHERE discord_user_id = ? ORDER BY created_at DESC LIMIT 1",
    )
      .bind(DISCORD_USER_ID)
      .first<{ id: string; used_at: string | null }>();
    expect(confirmation?.id).toBeTruthy();
    expect(confirmation?.used_at).toBeNull();

    const confirmed = await send(
      interaction(
        { custom_id: `foilbury:confirm:${confirmation?.id}`, component_type: 2 },
        { id: "grant-confirm", type: 3 },
      ),
    );
    expect(confirmed.payload.data?.embeds?.[0]?.title).toMatch(/Admin grant recorded/i);
    const used = await runtime.DB.prepare(
      "SELECT used_at FROM fb_discord_confirmations WHERE id = ?",
    )
      .bind(confirmation?.id)
      .first<{ used_at: string | null }>();
    expect(used?.used_at).toBeTruthy();

    const replay = await send(
      interaction(
        { custom_id: `foilbury:confirm:${confirmation?.id}`, component_type: 2 },
        { id: "grant-confirm-replay", type: 3 },
      ),
    );
    expect(replay.payload.data?.embeds?.[0]?.description).toMatch(/already been used/i);
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
    expect(unknown.payload.data?.embeds?.[0]?.description).toMatch(/not recognised/i);
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
    const requested = await send(
      interaction(
        command("admin", [
          {
            name: "grant",
            type: 1,
            options: [
              { name: "user", type: 3, value: DISCORD_USER_ID },
              { name: "amount", type: 4, value: 100 },
              { name: "reason", type: 3, value: "revocation test" },
            ],
          },
        ]),
        { id: "revoked-grant-request" },
      ),
    );
    expect(requested.payload.data?.embeds?.[0]?.title).toMatch(/Confirm admin grant/i);
    const confirmation = await runtime.DB.prepare(
      "SELECT id FROM fb_discord_confirmations WHERE discord_user_id = ? ORDER BY created_at DESC LIMIT 1",
    )
      .bind(DISCORD_USER_ID)
      .first<{ id: string }>();
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
    expect(JSON.stringify(publicReveal.payload.data)).toMatch(/Private reveal/i);

    const share = await send(
      interaction(
        { custom_id: "foilbury:tourshare:card:not-owned", component_type: 2 },
        { id: "restricted-share", type: 3 },
      ),
    );
    expect(share.payload.data?.embeds?.[0]?.description).toMatch(
      /not in your cabinet|not available/i,
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
    expect(memberReveal.payload.data?.flags).toBeUndefined();
    expect(memberReveal.payload.data?.embeds?.[0]?.title).toContain("Test One");

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

  it("starts the guided tour without drawing, spending or granting", async () => {
    await send(interaction(command("daily"), { id: "tour-player-create" }));
    const before = await runtime.DB.prepare(
      "SELECT COUNT(*) AS count FROM fb_ledger_entries",
    ).first<{ count: number }>();
    const welcome = await send(interaction(command("tour"), { id: "tour-welcome" }));
    expect(welcome.payload.data?.flags).toBe(64);
    expect(welcome.payload.data?.embeds?.[0]?.title).toContain("guided tour");
    expect(JSON.stringify(welcome.payload.data)).toContain("Nothing in the tour spends");
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

    const fresh = await send(
      interaction(
        { custom_id: "foilbury:tour:fresh", component_type: 2 },
        { id: "tour-journey-fresh", type: 3 },
      ),
    );
    expect(JSON.stringify(fresh.payload.data)).toContain("Free play, first run");

    const open = await send(
      interaction(
        { custom_id: "foilbury:tour:open", component_type: 2 },
        { id: "tour-journey-open", type: 3 },
      ),
    );
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
    expect(JSON.stringify(draw.payload)).toContain("foilbury-card.webp");
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
    expect(inspectText).toContain("Discord does not present native 3D");
    expect(inspectText).toMatch(/No published finish renders|Plain/);

    const progress = await send(
      interaction(
        { custom_id: "foilbury:tour:progress", component_type: 2 },
        { id: "tour-journey-progress", type: 3 },
      ),
    );
    expect(JSON.stringify(progress.payload.data)).toContain("Progress ·");
    expect(JSON.stringify(progress.payload.data)).toContain("Unique subjects");
  });
});
