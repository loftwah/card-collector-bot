export interface AdminAlert {
  level: "warning" | "error" | "critical";
  message: string;
  correlation_id?: string;
  detail?: string;
  occurred_at: string;
}

/**
 * Build a bounded, mention-free operational alert. Discord webhook tokens and
 * interaction tokens never enter the payload; only a correlation id and a
 * scrubbed detail string are included.
 */
export function buildAdminAlert(input: {
  level: AdminAlert["level"];
  message: string;
  correlationId?: string;
  detail?: string;
  occurredAt?: string;
  secrets?: string[];
}): { content: string; allowed_mentions: { parse: [] } } {
  // Only fixed event labels may cross the alert boundary. Free-form exception
  // messages can contain arbitrary member data, signed URLs or provider secrets
  // that cannot be reliably scrubbed with a token-pattern list.
  const scheduled = input.message.match(/^Scheduled maintenance failed: ([a-z_, ]+)$/);
  const allowedSteps = new Set(["rate_limits", "magic_links", "stale_interactions", "npc_progression", "maintenance_runner", "unknown step"]);
  const steps = scheduled?.[1]?.split(", ").filter((step) => allowedSteps.has(step)) ?? [];
  const message = scheduled && steps.length ? `Scheduled maintenance failed: ${steps.join(", ")}` : "Operational issue";
  const correlation = input.correlationId && /^(?:scheduled:maintenance|scheduled:run:[0-9a-f-]{36}|discord:\d{1,25})$/.test(input.correlationId)
    ? input.correlationId : undefined;
  const detailItems = input.detail?.split(" | ") ?? [];
  const safeDetails = detailItems.map((item) => item.match(/^([a-z_]+): (timeout|operation_failed|failed)$/))
    .filter((match): match is RegExpMatchArray => Boolean(match && allowedSteps.has(match[1] ?? "")))
    .map((match) => `${match[1]}: ${match[2]}`);
  const alert: AdminAlert = {
    level: input.level,
    message,
    ...(correlation ? { correlation_id: correlation } : {}),
    ...(input.detail ? { detail: safeDetails.length === detailItems.length && safeDetails.length ? safeDetails.join(" | ") : "Additional diagnostic detail withheld." } : {}),
    occurred_at: input.occurredAt && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(input.occurredAt) ? input.occurredAt : new Date().toISOString(),
  };
  return {
    content: [
      `**Foilbury ${alert.level}** · ${alert.message}`,
      alert.correlation_id ? `Correlation: \`${alert.correlation_id}\`` : null,
      alert.detail ? alert.detail : null,
      `Recorded: ${alert.occurred_at}`,
    ]
      .filter(Boolean)
      .join("\n")
      .slice(0, 1800),
    allowed_mentions: { parse: [] },
  };
}

export interface AlertDelivery {
  configured: boolean;
  delivered: boolean;
  status: number | null;
  attempts: number;
  error?: string;
}

/**
 * Deliver one alert with a single POST attempt. An ambiguous non-idempotent
 * POST is not retried automatically: a duplicate alert is less harmful than a
 * duplicate op, but the policy stays consistent with the rest of the product.
 * The caller decides whether the missing destination blocks a release.
 */
export async function deliverAdminAlert(
  env: { ADMIN_DISCORD_WEBHOOK_URL?: string; DISCORD_WEBHOOK_URL?: string },
  alert: { content: string; allowed_mentions: { parse: [] } },
  options: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    now?: () => number;
  } = {},
): Promise<AlertDelivery> {
  const url = env.ADMIN_DISCORD_WEBHOOK_URL?.trim() || env.DISCORD_WEBHOOK_URL?.trim() || "";
  if (!url) return { configured: false, delivered: false, status: null, attempts: 0 };
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(alert),
      signal: controller.signal,
    });
    return {
      configured: true,
      delivered: response.ok,
      status: response.status,
      attempts: 1,
      ...(response.ok ? {} : { error: `HTTP ${response.status}` }),
    };
  } catch (error) {
    return {
      configured: true,
      delivered: false,
      status: null,
      attempts: 1,
      error: error instanceof Error && error.name === "AbortError" ? "delivery_timeout" : "delivery_transport_error",
    };
  } finally {
    clearTimeout(timeout);
  }
}
