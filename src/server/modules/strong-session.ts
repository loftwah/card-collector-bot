import { ApiError, type Ctx } from '../context';

/** SQL predicate for a currently active, recently stepped-up human session. */
export const liveStrongHumanSession = `EXISTS (SELECT 1 FROM fb_sessions s JOIN fb_users u ON u.id=s.user_id
 JOIN fb_memberships m ON m.user_id=u.id AND m.tenant_id=s.tenant_id
 WHERE s.id=? AND s.user_id=? AND s.tenant_id=? AND s.revoked_at IS NULL
 AND s.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND s.assurance=? AND s.assurance IN ('mfa','passkey')
 AND s.auth_time>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 minutes') AND s.auth_time<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 AND u.disabled_at IS NULL AND m.status='active' AND m.revoked_at IS NULL)`;
export function strongHumanArgs(ctx: Ctx) {
  if (!ctx.user || ctx.actor.type !== 'user' || ctx.actor.id !== ctx.user.id || ctx.actor.representedUserId !== ctx.user.id || !ctx.sessionId)
    throw new ApiError(403,'strong_auth_required','Sign in and confirm with a passkey or authenticator code.');
  return [ctx.sessionId,ctx.user.id,ctx.tenant.id,ctx.sessionAssurance];
}
