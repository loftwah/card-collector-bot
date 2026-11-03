/**
 * Discord webhook URLs carry the interaction token in a path segment. Provider
 * errors can echo that URL, so operational logs never receive a raw URL or an
 * unscrubbed provider body.
 *
 * The route template is an allowlist: unknown paths collapse to a safe label
 * rather than guessing which segments are safe to retain.
 */

const DISCORD_HOSTS = new Set(["discord.com", "discordapp.com"]);

const SAFE_QUERY_KEYS = new Set(["wait", "with_response"]);

export interface DiscordRoute {
  method: string;
  template: string;
}

function normaliseMethod(method: string | undefined): string {
  const value = (method ?? "GET").toUpperCase();
  return /^[A-Z]{3,7}$/.test(value) ? value : "UNKNOWN";
}

function safeQuery(url: URL): string {
  const kept: string[] = [];
  for (const [key, value] of url.searchParams) {
    if (!SAFE_QUERY_KEYS.has(key)) continue;
    kept.push(`${key}=${value === "true" || value === "false" ? value : "…"}`);
  }
  return kept.length ? `?${kept.join("&")}` : "";
}

/**
 * Map a Discord request URL to a token-free route template. The application ID
 * and message ID are not secrets; interaction tokens, webhook tokens and query
 * strings are.
 */
export function discordRouteTemplate(method: string | undefined, rawUrl: string): DiscordRoute {
  const verb = normaliseMethod(method);
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { method: verb, template: "invalid-url" };
  }
  if (!DISCORD_HOSTS.has(url.hostname)) return { method: verb, template: "non-discord-host" };
  const parts = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  const query = safeQuery(url);

  // /api/v10/webhooks/:application_id/:interaction_token[/messages/:message_id]
  if (parts[0] === "api" && /^v\d+$/.test(parts[1] ?? "") && parts[2] === "webhooks") {
    const applicationId = parts[3] && /^\d{5,25}$/.test(parts[3]) ? parts[3] : ":application_id";
    if (parts.length === 5) {
      return { method: verb, template: `${verb} /api/v10/webhooks/${applicationId}/:interaction_token${query}` };
    }
    if (parts[5] === "messages" && parts.length === 7) {
      const messageId = parts[6] === "@original" ? "@original" : ":message_id";
      return {
        method: verb,
        template: `${verb} /api/v10/webhooks/${applicationId}/:interaction_token/messages/${messageId}${query}`,
      };
    }
    return { method: verb, template: `${verb} /api/v10/webhooks/${applicationId}/:interaction_token/…${query}` };
  }

  // /api/v10/interactions/:interaction_id/:interaction_token/callback
  if (parts[0] === "api" && /^v\d+$/.test(parts[1] ?? "") && parts[2] === "interactions") {
    const interactionId = parts[3] && /^\d{5,25}$/.test(parts[3]) ? parts[3] : ":interaction_id";
    if (parts[5] === "callback") {
      return { method: verb, template: `${verb} /api/v10/interactions/${interactionId}/:interaction_token/callback${query}` };
    }
    return { method: verb, template: `${verb} /api/v10/interactions/${interactionId}/:interaction_token/…${query}` };
  }

  // /api/v10/channels/:channel_id/messages[/:message_id]
  if (parts[0] === "api" && /^v\d+$/.test(parts[1] ?? "") && parts[2] === "channels") {
    const channelId = parts[3] && /^\d{5,25}$/.test(parts[3]) ? parts[3] : ":channel_id";
    if (parts[4] === "messages" && parts.length === 5) {
      return { method: verb, template: `${verb} /api/v10/channels/${channelId}/messages${query}` };
    }
    if (parts[4] === "messages" && parts.length === 6) {
      return { method: verb, template: `${verb} /api/v10/channels/${channelId}/messages/:message_id${query}` };
    }
    return { method: verb, template: `${verb} /api/v10/channels/${channelId}/…${query}` };
  }

  return { method: verb, template: `${verb} /api/…` };
}

const SECRET_PATTERNS: RegExp[] = [
  // Interaction/webhook token path segment.
  /\/webhooks\/(\d{5,25})\/[^/?#\s]+/gi,
  /\/interactions\/(\d{5,25})\/[^/?#\s]+/gi,
  // Bearer tokens and Discord bot tokens.
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:Bot|Bearer)\s+[A-Za-z0-9._-]{8,}/gi,
  /[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}/g,
  /\b(?:DISCORD_(?:BOT_TOKEN|PUBLIC_KEY|CLIENT_SECRET)|RESEND_API_KEY|FAL_AI_API_KEY|CF_API_TOKEN)\s*[=:]\s*\S+/gi,
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Scrub a provider/exception string. Explicit secret values are removed first,
 * then token-shaped material, then Discord webhook paths.
 */
export function redactDiscordText(input: unknown, secrets: string[] = []): string {
  let text = typeof input === "string" ? input : input instanceof Error ? input.message : String(input ?? "");
  text = text.replace(/\/webhooks\/(\d{5,25})\/[^/?#\s]+/gi, "/webhooks/$1/[redacted]");
  text = text.replace(/\/interactions\/(\d{5,25})\/[^/?#\s]+/gi, "/interactions/$1/[redacted]");
  for (const secret of secrets) {
    const value = secret.trim();
    if (value.length < 8) continue;
    text = text.replace(new RegExp(escapeRegExp(value), "g"), "[redacted]");
  }
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, "[redacted]");
  text = text.replace(/\s+/g, " ").trim();
  return text.slice(0, 500);
}

export interface DiscordFailureLog {
  level: "error";
  request_id: string;
  message: string;
  route: string;
  status: number | null;
  detail: string;
}

export function discordFailureLog(input: {
  correlationId: string;
  method: string;
  url: string;
  status?: number | null;
  detail?: unknown;
  secrets?: string[];
  message?: string;
}): DiscordFailureLog {
  return {
    level: "error",
    request_id: input.correlationId,
    message: input.message ?? "Discord request failed",
    route: discordRouteTemplate(input.method, input.url).template,
    status: input.status ?? null,
    detail: redactDiscordText(input.detail ?? "", input.secrets ?? []),
  };
}
