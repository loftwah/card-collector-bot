import { beforeEach, describe, expect, it } from "vitest";
import {
  createScheduledRunner,
  runScheduledMaintenance,
  SCHEDULED_MAINTENANCE_STEPS,
  type ScheduledEnv,
} from "../../src/server/scheduled";
import { buildAdminAlert, deliverAdminAlert } from "../../src/server/observability/alert";
import { bootstrap, runtime } from "./helpers";

const APP = "1566702936615026769";

describe("scheduled Worker entry", () => {
  beforeEach(async () => {
    await bootstrap();
  });

  it("runs maintenance, stale interaction expiry and NPC work with a bounded receipt", async () => {
    const stale = new Date(Date.now() - 60 * 60_000).toISOString();
    await runtime.DB.prepare(
      `INSERT INTO fb_discord_interactions
        (interaction_id, application_id, guild_id, channel_id, discord_user_id, command_name, status, created_at)
       VALUES ('scheduled-stale', ?, '997734945206313041', '1566700752385081355', '707281352818425929', 'foilbury', 'processing', ?)`,
    )
      .bind(APP, stale)
      .run();

    const result = await runScheduledMaintenance(runtime as unknown as ScheduledEnv);
    expect(result.steps.map((step) => step.name)).toEqual([
      "rate_limits",
      "magic_links",
      "stale_interactions",
      "npc_progression",
    ]);
    expect(result.ok).toBe(true);
    const row = await runtime.DB.prepare(
      "SELECT status, error_code FROM fb_discord_interactions WHERE interaction_id = 'scheduled-stale'",
    ).first<{ status: string; error_code: string }>();
    expect(row?.status).toBe("failed");
    expect(row?.error_code).toBe("delivery_timeout");
  });

  it("isolates a failing maintenance step and still runs the remaining steps", async () => {
    const ran: string[] = [];
    const result = await runScheduledMaintenance(runtime as unknown as ScheduledEnv, [
      {
        name: "explodes",
        run: async () => {
          ran.push("explodes");
          throw new Error("synthetic maintenance failure");
        },
      },
      {
        name: "continues",
        run: async () => {
          ran.push("continues");
          return 1;
        },
      },
    ]);
    expect(ran).toEqual(["explodes", "continues"]);
    expect(result.ok).toBe(false);
    expect(result.steps.find((step) => step.name === "explodes")?.ok).toBe(false);
    expect(result.steps.find((step) => step.name === "continues")?.ok).toBe(true);
  });

  it("runs the editorial handler even when maintenance cannot start", async () => {
    let editorialRan = false;
    const runner = createScheduledRunner({
      maintenance: async () => {
        throw new Error("database unavailable");
      },
      editorial: async () => {
        editorialRan = true;
      },
    });
    const result = await runner(
      {} as ScheduledController,
      runtime as unknown as ScheduledEnv,
      { waitUntil: () => undefined } as unknown as ExecutionContext,
    );
    expect(editorialRan).toBe(true);
    expect(result.maintenance.ok).toBe(false);
    expect(result.editorial.ok).toBe(true);
  });

  it("declares only bounded maintenance steps", () => {
    expect(SCHEDULED_MAINTENANCE_STEPS.length).toBeLessThanOrEqual(8);
    expect(new Set(SCHEDULED_MAINTENANCE_STEPS.map((step) => step.name)).size).toBe(
      SCHEDULED_MAINTENANCE_STEPS.length,
    );
  });

  it("raises a bounded, mention-free alert when maintenance fails", async () => {
    const alerts: unknown[] = [];
    const runner = createScheduledRunner({
      maintenance: async () => ({
        ok: false,
        steps: [{ name: "stale_interactions", ok: false, detail: "database unavailable" }],
      }),
      alert: async (_env, result) => {
        alerts.push(result);
      },
      editorial: async () => undefined,
    });
    await runner(
      {} as ScheduledController,
      { ...runtime, ADMIN_DISCORD_WEBHOOK_URL: "https://example.test/webhook" } as unknown as ScheduledEnv,
      { waitUntil: () => undefined } as unknown as ExecutionContext,
    );
    expect(alerts).toHaveLength(1);
  });

  it("delivers one stub alert without mentions and without retry ambiguity", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const stub = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const payload = buildAdminAlert({
      level: "error",
      message: "delivery failed",
      correlationId: "discord:123",
      detail: "token abc.def should not leak",
      occurredAt: "2026-11-04T00:00:00.000Z",
      secrets: ["abc.def"],
    });
    const result = await deliverAdminAlert(
      { ADMIN_DISCORD_WEBHOOK_URL: "https://example.test/webhook" },
      payload,
      { fetchImpl: stub, timeoutMs: 1000 },
    );
    expect(result).toMatchObject({ configured: true, delivered: true, attempts: 1, status: 204 });
    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.content).not.toContain("abc.def");
    expect(body.content).toContain("discord:123");
  });

  it("reports an unconfigured alert destination without making a request", async () => {
    const stub = (async () => {
      throw new Error("must not be called");
    }) as typeof fetch;
    const result = await deliverAdminAlert({}, buildAdminAlert({ level: "warning", message: "x" }), {
      fetchImpl: stub,
    });
    expect(result).toMatchObject({ configured: false, delivered: false, attempts: 0 });
  });
});
