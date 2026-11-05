import type { Ctx, CurrentUser } from "../context";
import { first } from "../db";

/** Reconstruct live membership and platform grants; malformed scopes fail closed. */
export async function liveViewerContext(ctx: Ctx, userId: string): Promise<Ctx | null> {
  const row = await first<{ id: string; email: string; display_name: string; role: CurrentUser["role"]; platform_admin: number; scopes_json: string | null }>(ctx.db,
    `SELECT u.id, u.email, u.display_name, m.role,
      EXISTS (SELECT 1 FROM fb_platform_admins pa WHERE pa.user_id = u.id AND pa.status = 'active' AND pa.revoked_at IS NULL AND u.platform_admin = 1) AS platform_admin,
      (SELECT scopes_json FROM fb_platform_role_assignments p WHERE p.user_id = u.id AND p.role = 'global_collection_admin' AND p.status = 'active' AND p.revoked_at IS NULL) AS scopes_json
      FROM fb_users u JOIN fb_memberships m ON m.user_id = u.id AND m.tenant_id = ? AND m.status = 'active' AND m.revoked_at IS NULL
      WHERE u.id = ? AND u.disabled_at IS NULL AND u.is_synthetic=0`, ctx.tenant.id, userId);
  if (!row) return null;
  let scope: CurrentUser["globalCollectionScope"] = null;
  try {
    const parsed = JSON.parse(row.scopes_json ?? "null") as { all?: unknown; collectionIds?: unknown } | null;
    if (parsed?.all === true) scope = { all: true, collectionIds: [] };
    else if (parsed?.all === false && Array.isArray(parsed.collectionIds) && parsed.collectionIds.length > 0 && parsed.collectionIds.every((id) => typeof id === "string")) scope = { all: false, collectionIds: parsed.collectionIds };
  } catch { /* malformed grants have no scope */ }
  return { ...ctx, user: { id: row.id, email: row.email, displayName: row.display_name, role: row.role, platformAdmin: Boolean(row.platform_admin), globalCollectionScope: scope } };
}
