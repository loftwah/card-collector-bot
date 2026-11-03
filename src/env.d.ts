/// <reference types="astro/client" />
/// <reference types="emdash/locals" />

type D1Database = import("@cloudflare/workers-types").D1Database;
type R2Bucket = import("@cloudflare/workers-types").R2Bucket;
type Fetcher = import("@cloudflare/workers-types").Fetcher;

interface FoilburyEnv {
  DB: D1Database;
  MEDIA: R2Bucket;
  ASSETS?: Fetcher;
  SESSION?: import("@cloudflare/workers-types").KVNamespace;
  FOILBURY_ENV: string;
  FOILBURY_PUBLIC_ORIGIN: string;
  FOILBURY_TENANT_SLUG: string;
  EMDASH_SITE_URL?: string;
  FOILBURY_LOCAL_MODE?: string;
  FOILBURY_SESSION_SECRET?: string;
  FOILBURY_CSRF_SECRET?: string;
  FOILBURY_BOOTSTRAP_TOKEN?: string;
  FOILBURY_AGENT_TOKEN_PEPPER?: string;
  FOILBURY_ACCESS_TEAM_DOMAIN?: string;
  FOILBURY_ACCESS_AUD?: string;
  FOILBURY_ACCESS_API_AUD?: string;
  FOILBURY_ACCESS_PLATFORM_AUD?: string;
  FOILBURY_ACCESS_PLATFORM_API_AUD?: string;
  FOILBURY_ACCESS_EDITORIAL_AUD?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM_ADDRESS?: string;
  RESEND_REPLY_TO?: string;
  EMDASH_ENCRYPTION_KEY?: string;
  DISCORD_APPLICATION_ID?: string;
  DISCORD_PUBLIC_KEY?: string;
  DISCORD_BOT_TOKEN?: string;
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  DISCORD_REDIRECT_URI?: string;
  DISCORD_TEST_GUILD_ID?: string;
  DISCORD_TEST_CHANNEL_ID?: string;
}

declare namespace App {
  interface Locals {
    foilbury?: {
      tenantId: string;
      tenantSlug: string;
      user: {
        id: string;
        email: string;
        displayName: string;
        role: "owner" | "editor" | "economy_admin" | "player";
        platformAdmin?: boolean;
        capabilities?: string[];
      } | null;
      sessionId: string | null;
      csrfToken: string;
      actor: { type: "user" | "agent" | "system"; id: string; representedUserId: string | null; label: string } | null;
      wallet: number | null;
      accessStatus?: string | null;
      accessIdentity?: import("./server/access").AccessIdentity | null;
    };
    requestId: string;
    theme: "light" | "dark" | "system";
  }
}

declare module "cloudflare:workers" {
  interface Env extends FoilburyEnv {}
}

