import type { Ctx } from "../context";
import { first } from "../db";
import { DRAW_EPOCH_TRIGGER_DEFINITIONS } from "./draw-epoch-trigger-definitions";

export const DRAW_EPOCH_TRIGGER_CHECK = `NOT EXISTS (SELECT 1 FROM json_each(?) e WHERE NOT EXISTS (SELECT 1 FROM sqlite_master s WHERE s.type='trigger' AND s.name=json_extract(e.value,'$[0]') AND s.sql=json_extract(e.value,'$[1]')))`;
export const DRAW_EPOCH_TRIGGER_DATA = JSON.stringify(DRAW_EPOCH_TRIGGER_DEFINITIONS);

/** Explicit repair primitive; callers must first hold new scoped draws and
 * coordinate all schema changes. Reinstall and invalidate previews atomically.
 * It is intentionally not exposed by an API or invoked automatically. */
export async function repairDrawEpochTriggers(db: Ctx["db"]): Promise<void> {
  await db.batch([
    ...DRAW_EPOCH_TRIGGER_DEFINITIONS.flatMap(([name, sql]) => [
      db.prepare(`DROP TRIGGER IF EXISTS "${name}"`),
      db.prepare(sql),
    ]),
    db.prepare("UPDATE fb_draw_scope_global_epoch SET revision=revision+1 WHERE id=1"),
    db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json('draw_epoch_repair_failed') END"),
    db.prepare(`SELECT CASE WHEN ${DRAW_EPOCH_TRIGGER_CHECK} THEN 1 ELSE json('draw_epoch_repair_failed') END`).bind(DRAW_EPOCH_TRIGGER_DATA),
  ]);
}

export type DrawScopeEpoch = { global: number; tenant: number; user: number; userId: string };
export type DrawInstallationSnapshot = {
  id: string;
  revision: number;
  botId: string | null;
  channelAllowlist: string;
  collectionAllowlist: string | null;
  channelAudience: string | null;
  channelKey: string | null;
};

/** Missing additive schema means no scoped-draw fence is available. */
export async function readDrawScopeEpoch(ctx: Ctx): Promise<DrawScopeEpoch | null> {
  if (!ctx.user) return null;
  try {
    const row = await first<{ global_revision: number; tenant_revision: number; user_revision: number }>(
      ctx.db,
      `SELECT g.revision AS global_revision, COALESCE((SELECT revision FROM fb_draw_scope_tenant_epochs WHERE tenant_id=?),0) AS tenant_revision, COALESCE((SELECT revision FROM fb_draw_scope_user_epochs WHERE user_id=?),0) AS user_revision FROM fb_draw_scope_global_epoch g WHERE g.id=1 AND ${DRAW_EPOCH_TRIGGER_CHECK}`,
      ctx.tenant.id,
      ctx.user.id,
      DRAW_EPOCH_TRIGGER_DATA,
    );
    if (!row) return null;
    const global = Number(row.global_revision),
      tenant = Number(row.tenant_revision), user = Number(row.user_revision);
    return Number.isSafeInteger(global) &&
      global >= 0 &&
      Number.isSafeInteger(tenant) &&
      tenant >= 0 && Number.isSafeInteger(user) && user >= 0
      ? { global, tenant, user, userId: ctx.user.id }
      : null;
  } catch (error) {
    if (/no such table: fb_draw_scope_(?:global_epoch|tenant_epochs|user_epochs)\b/.test(String(error)))
      return null;
    throw error;
  }
}
