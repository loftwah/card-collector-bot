export type Role = "owner" | "editor" | "economy_admin" | "player";

export interface AccessConfig {
  enabled: boolean;
  teamDomain: string;
  adminAudience: string;
  apiAudience: string;
  platformAudience: string;
  platformApiAudience: string;
  editorialAudience: string;
}

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
  resendFrom: string;
  access: AccessConfig;
  providers: {
    fal: boolean;
    elevenlabs: boolean;
    resend: boolean;
    adminWebhook: boolean;
    discordApplication: boolean;
    discordBot: boolean;
    discordOAuth: boolean;
    cloudflareAccess: boolean;
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
  RESEND_FROM_ADDRESS?: string;
  RESEND_REPLY_TO?: string;
  FOILBURY_ACCESS_TEAM_DOMAIN?: string;
  FOILBURY_ACCESS_AUD?: string;
  FOILBURY_ACCESS_API_AUD?: string;
  FOILBURY_ACCESS_PLATFORM_AUD?: string;
  FOILBURY_ACCESS_PLATFORM_API_AUD?: string;
  FOILBURY_ACCESS_EDITORIAL_AUD?: string;
  ADMIN_DISCORD_WEBHOOK_URL?: string;
  DISCORD_WEBHOOK_URL?: string;
  DISCORD_APPLICATION_ID?: string;
  DISCORD_PUBLIC_KEY?: string;
  DISCORD_BOT_TOKEN?: string;
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  DISCORD_REDIRECT_URI?: string;
  DISCORD_TEST_GUILD_ID?: string;
  DISCORD_TEST_CHANNEL_ID?: string;
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

  const accessTeamDomain = raw.FOILBURY_ACCESS_TEAM_DOMAIN?.trim() ?? "";
  const access = {
    enabled: environment === "production" && Boolean(accessTeamDomain),
    teamDomain: accessTeamDomain.replace(/^https?:\/\//, "").replace(/\/$/, ""),
    adminAudience: raw.FOILBURY_ACCESS_AUD?.trim() ?? "",
    apiAudience: raw.FOILBURY_ACCESS_API_AUD?.trim() ?? "",
    platformAudience: raw.FOILBURY_ACCESS_PLATFORM_AUD?.trim() ?? "",
    platformApiAudience: raw.FOILBURY_ACCESS_PLATFORM_API_AUD?.trim() ?? "",
    editorialAudience: raw.FOILBURY_ACCESS_EDITORIAL_AUD?.trim() ?? "",
  };

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
    resendFrom: raw.RESEND_FROM_ADDRESS?.trim() || "foilbury@loftwah.com",
    access,
    providers: {
      fal: Boolean(raw.FAL_AI_API_KEY?.trim()),
      elevenlabs: Boolean(raw.ELEVENLABS_API_KEY?.trim()),
      resend: Boolean(raw.RESEND_API_KEY?.trim()),
      adminWebhook: Boolean(webhook),
      discordApplication: Boolean(raw.DISCORD_APPLICATION_ID?.trim()),
      discordBot: Boolean(raw.DISCORD_BOT_TOKEN?.trim()),
      discordOAuth: Boolean(
        raw.DISCORD_CLIENT_SECRET?.trim() &&
          (raw.DISCORD_CLIENT_ID?.trim() || raw.DISCORD_APPLICATION_ID?.trim()),
      ),
      cloudflareAccess: access.enabled,
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
