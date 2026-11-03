import { ApiError } from "../context";
import { nowIso } from "../db";
import { errorCallback, runCommand, runComponent } from "./commands";
import {
  buildDiscordContext,
  ensureDiscordPlayer,
  interactionUser,
  resolveInstallation,
} from "./context";
import {
  drawRecoveryMessage,
  markDeliveryVisibility,
  readInteractionReceipt,
} from "./receipts";
import { runDiscordRequest } from "../effect/discord-transport";
import { discordFailureLog, redactDiscordText } from "./redaction";
import { verifyDiscordSignature } from "./signature";
import type {
  DiscordCallback,
  DiscordEnv,
  DiscordInteraction,
  DiscordMessage,
} from "./types";

const EPHEMERAL_FLAG = 64;

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

/**
 * Admin controls must remain reachable while Discord gameplay is disabled, so
 * an authorised Bot Owner can turn the installation back on. Authorisation is
 * still enforced by every admin command and confirmation handler.
 */
function isAdminInteraction(interaction: DiscordInteraction): boolean {
  if (interaction.type === 2) {
    const top = interaction.data?.options?.find((option) => option.type === 1 || option.type === 2);
    return top?.name === "admin";
  }
  if (interaction.type === 3) {
    const customId = interaction.data?.custom_id ?? "";
    return customId.startsWith("foilbury:confirm:") || customId.startsWith("foilbury:cancel:");
  }
  return false;
}

/**
 * Discord's webhook endpoints normally answer in under a second, but a stalled
 * connection must not strand the deferred interaction. Without a bound, the
 * Worker is terminated before it can record a terminal state, which is how the
 * two live empty `/foilbury open` messages on 2026-11-03 were produced.
 */
const DISCORD_DELIVERY_TIMEOUT_MS = 8_000;

interface DiscordRequestContext {
  interactionId: string;
  token?: string;
}

/**
 * GET/PATCH/DELETE webhook calls are idempotent and safe to retry within the
 * interaction lifetime. POST is deliberately not retried automatically: an
 * ambiguous create could post the same reveal twice. The caller keeps the
 * committed private receipt and offers a deliberate re-send instead.
 *
 * The execution, timeout, typed failure and bounded retry live in the Effect
 * service (`src/server/effect/discord-transport.ts`), so the production path
 * exercises more than a dependency addition.
 */
async function discordFetch(
  url: string,
  init: RequestInit,
  requestContext: DiscordRequestContext,
): Promise<Response | null> {
  const method = String(init.method ?? "GET").toUpperCase();
  const result = await runDiscordRequest(
    {
      url,
      init,
      timeoutMs: DISCORD_DELIVERY_TIMEOUT_MS,
      idempotent: method !== "POST",
      maxAttempts: 3,
    },
    {
      http: {
        request: (target, requestInit, signal) =>
          fetch(target, { ...requestInit, signal }),
      },
      logger: {
        error: () => {
          // The boundary below emits the single redacted operational event.
        },
      },
    },
  );
  if (result.response) return result.response;
  console.error(
    JSON.stringify(
      discordFailureLog({
        correlationId: `discord:${requestContext.interactionId}`,
        method,
        url,
        status: result.error?.status ?? null,
        detail: result.error
          ? `${result.error.message}${result.error.timedOut ? " (timeout)" : ""} after ${result.attempts} attempt(s)`
          : `Discord request failed after ${result.attempts} attempt(s)`,
        secrets: requestContext.token ? [requestContext.token] : [],
        message: "Discord request failed or timed out",
      }),
    ),
  );
  return null;
}

function stripUnavailableAttachments(data: DiscordMessage): DiscordMessage {
  const embeds = (data.embeds ?? []).map((embed) => {
    if (!embed.image?.url.startsWith("attachment://")) return embed;
    const { image: _image, ...withoutImage } = embed;
    return withoutImage;
  });
  return { ...data, embeds };
}

function ensureVisibleResult(data: DiscordMessage, artworkFailed: boolean): DiscordMessage {
  const visible = artworkFailed ? stripUnavailableAttachments(data) : data;
  const hasVisibleEmbed = Boolean(visible.embeds?.length);
  if (visible.content?.trim() || hasVisibleEmbed) {
    if (!artworkFailed || !hasVisibleEmbed) return visible;
    const note = "The card artwork could not be attached to this message. The result is recorded; open your collection to see the card.";
    return { ...visible, content: visible.content?.trim() ? `${visible.content}\n${note}` : note };
  }
  return {
    ...visible,
    content: "Foilbury completed the action, but the result had no displayable content. Open your collection to see the current state.",
  };
}

async function discordBody(
  env: DiscordEnv,
  callback: DiscordCallback,
): Promise<{ body: BodyInit; headers: Record<string, string>; artworkFailed: boolean }> {
  const requested = callback.attachments ?? [];
  if (!requested.length) {
    return {
      body: JSON.stringify(ensureVisibleResult(callback.data ?? {}, false)),
      headers: { "content-type": "application/json" },
      artworkFailed: false,
    };
  }
  const files: Array<{ bytes: Uint8Array; filename: string; contentType: string }> = [];
  for (const attachment of requested) {
    try {
      const object = await env.MEDIA.get(attachment.r2Key);
      if (!object) continue;
      const bytes = new Uint8Array(await object.arrayBuffer());
      files.push({ bytes, filename: attachment.filename, contentType: attachment.contentType });
    } catch {
      // A missing or unreadable render falls back to a text receipt below.
    }
  }
  const artworkFailed = files.length === 0;
  const data = ensureVisibleResult(callback.data ?? {}, artworkFailed);
  const form = new FormData();
  form.append("payload_json", JSON.stringify(data));
  files.forEach((file, index) => {
    form.append(
      `files[${index}]`,
      new Blob([file.bytes as unknown as BlobPart], { type: file.contentType }),
      file.filename,
    );
  });
  return { body: form, headers: {}, artworkFailed };
}

async function editOriginal(
  env: DiscordEnv,
  interaction: DiscordInteraction,
  callback: DiscordCallback,
): Promise<boolean> {
  const request = await discordBody(env, callback);
  const response = await discordFetch(
    `https://discord.com/api/v10/webhooks/${encodeURIComponent(interaction.application_id)}/${encodeURIComponent(interaction.token)}/messages/@original`,
    { method: "PATCH", headers: request.headers, body: request.body },
    { interactionId: interaction.id, token: interaction.token },
  );
  if (!response?.ok) {
    const detail = response ? await response.text().catch(() => "") : "request timed out";
    console.error(
      JSON.stringify(
        discordFailureLog({
          correlationId: `discord:${interaction.id}`,
          method: "PATCH",
          url: `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`,
          status: response?.status ?? null,
          detail,
          secrets: [interaction.token],
          message: "Discord original-response edit failed",
        }),
      ),
    );
    return false;
  }
  return true;
}

async function sendFollowUp(
  env: DiscordEnv,
  interaction: DiscordInteraction,
  callback: DiscordCallback,
): Promise<string | null> {
  const request = await discordBody(env, callback);
  const response = await discordFetch(
    `https://discord.com/api/v10/webhooks/${encodeURIComponent(interaction.application_id)}/${encodeURIComponent(interaction.token)}`,
    { method: "POST", headers: request.headers, body: request.body },
    { interactionId: interaction.id, token: interaction.token },
  );
  if (!response?.ok) {
    const detail = response ? await response.text().catch(() => "") : "request timed out";
    console.error(
      JSON.stringify(
        discordFailureLog({
          correlationId: `discord:${interaction.id}`,
          method: "POST",
          url: `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}`,
          status: response?.status ?? null,
          detail,
          secrets: [interaction.token],
          message: "Discord follow-up message failed",
        }),
      ),
    );
    return null;
  }
  const message = (await response.json().catch(() => null)) as { id?: string } | null;
  return message?.id ?? null;
}

function isPrivateCallback(callback: DiscordCallback): boolean {
  return Boolean((callback.data?.flags ?? 0) & EPHEMERAL_FLAG);
}

function privateCallback(callback: DiscordCallback, note?: string): DiscordCallback {
  const data = callback.data ?? {};
  return {
    type: 4,
    data: {
      ...data,
      content: note ? (data.content ? `${data.content}\n${note}` : note) : data.content,
      flags: (data.flags ?? 0) | EPHEMERAL_FLAG,
    },
    attachments: callback.attachments,
  };
}

function publicDeliveryFailedNote(callback: DiscordCallback): DiscordCallback {
  const data = privateCallback(callback);
  const note =
    "The public channel copy could not be posted. This private receipt is the recorded result. Press Share to channel to try the public post again; do not start a new draw.";
  return {
    ...data,
    data: {
      ...data.data!,
      content: data.data?.content ? `${data.data.content}\n${note}` : note,
    },
  };
}

interface DeliveryOutcome {
  delivered: boolean;
  visibility: "private" | "public" | "private_fallback";
}

/**
 * Deliver a completed interaction. The initial deferred acknowledgement is
 * always private, because element-level audience checks happen after the draw.
 * Discord preserves that visibility for the original message; it cannot be
 * changed later.
 *
 * A public result therefore uses a deliberate second delivery: settle the
 * original with the private receipt, then create a public follow-up. The first
 * POST after a deferred response is documented to edit the original instead of
 * creating a message, so the PATCH must happen first.
 */
async function deliverDeferred(
  env: DiscordEnv,
  interaction: DiscordInteraction,
  callback: DiscordCallback,
): Promise<DeliveryOutcome> {
  if (isPrivateCallback(callback)) {
    const delivered = await editOriginal(env, interaction, callback);
    return { delivered, visibility: "private" };
  }

  const privateReceipt = privateCallback(callback);
  const settled = await editOriginal(env, interaction, privateReceipt);
  if (!settled) return { delivered: false, visibility: "private_fallback" };

  const publicMessageId = await sendFollowUp(env, interaction, callback);
  if (publicMessageId) return { delivered: true, visibility: "public" };

  // The user still has a complete private receipt. Re-edit it with an honest
  // explanation and a safe retry path rather than claiming success or silence.
  await editOriginal(env, interaction, publicDeliveryFailedNote(callback));
  return { delivered: true, visibility: "private_fallback" };
}

function safeRecoveryReason(error: unknown): string {
  const api = error instanceof ApiError ? error : null;
  if (!api) {
    return "The result is recorded; the display step hit an unexpected error. No second draw was started.";
  }
  if (api.code === "card_render_unavailable" || api.code === "render_missing") {
    return "The saved card render was unavailable, but the draw and serial are recorded.";
  }
  return `The display step stopped after the draw: ${redactDiscordText(api.message)}.`;
}

async function processDeferred(
  env: DiscordEnv,
  interaction: DiscordInteraction,
  applicationId: string,
): Promise<void> {
  let finished = false;
  const finish = async (
    status: "completed" | "failed",
    errorCode?: string,
    visibility?: DeliveryOutcome["visibility"],
  ): Promise<void> => {
    if (finished) return;
    finished = true;
    await recordFinish(env, interaction.id, status, errorCode);
    if (visibility) await markDeliveryVisibility(env.DB, interaction.id, visibility);
  };

  try {
    const guildId = interaction.guild_id;
    if (!guildId) {
      const outcome = await deliverDeferred(
        env,
        interaction,
        errorCallback(
          new ApiError(
            403,
            "discord_guild_required",
            "Foilbury only works in a server where this Bot is installed.",
          ),
        ),
      );
      await finish(outcome.delivered ? "completed" : "failed", "discord_guild_required", outcome.visibility);
      return;
    }
    const resolved = await resolveInstallation(env, interaction, applicationId, {
      allowDisabledGame: isAdminInteraction(interaction),
    });
    const discordUser = interactionUser(interaction);
    const player = await ensureDiscordPlayer(env, resolved.tenant, discordUser);
    const ctx = buildDiscordContext(env, resolved.tenant, player.user, interaction);
    await recordStart(env, interaction);
    const callback =
      interaction.type === 2
        ? await runCommand(ctx, interaction, resolved.installation)
        : await runComponent(ctx, interaction, resolved.installation);
    const outcome = await deliverDeferred(env, interaction, callback);
    if (!outcome.delivered) {
      // The domain may already have committed. Keep the interaction completed
      // with a delivery-specific error code; the receipt is retrievable.
      const receipt = await readInteractionReceipt(env.DB, interaction.id);
      await finish(receipt ? "completed" : "failed", "delivery_failed", outcome.visibility);
      return;
    }
    await finish(
      "completed",
      outcome.visibility === "private_fallback" ? "public_delivery_failed" : undefined,
      outcome.visibility,
    );
  } catch (error) {
    const api = error instanceof ApiError ? error : null;
    if (!api) {
      console.error(
        JSON.stringify({
          level: "error",
          request_id: `discord:${interaction.id}`,
          message: redactDiscordText(
            error instanceof Error ? error.message : "Unexpected Discord interaction error",
            [interaction.token],
          ),
        }),
      );
    }

    // A draw may have committed before the failure. Recover the persisted
    // receipt and tell the truth; never offer a second paid draw as "retry".
    const receipt = await readInteractionReceipt(env.DB, interaction.id);
    const recovery = receipt
      ? {
          type: 4 as const,
          data: drawRecoveryMessage({
            receipt,
            origin: env.FOILBURY_PUBLIC_ORIGIN ?? "https://foilbury.loftwah.com",
            interactionId: interaction.id,
            reason: safeRecoveryReason(error),
          }) as DiscordMessage,
        }
      : errorCallback(api);
    const outcome = await deliverDeferred(env, interaction, recovery);
    await finish(
      outcome.delivered || Boolean(receipt) ? "completed" : "failed",
      outcome.delivered ? (receipt ? "delivery_recovered" : api?.code) : "delivery_failed",
      outcome.visibility,
    );
  }
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
  options?: {
    publicKey?: string;
    nowSeconds?: number;
    waitUntil?: (promise: Promise<unknown>) => void;
  },
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
    return jsonResponse(
      { error: api?.message ?? "Discord signature verification failed." },
      api?.status ?? 401,
    );
  }

  let interaction: DiscordInteraction;
  try {
    interaction = JSON.parse(raw) as DiscordInteraction;
  } catch {
    return jsonResponse({ error: "The interaction body is not valid JSON." }, 400);
  }
  if (
    !interaction ||
    typeof interaction !== "object" ||
    typeof interaction.id !== "string" ||
    typeof interaction.token !== "string"
  ) {
    return jsonResponse({ error: "The interaction payload is malformed." }, 400);
  }

  const applicationId = env.DISCORD_APPLICATION_ID?.trim();
  if (!applicationId) {
    return jsonResponse({ error: "The Discord application ID is not configured." }, 503);
  }
  if (interaction.application_id !== applicationId) {
    return jsonResponse(
      { error: "This interaction belongs to a different Discord application." },
      401,
    );
  }

  if (interaction.type === 1) {
    return jsonResponse({ type: 1 });
  }

  if (interaction.type !== 2 && interaction.type !== 3) {
    return jsonResponse({ error: "Unsupported Discord interaction type." }, 400);
  }

  if (options?.waitUntil) {
    // Acknowledge within Discord's three-second deadline. Every deferred
    // acknowledgement is private, because a later audience check cannot change
    // the visibility Discord has already fixed for this message.
    options.waitUntil(processDeferred(env, interaction, applicationId));
    return jsonResponse({ type: 5, data: { flags: EPHEMERAL_FLAG } });
  }

  try {
    const guildId = interaction.guild_id;
    if (!guildId) {
      return jsonResponse(
        errorCallback(
          new ApiError(
            403,
            "discord_guild_required",
            "Foilbury only works in a server where this Bot is installed.",
          ),
        ),
      );
    }
    const resolved = await resolveInstallation(env, interaction, applicationId, {
      allowDisabledGame: isAdminInteraction(interaction),
    });
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
    await markDeliveryVisibility(
      env.DB,
      interaction.id,
      isPrivateCallback(callback) ? "private" : "public",
    );
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
          message: redactDiscordText(
            error instanceof Error ? error.message : "Unexpected Discord interaction error",
            [interaction.token],
          ),
        }),
      );
      await recordFinish(env, interaction.id, "failed", "internal_error");
    }
    return jsonResponse(
      errorCallback(
        api ??
          new ApiError(
            500,
            "internal_error",
            "Foilbury could not confirm the outcome of that action. Check your cabinet and wallet before trying again; a committed draw remains recorded.",
          ),
      ),
    );
  }
}
