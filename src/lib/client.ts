"use client";

import { ensureAccessApiSession } from "./access-session";

const FALLBACK = "This action could not be completed.";

export class ApiClientError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
    public requestId?: string,
  ) {
    super(message);
  }
}

export function csrfToken(): string {
  return document.querySelector<HTMLMetaElement>('meta[name="foilbury-csrf"]')?.content ?? "";
}

/**
 * The Studio is the non-Cloudflare scoped administration surface. It uses the
 * same domain routes as /admin but under /api/v1/studio, where the Worker still
 * enforces the live role/capability on every request. /admin remains the
 * Access-protected operator surface.
 */
export function apiPath(path: string): string {
  if (typeof window === "undefined") return path;
  const isStudio = window.location.pathname === "/studio" || window.location.pathname.startsWith("/studio/");
  if (!isStudio && !(window as unknown as { __FOILBURY_STUDIO__?: boolean }).__FOILBURY_STUDIO__) return path;
  return path.startsWith("/api/v1/admin/")
    ? path.replace("/api/v1/admin/", "/api/v1/studio/")
    : path;
}

export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; idempotencyKey?: string; signal?: AbortSignal } = {},
): Promise<T> {
  const target = apiPath(path);
  if (!target.startsWith("/api/v1/studio/")) await ensureAccessApiSession(target);
  const headers = new Headers({ accept: "application/json" });
  const token = csrfToken();
  if (token) headers.set("x-foilbury-csrf", token);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  if (options.idempotencyKey) headers.set("idempotency-key", options.idempotencyKey);
  const response = await fetch(target, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers,
    credentials: "same-origin",
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const error = (
      payload as { error?: { code?: string; message?: string; details?: Record<string, unknown> } }
    )?.error;
    throw new ApiClientError(
      response.status,
      error?.code ?? "request_failed",
      error?.message ?? FALLBACK,
      error?.details,
      (payload as { request_id?: string } | null)?.request_id,
    );
  }
  return payload as T;
}

export async function apiUpload<T>(path: string, form: FormData, idempotencyKey?: string): Promise<T> {
  const target = apiPath(path);
  if (!target.startsWith("/api/v1/studio/")) await ensureAccessApiSession(target);
  const headers = new Headers({ accept: "application/json" });
  if (idempotencyKey) headers.set("idempotency-key", idempotencyKey);
  const token = csrfToken();
  if (token) headers.set("x-foilbury-csrf", token);
  const response = await fetch(target, {
    method: "POST",
    headers,
    credentials: "same-origin",
    body: form,
  });
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const error = (
      payload as { error?: { code?: string; message?: string; details?: Record<string, unknown> } }
    )?.error;
    throw new ApiClientError(
      response.status,
      error?.code ?? "request_failed",
      error?.message ?? FALLBACK,
      error?.details,
      (payload as { request_id?: string } | null)?.request_id,
    );
  }
  return payload as T;
}

export function idempotencyKey(prefix = "ui"): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function describeError(error: unknown): string {
  if (error instanceof ApiClientError) {
    return error.requestId ? `${error.message} Reference: ${error.requestId}` : error.message;
  }
  if (error instanceof Error) return error.message;
  return FALLBACK;
}
