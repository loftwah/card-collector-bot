import { ApiError } from "../context";
import { errorCallback, runCommand, runComponent } from "./commands";
import {
  buildDiscordContext,
  ensureDiscordPlayer,
  interactionUser,
  resolveInstallation,
} from "./context";
import {
  readInteractionReceipt,
} from "./receipts";
import {
  deliverDeferred,
  isPrivateCallback,
  type DeliveryOutcome,
} from "./delivery";
import {
  isDiscordDrawInteraction,
  runDiscordDrawForInteraction,
} from "./draw-runtime";
import {
  recordInteractionFinish,
  recordInteractionStart,
} from "./interactions";
import { redactDiscordText } from "./redaction";
import { verifyDiscordSignature } from "./signature";
import type {
  DiscordCallback,
  DiscordEnv,
  DiscordInteraction,
} from "./types";

export { expireStaleDiscordInteractions } from "./interactions";

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

async function processDeferred(
  env: DiscordEnv,
  interaction: DiscordInteraction,
  applicationId: string,
): Promise<void> {
  let finished = false;
  let attemptId: string | null = null;
  const finish = async (
    status: "completed" | "failed",
    errorCode?: string,
    visibility?: DeliveryOutcome["visibility"],
  ): Promise<void> => {
    if (finished) return;
    finished = true;
    await recordInteractionFinish(env, interaction.id, status, errorCode, attemptId, visibility);
  };

  // The draw lifecycle is an Effect service. It owns identity, consent,
  // commit, receipt, delivery and recovery; the remaining commands keep the
  // existing generic path below.
  if (isDiscordDrawInteraction(interaction)) {
    await runDiscordDrawForInteraction({ env, interaction, applicationId });
    return;
  }

  attemptId = await recordInteractionStart(env, interaction);

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
      ? {type:4 as const,data:{content:"Your opening completed. You can request the receipt again or check your collection; no second opening is needed.",flags:64,allowed_mentions:{parse:[]},components:[{type:1 as const,components:[{type:2 as const,style:2 as const,label:"Re-send receipt",custom_id:`foilbury:redeliver:${interaction.id}`.slice(0,100)}]}]}}
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

  const attemptId = await recordInteractionStart(env, interaction);
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
    let callback: DiscordCallback;
    if (interaction.type === 2) {
      callback = await runCommand(ctx, interaction, resolved.installation);
    } else {
      callback = await runComponent(ctx, interaction, resolved.installation);
    }
    await recordInteractionFinish(env, interaction.id, "completed",undefined,attemptId,isPrivateCallback(callback) ? "private" : "public");
    return jsonResponse(callback);
  } catch (error) {
    const api = error instanceof ApiError ? error : null;
    if (api) {
      await recordInteractionFinish(env, interaction.id, "failed", api.code,attemptId);
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
      await recordInteractionFinish(env, interaction.id, "failed", "internal_error",attemptId);
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
