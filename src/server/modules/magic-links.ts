import type { D1Database } from "@cloudflare/workers-types";
import { ApiError, rateLimitEmailKey, requireRecentStrongAuth, requireUser, type Ctx, type CurrentUser } from "../context";
import { first, nowIso } from "../db";
import { newId, sha256Hex, token } from "../ids";
import { magicLinkEmail, sendEmail } from "../email";
import { addMembership, createEmailUser, createSession, findUserByEmail, markEmailVerified } from "./identity";
import { ensureWallet } from "./identity";

import { liveStrongHumanSession, strongHumanArgs } from "./strong-session";

const TTL_MINUTES = 15;

export interface MagicLinkRequestResult {
  ok: true;
  /** Local/test only. Never returned by the production API. */
  devToken?: string;
}

function safeRedirect(value: string | null | undefined): string {
  return value && value.startsWith("/") && !value.startsWith("//") ? value : "/play";
}

async function checkMagicLinkLimits(ctx: Ctx, email: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000), start = now - (now % 900);
  const client = `magic:client:${ctx.clientKey}`;
  const emailKey = await rateLimitEmailKey(ctx.config, "magic:email", email);
  const legacy = `magic:email:${await sha256Hex(email)}`;
  // The serialized batch admits each subsequent bucket only if the previous
  // limits still allow it. Denied clients never consume service capacity and
  // an exhausted service never allocates another client or address bucket.
  const results = await ctx.db.batch([
    ctx.db.prepare(`INSERT INTO fb_rate_limits(key,window_start,count)
      SELECT ?,?,1 WHERE NOT EXISTS (SELECT 1 FROM fb_rate_limits WHERE key='magic:service' AND window_start=? AND count>=120)
      ON CONFLICT(key) DO UPDATE SET count=CASE WHEN window_start<? THEN 1 ELSE count+1 END,
        window_start=CASE WHEN window_start<? THEN ? ELSE window_start END RETURNING count,window_start`)
      .bind(client,start,start,start,start,start),
    ctx.db.prepare(`INSERT INTO fb_rate_limits(key,window_start,count)
      SELECT 'magic:service',?,1 WHERE EXISTS (SELECT 1 FROM fb_rate_limits WHERE key=? AND window_start=? AND count<=20)
      ON CONFLICT(key) DO UPDATE SET count=CASE WHEN window_start<? THEN 1 ELSE count+1 END,
        window_start=CASE WHEN window_start<? THEN ? ELSE window_start END
      WHERE window_start<? OR count<120 RETURNING count,window_start`)
      .bind(start,client,start,start,start,start,start),
    ctx.db.prepare(`INSERT INTO fb_rate_limits(key,window_start,count)
      SELECT ?,?,1+COALESCE((SELECT count FROM fb_rate_limits WHERE key=? AND window_start=?),0) WHERE changes()=1
      ON CONFLICT(key) DO UPDATE SET count=CASE WHEN window_start<? THEN excluded.count ELSE count+1 END,
        window_start=CASE WHEN window_start<? THEN ? ELSE window_start END RETURNING count,window_start`)
      .bind(emailKey,start,legacy,start,start,start,start),
  ]);
  const row = (index: number) => (results[index]?.results?.[0] ?? null) as { count: number; window_start: number } | null;
  const clientRow = row(0), serviceRow = row(1), emailRow = row(2);
  if (!clientRow || clientRow.count > 20 || !serviceRow || !emailRow || emailRow.count > 5) {
    const end = (clientRow && clientRow.count > 20 ? clientRow.window_start : emailRow && emailRow.count > 5 ? emailRow.window_start : start) + 900;
    throw new ApiError(429, "rate_limited", "Too many attempts. Try again shortly.", { retryAfterSeconds: Math.max(1, Math.min(900, end - now)) });
  }
}

export async function requestMagicLink(
  ctx: Ctx,
  input: { email: string; purpose: "signin" | "verify_email" | "link_email"; redirectPath?: string | null; userId?: string | null },
): Promise<MagicLinkRequestResult> {
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(422, "email_invalid", "Enter a valid email address.");
  // Layered abuse limits. The per-address and service ceilings bound delivery
  // and cost; the per-client bucket comes from a trusted, privacy-preserving
  // network identity, never from the request correlation ID.
  await checkMagicLinkLimits(ctx, email);

  const account = await findUserByEmail(ctx.db, email);
  // Synthetic game actors have no mailbox and no human sign-in path.
  if (account?.disabled_at || account?.is_synthetic) return { ok: true };

  const raw = token("fbm");
  const id = newId("ml");
  const now = nowIso();
  const expiresAt = new Date(Date.now() + TTL_MINUTES * 60_000).toISOString();
  await ctx.db
    .prepare(
      `INSERT INTO fb_magic_links
        (id, user_id, email, purpose, token_hash, redirect_path, created_at, expires_at, request_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.purpose === "signin" ? account?.id ?? null : input.userId ?? account?.id ?? null,
      email,
      input.purpose,
      await sha256Hex(raw),
      safeRedirect(input.redirectPath),
      now,
      expiresAt,
      ctx.requestId,
    )
    .run();

  const link = `${ctx.config.publicOrigin}/auth/email/verify?token=${encodeURIComponent(raw)}`;
  const mail = magicLinkEmail({
    displayName: account?.display_name ?? email.split("@")[0] ?? "Collector",
    link,
    expiresMinutes: TTL_MINUTES,
    purpose: input.purpose,
  });
  const delivered = await sendEmail(ctx.config, {
    to: email,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
    idempotencyKey: `magic-${id}`,
  });
  if (!delivered.ok && ctx.config.providers.resend && ctx.config.environment === "production") {
    await ctx.db
      .prepare("UPDATE fb_magic_links SET used_at = ? WHERE id = ?")
      .bind(nowIso(), id)
      .run()
      .catch(() => undefined);
    throw new ApiError(503, "email_delivery_failed", "The sign-in email could not be sent. Try again shortly.");
  }
  await ctx.db
    .prepare(
      `INSERT INTO fb_audit_events
        (id, tenant_id, actor_type, actor_id, represented_user_id, action, object_type, object_id, metadata_json, request_id, created_at)
       VALUES (?, ?, 'system', 'magic-link', ?, 'auth.magic_link.requested', 'email', ?, ?, ?, ?)`,
    )
    .bind(
      newId("aud"),
      ctx.tenant.id,
      account?.id ?? null,
      await sha256Hex(email),
      JSON.stringify({ purpose: input.purpose, delivered: delivered.ok, provider: delivered.ok ? "resend" : "local_outbox" }),
      ctx.requestId,
      now,
    )
    .run()
    .catch(() => undefined);

  return {
    ok: true,
    ...(ctx.config.environment === "local" || ctx.config.environment === "test" ? { devToken: raw } : {}),
  };
}

export async function findMagicLink(ctx: Ctx, rawToken: string) {
  const tokenHash = await sha256Hex(rawToken);
  return first<{
    id: string;
    user_id: string | null;
    email: string;
    purpose: "signin" | "verify_email" | "link_email";
    redirect_path: string | null;
    expires_at: string;
    used_at: string | null;
  }>(
    ctx.db,
    `SELECT id, user_id, email, purpose, redirect_path, expires_at, used_at
       FROM fb_magic_links WHERE token_hash = ?`,
    tokenHash,
  );
}

/**
 * Confirm a signed-in account's new email from a one-use link.
 *
 * The link proves control of the new mailbox. The current strong session proves
 * the person changing the account, and a matching row.user_id prevents a link
 * from being used against another account. We never merge accounts by matching
 * an email string.
 */
export async function confirmEmailChange(ctx: Ctx, rawToken: string): Promise<{ email: string }> {
  const user = requireUser(ctx);
  requireRecentStrongAuth(ctx, 30);
  const tokenHash = await sha256Hex(rawToken);
  const row = await first<{
    id: string;
    user_id: string | null;
    email: string;
    purpose: "signin" | "verify_email" | "link_email";
    expires_at: string;
    used_at: string | null;
  }>(
    ctx.db,
    "SELECT id, user_id, email, purpose, expires_at, used_at FROM fb_magic_links WHERE token_hash = ?",
    tokenHash,
  );
  if (!row || row.used_at || new Date(row.expires_at) <= new Date()) {
    throw new ApiError(401, "email_link_invalid", "This email confirmation link is invalid or has expired. Request a new one.");
  }
  if (row.purpose !== "link_email" || !row.user_id || row.user_id !== user.id) {
    throw new ApiError(403, "email_link_mismatch", "This email link was not issued for the signed-in account.");
  }
  const existing = await findUserByEmail(ctx.db, row.email);
  if (existing && existing.id !== user.id) {
    throw new ApiError(409, "email_in_use", "That email is already attached to another Foilbury account. Nothing was changed.");
  }
  const now = nowIso();
  const sessionArgs = strongHumanArgs(ctx);
  try {
    await ctx.db.batch([
      ctx.db.prepare(`SELECT CASE WHEN ${liveStrongHumanSession} AND EXISTS (
        SELECT 1 FROM fb_magic_links l WHERE l.id=? AND l.user_id=? AND l.token_hash=? AND l.email COLLATE BINARY IS ? AND l.purpose='link_email' AND l.used_at IS NULL AND l.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
      ) AND EXISTS (SELECT 1 FROM fb_users WHERE id=? AND email COLLATE BINARY IS ? AND disabled_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM fb_users WHERE email=? COLLATE NOCASE AND id<>?) THEN 1 ELSE json('email_change_guard') END`)
        .bind(...sessionArgs,row.id,user.id,tokenHash,row.email,user.id,user.email,row.email,user.id),
      ctx.db.prepare("UPDATE fb_magic_links SET used_at=? WHERE id=? AND used_at IS NULL").bind(now,row.id),
      ctx.db.prepare("UPDATE fb_users SET email=?,email_verified_at=? WHERE id=? AND disabled_at IS NULL").bind(row.email,now,user.id),
      ctx.db.prepare(`INSERT INTO fb_audit_events
        (id,tenant_id,actor_type,actor_id,represented_user_id,action,object_type,object_id,metadata_json,request_id,created_at)
        VALUES (?,?,'user',?,?,'identity.email.verified','user',?,?,?,?)`)
        .bind(newId('aud'),ctx.tenant.id,user.id,user.id,user.id,JSON.stringify({previous_email:user.email}),ctx.requestId,now),
    ]);
  } catch (error) {
    if (String(error).includes('malformed JSON')) throw new ApiError(409,'email_change_changed','The link or your session changed. Sign in again and request a fresh link if needed.');
    throw error;
  }
  return { email: row.email };
}

export async function redeemMagicLink(
  ctx: Ctx,
  rawToken: string,
  options?: { userAgent?: string | null; ipHash?: string | null },
): Promise<{ token: string; csrf: string; expiresAt: string; redirectPath: string; user: { id: string; email: string; displayName: string } }> {
  const tokenHash = await sha256Hex(rawToken);
  const now = nowIso();
  const row = await first<{
    id: string;
    user_id: string | null;
    email: string;
    purpose: "signin" | "verify_email" | "link_email";
    redirect_path: string | null;
    expires_at: string;
    used_at: string | null;
  }>(
    ctx.db,
    `SELECT id, user_id, email, purpose, redirect_path, expires_at, used_at
       FROM fb_magic_links WHERE token_hash = ?`,
    tokenHash,
  );
  if (!row || row.used_at || new Date(row.expires_at) <= new Date()) {
    throw new ApiError(401, "magic_link_invalid", "This sign-in link is invalid or has expired. Request a new one.");
  }
  const consumed = await ctx.db
    .prepare("UPDATE fb_magic_links SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?")
    .bind(now, row.id, now)
    .run();
  if ((consumed.meta?.changes ?? 0) !== 1) {
    throw new ApiError(401, "magic_link_invalid", "This sign-in link has already been used. Request a new one.");
  }

  const account = await findUserByEmail(ctx.db, row.email);
  if (account?.disabled_at) throw new ApiError(403, "account_disabled", "This account is disabled.");
  if (account?.is_synthetic) throw new ApiError(403, "account_disabled", "Synthetic collectors cannot sign in.");
  const user = account
    ? { id: account.id, email: account.email, displayName: account.display_name }
    : await createEmailUser(ctx.db, { email: row.email });
  await markEmailVerified(ctx.db, user.id);

  // Authentication is not admission. Read the membership in EVERY state before
  // deciding anything: an inactive row means a human administrator changed the
  // relationship, so a new email token must never recreate it as active.
  const membership = await first<{ status: string; revoked_at: string | null }>(
    ctx.db,
    "SELECT status, revoked_at FROM fb_memberships WHERE user_id = ? AND tenant_id = ?",
    user.id,
    ctx.tenant.id,
  );
  if (membership && (membership.status !== "active" || membership.revoked_at)) {
    throw new ApiError(
      403,
      "membership_inactive",
      membership.status === "invited"
        ? "This album invitation has not been accepted by an administrator. Nothing was changed."
        : "This album membership is suspended or revoked. Ask an administrator to restore it deliberately. Nothing was changed.",
    );
  }
  if (!membership) {
    // Approved admission for this installation: a brand-new verified-email
    // account explicitly joins the public album. Deferred registration here is
    // indistinguishable from the explicit /me/join path and never restores an
    // existing row.
    if (!await addMembership(ctx.db, ctx.tenant.id, user.id, "player", { acceptedAt: now, insertOnly: true }))
      throw new ApiError(409, "membership_changed", "Membership changed while signing in. Request a new sign-in link or ask an administrator for help.");
    await ensureWallet(ctx.db, ctx.tenant.id, user.id);
  }

  const sessionUser: CurrentUser = {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: "player",
    platformAdmin: false,
    emailVerified: true,
    capabilities: [],
  };
  const role = await first<{ role: "owner" | "editor" | "economy_admin" | "player"; capabilities_json: string; platform_admin: number }>(
    ctx.db,
    `SELECT m.role, m.capabilities_json, u.platform_admin
       FROM fb_memberships m JOIN fb_users u ON u.id = m.user_id
      WHERE m.user_id = ? AND m.tenant_id = ? AND m.status = 'active'`,
    user.id,
    ctx.tenant.id,
  );
  if (role) {
    sessionUser.role = role.role;
    sessionUser.platformAdmin = Boolean(role.platform_admin);
    try {
      const capabilities = JSON.parse(role.capabilities_json) as unknown;
      if (Array.isArray(capabilities)) sessionUser.capabilities = capabilities.filter((item): item is string => typeof item === "string");
    } catch {
      sessionUser.capabilities = [];
    }
  }
  const session = await createSession(ctx.db, ctx.tenant, sessionUser, {
    authMethod: "magic_link",
    assurance: "email",
    userAgent: options?.userAgent,
    ipHash: options?.ipHash,
  });
  await ctx.db
    .prepare(
      `INSERT INTO fb_audit_events
        (id, tenant_id, actor_type, actor_id, represented_user_id, action, object_type, object_id, metadata_json, request_id, created_at)
       VALUES (?, ?, 'user', ?, ?, 'auth.magic_link.redeemed', 'user', ?, ?, ?, ?)`,
    )
    .bind(
      newId("aud"),
      ctx.tenant.id,
      user.id,
      user.id,
      user.id,
      JSON.stringify({ purpose: row.purpose }),
      ctx.requestId,
      now,
    )
    .run()
    .catch(() => undefined);
  return {
    token: session.token,
    csrf: session.csrf,
    expiresAt: session.expiresAt,
    redirectPath: safeRedirect(row.redirect_path),
    user,
  };
}

export async function pruneMagicLinks(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM fb_magic_links WHERE expires_at < ? OR used_at < ?").bind(nowIso(), new Date(Date.now() - 86400_000).toISOString()).run();
}

/**
 * Rate-limit rows are one row per keyed bucket. Expired windows are removed on
 * the existing cron so long-lived deployments do not accumulate per-address
 * keys indefinitely. No raw address is stored: only keyed HMAC buckets. */
export async function pruneRateLimits(db: D1Database): Promise<void> {
  const cutoff = Math.floor(Date.now() / 1000) - 86400;
  await db.prepare("DELETE FROM fb_rate_limits WHERE window_start < ?").bind(cutoff).run();
}

