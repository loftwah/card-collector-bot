import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  expireStaleDiscordInteractions,
  handleDiscordInteraction,
} from "../../src/server/discord/handler";
import { drawIdempotencyKey, drawRecoveryMessage, recoverDrawReceipt } from "../../src/server/discord/receipts";
import { signDiscordRequest } from "../../src/server/discord/signature";
import type { DiscordEnv } from "../../src/server/discord/types";
import { sha256Hex } from "../../src/server/ids";
import { executeDraw, getPoolPreview } from "../../src/server/modules/pools";
import { bootstrap, ctxFor, fixturePool, runtime } from "./helpers";
import { DiscordTransport } from "./discord-transport";

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

function envFor(db: D1Database): DiscordEnv {
  return new Proxy(runtime as unknown as DiscordEnv, {
    get(target, property) {
      if (property === "DB") return db;
      if (property === "DISCORD_APPLICATION_ID") return APPLICATION_ID;
      if (property === "DISCORD_PUBLIC_KEY") return publicKeyHex;
      if (property === "FOILBURY_PUBLIC_ORIGIN") return "https://foilbury.test";
      return (target as unknown as Record<PropertyKey, unknown>)[property];
    },
  });
}

interface FaultRule {
  label: string;
  match: (sql: string) => boolean;
  method?: "run" | "first" | "all" | "raw";
  mode?: "throw" | "zero";
  times?: number;
  afterDrawCommit?: boolean;
  /** Let this many matching calls pass before failing. */
  skip?: number;
}

interface FaultDatabase {
  db: D1Database;
  committed(): boolean;
}

/**
 * A narrow D1 fault injector. It only alters the handler's DB handle, leaving
 * the real database available for assertions and for the rest of the setup.
 */
function faultDatabase(rules: FaultRule[]): FaultDatabase {
  let committed = false;
  const originals = new WeakMap<object, D1PreparedStatement>();
  const sqlByStatement = new WeakMap<object, string>();
  const states = rules.map((rule) => ({
    rule,
    remaining: rule.times ?? Number.POSITIVE_INFINITY,
    skip: rule.skip ?? 0,
  }));

  const takeFailure = (sql: string, method: string): FaultRule | null => {
    for (const state of states) {
      const rule = state.rule;
      if (state.remaining <= 0) continue;
      if (rule.method && rule.method !== method) continue;
      if (rule.afterDrawCommit && !committed) continue;
      if (!rule.match(sql)) continue;
      if (state.skip > 0) {
        state.skip -= 1;
        continue;
      }
      state.remaining -= 1;
      return rule;
    }
    return null;
  };

  const wrapStatement = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(statement as unknown as Record<PropertyKey, unknown>, {
      get(target, property) {
        if (property === "bind") {
          return (...args: unknown[]) => {
            const bound = (target.bind as (...values: unknown[]) => D1PreparedStatement)(...args);
            return wrapStatement(bound, sql);
          };
        }
        if (
          property === "run" ||
          property === "first" ||
          property === "all" ||
          property === "raw"
        ) {
          return async (...args: unknown[]) => {
            const failure = takeFailure(sql, String(property));
            if (failure) {
              if ((failure.mode ?? "throw") === "zero") {
                return {
                  success: true,
                  meta: {
                    changes: 0,
                    duration: 0,
                    last_row_id: 0,
                    changed_db: false,
                    size_after: 0,
                    rows_read: 0,
                    rows_written: 0,
                  },
                  results: [],
                };
              }
              throw new Error(`Injected ${failure.label} failure`);
            }
            return (target[property] as (...values: unknown[]) => unknown)(...args);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as D1PreparedStatement;
    originals.set(proxy, statement);
    sqlByStatement.set(proxy, sql);
    return proxy;
  };

  const db = new Proxy(runtime.DB as unknown as Record<PropertyKey, unknown>, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string) => wrapStatement(target.prepare(sql) as D1PreparedStatement, sql);
      }
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          const raw = statements.map((statement) => originals.get(statement) ?? statement);
          const containsDraw = statements.some((statement) =>
            (sqlByStatement.get(statement) ?? "").includes("INSERT INTO fb_draws"),
          );
          const result = await target.batch(raw);
          if (containsDraw) committed = true;
          return result;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as D1Database;

  return { db, committed: () => committed };
}

function interaction(
  data: Record<string, unknown>,
  overrides: {
    id?: string;
    type?: number;
    token?: string;
    channelId?: string;
    guildId?: string;
  } = {},
) {
  return {
    id: overrides.id ?? `interaction-${Math.random().toString(36).slice(2)}`,
    application_id: APPLICATION_ID,
    type: overrides.type ?? 2,
    token: overrides.token ?? "test-interaction-token",
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

async function requestFor(body: Record<string, unknown>): Promise<Request> {
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await signDiscordRequest({ body: raw, timestamp, privateKey });
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

async function send(body: Record<string, unknown>, db: D1Database = runtime.DB) {
  const response = await handleDiscordInteraction(await requestFor(body), envFor(db), {
    publicKey: publicKeyHex,
  });
  return {
    response,
    payload: (await response.json()) as {
      type?: number;
      data?: {
        content?: string;
        embeds?: Array<{ title?: string; description?: string }>;
        flags?: number;
      };
      error?: string;
    },
  };
}

async function deliverDeferred(
  body: Record<string, unknown>,
  db: D1Database,
  transport: DiscordTransport,
): Promise<void> {
  const token = String(body.token);
  const pending: Promise<unknown>[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = transport.fetch as typeof fetch;
  try {
    const response = await handleDiscordInteraction(await requestFor(body), envFor(db), {
      publicKey: publicKeyHex,
      waitUntil: (promise) => pending.push(promise),
    });
    const ack = (await response.json()) as { type?: number; data?: { flags?: number } };
    expect(ack.type).toBe(5);
    expect(ack.data?.flags).toBe(64);
    transport.acknowledge(token, ack.data?.flags);
    await Promise.all(pending);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function redeliver(
  originalInteractionId: string,
  transport: DiscordTransport,
  token = "redeliver-token",
  db: D1Database = runtime.DB,
): Promise<void> {
  const body = interaction(
    { custom_id: `foilbury:redeliver:${originalInteractionId}`, component_type: 2 },
    { id: `redeliver-${originalInteractionId}`, type: 3, token },
  );
  await deliverDeferred(body, db, transport);
}

async function discordPlayer() {
  return ctxFor("cabinet", `discord.${DISCORD_USER_ID}@players.foilbury.invalid`);
}

async function replayDraw(interactionId: string) {
  const player = await discordPlayer();
  const digest = await sha256Hex(
    `discord-open:${player.tenant.id}:${player.user!.id}:test-pool:${interactionId}`,
  );
  const preview = await getPoolPreview(player, "test-pool");
  return executeDraw(player, {
    pool: "test-pool",
    expectedRevision: preview.revision,
    expectedDistribution: preview.distribution_fingerprint,
    idempotency: { key: drawIdempotencyKey(interactionId), digest },
  });
}

async function committedDraw(interactionId: string) {
  const draws = await runtime.DB.prepare(
    `SELECT d.id, d.instance_id, d.receipt_json, ci.serial, ci.user_id
       FROM fb_draws d JOIN fb_card_instances ci ON ci.id = d.instance_id
      WHERE d.idempotency_key = ?`,
  )
    .bind(drawIdempotencyKey(interactionId))
    .all<{
      id: string;
      instance_id: string;
      receipt_json: string;
      serial: string;
      user_id: string;
    }>();
  expect(draws.results).toHaveLength(1);
  const draw = draws.results[0]!;

  const drawsForKey = await runtime.DB.prepare(
    "SELECT COUNT(*) AS count FROM fb_draws WHERE idempotency_key = ?",
  )
    .bind(drawIdempotencyKey(interactionId))
    .first<{ count: number }>();
  const instances = await runtime.DB.prepare(
    "SELECT COUNT(*) AS count FROM fb_card_instances WHERE id = ?",
  )
    .bind(draw.instance_id)
    .first<{ count: number }>();
  const spends = await runtime.DB.prepare(
    `SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total
       FROM fb_ledger_entries
      WHERE tenant_id = ? AND user_id = ? AND kind = 'spend' AND reference_type = 'draw' AND reference_id = ?`,
  )
    .bind((await discordPlayer()).tenant.id, draw.user_id, draw.id)
    .first<{ count: number; total: number }>();

  expect(drawsForKey?.count).toBe(1);
  expect(instances?.count).toBe(1);
  expect(spends?.count).toBe(1);
  expect(spends?.total).toBe(-80);
  expect(draw.serial).toMatch(/^FB-/);
  return draw;
}

async function assertRewardSettledOnce() {
  const rewards = await runtime.DB.prepare(
    `SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total
       FROM fb_ledger_entries
      WHERE kind = 'issue' AND reference_type = 'achievement'`,
  ).first<{ count: number; total: number }>();
  expect(rewards?.count).toBe(1);
  expect(rewards?.total).toBe(160);
}

describe("Discord draw commit recovery", () => {
  beforeEach(async () => {
    await bootstrap();
    await makeKeys();
    await install();
  });

  it("labels a recovered historical balance as the opening balance after the wallet changes", async () => {
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await fixturePool(player);
    const interactionId = "recovery-historical-balance";
    const original = new DiscordTransport();
    await deliverDeferred(interaction(command("open", [{ name: "pool", type: 3, value: "test-pool" }]), { id: interactionId }), runtime.DB, original);
    const draw = await committedDraw(interactionId);
    await runtime.DB.prepare("UPDATE fb_wallets SET balance = 999 WHERE tenant_id = ? AND user_id = ?").bind(player.tenant.id, draw.user_id).run();
    const retry = new DiscordTransport();
    await redeliver(interactionId, retry);
    const visible = JSON.stringify(retry.original("redeliver-token")!.payload);
    expect(visible).toContain("Balance after that opening");
    expect(visible).not.toContain("Current balance");
    expect(visible).not.toContain("999");
    await committedDraw(interactionId);
  });

  it("recovers from the draw row when the receipt write fails after the commit", async () => {
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await fixturePool(player);
    // Force the normal reveal builder to fail after the draw, so the handler
    // must recover from the draw row rather than only the interaction receipt.
    await runtime.DB.prepare(
      "UPDATE fb_card_definitions SET name = 'usr_secret123' WHERE id = 'crd_test_card'",
    ).run();

    const faults = faultDatabase([
      {
        label: "receipt persistence",
        match: (sql) =>
          sql.includes("UPDATE fb_discord_interactions") && sql.includes("receipt_kind"),
        method: "run",
        times: 20,
      },
    ]);
    const transport = new DiscordTransport();
    const interactionId = "recovery-lost-receipt";
    await deliverDeferred(
      interaction(command("open", [{ name: "pool", type: 3, value: "test-pool" }]), {
        id: interactionId,
      }),
      faults.db,
      transport,
    );

    const draw = await committedDraw(interactionId);
    const original = transport.original("test-interaction-token")!;
    const payload = JSON.stringify(original.payload);
    expect(payload).toContain("Draw completed — display interrupted");
    expect(payload).toContain("did");
    expect(payload).toContain(draw.serial);
    expect(payload).not.toContain("nothing changed");

    const record = await runtime.DB.prepare(
      "SELECT status, error_code, receipt_json FROM fb_discord_interactions WHERE interaction_id = ?",
    )
      .bind(interactionId)
      .first<{ status: string; error_code: string | null; receipt_json: string | null }>();
    expect(record?.status).toBe("completed");
    // The Effect workflow distinguishes a failed receipt write from a
    // delivery-only recovery; both are honest, and the receipt remains absent.
    expect(["delivery_recovered", "receipt_persist_failed"]).toContain(record?.error_code);
    expect(record?.receipt_json).toBeNull();

    const redelivery = new DiscordTransport();
    await redeliver(interactionId, redelivery);
    const resent = JSON.stringify(redelivery.original("redeliver-token")!.payload);
    expect(resent).toContain("recorded result");
    expect(resent).toContain("No second pull");
    expect(resent).toContain(draw.serial);
    await committedDraw(interactionId);
    await assertRewardSettledOnce();

    const replay = await replayDraw(interactionId);
    expect(replay.replayed).toBe(true);
    expect(replay.instance_id).toBe(draw.instance_id);
    expect(replay.serial).toBe(draw.serial);
    await committedDraw(interactionId);
    await assertRewardSettledOnce();
  });

  it("keeps a committed draw when reward settlement read-back fails", async () => {
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await fixturePool(player);
    const errors: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((value) => {
      errors.push(String(value));
    });
    const faults = faultDatabase([
      {
        label: "settlement read-back",
        match: (sql) => sql.includes("FROM fb_wallets w JOIN fb_economy_settings"),
        method: "first",
        afterDrawCommit: true,
        skip: 2,
        times: 1,
      },
    ]);
    const transport = new DiscordTransport();
    const interactionId = "recovery-settlement-read";
    try {
      await deliverDeferred(
        interaction(command("open", [{ name: "pool", type: 3, value: "test-pool" }]), {
          id: interactionId,
        }),
        faults.db,
        transport,
      );
    } finally {
      errorSpy.mockRestore();
    }

    expect(faults.committed()).toBe(true);
    expect(errors.join("\n")).toContain("wallet read after draw failed");
    expect(errors.join("\n")).not.toContain("Injected settlement read-back failure");
    const original = JSON.stringify(transport.original("test-interaction-token")!.payload);
    expect(original).toContain("Test One");
    expect(original).not.toContain("Reward credited");
    expect(original).not.toContain("Settled balance");
    expect(original).toContain("Not yet confirmed");
    expect(original).not.toContain("nothing changed");

    const draw = await committedDraw(interactionId);
    const record = await runtime.DB.prepare(
      "SELECT status, error_code, receipt_json FROM fb_discord_interactions WHERE interaction_id = ?",
    )
      .bind(interactionId)
      .first<{ status: string; error_code: string | null; receipt_json: string | null }>();
    expect(record?.status).toBe("completed");
    expect(record?.error_code).toBeNull();
    expect(record?.receipt_json).toContain("Test One");
    expect(record?.receipt_json).toContain('"credits_total":160');
    expect(record?.receipt_json).toContain('"settlement_status":"pending"');

    const redelivery = new DiscordTransport();
    await redeliver(interactionId, redelivery);
    const resent = JSON.stringify(redelivery.original("redeliver-token")!.payload);
    expect(resent).toContain(draw.serial);
    expect(resent).not.toContain("Settled rewards");
    expect(resent).toContain("balance is unconfirmed");
    await committedDraw(interactionId);
    await assertRewardSettledOnce();

    const replay = await replayDraw(interactionId);
    expect(replay.replayed).toBe(true);
    expect(replay.instance_id).toBe(draw.instance_id);
    await committedDraw(interactionId);
    await assertRewardSettledOnce();
  });

  it("retries a receipt update that affects no rows and recovers the same card", async () => {
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await fixturePool(player);
    const errors: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((value) => {
      errors.push(String(value));
    });
    const faults = faultDatabase([
      {
        label: "zero-row receipt update",
        match: (sql) =>
          sql.includes("UPDATE fb_discord_interactions") && sql.includes("receipt_kind"),
        method: "run",
        mode: "zero",
        times: 20,
      },
    ]);
    const transport = new DiscordTransport();
    const interactionId = "recovery-zero-row";
    try {
      await deliverDeferred(
        interaction(command("open", [{ name: "pool", type: 3, value: "test-pool" }]), {
          id: interactionId,
        }),
        faults.db,
        transport,
      );
    } finally {
      errorSpy.mockRestore();
    }

    const draw = await committedDraw(interactionId);
    expect(errors.join("\n")).toContain("receipt update affected no rows");
    expect(errors.join("\n")).toContain('"attempt":1');
    expect(errors.join("\n")).toContain('"attempt":2');
    expect(errors.join("\n")).not.toContain("test-interaction-token");
    const first = JSON.stringify(transport.original("test-interaction-token")!.payload);
    expect(first).toContain("Test One");
    expect(first).toContain(draw.serial);
    const record = await runtime.DB.prepare(
      "SELECT receipt_json FROM fb_discord_interactions WHERE interaction_id = ?",
    )
      .bind(interactionId)
      .first<{ receipt_json: string | null }>();
    expect(record?.receipt_json).toBeNull();

    const redelivery = new DiscordTransport();
    await redeliver(interactionId, redelivery);
    const resent = JSON.stringify(redelivery.original("redeliver-token")!.payload);
    expect(resent).toContain(draw.serial);
    expect(resent).toContain("No second pull");
    await committedDraw(interactionId);
    await assertRewardSettledOnce();
  });

  it("keeps the same committed draw when the render lookup fails", async () => {
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await fixturePool(player);
    await runtime.MEDIA.put("test/render.webp", new Uint8Array([82, 73, 70, 70, 1, 2, 3]));
    const faults = faultDatabase([
      {
        label: "render lookup",
        match: (sql) => sql.includes("FROM fb_variant_renders"),
        method: "first",
        times: 1,
      },
    ]);
    const transport = new DiscordTransport();
    const interactionId = "recovery-render-lookup";
    await deliverDeferred(
      interaction(command("open", [{ name: "pool", type: 3, value: "test-pool" }]), {
        id: interactionId,
      }),
      faults.db,
      transport,
    );
    const draw = await committedDraw(interactionId);
    const firstPayload = transport.original("test-interaction-token")!.payload;
    const first = JSON.stringify(firstPayload);
    expect(first).toContain("Test One");
    expect(first).toContain(draw.serial);
    expect(first).not.toContain("attachment://");
    expect(transport.original("test-interaction-token")!.files).toBe(0);

    const redelivery = new DiscordTransport();
    await redeliver(interactionId, redelivery);
    const resend = redelivery.original("redeliver-token")!;
    const resent = JSON.stringify(resend.payload);
    expect(resent).toContain(draw.serial);
    expect(resent).toContain("recorded result");
    expect(resend.files).toBe(1);
    await committedDraw(interactionId);
    await assertRewardSettledOnce();
  });

  it("marks a lost-receipt delivery failure completed and re-sends the same draw", async () => {
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await fixturePool(player);
    await runtime.MEDIA.put("test/render.webp", new Uint8Array([82, 73, 70, 70, 1, 2, 3]));
    const faults = faultDatabase([
      {
        label: "receipt persistence",
        match: (sql) =>
          sql.includes("UPDATE fb_discord_interactions") && sql.includes("receipt_kind"),
        method: "run",
        times: 20,
      },
    ]);
    const transport = new DiscordTransport();
    transport.failNext({ method: "PATCH", target: "original", status: 503, times: 3 });
    const interactionId = "recovery-delivery-failed";
    await deliverDeferred(
      interaction(command("open", [{ name: "pool", type: 3, value: "test-pool" }]), {
        id: interactionId,
      }),
      faults.db,
      transport,
    );

    const draw = await committedDraw(interactionId);
    const record = await runtime.DB.prepare(
      "SELECT status, error_code, receipt_json FROM fb_discord_interactions WHERE interaction_id = ?",
    )
      .bind(interactionId)
      .first<{ status: string; error_code: string | null; receipt_json: string | null }>();
    expect(record?.status).toBe("completed");
    expect(record?.error_code).toBe("delivery_failed");
    expect(record?.receipt_json).toBeNull();

    const redelivery = new DiscordTransport();
    await redeliver(interactionId, redelivery);
    const resent = JSON.stringify(redelivery.original("redeliver-token")!.payload);
    expect(resent).toContain(draw.serial);
    expect(resent).toContain("No second pull");
    await committedDraw(interactionId);
    await assertRewardSettledOnce();
  });

  it("keeps the original receipt pending when reward credit fails before commit", async () => {
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await fixturePool(player);
    const faults = faultDatabase([{ label: "reward pre-credit wallet", match: (sql) => sql.includes("FROM fb_wallets w JOIN fb_economy_settings"), method: "first", afterDrawCommit: true, times: 1 }]);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const transport = new DiscordTransport();
    const interactionId = "recovery-reward-before-credit";
    try {
      await deliverDeferred(interaction(command("open", [{ name: "pool", type: 3, value: "test-pool" }]), { id: interactionId }), faults.db, transport);
    } finally { errorSpy.mockRestore(); }
    const draw = await committedDraw(interactionId);
    const recovered = await recoverDrawReceipt(runtime.DB, { tenantId: player.tenant.id, userId: draw.user_id, interactionId });
    expect(recovered?.credits_total).toBe(0);
    expect(recovered?.balance_after).toBe(270);
    expect(recovered?.settlement_pending).toBe(true);
    const visible = JSON.stringify(transport.original("test-interaction-token")!.payload);
    expect(visible).not.toContain("Settled balance");
    expect(visible).not.toContain("Reward credited");
    const record = await runtime.DB.prepare("SELECT response_json FROM fb_idempotency_keys WHERE idempotency_key = ?").bind(drawIdempotencyKey(interactionId)).first<{ response_json: string }>();
    expect(JSON.parse(record!.response_json).settlement_status).not.toBe("settled");
  });

  it("does not present a pending achievement as a settled wallet credit", async () => {
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await fixturePool(player);
    const interactionId = "recovery-pending-achievement";
    await send(
      interaction(command("open", [{ name: "pool", type: 3, value: "test-pool" }]), {
        id: interactionId,
      }),
      runtime.DB,
    );
    const draw = await committedDraw(interactionId);
    // Isolated test fixture: reproduce an unlock saved before reward fulfilment.
    await runtime.DB.prepare(
      "UPDATE fb_achievement_unlocks SET reward_state = 'pending', reward_ledger_id = NULL WHERE user_id = ?",
    )
      .bind(draw.user_id)
      .run();
    await runtime.DB.prepare(
      "DELETE FROM fb_ledger_entries WHERE user_id = ? AND reference_type = 'achievement'",
    )
      .bind(draw.user_id)
      .run();
    await runtime.DB.prepare("UPDATE fb_wallets SET balance = 270 WHERE user_id = ?")
      .bind(draw.user_id)
      .run();
    // Keep both stale cached receipts: ledger state must win over them.
    const result = await recoverDrawReceipt(runtime.DB, {
      tenantId: player.tenant.id,
      userId: draw.user_id,
      interactionId,
    });
    expect(result?.credits_total).toBe(0);
    expect(result?.balance_after).toBe(270);
    expect(result?.settlement_pending).toBe(true);
    const unlock = await runtime.DB.prepare(
      "SELECT id FROM fb_achievement_unlocks WHERE user_id = ? LIMIT 1",
    )
      .bind(draw.user_id)
      .first<{ id: string }>();
    await runtime.DB.prepare(
      "INSERT INTO fb_ledger_entries (id, tenant_id, user_id, kind, amount, balance_after, reference_type, reference_id, description, created_at) VALUES ('test-pending-credit', ?, ?, 'issue', 160, 430, 'achievement', ?, 'Test reward', ?)",
    )
      .bind(player.tenant.id, draw.user_id, unlock!.id, new Date().toISOString())
      .run();
    await runtime.DB.prepare(
      "UPDATE fb_achievement_unlocks SET reward_state = 'granted', reward_ledger_id = 'test-pending-credit' WHERE id = ?",
    )
      .bind(unlock!.id)
      .run();
    const settled = await recoverDrawReceipt(runtime.DB, {
      tenantId: player.tenant.id,
      userId: draw.user_id,
      interactionId,
    });
    expect(settled?.credits_total).toBe(160);
    expect(settled?.balance_after).toBe(430);
    expect(settled?.settlement_pending).toBe(false);
    await runtime.DB.prepare("UPDATE fb_idempotency_keys SET response_json = json_remove(response_json, '$.settlement_status') WHERE idempotency_key = ?").bind(drawIdempotencyKey(interactionId)).run();
    const missingCompletion = await recoverDrawReceipt(runtime.DB, { tenantId: player.tenant.id, userId: draw.user_id, interactionId });
    expect(missingCompletion?.settlement_pending).toBe(true);
  });

  it("requires the unlock's exact granted ledger link during recovery", async () => {
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await fixturePool(player);
    const interactionId = "recovery-unlinked-credit";
    await send(interaction(command("open", [{ name: "pool", type: 3, value: "test-pool" }]), { id: interactionId }), runtime.DB);
    const draw = await committedDraw(interactionId);
    await runtime.DB.prepare("UPDATE fb_achievement_unlocks SET reward_ledger_id = NULL WHERE user_id = ?").bind(draw.user_id).run();
    const receipt = await recoverDrawReceipt(runtime.DB, { tenantId: player.tenant.id, userId: draw.user_id, interactionId });
    expect(receipt?.credits_total).toBe(0);
    expect(receipt?.settlement_pending).toBe(true);
  });

  it("does not invent a historical balance when the debit read fails and the wallet changes", async () => {
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await fixturePool(player);
    const interactionId = "recovery-missing-debit-balance";
    await send(interaction(command("open", [{ name: "pool", type: 3, value: "test-pool" }]), { id: interactionId }), runtime.DB);
    const draw = await committedDraw(interactionId);
    await runtime.DB.prepare("UPDATE fb_idempotency_keys SET response_json = json_remove(response_json, '$.balance_after_debit') WHERE idempotency_key = ?")
      .bind(drawIdempotencyKey(interactionId)).run();
    await runtime.DB.prepare("UPDATE fb_wallets SET balance = 999 WHERE tenant_id = ? AND user_id = ?")
      .bind(player.tenant.id, draw.user_id).run();
    const faults = faultDatabase([{ label: "debit unavailable", method: "first", match: (sql) => sql.includes("FROM fb_ledger_entries") && sql.includes("reference_type = 'draw'") }]);
    const receipt = await recoverDrawReceipt(faults.db, { tenantId: player.tenant.id, userId: draw.user_id, interactionId });
    expect(receipt?.balance_after).toBeUndefined();
    expect(receipt?.settlement_pending).toBe(true);
    const message = JSON.stringify(drawRecoveryMessage({ receipt: receipt!, origin: "https://foilbury.test", interactionId, reason: "Display interrupted." }));
    expect(message).toContain("Balance after draw is not yet confirmed");
    expect(message).not.toContain("999");
    expect(message).not.toContain("Balance after draw: **0");
    expect(message).not.toContain('"name":"Balance after draw"');
  });

  it("scopes recovery to the tenant and user that own the draw", async () => {
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await fixturePool(player);
    const interactionId = "recovery-scope";
    await send(
      interaction(command("open", [{ name: "pool", type: 3, value: "test-pool" }]), {
        id: interactionId,
      }),
      runtime.DB,
    );
    const draw = await committedDraw(interactionId);
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const unrelated = await recoverDrawReceipt(runtime.DB, {
      tenantId: owner.tenant.id,
      userId: owner.user!.id,
      interactionId,
    });
    expect(unrelated).toBeNull();
    const own = await recoverDrawReceipt(runtime.DB, {
      tenantId: owner.tenant.id,
      userId: draw.user_id,
      interactionId,
    });
    expect(own?.draw_id).toBe(draw.id);
    expect(own?.serial).toBe(draw.serial);
  });

  it("expires a stale post-commit interaction and still re-sends the same draw", async () => {
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await fixturePool(player);
    const transport = new DiscordTransport();
    const interactionId = "recovery-expired-after-commit";
    await deliverDeferred(
      interaction(command("open", [{ name: "pool", type: 3, value: "test-pool" }]), {
        id: interactionId,
      }),
      runtime.DB,
      transport,
    );
    const draw = await committedDraw(interactionId);
    const old = new Date(Date.now() - 60 * 60_000).toISOString();
    await runtime.DB.prepare(
      "UPDATE fb_discord_interactions SET status = 'processing', error_code = NULL, completed_at = NULL, created_at = ? WHERE interaction_id = ?",
    )
      .bind(old, interactionId)
      .run();
    const changed = await expireStaleDiscordInteractions(runtime.DB, 10);
    expect(changed).toBeGreaterThanOrEqual(1);
    const expired = await runtime.DB.prepare(
      "SELECT status, error_code FROM fb_discord_interactions WHERE interaction_id = ?",
    )
      .bind(interactionId)
      .first<{ status: string; error_code: string | null }>();
    expect(expired?.status).toBe("failed");
    expect(expired?.error_code).toBe("delivery_timeout");

    const redelivery = new DiscordTransport();
    await redeliver(interactionId, redelivery);
    const resent = JSON.stringify(redelivery.original("redeliver-token")!.payload);
    expect(resent).toContain(draw.serial);
    expect(resent).toContain("recorded result");
    await committedDraw(interactionId);
    await assertRewardSettledOnce();

    const replay = await replayDraw(interactionId);
    expect(replay.replayed).toBe(true);
    expect(replay.instance_id).toBe(draw.instance_id);
    await committedDraw(interactionId);
    await assertRewardSettledOnce();
  });
});
