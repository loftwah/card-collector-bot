import { beforeEach, describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { signDiscordRequest } from "../../src/server/discord/signature";
import { bootstrap, ctxFor, fixturePool, runtime } from "../workers/helpers";
import { DiscordTransport } from "../workers/discord-transport";
import { TEST_DISCORD_PRIVATE_JWK } from "./test-keys";

const APPLICATION_ID = "1566702936615026769";
const GUILD_ID = "997734945206313041";
const CHANNEL_ID = "1566700752385081355";
const DISCORD_USER_ID = "707281352818425929";

async function privateKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    TEST_DISCORD_PRIVATE_JWK,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
}

async function signedRequest(body: Record<string, unknown>): Promise<Request> {
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await signDiscordRequest({
    body: raw,
    timestamp,
    privateKey: await privateKey(),
  });
  return new Request("https://foilbury.test/api/discord/interactions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-signature-ed25519": signature,
      "x-signature-timestamp": timestamp,
    },
    body: raw,
  });
}

async function waitForTerminal(interactionId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const row = await runtime.DB.prepare(
      "SELECT status FROM fb_discord_interactions WHERE interaction_id = ?",
    )
      .bind(interactionId)
      .first<{ status: string }>();
    if (row && row.status !== "processing") return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`interaction ${interactionId} did not reach a terminal state`);
}

async function install(): Promise<void> {
  await bootstrap();
  await runtime.DB.prepare(
    `INSERT INTO fb_discord_installations
      (id, tenant_id, application_id, guild_id, guild_name, channel_allowlist_json, game_enabled, website_enabled, api_enabled, public_catalogue_enabled, admin_gui_enabled, active, created_at, updated_at)
     SELECT 'dci_prod_path', id, ?, ?, 'Loftwah', ?, 1, 1, 1, 1, 1, 1, ?, ?
       FROM fb_tenants WHERE slug = 'cabinet'`,
  )
    .bind(
      APPLICATION_ID,
      GUILD_ID,
      JSON.stringify([CHANNEL_ID]),
      new Date().toISOString(),
      new Date().toISOString(),
    )
    .run();
}

function interaction(id: string) {
  return {
    id,
    application_id: APPLICATION_ID,
    type: 2,
    token: "production-path-token",
    guild_id: GUILD_ID,
    channel_id: CHANNEL_ID,
    member: {
      user: { id: DISCORD_USER_ID, username: "dean", global_name: "Dean" },
      roles: [],
    },
    data: {
      name: "foilbury",
      type: 1,
      options: [{ name: "open", type: 1, options: [{ name: "pool", type: 3, value: "test-pool" }] }],
    },
  };
}

describe("production Worker entry", () => {
  beforeEach(async () => {
    await install();
  });

  it("runs a signed draw through src/worker.ts with a private deferred acknowledgement", async () => {
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await fixturePool(player);
    await runtime.MEDIA.put("test/render.webp", new Uint8Array([82, 73, 70, 70, 1, 2, 3]));

    const transport = new DiscordTransport();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = transport.fetch as typeof fetch;
    try {
      const response = await SELF.fetch(await signedRequest(interaction("worker-entry-draw")));
      expect(response.status).toBe(200);
      const ack = (await response.json()) as { type: number; data?: { flags?: number } };
      expect(ack).toEqual({ type: 5, data: { flags: 64 } });
      transport.acknowledge("production-path-token", ack.data?.flags);
      await waitForTerminal("worker-entry-draw");
    } finally {
      globalThis.fetch = originalFetch;
    }

    const original = transport.original("production-path-token");
    expect(original?.loading).toBe(false);
    expect(original?.visibility).toBe("ephemeral");
    expect(JSON.stringify(original?.payload)).toContain("Test One");
    expect(transport.publicMessages()).toHaveLength(0);

    const receipt = await runtime.DB.prepare(
      "SELECT status, error_code, receipt_json FROM fb_discord_interactions WHERE interaction_id = ?",
    )
      .bind("worker-entry-draw")
      .first<{ status: string; error_code: string | null; receipt_json: string | null }>();
    expect(receipt?.status).toBe("completed");
    expect(receipt?.error_code).toBeNull();
    expect(receipt?.receipt_json).toContain("Test One");

    const draws = await runtime.DB.prepare(
      "SELECT COUNT(*) AS count FROM fb_draws WHERE idempotency_key = ?",
    )
      .bind("discord:worker-entry-draw:open")
      .first<{ count: number }>();
    expect(draws?.count).toBe(1);
  });

  it("rejects an invalid signature before any domain work", async () => {
    const request = await signedRequest(interaction("worker-entry-invalid"));
    const invalid = new Request(request, {
      headers: {
        ...Object.fromEntries(request.headers.entries()),
        "x-signature-ed25519": "00".repeat(64),
      },
    });
    const response = await SELF.fetch(invalid);
    expect(response.status).toBe(401);
    const draws = await runtime.DB.prepare("SELECT COUNT(*) AS count FROM fb_draws").first<{
      count: number;
    }>();
    expect(draws?.count).toBe(0);
  });
});
