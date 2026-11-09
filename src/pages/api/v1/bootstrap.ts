import type { APIRoute } from "astro";
import { runtimeEnv, ApiError } from "../../../server/context";
import { readConfig } from "../../../server/config";
import { first } from "../../../server/db";
import { json, apiErrorResponse } from "../../../server/http";
import { bootstrapInstallation } from "../../../server/modules/bootstrap";
import { nowIso } from "../../../server/db";
import { newId, requestReference } from "../../../server/ids";

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const requestId = requestReference(request);
  try {
    const raw = runtimeEnv();
    const config = readConfig(raw);
    const url = new URL(request.url);
    const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
    if (!config.localMode || config.environment !== "local" || !loopback) {
      throw new ApiError(404, "not_found", "Not found.");
    }
    const supplied = request.headers.get("x-foilbury-bootstrap") ?? "";
    const expected = raw.FOILBURY_BOOTSTRAP_TOKEN ?? "";
    if (!expected || supplied !== expected) {
      throw new ApiError(403, "bootstrap_forbidden", "A valid local bootstrap token is required.");
    }
    const existing = await first<{ value: string }>(
      raw.DB,
      "SELECT value FROM fb_schema_meta WHERE key = 'bootstrap_complete'",
    );
    if (existing?.value === "1") {
      throw new ApiError(
        409,
        "already_bootstrapped",
        "This installation is already set up. Existing accounts and balances were not changed.",
      );
    }
    const result = await bootstrapInstallation();
    await raw.DB.prepare(
      "INSERT INTO fb_audit_events (id, tenant_id, actor_type, actor_id, represented_user_id, action, object_type, object_id, metadata_json, request_id, created_at) VALUES (?, ?, 'system', 'setup', NULL, 'installation.bootstrap', 'tenant', ?, '{}', ?, ?)",
    )
      .bind(newId("aud"), result.ownerTenantId, result.ownerTenantId, requestId, nowIso())
      .run();
    return json(result, 201, { "cache-control": "no-store" });
  } catch (error) {
    return apiErrorResponse(error, requestId);
  }
};
