import { expireStaleDiscordInteractions } from "./discord/handler";
import { runScheduledNpcProgression } from "./modules/npcs";
import { pruneMagicLinks, pruneRateLimits } from "./modules/magic-links";
import { readConfig } from "./config";
import { buildAdminAlert, deliverAdminAlert } from "./observability/alert";

function failureClass(error: unknown): "timeout" | "operation_failed" {
  return error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")
    ? "timeout" : "operation_failed";
}

/**
 * Scheduled work is isolated per step. One failed maintenance task must not
 * prevent the remaining bounded work or the EmDash editorial/publication
 * handler from running. The returned receipt is written to the Worker log so a
 * real scheduled run can be correlated without claiming success from a unit
 * call.
 */
export interface ScheduledMaintenanceStep {
  name: string;
  run: (env: ScheduledEnv, correlationId?: string) => Promise<unknown>;
}

function newCorrelationId() { return `scheduled:run:${crypto.randomUUID()}`; }

export interface ScheduledEnv {
  DB: D1Database;
  MEDIA: R2Bucket;
  [key: string]: unknown;
}

export const SCHEDULED_MAINTENANCE_STEPS: ScheduledMaintenanceStep[] = [
  { name: "rate_limits", run: (env) => pruneRateLimits(env.DB) },
  { name: "magic_links", run: (env) => pruneMagicLinks(env.DB) },
  { name: "stale_interactions", run: (env) => expireStaleDiscordInteractions(env.DB) },
  {
    name: "npc_progression",
    run: async (env, correlationId) => {
      const result = await runScheduledNpcProgression(env.DB, env.MEDIA, readConfig(env as never), { correlationId });
      if (result.failed) throw new Error("npc_tenant_failure");
      return result.ran;
    },
  },
];

async function defaultAlert(
  env: ScheduledEnv,
  result: Awaited<ReturnType<typeof runScheduledMaintenance>>,
  correlationId: string,
): Promise<void> {
  const failed = result.steps.filter((step) => !step.ok);
  const delivery = await deliverAdminAlert(
    env as { ADMIN_DISCORD_WEBHOOK_URL?: string; DISCORD_WEBHOOK_URL?: string },
    buildAdminAlert({
      level: "error",
      message: `Scheduled maintenance failed: ${failed.map((step) => step.name).join(", ") || "unknown step"}`,
      correlationId,
      detail: failed.map((step) => `${step.name}: ${step.detail ?? "failed"}`).join(" | "),
    }),
  );
  if (!delivery.delivered) {
    console.error(JSON.stringify({
      level: "error",
      event_code: "scheduled.alert.undelivered",
      correlation_id: correlationId,
      occurred_at: new Date().toISOString(),
      configured: delivery.configured,
      status: delivery.status,
      attempts: delivery.attempts,
      error: delivery.error ?? (delivery.configured ? "delivery_failed" : "not_configured"),
    }));
  }
}

export async function runScheduledMaintenance(
  env: ScheduledEnv,
  steps: ScheduledMaintenanceStep[] = SCHEDULED_MAINTENANCE_STEPS,
  correlationId = newCorrelationId(),
): Promise<{
  ok: boolean;
  steps: Array<{ name: string; ok: boolean; detail?: string }>;
}> {
  const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
  for (const step of steps) {
    try {
      const value = await step.run(env, correlationId);
      results.push({
        name: step.name,
        ok: true,
        ...(typeof value === "number" ? { detail: String(value) } : {}),
      });
    } catch (error) {
      results.push({ name: step.name, ok: false, detail: failureClass(error) });
      // Keep the failure visible but continue the bounded maintenance set.
    }
  }
  const ok = results.every((step) => step.ok);
  console.log(
    JSON.stringify({
      level: ok ? "info" : "error",
      message: "scheduled maintenance",
      event_code: "scheduled.maintenance.completed",
      correlation_id: correlationId,
      occurred_at: new Date().toISOString(),
      ok,
      steps: results,
    }),
  );
  return { ok, steps: results };
}

export interface ScheduledRunnerOptions {
  maintenance?: typeof runScheduledMaintenance;
  editorial?: (
    controller: ScheduledController,
    env: unknown,
    ctx: ExecutionContext,
  ) => Promise<unknown> | unknown;
  alert?: (
    env: ScheduledEnv,
    result: Awaited<ReturnType<typeof runScheduledMaintenance>>,
    correlationId: string,
  ) => Promise<unknown>;
}

export function createScheduledRunner(options: ScheduledRunnerOptions = {}) {
  const maintenance = options.maintenance ?? runScheduledMaintenance;
  const alert = options.alert ?? defaultAlert;
  return async (
    controller: ScheduledController,
    env: unknown,
    ctx: ExecutionContext,
  ): Promise<{ maintenance: Awaited<ReturnType<typeof runScheduledMaintenance>>; editorial: { ok: boolean; detail?: string } }> => {
    const correlationId = newCorrelationId();
    let maintenanceResult: Awaited<ReturnType<typeof runScheduledMaintenance>>;
    try {
      maintenanceResult = await maintenance(env as ScheduledEnv, undefined, correlationId);
    } catch (error) {
      console.error(JSON.stringify({
        level: "error",
        event_code: "scheduled.maintenance.failed",
        correlation_id: correlationId,
        occurred_at: new Date().toISOString(),
        error: failureClass(error),
      }));
      maintenanceResult = {
        ok: false,
        steps: [
          {
            name: "maintenance_runner",
            ok: false,
            detail: failureClass(error),
          },
        ],
      };
    }
    if (!maintenanceResult.ok) {
      try {
        await alert(env as ScheduledEnv, maintenanceResult, correlationId);
      } catch (error) {
        console.error(
          JSON.stringify({
            level: "error",
            message: "scheduled alert delivery failed",
            event_code: "scheduled.alert.failed",
            correlation_id: correlationId,
            occurred_at: new Date().toISOString(),
            error: failureClass(error),
          }),
        );
      }
    }
    let editorial: { ok: boolean; detail?: string } = { ok: true };
    if (options.editorial) {
      try {
        await options.editorial(controller, env, ctx);
      } catch (error) {
        editorial = {
          ok: false,
          detail: failureClass(error),
        };
        console.error(
          JSON.stringify({
            level: "error",
            message: "scheduled editorial handler failed",
            event_code: "scheduled.editorial.failed",
            correlation_id: correlationId,
            occurred_at: new Date().toISOString(),
            error: editorial.detail,
          }),
        );
      }
    }
    return { maintenance: maintenanceResult, editorial };
  };
}
