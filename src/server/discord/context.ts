import { ApiError, type Ctx, type CurrentUser, type Tenant } from "../context";
import { readConfig } from "../config";
import { first, nowIso } from "../db";
import { newId } from "../ids";
import { addMembership, ensureWallet } from "../modules/identity";
import { creditWallet } from "../modules/wallet";
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
      membership_status: string | null;
      membership_revoked_at: string | null;
      tenant_name: string;
    }
  >(
    env.DB,
    `SELECT di.*, u.email, u.display_name AS user_display_name, u.platform_admin, u.disabled_at,
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
    if (existing.disabled_at)
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
    await env.DB.prepare(
      "UPDATE fb_discord_identities SET username = ?, global_name = ?, last_seen_at = ? WHERE id = ?",
    )
      .bind(discordUser.username, discordUser.global_name ?? null, nowIso(), existing.id)
      .run();
    return {
      created: false,
      identity: existing,
      user: {
        id: existing.user_id,
        email: existing.email,
        displayName: existing.user_display_name,
        role: existing.role,
        platformAdmin: Boolean(existing.platform_admin),
        capabilities: existing.capabilities_json
          ? (JSON.parse(existing.capabilities_json) as string[])
          : [],
        selfGrantsEnabled: Boolean(existing.self_grants_enabled),
        grantLimit: Number(existing.grant_limit ?? 0),
        capabilityRevision: Number(existing.capability_revision ?? 1),
      },
    };
  }

  const email = `discord.${discordUser.id}@players.foilbury.invalid`;
  let user = await first<{
    id: string;
    email: string;
    display_name: string;
    platform_admin: number;
    disabled_at: string | null;
  }>(
    env.DB,
    "SELECT id, email, display_name, platform_admin, disabled_at FROM fb_users WHERE email = ?",
    email,
  );
  let created = false;
  if (!user) {
    const userId = newId("usr");
    try {
      await env.DB.prepare(
        "INSERT INTO fb_users (id, email, display_name, password_hash, platform_admin, created_at) VALUES (?, ?, ?, 'discord_only$no_password', 0, ?)",
      )
        .bind(userId, email, displayName, nowIso())
        .run();
      user = { id: userId, email, display_name: displayName, platform_admin: 0, disabled_at: null };
      created = true;
    } catch (error) {
      if (!String(error).includes("UNIQUE")) throw error;
      user = await first<{
        id: string;
        email: string;
        display_name: string;
        platform_admin: number;
        disabled_at: string | null;
      }>(
        env.DB,
        "SELECT id, email, display_name, platform_admin, disabled_at FROM fb_users WHERE email = ?",
        email,
      );
    }
  }
  if (!user)
    throw new ApiError(500, "player_create_failed", "The player identity could not be created.");
  if (user.disabled_at)
    throw new ApiError(403, "account_disabled", "This player account is disabled.");

  // A partially created account may already have a membership. Never let a
  // later interaction silently reactivate a revoked or suspended membership.
  const priorMembership = await first<{ status: string; revoked_at: string | null }>(
    env.DB,
    "SELECT status, revoked_at FROM fb_memberships WHERE tenant_id = ? AND user_id = ?",
    tenant.id,
    user.id,
  );
  if (priorMembership && (priorMembership.status !== "active" || priorMembership.revoked_at)) {
    throw new ApiError(
      403,
      "membership_revoked",
      "This player is no longer an active member of this Bot. Nothing was changed.",
    );
  }
  if (!priorMembership) await addMembership(env.DB, tenant.id, user.id, "player");
  await ensureWallet(env.DB, tenant.id, user.id);

  const starterKey = `starter:${tenant.id}:${user.id}`;
  const alreadyGranted = await first<{ id: string }>(
    env.DB,
    "SELECT id FROM fb_ledger_entries WHERE tenant_id = ? AND user_id = ? AND idempotency_key = ?",
    tenant.id,
    user.id,
    starterKey,
  );
  if (!alreadyGranted) {
    const economy = await first<{ starter_grant: number }>(
      env.DB,
      "SELECT starter_grant FROM fb_economy_settings WHERE tenant_id = ?",
      tenant.id,
    );
    if (economy && economy.starter_grant > 0) {
      try {
        await creditWallet(env.DB, {
          tenantId: tenant.id,
          userId: user.id,
          amount: economy.starter_grant,
          kind: "issue",
          description: "Welcome to Foilbury",
          idempotencyKey: starterKey,
          referenceType: "welcome_reward",
          metadata: { source: "discord_first_interaction" },
          actorType: "system",
          actorId: "discord",
        });
      } catch (error) {
        if (!String(error).includes("UNIQUE")) throw error;
      }
    }
  }

  const identityId = newId("dci");
  try {
    await env.DB.prepare(
      `INSERT INTO fb_discord_identities
        (id, tenant_id, discord_user_id, user_id, username, global_name, linked_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        identityId,
        tenant.id,
        discordUser.id,
        user.id,
        discordUser.username,
        discordUser.global_name ?? null,
        nowIso(),
        nowIso(),
      )
      .run();
  } catch (error) {
    if (!String(error).includes("UNIQUE")) throw error;
  }

  const resolved = await first<
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
      tenant_name: string;
    }
  >(
    env.DB,
    `SELECT di.*, u.email, u.display_name AS user_display_name, u.platform_admin, u.disabled_at, m.role, t.name AS tenant_name
       FROM fb_discord_identities di
       JOIN fb_users u ON u.id = di.user_id
       JOIN fb_memberships m ON m.user_id = u.id AND m.tenant_id = di.tenant_id
       JOIN fb_tenants t ON t.id = di.tenant_id
      WHERE di.tenant_id = ? AND di.discord_user_id = ? AND di.revoked_at IS NULL`,
    tenant.id,
    discordUser.id,
  );
  if (!resolved)
    throw new ApiError(500, "player_link_failed", "The Discord identity could not be linked.");
  return {
    created,
    identity: resolved,
    user: {
      id: resolved.user_id,
      email: resolved.email,
      displayName: resolved.user_display_name,
      role: resolved.role,
      platformAdmin: Boolean(resolved.platform_admin),
    },
  };
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
    await env.DB.prepare(
      "UPDATE fb_discord_identities SET username = ?, global_name = ?, last_seen_at = ? WHERE id = ?",
    )
      .bind(discordUser.username, discordUser.global_name ?? null, now, existingForDiscord.id)
      .run();
    return {
      ...existingForDiscord,
      username: discordUser.username,
      global_name: discordUser.global_name ?? null,
      last_seen_at: now,
    };
  }
  await ensureWallet(env.DB, tenant.id, user.id);
  const id = newId("dci");
  try {
    await env.DB.prepare(
      `INSERT INTO fb_discord_identities
        (id, tenant_id, discord_user_id, user_id, username, global_name, linked_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
      )
      .run();
  } catch (error) {
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
  return linked;
}

export function buildDiscordContext(
  env: DiscordEnv,
  tenant: Tenant,
  user: CurrentUser,
  interaction: DiscordInteraction,
): Ctx {
  const discordUser = interactionUser(interaction);
  return {
    db: env.DB,
    media: env.MEDIA,
    config: readConfig(env),
    requestId: `discord:${interaction.id}`,
    clientKey: `discord:${discordUser.id}`,
    ...(interaction.guild_id && interaction.channel_id ? { discordPrincipal: { discordUserId:discordUser.id,applicationId:interaction.application_id,guildId:interaction.guild_id,channelId:interaction.channel_id } } : {}),
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
