import type { D1Database } from "@cloudflare/workers-types";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { ApiError, type Ctx, type CurrentUser, type Tenant } from "../context";
import { all, first, nowIso } from "../db";
import { newId, sha256Hex } from "../ids";
import { createSession, upgradeSessionAssurance } from "./identity";
import type { Role } from "../config";

const CHALLENGE_TTL_MS = 5 * 60_000;

function rp(request: Request, configOrigin: string): { rpID: string; origin: string } {
  const origin = configOrigin || new URL(request.url).origin;
  return { rpID: new URL(origin).hostname, origin };
}

async function saveChallenge(db: D1Database, kind: "registration" | "authentication", challenge: string, userId: string | null): Promise<void> {
  await db
    .prepare(
      `INSERT INTO fb_auth_challenges (id, user_id, kind, challenge, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(newId("chl"), userId, kind, challenge, new Date(Date.now() + CHALLENGE_TTL_MS).toISOString(), nowIso())
    .run();
}

async function takeChallenge(db: D1Database, kind: "registration" | "authentication", challenge: string): Promise<{ id: string; user_id: string | null }> {
  const row = await first<{ id: string; user_id: string | null; expires_at: string; used_at: string | null }>(
    db,
    `SELECT id, user_id, expires_at, used_at FROM fb_auth_challenges
      WHERE kind = ? AND challenge = ? ORDER BY created_at DESC LIMIT 1`,
    kind,
    challenge,
  );
  if (!row || row.used_at || new Date(row.expires_at) <= new Date()) {
    throw new ApiError(401, "passkey_challenge_invalid", "That passkey prompt expired. Try again.");
  }
  const updated = await db
    .prepare("UPDATE fb_auth_challenges SET used_at = ? WHERE id = ? AND used_at IS NULL")
    .bind(nowIso(), row.id)
    .run();
  if ((updated.meta?.changes ?? 0) !== 1) throw new ApiError(401, "passkey_challenge_invalid", "That passkey prompt was already used.");
  return { id: row.id, user_id: row.user_id };
}

export async function registrationOptions(ctx: Ctx, request: Request) {
  if (!ctx.user) throw new ApiError(401, "authentication_required", "Sign in before adding a passkey.");
  const { rpID } = rp(request, ctx.config.publicOrigin);
  const existing = await all<{ credential_id: string; transports_json: string }>(
    ctx.db,
    "SELECT credential_id, transports_json FROM fb_webauthn_credentials WHERE user_id = ?",
    ctx.user.id,
  );
  const excludeCredentials = existing.map((credential) => ({
    id: credential.credential_id,
    transports: safeTransports(credential.transports_json),
  }));
  const options = await generateRegistrationOptions({
    rpName: "Foilbury",
    rpID,
    userName: ctx.user.email,
    userDisplayName: ctx.user.displayName,
    userID: new TextEncoder().encode(ctx.user.id.slice(0, 64)),
    attestationType: "none",
    excludeCredentials,
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
  });
  await saveChallenge(ctx.db, "registration", options.challenge, ctx.user.id);
  return options;
}

export async function registerPasskey(
  ctx: Ctx,
  request: Request,
  input: { response: RegistrationResponseJSON; name?: string },
) {
  if (!ctx.user) throw new ApiError(401, "authentication_required", "Sign in before adding a passkey.");
  const challenge = extractClientChallenge(input.response);
  const challengeRow = await takeChallenge(ctx.db, "registration", challenge);
  if (challengeRow.user_id !== ctx.user.id) throw new ApiError(403, "passkey_challenge_mismatch", "That passkey prompt belongs to another account.");
  const { rpID, origin } = rp(request, ctx.config.publicOrigin);
  const verified = await verifyRegistrationResponse({
    response: input.response,
    expectedChallenge: challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true,
  });
  if (!verified.verified || !verified.registrationInfo) {
    throw new ApiError(422, "passkey_verification_failed", "The passkey could not be verified.");
  }
  const credential = verified.registrationInfo.credential;
  const now = nowIso();
  await ctx.db
    .prepare(
      `INSERT INTO fb_webauthn_credentials
        (id, user_id, credential_id, public_key, counter, transports_json, device_type, backed_up, name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      newId("pk"),
      ctx.user.id,
      credential.id,
      isoBase64URL.fromBuffer(credential.publicKey),
      credential.counter,
      JSON.stringify(credential.transports ?? []),
      verified.registrationInfo.credentialDeviceType,
      verified.registrationInfo.credentialBackedUp ? 1 : 0,
      (input.name?.trim() || "Passkey").slice(0, 80),
      now,
    )
    .run();
  if (ctx.sessionId) await upgradeSessionAssurance(ctx.db, ctx.sessionId, "passkey");
  await ctx.db
    .prepare(
      `INSERT INTO fb_audit_events
        (id, tenant_id, actor_type, actor_id, represented_user_id, action, object_type, object_id, metadata_json, request_id, created_at)
       VALUES (?, ?, 'user', ?, ?, 'auth.passkey.registered', 'user', ?, '{}', ?, ?)`,
    )
    .bind(newId("aud"), ctx.tenant.id, ctx.user.id, ctx.user.id, ctx.user.id, ctx.requestId, now)
    .run()
    .catch(() => undefined);
  return { ok: true, name: input.name ?? "Passkey" };
}

export async function authenticationOptions(ctx: Ctx, request: Request, email?: string) {
  const { rpID } = rp(request, ctx.config.publicOrigin);
  let allowCredentials: { id: string; transports?: string[] }[] = [];
  let userId: string | null = null;
  if (email) {
    const row = await first<{ id: string }>(ctx.db, "SELECT id FROM fb_users WHERE email = ? AND disabled_at IS NULL AND is_synthetic = 0", email.trim().toLowerCase());
    if (row) {
      userId = row.id;
      const credentials = await all<{ credential_id: string; transports_json: string }>(
        ctx.db,
        "SELECT credential_id, transports_json FROM fb_webauthn_credentials WHERE user_id = ?",
        row.id,
      );
      allowCredentials = credentials.map((credential) => ({
        id: credential.credential_id,
        transports: safeTransports(credential.transports_json),
      }));
    }
  }
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: "preferred",
    allowCredentials,
  });
  await saveChallenge(ctx.db, "authentication", options.challenge, userId);
  return options;
}

export async function loginWithPasskey(
  ctx: Ctx,
  request: Request,
  input: { response: AuthenticationResponseJSON },
): Promise<{ token: string; csrf: string; expiresAt: string; tenant: Tenant; user: CurrentUser; redirectPath: string }> {
  const credentialId = input.response.id;
  const row = await first<{
    id: string;
    user_id: string;
    credential_id: string;
    public_key: string;
    counter: number;
    transports_json: string;
    email: string;
    display_name: string;
    platform_admin: number;
    email_verified_at: string | null;
    disabled_at: string | null;
    role: Role;
    capabilities_json: string;
    tenant_id: string;
    tenant_slug: string;
    tenant_name: string;
  }>(
    ctx.db,
    `SELECT c.id, c.user_id, c.credential_id, c.public_key, c.counter, c.transports_json,
            u.email, u.display_name, u.platform_admin, u.email_verified_at, u.disabled_at,
            m.role, m.capabilities_json, t.id AS tenant_id, t.slug AS tenant_slug, t.name AS tenant_name
       FROM fb_webauthn_credentials c
       JOIN fb_users u ON u.id = c.user_id
       JOIN fb_memberships m ON m.user_id = u.id AND m.tenant_id = ?
         AND m.status = 'active' AND m.revoked_at IS NULL
       JOIN fb_tenants t ON t.id = m.tenant_id
      WHERE c.credential_id = ?`,
    ctx.tenant.id,
    credentialId,
  );
  if (!row || row.disabled_at) throw new ApiError(401, "passkey_unknown", "That passkey is not registered for this Bot.");
  const challenge = extractClientChallenge(input.response);
  const challengeRow = await takeChallenge(ctx.db, "authentication", challenge);
  if (challengeRow.user_id && challengeRow.user_id !== row.user_id) {
    throw new ApiError(403, "passkey_challenge_mismatch", "That passkey prompt belongs to another account.");
  }
  const { rpID, origin } = rp(request, ctx.config.publicOrigin);
  const verified = await verifyAuthenticationResponse({
    response: input.response,
    expectedChallenge: challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true,
    credential: {
      id: row.credential_id,
      publicKey: isoBase64URL.toBuffer(row.public_key),
      counter: row.counter,
      transports: safeTransports(row.transports_json),
    },
  });
  if (!verified.verified) throw new ApiError(401, "passkey_verification_failed", "The passkey could not be verified.");
  await ctx.db
    .prepare("UPDATE fb_webauthn_credentials SET counter = ?, last_used_at = ? WHERE id = ?")
    .bind(verified.authenticationInfo.newCounter, nowIso(), row.id)
    .run();
  let capabilities: string[] = [];
  try {
    const parsed = JSON.parse(row.capabilities_json ?? "[]") as unknown;
    if (Array.isArray(parsed)) capabilities = parsed.filter((item): item is string => typeof item === "string");
  } catch {
    capabilities = [];
  }
  const tenant = { id: row.tenant_id, slug: row.tenant_slug, name: row.tenant_name };
  const user: CurrentUser = {
    id: row.user_id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    platformAdmin: Boolean(row.platform_admin),
    emailVerified: Boolean(row.email_verified_at),
    capabilities,
  };
  const session = await createSession(ctx.db, tenant, user, {
    authMethod: "passkey",
    assurance: "passkey",
    userAgent: request.headers.get("user-agent"),
  });
  await ctx.db
    .prepare(
      `INSERT INTO fb_audit_events
        (id, tenant_id, actor_type, actor_id, represented_user_id, action, object_type, object_id, metadata_json, request_id, created_at)
       VALUES (?, ?, 'user', ?, ?, 'auth.passkey.signed_in', 'user', ?, '{}', ?, ?)`,
    )
    .bind(newId("aud"), tenant.id, user.id, user.id, user.id, ctx.requestId, nowIso())
    .run()
    .catch(() => undefined);
  return { token: session.token, csrf: session.csrf, expiresAt: session.expiresAt, tenant, user, redirectPath: "/play" };
}

function safeTransports(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

function extractClientChallenge(response: { response?: { clientDataJSON?: string } }): string {
  const encoded = response.response?.clientDataJSON;
  if (!encoded) throw new ApiError(422, "passkey_response_invalid", "The passkey response is incomplete.");
  try {
    const decoded = JSON.parse(new TextDecoder().decode(isoBase64URL.toBuffer(encoded))) as { challenge?: string };
    if (!decoded.challenge) throw new Error("missing challenge");
    return decoded.challenge;
  } catch {
    throw new ApiError(422, "passkey_response_invalid", "The passkey response could not be read.");
  }
}

export async function listPasskeys(db: D1Database, userId: string) {
  return all<{ id: string; name: string; created_at: string; last_used_at: string | null; device_type: string | null }>(
    db,
    "SELECT id, name, created_at, last_used_at, device_type FROM fb_webauthn_credentials WHERE user_id = ? ORDER BY created_at DESC",
    userId,
  );
}

export async function deletePasskey(db: D1Database, userId: string, passkeyId: string): Promise<void> {
  // Keep the "never remove the last credential" invariant inside the write.
  // A separate count followed by a delete lets two concurrent removals both
  // observe two credentials and delete both, leaving strong authentication
  // unavailable for the account.
  const deleted = await db
    .prepare(
      `DELETE FROM fb_webauthn_credentials
        WHERE id = ? AND user_id = ?
          AND (SELECT COUNT(*) FROM fb_webauthn_credentials WHERE user_id = ?) > 1`,
    )
    .bind(passkeyId, userId, userId)
    .run();
  if ((deleted.meta?.changes ?? 0) !== 1) {
    throw new ApiError(409, "last_passkey", "Add another passkey before removing the last one.");
  }
}

export async function hashChallenge(challenge: string): Promise<string> {
  return sha256Hex(challenge);
}
