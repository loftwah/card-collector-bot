export type Role = "owner" | "editor" | "economy_admin" | "player";

export interface RuntimeConfig {
  appName: string;
  environment: "local" | "production" | "test";
  publicOrigin: string;
  tenantSlug: string;
  localMode: boolean;
  devLogin: boolean;
  sessionSecret: string;
  csrfSecret: string;
  agentPepper: string;
  emdashSiteUrl: string;
  providers: {
    fal: boolean;
    elevenlabs: boolean;
    resend: boolean;
    adminWebhook: boolean;
    discordApplication: boolean;
    discordBot: boolean;
  };
}

export interface RawEnv {
  FOILBURY_ENV?: string;
  FOILBURY_PUBLIC_ORIGIN?: string;
  FOILBURY_TENANT_SLUG?: string;
  FOILBURY_LOCAL_MODE?: string;
  FOILBURY_DEV_LOGIN?: string;
  FOILBURY_SESSION_SECRET?: string;
  FOILBURY_CSRF_SECRET?: string;
  FOILBURY_AGENT_TOKEN_PEPPER?: string;
  FOILBURY_BOOTSTRAP_TOKEN?: string;
  EMDASH_SITE_URL?: string;
  FAL_AI_API_KEY?: string;
  ELEVENLABS_API_KEY?: string;
  RESEND_API_KEY?: string;
  ADMIN_DISCORD_WEBHOOK_URL?: string;
  DISCORD_WEBHOOK_URL?: string;
  DISCORD_APPLICATION_ID?: string;
  DISCORD_BOT_TOKEN?: string;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function readConfig(raw: RawEnv): RuntimeConfig {
  const environment = raw.FOILBURY_ENV === "production" ? "production" : raw.FOILBURY_ENV === "test" ? "test" : "local";
  const localMode = environment === "local" && raw.FOILBURY_LOCAL_MODE === "true";
  const webhook = raw.ADMIN_DISCORD_WEBHOOK_URL?.trim() || raw.DISCORD_WEBHOOK_URL?.trim() || "";
  const sessionSecret = raw.FOILBURY_SESSION_SECRET ?? "";
  const csrfSecret = raw.FOILBURY_CSRF_SECRET ?? "";
  const agentPepper = raw.FOILBURY_AGENT_TOKEN_PEPPER ?? "";

  if (environment !== "local") {
    for (const [name, value] of [
      ["FOILBURY_SESSION_SECRET", sessionSecret],
      ["FOILBURY_CSRF_SECRET", csrfSecret],
      ["FOILBURY_AGENT_TOKEN_PEPPER", agentPepper],
    ] as const) {
      if (value.length < 32) throw new Error(`${name} must be at least 32 characters outside local mode`);
    }
  }

  return {
    appName: "Foilbury",
    environment,
    publicOrigin: raw.FOILBURY_PUBLIC_ORIGIN ?? "http://127.0.0.1:4321",
    tenantSlug: raw.FOILBURY_TENANT_SLUG ?? "cabinet",
    localMode,
    devLogin: localMode && raw.FOILBURY_DEV_LOGIN === "true",
    sessionSecret,
    csrfSecret,
    agentPepper,
    emdashSiteUrl: raw.EMDASH_SITE_URL ?? raw.FOILBURY_PUBLIC_ORIGIN ?? "http://127.0.0.1:4321",
    providers: {
      fal: Boolean(raw.FAL_AI_API_KEY?.trim()),
      elevenlabs: Boolean(raw.ELEVENLABS_API_KEY?.trim()),
      resend: Boolean(raw.RESEND_API_KEY?.trim()),
      adminWebhook: Boolean(webhook),
      discordApplication: Boolean(raw.DISCORD_APPLICATION_ID?.trim()),
      discordBot: Boolean(raw.DISCORD_BOT_TOKEN?.trim()),
    },
  };
}

/** A Host header is not evidence. This checks the actual request URL and an explicit local flag. */
export function isTrustedLocalRequest(request: Request, config: RuntimeConfig): boolean {
  if (!config.localMode) return false;
  const url = new URL(request.url);
  return LOOPBACK.has(url.hostname) && config.environment === "local";
}

export function assertTrustedLocal(request: Request, config: RuntimeConfig): void {
  if (!isTrustedLocalRequest(request, config)) {
    throw new Error("This action requires an explicit local development configuration bound to loopback.");
  }
}

export function redactProviderUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.hostname === "discord.com" ? "discord.com" : "configured-host"}/…`;
  } catch {
    return "configured";
  }
}
