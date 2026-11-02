import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";

export async function first<T>(
  db: D1Database,
  sql: string,
  ...params: unknown[]
): Promise<T | null> {
  return (await db
    .prepare(sql)
    .bind(...params)
    .first<T>()) as T | null;
}

export async function all<T>(db: D1Database, sql: string, ...params: unknown[]): Promise<T[]> {
  const result = await db
    .prepare(sql)
    .bind(...params)
    .all<T>();
  return result.results ?? [];
}

export async function run(
  db: D1Database,
  sql: string,
  ...params: unknown[]
): Promise<{ changes: number }> {
  const result = await db
    .prepare(sql)
    .bind(...params)
    .run();
  return { changes: result.meta.changes ?? 0 };
}

export function statement(
  db: D1Database,
  sql: string,
  ...params: unknown[]
): D1PreparedStatement {
  return db
    .prepare(sql)
    .bind(...params);
}

export async function batch<T = unknown>(
  db: D1Database,
  statements: D1PreparedStatement[],
): Promise<T[]> {
  if (statements.length === 0) return [];
  const results = await db.batch(statements);
  return results as unknown as T[];
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function addSeconds(iso: string, seconds: number): string {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString();
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(",");
}
