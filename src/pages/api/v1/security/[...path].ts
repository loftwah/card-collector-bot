import type { APIRoute } from "astro";
import { z } from "zod";
import {
  ApiError,
  assertCsrf,
  requireUser,
  roleLabel,
  type Ctx,
} from "../../../../server/context";
import { buildContext } from "../../../../server/context";
import { apiErrorResponse, json, readJson } from "../../../../server/http";
import {
  listSessions,
  revokeOtherSessions,
  revokeSessionById,
  upgradeSessionAssurance,
} from "../../../../server/modules/identity";
import { deletePasskey, listPasskeys } from "../../../../server/modules/passkeys";
import {
  confirmTotpSetup,
  consumeRecoveryCode,
  issueRecoveryCodes,
  recoveryCodeCount,
  removeTotp,
  startTotpSetup,
  verifyUserTotp,
} from "../../../../server/modules/totp";
import { first } from "../../../../server/db";

export const prerender = false;

async function overview(ctx: Ctx) {
  const user = requireUser(ctx);
  const [passkeys, sessions, totp, recoveryCodes, access] = await Promise.all([
    listPasskeys(ctx.db, user.id),
    listSessions(ctx.db, user.id, ctx.sessionId),
    first<{ confirmed_at: string | null }>(ctx.db, "SELECT confirmed_at FROM fb_totp_secrets WHERE user_id = ?", user.id),
    recoveryCodeCount(ctx.db, user.id),
    first<{ email: string; linked_at: string }>(
      ctx.db,
      "SELECT email, linked_at FROM fb_access_identities WHERE user_id = ? AND revoked_at IS NULL ORDER BY linked_at DESC LIMIT 1",
      user.id,
    ),
  ]);
  return {
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      role_label: roleLabel(user),
      platform_admin: user.platformAdmin,
      email_verified: Boolean(user.emailVerified),
    },
    assurance: ctx.sessionAssurance,
    passkeys,
    totp: { configured: Boolean(totp?.confirmed_at) },
    recovery_codes_remaining: recoveryCodes,
    access: access ? { linked: true, email: access.email, linked_at: access.linked_at } : { linked: false },
    sessions,
  };
}

export const ALL: APIRoute = async ({ request, params }) => {
  const path = params.path ?? "";
  const method = request.method.toUpperCase();
  try {
    const ctx = await buildContext(request);
    if (method !== "GET" && method !== "HEAD") assertCsrf(ctx, request);
    if (path === "overview" && method === "GET") return json(await overview(ctx));

    if (path === "totp/start" && method === "POST") {
      const user = requireUser(ctx);
      const result = await startTotpSetup(ctx);
      return json({ ...result, user: user.id });
    }
    if (path === "totp/confirm" && method === "POST") {
      const input = await readJson(request, z.object({ code: z.string().min(6).max(8) }));
      const result = await confirmTotpSetup(ctx, input.code);
      if (ctx.sessionId) await upgradeSessionAssurance(ctx.db, ctx.sessionId, "mfa");
      return json({ ok: true, recovery_codes: result.recoveryCodes });
    }
    if (path === "totp/verify" && method === "POST") {
      const user = requireUser(ctx);
      const input = await readJson(request, z.object({ code: z.string().min(6).max(12) }));
      if (!(await verifyUserTotp(ctx, user.id, input.code))) {
        throw new ApiError(401, "totp_code_invalid", "That authenticator code is not valid.");
      }
      if (ctx.sessionId) await upgradeSessionAssurance(ctx.db, ctx.sessionId, "mfa");
      return json({ ok: true, assurance: "mfa" });
    }
    if (path === "totp/remove" && method === "POST") {
      const user = requireUser(ctx);
      const input = await readJson(request, z.object({ code: z.string().min(6).max(12) }).optional());
      if (!input || !(await verifyUserTotp(ctx, user.id, input.code))) {
        throw new ApiError(403, "strong_auth_required", "Confirm with your authenticator before removing it.");
      }
      await removeTotp(ctx);
      return json({ ok: true });
    }
    if (path === "recovery-codes/regenerate" && method === "POST") {
      const user = requireUser(ctx);
      const input = await readJson(request, z.object({ code: z.string().min(6).max(12) }));
      if (!(await verifyUserTotp(ctx, user.id, input.code))) {
        throw new ApiError(403, "totp_code_invalid", "Confirm with your authenticator first.");
      }
      return json({ ok: true, recovery_codes: await issueRecoveryCodes(ctx.db, user.id) });
    }
    if (path === "recovery/consume" && method === "POST") {
      const user = requireUser(ctx);
      const input = await readJson(request, z.object({ code: z.string().min(4).max(32) }));
      if (!(await consumeRecoveryCode(ctx, user.id, input.code))) {
        throw new ApiError(401, "recovery_code_invalid", "That recovery code is not valid or has been used.");
      }
      if (ctx.sessionId) await upgradeSessionAssurance(ctx.db, ctx.sessionId, "mfa");
      return json({ ok: true });
    }
    if (path === "sessions/revoke-others" && method === "POST") {
      const user = requireUser(ctx);
      if (!ctx.sessionId) throw new ApiError(403, "session_required", "Sign in again to manage sessions.");
      await revokeOtherSessions(ctx.db, user.id, ctx.sessionId);
      return json({ ok: true });
    }
    const sessionMatch = path.match(/^sessions\/([^/]+)\/revoke$/);
    if (sessionMatch && method === "POST") {
      const user = requireUser(ctx);
      const revoked = await revokeSessionById(ctx.db, user.id, sessionMatch[1]!);
      if (!revoked) throw new ApiError(404, "session_not_found", "That session is not available.");
      return json({ ok: true });
    }
    const passkeyMatch = path.match(/^passkeys\/([^/]+)\/delete$/);
    if (passkeyMatch && method === "POST") {
      const user = requireUser(ctx);
      await deletePasskey(ctx.db, user.id, passkeyMatch[1]!);
      return json({ ok: true });
    }
    throw new ApiError(404, "not_found", "No matching security action.");
  } catch (error) {
    return apiErrorResponse(error, request.headers.get("cf-ray") ?? crypto.randomUUID());
  }
};

export const GET = ALL;
export const POST = ALL;
