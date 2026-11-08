import { ApiError, hasCapability, requireRecentStrongAuth, type Ctx } from "../context";
import { all, first, nowIso } from "../db";
import { newId } from "../ids";
import { auditStatement } from "../http";
import { addPlayerMembershipIfAbsent, ensureWallet } from "./identity";
import { assertTransition } from "../state";

export interface MembershipView {
  tenant_id: string;
  tenant_slug: string;
  tenant_name: string;
  role: string;
  status: string;
  capabilities: string[];
  joined_at: string;
  revoked_at: string | null;
}

export async function getMyMemberships(ctx: Ctx): Promise<MembershipView[]> {
  const user = ctx.user;
  if (!user) throw new ApiError(401, "authentication_required", "Sign in to see your memberships.");
  const rows = await all<{
    tenant_id: string;
    tenant_slug: string;
    tenant_name: string;
    role: string;
    status: string;
    capabilities_json: string;
    created_at: string;
    revoked_at: string | null;
  }>(
    ctx.db,
    `SELECT m.tenant_id, t.slug AS tenant_slug, t.name AS tenant_name, m.role, m.status,
            m.capabilities_json, m.created_at, m.revoked_at
       FROM fb_memberships m JOIN fb_tenants t ON t.id = m.tenant_id
      WHERE m.user_id = ? ORDER BY m.status = 'active' DESC, t.name`,
    user.id,
  );
  return rows.map((row) => ({
    tenant_id: row.tenant_id,
    tenant_slug: row.tenant_slug,
    tenant_name: row.tenant_name,
    role: row.role,
    status: row.status,
    capabilities: safeCapabilities(row.capabilities_json),
    joined_at: row.created_at,
    revoked_at: row.revoked_at,
  }));
}

/**
 * Re-read the live membership for a domain command. A session is a credential,
 * not a permanent entitlement: a profile, trade or share mutation must fail if
 * the membership was suspended or revoked after sign-in.
 */
export async function requireActiveMembership(ctx: Ctx): Promise<void> {
  const user = ctx.user;
  if (!user) throw new ApiError(401, "authentication_required", "Sign in to continue.");
  const row = await first<{ status: string; revoked_at: string | null; disabled_at: string | null }>(
    ctx.db,
    `SELECT m.status, m.revoked_at, u.disabled_at
       FROM fb_memberships m JOIN fb_users u ON u.id = m.user_id
      WHERE m.tenant_id = ? AND m.user_id = ?`,
    ctx.tenant.id,
    user.id,
  );
  if (!row || row.status !== "active" || row.revoked_at || row.disabled_at) {
    throw new ApiError(403, "membership_inactive", "This album membership is not active. Ask an administrator for access.");
  }
}

export async function joinMainAlbum(ctx: Ctx): Promise<{ joined: boolean; membership: MembershipView }> {
  const user = ctx.user;
  if (!user) throw new ApiError(401, "authentication_required", "Sign in to join the album.");
  const existing = await first<{ status: string; role: string; revoked_at: string | null }>(
    ctx.db,
    "SELECT status, role, revoked_at FROM fb_memberships WHERE tenant_id = ? AND user_id = ?",
    ctx.tenant.id,
    user.id,
  );
  if (existing?.status === "active" && !existing.revoked_at) {
    await ensureWallet(ctx.db, ctx.tenant.id, user.id);
    const memberships = await getMyMemberships(ctx);
    return { joined: false, membership: memberships.find((item) => item.tenant_id === ctx.tenant.id)! };
  }
  if (existing) {
    throw new ApiError(
      403,
      "membership_inactive",
      "This album membership is suspended, revoked or still awaiting approval. An administrator must restore it deliberately; signing in cannot do so.",
    );
  }
  const joined = await addPlayerMembershipIfAbsent(ctx.db, ctx.tenant.id, user.id);
  const current = await first<{ status: string; revoked_at: string | null }>(ctx.db,
    "SELECT status, revoked_at FROM fb_memberships WHERE tenant_id = ? AND user_id = ?", ctx.tenant.id, user.id);
  if (!current || current.status !== "active" || current.revoked_at) {
    throw new ApiError(403, "membership_inactive", "This album membership is not active. Ask an administrator for access.");
  }
  await ensureWallet(ctx.db, ctx.tenant.id, user.id);
  if (joined) await recordMembershipEvent(ctx, ctx.tenant.id, user.id, "joined", "member", "Self-service membership from a verified account.");
  const memberships = await getMyMemberships(ctx);
  return { joined, membership: memberships.find((item) => item.tenant_id === ctx.tenant.id)! };
}

export async function listAlbumMembers(ctx: Ctx) {
  requireMemberAdmin(ctx);
  const rows = await all<{
    user_id: string;
    email: string;
    display_name: string;
    role: string;
    status: string;
    capabilities_json: string;
    created_at: string;
    last_seen_at: string | null;
    cards: number;
    balance: number;
  }>(
    ctx.db,
    `SELECT m.user_id, u.email, u.display_name, m.role, m.status, m.capabilities_json, m.created_at,
            (SELECT MAX(s.last_seen_at) FROM fb_sessions s WHERE s.user_id = u.id AND s.tenant_id = m.tenant_id) AS last_seen_at,
            (SELECT COUNT(*) FROM fb_card_instances ci WHERE ci.tenant_id = m.tenant_id AND ci.user_id = u.id AND ci.status IN ('owned','reserved')) AS cards,
            (SELECT COALESCE(balance, 0) FROM fb_wallets w WHERE w.tenant_id = m.tenant_id AND w.user_id = u.id) AS balance
       FROM fb_memberships m JOIN fb_users u ON u.id = m.user_id
      WHERE m.tenant_id = ? ORDER BY m.status = 'active' DESC, u.display_name`,
    ctx.tenant.id,
  );
  return rows.map((row) => ({
    user_id: row.user_id,
    email: row.email,
    display_name: row.display_name,
    role: row.role,
    status: row.status,
    capabilities: safeCapabilities(row.capabilities_json),
    joined_at: row.created_at,
    last_seen_at: row.last_seen_at,
    cards: row.cards,
    balance: row.balance,
  }));
}

export async function setMemberStatus(
  ctx: Ctx,
  userId: string,
  status: "active" | "suspended" | "revoked",
  reason: string,
) {
  requireMemberAdmin(ctx);
  requireRecentStrongAuth(ctx, 30);
  if (!reason.trim() || reason.trim().length < 3) throw new ApiError(422, "reason_required", "Record why access is changing.");
  if (userId === ctx.user?.id && status !== "active") {
    throw new ApiError(422, "self_lockout", "Use another administrator to change your own membership.");
  }
  const row = await first<{ role: string; status: string }>(
    ctx.db,
    "SELECT role, status FROM fb_memberships WHERE tenant_id = ? AND user_id = ?",
    ctx.tenant.id,
    userId,
  );
  if (!row) throw new ApiError(404, "member_not_found", "That account is not a member of this album.");
  if (row.role === "owner" && status !== "active") {
    throw new ApiError(422, "owner_protected", "The album owner keeps access. Transfer ownership first.");
  }
  assertTransition("membership", row.status, status);
  const now = nowIso();
  await ctx.db.batch([
    ctx.db
      .prepare(
        "UPDATE fb_memberships SET status = ?, revoked_at = ?, accepted_at = COALESCE(accepted_at, ?) WHERE tenant_id = ? AND user_id = ?",
      )
      .bind(status, status === "active" ? null : now, now, ctx.tenant.id, userId),
    ...(status === "active"
      ? []
      : [
          ctx.db
            .prepare("UPDATE fb_sessions SET revoked_at = ?, revoked_reason = ? WHERE tenant_id = ? AND user_id = ? AND revoked_at IS NULL")
            .bind(now, `membership_${status}`, ctx.tenant.id, userId),
        ]),
    auditStatement(ctx, `membership.${status}`, "membership", userId, { reason: reason.trim() }),
  ]);
  await recordMembershipEvent(ctx, ctx.tenant.id, userId, status === "active" ? "restored" : status, "admin", reason.trim());
  return { user_id: userId, status };
}

async function recordMembershipEvent(
  ctx: Ctx,
  tenantId: string,
  userId: string,
  event: "joined" | "approved" | "suspended" | "revoked" | "restored" | "role_changed",
  actorType: string,
  reason: string,
) {
  await ctx.db
    .prepare(
      `INSERT INTO fb_membership_events (id, tenant_id, user_id, event, actor_type, actor_id, reason, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?)`,
    )
    .bind(newId("mev"), tenantId, userId, event, actorType, ctx.user?.id ?? null, reason, nowIso())
    .run();
}

function requireMemberAdmin(ctx: Ctx) {
  const user = ctx.user;
  if (!user) throw new ApiError(401, "authentication_required", "Sign in to manage members.");
  // Coarse legacy roles are not enough: the capability set is the authority.
  // An economy administrator without `members` must not rewrite membership
  // state, and an agent never gains a human-only lifecycle decision.
  if (ctx.actor.type === "agent") {
    throw new ApiError(403, "human_admin_required", "Agent grants cannot change album membership.");
  }
  if (!user.platformAdmin && !hasCapability(user, "members")) {
    throw new ApiError(403, "insufficient_capability", "Your role does not include member management.");
  }
}

function safeCapabilities(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
