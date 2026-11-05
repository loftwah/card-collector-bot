import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  expireStaleDiscordInteractions,
  handleDiscordInteraction,
} from "../../src/server/discord/handler";
import { drawIdempotencyKey, markDeliveryVisibility, recoverDrawReceipt } from "../../src/server/discord/receipts";
import { signDiscordRequest } from "../../src/server/discord/signature";
import type { DiscordEnv } from "../../src/server/discord/types";
import { sha256Hex } from "../../src/server/ids";
import { executeDraw, getPoolPreview } from "../../src/server/modules/pools";
import { bootstrap, ctxFor, fixturePool, runtime, setBalance } from "./helpers";
import { DiscordTransport } from "./discord-transport";
import { recordInteractionFinish, recordInteractionStart, reconcileTimedOutDraws } from "../../src/server/discord/interactions";

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
    expect(payload).toContain("Your opening completed");
    expect(payload).toContain("Re-send receipt");
    expect(payload).not.toContain(draw.serial);
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
    expect(errors.join("\n")).toContain("achievement reward failed");
    expect(errors.join("\n")).toContain("Injected settlement read-back failure");
    const original = JSON.stringify(transport.original("test-interaction-token")!.payload);
    expect(original).toContain("Test One");
    expect(original).not.toContain("Reward credited");
    expect(original).not.toContain("Settled balance");
    expect(original).toContain("Open your wallet");
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
    expect(record?.receipt_json).toContain('"settlement_status":"settled"');

    const redelivery = new DiscordTransport();
    await redeliver(interactionId, redelivery);
    const resent = JSON.stringify(redelivery.original("redeliver-token")!.payload);
    expect(resent).toContain(draw.serial);
    expect(resent).not.toContain("Settled rewards");
    expect(resent).toContain("Check your wallet");
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

    await runtime.DB.prepare("UPDATE fb_discord_installations SET game_enabled=0 WHERE id='dci_test'").run();
    const retry=new DiscordTransport();
    await deliverDeferred(interaction(command("open",[{name:"pool",type:3,value:"test-pool"}]),{id:interactionId,token:"lost-delivery-retry"}),runtime.DB,retry);
    const afterRetry=await runtime.DB.prepare("SELECT status,error_code,receipt_json FROM fb_discord_interactions WHERE interaction_id=?").bind(interactionId).first<{status:string;error_code:string|null;receipt_json:string|null}>();
    expect(afterRetry).toEqual(record);
    await runtime.DB.prepare("UPDATE fb_discord_installations SET game_enabled=1 WHERE id='dci_test'").run();

    const redelivery = new DiscordTransport();
    await redeliver(interactionId, redelivery);
    const resent = JSON.stringify(redelivery.original("redeliver-token")!.payload);
    expect(resent).toContain(draw.serial);
    expect(resent).toContain("No second pull");
    await committedDraw(interactionId);
    await assertRewardSettledOnce();
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
    await runtime.DB.prepare("UPDATE fb_discord_interaction_attempts SET status='processing',error_code=NULL,delivery_visibility=NULL,finished_at=NULL,started_at=? WHERE attempt_id=(SELECT current_attempt_id FROM fb_discord_interactions WHERE interaction_id=?)").bind(old,interactionId).run();
    const changed = await expireStaleDiscordInteractions(runtime.DB, 10);
    expect(changed).toBeGreaterThanOrEqual(1);
    const expired = await runtime.DB.prepare(
      "SELECT status, error_code FROM fb_discord_interactions WHERE interaction_id = ?",
    )
      .bind(interactionId)
      .first<{ status: string; error_code: string | null }>();
    expect(expired?.status).toBe("completed");
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
  it("keeps deferred reconciliation neutral after commit and immediate access loss", async () => {
    const player=await ctxFor("cabinet","player@foilbury.local");
    await fixturePool(player);
    const tracked=faultDatabase([]);
    let injected=false;
    const db=new Proxy(tracked.db,{get(target,key){
      if(key==='batch') return async (statements:D1PreparedStatement[]) => {
        const result=await target.batch(statements);
        if(tracked.committed() && !injected){
          injected=true;
          await runtime.DB.prepare("UPDATE fb_collections SET status='draft' WHERE id='col_test_public'").run();
          throw new Error('lost commit acknowledgement');
        }
        return result;
      };
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    const transport=new DiscordTransport();
    const interactionId='reconcile-revoked-after-commit';
    await deliverDeferred(interaction(command('open',[{name:'pool',type:3,value:'test-pool'}]),{id:interactionId}),db,transport);
    expect(injected).toBe(true);
    const draw=await committedDraw(interactionId);
    const payload=JSON.stringify(transport.original('test-interaction-token')!.payload);
    expect(payload).not.toContain('Test One');
    expect(payload).not.toContain(draw.serial);
    expect(payload).toMatch(/may have completed/i);
    expect(payload).toContain('Check receipt');
    const status=await runtime.DB.prepare("SELECT status,error_code FROM fb_discord_interactions WHERE interaction_id=?").bind(interactionId).first<{status:string;error_code:string|null}>();
    expect(status).toEqual({status:'completed',error_code:'unknown_commit_outcome'});
    const denied=new DiscordTransport();
    await redeliver(interactionId,denied,'denied-token');
    const deniedPayload=JSON.stringify(denied.original('denied-token')!.payload);
    expect(deniedPayload).not.toContain('Test One');
    expect(deniedPayload).not.toContain(draw.serial);
    await runtime.DB.prepare("UPDATE fb_collections SET status='published' WHERE id='col_test_public'").run();
    const restored=new DiscordTransport();
    await redeliver(interactionId,restored,'restored-token');
    const restoredPayload=JSON.stringify(restored.original('restored-token')!.payload);
    expect(restoredPayload).toContain(draw.serial);
    expect((await runtime.DB.prepare("SELECT COUNT(*) AS n FROM fb_draws WHERE idempotency_key=?").bind(drawIdempotencyKey(interactionId)).first<{n:number}>())!.n).toBe(1);
  });
  it.each([
    ["identity revoked", "UPDATE fb_discord_identities SET revoked_at='2026-01-01' WHERE discord_user_id='707281352818425929'"],
    ["installation disabled", "UPDATE fb_discord_installations SET game_enabled=0 WHERE id='dci_test'"],
    ["collection disabled", "UPDATE fb_bot_collections SET enabled=0 WHERE collection_id='col_test_public'"],
    ["pool emptied", "UPDATE fb_pool_entries SET enabled=0 WHERE id='poe_test'"],
  ])("keeps same-key retry neutral after %s", async (_label,mutation) => {
    const player=await ctxFor("cabinet","player@foilbury.local");
    await fixturePool(player);
    const interactionId=`early-${_label.replaceAll(' ','-')}`;
    const original=interaction(command('open',[{name:'pool',type:3,value:'test-pool'}]),{id:interactionId});
    await deliverDeferred(original,runtime.DB,new DiscordTransport());
    const draw=await committedDraw(interactionId);
    const before=await runtime.DB.prepare("SELECT status,error_code,delivery_visibility FROM fb_discord_interactions WHERE interaction_id=?").bind(interactionId).first<{status:string;error_code:string|null;delivery_visibility:string|null}>();
    expect(before?.status).toBe('completed');
    await runtime.DB.prepare(mutation).run();
    const retry=new DiscordTransport();
    await deliverDeferred({...original,token:'early-retry-token'},runtime.DB,retry);
    const payload=JSON.stringify(retry.original('early-retry-token')!.payload);
    expect(payload).toContain('may have completed');
    expect(payload).toContain('Check receipt');
    expect(payload).not.toMatch(/nothing was charged|nothing was changed/i);
    expect(payload).not.toContain('Test One');
    expect(payload).not.toContain(draw.serial);
    expect((await runtime.DB.prepare("SELECT COUNT(*) AS n FROM fb_draws WHERE idempotency_key=?").bind(drawIdempotencyKey(interactionId)).first<{n:number}>())!.n).toBe(1);
    expect((await runtime.DB.prepare("SELECT COUNT(*) AS n FROM fb_ledger_entries WHERE reference_type='draw' AND reference_id=? AND kind='spend'").bind(draw.id).first<{n:number}>())!.n).toBe(1);
    await markDeliveryVisibility(runtime.DB,interactionId,'public');
    const after=await runtime.DB.prepare("SELECT status,error_code,delivery_visibility FROM fb_discord_interactions WHERE interaction_id=?").bind(interactionId).first<{status:string;error_code:string|null;delivery_visibility:string|null}>();
    expect(after).toEqual(before);
    if (_label==='identity revoked') expect((await runtime.DB.prepare("SELECT COUNT(*) AS n FROM fb_discord_identities WHERE discord_user_id='707281352818425929' AND revoked_at IS NULL").first<{n:number}>())!.n).toBe(0);
  });
  it('records a later same-key success after an earlier empty-pool response',async()=>{
    const player=await ctxFor('cabinet','player@foilbury.local');
    await fixturePool(player);
    await runtime.DB.prepare("UPDATE fb_pool_entries SET enabled=0 WHERE id='poe_test'").run();
    const interactionId='retry-after-empty-pool';
    const original=interaction(command('open',[{name:'pool',type:3,value:'test-pool'}]),{id:interactionId});
    await deliverDeferred(original,runtime.DB,new DiscordTransport());
    const before=await runtime.DB.prepare("SELECT status,error_code FROM fb_discord_interactions WHERE interaction_id=?").bind(interactionId).first<{status:string;error_code:string|null}>();
    expect(before).toEqual({status:'completed',error_code:'empty_pool_uncertain'});
    await runtime.DB.prepare("UPDATE fb_pool_entries SET enabled=1 WHERE id='poe_test'").run();
    await deliverDeferred({...original,token:'retry-success-token'},runtime.DB,new DiscordTransport());
    const draw=await committedDraw(interactionId);
    const after=await runtime.DB.prepare("SELECT status,error_code FROM fb_discord_interactions WHERE interaction_id=?").bind(interactionId).first<{status:string;error_code:string|null}>();
    expect(after).toEqual({status:'completed',error_code:null});
    expect((await runtime.DB.prepare("SELECT COUNT(*) AS n FROM fb_ledger_entries WHERE reference_type='draw' AND reference_id=? AND kind='spend'").bind(draw.id).first<{n:number}>())!.n).toBe(1);
  });
  it('does not let an overlapping old attempt own the new committed outcome',async()=>{
    const player=await ctxFor('cabinet','player@foilbury.local');
    await fixturePool(player);
    await runtime.DB.prepare("UPDATE fb_pool_entries SET enabled=0 WHERE id='poe_test'").run();
    const interactionId='overlapping-attempt-finish';
    const original=interaction(command('open',[{name:'pool',type:3,value:'test-pool'}]),{id:interactionId});
    await deliverDeferred(original,runtime.DB,new DiscordTransport());
    const oldAttempt=await recordInteractionStart(envFor(runtime.DB),original as never);
    expect(oldAttempt).toBeTruthy();
    await runtime.DB.prepare("UPDATE fb_pool_entries SET enabled=1 WHERE id='poe_test'").run();
    const tracked=faultDatabase([]);
    let injected=false;
    const db=new Proxy(tracked.db,{get(target,key){
      if(key==='batch')return async(statements:D1PreparedStatement[])=>{
        const result=await target.batch(statements);
        if(tracked.committed()&&!injected){
          injected=true;
          await recordInteractionFinish(envFor(runtime.DB),interactionId,'completed','empty_pool_uncertain',oldAttempt,'public');
        }
        return result;
      };
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    await deliverDeferred({...original,token:'overlap-token'},db,new DiscordTransport());
    expect(injected).toBe(true);
    await committedDraw(interactionId);
    const state=await runtime.DB.prepare('SELECT status,error_code FROM fb_discord_interactions WHERE interaction_id=?').bind(interactionId).first<{status:string;error_code:string|null}>();
    expect(state).toEqual({status:'completed',error_code:null});
  });
  it('keeps an expired attempt immutable and reconciles a draw that commits late',async()=>{
    const player=await ctxFor('cabinet','player@foilbury.local');await fixturePool(player);
    const interactionId='late-commit-after-expiry';
    const statements=new WeakMap<object,{raw:D1PreparedStatement;sql:string}>();
    const db=new Proxy(runtime.DB,{get(target,key){
      if(key==='prepare')return(sql:string)=>{
        const wrap=(raw:D1PreparedStatement):D1PreparedStatement=>{
          const proxy=new Proxy(raw,{get(statement,method){
            if(method==='bind')return(...args:unknown[])=>wrap(statement.bind(...args));
            const value=Reflect.get(statement,method,statement);return typeof value==='function'?value.bind(statement):value;
          }});
          statements.set(proxy,{raw,sql});return proxy;
        };
        return wrap(target.prepare(sql));
      };
      if(key==='batch')return async(items:D1PreparedStatement[])=>{
        const containsDraw=items.some(item=>statements.get(item)?.sql.includes('INSERT INTO fb_draws'));
        if(containsDraw){
          const old=new Date(Date.now()-60*60_000).toISOString();
          await runtime.DB.prepare("UPDATE fb_discord_interaction_attempts SET started_at=? WHERE interaction_id=? AND status='processing'").bind(old,interactionId).run();
          expect(await expireStaleDiscordInteractions(runtime.DB,10)).toBeGreaterThan(0);
        }
        return target.batch(items.map(item=>statements.get(item)?.raw??item));
      };
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    await deliverDeferred(interaction(command('open',[{name:'pool',type:3,value:'test-pool'}]),{id:interactionId}),db,new DiscordTransport());
    await committedDraw(interactionId);
    const attempt=await runtime.DB.prepare('SELECT status,error_code FROM fb_discord_interaction_attempts WHERE interaction_id=?').bind(interactionId).first<{status:string;error_code:string|null}>();
    expect(attempt).toEqual({status:'expired',error_code:'delivery_timeout'});
    const parent=await runtime.DB.prepare('SELECT status,error_code FROM fb_discord_interactions WHERE interaction_id=?').bind(interactionId).first<{status:string;error_code:string|null}>();
    expect(parent).toEqual({status:'completed',error_code:'late_commit_reconciled'});
  });
  it('does not let a different actor own or rewrite an interaction projection',async()=>{
    const player=await ctxFor('cabinet','player@foilbury.local');await fixturePool(player);
    const interactionId='attempt-other-actor';
    const original=interaction(command('open',[{name:'pool',type:3,value:'test-pool'}]),{id:interactionId});
    await deliverDeferred(original,runtime.DB,new DiscordTransport());await committedDraw(interactionId);
    const before=await runtime.DB.prepare('SELECT status,error_code,delivery_visibility,current_attempt_id FROM fb_discord_interactions WHERE interaction_id=?').bind(interactionId).first();
    const other={...original,member:{...original.member,user:{id:'111111111111111111',username:'other',global_name:'Other'}}};
    const otherAttempt=await recordInteractionStart(envFor(runtime.DB),other as never);
    expect(otherAttempt).toBeTruthy();
    await recordInteractionFinish(envFor(runtime.DB),interactionId,'failed','other-actor',otherAttempt,'public');
    const after=await runtime.DB.prepare('SELECT status,error_code,delivery_visibility,current_attempt_id FROM fb_discord_interactions WHERE interaction_id=?').bind(interactionId).first();
    expect(after).toEqual(before);
  });
  it('expires only the old attempt while a newer execution owns the projection',async()=>{
    const original=interaction(command('open',[{name:'pool',type:3,value:'test-pool'}]),{id:'expired-old-attempt'});
    const first=await recordInteractionStart(envFor(runtime.DB),original as never);
    const second=await recordInteractionStart(envFor(runtime.DB),original as never);
    expect(first).toBeTruthy();expect(second).toBeTruthy();expect(first).not.toBe(second);
    const old=new Date(Date.now()-60*60_000).toISOString();
    await runtime.DB.prepare("UPDATE fb_discord_interaction_attempts SET started_at=? WHERE attempt_id=?").bind(old,first).run();
    await expireStaleDiscordInteractions(runtime.DB,10);
    const during=await runtime.DB.prepare("SELECT status,current_attempt_id FROM fb_discord_interactions WHERE interaction_id=?").bind(original.id).first();
    expect(during).toEqual({status:'processing',current_attempt_id:second});
    await recordInteractionFinish(envFor(runtime.DB),original.id,'completed',undefined,second,'private');
    await recordInteractionFinish(envFor(runtime.DB),original.id,'failed','stale-finish',first,'public');
    const parent=await runtime.DB.prepare("SELECT status,error_code,delivery_visibility FROM fb_discord_interactions WHERE interaction_id=?").bind(original.id).first();
    expect(parent).toEqual({status:'completed',error_code:null,delivery_visibility:'private'});
    const expired=await runtime.DB.prepare("SELECT status,error_code,delivery_visibility FROM fb_discord_interaction_attempts WHERE attempt_id=?").bind(first).first();
    expect(expired).toEqual({status:'expired',error_code:'delivery_timeout',delivery_visibility:null});
  });
  it.each([['current',false],['revoked',true]])('reconciles a lost terminal acknowledgement with %s identity',async(_label,revoke)=>{
    const player=await ctxFor('cabinet','player@foilbury.local');await fixturePool(player);
    await send(interaction(command('profile'),{id:'terminal-profile'}));
    const discord=await discordPlayer();await setBalance(discord,discord.user!.id,0);
    const statements=new WeakMap<object,{raw:D1PreparedStatement;sql:string}>();
    let injected=false;
    const db=new Proxy(runtime.DB,{get(target,key){
      if(key==='prepare')return(sql:string)=>{
        const wrap=(raw:D1PreparedStatement):D1PreparedStatement=>{
          const proxy=new Proxy(raw,{get(statement,method){
            if(method==='bind')return(...args:unknown[])=>wrap(statement.bind(...args));
            const value=Reflect.get(statement,method,statement);return typeof value==='function'?value.bind(statement):value;
          }});statements.set(proxy,{raw,sql});return proxy;
        };return wrap(target.prepare(sql));
      };
      if(key==='batch')return async(items:D1PreparedStatement[])=>{
        const terminal=items.some(item=>statements.get(item)?.sql.includes('INSERT OR IGNORE INTO fb_idempotency_keys'));
        const result=await target.batch(items.map(item=>statements.get(item)?.raw??item));
        if(terminal&&!injected){injected=true;if(revoke)await runtime.DB.prepare("UPDATE fb_discord_identities SET revoked_at='2026-01-01' WHERE discord_user_id=?").bind(DISCORD_USER_ID).run();throw new Error('lost terminal acknowledgement');}
        return result;
      };
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    const transport=new DiscordTransport(),interactionId='terminal-ack-lost';
    await deliverDeferred(interaction(command('open',[{name:'pool',type:3,value:'test-pool'}]),{id:interactionId}),db,transport);
    expect(injected).toBe(true);
    const payload=JSON.stringify(transport.original('test-interaction-token')!.payload);
    if(revoke){expect(payload).toContain('may have completed');expect(payload).not.toContain('Not enough Foil');}
    else {expect(payload).toContain('Not enough Foil');expect(payload).toContain('/foilbury daily');}
    const marker=await runtime.DB.prepare("SELECT status FROM fb_idempotency_keys WHERE idempotency_key=?").bind(drawIdempotencyKey(interactionId)).first<{status:string}>();
    expect(marker?.status).toBe('failed');
    expect((await runtime.DB.prepare('SELECT COUNT(*) AS n FROM fb_draws WHERE idempotency_key=?').bind(drawIdempotencyKey(interactionId)).first<{n:number}>())!.n).toBe(0);
  });
  it('recovers the same draw when attempt logging fails before the opening',async()=>{
    const player=await ctxFor('cabinet','player@foilbury.local');await fixturePool(player);
    const statements=new WeakMap<object,{raw:D1PreparedStatement;sql:string}>();let injected=false;
    const db=new Proxy(runtime.DB,{get(target,key){
      if(key==='prepare')return(sql:string)=>{
        const wrap=(raw:D1PreparedStatement):D1PreparedStatement=>{
          const proxy=new Proxy(raw,{get(statement,method){
            if(method==='bind')return(...args:unknown[])=>wrap(statement.bind(...args));
            const value=Reflect.get(statement,method,statement);return typeof value==='function'?value.bind(statement):value;
          }});statements.set(proxy,{raw,sql});return proxy;
        };return wrap(target.prepare(sql));
      };
      if(key==='batch')return async(items:D1PreparedStatement[])=>{
        if(!injected&&items.some(item=>statements.get(item)?.sql.includes('INSERT INTO fb_discord_interaction_attempts'))){injected=true;throw new Error('attempt logging unavailable');}
        return target.batch(items.map(item=>statements.get(item)?.raw??item));
      };
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    const interactionId='attempt-log-unavailable',transport=new DiscordTransport();
    await deliverDeferred(interaction(command('open',[{name:'pool',type:3,value:'test-pool'}]),{id:interactionId}),db,transport);
    expect(injected).toBe(true);
    const draw=await committedDraw(interactionId);
    const missing=await runtime.DB.prepare('SELECT interaction_id FROM fb_discord_interactions WHERE interaction_id=?').bind(interactionId).first();
    expect(missing).toBeNull();
    const recovery=new DiscordTransport();await redeliver(interactionId,recovery,'attempt-log-recovery');
    expect(JSON.stringify(recovery.original('attempt-log-recovery')!.payload)).toContain(draw.serial);
    expect((await runtime.DB.prepare("SELECT COUNT(*) AS n FROM fb_ledger_entries WHERE reference_type='draw' AND reference_id=? AND kind='spend'").bind(draw.id).first<{n:number}>())!.n).toBe(1);
  });
  it('scheduled maintenance reconciles an expired draw after the finishing Worker disappears',async()=>{
    const player=await ctxFor('cabinet','player@foilbury.local');await fixturePool(player);
    const interactionId='late-commit-worker-gone',statements=new WeakMap<object,{raw:D1PreparedStatement;sql:string}>();let committed=false;
    const db=new Proxy(runtime.DB,{get(target,key){
      if(key==='prepare')return(sql:string)=>{
        const wrap=(raw:D1PreparedStatement):D1PreparedStatement=>{
          const proxy=new Proxy(raw,{get(statement,method){
            if(method==='bind')return(...args:unknown[])=>wrap(statement.bind(...args));
            const value=Reflect.get(statement,method,statement);return typeof value==='function'?value.bind(statement):value;
          }});statements.set(proxy,{raw,sql});return proxy;
        };return wrap(target.prepare(sql));
      };
      if(key==='batch')return async(items:D1PreparedStatement[])=>{
        const containsDraw=items.some(item=>statements.get(item)?.sql.includes('INSERT INTO fb_draws'));
        const isFinish=items.some(item=>statements.get(item)?.sql.includes('UPDATE fb_discord_interaction_attempts SET status='));
        if(containsDraw){
          const old=new Date(Date.now()-60*60_000).toISOString();
          await runtime.DB.prepare("UPDATE fb_discord_interaction_attempts SET started_at=? WHERE interaction_id=? AND status='processing'").bind(old,interactionId).run();
          await expireStaleDiscordInteractions(runtime.DB,10);
        }
        if(committed&&isFinish)throw new Error('finishing Worker disappeared');
        const result=await target.batch(items.map(item=>statements.get(item)?.raw??item));
        if(containsDraw)committed=true;
        return result;
      };
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    await deliverDeferred(interaction(command('open',[{name:'pool',type:3,value:'test-pool'}]),{id:interactionId}),db,new DiscordTransport());
    await committedDraw(interactionId);
    const before=await runtime.DB.prepare('SELECT status,error_code FROM fb_discord_interactions WHERE interaction_id=?').bind(interactionId).first();
    expect(before).toEqual({status:'failed',error_code:'delivery_timeout'});
    // A prefix of unmatched timeouts must not starve a later real draw.
    await runtime.DB.prepare(`INSERT INTO fb_discord_interactions
      (interaction_id,application_id,guild_id,channel_id,discord_user_id,command_name,status,error_code,created_at,completed_at)
      SELECT 'unmatched-'||j.value,x.application_id,x.guild_id,x.channel_id,x.discord_user_id,'fixture','failed','delivery_timeout','2000-01-01T00:00:00.000Z','2000-01-01T00:00:00.000Z'
        FROM fb_discord_interactions x,json_each(?) j WHERE x.interaction_id=?`).bind(JSON.stringify(Array.from({length:60},(_,i)=>i)),interactionId).run();
    expect(await expireStaleDiscordInteractions(runtime.DB,10)).toBe(0);
    expect(await expireStaleDiscordInteractions(runtime.DB,10)).toBeGreaterThan(0);
    const after=await runtime.DB.prepare('SELECT status,error_code FROM fb_discord_interactions WHERE interaction_id=?').bind(interactionId).first();
    expect(after).toEqual({status:'completed',error_code:'late_commit_reconciled'});
    const again=await expireStaleDiscordInteractions(runtime.DB,10);expect(again).toBe(0);
  });
  it('does not regress the timeout cursor when maintenance calls overlap',async()=>{
    await runtime.DB.prepare(`INSERT INTO fb_discord_interactions
      (interaction_id,application_id,guild_id,channel_id,discord_user_id,command_name,status,error_code,created_at,completed_at)
      SELECT 'cursor-'||value,?,?,?,?,'fixture','failed','delivery_timeout','2000-01-01T00:00:00.000Z','2000-01-01T00:00:00.000Z' FROM json_each(?)`)
      .bind(APPLICATION_ID,GUILD_ID,CHANNEL_ID,DISCORD_USER_ID,JSON.stringify(Array.from({length:60},(_,i)=>i))).run();
    let injected=false,winningCursor:unknown=null;
    const db=new Proxy(runtime.DB,{get(target,key){
      if(key==='batch')return async(items:D1PreparedStatement[])=>{
        if(!injected){injected=true;await reconcileTimedOutDraws(runtime.DB);winningCursor=await runtime.DB.prepare('SELECT completed_at,interaction_id FROM fb_discord_timeout_reconcile_cursor WHERE id=1').first();}
        return target.batch(items);
      };
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    expect(await reconcileTimedOutDraws(db)).toBe(0);
    expect(injected).toBe(true);
    expect(await runtime.DB.prepare('SELECT completed_at,interaction_id FROM fb_discord_timeout_reconcile_cursor WHERE id=1').first()).toEqual(winningCursor);
    await reconcileTimedOutDraws(runtime.DB);
    expect(await runtime.DB.prepare('SELECT completed_at,interaction_id FROM fb_discord_timeout_reconcile_cursor WHERE id=1').first()).not.toEqual(winningCursor);
  });
  it('finishes a fixed timeout cycle even when a newer tail keeps arriving',async()=>{
    const insert=async(prefix:string,at:string)=>runtime.DB.prepare(`INSERT INTO fb_discord_interactions
      (interaction_id,application_id,guild_id,channel_id,discord_user_id,command_name,status,error_code,created_at,completed_at)
      SELECT ?||value,?,?,?,?,'fixture','failed','delivery_timeout',?,? FROM json_each(?)`)
      .bind(prefix,APPLICATION_ID,GUILD_ID,CHANNEL_ID,DISCORD_USER_ID,at,at,JSON.stringify(Array.from({length:60},(_,i)=>i))).run();
    await insert('old-','2000-01-01T00:00:00.000Z');
    await reconcileTimedOutDraws(runtime.DB);
    const first=await runtime.DB.prepare('SELECT * FROM fb_discord_timeout_reconcile_cursor WHERE id=1').first<{high_completed_at:string}>();
    expect(first?.high_completed_at).toBe('2000-01-01T00:00:00.000Z');
    await insert('new-','2001-01-01T00:00:00.000Z');
    await reconcileTimedOutDraws(runtime.DB);
    const wrapped=await runtime.DB.prepare('SELECT * FROM fb_discord_timeout_reconcile_cursor WHERE id=1').first<{completed_at:string;high_completed_at:string}>();
    expect(wrapped?.completed_at).toBe('');expect(wrapped?.high_completed_at).toBe('');
    await reconcileTimedOutDraws(runtime.DB);
    const next=await runtime.DB.prepare('SELECT * FROM fb_discord_timeout_reconcile_cursor WHERE id=1').first<{high_completed_at:string}>();
    expect(next?.high_completed_at).toBe('2001-01-01T00:00:00.000Z');
  });
  it('rejects a stale cursor even after another pass completes a full cycle',async()=>{
    await runtime.DB.prepare(`INSERT INTO fb_discord_interactions
      (interaction_id,application_id,guild_id,channel_id,discord_user_id,command_name,status,error_code,created_at,completed_at)
      SELECT 'aba-'||value,?,?,?,?,'fixture','failed','delivery_timeout','2000-01-01T00:00:00.000Z','2000-01-01T00:00:00.000Z' FROM json_each(?)`)
      .bind(APPLICATION_ID,GUILD_ID,CHANNEL_ID,DISCORD_USER_ID,JSON.stringify(Array.from({length:60},(_,i)=>i))).run();
    let injected=false;
    const db=new Proxy(runtime.DB,{get(target,key){
      if(key==='batch')return async(items:D1PreparedStatement[])=>{
        if(!injected){injected=true;await reconcileTimedOutDraws(runtime.DB);await reconcileTimedOutDraws(runtime.DB);}
        return target.batch(items);
      };
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    expect(await reconcileTimedOutDraws(db)).toBe(0);
    const cursor=await runtime.DB.prepare('SELECT completed_at,interaction_id,generation FROM fb_discord_timeout_reconcile_cursor WHERE id=1').first<{completed_at:string;interaction_id:string;generation:number}>();
    expect(cursor).toEqual({completed_at:'',interaction_id:'',generation:2});
  });
  it('uses the intended timeout-page and draw-identity indexes',async()=>{
    const page=await runtime.DB.prepare(`EXPLAIN QUERY PLAN SELECT interaction_id,completed_at FROM fb_discord_interactions
      WHERE status='failed' AND error_code='delivery_timeout' AND completed_at IS NOT NULL
        AND (completed_at>? OR (completed_at=? AND interaction_id>?)) AND (completed_at<? OR (completed_at=? AND interaction_id<=?)) ORDER BY completed_at,interaction_id LIMIT 50`)
      .bind('','','','z','z','z').all<{detail:string}>();
    const pagePlan=(page.results??[]).map(row=>row.detail).join('\n');
    expect(pagePlan).toContain('fb_discord_timeout_reconcile_idx');
    expect(pagePlan).not.toContain('USE TEMP B-TREE');
    const lookup=await runtime.DB.prepare(`EXPLAIN QUERY PLAN SELECT x.interaction_id FROM fb_discord_interactions x WHERE x.interaction_id=?
      AND EXISTS (SELECT 1 FROM fb_discord_installations i
        JOIN fb_discord_identities di ON di.tenant_id=i.tenant_id AND di.discord_user_id=x.discord_user_id
        JOIN fb_draws d ON d.tenant_id=i.tenant_id AND d.user_id=di.user_id AND d.idempotency_key='discord:' || x.interaction_id || ':open'
        WHERE i.application_id=x.application_id AND i.guild_id=x.guild_id)`).bind('fixture').all<{detail:string}>();
    expect((lookup.results??[]).map(row=>row.detail).join('\n')).toMatch(/SEARCH d USING (?:COVERING )?INDEX .*tenant_id=\? AND user_id=\? AND idempotency_key=\?/);
    const attempts=await runtime.DB.prepare(`EXPLAIN QUERY PLAN SELECT attempt_id FROM fb_discord_interaction_attempts
      WHERE status='processing' AND started_at<? ORDER BY started_at,attempt_id LIMIT 50`).bind('2100-01-01').all<{detail:string}>();
    const attemptPlan=(attempts.results??[]).map(row=>row.detail).join('\n');
    expect(attemptPlan).toContain('fb_discord_attempts_expiry_idx');expect(attemptPlan).not.toContain('USE TEMP B-TREE');
    const legacy=await runtime.DB.prepare(`EXPLAIN QUERY PLAN SELECT interaction_id FROM fb_discord_interactions
      WHERE status='processing' AND current_attempt_id IS NULL AND created_at<? ORDER BY created_at,interaction_id LIMIT 50`).bind('2100-01-01').all<{detail:string}>();
    const legacyPlan=(legacy.results??[]).map(row=>row.detail).join('\n');
    expect(legacyPlan).toContain('fb_discord_processing_attempt_idx');expect(legacyPlan).not.toContain('USE TEMP B-TREE');
    const byBatch=await runtime.DB.prepare(`EXPLAIN QUERY PLAN SELECT attempt_id FROM fb_discord_interaction_attempts
      WHERE status='expired' AND expiry_batch_id=?`).bind('fixture').all<{detail:string}>();
    expect((byBatch.results??[]).map(row=>row.detail).join('\n')).toContain('fb_discord_attempts_expiry_batch_idx');
    const parentUpdate=await runtime.DB.prepare(`EXPLAIN QUERY PLAN UPDATE fb_discord_interactions SET status='failed'
      WHERE status='processing' AND current_attempt_id IN (SELECT attempt_id FROM fb_discord_interaction_attempts WHERE status='expired' AND expiry_batch_id=?)`)
      .bind('fixture').all<{detail:string}>();
    const parentPlan=(parentUpdate.results??[]).map(row=>row.detail).join('\n');
    expect(parentPlan).toContain('fb_discord_processing_attempt_idx');
    expect(parentPlan).toContain('fb_discord_attempts_expiry_batch_idx');
    expect(parentPlan).not.toContain('USE TEMP B-TREE');
  });
});
