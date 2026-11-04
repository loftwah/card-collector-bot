import { nowIso } from "../db";
import type { DiscordEnv, DiscordInteraction } from "./types";

function interactionName(interaction: DiscordInteraction): string {
  if (interaction.type === 3) return interaction.data?.custom_id?.slice(0, 80) ?? "component";
  return interaction.data?.name ?? "unknown";
}

/**
 * Operational interaction log. These writes are deliberately best-effort: a
 * missing log row must never prevent the player's actual result from being
 * delivered. The Effect draw workflow additionally uses the conditional
 * `abandonInteraction` finalizer to close a cancelled run without overwriting
 * a completed one.
 */
export async function recordInteractionStart(
  env: DiscordEnv,
  interaction: DiscordInteraction,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO fb_discord_interactions
      (interaction_id, application_id, guild_id, channel_id, discord_user_id, command_name, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'processing', ?)
     ON CONFLICT(interaction_id) DO NOTHING`,
  )
    .bind(
      interaction.id,
      interaction.application_id,
      interaction.guild_id ?? null,
      interaction.channel_id ?? null,
      interaction.member?.user?.id ?? interaction.user?.id ?? null,
      interactionName(interaction),
      nowIso(),
    )
    .run()
    .catch(() => undefined);
}

export async function recordInteractionFinish(
  env: DiscordEnv,
  interactionId: string,
  status: "completed" | "failed",
  errorCode?: string,
): Promise<void> {
  await env.DB.prepare(
    "UPDATE fb_discord_interactions SET status = ?, error_code = ?, completed_at = ? WHERE interaction_id = ?",
  )
    .bind(status, errorCode ?? null, nowIso(), interactionId)
    .run()
    .catch(() => undefined);
}

/**
 * Close only an interaction that is still processing. A cancellation finalizer
 * must not relabel a result that already reached a terminal delivery state.
 */
export async function abandonInteraction(env: DiscordEnv, interactionId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE fb_discord_interactions
        SET status = 'failed', error_code = 'workflow_cancelled', completed_at = ?
      WHERE interaction_id = ? AND status = 'processing'`,
  )
    .bind(nowIso(), interactionId)
    .run()
    .catch(() => undefined);
}

/**
 * Mark interactions that never reached a terminal delivery state. The reward or
 * draw (when one committed) is untouched and remains visible in the collection;
 * this only keeps the operational record honest and makes stuck deliveries
 * visible instead of permanently "processing".
 */
export async function expireStaleDiscordInteractions(
  db: DiscordEnv["DB"],
  olderThanMinutes = 10,
): Promise<number> {
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000).toISOString();
  const result = await db
    .prepare(
      `UPDATE fb_discord_interactions
          SET status = 'failed', error_code = 'delivery_timeout', completed_at = ?
        WHERE status = 'processing' AND created_at < ?`,
    )
    .bind(now, cutoff)
    .run();
  return result.meta?.changes ?? 0;
}
