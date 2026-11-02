import { ApiError } from "../context";
import { nowIso } from "../db";
import { errorCallback, runCommand, runComponent } from "./commands";
import {
  buildDiscordContext,
  ensureDiscordPlayer,
  interactionUser,
  resolveInstallation,
} from "./context";
import { verifyDiscordSignature } from "./signature";
import type { DiscordCallback, DiscordEnv, DiscordInteraction } from "./types";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function interactionName(interaction: DiscordInteraction): string {
  if (interaction.type === 3) return interaction.data?.custom_id?.slice(0, 80) ?? "component";
  return interaction.data?.name ?? "unknown";
}

async function recordStart(env: DiscordEnv, interaction: DiscordInteraction): Promise<void> {
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

async function recordFinish(
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

function isEphemeralInteraction(interaction: DiscordInteraction): boolean {
  if (interaction.type === 3) {
    return !interaction.data?.custom_id?.startsWith("foilbury:open:");
  }
  const top = interaction.data?.options?.find((option) => option.type === 1 || option.type === 2);
  return top?.name !== "open";
}

async function discordBody(
  env: DiscordEnv,
  callback: DiscordCallback,
): Promise<{ body: BodyInit; headers: Record<string, string> }> {
  if (!callback.attachments?.length) {
    return { body: JSON.stringify(callback.data ?? {}), headers: { "content-type": "application/json" } };
  }
  const form = new FormData();
  form.append("payload_json", JSON.stringify(callback.data ?? {}));
  let index = 0;
  for (const attachment of callback.attachments) {
    const object = await env.MEDIA.get(attachment.r2Key);
    if (!object) continue;
    const bytes = await object.arrayBuffer();
    form.append(`files[${index}]`, new Blob([bytes as unknown as BlobPart], { type: attachment.contentType }), attachment.filename);
    index += 1;
  }
  return { body: form, headers: {} };
}

async function editOriginal(env: DiscordEnv, interaction: DiscordInteraction, callback: DiscordCallback): Promise<void> {
  const request = await discordBody(env, callback);
  const response = await fetch(
    `https://discord.com/api/v10/webhooks/${encodeURIComponent(interaction.application_id)}/${encodeURIComponent(interaction.token)}/messages/@original`,
    { method: "PATCH", headers: request.headers, body: request.body },
  );
  if (!response.ok) {
    console.error(
      JSON.stringify({
        level: "error",
        request_id: `discord:${interaction.id}`,
        message: "Discord follow-up delivery failed",
        status: response.status,
      }),
    );
  }
}

async function sendFollowUp(env: DiscordEnv, interaction: DiscordInteraction, callback: DiscordCallback): Promise<string | null> {
  const request = await discordBody(env, callback);
  const response = await fetch(
    `https://discord.com/api/v10/webhooks/${encodeURIComponent(interaction.application_id)}/${encodeURIComponent(interaction.token)}?wait=true`,
    { method: "POST", headers: request.headers, body: request.body },
  );
  if (!response.ok) {
    console.error(
      JSON.stringify({
        level: "error",
        request_id: `discord:${interaction.id}`,
        message: "Discord follow-up message failed",
        status: response.status,
      }),
    );
    return null;
  }
  const message = (await response.json().catch(() => null)) as { id?: string } | null;
  return message?.id ?? null;
}

async function originalMessageId(interaction: DiscordInteraction): Promise<string | null> {
  const response = await fetch(
    `https://discord.com/api/v10/webhooks/${encodeURIComponent(interaction.application_id)}/${encodeURIComponent(interaction.token)}/messages/@original`,
  ).catch(() => null);
  if (!response?.ok) return null;
  const message = (await response.json().catch(() => null)) as { id?: string } | null;
  return message?.id ?? null;
}

async function deleteOriginal(interaction: DiscordInteraction): Promise<void> {
  await fetch(
    `https://discord.com/api/v10/webhooks/${encodeURIComponent(interaction.application_id)}/${encodeURIComponent(interaction.token)}/messages/@original`,
    { method: "DELETE" },
  ).catch(() => undefined);
}

async function processDeferred(env: DiscordEnv, interaction: DiscordInteraction, applicationId: string): Promise<void> {
  try {
    const guildId = interaction.guild_id;
    if (!guildId) {
      await editOriginal(
        env,
        interaction,
        errorCallback(
          new ApiError(403, "discord_guild_required", "Foilbury only works in a server where this Bot is installed."),
        ),
      );
      await recordFinish(env, interaction.id, "failed", "discord_guild_required");
      return;
    }
    const resolved = await resolveInstallation(env, interaction, applicationId);
    const discordUser = interactionUser(interaction);
    const player = await ensureDiscordPlayer(env, resolved.tenant, discordUser);
    const ctx = buildDiscordContext(env, resolved.tenant, player.user, interaction);
    await recordStart(env, interaction);
    const callback =
      interaction.type === 2
        ? await runCommand(ctx, interaction, resolved.installation)
        : await runComponent(ctx, interaction, resolved.installation);
    if (isEphemeralInteraction(interaction)) {
      await editOriginal(env, interaction, callback);
    } else {
      // Card reveals are delivered as a normal follow-up with the render
      // attached, so the artwork is visible even when Discord's external image
      // proxy has not populated dimensions. The temporary deferred message is
      // removed only when it is a different message from the delivered card.
      const delivered = await sendFollowUp(env, interaction, callback);
      if (delivered) {
        const original = await originalMessageId(interaction);
        if (original && original !== delivered) await deleteOriginal(interaction);
      } else {
        await editOriginal(env, interaction, callback);
      }
    }
    await recordFinish(env, interaction.id, "completed");
  } catch (error) {
    const api = error instanceof ApiError ? error : null;
    if (api) {
      await recordFinish(env, interaction.id, "failed", api.code);
    } else {
      console.error(
        JSON.stringify({
          level: "error",
          request_id: `discord:${interaction.id}`,
          message: error instanceof Error ? error.message : "Unexpected Discord interaction error",
        }),
      );
      await recordFinish(env, interaction.id, "failed", "internal_error");
    }
    await editOriginal(
      env,
      interaction,
      errorCallback(
        api ?? new ApiError(500, "internal_error", "Foilbury could not complete that interaction. Nothing was changed."),
      ),
    );
  }
}

/**
 * Cloudflare Workers HTTP endpoint for Discord interactions.
 *
 * No Gateway connection or privileged intent is used. Every request is verified
 * against the raw body before it is parsed, then handled through the same domain
 * services as the website and headless API.
 */
export async function handleDiscordInteraction(
  request: Request,
  env: DiscordEnv,
  options?: { publicKey?: string; nowSeconds?: number; waitUntil?: (promise: Promise<unknown>) => void },
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "Use POST for Discord interactions." }, 405);
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return jsonResponse({ error: "The interaction body could not be read." }, 400);
  }

  try {
    await verifyDiscordSignature({
      body: raw,
      signature: request.headers.get("x-signature-ed25519"),
      timestamp: request.headers.get("x-signature-timestamp"),
      publicKey: options?.publicKey ?? env.DISCORD_PUBLIC_KEY,
      nowSeconds: options?.nowSeconds,
    });
  } catch (error) {
    const api = error instanceof ApiError ? error : null;
    return jsonResponse({ error: api?.message ?? "Discord signature verification failed." }, api?.status ?? 401);
  }

  let interaction: DiscordInteraction;
  try {
    interaction = JSON.parse(raw) as DiscordInteraction;
  } catch {
    return jsonResponse({ error: "The interaction body is not valid JSON." }, 400);
  }
  if (!interaction || typeof interaction !== "object" || typeof interaction.id !== "string" || typeof interaction.token !== "string") {
    return jsonResponse({ error: "The interaction payload is malformed." }, 400);
  }

  const applicationId = env.DISCORD_APPLICATION_ID?.trim();
  if (!applicationId) {
    return jsonResponse({ error: "The Discord application ID is not configured." }, 503);
  }
  if (interaction.application_id !== applicationId) {
    return jsonResponse({ error: "This interaction belongs to a different Discord application." }, 401);
  }

  if (interaction.type === 1) {
    return jsonResponse({ type: 1 });
  }

  if (interaction.type !== 2 && interaction.type !== 3) {
    return jsonResponse({ error: "Unsupported Discord interaction type." }, 400);
  }

  if (options?.waitUntil) {
    // Acknowledge within Discord's three-second deadline. D1 work, player
    // creation and the card reveal continue after the acknowledgement and are
    // delivered by editing the original interaction response.
    options.waitUntil(processDeferred(env, interaction, applicationId));
    return jsonResponse({
      type: 5,
      data: isEphemeralInteraction(interaction) ? { flags: 64 } : {},
    });
  }

  try {
    const guildId = interaction.guild_id;
    if (!guildId) {
      return jsonResponse(
        errorCallback(
          new ApiError(403, "discord_guild_required", "Foilbury only works in a server where this Bot is installed."),
        ),
      );
    }
    const resolved = await resolveInstallation(env, interaction, applicationId);
    const discordUser = interactionUser(interaction);
    const player = await ensureDiscordPlayer(env, resolved.tenant, discordUser);
    const ctx = buildDiscordContext(env, resolved.tenant, player.user, interaction);
    await recordStart(env, interaction);
    let callback: DiscordCallback;
    if (interaction.type === 2) {
      callback = await runCommand(ctx, interaction, resolved.installation);
    } else {
      callback = await runComponent(ctx, interaction, resolved.installation);
    }
    await recordFinish(env, interaction.id, "completed");
    return jsonResponse(callback);
  } catch (error) {
    const api = error instanceof ApiError ? error : null;
    if (api) {
      await recordFinish(env, interaction.id, "failed", api.code);
    } else {
      console.error(
        JSON.stringify({
          level: "error",
          request_id: `discord:${interaction.id}`,
          message: error instanceof Error ? error.message : "Unexpected Discord interaction error",
        }),
      );
      await recordFinish(env, interaction.id, "failed", "internal_error");
    }
    return jsonResponse(
      errorCallback(
        api ?? new ApiError(500, "internal_error", "Foilbury could not complete that interaction. Nothing was changed."),
      ),
    );
  }
}
