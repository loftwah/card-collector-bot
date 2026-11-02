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
  EMDASH_ENCRYPTION_KEY?: string;
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
      } | null;
      sessionId: string | null;
      csrfToken: string;
      actor: { type: "user" | "agent" | "system"; id: string; representedUserId: string | null; label: string } | null;
      wallet: number | null;
    };
    requestId: string;
    theme: "light" | "dark" | "system";
  }
}

declare module "cloudflare:workers" {
  interface Env extends FoilburyEnv {}
}
