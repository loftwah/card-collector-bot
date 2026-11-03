import { ApiError, type Ctx } from "../context";
import { all, first, nowIso } from "../db";
import { newId } from "../ids";
import { audit } from "../http";

export const SCOPED_PLATFORM_ROLES = ["global_collection_admin"] as const;
export type ScopedPlatformRole = (typeof SCOPED_PLATFORM_ROLES)[number];

export interface PlatformPerson {
  id: string;
  email: string;
  display_name: string;
  platform_admin: number;
  email_verified_at: string | null;
  created_at: string;
  disabled_at: string | null;
  discord_user_id: string | null;
  discord_username: string | null;
  platform_roles: Array<{ role: string; scopes: { all?: boolean; collectionIds?: string[] }; status: string; granted_at: string; reason: string }>;
  memberships: Array<{ tenant_id: string; tenant_name: string; tenant_slug: string; role: string; capabilities: string[]; status: string }>;
  bot_roles: Array<{ bot_id: string; bot_name: string; role: string; capabilities: string[]; status: string }>;
  pending_invitations: Array<{ bot_name: string; email: string; status: string; expires_at: string }>;
}

function parseScopes(value: string): { all?: boolean; collectionIds?: string[] } {
  try {
    const parsed = JSON.parse(value) as { all?: unknown; collectionIds?: unknown };
    return {
      all: parsed.all !== false,
      collectionIds: Array.isArray(parsed.collectionIds)
        ? parsed.collectionIds.filter((id): id is string => typeof id === "string")
        : [],
    };
  } catch {
    return { all: true, collectionIds: [] };
  }
}

export async function listPlatformPeople(ctx: Ctx, options: { search?: string; role?: string } = {}): Promise<PlatformPerson[]> {
  const search = options.search?.trim().toLowerCase() ?? "";
  const people = await all<{
    id: string;
    email: string;
    display_name: string;
    platform_admin: number;
    email_verified_at: string | null;
    created_at: string;
    disabled_at: string | null;
    discord_user_id: string | null;
    discord_username: string | null;
  }>(
    ctx.db,
    `SELECT u.id, u.email, u.display_name, u.platform_admin, u.email_verified_at, u.created_at, u.disabled_at,
            (SELECT d.discord_user_id FROM fb_discord_identities d WHERE d.user_id = u.id AND d.revoked_at IS NULL ORDER BY d.linked_at DESC LIMIT 1) AS discord_user_id,
            (SELECT d.username FROM fb_discord_identities d WHERE d.user_id = u.id AND d.revoked_at IS NULL ORDER BY d.linked_at DESC LIMIT 1) AS discord_username
       FROM fb_users u
      ORDER BY u.created_at`,
  );
  const roleRows = await all<{ id: string; user_id: string; role: string; scopes_json: string; status: string; granted_at: string; reason: string }>(
    ctx.db,
    "SELECT id, user_id, role, scopes_json, status, granted_at, reason FROM fb_platform_role_assignments ORDER BY granted_at DESC",
  );
  const memberships = await all<{ user_id: string; tenant_id: string; tenant_name: string; tenant_slug: string; role: string; capabilities_json: string; status: string }>(
    ctx.db,
    `SELECT m.user_id, m.tenant_id, t.name AS tenant_name, t.slug AS tenant_slug, m.role, m.capabilities_json, m.status
       FROM fb_memberships m JOIN fb_tenants t ON t.id = m.tenant_id
      WHERE m.status = 'active' ORDER BY t.name`,
  );
  const botRoles = await all<{ user_id: string; bot_id: string; bot_name: string; role: string; capabilities_json: string; status: string }>(
    ctx.db,
    `SELECT ba.user_id, ba.bot_id, b.name AS bot_name, ba.role, ba.capabilities_json, ba.status
       FROM fb_bot_admins ba JOIN fb_bots b ON b.id = ba.bot_id
      WHERE ba.status = 'active' ORDER BY b.name`,
  );
  const invitations = await all<{ bot_name: string; email: string; status: string; expires_at: string; created_by: string }>(
    ctx.db,
    `SELECT b.name AS bot_name, i.email, i.status, i.expires_at, i.created_by
       FROM fb_bot_invitations i JOIN fb_bots b ON b.id = i.bot_id
      WHERE i.status = 'pending' ORDER BY i.created_at DESC`,
  );

  const parseCapabilities = (value: string): string[] => {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
    } catch {
      return [];
    }
  };

  const enriched = people.map((person) => ({
    ...person,
    platform_roles: roleRows
      .filter((row) => row.user_id === person.id)
      .map((row) => ({ role: row.role, scopes: parseScopes(row.scopes_json), status: row.status, granted_at: row.granted_at, reason: row.reason })),
    memberships: memberships
      .filter((row) => row.user_id === person.id)
      .map((row) => ({ tenant_id: row.tenant_id, tenant_name: row.tenant_name, tenant_slug: row.tenant_slug, role: row.role, capabilities: parseCapabilities(row.capabilities_json), status: row.status })),
    bot_roles: botRoles
      .filter((row) => row.user_id === person.id)
      .map((row) => ({ bot_id: row.bot_id, bot_name: row.bot_name, role: row.role, capabilities: parseCapabilities(row.capabilities_json), status: row.status })),
    pending_invitations: invitations.filter((row) => row.email.toLowerCase() === person.email.toLowerCase() && row.status === "pending"),
  }));

  return enriched.filter((person) => {
    if (search && ![person.display_name, person.email, person.discord_username ?? "", person.discord_user_id ?? ""].some((value) => value.toLowerCase().includes(search))) return false;
    if (options.role === "super_admin") return Boolean(person.platform_admin);
    if (options.role === "global_collection_admin") return person.platform_roles.some((role) => role.role === "global_collection_admin" && role.status === "active");
    if (options.role === "bot_admin") return person.bot_roles.length > 0 || person.memberships.some((membership) => membership.role !== "player");
    if (options.role === "user") return !person.platform_admin && person.platform_roles.length === 0 && person.bot_roles.length === 0 && !person.memberships.some((membership) => membership.role !== "player");
    return true;
  });
}

export async function assignPlatformRole(
  ctx: Ctx,
  input: { userId: string; role: ScopedPlatformRole; scopes?: { all?: boolean; collectionIds?: string[] }; reason: string },
): Promise<{ assignment: Record<string, unknown>; changed: boolean }> {
  if (!SCOPED_PLATFORM_ROLES.includes(input.role)) {
    throw new ApiError(422, "role_not_assignable", "That platform role cannot be granted through this API.");
  }
  const user = await first<{ id: string; display_name: string; email: string; disabled_at: string | null }>(
    ctx.db,
    "SELECT id, display_name, email, disabled_at FROM fb_users WHERE id = ?",
    input.userId,
  );
  if (!user) throw new ApiError(404, "account_not_found", "That Foilbury account does not exist.");
  if (user.disabled_at) throw new ApiError(403, "account_disabled", "Enable the account before assigning a role.");
  const verified = await first<{ email_verified: number; discord: number }>(
    ctx.db,
    `SELECT
       (SELECT COUNT(*) FROM fb_users WHERE id = ? AND email_verified_at IS NOT NULL) AS email_verified,
       (SELECT COUNT(*) FROM fb_discord_identities WHERE user_id = ? AND revoked_at IS NULL) AS discord`,
    input.userId,
    input.userId,
  );
  if (!verified?.email_verified && !verified?.discord) {
    throw new ApiError(422, "identity_unverified", "Link a verified email or Discord identity before assigning a scoped platform role.");
  }
  if (input.userId === ctx.user?.id && !ctx.user.platformAdmin) {
    throw new ApiError(403, "self_escalation", "You cannot grant yourself a platform role.");
  }
  const reason = input.reason.trim().slice(0, 500);
  if (reason.length < 3) throw new ApiError(422, "reason_required", "Record why this role is being granted.");

  const collectionIds = [...new Set(input.scopes?.collectionIds ?? [])].slice(0, 200);
  if (collectionIds.length) {
    const found = await all<{ id: string }>(ctx.db, `SELECT id FROM fb_collections WHERE scope = 'global' AND id IN (${collectionIds.map(() => "?").join(",")})`, ...collectionIds).catch(() => []);
    if (found.length !== collectionIds.length) throw new ApiError(422, "collection_scope_invalid", "One or more scoped collections do not exist.");
  }
  const scopes = collectionIds.length ? { all: false, collectionIds } : { all: true, collectionIds: [] };
  const scopesJson = JSON.stringify(scopes);

  const existing = await first<{ id: string; status: string; scopes_json: string }>(
    ctx.db,
    "SELECT id, status, scopes_json FROM fb_platform_role_assignments WHERE user_id = ? AND role = ?",
    input.userId,
    input.role,
  );
  if (existing?.status === "active" && existing.scopes_json === scopesJson) {
    return { assignment: { id: existing.id, user_id: input.userId, role: input.role, scopes, status: "active" }, changed: false };
  }
  const now = nowIso();
  if (existing) {
    await ctx.db
      .prepare(
        "UPDATE fb_platform_role_assignments SET scopes_json = ?, status = 'active', granted_by = ?, granted_at = ?, reason = ?, revoked_by = NULL, revoked_at = NULL WHERE id = ?",
      )
      .bind(scopesJson, ctx.user!.id, now, reason, existing.id)
      .run();
    await audit(ctx, "platform.role.assigned", "platform_role", existing.id, {
      user_id: input.userId, role: input.role, scopes, reason, reactivated: true,
    });
    return { assignment: { id: existing.id, user_id: input.userId, role: input.role, scopes, status: "active" }, changed: true };
  }
  const id = newId("role");
  await ctx.db
    .prepare(
      `INSERT INTO fb_platform_role_assignments
        (id, user_id, role, scopes_json, status, granted_by, granted_at, reason)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
    )
    .bind(id, input.userId, input.role, scopesJson, ctx.user!.id, now, reason)
    .run();
  await audit(ctx, "platform.role.assigned", "platform_role", id, { user_id: input.userId, role: input.role, scopes, reason });
  return { assignment: { id, user_id: input.userId, role: input.role, scopes, status: "active" }, changed: true };
}

export async function revokePlatformRole(ctx: Ctx, userId: string, role: ScopedPlatformRole, reason: string): Promise<{ changed: boolean }> {
  const reasonText = reason.trim().slice(0, 500);
  if (reasonText.length < 3) throw new ApiError(422, "reason_required", "Record why this role is being revoked.");
  const row = await first<{ id: string; status: string }>(
    ctx.db,
    "SELECT id, status FROM fb_platform_role_assignments WHERE user_id = ? AND role = ?",
    userId,
    role,
  );
  if (!row) throw new ApiError(404, "role_not_found", "That account does not hold this role.");
  if (row.status === "revoked") return { changed: false };
  const now = nowIso();
  await ctx.db
    .prepare("UPDATE fb_platform_role_assignments SET status = 'revoked', revoked_by = ?, revoked_at = ?, reason = ? WHERE id = ? AND status = 'active'")
    .bind(ctx.user!.id, now, reasonText, row.id)
    .run();
  await audit(ctx, "platform.role.revoked", "platform_role", row.id, { user_id: userId, role, reason: reasonText });
  return { changed: true };
}

export async function listPlatformRoleAssignments(ctx: Ctx): Promise<Array<Record<string, unknown>>> {
  return all<Record<string, unknown>>(
    ctx.db,
    `SELECT a.id, a.user_id, u.display_name, u.email, a.role, a.scopes_json, a.status, a.granted_at, a.reason,
            g.display_name AS granted_by_name, a.revoked_at
       FROM fb_platform_role_assignments a
       JOIN fb_users u ON u.id = a.user_id
       LEFT JOIN fb_users g ON g.id = a.granted_by
      ORDER BY a.granted_at DESC`,
  );
}
