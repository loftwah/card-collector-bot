import { beforeEach, describe, expect, it } from "vitest";
import { handleDiscordInteraction } from "../../src/server/discord/handler";
import { signDiscordRequest } from "../../src/server/discord/signature";
import type { DiscordEnv } from "../../src/server/discord/types";
import { bootstrap, ctxFor, fixturePool, runtime } from "./helpers";

const APPLICATION_ID = "1566702936615026769";
const GUILD_ID = "997734945206313041";
const CHANNEL_ID = "1566700752385081355";
const DISCORD_USER_ID = "707281352818425929";

let privateKey: CryptoKey;
let publicKeyHex: string;

async function makeKeys() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  privateKey = pair.privateKey;
  const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
  publicKeyHex = Array.from(new Uint8Array(raw), (byte) => byte.toString(16).padStart(2, "0")).join("");
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
  options: { timestamp?: number; signatureBody?: string; channelId?: string; guildId?: string } = {},
) {
  const raw = JSON.stringify(body);
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const signature = await signDiscordRequest({ body: options.signatureBody ?? raw, timestamp, privateKey });
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
  return { name: "foilbury", type: 1, options: [{ name, type: name === "admin" ? 2 : 1, options }] };
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
    const { response, payload } = await send({ id: "ping-1", application_id: APPLICATION_ID, type: 1, token: "t" });
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
    const body = interaction(command("open", [{ name: "pool", type: 3, value: "test-pool" }]), { id: "draw-1" });
    const first = await send(body);
    expect(first.payload.type).toBe(4);
    expect(first.payload.data?.embeds?.[0]?.title).toContain("Test One");
    const draw = await runtime.DB.prepare(
      "SELECT d.instance_id, d.receipt_json, ci.user_id, ci.serial FROM fb_draws d JOIN fb_card_instances ci ON ci.id = d.instance_id WHERE d.idempotency_key = ?",
    )
      .bind("discord:draw-1:open")
      .first<{ instance_id: string; user_id: string; serial: string }>();
    expect(draw?.instance_id).toBeTruthy();
    const identity = await runtime.DB.prepare("SELECT user_id FROM fb_discord_identities WHERE discord_user_id = ?")
      .bind(DISCORD_USER_ID)
      .first<{ user_id: string }>();
    expect(draw?.user_id).toBe(identity?.user_id);

    const replay = await send(body);
    expect(replay.payload.data?.embeds?.[0]?.title).toContain("Test One");
    const draws = await runtime.DB.prepare("SELECT COUNT(*) AS count FROM fb_draws WHERE idempotency_key = ?")
      .bind("discord:draw-1:open")
      .first<{ count: number }>();
    const instances = await runtime.DB.prepare("SELECT COUNT(*) AS count FROM fb_card_instances WHERE user_id = ?")
      .bind(identity?.user_id)
      .first<{ count: number }>();
    expect(draws?.count).toBe(1);
    expect(instances?.count).toBe(1);
  });

  it("shows the same awarded instance in a later collection lookup", async () => {
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await fixturePool(player);
    const draw = await send(interaction(command("open", [{ name: "pool", type: 3, value: "test-pool" }]), { id: "draw-collection" }));
    const title = draw.payload.data?.embeds?.[0]?.title ?? "";
    const collection = await send(interaction(command("collection"), { id: "collection-1" }));
    const text = JSON.stringify(collection.payload.data);
    expect(text).toContain("Your collection");
    expect(text).toContain("Test One");
    expect(title).toContain("Test One");
    const card = await send(interaction(command("card", [{ name: "query", type: 3, value: "Test One" }]), { id: "card-link" }));
    const actionRow = card.payload.data?.components?.[0];
    const link = actionRow?.components?.find((component) => component.style === 5);
    expect(link?.type).toBe(2);
    expect(link?.style).toBe(5);
    expect(link?.url).toContain("/play/collection");
  });

  it("rejects the wrong guild, the wrong channel, and unbound installations", async () => {
    const wrongGuild = await send(interaction(command("daily"), { guildId: "111111111111111111", id: "wrong-guild" }));
    expect(wrongGuild.payload.data?.embeds?.[0]?.description).toMatch(/not bound/i);
    const wrongChannel = await send(interaction(command("daily"), { channelId: "222222222222222222", id: "wrong-channel" }));
    expect(wrongChannel.payload.data?.embeds?.[0]?.description).toMatch(/not enabled in this channel/i);
    const claims = await runtime.DB.prepare("SELECT COUNT(*) AS count FROM fb_reward_claims").first<{ count: number }>();
    expect(claims?.count).toBe(0);
  });

  it("denies admin commands to ordinary players and allows a Bot Owner", async () => {
    const denied = await send(interaction(command("admin", [{ name: "status", type: 1, options: [] }]), { id: "admin-denied" }));
    expect(denied.payload.data?.embeds?.[0]?.description).toMatch(/Owner or Admin/i);

    const identity = await runtime.DB.prepare("SELECT user_id FROM fb_discord_identities WHERE discord_user_id = ?")
      .bind(DISCORD_USER_ID)
      .first<{ user_id: string }>();
    await runtime.DB.prepare("UPDATE fb_memberships SET role = 'owner' WHERE user_id = ?").bind(identity?.user_id).run();
    const allowed = await send(interaction(command("admin", [{ name: "status", type: 1, options: [] }]), { id: "admin-allowed" }));
    expect(allowed.payload.data?.embeds?.[0]?.title).toContain("Bot status");
  });

  it("acknowledges immediately and edits the original response after deferred work", async () => {
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await fixturePool(player);
    await runtime.MEDIA.put("test/render.webp", new Uint8Array([82, 73, 70, 70, 1, 2, 3]));
    const body = interaction(command("open", [{ name: "pool", type: 3, value: "test-pool" }]), { id: "deferred-draw" });
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
      const id = method === "GET" && url.includes("/messages/@original") ? "original-message" : "follow-up-message";
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
    expect(calls[0]!.url).toContain("/webhooks/1566702936615026769/test-interaction-token?wait=true");
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
    const body = interaction(command("open", [{ name: "pool", type: 3, value: "test-pool" }]), { id: "concurrent-draw" });
    const [first, second] = await Promise.all([send(body), send(body)]);
    expect(first.payload.type).toBe(4);
    expect(second.payload.type).toBe(4);
    const draws = await runtime.DB.prepare("SELECT COUNT(*) AS count FROM fb_draws WHERE idempotency_key = ?")
      .bind("discord:concurrent-draw:open")
      .first<{ count: number }>();
    const identity = await runtime.DB.prepare("SELECT user_id FROM fb_discord_identities WHERE discord_user_id = ?")
      .bind(DISCORD_USER_ID)
      .first<{ user_id: string }>();
    const instances = await runtime.DB.prepare("SELECT COUNT(*) AS count FROM fb_card_instances WHERE user_id = ?")
      .bind(identity?.user_id)
      .first<{ count: number }>();
    expect(draws?.count).toBe(1);
    expect(instances?.count).toBe(1);
  });

  it("finds a card by its display name as well as its slug", async () => {
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await fixturePool(player);
    const result = await send(interaction(command("card", [{ name: "query", type: 3, value: "Test One" }]), { id: "card-by-name" }));
    expect(result.payload.data?.embeds?.[0]?.title).toBe("Test One");
  });

  it("requires a confirmation button for a sensitive admin grant and records it once", async () => {
    const first = await send(interaction(command("daily"), { id: "grant-player-create" }));
    expect(first.payload.type).toBe(4);
    const identity = await runtime.DB.prepare("SELECT user_id FROM fb_discord_identities WHERE discord_user_id = ?")
      .bind(DISCORD_USER_ID)
      .first<{ user_id: string }>();
    await runtime.DB.prepare("UPDATE fb_memberships SET role = 'owner' WHERE user_id = ?").bind(identity?.user_id).run();

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
    const used = await runtime.DB.prepare("SELECT used_at FROM fb_discord_confirmations WHERE id = ?")
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
    const unknown = await send(interaction({ custom_id: "foilbury:not-a-real-button", component_type: 2 }, { id: "button-unknown", type: 3 }));
    expect(unknown.payload.data?.embeds?.[0]?.description).toMatch(/not recognised/i);
  });
});
