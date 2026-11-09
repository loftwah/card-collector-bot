import type { D1Database } from "@cloudflare/workers-types";
import { all } from "../db";

type LineageRow = {
  id: string;
  origin: string;
  derivative_of_asset_id: string | null;
  dependencies_json: string | null;
};
type Lineage = "ai" | "no-recorded-ai" | "unknown" | "unclassified";

/** Resolve every recorded input, treating missing parents, cycles and malformed
 * dependency lists as unknown. The limit bounds untrusted catalogue graphs. */
export async function classifyArtLineage(
  db: D1Database,
  rootIds: string[],
): Promise<Map<string, Lineage>> {
  const result = new Map<string, Lineage>();
  const uniqueRoots = [...new Set(rootIds.filter(Boolean))];
  for (let i = 0; i < uniqueRoots.length; i += 64) {
    const chunk = await classifyChunk(db, uniqueRoots.slice(i, i + 64));
    for (const [id, state] of chunk) result.set(id, state);
  }
  return result;
}

async function classifyChunk(db: D1Database, rootIds: string[]): Promise<Map<string, Lineage>> {
  const nodes = new Map<string, LineageRow>();
  const requested = new Set<string>();
  let pending = [...new Set(rootIds.filter(Boolean))];
  while (pending.length && requested.size < 512) {
    const batch = pending
      .filter((id) => !requested.has(id))
      .slice(0, Math.min(80, 512 - requested.size));
    if (!batch.length) break;
    for (const id of batch) requested.add(id);
    const rows = await all<LineageRow>(
      db,
      `SELECT id, origin, derivative_of_asset_id, dependencies_json FROM fb_assets WHERE id IN (${batch.map(() => "?").join(",")}) AND archived_at IS NULL`,
      ...batch,
    );
    for (const row of rows) {
      nodes.set(row.id, row);
      const parents = parentIds(row);
      if (parents) pending.push(...parents);
    }
    pending = pending.filter((id) => !requested.has(id));
  }
  const memo = new Map<string, Lineage>();
  let work = 0;
  const walk = (id: string, path: Set<string>): Lineage => {
    if (++work > 8192 || path.has(id) || path.size >= 64) return "unknown";
    const cached = memo.get(id);
    if (cached) return cached;
    const row = nodes.get(id);
    if (!row) return "unknown";
    const parents = parentIds(row);
    if (!parents) return "unknown";
    if (row.origin === "ai_assisted" || row.origin === "ai_generated") return "ai";
    if (row.origin === "derived" && parents.length === 0) return "unknown";
    if (row.origin === "unknown" && parents.length === 0) return "unclassified";
    const next = new Set(path).add(id);
    const states = parents.map((parent) => walk(parent, next));
    if (states.includes("ai")) {
      memo.set(id, "ai");
      return "ai";
    }
    if (states.includes("unknown") || states.includes("unclassified") || row.origin === "unknown")
      return "unknown";
    const result = ["sourced", "foilbury_original", "derived"].includes(row.origin)
      ? "no-recorded-ai"
      : "unknown";
    if (result === "no-recorded-ai") memo.set(id, result);
    return result;
  };
  return new Map(rootIds.map((id) => [id, walk(id, new Set())]));
}

function parentIds(row: LineageRow): string[] | null {
  try {
    const deps: unknown = JSON.parse(row.dependencies_json ?? "[]");
    if (!Array.isArray(deps) || deps.some((item) => typeof item !== "string" || !item)) return null;
    return [
      ...new Set([...(row.derivative_of_asset_id ? [row.derivative_of_asset_id] : []), ...deps]),
    ];
  } catch {
    return null;
  }
}
