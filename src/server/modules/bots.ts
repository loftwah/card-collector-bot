import type { D1Database } from "@cloudflare/workers-types";
import { ApiError, hasCapability, requireProtectedAccount, requireUser, type Ctx, type Role } from "../context";
import { all, first, nowIso } from "../db";
import { newId, sha256Hex, token } from "../ids";
import { addMembership, ensureWallet, seedIdentityTaxonomy } from "./identity";
import { creditWallet } from "./wallet";
import { sendEmail } from "../email";

export const BOT_CAPABILITIES = ["content", "publish", "economy", "members", "settings", "inventory", "grants"] as const;
export type BotCapability = (typeof BOT_CAPABILITIES)[number];

export interface BotRow {
  id: string;
  tenant_id: string;
  owner_user_id: string;
  slug: string;
  name: string;
  description: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface BotSummary extends BotRow {
  tenant_slug: string;
  owner_name: string;
  role: Role;
  role_label: string;
  capabilities: string[];
  member_count: number;
  card_count: number;
}

function normalizeSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function validateCapabilities(input: string[]): BotCapability[] {
  const unique = [...new Set(input)];
  const invalid = unique.filter((item) => !BOT_CAPABILITIES.includes(item as BotCapability));
  if (invalid.length) throw new ApiError(422, "capability_invalid", `Unknown Bot capability: ${invalid.join(", ")}.`);
  if (!unique.length) throw new ApiError(422, "capability_required", "Choose at least one Bot capability.");
  return unique as BotCapability[];
}

export function botRoleLabel(role: Role, capabilities: string[] = []): string {
  if (role === "owner") return "Bot Owner";
  if (role === "editor" || role === "economy_admin" || capabilities.length > 0) return "Bot Admin";
  return "User";
}

export async function listBotsForUser(db: D1Database, userId: string): Promise<BotSummary[]> {
  const rows = await all<BotSummary & { capabilities_json: string; member_count: number; card_count: number }>(
    db,
    `SELECT b.*, t.slug AS tenant_slug, u.display_name AS owner_name, m.role,
            m.capabilities_json,
            (SELECT COUNT(*) FROM fb_memberships mm WHERE mm.tenant_id = b.tenant_id AND mm.status = 'active') AS member_count,
            (SELECT COUNT(*) FROM fb_card_definitions cd WHERE cd.tenant_id = b.tenant_id AND cd.archived_at IS NULL) AS card_count
       FROM fb_bots b
       JOIN fb_tenants t ON t.id = b.tenant_id
       JOIN fb_users u ON u.id = b.owner_user_id
       JOIN fb_memberships m ON m.tenant_id = b.tenant_id AND m.user_id = ? AND m.status = 'active'
      WHERE b.status <> 'archived'
      ORDER BY b.created_at`,
    userId,
  );
  return rows.map((row) => {
    let capabilities: string[] = [];
    try {
      const parsed = JSON.parse(row.capabilities_json ?? "[]") as unknown;
      if (Array.isArray(parsed)) capabilities = parsed.filter((item): item is string => typeof item === "string");
    } catch {
      capabilities = [];
    }
    return { ...row, capabilities, role_label: botRoleLabel(row.role, capabilities) };
  });
}

export async function botForTenant(db: D1Database, tenantId: string): Promise<BotRow | null> {
  return first<BotRow>(db, "SELECT * FROM fb_bots WHERE tenant_id = ? AND status <> 'archived'", tenantId);
}

export async function createBot(
  ctx: Ctx,
  input: { name: string; slug?: string; description?: string },
): Promise<{ bot: BotRow; tenant: { id: string; slug: string; name: string }; created: boolean }> {
  const user = await requireProtectedAccount(ctx);
  const name = input.name.trim().slice(0, 80);
  if (name.length < 2) throw new ApiError(422, "bot_name_invalid", "Give the Bot a name of at least two characters.");
  const slug = normalizeSlug(input.slug || name);
  if (slug.length < 2) throw new ApiError(422, "bot_slug_invalid", "Choose a URL-friendly Bot slug.");

  const existing = await first<BotRow & { tenant_slug: string }>(
    ctx.db,
    `SELECT b.*, t.slug AS tenant_slug FROM fb_bots b JOIN fb_tenants t ON t.id = b.tenant_id
      WHERE b.owner_user_id = ? AND b.slug = ?`,
    user.id,
    slug,
  );
  if (existing) {
    return {
      bot: existing,
      tenant: { id: existing.tenant_id, slug: existing.tenant_slug, name: existing.name },
      created: false,
    };
  }

  const tenantId = newId("ten");
  const tenantSlug = `bot-${slug}`;
  const botId = newId("bot");
  const now = nowIso();
  await ctx.db.batch([
    ctx.db
      .prepare(
        `INSERT INTO fb_tenants (id, slug, name, tagline, created_at, settings_json, community_policy_json, economy_json, publication_json)
         VALUES (?, ?, ?, ?, ?, ?, '{}', '{}', '{}')`,
      )
      .bind(tenantId, tenantSlug, name, input.description?.slice(0, 200) ?? null, now, JSON.stringify({ bot_id: botId })),
    ctx.db
      .prepare(
        `INSERT INTO fb_bots (id, tenant_id, owner_user_id, slug, name, description, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .bind(botId, tenantId, user.id, slug, name, input.description?.slice(0, 500) ?? null, now, now),
    ctx.db
      .prepare(
        `INSERT INTO fb_economy_settings
          (tenant_id, currency_name, currency_symbol, starter_grant, daily_reward, daily_cooldown_seconds, recycle_enabled, version, updated_at, updated_by)
         VALUES (?, 'Foil', '✦', 350, 120, 72000, 1, 1, ?, ?)`,
      )
      .bind(tenantId, now, user.id),
  ]);
  await seedIdentityTaxonomy(ctx.db, tenantId);
  await addMembership(ctx.db, tenantId, user.id, "owner");
  await ctx.db
    .prepare(
      `INSERT INTO fb_bot_admins (id, bot_id, user_id, role, capabilities_json, status, created_at, accepted_at)
       VALUES (?, ?, ?, 'owner', ?, 'active', ?, ?)`,
    )
    .bind(newId("badm"), botId, user.id, JSON.stringify([...BOT_CAPABILITIES]), now, now)
    .run();
  await ensureWallet(ctx.db, tenantId, user.id);
  await creditWallet(ctx.db, {
    tenantId,
    userId: user.id,
    amount: 350,
    kind: "issue",
    description: "Starter cabinet grant",
    idempotencyKey: `starter:${tenantId}:${user.id}`,
    referenceType: "starter_grant",
    metadata: { source: "bot_creation" },
    actorType: "user",
    actorId: user.id,
  });
  await ctx.db
    .prepare(
      `INSERT INTO fb_bot_collections (bot_id, collection_id, enabled, updated_by, updated_at)
       SELECT ?, c.id, 1, ?, ? FROM fb_collections c WHERE c.scope = 'global' AND c.status = 'published'`,
    )
    .bind(botId, user.id, now)
    .run();
  await ctx.db
    .prepare(
      `INSERT INTO fb_collections
        (id, slug, name, description, scope, owner_tenant_id, logo_url, accent, status, sort, created_by, created_at, updated_at)
       VALUES (?, 'first-cards', 'First cards', 'Your first Bot-owned collection. Add cards when you are ready.', 'bot', ?, '/art/collections/first-cards.svg', 'brass', 'draft', 0, ?, ?, ?)`,
    )
    .bind(newId("col"), tenantId, user.id, now, now)
    .run();
  await ctx.db
    .prepare(
      `INSERT INTO fb_audit_events
        (id, tenant_id, actor_type, actor_id, represented_user_id, action, object_type, object_id, metadata_json, request_id, created_at)
       VALUES (?, ?, 'user', ?, ?, 'bot.created', 'bot', ?, ?, ?, ?)`,
    )
    .bind(newId("aud"), tenantId, user.id, user.id, botId, JSON.stringify({ name, slug }), ctx.requestId, now)
    .run();
  // A creator's verified email is the explicit Access link allowlist for
  // their own administration. This does not grant a role; membership does.
  await ctx.db
    .prepare(
      `INSERT INTO fb_access_emails (email, user_id, added_by, created_at, revoked_at)
       VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT(email) DO UPDATE SET user_id = excluded.user_id, revoked_at = NULL`,
    )
    .bind(user.email.toLowerCase(), user.id, user.id, now)
    .run();
  return { bot: { id: botId, tenant_id: tenantId, owner_user_id: user.id, slug, name, description: input.description?.slice(0, 500) ?? null, status: "active", created_at: now, updated_at: now }, tenant: { id: tenantId, slug: tenantSlug, name }, created: true };
}

export async function createBotInvitation(
  ctx: Ctx,
  input: { botId: string; email: string; capabilities: string[]; expiresInDays?: number },
): Promise<{ id: string; expiresAt: string; devToken?: string }> {
  const user = requireUser(ctx);
  const bot = await first<BotRow>(ctx.db, "SELECT * FROM fb_bots WHERE id = ? AND tenant_id = ? AND status = 'active'", input.botId, ctx.tenant.id);
  if (!bot) throw new ApiError(404, "bot_not_found", "That Bot is not available in this administration area.");
  const admin = await first<{ role: string; capabilities_json: string }>(
    ctx.db,
    "SELECT role, capabilities_json FROM fb_memberships WHERE tenant_id = ? AND user_id = ? AND status = 'active'",
    bot.tenant_id,
    user.id,
  );
  if (!admin || (admin.role !== "owner" && !JSON.parse(admin.capabilities_json || "[]").includes("members"))) {
    throw new ApiError(403, "bot_members_required", "Only a Bot Owner or a Bot Admin with member capability can invite another admin.");
  }
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(422, "email_invalid", "Enter a valid email address.");
  if (email === user.email.toLowerCase()) throw new ApiError(422, "self_invite", "You already administer this Bot.");
  const existing = await first<{ user_id: string }>(
    ctx.db,
    `SELECT m.user_id FROM fb_memberships m JOIN fb_users u ON u.id = m.user_id
      WHERE m.tenant_id = ? AND u.email = ? AND m.status = 'active'`,
    bot.tenant_id,
    email,
  );
  if (existing) throw new ApiError(409, "already_a_member", "That person already has access to this Bot.");
  const capabilities = validateCapabilities(input.capabilities);
  const days = Math.min(Math.max(input.expiresInDays ?? 7, 1), 30);
  const raw = token("fbi");
  const id = newId("inv");
  const now = nowIso();
  const expiresAt = new Date(Date.now() + days * 86400_000).toISOString();
  await ctx.db
    .prepare(
      `INSERT INTO fb_bot_invitations
        (id, bot_id, email, role, capabilities_json, token_hash, status, created_by, created_at, expires_at)
       VALUES (?, ?, ?, 'admin', ?, ?, 'pending', ?, ?, ?)`,
    )
    .bind(id, bot.id, email, JSON.stringify(capabilities), await sha256Hex(raw), user.id, now, expiresAt)
    .run();
  const link = `${ctx.config.publicOrigin}/invite/${encodeURIComponent(raw)}`;
  const mail = invitationEmail({ botName: bot.name, inviter: user.displayName, link, days });
  const delivered = await sendEmail(ctx.config, {
    to: email,
    subject: `You are invited to administer ${bot.name} on Foilbury`,
    html: mail.html,
    text: mail.text,
    idempotencyKey: `invite-${id}`,
  });
  await ctx.db
    .prepare(
      `INSERT INTO fb_audit_events
        (id, tenant_id, actor_type, actor_id, represented_user_id, action, object_type, object_id, metadata_json, request_id, created_at)
       VALUES (?, ?, 'user', ?, ?, 'bot.invitation.created', 'bot', ?, ?, ?, ?)`,
    )
    .bind(newId("aud"), ctx.tenant.id, user.id, user.id, bot.id, JSON.stringify({ email_hash: await sha256Hex(email), capabilities, delivered: delivered.ok }), ctx.requestId, now)
    .run();
  return { id, expiresAt, ...(ctx.config.environment === "local" || ctx.config.environment === "test" ? { devToken: raw } : {}) };
}

export async function previewBotInvitation(ctx: Ctx, rawToken: string) {
  const tokenHash = await sha256Hex(rawToken);
  return first<{
    id: string;
    email: string;
    status: string;
    expires_at: string;
    capabilities_json: string;
    bot_id: string;
    bot_name: string;
    tenant_slug: string;
  }>(
    ctx.db,
    `SELECT i.id, i.email, i.status, i.expires_at, i.capabilities_json, i.bot_id,
            b.name AS bot_name, t.slug AS tenant_slug
       FROM fb_bot_invitations i JOIN fb_bots b ON b.id = i.bot_id JOIN fb_tenants t ON t.id = b.tenant_id
      WHERE i.token_hash = ?`,
    tokenHash,
  );
}

export async function acceptBotInvitation(ctx: Ctx, rawToken: string): Promise<{ bot: BotRow; capabilities: string[] }> {
  const user = await requireProtectedAccount(ctx);
  const tokenHash = await sha256Hex(rawToken);
  const invitation = await first<{
    id: string;
    bot_id: string;
    email: string;
    capabilities_json: string;
    status: string;
    expires_at: string;
    created_by: string;
  }>(ctx.db, "SELECT id, bot_id, email, capabilities_json, status, expires_at, created_by FROM fb_bot_invitations WHERE token_hash = ?", tokenHash);
  if (!invitation || invitation.status !== "pending" || new Date(invitation.expires_at) <= new Date()) {
    throw new ApiError(401, "invitation_invalid", "This invitation is expired, revoked or already used.");
  }
  if (invitation.email.toLowerCase() !== user.email.toLowerCase()) {
    throw new ApiError(403, "invitation_email_mismatch", "Sign in with the email address this invitation was sent to.");
  }
  const bot = await first<BotRow>(ctx.db, "SELECT * FROM fb_bots WHERE id = ? AND status = 'active'", invitation.bot_id);
  if (!bot) throw new ApiError(404, "bot_not_found", "That Bot is no longer available.");
  const capabilities = validateCapabilities(JSON.parse(invitation.capabilities_json) as string[]);
  const role: Role = capabilities.includes("content") || capabilities.includes("publish") ? "editor" : "economy_admin";
  const now = nowIso();
  await addMembership(ctx.db, bot.tenant_id, user.id, role, { capabilities, invitedBy: invitation.id, acceptedAt: now });
  await ctx.db
    .prepare(
      `INSERT INTO fb_bot_admins (id, bot_id, user_id, role, capabilities_json, status, invited_by, created_at, accepted_at)
       VALUES (?, ?, ?, 'admin', ?, 'active', ?, ?, ?)
       ON CONFLICT(bot_id, user_id) DO UPDATE SET role = 'admin', capabilities_json = excluded.capabilities_json, status = 'active', accepted_at = excluded.accepted_at, revoked_at = NULL`,
    )
    .bind(newId("badm"), bot.id, user.id, JSON.stringify(capabilities), invitation.created_by, now, now)
    .run();
  const accepted = await ctx.db
    .prepare("UPDATE fb_bot_invitations SET status = 'accepted', accepted_by = ?, accepted_at = ? WHERE id = ? AND status = 'pending'")
    .bind(user.id, now, invitation.id)
    .run();
  if ((accepted.meta?.changes ?? 0) !== 1) throw new ApiError(409, "invitation_already_used", "This invitation was already accepted.");
  await ctx.db
    .prepare(
      `INSERT INTO fb_access_emails (email, user_id, added_by, created_at, revoked_at)
       VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT(email) DO UPDATE SET user_id = excluded.user_id, revoked_at = NULL`,
    )
    .bind(user.email.toLowerCase(), user.id, invitation.created_by, now)
    .run();
  await ctx.db
    .prepare(
      `INSERT INTO fb_audit_events
        (id, tenant_id, actor_type, actor_id, represented_user_id, action, object_type, object_id, metadata_json, request_id, created_at)
       VALUES (?, ?, 'user', ?, ?, 'bot.invitation.accepted', 'bot', ?, ?, ?, ?)`,
    )
    .bind(newId("aud"), bot.tenant_id, user.id, user.id, bot.id, JSON.stringify({ capabilities }), ctx.requestId, now)
    .run();
  return { bot, capabilities };
}

export async function revokeBotAdmin(ctx: Ctx, botId: string, userId: string): Promise<void> {
  const user = requireUser(ctx);
  const bot = await first<BotRow>(ctx.db, "SELECT * FROM fb_bots WHERE id = ? AND tenant_id = ?", botId, ctx.tenant.id);
  if (!bot) throw new ApiError(404, "bot_not_found", "That Bot is not available.");
  const admin = await first<{ role: string }>(ctx.db, "SELECT role FROM fb_memberships WHERE tenant_id = ? AND user_id = ? AND status = 'active'", bot.tenant_id, user.id);
  if (!admin || admin.role !== "owner") throw new ApiError(403, "bot_owner_required", "Only the Bot Owner can revoke Bot Admin access.");
  if (userId === bot.owner_user_id) throw new ApiError(422, "owner_cannot_be_revoked", "The Bot Owner cannot revoke their own ownership.");
  const now = nowIso();
  await ctx.db.batch([
    ctx.db.prepare("UPDATE fb_memberships SET status = 'revoked', revoked_at = ? WHERE tenant_id = ? AND user_id = ?").bind(now, bot.tenant_id, userId),
    ctx.db.prepare("UPDATE fb_bot_admins SET status = 'revoked', revoked_at = ? WHERE bot_id = ? AND user_id = ?").bind(now, bot.id, userId),
    ctx.db
      .prepare(
        `INSERT INTO fb_audit_events
          (id, tenant_id, actor_type, actor_id, represented_user_id, action, object_type, object_id, metadata_json, request_id, created_at)
         VALUES (?, ?, 'user', ?, ?, 'bot.admin.revoked', 'bot', ?, ?, ?, ?)`,
      )
      .bind(newId("aud"), ctx.tenant.id, user.id, user.id, bot.id, JSON.stringify({ revoked_user_id: userId }), ctx.requestId, now),
  ]);
}

export async function listBotAdmins(ctx: Ctx, botId: string) {
  return all<{
    user_id: string;
    display_name: string;
    email: string;
    role: string;
    capabilities_json: string;
    status: string;
    created_at: string;
    accepted_at: string | null;
    self_grants_enabled: number;
    grant_limit: number;
    capability_revision: number;
  }>(
    ctx.db,
    `SELECT ba.user_id, u.display_name, u.email, ba.role, ba.capabilities_json, ba.status, ba.created_at, ba.accepted_at,
            COALESCE(m.self_grants_enabled, 0) AS self_grants_enabled,
            COALESCE(m.grant_limit, 500) AS grant_limit,
            COALESCE(m.capability_revision, 1) AS capability_revision
       FROM fb_bot_admins ba JOIN fb_users u ON u.id = ba.user_id
       JOIN fb_bots b ON b.id = ba.bot_id
       LEFT JOIN fb_memberships m ON m.tenant_id = b.tenant_id AND m.user_id = ba.user_id
      WHERE ba.bot_id = ? AND b.tenant_id = ? ORDER BY ba.role DESC, ba.created_at`,
    botId,
    ctx.tenant.id,
  );
}

export async function listBotInvitations(ctx: Ctx, botId: string) {
  return all<{ id: string; email: string; capabilities_json: string; status: string; created_at: string; expires_at: string; accepted_at: string | null }>(
    ctx.db,
    `SELECT i.id, i.email, i.capabilities_json, i.status, i.created_at, i.expires_at, i.accepted_at
       FROM fb_bot_invitations i JOIN fb_bots b ON b.id = i.bot_id
      WHERE i.bot_id = ? AND b.tenant_id = ? ORDER BY i.created_at DESC LIMIT 50`,
    botId,
    ctx.tenant.id,
  );
}

export async function switchBot(ctx: Ctx, botId: string) {
  const user = requireUser(ctx);
  const bot = await first<BotRow & { tenant_slug: string; tenant_name: string }>(
    ctx.db,
    `SELECT b.*, t.slug AS tenant_slug, t.name AS tenant_name
       FROM fb_bots b JOIN fb_tenants t ON t.id = b.tenant_id
       JOIN fb_memberships m ON m.tenant_id = b.tenant_id AND m.user_id = ? AND m.status = 'active'
      WHERE b.id = ? AND b.status = 'active'`,
    user.id,
    botId,
  );
  if (!bot) throw new ApiError(404, "bot_not_found", "That Bot is not available to your account.");
  return { tenant: { id: bot.tenant_id, slug: bot.tenant_slug, name: bot.tenant_name }, bot };
}

function invitationEmail(input: { botName: string; inviter: string; link: string; days: number }) {
  const html = `<!doctype html><html><body style="margin:0;background:#f4f0e6;color:#141512;font-family:ui-sans-serif,system-ui,sans-serif">
  <div style="max-width:560px;margin:0 auto;padding:40px 24px"><div style="border:1px solid #d6cdbc;background:#fffdf8;padding:36px">
  <p style="margin:0 0 8px;font-family:ui-monospace,monospace;font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#6e6657">Foilbury · Bot invitation</p>
  <h1 style="margin:0 0 16px;font-family:Georgia,serif;font-size:32px;line-height:1.05">A cabinet needs a second pair of hands.</h1>
  <p style="margin:0 0 12px;line-height:1.6">${escapeHtml(input.inviter)} invited you to administer <strong>${escapeHtml(input.botName)}</strong> on Foilbury. The invitation expires in ${input.days} days and binds to this email address.</p>
  <p style="margin:0 0 24px"><a href="${escapeHtml(input.link)}" style="display:inline-block;background:#245c4b;color:#fffdf8;padding:13px 20px;text-decoration:none;font-weight:600">Review the invitation</a></p>
  <p style="margin:0;color:#6e6657;font-size:12px;line-height:1.6">You will be asked to sign in and verify this email before any access is granted. If you were not expecting this, ignore it.</p>
  </div></div></body></html>`;
  return {
    html,
    text: `${input.inviter} invited you to administer ${input.botName} on Foilbury. Open ${input.link} within ${input.days} days. Sign in with this email address to accept.`,
  };
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
