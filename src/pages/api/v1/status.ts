import type { APIRoute } from "astro";
import { runtimeEnv, ApiError } from "../../../server/context";
import { readConfig } from "../../../server/config";
import { first } from "../../../server/db";
import { json } from "../../../server/http";

export const prerender = false;

export const GET: APIRoute = async () => {
  const raw = runtimeEnv();
  const config = readConfig(raw);
  const tenants = await first<{ count: number }>(raw.DB, "SELECT COUNT(*) AS count FROM fb_tenants");
  const setup = await first<{ value: string }>(
    raw.DB,
    "SELECT value FROM fb_schema_meta WHERE key = 'bootstrap_complete'",
  );
  return json({
    name: "Foilbury",
    version: "0.1.0",
    environment: config.environment,
    local: config.localMode,
    dev_login: config.devLogin,
    configured: Boolean(tenants?.count) && setup?.value === "1",
    origin: config.publicOrigin,
    tenant: config.tenantSlug,
    providers: config.providers,
    discord: "disabled",
    email: "outbox_only",
    generation: "not_run",
    server_time_utc: new Date().toISOString(),
  });
};
