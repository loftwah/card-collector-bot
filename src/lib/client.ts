"use client";

const FALLBACK = "This action could not be completed.";

export class ApiClientError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function csrfToken(): string {
  return document.querySelector<HTMLMetaElement>('meta[name="foilbury-csrf"]')?.content ?? "";
}

export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<T> {
  const headers = new Headers({ accept: "application/json" });
  const token = csrfToken();
  if (token) headers.set("x-foilbury-csrf", token);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  if (options.idempotencyKey) headers.set("idempotency-key", options.idempotencyKey);
  const response = await fetch(path, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers,
    credentials: "same-origin",
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string; details?: Record<string, unknown> } })?.error;
    throw new ApiClientError(response.status, error?.code ?? "request_failed", error?.message ?? FALLBACK, error?.details);
  }
  return payload as T;
}

export async function apiUpload<T>(path: string, form: FormData): Promise<T> {
  const headers = new Headers({ accept: "application/json" });
  const token = csrfToken();
  if (token) headers.set("x-foilbury-csrf", token);
  const response = await fetch(path, { method: "POST", headers, credentials: "same-origin", body: form });
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string; details?: Record<string, unknown> } })?.error;
    throw new ApiClientError(response.status, error?.code ?? "request_failed", error?.message ?? FALLBACK, error?.details);
  }
  return payload as T;
}

export function idempotencyKey(prefix = "ui"): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function describeError(error: unknown): string {
  if (error instanceof ApiClientError) return error.message;
  if (error instanceof Error) return error.message;
  return FALLBACK;
}
