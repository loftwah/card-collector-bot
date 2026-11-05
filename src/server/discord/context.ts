import { ApiError, type Ctx, type CurrentUser, type Tenant } from "../context";
import { readConfig } from "../config";
import { first, nowIso } from "../db";
import { newId } from "../ids";
import type {
  DiscordEnv,
  DiscordIdentity,
  DiscordInstallation,
  DiscordInteraction,
  DiscordUser,
} from "./types";

export interface ResolvedInstallation {
  installation: DiscordInstallation;
  tenant: Tenant;
  allowedChannels: string[];
}

export interface ResolvedPlayer {
  user: CurrentUser;
  identity: DiscordIdentity;
  created: boolean;
}

/**
 * The audience an operator has verified for a channel. Missing policy means
 * public only: restricted artwork stays ephemeral until a channel is prepared.
 */
export function channelAudienceFor(
  installation: DiscordInstallation,
  channelId: string | undefined | null,
): "public" | "members" | "private" {
  if (!channelId) return "public";
  try {
    const parsed = JSON.parse(installation.channel_audience_json ?? "{}") as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const value = (parsed as Record<string, unknown>)[channelId];
      if (value === "public" || value === "members" || value === "private") return value;
    }
  } catch {
    // A malformed policy is treated as public-only, never as a permissive one.
  }
  return "public";
}

function isSnowflake(value: string | undefined | null): value is string {
  return Boolean(value && /^\d{15,22}$/.test(value));
}

export function interactionUser(interaction: DiscordInteraction): DiscordUser {
  const user = interaction.member?.user ?? interaction.user;
  if (!user || !isSnowflake(user.id)) {
    throw new ApiError(
      401,
      "discord_user_missing",
      "Discord did not provide a verified user for this interaction.",
    );
  }
  return user;
}

export async function resolveInstallation(
  env: DiscordEnv,
  interaction: DiscordInteraction,
  applicationId: string,
  options: { allowDisabledGame?: boolean } = {},
): Promise<ResolvedInstallation> {
  const guildId = interaction.guild_id;
  if (!isSnowflake(guildId)) {
    throw new ApiError(
      403,
      "discord_guild_required",
      "Foilbury only works in a server where it is installed.",
    );
  }
  const installation = await first<DiscordInstallation>(
    env.DB,
    `SELECT * FROM fb_discord_installations
      WHERE application_id = ? AND guild_id = ? AND active = 1 AND revoked_at IS NULL`,
    applicationId,
    guildId,
  );
  if (!installation) {
    throw new ApiError(
      403,
      "discord_installation_missing",
      "This server is not bound to a Foilbury Bot. Ask the Bot Owner to connect it.",
    );
  }
  if (!installation.game_enabled && !options.allowDisabledGame) {
    throw new ApiError(
      403,
      "discord_game_disabled",
      "Discord gameplay is paused for this installation. Nothing was charged.",
    );
  }
  let allowedChannels: string[] = [];
  try {
    const parsed = JSON.parse(installation.channel_allowlist_json) as unknown;
    if (Array.isArray(parsed))
      allowedChannels = parsed.filter((value): value is string => typeof value === "string");
  } catch {
    allowedChannels = [];
  }
  if (
    allowedChannels.length > 0 &&
    (!interaction.channel_id || !allowedChannels.includes(interaction.channel_id))
  ) {
    throw new ApiError(
      403,
      "discord_channel_not_enabled",
      "Foilbury is not enabled in this channel. Try the configured play channel.",
    );
  }
  const tenant = await first<Tenant>(
    env.DB,
    "SELECT id, slug, name FROM fb_tenants WHERE id = ?",
    installation.tenant_id,
  );
  if (!tenant)
    throw new ApiError(
      503,
      "tenant_not_configured",
      "This installation's Bot is no longer configured.",
    );
  return { installation, tenant, allowedChannels };
}

function safeDisplayName(user: DiscordUser): string {
  const raw = (user.global_name ?? user.username ?? "Discord Player")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  return (raw || "Discord Player").slice(0, 80);
}

type LiveDiscordPlayer = DiscordIdentity & {
  email: string; user_display_name: string; platform_admin: number;
  role: CurrentUser["role"]; capabilities_json: string | null;
  self_grants_enabled: number; grant_limit: number; capability_revision: number;
};

async function liveDiscordPlayer(env: DiscordEnv, tenantId: string, discordUserId: string, expectedUserId: string): Promise<LiveDiscordPlayer | null> {
  return first<LiveDiscordPlayer>(env.DB,`SELECT di.*,u.email,u.display_name AS user_display_name,u.platform_admin,
    m.role,m.capabilities_json,m.self_grants_enabled,m.grant_limit,m.capability_revision
    FROM fb_discord_identities di JOIN fb_users u ON u.id=di.user_id
    JOIN fb_memberships m ON m.tenant_id=di.tenant_id AND m.user_id=di.user_id
    WHERE di.tenant_id=? AND di.discord_user_id=? AND di.user_id=? AND di.revoked_at IS NULL
      AND u.disabled_at IS NULL AND u.is_synthetic=0 AND m.status='active' AND m.revoked_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM fb_discord_identities other INDEXED BY fb_discord_identity_global_lookup_idx
        WHERE other.discord_user_id=di.discord_user_id AND other.user_id<>di.user_id)`,
    tenantId,discordUserId,expectedUserId);
}

function resolvedDiscordPlayer(row: LiveDiscordPlayer, created: boolean): ResolvedPlayer {
  let capabilities:string[]=[];
  try { const parsed=JSON.parse(row.capabilities_json??'[]');if(Array.isArray(parsed))capabilities=parsed.filter((item):item is string=>typeof item==='string'); } catch { /* fail closed */ }
  return {created,identity:row,user:{id:row.user_id,email:row.email,displayName:row.user_display_name,
    role:row.role,platformAdmin:Boolean(row.platform_admin),capabilities,
    selfGrantsEnabled:Boolean(row.self_grants_enabled),grantLimit:Number(row.grant_limit??0),capabilityRevision:Number(row.capability_revision??1)}};
}

/**
 * A verified Discord interaction is enough to become a lightweight Player.
 * There is no separate /register step and no privileged intent requirement.
 */
export async function ensureDiscordPlayer(
  env: DiscordEnv,
  tenant: Tenant,
  discordUser: DiscordUser,
): Promise<ResolvedPlayer> {
  const displayName = safeDisplayName(discordUser);
  const existing = await first<
    DiscordIdentity & {
      email: string;
      user_display_name: string;
      platform_admin: number;
      role: CurrentUser["role"];
      capabilities_json: string | null;
      self_grants_enabled: number;
      grant_limit: number;
      capability_revision: number;
      disabled_at: string | null;
      is_synthetic: number;
      membership_status: string | null;
      membership_revoked_at: string | null;
      tenant_name: string;
    }
  >(
    env.DB,
    `SELECT di.*, u.email, u.display_name AS user_display_name, u.platform_admin, u.disabled_at, u.is_synthetic,
            m.role, m.capabilities_json, m.self_grants_enabled, m.grant_limit, m.capability_revision,
            m.status AS membership_status, m.revoked_at AS membership_revoked_at, t.name AS tenant_name
       FROM fb_discord_identities di
       JOIN fb_users u ON u.id = di.user_id
       LEFT JOIN fb_memberships m ON m.user_id = u.id AND m.tenant_id = di.tenant_id
       JOIN fb_tenants t ON t.id = di.tenant_id
      WHERE di.tenant_id = ? AND di.discord_user_id = ?`,
    tenant.id,
    discordUser.id,
  );
  // Global identity is derived from Discord's signed user ID, never email.
  // The index is a test-only migration proposal; absence must fail closed.
  let mapping:{user_id:string|null;users:number;active_links:number;total:number}|null;
  try {
    mapping=await first(env.DB,`SELECT MIN(user_id) AS user_id,COUNT(DISTINCT user_id) AS users,
      SUM(CASE WHEN revoked_at IS NULL THEN 1 ELSE 0 END) AS active_links,COUNT(*) AS total
      FROM fb_discord_identities INDEXED BY fb_discord_identity_global_lookup_idx WHERE discord_user_id=?`,discordUser.id);
  } catch(error) {
    if(String(error).includes('no such index')) throw new ApiError(503,'discord_identity_unavailable','Discord account linking is temporarily unavailable.');
    throw error;
  }
  if(!mapping || Number(mapping.users)>1)
    throw new ApiError(409,'discord_link_conflict','This Discord account needs help from the Bot Owner before it can be connected.');
  if (existing) {
    // A verified Discord identity never restores a revoked membership. The
    // membership and the identity's revocation state are checked on every
    // interaction, including buttons and delayed confirmations.
    if (existing.revoked_at) {
      throw new ApiError(
        403,
        "discord_identity_revoked",
        "This Discord identity was revoked for this Bot. Ask the Bot Owner to restore it.",
      );
    }
    if (existing.disabled_at || existing.is_synthetic)
      throw new ApiError(403, "account_disabled", "This player account is disabled.");
    if (
      !existing.membership_status ||
      existing.membership_status !== "active" ||
      existing.membership_revoked_at
    ) {
      throw new ApiError(
        403,
        "membership_revoked",
        "This player is no longer an active member of this Bot. Nothing was changed.",
      );
    }
    const touched=await env.DB.prepare(`UPDATE fb_discord_identities SET username=?,global_name=?,last_seen_at=?
      WHERE id=? AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM fb_users u JOIN fb_memberships m ON m.user_id=u.id
        WHERE u.id=fb_discord_identities.user_id AND u.disabled_at IS NULL AND u.is_synthetic=0
          AND m.tenant_id=fb_discord_identities.tenant_id AND m.status='active' AND m.revoked_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM fb_discord_identities other INDEXED BY fb_discord_identity_global_lookup_idx
          WHERE other.discord_user_id=fb_discord_identities.discord_user_id AND other.user_id<>fb_discord_identities.user_id) RETURNING id`)
      .bind(discordUser.username,discordUser.global_name??null,nowIso(),existing.id).first<{id:string}>();
    if(!touched) throw new ApiError(403,'membership_revoked','Your Discord access changed. Ask the Bot Owner for help.');
    const live=await liveDiscordPlayer(env,tenant.id,discordUser.id,existing.user_id);
    if(!live) throw new ApiError(403,'membership_revoked','Your Discord access changed. Ask the Bot Owner for help.');
    return resolvedDiscordPlayer(live,false);
  }

  const email = `discord.${discordUser.id}@players.foilbury.invalid`;
  if(Number(mapping.total)>0 && Number(mapping.active_links)===0)
    throw new ApiError(409,'discord_link_conflict','This Discord account needs help from the Bot Owner before it can be connected.');
  const linkedUserId=Number(mapping.active_links)>0 ? mapping.user_id : null;
  const accountWhere=linkedUserId ? 'u.id=?' : "u.email=? AND u.password_hash='discord_only$no_password'";
  const accountKey=linkedUserId??email;
  const priorUser=await first<{id:string;password_hash:string;disabled_at:string|null;is_synthetic:number}>(env.DB,
    linkedUserId ? 'SELECT id,password_hash,disabled_at,is_synthetic FROM fb_users WHERE id=?' : 'SELECT id,password_hash,disabled_at,is_synthetic FROM fb_users WHERE email=?',accountKey);
  if(linkedUserId && !priorUser) throw new ApiError(409,'discord_link_conflict','This Discord account needs help from the Bot Owner before it can be connected.');
  if(priorUser && (priorUser.disabled_at || priorUser.is_synthetic))
    throw new ApiError(403,'account_disabled','This player account is disabled.');
  // Neither the reserved address nor the password sentinel proves identity.
  // A prior orphan requires an explicit verified recovery flow.
  if(!linkedUserId && priorUser)
    throw new ApiError(409,'discord_link_conflict','This Discord account could not be linked to this Foilbury account.');
  if(priorUser){
    const priorMembership=await first<{status:string;revoked_at:string|null}>(env.DB,
      'SELECT status,revoked_at FROM fb_memberships WHERE tenant_id=? AND user_id=?',tenant.id,priorUser.id);
    if(priorMembership && (priorMembership.status!=='active' || priorMembership.revoked_at))
      throw new ApiError(403,'membership_revoked','This player is no longer an active member of this Bot. Ask the Bot Owner for help.');
  }
  const now=nowIso(), candidateUserId=newId('usr'), identityId=newId('dci'), ledgerId=newId('led');
  let created=false;
  try {
    // Account, membership, starter ledger and identity share one D1 batch.
    // The global Discord mapping and current authority are checked in it.
    const results=await env.DB.batch([
      env.DB.prepare('INSERT INTO fb_discord_binding_admissions (discord_user_id,user_id) VALUES (?,COALESCE((SELECT user_id FROM fb_discord_global_bindings WHERE discord_user_id=?),?))')
        .bind(discordUser.id,discordUser.id,linkedUserId??candidateUserId),
      env.DB.prepare(`INSERT INTO fb_users (id,email,display_name,password_hash,platform_admin,created_at)
        SELECT ?,?,?,'discord_only$no_password',0,? WHERE ?=0
          AND NOT EXISTS (SELECT 1 FROM fb_discord_global_bindings WHERE discord_user_id=?) ON CONFLICT(email) DO NOTHING RETURNING id`)
        .bind(candidateUserId,email,displayName,now,linkedUserId?1:0,discordUser.id),
      env.DB.prepare(`SELECT CASE WHEN EXISTS (SELECT 1 FROM fb_users u WHERE ${accountWhere}
        AND (? IS NULL OR u.id=?) AND u.disabled_at IS NULL AND u.is_synthetic=0
        AND EXISTS (SELECT 1 FROM fb_discord_binding_admissions p WHERE p.discord_user_id=? AND p.user_id=u.id)
        AND NOT EXISTS (SELECT 1 FROM fb_discord_identities di INDEXED BY fb_discord_identity_global_lookup_idx WHERE di.discord_user_id=? AND di.user_id<>u.id)
        AND ((?=1 AND EXISTS (SELECT 1 FROM fb_discord_identities di INDEXED BY fb_discord_identity_global_lookup_idx WHERE di.discord_user_id=? AND di.user_id=u.id AND di.revoked_at IS NULL))
          OR (?=0 AND (changes()=1 OR EXISTS (SELECT 1 FROM fb_discord_identities di INDEXED BY fb_discord_identity_global_lookup_idx WHERE di.discord_user_id=? AND di.user_id=u.id AND di.revoked_at IS NULL)))))
        THEN 1 ELSE json('discord_admission_changed') END`)
        .bind(accountKey,priorUser?.id??null,priorUser?.id??null,discordUser.id,discordUser.id,linkedUserId?1:0,discordUser.id,linkedUserId?1:0,discordUser.id),
      env.DB.prepare(`INSERT INTO fb_memberships (tenant_id,user_id,role,created_at,capabilities_json,status,accepted_at,revoked_at)
        SELECT ?,u.id,'player',?,'[]','active',?,NULL FROM fb_users u WHERE ${accountWhere} AND u.disabled_at IS NULL AND u.is_synthetic=0
        ON CONFLICT(tenant_id,user_id) DO NOTHING`).bind(tenant.id,now,now,accountKey),
      env.DB.prepare(`SELECT CASE WHEN EXISTS (SELECT 1 FROM fb_users u JOIN fb_memberships m ON m.user_id=u.id
        WHERE ${accountWhere} AND u.disabled_at IS NULL AND u.is_synthetic=0 AND m.tenant_id=? AND m.status='active' AND m.revoked_at IS NULL)
        THEN 1 ELSE json('discord_admission_changed') END`).bind(accountKey,tenant.id),
      env.DB.prepare(`INSERT INTO fb_wallets (tenant_id,user_id,balance,updated_at)
        SELECT ?,u.id,0,? FROM fb_users u WHERE ${accountWhere} ON CONFLICT(tenant_id,user_id) DO NOTHING`).bind(tenant.id,now,accountKey),
      env.DB.prepare(`UPDATE fb_wallets SET balance=balance+(SELECT starter_grant FROM fb_economy_settings WHERE tenant_id=?),updated_at=?
        WHERE tenant_id=? AND user_id=(SELECT u.id FROM fb_users u WHERE ${accountWhere}) AND EXISTS (SELECT 1 FROM fb_economy_settings e WHERE e.tenant_id=? AND e.starter_grant>0)
          AND NOT EXISTS (SELECT 1 FROM fb_ledger_entries l WHERE l.tenant_id=fb_wallets.tenant_id AND l.user_id=fb_wallets.user_id
            AND l.idempotency_key='starter:' || fb_wallets.tenant_id || ':' || fb_wallets.user_id)`)
        .bind(tenant.id,now,tenant.id,accountKey,tenant.id),
      env.DB.prepare(`INSERT INTO fb_ledger_entries
        (id,tenant_id,user_id,kind,amount,balance_after,reference_type,reference_id,description,idempotency_key,metadata_json,actor_type,actor_id,created_at)
        SELECT ?,w.tenant_id,w.user_id,'issue',(SELECT starter_grant FROM fb_economy_settings WHERE tenant_id=w.tenant_id),w.balance,'welcome_reward',NULL,
          'Welcome to Foilbury','starter:' || w.tenant_id || ':' || w.user_id,'{\"source\":\"discord_first_interaction\"}','system','discord',?
        FROM fb_wallets w WHERE w.tenant_id=? AND w.user_id=(SELECT u.id FROM fb_users u WHERE ${accountWhere}) AND changes()=1`)
        .bind(ledgerId,now,tenant.id,accountKey),
      env.DB.prepare(`SELECT CASE WHEN COALESCE((SELECT starter_grant FROM fb_economy_settings WHERE tenant_id=?),0)=0
        OR EXISTS (SELECT 1 FROM fb_ledger_entries l JOIN fb_users u ON u.id=l.user_id
          WHERE l.tenant_id=? AND ${accountWhere} AND l.idempotency_key='starter:' || l.tenant_id || ':' || l.user_id)
        THEN 1 ELSE json('discord_starter_unavailable') END`).bind(tenant.id,tenant.id,accountKey),
      env.DB.prepare(`INSERT INTO fb_discord_identities (id,tenant_id,discord_user_id,user_id,username,global_name,linked_at,last_seen_at)
        SELECT ?,?,?,u.id,?,?,?,? FROM fb_users u WHERE ${accountWhere} ON CONFLICT(tenant_id,discord_user_id) DO NOTHING`)
        .bind(identityId,tenant.id,discordUser.id,discordUser.username,discordUser.global_name??null,now,now,accountKey),
      env.DB.prepare(`SELECT CASE WHEN EXISTS (SELECT 1 FROM fb_discord_identities di
        JOIN fb_users u ON u.id=di.user_id JOIN fb_memberships m ON m.tenant_id=di.tenant_id AND m.user_id=di.user_id
        WHERE di.tenant_id=? AND di.discord_user_id=? AND ${accountWhere} AND di.revoked_at IS NULL
          AND u.disabled_at IS NULL AND u.is_synthetic=0 AND m.status='active' AND m.revoked_at IS NULL)
        THEN 1 ELSE json('discord_admission_changed') END`).bind(tenant.id,discordUser.id,accountKey),
      env.DB.prepare("SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM fb_discord_binding_admissions WHERE discord_user_id=?) THEN 1 ELSE json('discord_admission_unconsumed') END").bind(discordUser.id),
    ]);
    created=(results[1]?.results?.length??0)===1;
  } catch(error) {
    if(String(error).includes('malformed JSON')) throw new ApiError(409,'discord_setup_changed','Your Discord setup could not be completed. Try again or ask the Bot Owner for help.');
    if(String(error).includes('UNIQUE')) throw new ApiError(409,'discord_link_conflict','This Discord account could not be linked to this Foilbury account.');
    throw error;
  }
  const current=await first<{id:string}>(env.DB,`SELECT u.id FROM fb_users u WHERE ${accountWhere}`,accountKey);
  const live=current && await liveDiscordPlayer(env,tenant.id,discordUser.id,current.id);
  if(!live) throw new ApiError(403,'membership_revoked','Your Discord access changed. Ask the Bot Owner for help.');
  return resolvedDiscordPlayer(live,created);
}

/**
 * Deliberate account linking: an existing Foilbury session plus a completed
 * Discord OAuth authorization prove both identities. Never merge automatically
 * when the Discord ID or Foilbury account is already linked to another person.
 */
export async function linkDiscordIdentity(
  env: DiscordEnv,
  tenant: Tenant,
  user: CurrentUser,
  discordUser: DiscordUser,
): Promise<DiscordIdentity> {
  const existingForDiscord = await first<DiscordIdentity>(
    env.DB,
    "SELECT * FROM fb_discord_identities WHERE tenant_id = ? AND discord_user_id = ? AND revoked_at IS NULL",
    tenant.id,
    discordUser.id,
  );
  if (existingForDiscord && existingForDiscord.user_id !== user.id) {
    throw new ApiError(
      409,
      "discord_already_linked",
      "That Discord account is already linked to another Foilbury account.",
    );
  }
  const existingForUser = await first<DiscordIdentity>(
    env.DB,
    "SELECT * FROM fb_discord_identities WHERE tenant_id = ? AND user_id = ? AND revoked_at IS NULL",
    tenant.id,
    user.id,
  );
  if (existingForUser && existingForUser.discord_user_id !== discordUser.id) {
    throw new ApiError(
      409,
      "account_already_linked",
      "This Foilbury account is already linked to a different Discord account.",
    );
  }
  const now = nowIso();
  if (existingForDiscord) {
    const updated=await env.DB.prepare(`UPDATE fb_discord_identities SET username=?,global_name=?,last_seen_at=?
      WHERE id=? AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM fb_users u JOIN fb_memberships m ON m.user_id=u.id
        WHERE u.id=fb_discord_identities.user_id AND u.disabled_at IS NULL AND u.is_synthetic=0
          AND m.tenant_id=fb_discord_identities.tenant_id AND m.status='active' AND m.revoked_at IS NULL) AND NOT EXISTS (
        SELECT 1 FROM fb_discord_identities other INDEXED BY fb_discord_identity_global_lookup_idx
        WHERE other.discord_user_id=fb_discord_identities.discord_user_id AND other.user_id<>fb_discord_identities.user_id)
      RETURNING id`).bind(discordUser.username,discordUser.global_name??null,now,existingForDiscord.id).first();
    if(!updated) throw new ApiError(409,'discord_link_conflict','That Discord account could not be linked to this Foilbury account.');
    return {
      ...existingForDiscord,
      username: discordUser.username,
      global_name: discordUser.global_name ?? null,
      last_seen_at: now,
    };
  }
  const id = newId("dci");
  try {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO fb_discord_binding_admissions (discord_user_id,user_id) VALUES (?,?)').bind(discordUser.id,user.id),
      env.DB.prepare(
      `INSERT INTO fb_discord_identities
        (id, tenant_id, discord_user_id, user_id, username, global_name, linked_at, last_seen_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM fb_users u JOIN fb_memberships m ON m.user_id=u.id
         WHERE u.id=? AND u.disabled_at IS NULL AND u.is_synthetic=0 AND m.tenant_id=? AND m.status='active' AND m.revoked_at IS NULL) AND NOT EXISTS (
         SELECT 1 FROM fb_discord_identities other INDEXED BY fb_discord_identity_global_lookup_idx
         WHERE other.discord_user_id=? AND other.user_id<>?)`,
    )
      .bind(
        id,
        tenant.id,
        discordUser.id,
        user.id,
        discordUser.username,
        discordUser.global_name ?? null,
        now,
        now,
        user.id,
        tenant.id,
        discordUser.id,
        user.id,
      ),
      env.DB.prepare(`SELECT CASE WHEN EXISTS (SELECT 1 FROM fb_discord_identities di JOIN fb_users u ON u.id=di.user_id
        JOIN fb_memberships m ON m.tenant_id=di.tenant_id AND m.user_id=di.user_id
        WHERE di.tenant_id=? AND di.discord_user_id=? AND di.user_id=? AND di.revoked_at IS NULL
          AND u.disabled_at IS NULL AND u.is_synthetic=0 AND m.status='active' AND m.revoked_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM fb_discord_binding_admissions WHERE discord_user_id=?)
        THEN 1 ELSE json('discord_admission_changed') END`).bind(tenant.id,discordUser.id,user.id,discordUser.id),
    ]);
  } catch (error) {
    if (String(error).includes('malformed JSON') || String(error).includes('discord_global_binding_'))
      throw new ApiError(409,'discord_link_conflict','That Discord account could not be linked to this Foilbury account.');
    if (!String(error).includes("UNIQUE")) throw error;
  }
  const linked = await first<DiscordIdentity>(
    env.DB,
    "SELECT * FROM fb_discord_identities WHERE tenant_id = ? AND discord_user_id = ? AND revoked_at IS NULL",
    tenant.id,
    discordUser.id,
  );
  if (!linked || linked.user_id !== user.id) {
    throw new ApiError(
      409,
      "discord_link_conflict",
      "That Discord account could not be linked to this Foilbury account.",
    );
  }
  await env.DB.prepare(`INSERT INTO fb_wallets (tenant_id,user_id,balance,updated_at)
    SELECT ?,?,0,? WHERE EXISTS (SELECT 1 FROM fb_users u JOIN fb_memberships m ON m.user_id=u.id
      JOIN fb_discord_identities di ON di.user_id=u.id AND di.tenant_id=m.tenant_id
      WHERE u.id=? AND u.disabled_at IS NULL AND u.is_synthetic=0 AND m.tenant_id=?
        AND m.status='active' AND m.revoked_at IS NULL AND di.discord_user_id=? AND di.revoked_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM fb_discord_identities other INDEXED BY fb_discord_identity_global_lookup_idx
          WHERE other.discord_user_id=di.discord_user_id AND other.user_id<>di.user_id))
    ON CONFLICT(tenant_id,user_id) DO NOTHING`).bind(tenant.id,user.id,now,user.id,tenant.id,discordUser.id).run();
  return linked;
}

export function buildDiscordContext(
  env: DiscordEnv,
  tenant: Tenant,
  user: CurrentUser,
  interaction: DiscordInteraction,
): Ctx {
  return {
    db: env.DB,
    media: env.MEDIA,
    config: readConfig(env),
    requestId: `discord:${interaction.id}`,
    clientKey: `discord:${interaction.user?.id ?? interaction.id}`,
    tenant,
    user,
    actor: {
      type: "user",
      id: user.id,
      representedUserId: user.id,
      label: `Discord ${user.displayName}`,
    },
    scopes: null,
    sessionId: null,
    csrfToken: "",
    sessionAssurance: null,
    sessionAuthTime: null,
    accessIdentity: null,
    accessStatus: null,
  };
}

export function isBotAdmin(user: CurrentUser): boolean {
  return user.platformAdmin || ["owner", "editor", "economy_admin"].includes(user.role);
}

export function requireBotAdmin(user: CurrentUser): void {
  if (!isBotAdmin(user)) {
    throw new ApiError(
      403,
      "discord_admin_required",
      "Only this Bot's Owner or Admin can use admin commands. Ask the Bot Owner to link your Foilbury account on the website.",
    );
  }
}
