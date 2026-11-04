/**
 * Discord interaction delivery primitives.
 *
 * The Effect transport owns HTTP execution, timeout and bounded idempotent
 * retries. This module owns the interaction-level delivery rules:
 *
 * - the deferred acknowledgement always fixes the original message private;
 * - editing the original is idempotent and safe to retry;
 * - creating a follow-up is a single attempt, because an ambiguous POST cannot
 *   be repeated without risking a duplicate reveal;
 * - a public result is settled privately first, then posted as a follow-up.
 */
import { ApiError } from "../context";
import { runDiscordRequest } from "../effect/discord-transport";
import { discordFailureLog, redactDiscordText } from "./redaction";
import type { DiscordCallback, DiscordEnv, DiscordInteraction, DiscordMessage } from "./types";

export const EPHEMERAL_FLAG = 64;

/**
 * Discord's webhook endpoints normally answer in under a second, but a stalled
 * connection must not strand the deferred interaction. Without a bound, the
 * Worker is terminated before it can record a terminal state, which is how the
 * two live empty `/foilbury open` messages on 2026-11-03 were produced.
 */
export const DISCORD_DELIVERY_TIMEOUT_MS = 8_000;

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
        request: (target, requestInit, signal) => fetch(target, { ...requestInit, signal }),
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
    const note =
      "The card artwork could not be attached to this message. The result is recorded; open your collection to see the card.";
    return { ...visible, content: visible.content?.trim() ? `${visible.content}\n${note}` : note };
  }
  return {
    ...visible,
    content:
      "Foilbury completed the action, but the result had no displayable content. Open your collection to see the current state.",
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

export function isPrivateCallback(callback: DiscordCallback): boolean {
  return Boolean((callback.data?.flags ?? 0) & EPHEMERAL_FLAG);
}

export function privateCallback(callback: DiscordCallback, note?: string): DiscordCallback {
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

export interface DeliveryOutcome {
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
export async function deliverDeferred(
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

export function safeRecoveryReason(error: unknown): string {
  const api = error instanceof ApiError ? error : null;
  if (!api) {
    return "The result is recorded; the display step hit an unexpected error. No second draw was started.";
  }
  if (api.code === "card_render_unavailable" || api.code === "render_missing") {
    return "The saved card render was unavailable, but the draw and serial are recorded.";
  }
  return `The display step stopped after the draw: ${redactDiscordText(api.message)}.`;
}
