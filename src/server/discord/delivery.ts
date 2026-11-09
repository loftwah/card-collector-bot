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
import { ApiError, type CurrentUser } from "../context";
import { first } from "../db";
import { sha256Hex } from "../ids";
import { runDiscordRequest } from "../effect/discord-transport";
import { renderResponse } from "../modules/media";
import { DRAW_EPOCH_TRIGGER_CHECK, DRAW_EPOCH_TRIGGER_DATA } from "../modules/draw-scope-epoch";
import { buildDiscordContext, resolveInstallation } from "./context";
import { discordFailureLog } from "./redaction";
import type { DiscordCallback, DiscordEnv, DiscordInteraction, DiscordMessage } from "./types";

export const EPHEMERAL_FLAG = 64;

function safeCorrelation(id: string): string {
  return /^\d{15,22}$/.test(id) ? `discord:${id}` : "discord:invalid-id";
}

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
        correlationId: safeCorrelation(requestContext.interactionId),
        method,
        url,
        status: result.error?.status ?? null,
        detail: `${result.error?.timedOut ? "timeout" : "transport_failed"} after ${Math.min(3, Math.max(0, result.attempts))} attempt(s)`,
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

export async function readBoundDiscordAttachment(env: DiscordEnv, interaction: DiscordInteraction, key: string, publicOnly: boolean): Promise<{bytes:Uint8Array;mime:string}|null> {
  const discordId=interaction.member?.user?.id ?? interaction.user?.id;
  if (!discordId || !key.startsWith('bound-render-stage-v1/')) return null;
  try {
    const installation=await resolveInstallation(env,interaction,interaction.application_id,{allowDisabledGame:true});
    const identity=()=>first<CurrentUser>(env.DB,`SELECT u.id,u.email,u.display_name,m.role,0 AS platformAdmin FROM fb_discord_identities d
      JOIN fb_users u ON u.id=d.user_id AND u.disabled_at IS NULL AND u.is_synthetic=0
      JOIN fb_memberships m ON m.user_id=u.id AND m.tenant_id=d.tenant_id AND m.status='active' AND m.revoked_at IS NULL
      WHERE d.tenant_id=? AND d.discord_user_id=? AND d.revoked_at IS NULL`,installation.tenant.id,discordId);
    const user=await identity();if(!user)return null;
    const output=await first<{asset_id:string;mime:string}>(env.DB,`SELECT p.asset_id,p.mime FROM fb_bound_render_outputs p
      JOIN fb_bound_render_jobs j ON j.id=p.job_id AND j.tenant_id=p.tenant_id AND j.status='succeeded'
      WHERE p.tenant_id=? AND p.r2_key=? AND p.side='front'`,installation.tenant.id,key);
    if(!output)return null;
    const ctx=buildDiscordContext(env,installation.tenant,user,interaction);
    const response=await renderResponse(ctx,env.MEDIA,output.asset_id,{publicOnly,request:new Request('https://foilbury.invalid/media')});
    if(response.status!==200)return null;
    const bytes=new Uint8Array(await response.arrayBuffer());
    const current=await identity();
    const currentInstallation=await resolveInstallation(env,interaction,interaction.application_id,{allowDisabledGame:true});
    if(!current || current.id!==user.id || currentInstallation.installation.id!==installation.installation.id)return null;
    return {bytes,mime:output.mime};
  } catch { return null; }
}

async function discordBody(
  env: DiscordEnv,
  interaction: DiscordInteraction,
  callback: DiscordCallback,
  publicOnly: boolean,
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
  const matchesShare = async (key:string, bytes:Uint8Array, mime:string) => {
    const proof=callback.publicCardShare;
    if (!proof) return true;
    return key===proof.renderKey && mime===proof.mime && /^[a-f0-9]{64}$/.test(proof.assetSha256)
      && bytes.byteLength===proof.assetBytes && await sha256Hex(bytes)===proof.assetSha256;
  };
  for (const attachment of requested) {
    // Collection-brand objects require a D1 version/byte pin before any read.
    // Discord attachments do not yet carry that evidence.
    if (attachment.r2Key.startsWith('collection-brand-v1/')) continue;
    try {
      if (attachment.r2Key.startsWith('bound-render-stage-v1/')) {
        const checked=await readBoundDiscordAttachment(env,interaction,attachment.r2Key,publicOnly);
        if (checked && checked.mime===attachment.contentType && await matchesShare(attachment.r2Key,checked.bytes,checked.mime)) files.push({bytes:checked.bytes,filename:attachment.filename,contentType:checked.mime});
        continue;
      }
      const object = await env.MEDIA.get(attachment.r2Key);
      if (!object) continue;
      const bytes = new Uint8Array(await object.arrayBuffer());
      if (!(await matchesShare(attachment.r2Key,bytes,attachment.contentType))) continue;
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
  const request = await discordBody(env, interaction, callback, false);
  const response = await discordFetch(
    `https://discord.com/api/v10/webhooks/${encodeURIComponent(interaction.application_id)}/${encodeURIComponent(interaction.token)}/messages/@original`,
    { method: "PATCH", headers: request.headers, body: request.body },
    { interactionId: interaction.id, token: interaction.token },
  );
  if (!response?.ok) {
    console.error(
      JSON.stringify(
        discordFailureLog({
          correlationId: safeCorrelation(interaction.id),
          method: "PATCH",
          url: `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`,
          status: response?.status ?? null,
          detail: response ? `HTTP ${response.status}` : "transport_failed",
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
  const request = await discordBody(env, interaction, callback, true);
  if (callback.publicCardShare) {
    if (!(await beginPublicCardShare(env,interaction,callback.publicCardShare))) {
      await transitionCardShareAttempt(env,callback.publicCardShare.attemptId,'reserved','not_sent');
      return null;
    }
  }
  const response = await discordFetch(
    `https://discord.com/api/v10/webhooks/${encodeURIComponent(interaction.application_id)}/${encodeURIComponent(interaction.token)}`,
    { method: "POST", headers: request.headers, body: request.body },
    { interactionId: interaction.id, token: interaction.token },
  );
  if (!response?.ok) {
    console.error(
      JSON.stringify(
        discordFailureLog({
          correlationId: safeCorrelation(interaction.id),
          method: "POST",
          url: `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}`,
          status: response?.status ?? null,
          detail: response ? `HTTP ${response.status}` : "transport_failed",
          secrets: [interaction.token],
          message: "Discord follow-up message failed",
        }),
      ),
    );
    return null;
  }
  const message = (await response.json().catch(() => null)) as { id?: string } | null;
  if (message?.id && callback.publicCardShare)
    await transitionCardShareAttempt(env,callback.publicCardShare.attemptId,'uncertain','delivered',message.id);
  return message?.id ?? null;
}

/** Transitions preserve attempt history; uncertainty never grants a retry. */
export async function transitionCardShareAttempt(env: DiscordEnv, id: string, from: 'reserved'|'uncertain', to: 'not_sent'|'delivered', messageId: string | null = null): Promise<boolean> {
  if (!((from==='reserved' && to==='not_sent') || (from==='uncertain' && to==='delivered'))) return false;
  try {
    const result=await env.DB.prepare(`UPDATE fb_discord_share_attempts SET state=?,message_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND state=? RETURNING id`)
      .bind(to,messageId,id,from).all();
    return result.results.length===1;
  } catch { return false; }
}

/** Recheck the exact share and reserve an uncertain outcome in one D1 write. */
export async function beginPublicCardShare(env: DiscordEnv, interaction: DiscordInteraction, proof: NonNullable<DiscordCallback['publicCardShare']>): Promise<boolean> {
  const discordId=interaction.member?.user?.id ?? interaction.user?.id;
  if (!discordId || !proof.epoch || proof.epoch.userId!==proof.userId) return false;
  try {
    const resolved=await resolveInstallation(env,interaction,interaction.application_id);
    if (resolved.tenant.id!==proof.tenantId || resolved.installation.id!==proof.installationId) return false;
    const result=await env.DB.prepare(`UPDATE fb_discord_share_attempts SET state='uncertain',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id=? AND interaction_id=? AND state='reserved' AND EXISTS (SELECT 1 FROM fb_discord_shares s
        WHERE s.id=fb_discord_share_attempts.share_id AND s.tenant_id=? AND s.user_id=? AND s.channel_id=? AND s.object_type='card' AND s.object_id=?)
      AND EXISTS (SELECT 1 FROM fb_card_instances ci
      JOIN fb_card_definitions cd ON cd.id=ci.card_id AND cd.tenant_id=ci.tenant_id
      JOIN fb_variants v ON v.id=ci.variant_id AND v.card_id=ci.card_id AND v.tenant_id=ci.tenant_id
      JOIN fb_variant_renders vr ON vr.variant_id=v.id AND vr.tenant_id=ci.tenant_id AND vr.status='published'
      JOIN fb_assets a ON a.id=vr.asset_id AND a.tenant_id=vr.tenant_id AND a.id=? AND a.r2_key=? AND a.sha256=? AND a.bytes=? AND a.mime=? AND a.archived_at IS NULL
      JOIN fb_users u ON u.id=ci.user_id AND u.disabled_at IS NULL
      JOIN fb_memberships m ON m.tenant_id=ci.tenant_id AND m.user_id=ci.user_id AND m.status='active' AND m.revoked_at IS NULL
      JOIN fb_discord_identities di ON di.tenant_id=ci.tenant_id AND di.user_id=ci.user_id AND di.discord_user_id=? AND di.revoked_at IS NULL
      JOIN fb_bots b ON b.tenant_id=ci.tenant_id AND b.status='active'
      JOIN fb_draw_scope_global_epoch g ON g.id=1 AND g.revision=?
      WHERE ci.id=? AND ci.tenant_id=? AND ci.user_id=? AND ci.card_id=? AND ci.variant_id=? AND ci.serial=? AND ci.status IN ('owned','reserved')
        AND cd.status='published' AND cd.archived_at IS NULL AND v.status='published' AND v.archived_at IS NULL
        AND COALESCE((SELECT revision FROM fb_draw_scope_tenant_epochs WHERE tenant_id=ci.tenant_id),0)=?
        AND COALESCE((SELECT revision FROM fb_draw_scope_user_epochs WHERE user_id=ci.user_id),0)=? AND ${DRAW_EPOCH_TRIGGER_CHECK}) RETURNING id`)
      .bind(proof.attemptId,interaction.id,proof.tenantId,proof.userId,interaction.channel_id ?? '',proof.cardId,proof.assetId,proof.renderKey,proof.assetSha256,proof.assetBytes,proof.mime,discordId,proof.epoch.global,proof.instanceId,proof.tenantId,proof.userId,proof.cardId,proof.variantId,proof.serial,proof.epoch.tenant,proof.epoch.user,DRAW_EPOCH_TRIGGER_DATA).all();
    return result.results.length===1;
  } catch { return false; }
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
    publicCardShare: callback.publicCardShare,
  };
}

function publicDeliveryFailedNote(callback: DiscordCallback, retryable = false): DiscordCallback {
  const data = privateCallback(callback);
  const note = retryable
    ? "Nothing was posted to the channel. You can try sharing again after your access and the card are available."
    : "The public channel copy could not be confirmed. This private receipt is the recorded result. A share record may already exist; check your cabinet before taking another action.";
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
  if (!settled) {
    if (callback.publicCardShare) await transitionCardShareAttempt(env,callback.publicCardShare.attemptId,'reserved','not_sent');
    return { delivered: false, visibility: "private_fallback" };
  }

  const publicMessageId = await sendFollowUp(env, interaction, callback);
  if (publicMessageId) return { delivered: true, visibility: "public" };

  // The user still has a complete private receipt. Re-edit it with an honest
  // explanation and a safe retry path rather than claiming success or silence.
  const attempt = callback.publicCardShare ? await first<{state:string}>(env.DB,
    'SELECT state FROM fb_discord_share_attempts WHERE id=?',callback.publicCardShare.attemptId).catch(() => null) : null;
  await editOriginal(env, interaction, publicDeliveryFailedNote(callback,attempt?.state==='not_sent'));
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
  return "The display step stopped after the draw. The recorded result remains in your cabinet; no second draw was started.";
}
