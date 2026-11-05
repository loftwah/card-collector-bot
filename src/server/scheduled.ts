import { expireStaleDiscordInteractions } from "./discord/handler";
import { runScheduledNpcProgression } from "./modules/npcs";
import { pruneMagicLinks, pruneRateLimits } from "./modules/magic-links";
import { readConfig } from "./config";
import { buildAdminAlert, deliverAdminAlert } from "./observability/alert";
import { expireDiscordRecoveryArtifactsIfInstalled } from './discord/recovery';

/**
 * Scheduled work is isolated per step. One failed maintenance task must not
 * prevent the remaining bounded work or the EmDash editorial/publication
 * handler from running. The returned receipt is written to the Worker log so a
 * real scheduled run can be correlated without claiming success from a unit
 * call.
 */
export interface ScheduledMaintenanceStep {
  name: string;
  run: (env: ScheduledEnv) => Promise<unknown>;
}

export interface ScheduledEnv {
  DB: D1Database;
  MEDIA: R2Bucket;
  [key: string]: unknown;
}

export const SCHEDULED_MAINTENANCE_STEPS: ScheduledMaintenanceStep[] = [
  { name: "rate_limits", run: (env) => pruneRateLimits(env.DB) },
  { name: "magic_links", run: (env) => pruneMagicLinks(env.DB) },
  { name: "discord_recovery_cleanup", run: (env) => expireDiscordRecoveryArtifactsIfInstalled(env.DB) },
  { name: "stale_interactions", run: (env) => expireStaleDiscordInteractions(env.DB) },
  {
    name: "npc_progression",
    run: (env) => runScheduledNpcProgression(env.DB, env.MEDIA, readConfig(env as never)),
  },
];

async function defaultAlert(
  env: ScheduledEnv,
  result: Awaited<ReturnType<typeof runScheduledMaintenance>>,
): Promise<void> {
  const failed = result.steps.filter((step) => !step.ok);
  await deliverAdminAlert(
    env as { ADMIN_DISCORD_WEBHOOK_URL?: string; DISCORD_WEBHOOK_URL?: string },
    buildAdminAlert({
      level: "error",
      message: `Scheduled maintenance failed: ${failed.map((step) => step.name).join(", ") || "unknown step"}`,
      correlationId: "scheduled:maintenance",
      detail: failed.map((step) => `${step.name}: ${step.detail ?? "failed"}`).join(" | "),
    }),
  );
}

export async function runScheduledMaintenance(
  env: ScheduledEnv,
  steps: ScheduledMaintenanceStep[] = SCHEDULED_MAINTENANCE_STEPS,
): Promise<{
  ok: boolean;
  steps: Array<{ name: string; ok: boolean; detail?: string }>;
}> {
  const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
  for (const step of steps) {
    try {
      const value = await step.run(env);
      results.push({
        name: step.name,
        ok: true,
        ...(typeof value === "number" ? { detail: String(value) } : {}),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      results.push({ name: step.name, ok: false, detail: detail.slice(0, 300) });
      // Keep the failure visible but continue the bounded maintenance set.
    }
  }
  const ok = results.every((step) => step.ok);
  console.log(
    JSON.stringify({
      level: ok ? "info" : "error",
      message: "scheduled maintenance",
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
    let maintenanceResult: Awaited<ReturnType<typeof runScheduledMaintenance>>;
    try {
      maintenanceResult = await maintenance(env as ScheduledEnv);
    } catch (error) {
      maintenanceResult = {
        ok: false,
        steps: [
          {
            name: "maintenance_runner",
            ok: false,
            detail: (error instanceof Error ? error.message : String(error)).slice(0, 300),
          },
        ],
      };
    }
    if (!maintenanceResult.ok) {
      try {
        await alert(env as ScheduledEnv, maintenanceResult);
      } catch (error) {
        console.error(
          JSON.stringify({
            level: "error",
            message: "scheduled alert delivery failed",
            error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
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
          detail: (error instanceof Error ? error.message : String(error)).slice(0, 300),
        };
        console.error(
          JSON.stringify({
            level: "error",
            message: "scheduled editorial handler failed",
            error: editorial.detail,
          }),
        );
      }
    }
    return { maintenance: maintenanceResult, editorial };
  };
}
