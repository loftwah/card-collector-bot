import type { Ctx } from "../context";
import { all, first } from "../db";
import { sha256Hex } from "../ids";
import { canViewCollection, cardVisibilitySql, viewerAccess } from "./visibility";

/** Only collection-bound definitions with a fully identified frozen roster can be shared. */
export async function authorizedAchievementShare(owner: Ctx, viewer: Ctx, unlockId: string, expectedCriteriaHash?: string) {
  const row = await first<{ achievement_id: string; achievement_version: number; earned_at: string; name: string; description: string; art_key: string; category: string; criteria_json: string; visibility: string }>(owner.db,
    `SELECT u.achievement_id,u.achievement_version,u.earned_at,d.name,d.description,d.art_key,d.category,d.criteria_json,d.visibility
     FROM fb_achievement_unlocks u JOIN fb_achievement_definitions d ON d.id = u.achievement_id AND d.version = u.achievement_version
     WHERE u.id = ? AND u.tenant_id = ? AND u.user_id = ? AND d.status = 'active' AND d.archived_at IS NULL AND (d.scope = 'platform' OR (d.scope = 'bot' AND d.tenant_id = ?))`,
    unlockId, owner.tenant.id, owner.user!.id, owner.tenant.id);
  if (!row || row.visibility === "private") return null;
  const criteriaHash = await sha256Hex(row.criteria_json);
  if (expectedCriteriaHash && expectedCriteriaHash !== criteriaHash) return null;
  let criteria: { type?: unknown; collection_id?: unknown; roster_card_ids?: unknown };
  try { criteria = JSON.parse(row.criteria_json); } catch { return null; }
  const allowedKeys = new Set(["type", "collection_id", "collection_slug", "roster_card_ids", "roster_release_version", "roster_size", "target", "finish"]);
  if (!criteria || typeof criteria !== "object" || Array.isArray(criteria) || Object.keys(criteria).some((key) => !allowedKeys.has(key)) || !["first_in_collection", "collection_complete", "collection_unique", "collection_finish_set", "collection_core_set"].includes(String(criteria.type)) || typeof criteria.collection_id !== "string" || !Array.isArray(criteria.roster_card_ids) || !criteria.roster_card_ids.length || criteria.roster_card_ids.length > 40 || !criteria.roster_card_ids.every((id: unknown) => typeof id === "string" && id.length > 0)) return null;
  const ids = [...new Set(criteria.roster_card_ids as string[])];
  if (ids.length !== criteria.roster_card_ids.length) return null;
  const collection = await first<{ id: string; name: string; logo_url: string | null }>(owner.db, "SELECT id,name,logo_url FROM fb_collections WHERE id = ? AND status = 'published' AND archived_at IS NULL", criteria.collection_id);
  if (!collection || !(await canViewCollection(owner, collection.id, { liveContentAdmin: true })) || !(await canViewCollection(viewer, collection.id, { liveContentAdmin: true }))) return null;
  const roster = await all<{ id: string }>(owner.db, `SELECT cd.id FROM fb_card_definitions cd JOIN fb_collection_cards cc ON cc.card_id = cd.id WHERE cc.collection_id = ? AND cd.tenant_id = ? AND cd.id IN (${ids.map(() => "?").join(",")}) AND cd.status = 'published' AND cd.archived_at IS NULL`, collection.id, owner.tenant.id, ...ids);
  if (new Set(roster.map((c) => c.id)).size !== ids.length) return null;
  for (const actor of [owner, viewer]) {
    const predicate = cardVisibilitySql(await viewerAccess(actor, { liveContentAdmin: true }));
    const chunkSize = Math.min(20, 90 - predicate.params.length - 1);
    if (chunkSize < 1) return null;
    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize);
      const visible = await all<{ id: string }>(actor.db, `SELECT cd.id FROM fb_card_definitions cd WHERE cd.tenant_id = ? AND cd.id IN (${chunk.map(() => "?").join(",")}) AND cd.status = 'published' AND cd.archived_at IS NULL AND (${predicate.sql})`, actor.tenant.id, ...chunk, ...predicate.params);
      if (visible.length !== chunk.length) return null;
    }
  }
  return { criteriaHash, achievementId: row.achievement_id,
    fence: {achievementId:row.achievement_id,version:row.achievement_version,earnedAt:row.earned_at,criteria:row.criteria_json,visibility:row.visibility},
    payload: { label: "Achievement", achievement_name: `${collection.name} · Achievement`, achievement_description: "Earned for a verified collection roster.", art_key: "medal-generic", category: "collection", earned_at: row.earned_at, collection_logo_url: collection.logo_url, audience: "member" } };
}
