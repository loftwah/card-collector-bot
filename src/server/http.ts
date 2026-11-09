import { z } from "zod";
import { ApiError, type Ctx } from "./context";
import { first, nowIso, statement } from "./db";
import { canonicalJson, newId, safeRequestReference, sha256Hex } from "./ids";

export const MAX_BODY_BYTES = 1_000_000;

export function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  const merged = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  if (headers instanceof Headers) {
    const cookies = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    for (const cookie of cookies) merged.append("set-cookie", cookie);
    headers.forEach((value, key) => {
      if (key.toLowerCase() !== "set-cookie") merged.append(key, value);
    });
  } else if (headers) {
    for (const [key, value] of Object.entries(headers)) merged.append(key, value);
  }
  return new Response(JSON.stringify(data), { status, headers: merged });
}

export async function readJson<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BODY_BYTES) throw new ApiError(413, "body_too_large", "Request body is too large.");
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ApiError(400, "invalid_json", "The request body must be valid JSON.");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(422, "validation_failed", "Some fields are invalid.", {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
  return parsed.data;
}

export interface IdempotencyInput {
  key: string;
  digest: string;
}

export async function idempotencyInput(request: Request, body: unknown): Promise<IdempotencyInput> {
  const key = request.headers.get("idempotency-key")?.trim();
  if (!key) throw new ApiError(400, "idempotency_key_required", "Provide an Idempotency-Key header.");
  if (key.length < 8 || key.length > 200) {
    throw new ApiError(422, "idempotency_key_invalid", "Idempotency-Key must be 8–200 characters.");
  }
  return { key, digest: await sha256Hex(canonicalJson(body)) };
}

export async function findIdempotent(
  ctx: Ctx,
  operation: string,
  input: IdempotencyInput,
): Promise<{ response: unknown; replayed: boolean } | null> {
  const row = await first<{ request_digest: string; response_json: string }>(
    ctx.db,
    `SELECT request_digest, response_json FROM fb_idempotency_keys
      WHERE tenant_id = ? AND actor_type = ? AND actor_id = ? AND operation = ? AND idempotency_key = ?`,
    ctx.tenant.id,
    ctx.actor.type,
    ctx.actor.id,
    operation,
    input.key,
  );
  if (!row) return null;
  if (row.request_digest !== input.digest) {
    throw new ApiError(
      409,
      "idempotency_conflict",
      "This idempotency key was already used with a different request.",
    );
  }
  return { response: JSON.parse(row.response_json), replayed: true };
}

export function idempotencyStatement(ctx: Ctx, operation: string, input: IdempotencyInput, response: unknown) {
  return statement(
    ctx.db,
    `INSERT INTO fb_idempotency_keys
      (tenant_id, actor_type, actor_id, operation, idempotency_key, request_digest, status, response_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?)`,
    ctx.tenant.id,
    ctx.actor.type,
    ctx.actor.id,
    operation,
    input.key,
    input.digest,
    JSON.stringify(response),
    nowIso(),
  );
}

export async function replayOrThrow(ctx: Ctx, operation: string, input: IdempotencyInput) {
  const existing = await findIdempotent(ctx, operation, input);
  if (existing) return existing.response;
  return null;
}

export function apiErrorResponse(error: unknown, requestId: string): Response {
  // Only carry bounded, recognisable correlation IDs from the request. A
  // client-controlled header must not become arbitrary response or log text.
  const reference = safeRequestReference(requestId);
  if (error instanceof ApiError) {
    const retry = error.status === 429 && error.code === "rate_limited" ? error.details?.retryAfterSeconds : undefined;
    return json(
      { error: { code: error.code, message: error.message, details: error.details }, request_id: reference },
      error.status,
      typeof retry === "number" && Number.isSafeInteger(retry) && retry > 0 && retry <= 86400 ? { "retry-after": String(retry) } : undefined,
    );
  }
  console.error(
    JSON.stringify({
      level: "error",
      event_code: "api.unexpected_failure",
      request_id: reference,
      error: "operation_failed",
    }),
  );
  return json(
    {
      error: {
        code: "internal_error",
        message: "The cabinet could not complete that request. Check its status before trying again.",
      },
      request_id: reference,
    },
    500,
  );
}

export function auditStatement(
  ctx: Ctx,
  action: string,
  objectType: string,
  objectId: string,
  metadata: Record<string, unknown> = {},
) {
  return statement(
    ctx.db,
    `INSERT INTO fb_audit_events
      (id, tenant_id, actor_type, actor_id, represented_user_id, action, object_type, object_id,
       metadata_json, request_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    newId("aud"),
    ctx.tenant.id,
    ctx.actor.type,
    ctx.actor.id,
    ctx.actor.representedUserId,
    action,
    objectType,
    objectId,
    JSON.stringify(metadata),
    ctx.requestId,
    nowIso(),
  );
}

export async function audit(
  ctx: Ctx,
  action: string,
  objectType: string,
  objectId: string,
  metadata: Record<string, unknown> = {},
) {
  await auditStatement(ctx, action, objectType, objectId, metadata).run();
}

export function pagination(url: URL, defaultLimit = 20, maxLimit = 100) {
  const limit = Math.min(maxLimit, Math.max(1, Number(url.searchParams.get("limit") ?? defaultLimit) || defaultLimit));
  const cursor = url.searchParams.get("cursor");
  return { limit, cursor };
}

export function page<T>(items: T[], limit: number): { items: T[]; next_cursor: string | null } {
  const next = items.length > limit ? String((items[limit] as { id?: string })?.id ?? "") : null;
  return { items: items.slice(0, limit), next_cursor: next || null };
}
