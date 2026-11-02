import fs from "node:fs";
import path from "node:path";
import { readSecretFile, startDevServer } from "./local.mjs";

export const BASE_URL = process.env.FOILBURY_URL ?? "http://localhost:5173";

export function accessHeaders() {
  const headers = {};
  if (process.env.CF_ACCESS_CLIENT_ID) headers["CF-Access-Client-Id"] = process.env.CF_ACCESS_CLIENT_ID;
  if (process.env.CF_ACCESS_CLIENT_SECRET) headers["CF-Access-Client-Secret"] = process.env.CF_ACCESS_CLIENT_SECRET;
  return headers;
}

export function agentToken(kind = process.env.FOILBURY_AGENT ?? "owner") {
  if (process.env.FOILBURY_AGENT_TOKEN) return process.env.FOILBURY_AGENT_TOKEN;
  const file = path.join(process.cwd(), ".foilbury/agents.json");
  if (!fs.existsSync(file)) throw new Error("No local agent credentials. Run pnpm setup:local first.");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const match = data.agents.find((agent) =>
    kind === "player" ? agent.represented === "player@foilbury.local" : agent.represented === "owner@foilbury.local",
  );
  if (!match?.token) throw new Error(`No local ${kind} agent credential found.`);
  return match.token;
}

export async function ensureServer() {
  await startDevServer(5173);
}

/** A dev server can briefly reload after a build or file change. Retry only transport failures. */
export async function fetchWithRetry(url, options = {}, attempts = 4) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fetch(url, options);
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

export async function apiFetch(route, options = {}) {
  await ensureServer();
  const headers = new Headers(options.headers ?? {});
  for (const [name, value] of Object.entries(accessHeaders())) headers.set(name, value);
  headers.set("authorization", `Bearer ${options.token ?? agentToken(options.agent ?? "owner")}`);
  let body;
  if (options.form) {
    body = options.form;
  } else if (options.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(options.body);
  }
  if (options.idempotencyKey) headers.set("idempotency-key", options.idempotencyKey);
  const method = options.method ?? (body === undefined ? "GET" : "POST");
  const retrySafe = method === "GET" || method === "HEAD" || Boolean(options.idempotencyKey);
  const response = retrySafe
    ? await fetchWithRetry(`${BASE_URL}${route}`, { method, headers, body })
    : await fetch(`${BASE_URL}${route}`, { method, headers, body });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    const error = payload?.error;
    const detail = error?.details ? ` ${JSON.stringify(error.details)}` : "";
    throw new Error(`${response.status} ${route} ${error?.code ?? "request_failed"}: ${error?.message ?? text}${detail}`);
  }
  return payload;
}

export async function apiJson(route, options = {}) {
  return apiFetch(route, options);
}

export async function apiForm(route, form) {
  return apiFetch(route, { method: "POST", form });
}

export function credentials() {
  return readSecretFile("local-credentials.json");
}
