import type { D1Database } from "@cloudflare/workers-types";
import { first, nowIso, statement, all } from "../db";
import { newId, sha256Hex, token } from "../ids";
import { hashPassword, verifyPassword } from "../password";
import { ApiError, type Ctx, type CurrentUser, type Role, type Tenant } from "../context";
import { auditStatement } from "../http";

export const ALL_SCOPES = [
  "content:read",
  "content:write",
  "catalogue:publish",
  "import:write",
  "render:write",
  "economy:read",
  "economy:write",
  "economy:grant",
  "inventory:read",
  "inventory:write",
  "profile:read",
  "profile:write",
  "draw:execute",
  "reward:claim",
  "trade:write",
  "recycle:write",
  "settings:write",
  "ops:read",
] as const;

export type Scope = (typeof ALL_SCOPES)[number];

export const PLAYER_SCOPES: Scope[] = [
  "content:read",
  "inventory:read",
  "inventory:write",
  "profile:read",
  "profile:write",
  "economy:read",
  "draw:execute",
  "reward:claim",
  "trade:write",
  "recycle:write",
];

export function roleRank(role: Role): number {
  const ranks: Record<Role, number> = { player: 10, economy_admin: 20, editor: 20, owner: 50 };
  return ranks[role];
}

export async function createUser(
  db: D1Database,
  input: {
    email: string;
    displayName: string;
    password: string;
    platformAdmin?: boolean;
  },
): Promise<{ id: string; email: string }> {
  const email = input.email.trim().toLowerCase();
  const existing = await first<{ id: string }>(
    db,
    "SELECT id FROM fb_users WHERE email = ?",
    email,
  );
  if (existing) throw new ApiError(409, "email_exists", "That email is already registered.");
  const id = newId("usr");
  await db
    .prepare(
      "INSERT INTO fb_users (id, email, display_name, password_hash, platform_admin, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(
      id,
      email,
      input.displayName.trim(),
      await hashPassword(input.password),
      input.platformAdmin ? 1 : 0,
      nowIso(),
    )
    .run();
  return { id, email };
}

export async function findUserByEmail(
  db: D1Database,
  email: string,
): Promise<{
  id: string;
  email: string;
  display_name: string;
  email_verified_at: string | null;
  disabled_at: string | null;
} | null> {
  return first(
    db,
    "SELECT id, email, display_name, email_verified_at, disabled_at FROM fb_users WHERE email = ?",
    email.trim().toLowerCase(),
  );
}

export async function createEmailUser(
  db: D1Database,
  input: { email: string; displayName?: string },
): Promise<{ id: string; email: string; displayName: string }> {
  const email = input.email.trim().toLowerCase();
  const existing = await findUserByEmail(db, email);
  if (existing) {
    if (existing.disabled_at)
      throw new ApiError(403, "account_disabled", "This account is disabled.");
    if (!existing.email_verified_at) {
      await db
        .prepare("UPDATE fb_users SET email_verified_at = ? WHERE id = ?")
        .bind(nowIso(), existing.id)
        .run();
    }
    return { id: existing.id, email: existing.email, displayName: existing.display_name };
  }
  const id = newId("usr");
  const displayName = (input.displayName?.trim() || email.split("@")[0] || "Collector").slice(
    0,
    80,
  );
  await db
    .prepare(
      "INSERT INTO fb_users (id, email, display_name, password_hash, platform_admin, created_at, email_verified_at) VALUES (?, ?, ?, 'passwordless$no_password', 0, ?, ?)",
    )
    .bind(id, email, displayName, nowIso(), nowIso())
    .run();
  return { id, email, displayName };
}

export async function markEmailVerified(db: D1Database, userId: string): Promise<void> {
  await db
    .prepare("UPDATE fb_users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?")
    .bind(nowIso(), userId)
    .run();
}

const DEFAULT_CAPABILITIES: Record<Role, string[]> = {
  owner: ["content", "publish", "economy", "members", "settings", "inventory", "grants"],
  editor: ["content", "publish", "members"],
  economy_admin: ["economy", "inventory", "grants"],
  player: [],
};

export async function addMembership(
  db: D1Database,
  tenantId: string,
  userId: string,
  role: Role,
  options?: {
    capabilities?: string[];
    status?: "active" | "invited" | "revoked";
    invitedBy?: string | null;
    acceptedAt?: string | null;
  },
): Promise<void> {
  const capabilities = options?.capabilities ?? DEFAULT_CAPABILITIES[role];
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO fb_memberships
        (tenant_id, user_id, role, created_at, capabilities_json, status, invited_by, accepted_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, user_id) DO UPDATE SET
         role = excluded.role,
         capabilities_json = excluded.capabilities_json,
         status = excluded.status,
         invited_by = excluded.invited_by,
         accepted_at = excluded.accepted_at,
         revoked_at = excluded.revoked_at`,
    )
    .bind(
      tenantId,
      userId,
      role,
      now,
      JSON.stringify(capabilities),
      options?.status ?? "active",
      options?.invitedBy ?? null,
      options?.acceptedAt ?? (options?.status === "invited" ? null : now),
      options?.status === "revoked" ? now : null,
    )
    .run();
}

export async function ensureWallet(
  db: D1Database,
  tenantId: string,
  userId: string,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO fb_wallets (tenant_id, user_id, balance, updated_at) VALUES (?, ?, 0, ?) ON CONFLICT(tenant_id, user_id) DO NOTHING",
    )
    .bind(tenantId, userId, nowIso())
    .run();
}

export async function login(
  db: D1Database,
  tenant: Tenant,
  email: string,
  password: string,
): Promise<{ token: string; csrf: string; expiresAt: string; user: CurrentUser }> {
  const row = await first<{
    id: string;
    email: string;
    display_name: string;
    password_hash: string;
    platform_admin: number;
    email_verified_at: string | null;
    capabilities_json: string | null;
    role: Role;
    disabled_at: string | null;
  }>(
    db,
    `SELECT u.id, u.email, u.display_name, u.password_hash, u.platform_admin, u.email_verified_at, u.disabled_at, m.role, m.capabilities_json
       FROM fb_users u JOIN fb_memberships m ON m.user_id = u.id
      WHERE u.email = ? AND m.tenant_id = ?`,
    email.trim().toLowerCase(),
    tenant.id,
  );
  if (!row || row.disabled_at)
    throw new ApiError(401, "invalid_credentials", "Email or password is incorrect.");
  const valid = await verifyPassword(password, row.password_hash);
  if (!valid) throw new ApiError(401, "invalid_credentials", "Email or password is incorrect.");
  return createSession(db, tenant, {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    platformAdmin: Boolean(row.platform_admin),
    emailVerified: Boolean(row.email_verified_at),
    capabilities: row.capabilities_json ? (JSON.parse(row.capabilities_json) as string[]) : [],
  });
}

export async function createSession(
  db: D1Database,
  tenant: Tenant,
  user: CurrentUser,
  options?: {
    authMethod?:
      | "password"
      | "discord"
      | "magic_link"
      | "passkey"
      | "mfa"
      | "cloudflare_access"
      | "session_switch";
    assurance?: "password" | "email" | "discord" | "access" | "passkey" | "mfa";
    accessSubject?: string | null;
    userAgent?: string | null;
    ipHash?: string | null;
    ttlSeconds?: number;
    /** Preserve an existing strong-auth timestamp when minting a switched session. */
    authTime?: string | null;
  },
): Promise<{
  token: string;
  csrf: string;
  expiresAt: string;
  user: CurrentUser;
  assurance: string;
}> {
  const raw = token("fbs");
  const csrf = token("fbc");
  const id = newId("ses");
  const createdAt = nowIso();
  const expiresAt = new Date(
    Date.now() + 1000 * (options?.ttlSeconds ?? 60 * 60 * 24 * 14),
  ).toISOString();
  const authMethod = options?.authMethod ?? "password";
  const assurance = options?.assurance ?? "password";
  const authTime = options?.authTime ?? createdAt;
  await db
    .prepare(
      `INSERT INTO fb_sessions
        (id, token_hash, user_id, tenant_id, csrf_token, created_at, expires_at, last_seen_at,
         auth_method, assurance, auth_time, user_agent, ip_hash, access_subject)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      await sha256Hex(raw),
      user.id,
      tenant.id,
      csrf,
      createdAt,
      expiresAt,
      createdAt,
      authMethod,
      assurance,
      authTime,
      options?.userAgent ?? null,
      options?.ipHash ?? null,
      options?.accessSubject ?? null,
    )
    .run();
  return { token: raw, csrf, expiresAt, user, assurance };
}

/**
 * Mint a session for a Bot switch without laundering an old strong-auth
 * timestamp. Switching Bots is a session convenience, not a fresh MFA event.
 */
export async function createSwitchedSession(
  db: D1Database,
  tenant: Tenant,
  user: CurrentUser,
  ctx: Pick<Ctx, "sessionAssurance" | "sessionAuthTime">,
  userAgent?: string | null,
) {
  return createSession(db, tenant, user, {
    authMethod: "session_switch",
    assurance:
      (ctx.sessionAssurance as
        "password" | "email" | "discord" | "access" | "passkey" | "mfa" | null) ?? "password",
    authTime: ctx.sessionAuthTime,
    userAgent: userAgent ?? null,
  });
}

export async function upgradeSessionAssurance(
  db: D1Database,
  sessionId: string,
  assurance: "passkey" | "mfa" | "access",
): Promise<void> {
  await db
    .prepare(
      "UPDATE fb_sessions SET assurance = ?, auth_time = ?, last_seen_at = ? WHERE id = ? AND revoked_at IS NULL",
    )
    .bind(assurance, nowIso(), nowIso(), sessionId)
    .run();
}

export async function listSessions(
  db: D1Database,
  userId: string,
  currentSessionId?: string | null,
) {
  return all<{
    id: string;
    auth_method: string;
    assurance: string;
    created_at: string;
    last_seen_at: string;
    expires_at: string;
    revoked_at: string | null;
    user_agent: string | null;
    current: number;
  }>(
    db,
    `SELECT id, auth_method, assurance, created_at, last_seen_at, expires_at, revoked_at, user_agent,
            CASE WHEN id = ? THEN 1 ELSE 0 END AS current
       FROM fb_sessions WHERE user_id = ? ORDER BY last_seen_at DESC LIMIT 50`,
    currentSessionId ?? "",
    userId,
  );
}

export async function revokeSessionById(
  db: D1Database,
  userId: string,
  sessionId: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      "UPDATE fb_sessions SET revoked_at = ?, revoked_reason = 'user_revoked' WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
    )
    .bind(nowIso(), sessionId, userId)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function revokeOtherSessions(
  db: D1Database,
  userId: string,
  keepSessionId: string,
): Promise<void> {
  await db
    .prepare(
      "UPDATE fb_sessions SET revoked_at = ?, revoked_reason = 'user_revoked_others' WHERE user_id = ? AND id <> ? AND revoked_at IS NULL",
    )
    .bind(nowIso(), userId, keepSessionId)
    .run();
}

export async function revokeSession(db: D1Database, sessionId: string): Promise<void> {
  await db
    .prepare("UPDATE fb_sessions SET revoked_at = ? WHERE id = ?")
    .bind(nowIso(), sessionId)
    .run();
}

export async function issueAgentGrant(
  db: D1Database,
  config: { agentPepper: string; sessionSecret: string },
  tenant: Tenant,
  input: {
    agentName: string;
    representedUserId: string;
    scopes: string[];
    expiresInDays: number;
    createdBy: string;
  },
): Promise<{
  grantId: string;
  agentId: string;
  token: string;
  prefix: string;
  expiresAt: string;
}> {
  const unique = [...new Set(input.scopes)];
  const invalid = unique.filter((scope) => !ALL_SCOPES.includes(scope as Scope));
  if (invalid.length)
    throw new ApiError(422, "unknown_scope", `Unknown scopes: ${invalid.join(", ")}`);
  if (!unique.length) throw new ApiError(422, "scope_required", "Choose at least one scope.");
  if (input.expiresInDays < 1 || input.expiresInDays > 365) {
    throw new ApiError(422, "expiry_invalid", "Grant expiry must be between 1 and 365 days.");
  }
  const member = await first<{ user_id: string }>(
    db,
    "SELECT user_id FROM fb_memberships WHERE tenant_id = ? AND user_id = ?",
    tenant.id,
    input.representedUserId,
  );
  if (!member)
    throw new ApiError(
      422,
      "represented_user_invalid",
      "The represented user is not in this tenant.",
    );
  const grantId = newId("agt");
  const agentId = newId("agent");
  const raw = token("fba");
  const prefix = raw.slice(0, 12);
  const { hmacHex } = await import("../ids");
  const tokenHash = await hmacHex(config.agentPepper || config.sessionSecret || "local", raw);
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + input.expiresInDays * 86400 * 1000).toISOString();
  await db.batch([
    db
      .prepare(
        `INSERT INTO fb_agent_grants
          (id, tenant_id, agent_name, agent_id, represented_user_id, scopes_json, status, expires_at, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      )
      .bind(
        grantId,
        tenant.id,
        input.agentName.trim(),
        agentId,
        input.representedUserId,
        JSON.stringify(unique),
        expiresAt,
        input.createdBy,
        createdAt,
      ),
    db
      .prepare(
        `INSERT INTO fb_agent_tokens (id, grant_id, token_hash, prefix, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(newId("tok"), grantId, tokenHash, prefix, createdAt),
  ]);
  return { grantId, agentId, token: raw, prefix, expiresAt };
}

export async function createAgentGrant(
  ctx: Ctx,
  input: {
    agentName: string;
    representedUserId: string;
    scopes: string[];
    expiresInDays: number;
  },
) {
  if (ctx.actor.type === "agent") {
    throw new ApiError(
      403,
      "agents_cannot_administer_agents",
      "An agent cannot create or expand grants.",
    );
  }
  if (ctx.user?.role !== "owner") {
    throw new ApiError(403, "owner_required", "Only the tenant owner can create agent grants.");
  }
  const issued = await issueAgentGrant(ctx.db, ctx.config, ctx.tenant, {
    ...input,
    createdBy: ctx.user.id,
  });
  await auditStatement(ctx, "agent.grant.created", "agent_grant", issued.grantId, {
    agent_name: input.agentName,
    scopes: [...new Set(input.scopes)],
    represented_user_id: input.representedUserId,
  }).run();
  return issued;
}

export async function revokeAgentGrant(ctx: Ctx, grantId: string): Promise<void> {
  if (ctx.actor.type === "agent") {
    throw new ApiError(
      403,
      "agents_cannot_administer_agents",
      "An agent cannot revoke or alter grants.",
    );
  }
  if (ctx.user?.role !== "owner")
    throw new ApiError(403, "owner_required", "Only the owner can revoke grants.");
  const now = nowIso();
  await ctx.db.batch([
    ctx.db
      .prepare(
        "UPDATE fb_agent_grants SET status = 'revoked', revoked_at = ? WHERE id = ? AND tenant_id = ?",
      )
      .bind(now, grantId, ctx.tenant.id),
    ctx.db
      .prepare(
        "UPDATE fb_agent_tokens SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL",
      )
      .bind(now, grantId),
    auditStatement(ctx, "agent.grant.revoked", "agent_grant", grantId),
  ]);
}

export async function listAgentGrants(ctx: Ctx) {
  return all<{
    id: string;
    agent_name: string;
    agent_id: string;
    represented_user_id: string;
    scopes_json: string;
    status: string;
    expires_at: string;
    created_at: string;
    represented_name: string;
    prefix: string | null;
    last_used_at: string | null;
  }>(
    ctx.db,
    `SELECT g.id, g.agent_name, g.agent_id, g.represented_user_id, g.scopes_json, g.status,
            g.expires_at, g.created_at, u.display_name AS represented_name,
            t.prefix, t.last_used_at
       FROM fb_agent_grants g
       JOIN fb_users u ON u.id = g.represented_user_id
       LEFT JOIN fb_agent_tokens t ON t.grant_id = g.id
      WHERE g.tenant_id = ? ORDER BY g.created_at DESC`,
    ctx.tenant.id,
  );
}

export async function listMembers(ctx: Ctx) {
  return all<{ id: string; email: string; display_name: string; role: Role; created_at: string }>(
    ctx.db,
    `SELECT u.id, u.email, u.display_name, m.role, m.created_at
       FROM fb_memberships m JOIN fb_users u ON u.id = m.user_id
      WHERE m.tenant_id = ? ORDER BY m.created_at`,
    ctx.tenant.id,
  );
}

export async function changePassword(
  db: D1Database,
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const row = await first<{ password_hash: string }>(
    db,
    "SELECT password_hash FROM fb_users WHERE id = ?",
    userId,
  );
  if (!row) throw new ApiError(404, "user_not_found", "User not found.");
  if (!(await verifyPassword(currentPassword, row.password_hash))) {
    throw new ApiError(403, "invalid_credentials", "Current password is incorrect.");
  }
  await db
    .prepare("UPDATE fb_users SET password_hash = ? WHERE id = ?")
    .bind(await hashPassword(newPassword), userId)
    .run();
}

export async function seedIdentityTaxonomy(db: D1Database, tenantId: string): Promise<void> {
  const classes = [
    ["companion", "Companion", "A character who travels with the collection."],
    ["hero", "Hero", "A lead identity with a story of their own."],
    ["trickster", "Trickster", "A wildcard who changes the room."],
    ["operator", "Operator", "A technical or backstage specialist."],
    ["artefact", "Artefact", "An object, token or place worth keeping."],
  ] as const;
  const rarities = [
    ["common", "Common", 1000, "ink"],
    ["uncommon", "Uncommon", 450, "moss"],
    ["rare", "Rare", 140, "brass"],
    ["cabinet_rare", "Cabinet Rare", 25, "oxblood"],
  ] as const;
  const materials = [
    ["plain", "Plain", { finish: "matte", accent: "paper" }],
    ["silver", "Silver", { finish: "brushed", accent: "silver" }],
    ["gold", "Gold", { finish: "foil", accent: "gold" }],
    ["diamond", "Diamond", { finish: "faceted", accent: "diamond" }],
  ] as const;
  const effects = [
    ["none", "None", {}],
    ["holographic", "Holographic", { spectrum: "rainbow", opacity: 0.34 }],
    ["prismatic", "Prismatic", { spectrum: "prism", opacity: 0.24 }],
  ] as const;
  const categories = [
    ["bubbles", "Bubbles", "The Bubbles cast and their shared world."],
    ["fighter", "Fighter", "The Fighter roster and its expanded editions."],
    ["protocol-11", "Protocol 11", "The Protocol 11 table-night regulars."],
    ["shared", "Shared Characters", "Identities that appear in more than one world."],
  ] as const;
  const tags = [
    ["night-shift", "Night shift"],
    ["green-room", "Green room"],
    ["lantern", "Lantern"],
    ["cabinet", "Cabinet"],
    ["horror", "Horror"],
    ["music", "Music"],
    ["tech", "Tech"],
    ["animals", "Animals"],
    ["shared-cast", "Shared cast"],
  ] as const;
  const allStatements = [
    ...classes.map(([key, name, description], i) =>
      db
        .prepare(
          "INSERT INTO fb_classes (id, tenant_id, key, name, description, sort) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(tenant_id, key) DO NOTHING",
        )
        .bind(newId("cls"), tenantId, key, name, description, i),
    ),
    ...rarities.map(([key, name, weight, tone], i) =>
      db
        .prepare(
          "INSERT INTO fb_rarities (id, tenant_id, key, name, weight, tone, sort) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(tenant_id, key) DO NOTHING",
        )
        .bind(newId("rar"), tenantId, key, name, weight, tone, i),
    ),
    ...materials.map(([key, name, config], i) =>
      db
        .prepare(
          "INSERT INTO fb_materials (id, tenant_id, key, name, config_json, sort) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(tenant_id, key) DO NOTHING",
        )
        .bind(newId("mat"), tenantId, key, name, JSON.stringify(config), i),
    ),
    ...effects.map(([key, name, config], i) =>
      db
        .prepare(
          "INSERT INTO fb_effects (id, tenant_id, key, name, config_json, sort) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(tenant_id, key) DO NOTHING",
        )
        .bind(newId("eff"), tenantId, key, name, JSON.stringify(config), i),
    ),
    ...categories.map(([slug, name, description], i) =>
      db
        .prepare(
          "INSERT INTO fb_categories (id, tenant_id, slug, name, description, sort) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(tenant_id, slug) DO NOTHING",
        )
        .bind(newId("cat"), tenantId, slug, name, description, i),
    ),
    ...tags.map(([slug, name]) =>
      db
        .prepare(
          "INSERT INTO fb_tags (id, tenant_id, slug, name) VALUES (?, ?, ?, ?) ON CONFLICT(tenant_id, slug) DO NOTHING",
        )
        .bind(newId("tag"), tenantId, slug, name),
    ),
  ];
  await db.batch(allStatements);
}

/** Explicit local-only convenience. The API route enforces loopback + FOILBURY_LOCAL_MODE + FOILBURY_DEV_LOGIN. */
export async function devLogin(db: D1Database, tenant: Tenant, email: string) {
  const row = await first<{
    id: string;
    email: string;
    display_name: string;
    platform_admin: number;
    email_verified_at: string | null;
    capabilities_json: string | null;
    role: Role;
    disabled_at: string | null;
  }>(
    db,
    `SELECT u.id, u.email, u.display_name, u.platform_admin, u.email_verified_at, u.disabled_at, m.role, m.capabilities_json
       FROM fb_users u JOIN fb_memberships m ON m.user_id = u.id
      WHERE u.email = ? AND m.tenant_id = ?`,
    email.trim().toLowerCase(),
    tenant.id,
  );
  if (!row || row.disabled_at)
    throw new ApiError(
      404,
      "dev_account_not_found",
      "That local development account does not exist.",
    );
  return createSession(db, tenant, {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    platformAdmin: Boolean(row.platform_admin),
    emailVerified: Boolean(row.email_verified_at),
    capabilities: row.capabilities_json ? (JSON.parse(row.capabilities_json) as string[]) : [],
  });
}
