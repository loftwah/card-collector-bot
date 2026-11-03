#!/usr/bin/env node
/**
 * Foilbury Discord setup — read-only inspect, propose and diff.
 *
 * This script only uses official Discord REST API GET requests. It never creates,
 * edits or deletes a channel/role/message, never registers a command and never
 * uploads an image. It reads the existing bot token from .env by presence only:
 * the value is used in the Authorization header and is never printed or written
 * to the snapshot, plan or proposal.
 *
 * Usage:
 *   node scripts/discord/setup-plan.mjs
 *   node scripts/discord/setup-plan.mjs --json
 *   node scripts/discord/setup-plan.mjs --select category.foilbury,channel.foilbury-showcase
 *   node scripts/discord/setup-plan.mjs --out .foilbury/discord-setup --no-write
 *
 * Default mode is dry-run. There is intentionally no --apply in this script.
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DISCORD_COMMANDS } from "../../src/server/discord/command-definitions.ts";

export const PLAN_SCHEMA = "foilbury.discord.setup-plan.v1";
export const SNAPSHOT_SCHEMA = "foilbury.discord.setup-snapshot.v1";
export const DEFAULT_OUT_DIR = path.join(process.cwd(), ".foilbury", "discord-setup");
export const BOUND_GUILD_ENV = "DISCORD_TEST_GUILD_ID";
export const APPLICATION_ENV = "DISCORD_APPLICATION_ID";
export const CHANNEL_ENV = "DISCORD_TEST_CHANNEL_ID";
export const TOKEN_ENV = "DISCORD_BOT_TOKEN";

const API_BASE = "https://discord.com/api/v10";
const USER_AGENT = "Foilbury-discord-setup-plan/1.0";
const ALL_PERMISSIONS = (1n << 64n) - 1n;

const PERMISSION_TABLE = [
  ["CREATE_INSTANT_INVITE", 0],
  ["KICK_MEMBERS", 1],
  ["BAN_MEMBERS", 2],
  ["ADMINISTRATOR", 3],
  ["MANAGE_CHANNELS", 4],
  ["MANAGE_GUILD", 5],
  ["ADD_REACTIONS", 6],
  ["VIEW_AUDIT_LOG", 7],
  ["PRIORITY_SPEAKER", 8],
  ["STREAM", 9],
  ["VIEW_CHANNEL", 10],
  ["SEND_MESSAGES", 11],
  ["SEND_TTS_MESSAGES", 12],
  ["MANAGE_MESSAGES", 13],
  ["EMBED_LINKS", 14],
  ["ATTACH_FILES", 15],
  ["READ_MESSAGE_HISTORY", 16],
  ["MENTION_EVERYONE", 17],
  ["USE_EXTERNAL_EMOJIS", 18],
  ["VIEW_GUILD_INSIGHTS", 19],
  ["CONNECT", 20],
  ["SPEAK", 21],
  ["MUTE_MEMBERS", 22],
  ["DEAFEN_MEMBERS", 23],
  ["MOVE_MEMBERS", 24],
  ["USE_VAD", 25],
  ["CHANGE_NICKNAME", 26],
  ["MANAGE_NICKNAMES", 27],
  ["MANAGE_ROLES", 28],
  ["MANAGE_WEBHOOKS", 29],
  ["MANAGE_GUILD_EXPRESSIONS", 30],
  ["USE_APPLICATION_COMMANDS", 31],
  ["REQUEST_TO_SPEAK", 32],
  ["MANAGE_EVENTS", 33],
  ["MANAGE_THREADS", 34],
  ["CREATE_PUBLIC_THREADS", 35],
  ["CREATE_PRIVATE_THREADS", 36],
  ["USE_EXTERNAL_STICKERS", 37],
  ["SEND_MESSAGES_IN_THREADS", 38],
  ["USE_EMBEDDED_ACTIVITIES", 39],
  ["MODERATE_MEMBERS", 40],
  ["VIEW_CREATOR_MONETIZATION_ANALYTICS", 41],
  ["USE_SOUNDBOARD", 42],
  ["CREATE_GUILD_EXPRESSIONS", 43],
  ["CREATE_EVENTS", 44],
  ["SEND_VOICE_MESSAGES", 46],
  ["SEND_POLLS", 49],
  ["USE_EXTERNAL_APPS", 50],
];

export const PERMISSIONS = Object.fromEntries(
  PERMISSION_TABLE.map(([name, bit]) => [name, 1n << BigInt(bit)]),
);
const PERMISSION_ORDER = new Map(PERMISSION_TABLE.map(([name], index) => [name, index]));

export const REQUIRED_BOT_PERMISSIONS = [
  "VIEW_CHANNEL",
  "SEND_MESSAGES",
  "EMBED_LINKS",
  "ATTACH_FILES",
  "READ_MESSAGE_HISTORY",
  "MANAGE_CHANNELS",
  "MANAGE_ROLES",
];

const CHANNEL_TYPES = { 0: "text", 2: "voice", 4: "category", 5: "announcement" };

function channelTypeName(type) {
  return CHANNEL_TYPES[type] ?? `type:${type}`;
}

export function permissionNames(value) {
  let bits;
  try {
    bits = BigInt(value ?? "0");
  } catch {
    return [];
  }
  const names = [];
  for (const [name, bit] of PERMISSION_TABLE) {
    if ((bits & (1n << BigInt(bit))) !== 0n) names.push(name);
  }
  return names;
}

export function permissionMask(names = []) {
  let bits = 0n;
  for (const name of names) {
    const permission = PERMISSIONS[name];
    if (!permission) throw new Error(`Unknown Discord permission: ${name}`);
    bits |= permission;
  }
  return bits;
}

function sortPermissionNames(names = []) {
  return [...names].sort(
    (left, right) => (PERMISSION_ORDER.get(left) ?? 999) - (PERMISSION_ORDER.get(right) ?? 999),
  );
}

function hasPermission(bits, name) {
  return (BigInt(bits) & PERMISSIONS[name]) !== 0n;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function readEnvFile(file = path.join(process.cwd(), ".env")) {
  const values = new Map();
  if (!fs.existsSync(file)) return values;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line || line.trimStart().startsWith("#")) continue;
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) values.set(match[1], match[2].trim());
  }
  return values;
}

/**
 * Resolve the three public identifiers and the token. The token is returned
 * only so the HTTP client can use it; callers must never serialise this object.
 */
export function loadDiscordConfig(env = readEnvFile()) {
  const value = (key) => env.get(key)?.trim() ?? "";
  return {
    token: value(TOKEN_ENV),
    applicationId: value(APPLICATION_ENV),
    guildId: value(BOUND_GUILD_ENV),
    channelId: value(CHANNEL_ENV),
    missing: [
      [TOKEN_ENV, value(TOKEN_ENV)],
      [APPLICATION_ENV, value(APPLICATION_ENV)],
      [BOUND_GUILD_ENV, value(BOUND_GUILD_ENV)],
      [CHANNEL_ENV, value(CHANNEL_ENV)],
    ]
      .filter(([, item]) => !item)
      .map(([key]) => key),
  };
}

export class DiscordApiError extends Error {
  constructor(status, pathname, detail) {
    super(`Discord HTTP ${status} for ${pathname}: ${detail}`);
    this.name = "DiscordApiError";
    this.status = status;
    this.pathname = pathname;
    this.detail = detail;
  }
}

function redact(text, token) {
  let value = String(text ?? "");
  if (token) value = value.split(token).join("[REDACTED]");
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}

export function createDiscordClient(token) {
  if (!token) throw new Error(`${TOKEN_ENV} is missing from .env.`);
  return async function discord(pathname, options = {}) {
    const method = options.method ?? "GET";
    const retries = options.retries ?? 2;
    for (let attempt = 0; ; attempt += 1) {
      let response;
      try {
        response = await fetch(`${API_BASE}${pathname}`, {
          method,
          headers: {
            authorization: `Bot ${token}`,
            "user-agent": USER_AGENT,
            ...(options.body === undefined ? {} : { "content-type": "application/json" }),
          },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: AbortSignal.timeout(20_000),
        });
      } catch (error) {
        throw new Error(`Discord request failed for ${pathname}: ${redact(error?.message, token)}`);
      }

      if (response.status === 429 && attempt < retries) {
        const body = await response.json().catch(() => null);
        const waitMs = Math.min(10_000, Math.ceil(Number(body?.retry_after ?? 1) * 1_000));
        await sleep(waitMs);
        continue;
      }
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const error = new DiscordApiError(
          response.status,
          pathname,
          redact(body || response.statusText, token),
        );
        if (options.optional) return { ok: false, error };
        throw error;
      }
      if (response.status === 204) return null;
      return response.json();
    }
  };
}

async function optionalGet(discord, pathname) {
  try {
    return { ok: true, data: await discord(pathname) };
  } catch (error) {
    if (error instanceof DiscordApiError) {
      return { ok: false, error };
    }
    throw error;
  }
}

function gitRevision() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

function normalizeCommandOption(option) {
  const shape = {
    type: option.type ?? 1,
    name: option.name,
    description: option.description ?? "",
    required: Boolean(option.required),
  };
  if (Array.isArray(option.choices) && option.choices.length) {
    shape.choices = option.choices.map((choice) => ({ name: choice.name, value: choice.value }));
  }
  if (Array.isArray(option.options) && option.options.length) {
    shape.options = option.options.map(normalizeCommandOption);
  }
  return shape;
}

export function normalizeCommandShape(command) {
  return {
    type: command.type ?? 1,
    name: command.name,
    description: command.description ?? "",
    options: (command.options ?? []).map(normalizeCommandOption),
  };
}

function commandSnapshot(command) {
  return {
    id: command.id,
    application_id: command.application_id,
    version: command.version,
    type: command.type ?? 1,
    name: command.name,
    description: command.description ?? "",
    options: (command.options ?? []).map(normalizeCommandOption),
    default_member_permissions: command.default_member_permissions ?? null,
    dm_permission: command.dm_permission ?? null,
    nsfw: command.nsfw ?? false,
  };
}

export function compareCommands(live, expected) {
  const differences = [];
  if (!live) {
    differences.push({ path: "command", issue: "missing" });
    return differences;
  }
  if ((live.type ?? 1) !== (expected.type ?? 1)) {
    differences.push({ path: "type", issue: "changed", live: live.type, expected: expected.type });
  }
  if ((live.description ?? "") !== (expected.description ?? "")) {
    differences.push({
      path: "description",
      issue: "changed",
      live: live.description ?? "",
      expected: expected.description ?? "",
    });
  }
  compareOptionLists(live.options ?? [], expected.options ?? [], "options", differences);
  return differences;
}

function compareOptionLists(liveOptions, expectedOptions, prefix, differences) {
  const liveByName = new Map(liveOptions.map((option) => [option.name, option]));
  const expectedByName = new Map(expectedOptions.map((option) => [option.name, option]));
  for (const [name, expected] of expectedByName) {
    const live = liveByName.get(name);
    if (!live) {
      differences.push({ path: `${prefix}.${name}`, issue: "missing" });
      continue;
    }
    if ((live.type ?? 1) !== (expected.type ?? 1)) {
      differences.push({
        path: `${prefix}.${name}.type`,
        issue: "changed",
        live: live.type,
        expected: expected.type,
      });
    }
    if ((live.description ?? "") !== (expected.description ?? "")) {
      differences.push({
        path: `${prefix}.${name}.description`,
        issue: "changed",
        live: live.description ?? "",
        expected: expected.description ?? "",
      });
    }
    if (Boolean(live.required) !== Boolean(expected.required)) {
      differences.push({
        path: `${prefix}.${name}.required`,
        issue: "changed",
        live: Boolean(live.required),
        expected: Boolean(expected.required),
      });
    }
    compareOptionLists(
      live.options ?? [],
      expected.options ?? [],
      `${prefix}.${name}.options`,
      differences,
    );
    const liveChoices = (live.choices ?? []).map((choice) => `${choice.name}=${choice.value}`);
    const expectedChoices = (expected.choices ?? []).map(
      (choice) => `${choice.name}=${choice.value}`,
    );
    if (liveChoices.join("|") !== expectedChoices.join("|")) {
      differences.push({
        path: `${prefix}.${name}.choices`,
        issue: "changed",
        live: liveChoices,
        expected: expectedChoices,
      });
    }
  }
  for (const name of liveByName.keys()) {
    if (!expectedByName.has(name)) differences.push({ path: `${prefix}.${name}`, issue: "extra" });
  }
}

export function normalizeOverwrites(overwrites = [], guildId) {
  return [...overwrites]
    .map((overwrite) => ({
      id: overwrite.id,
      type: overwrite.type,
      allow: String(BigInt(overwrite.allow ?? "0")),
      deny: String(BigInt(overwrite.deny ?? "0")),
      target: overwrite.id === guildId ? "@everyone" : undefined,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function effectivePermissions(base, roleIds, channel, { administrator, botUserId, guildId }) {
  if (administrator) return ALL_PERMISSIONS;
  let permissions = BigInt(base);
  const overwrites = channel.permission_overwrites ?? [];
  const everyone = overwrites.find((item) => item.id === guildId && item.type === 0);
  if (everyone) {
    permissions = (permissions & ~BigInt(everyone.deny)) | BigInt(everyone.allow);
  }
  let allow = 0n;
  let deny = 0n;
  for (const overwrite of overwrites) {
    if (overwrite.type !== 0 || !roleIds.includes(overwrite.id)) continue;
    allow |= BigInt(overwrite.allow);
    deny |= BigInt(overwrite.deny);
  }
  permissions = (permissions & ~deny) | allow;
  const member = overwrites.find((item) => item.id === botUserId && item.type === 1);
  if (member) {
    permissions = (permissions & ~BigInt(member.deny)) | BigInt(member.allow);
  }
  return permissions;
}

function everyoneView(channel, guildId, everyonePermissions) {
  const overwrite = (channel.permission_overwrites ?? []).find(
    (item) => item.id === guildId && item.type === 0,
  );
  let permissions = BigInt(everyonePermissions);
  if (overwrite) {
    permissions = (permissions & ~BigInt(overwrite.deny)) | BigInt(overwrite.allow);
  }
  return {
    explicit_deny: Boolean(overwrite && BigInt(overwrite.deny) & PERMISSIONS.VIEW_CHANNEL),
    explicit_allow: Boolean(overwrite && BigInt(overwrite.allow) & PERMISSIONS.VIEW_CHANNEL),
    effective_allowed: (permissions & PERMISSIONS.VIEW_CHANNEL) !== 0n,
  };
}

function resolveTargetName({ id, guildId, roles, botUser }) {
  if (id === guildId) return "@everyone";
  const role = roles.find((item) => item.id === id);
  if (role) return `@${role.name}`;
  if (id === botUser.id) return `${botUser.username} (bot member)`;
  return `member:${id}`;
}

export async function collectSnapshot(discord, config) {
  const [application, botUser, guild, roles, channels] = await Promise.all([
    discord("/applications/@me"),
    discord("/users/@me"),
    discord(`/guilds/${config.guildId}`),
    discord(`/guilds/${config.guildId}/roles`),
    discord(`/guilds/${config.guildId}/channels`),
  ]);

  if (application.id !== config.applicationId) {
    throw new Error(
      `The token belongs to application ${application.id}, not the configured ${config.applicationId}.`,
    );
  }
  if (guild.id !== config.guildId) {
    throw new Error(`Discord returned guild ${guild.id}, not the bound ${config.guildId}.`);
  }
  if (botUser.bot !== true) throw new Error("The configured credential is not a bot account.");

  let member;
  try {
    member = await discord(`/guilds/${config.guildId}/members/${botUser.id}`);
  } catch (error) {
    if (error instanceof DiscordApiError && error.status === 404) {
      throw new Error(
        `The Foilbury bot is not a member of guild ${config.guildId}. Install it before planning.`,
      );
    }
    throw error;
  }

  const [guildCommands, globalCommands] = await Promise.all([
    discord(`/applications/${config.applicationId}/guilds/${config.guildId}/commands`),
    discord(`/applications/${config.applicationId}/commands`),
  ]);
  const webhooks = await optionalGet(discord, `/guilds/${config.guildId}/webhooks`);

  const everyoneRole = roles.find((role) => role.id === config.guildId);
  if (!everyoneRole) throw new Error("The guild @everyone role is missing from the role list.");

  let basePermissions = BigInt(everyoneRole.permissions ?? "0");
  const botRoles = roles.filter((role) => member.roles.includes(role.id));
  for (const role of botRoles) basePermissions |= BigInt(role.permissions ?? "0");
  const administrator =
    guild.owner_id === botUser.id || (basePermissions & PERMISSIONS.ADMINISTRATOR) !== 0n;

  const botRoleIds = member.roles;
  const rolePositions = botRoles.map((role) => role.position ?? 0);
  const topPosition = rolePositions.length ? Math.max(...rolePositions) : 0;
  const managedRole = roles.find((role) => role.tags?.bot_id === botUser.id) ?? null;
  const rolesAboveBot = roles
    .filter((role) => role.id !== config.guildId && (role.position ?? 0) > topPosition)
    .map((role) => ({ id: role.id, name: role.name, position: role.position }))
    .sort((left, right) => right.position - left.position);

  const channelSummaries = channels
    .map((channel) => {
      const effective = effectivePermissions(basePermissions, botRoleIds, channel, {
        administrator,
        botUserId: botUser.id,
        guildId: config.guildId,
      });
      const view = everyoneView(channel, config.guildId, everyoneRole.permissions ?? "0");
      return {
        id: channel.id,
        name: channel.name,
        type: channel.type,
        type_name: channelTypeName(channel.type),
        parent_id: channel.parent_id ?? null,
        position: channel.position ?? 0,
        topic: channel.topic ?? null,
        nsfw: Boolean(channel.nsfw),
        permission_overwrites: (channel.permission_overwrites ?? []).map((overwrite) => ({
          id: overwrite.id,
          type: overwrite.type,
          type_name: overwrite.type === 0 ? "role" : "member",
          target_name: resolveTargetName({
            id: overwrite.id,
            guildId: config.guildId,
            roles,
            botUser,
          }),
          allow: String(BigInt(overwrite.allow ?? "0")),
          deny: String(BigInt(overwrite.deny ?? "0")),
          allow_names: permissionNames(overwrite.allow),
          deny_names: permissionNames(overwrite.deny),
        })),
        everyone_view: view,
        bot_permissions: {
          bits: effective.toString(),
          names: permissionNames(effective),
        },
      };
    })
    .sort((left, right) => {
      if (left.type !== right.type) return left.type - right.type;
      return (left.position ?? 0) - (right.position ?? 0) || left.name.localeCompare(right.name);
    });

  return {
    schema: SNAPSHOT_SCHEMA,
    generated_at: new Date().toISOString(),
    source_revision: gitRevision(),
    mode: "read-only",
    application: {
      id: application.id,
      name: application.name,
      description: application.description ?? "",
      icon: application.icon ?? null,
      flags: application.flags ?? 0,
      bot_public: Boolean(application.bot_public),
      bot_require_code_grant: Boolean(application.bot_require_code_grant),
      tags: application.tags ?? [],
      approximate_guild_count: application.approximate_guild_count ?? null,
    },
    bot_user: {
      id: botUser.id,
      username: botUser.username,
      discriminator: botUser.discriminator,
      bot: botUser.bot,
    },
    bot_member: {
      user_id: botUser.id,
      roles: member.roles,
      joined_at: member.joined_at ?? null,
      highest_role_position: topPosition,
      managed_role_id: managedRole?.id ?? null,
      roles_above_bot: rolesAboveBot,
      administrator,
      guild_permissions: {
        bits: basePermissions.toString(),
        names: permissionNames(basePermissions),
      },
    },
    guild: {
      id: guild.id,
      name: guild.name,
      icon: guild.icon ?? null,
      banner: guild.banner ?? null,
      features: guild.features ?? [],
      premium_tier: guild.premium_tier ?? 0,
      premium_subscription_count: guild.premium_subscription_count ?? 0,
      owner_id: guild.owner_id,
      mfa_level: guild.mfa_level ?? 0,
      verification_level: guild.verification_level ?? 0,
      preferred_locale: guild.preferred_locale ?? null,
      nsfw_level: guild.nsfw_level ?? 0,
    },
    roles: roles.map((role) => ({
      id: role.id,
      name: role.name,
      color: role.color,
      hoist: Boolean(role.hoist),
      position: role.position ?? 0,
      managed: Boolean(role.managed),
      mentionable: Boolean(role.mentionable),
      permissions: String(BigInt(role.permissions ?? "0")),
      permission_names: permissionNames(role.permissions),
      tags: role.tags ?? null,
    })),
    channels: channelSummaries,
    commands: {
      guild: guildCommands.map(commandSnapshot),
      global: globalCommands.map(commandSnapshot),
      expected: DISCORD_COMMANDS.map((command) => normalizeCommandShape(command)),
    },
    webhooks: webhooks.ok
      ? {
          status: "ok",
          items: (webhooks.data ?? []).map((webhook) => ({
            id: webhook.id,
            name: webhook.name,
            type: webhook.type,
            channel_id: webhook.channel_id,
            application_id: webhook.application_id ?? null,
          })),
        }
      : { status: "blocked", error: webhooks.error.message, items: [] },
  };
}

export function findChannel(snapshot, channelId) {
  return snapshot.channels.find((channel) => channel.id === channelId);
}

export function findChannelByName(snapshot, name, type, parentId = null) {
  return snapshot.channels.find(
    (channel) => channel.name === name && channel.type === type && channel.parent_id === parentId,
  );
}

function overwriteSpec({ target, targetId, allow, deny, rationale }) {
  return {
    target,
    target_id: targetId,
    allow: sortPermissionNames(allow),
    deny: sortPermissionNames(deny),
    rationale,
  };
}

function channelDesiredOverwrites(snapshot) {
  const everyoneId = snapshot.guild.id;
  const botId = snapshot.bot_user.id;
  return {
    everyoneId,
    botId,
    test: [
      overwriteSpec({
        target: "@everyone",
        targetId: everyoneId,
        allow: ["VIEW_CHANNEL", "READ_MESSAGE_HISTORY", "USE_APPLICATION_COMMANDS"],
        deny: [],
        rationale:
          "Keep the reused test channel readable and usable by guild members. This is a channel-scoped explicit policy, not a guild-wide role change; it does not create a members-only surface.",
      }),
    ],
    showcase: [
      overwriteSpec({
        target: "@everyone",
        targetId: everyoneId,
        allow: ["VIEW_CHANNEL", "READ_MESSAGE_HISTORY"],
        deny: [
          "SEND_MESSAGES",
          "SEND_MESSAGES_IN_THREADS",
          "CREATE_PUBLIC_THREADS",
          "CREATE_PRIVATE_THREADS",
          "MENTION_EVERYONE",
        ],
        rationale:
          "The showcase is public to guild members, read-only for them, and append-only for the Foilbury bot. Only approved public original-IP shares belong here; member art stays ephemeral.",
      }),
      overwriteSpec({
        target: "bot_member",
        targetId: botId,
        allow: [
          "VIEW_CHANNEL",
          "SEND_MESSAGES",
          "EMBED_LINKS",
          "ATTACH_FILES",
          "READ_MESSAGE_HISTORY",
          "ADD_REACTIONS",
        ],
        deny: [],
        rationale:
          "A member-level overwrite scoped to the Foilbury application user. No new Discord role is created. The bot must be able to post and attach public card renders after the @everyone send deny.",
      }),
    ],
  };
}

function beforeChannelState(snapshot, channel, guildId) {
  return {
    exists: true,
    name: channel.name,
    type: channel.type,
    topic: channel.topic ?? null,
    parent_id: channel.parent_id ?? null,
    permission_overwrites: normalizeOverwrites(channel.permission_overwrites, guildId).map(
      ({ id, type, allow, deny }) => ({ id, type, allow, deny }),
    ),
  };
}

function buildActions(snapshot, config) {
  const testChannel = findChannel(snapshot, config.channelId);
  if (!testChannel) {
    throw new Error(
      `Configured channel ${config.channelId} is not in guild ${config.guildId}. Refusing to propose a duplicate.`,
    );
  }
  if (testChannel.name !== "card-collector-test") {
    throw new Error(
      `Configured channel ${config.channelId} is named #${testChannel.name}; expected #card-collector-test. Refusing to treat it as the reusable test channel.`,
    );
  }

  const specs = channelDesiredOverwrites(snapshot);
  const actions = [
    {
      id: "category.foilbury",
      op: "create_channel",
      kind: "category",
      resource: "new category",
      before: null,
      payload: {
        name: "Foilbury",
        type: 4,
        permission_overwrites: [],
      },
      rationale:
        "One small Foilbury section groups only the surfaces that already have a real audience. The category carries no overwrites; each channel states its own policy. No unrelated Loftwah channel is renamed, moved or deleted.",
    },
    {
      id: "channel.card-collector-test",
      op: "edit_channel",
      kind: "text",
      resource_id: testChannel.id,
      before: beforeChannelState(snapshot, testChannel, snapshot.guild.id),
      payload: {
        parent_ref: "category.foilbury",
        topic:
          "Foilbury test bench · public play and demos · member-only art stays private and ephemeral here",
        permission_overwrites: specs.test,
      },
      rationale:
        "Reuse the existing, already-approved test channel rather than creating a duplicate #foilbury-play room. Moving it into the new category and writing a truthful topic make the public audience explicit. There is no @everyone View Channel deny, so member-only artwork must stay ephemeral.",
    },
    {
      id: "channel.foilbury-showcase",
      op: "create_channel",
      kind: "text",
      before: null,
      payload: {
        name: "foilbury-showcase",
        type: 0,
        parent_ref: "category.foilbury",
        topic:
          "Approved Foilbury public showcase · original-IP cards only · member albums and third-party art stay private",
        nsfw: false,
        permission_overwrites: specs.showcase,
      },
      rationale:
        "A dedicated public read-only destination is justified because the test bench is not a showcase and public shares need a stable, obviously public place. The bot still checks each card's effective audience before posting; this channel does not unlock member content.",
    },
  ];

  return {
    actions,
    specs,
    testChannel,
  };
}

function planParentId(action, snapshot) {
  if (!action.payload.parent_ref) return action.payload.parent_id ?? null;
  return findChannelByName(snapshot, "Foilbury", 4)?.id ?? null;
}

function findPlanCreateTarget(action, snapshot) {
  if (action.kind === "category") {
    return snapshot.channels.find(
      (channel) => channel.name === action.payload.name && channel.type === 4,
    );
  }
  const parentId = planParentId(action, snapshot);
  const exact =
    parentId === null
      ? null
      : findChannelByName(snapshot, action.payload.name, action.payload.type, parentId);
  if (exact) return exact;
  return snapshot.channels.find(
    (channel) => channel.name === action.payload.name && channel.type === action.payload.type,
  );
}

function channelOverwritesMatch(channel, specs) {
  const desired = (specs ?? [])
    .map((spec) => ({
      id: spec.target_id,
      type: spec.target === "@everyone" ? 0 : 1,
      allow: permissionMask(spec.allow).toString(),
      deny: permissionMask(spec.deny).toString(),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const live = [...(channel.permission_overwrites ?? [])]
    .map((overwrite) => ({
      id: overwrite.id,
      type: overwrite.type,
      allow: String(BigInt(overwrite.allow)),
      deny: String(BigInt(overwrite.deny)),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return canonicalJson(desired) === canonicalJson(live);
}

function createShapeMatches(action, channel, snapshot) {
  if (!channel) return false;
  if (channel.name !== action.payload.name || channel.type !== action.payload.type) return false;
  if (action.kind === "category") {
    return channelOverwritesMatch(channel, action.payload.permission_overwrites ?? []);
  }
  if (planParentId(action, snapshot) === null) return false;
  if ((channel.parent_id ?? null) !== planParentId(action, snapshot)) return false;
  if ((channel.topic ?? null) !== (action.payload.topic ?? null)) return false;
  if (Boolean(channel.nsfw) !== Boolean(action.payload.nsfw)) return false;
  return channelOverwritesMatch(channel, action.payload.permission_overwrites ?? []);
}

function buildDiff(snapshot, actions) {
  const rows = [];
  for (const action of actions) {
    if (action.op === "create_channel") {
      const existing = findPlanCreateTarget(action, snapshot);
      if (existing) {
        const matches = createShapeMatches(action, existing, snapshot);
        rows.push({
          action_id: action.id,
          status: matches ? "unchanged" : "conflict",
          fields: matches
            ? []
            : [
                {
                  field: "existing",
                  before: `#${existing.name} (${existing.id})`,
                  after: "already exists but does not match the proposal",
                },
              ],
        });
        continue;
      }
      const parent = action.payload.parent_ref
        ? "Foilbury (new category)"
        : action.payload.parent_id
          ? (findChannel(snapshot, action.payload.parent_id)?.name ?? action.payload.parent_id)
          : "guild root";
      const fields = [
        { field: "type", before: null, after: channelTypeName(action.payload.type) },
        { field: "parent", before: null, after: parent },
      ];
      if (action.payload.topic !== undefined) {
        fields.push({ field: "topic", before: null, after: action.payload.topic });
      }
      for (const spec of action.payload.permission_overwrites ?? []) {
        fields.push({
          field: `overwrite:${spec.target}`,
          before: null,
          after: formatSpec(spec),
        });
      }
      rows.push({ action_id: action.id, status: "add", fields });
      continue;
    }

    const before = action.before;
    const current = findChannel(snapshot, action.resource_id);
    const fields = [];
    if (action.payload.parent_ref) {
      const existingParent = findChannelByName(snapshot, "Foilbury", 4);
      if (!existingParent || (before.parent_id ?? null) !== existingParent.id) {
        fields.push({
          field: "parent",
          before: before.parent_id
            ? (findChannel(snapshot, before.parent_id)?.name ?? before.parent_id)
            : "guild root",
          after: existingParent ? `#${existingParent.name}` : "Foilbury (new category)",
        });
      }
    }
    if (action.payload.topic !== undefined && action.payload.topic !== before.topic) {
      fields.push({ field: "topic", before: before.topic, after: action.payload.topic });
    }
    for (const spec of action.payload.permission_overwrites ?? []) {
      const existing = current?.permission_overwrites.find(
        (overwrite) => overwrite.id === spec.target_id,
      );
      const beforeSpec = existing
        ? {
            target: spec.target,
            allow: existing.allow_names,
            deny: existing.deny_names,
          }
        : null;
      const beforeText = beforeSpec ? formatSpec(beforeSpec) : "not set";
      const afterText = formatSpec(spec);
      if (beforeText !== afterText) {
        fields.push({ field: `overwrite:${spec.target}`, before: beforeText, after: afterText });
      }
    }
    rows.push({
      action_id: action.id,
      status: fields.length ? "change" : "unchanged",
      fields,
    });
  }
  return rows;
}

function formatSpec(spec) {
  const allow = spec.allow?.length ? spec.allow.join(", ") : "none";
  const deny = spec.deny?.length ? spec.deny.join(", ") : "none";
  return `allow [${allow}] · deny [${deny}]`;
}

export function buildFindings(snapshot, config) {
  const findings = [];
  const add = (id, status, detail) => findings.push({ id, status, detail });
  const testChannel = findChannel(snapshot, config.channelId);
  const missingPermissions = snapshot.bot_member.administrator
    ? []
    : REQUIRED_BOT_PERMISSIONS.filter(
        (name) => !hasPermission(snapshot.bot_member.guild_permissions.bits, name),
      );

  add(
    "credentials",
    config.token ? "PASS" : "FAIL",
    config.token
      ? `${TOKEN_ENV} is present in .env and is never printed, snapshotted or written to the plan.`
      : `${TOKEN_ENV} is missing from .env.`,
  );
  add(
    "bound_guild",
    snapshot.guild.id === config.guildId ? "PASS" : "FAIL",
    `${snapshot.guild.name} · ${snapshot.guild.id}. This workflow is bound to this guild only.`,
  );
  add(
    "application",
    snapshot.application.id === config.applicationId ? "PASS" : "FAIL",
    `${snapshot.application.name} · ${snapshot.application.id} · bot ${snapshot.bot_user.id}.`,
  );
  add(
    "test_channel",
    testChannel ? "PASS" : "FAIL",
    testChannel
      ? `#${testChannel.name} · ${testChannel.id} · parent ${testChannel.parent_id ?? "guild root"}.`
      : `Configured channel ${config.channelId} is missing from the guild.`,
  );
  add(
    "bot_permissions",
    missingPermissions.length ? "BLOCKED" : "PASS",
    missingPermissions.length
      ? `Missing guild permissions: ${missingPermissions.join(", ")}. Apply will refuse until the owner grants the minimum; this plan is still safe to read.`
      : `All required guild permissions are present: ${REQUIRED_BOT_PERMISSIONS.join(", ")}.`,
  );
  const runtimePermissions = [
    "VIEW_CHANNEL",
    "SEND_MESSAGES",
    "EMBED_LINKS",
    "ATTACH_FILES",
    "READ_MESSAGE_HISTORY",
  ];
  const missingChannelPermissions = testChannel
    ? runtimePermissions.filter(
        (name) => (BigInt(testChannel.bot_permissions.bits) & PERMISSIONS[name]) === 0n,
      )
    : [];
  add(
    "test_channel_permissions",
    !testChannel || missingChannelPermissions.length ? "BLOCKED" : "PASS",
    testChannel
      ? missingChannelPermissions.length
        ? `Effective permissions in #${testChannel.name} are missing: ${missingChannelPermissions.join(", ")}. A role name alone would not prove access; apply refuses until the effective channel permission is present.`
        : `Effective permissions in #${testChannel.name} include ${runtimePermissions.join(", ")}. This is computed from the @everyone role, bot roles and channel overwrites, not from a role name.`
      : "The reused channel is missing, so effective permissions cannot be computed.",
  );
  add(
    "bot_role_hierarchy",
    snapshot.bot_member.highest_role_position > 0 ? "PASS" : "WARN",
    snapshot.bot_member.highest_role_position > 0
      ? `Highest bot role position ${snapshot.bot_member.highest_role_position}; ${snapshot.bot_member.roles_above_bot.length} role(s) above it.`
      : "The bot has no guild role and sits at @everyone level (position 0). It cannot create channels or edit overwrites until the owner grants a dedicated role. No role is created by this proposal.",
  );
  add(
    "everyone_view_deny",
    testChannel?.everyone_view.explicit_deny ? "PASS" : "WARN",
    testChannel?.everyone_view.explicit_deny
      ? `#${testChannel.name} explicitly denies @everyone View Channel.`
      : testChannel && !testChannel.everyone_view.effective_allowed
        ? `#${testChannel.name} has no explicit @everyone View Channel deny, but @everyone's effective View is denied at guild level. Verify the intended audience before treating it as public or private.`
        : `#${testChannel?.name ?? config.channelId} has no explicit @everyone View Channel deny; every guild member can read it. Member-only artwork must stay ephemeral. No permission change is proposed to hide that fact.`,
  );
  add(
    "member_only_surface",
    "BLOCKED",
    "No verified, revocable Discord-role ↔ Foilbury membership mapping exists. A #foilbury-members channel is therefore not proposed: creating it now would either be empty or risk exposing member art. Do not infer membership from guild ownership, @everyone or a role name.",
  );
  add(
    "spectator",
    "BLOCKED",
    "A genuine outsider/spectator check needs a second controlled Discord account. It is a human step; this script does not automate a user account, self-bot or browser login.",
  );

  const features = snapshot.guild.features;
  add(
    "guild_banner",
    features.includes("BANNER") ? "PASS" : "BLOCKED",
    features.includes("BANNER")
      ? `Static guild banner is entitled. Current banner: ${snapshot.guild.banner ? "set" : "not set"}.`
      : `Guild features [${features.join(", ") || "none"}] · premium tier ${snapshot.guild.premium_tier} · boosts ${snapshot.guild.premium_subscription_count}. A static banner needs the BANNER entitlement (Boost tier 2); it is not available to upload now.`,
  );
  add(
    "animated_guild_banner",
    features.includes("ANIMATED_BANNER") ? "PASS" : "BLOCKED",
    features.includes("ANIMATED_BANNER")
      ? "Animated guild banner is entitled."
      : "Animated guild banner needs the ANIMATED_BANNER entitlement (Boost tier 3) and is not available now.",
  );
  add(
    "application_icon",
    snapshot.application.icon ? "PASS" : "WARN",
    snapshot.application.icon
      ? "The application icon is set. Updating it is a Developer Portal step, not part of this API plan."
      : "No application icon is set; upload one in the Developer Portal.",
  );
  add(
    "application_banner",
    "BLOCKED",
    "The application profile/banner is a Developer Portal surface. The bot API read used here does not prove it can be changed; it is listed as a manual owner step and is not proposed as an API mutation.",
  );

  const command = snapshot.commands.guild.find((item) => item.name === "foilbury");
  const expected = DISCORD_COMMANDS.find((item) => item.name === "foilbury");
  if (!command) {
    add(
      "command_registration",
      "FAIL",
      "The /foilbury guild command is not registered. Run the canonical registration script after approval.",
    );
  } else if (!expected) {
    add("command_registration", "FAIL", "The local command contract has no /foilbury definition.");
  } else {
    const differences = compareCommands(
      { ...command, options: command.options ?? [] },
      { ...expected, options: expected.options ?? [] },
    );
    add(
      "command_registration",
      differences.length ? "WARN" : "PASS",
      differences.length
        ? `${command.id} differs from src/server/discord/command-definitions.ts in ${differences.length} place(s): ${differences
            .slice(0, 12)
            .map((item) => `${item.path} (${item.issue})`)
            .join(
              ", ",
            )}${differences.length > 12 ? " …" : ""}. Command registration is a separate approved write.`
        : `${command.id} matches the local contract.`,
    );
  }
  const globalFoilbury = snapshot.commands.global.find((item) => item.name === "foilbury");
  add(
    "global_commands",
    globalFoilbury ? "WARN" : "PASS",
    globalFoilbury
      ? `A global /foilbury command (${globalFoilbury.id}) also exists. Guild commands and global commands can duplicate in the client.`
      : `No global /foilbury command. ${snapshot.commands.global.length} unrelated global command(s) preserved.`,
  );
  add(
    "webhook_targets",
    snapshot.webhooks.status === "ok" ? "PASS" : "BLOCKED",
    snapshot.webhooks.status === "ok"
      ? `${snapshot.webhooks.items.length} guild webhook(s) readable; no webhook is created, edited or called.`
      : `Guild webhooks are not readable with the current bot rights (${snapshot.webhooks.error}). This is read-only discovery; no webhook is changed.`,
  );
  add(
    "no_destructive_actions",
    "PASS",
    "The proposal contains 0 channel deletions, 0 channel renames, 0 role creations, 0 guild-wide role changes and 0 message posts.",
  );

  return findings;
}

function buildDeferred(snapshot) {
  return [
    {
      id: "channel.foilbury-play",
      decision: "skip",
      summary:
        "Reuse #card-collector-test as the public play/test surface. A second play room would duplicate the existing pilot and add an empty room.",
    },
    {
      id: "channel.foilbury-members",
      decision: "blocked",
      summary:
        "Not proposed until a verified, revocable Discord-role ↔ Foilbury membership mapping exists and the channel explicitly denies @everyone View Channel. A role name alone is not proof of membership.",
      preconditions: [
        "A verified, revocable membership-to-role mapping is implemented and audited.",
        "The Bot Admin records the channel audience only after verification.",
        "A controlled non-member account proves it cannot read the channel.",
      ],
      proposed_overwrites: [
        overwriteSpec({
          target: "@everyone",
          targetId: snapshot.guild.id,
          allow: [],
          deny: ["VIEW_CHANNEL"],
          rationale: "Deny the guild default; only the verified member role may see the channel.",
        }),
      ],
    },
    {
      id: "channel.foilbury-ops",
      decision: "skip",
      summary:
        "Administration stays on the signed-in /admin and /platform-admin surfaces. A Discord ops room would imply server moderator equals platform authority, which is forbidden.",
    },
    {
      id: "channel.foilbury-start",
      decision: "skip",
      summary:
        "Discovery is already provided by the channel topic, /foilbury help and /foilbury tour. A pinned how-to post is a message write and remains a manual owner step; it is not part of this channel plan.",
    },
    {
      id: "commands.registration",
      decision: "manual",
      summary:
        "Live registration drift is reported but not written by the setup apply path. The canonical merge script is pnpm discord:register; it needs a separate approval because it writes command registrations.",
    },
    {
      id: "branding.guild-banner",
      decision: "manual",
      summary:
        "Guild banner entitlement and upload are not bot API operations. Upload is a Server Settings step after the guild reaches the required boost tier.",
    },
  ];
}

function buildRecommendations(snapshot, config) {
  return [
    {
      id: "reuse.card-collector-test",
      channel: "#card-collector-test",
      audience: "public",
      decision: "reuse",
      rationale:
        "Already installed, already allowlisted in the Foilbury Bot and already the approved pilot destination. Reusing it avoids a duplicate test/play room.",
    },
    {
      id: "channel.foilbury-showcase",
      channel: "#foilbury-showcase",
      audience: "public",
      decision: "create",
      rationale:
        "A stable public destination for explicitly approved original-IP shares. Read-only for members; the bot remains the only writer. Member and third-party art stays ephemeral.",
    },
    {
      id: "channel.foilbury-play",
      channel: "#foilbury-play",
      audience: "public",
      decision: "skip",
      rationale:
        "The reused #card-collector-test is the play surface. Creating a second room before there is a separate audience would be an empty duplicate.",
    },
    {
      id: "channel.foilbury-members",
      channel: "#foilbury-members",
      audience: "members",
      decision: "blocked",
      rationale:
        "There is no verified, revocable Discord-role ↔ Foilbury membership mapping. A members-only channel without that mapping is a privacy risk, so it is deliberately not proposed.",
    },
    {
      id: "channel.foilbury-ops",
      channel: "#foilbury-ops",
      audience: "admin",
      decision: "skip",
      rationale:
        "Foilbury admin is web/Cloudflare Access, not Discord guild authority. A Discord ops room is not a substitute and could blur the authority boundary.",
    },
    {
      id: "channel.foilbury-start",
      channel: "#foilbury-start",
      audience: "public",
      decision: "skip",
      rationale:
        "The channel topic, /foilbury help and /foilbury tour already explain first-run play. Avoid an empty how-to room; a pinned post is a manual message step.",
    },
  ];
}

function buildManualSteps(snapshot, config) {
  const portal = `https://discord.com/developers/applications/${config.applicationId}`;
  return [
    {
      id: "grant-bot-permissions",
      owner_action:
        "Grant the Foilbury bot a dedicated guild role with View Channel, Send Messages, Embed Links, Attach Files, Read Message History, Manage Channels and Manage Roles. Do not grant Administrator.",
      why: "The plan creates one category and one channel and edits one channel's overwrites. The current bot has no guild role and lacks Manage Channels/Manage Roles, so apply must refuse.",
      deep_link: `https://discord.com/channels/${config.guildId}/settings/roles`,
    },
    {
      id: "command-registration",
      owner_action:
        "Run pnpm discord:register after reviewing the command diff and giving separate approval.",
      why: "The live /foilbury command is missing missions/npc and has description drift. Registration is a write and is not performed by setup apply.",
    },
    {
      id: "app-profile",
      owner_action:
        "Review the application icon, description, tags, public-bot setting and profile banner in the Developer Portal; upload a server banner only after the guild has the required boost tier.",
      why: "Application profile/cover and guild banner uploads are Developer Portal/Server Settings surfaces, not the channel API used here.",
      deep_link: portal,
    },
    {
      id: "guild-banner",
      owner_action:
        "If a guild banner is desired, reach the required Boost tier and upload it in Server Settings → Overview.",
      why: `The guild reports features [${snapshot.guild.features.join(", ") || "none"}], premium tier ${snapshot.guild.premium_tier} and ${snapshot.guild.premium_subscription_count} boost(s). A static banner is not currently available.`,
      deep_link: `https://discord.com/channels/${config.guildId}/settings/overview`,
    },
    {
      id: "pinned-how-to",
      owner_action:
        "After the channels exist, pin a concise how-to-play message in the reused test channel that links to /foilbury help and the real tour. Do not include admin URLs or personal data.",
      why: "Posting or pinning is a message write. This setup path deliberately does not send messages.",
    },
    {
      id: "spectator",
      owner_action:
        "Use a second controlled Discord account (with explicit consent) to verify that ephemeral responses are invisible and only public showcase shares are readable.",
      why: "A genuine outsider observation cannot be proven from bot API reads. Do not use a self-bot or automate a human account.",
    },
    {
      id: "browser-verification",
      owner_action:
        "Verify the real Discord client on desktop and mobile after apply: category/channel order, topics, read-only showcase, public share, and member-only art remaining ephemeral.",
      why: "API read-back proves configuration, not the rendered client experience.",
    },
  ];
}

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys
    .filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

export function approvalPayload(plan) {
  return {
    schema: plan.schema,
    target: {
      guild_id: plan.target.guild_id,
      application_id: plan.target.application_id,
    },
    reused_channel_id: plan.target.reused_channel_id,
    actions: [...plan.proposal.actions]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((action) => ({
        id: action.id,
        op: action.op,
        kind: action.kind,
        resource_id: action.resource_id ?? null,
        payload: action.payload,
        before: action.before,
      })),
    deferred: [...plan.proposal.deferred]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((item) => ({ id: item.id, decision: item.decision })),
  };
}

export function computePlanDigest(plan) {
  return crypto
    .createHash("sha256")
    .update(canonicalJson(approvalPayload(plan)))
    .digest("hex");
}

export function buildPlan(snapshot, config, options = {}) {
  const { actions, specs } = buildActions(snapshot, config);
  if (options.select?.length) {
    const known = new Set(actions.map((action) => action.id));
    const unknown = options.select.filter((id) => !known.has(id));
    if (unknown.length) {
      throw new Error(
        `Unknown action id(s): ${unknown.join(", ")}. Known ids: ${[...known].join(", ")}.`,
      );
    }
  }
  const selected = options.select?.length
    ? actions.filter((action) => options.select.includes(action.id))
    : actions;
  if (!selected.length) throw new Error("The selection resolved to zero actions.");

  const actionIds = new Set(selected.map((action) => action.id));
  const categoryExists = Boolean(
    findChannelByName(snapshot, "Foilbury", 4, null) ?? findChannelByName(snapshot, "Foilbury", 4),
  );
  for (const action of selected) {
    if (action.payload.parent_ref && !actionIds.has(action.payload.parent_ref) && !categoryExists) {
      throw new Error(
        `Selected action ${action.id} needs ${action.payload.parent_ref}. Include the category action or select nothing.`,
      );
    }
  }

  const diff = buildDiff(snapshot, selected);
  const findings = buildFindings(snapshot, config);
  const conflictCount = diff.filter((row) => row.status === "conflict").length;
  if (conflictCount) {
    findings.push({
      id: "plan_conflicts",
      status: "BLOCKED",
      detail: `${conflictCount} proposed channel/category target(s) already exist but do not match the proposal. Apply will refuse on this drift; resolve it manually or regenerate after review.`,
    });
  }
  const deferred = buildDeferred(snapshot);
  const recommendations = buildRecommendations(snapshot, config);
  const manualSteps = buildManualSteps(snapshot, config);
  const now = new Date().toISOString();
  const plan = {
    schema: PLAN_SCHEMA,
    generated_at: now,
    source_revision: snapshot.source_revision,
    mode: "dry-run",
    target: {
      guild_id: snapshot.guild.id,
      guild_name: snapshot.guild.name,
      application_id: snapshot.application.id,
      application_name: snapshot.application.name,
      reused_channel_id: config.channelId,
    },
    snapshot_sha256: crypto.createHash("sha256").update(canonicalJson(snapshot)).digest("hex"),
    snapshot,
    findings,
    proposal: {
      principles: [
        "Inspect first. The live guild is the authority; this plan never assumes an old preflight result.",
        "Minimal layout: one category, the reused test channel and one justified public showcase channel.",
        "No deletion, no rename of an existing channel, no role creation and no guild-wide permission change.",
        "Restricted art stays ephemeral until a verified members mapping and a genuinely private channel exist.",
        "Manual Developer Portal and boost-gated branding steps are listed honestly rather than faked.",
      ],
      recommendations,
      actions: selected,
      deferred,
      manual_steps: manualSteps,
      diff,
      summary: {
        actions: selected.length,
        creates: diff.filter((row) => row.status === "add").length,
        edits: diff.filter((row) => row.status === "change").length,
        conflicts: diff.filter((row) => row.status === "conflict").length,
        deletes: 0,
        renames: 0,
        role_changes: 0,
        message_posts: 0,
        unchanged: diff.filter((row) => row.status === "unchanged").length,
        skipped_or_blocked: deferred.filter((item) => item.decision !== "manual").length,
      },
      required_bot_permissions: REQUIRED_BOT_PERMISSIONS,
      overwrites: specs,
    },
    approval: {
      required: true,
      applied: false,
      target_guild_id: snapshot.guild.id,
      explicit_guild_required: true,
      digest_required: true,
      note: "This plan was generated read-only. Nothing was created, edited, deleted, registered, posted or uploaded.",
    },
  };

  plan.digest = computePlanDigest(plan);
  plan.plan_id = plan.digest.slice(0, 16);
  plan.approval.command = `pnpm discord:setup:apply --guild ${plan.target.guild_id} --plan ${plan.plan_id} --apply`;
  plan.approval.verify_command = `pnpm discord:setup:verify --guild ${plan.target.guild_id} --plan ${plan.plan_id} --plan-file <plan.json>`;
  return plan;
}

function formatStatus(status) {
  return status.padEnd(7);
}

export function renderProposal(plan) {
  const lines = [];
  lines.push("# Foilbury Discord setup proposal — DRY RUN");
  lines.push("");
  lines.push(`- Generated: ${plan.generated_at}`);
  lines.push(`- Source revision: \`${plan.source_revision}\``);
  lines.push(
    `- Target: **${plan.target.guild_name}** \`${plan.target.guild_id}\` · application **${plan.target.application_name}** \`${plan.target.application_id}\``,
  );
  lines.push(`- Mode: **read-only dry-run**. Nothing was written to Discord.`);
  lines.push(`- Plan id: \`${plan.plan_id}\``);
  lines.push(`- Plan digest: \`${plan.digest}\``);
  lines.push(
    `- Approved action scope: ${plan.proposal.actions.map((action) => `\`${action.id}\``).join(", ")}`,
  );
  lines.push("");
  lines.push("## Findings");
  lines.push("");
  lines.push("| Status | Check | Detail |");
  lines.push("| --- | --- | --- |");
  for (const finding of plan.findings) {
    lines.push(
      `| ${formatStatus(finding.status).trim()} | \`${finding.id}\` | ${finding.detail.replaceAll("|", "\\|")} |`,
    );
  }
  lines.push("");
  lines.push("## Proposed layout");
  lines.push("");
  lines.push("```text");
  lines.push("Foilbury (category, new)");
  lines.push("├── #card-collector-test (reused, public play/test)");
  lines.push("└── #foilbury-showcase (new, public read-only showcase)");
  lines.push("```");
  lines.push("");
  lines.push(
    "The layout shows the full intended section. Only the actions listed under **Changes** are covered by this plan digest; a `--select` plan is a deliberate subset.",
  );
  lines.push("");
  lines.push(
    "Deliberately not created: `#foilbury-play` (the reused test channel is the play surface), `#foilbury-start` (help/tour/topic already cover discovery), `#foilbury-ops` (admin is web/Access, not Discord) and `#foilbury-members` (no verified membership↔role mapping).",
  );
  lines.push("");
  lines.push("## Changes");
  lines.push("");
  for (const row of plan.proposal.diff) {
    const action = plan.proposal.actions.find((item) => item.id === row.action_id);
    lines.push(`### \`${row.action_id}\` — ${row.status}`);
    lines.push("");
    if (action) {
      lines.push(action.rationale);
      lines.push("");
    }
    if (row.fields.length === 0) {
      lines.push("No change; the live state already matches the proposal.");
    } else {
      lines.push("| Field | Before | After |");
      lines.push("| --- | --- | --- |");
      for (const field of row.fields) {
        lines.push(
          `| ${field.field} | ${String(field.before ?? "—").replaceAll("|", "\\|")} | ${String(field.after ?? "—").replaceAll("|", "\\|")} |`,
        );
      }
    }
    lines.push("");
  }
  lines.push("## Exact permission overwrites");
  lines.push("");
  for (const action of plan.proposal.actions) {
    const specs = action.payload.permission_overwrites ?? [];
    lines.push(`### ${action.id}`);
    lines.push("");
    if (!specs.length) {
      lines.push("No overwrites. The category inherits the guild default.");
      lines.push("");
      continue;
    }
    for (const spec of specs) {
      lines.push(
        `- **${spec.target}** \`${spec.target_id}\`: ${formatSpec(spec)}. ${spec.rationale}`,
      );
    }
    lines.push("");
  }
  lines.push("## Command registration");
  lines.push("");
  const commandFinding = plan.findings.find((finding) => finding.id === "command_registration");
  lines.push(commandFinding?.detail ?? "No command check was produced.");
  lines.push("");
  lines.push("## Deferred or blocked");
  lines.push("");
  for (const item of plan.proposal.deferred) {
    lines.push(`- \`${item.id}\` — **${item.decision}**: ${item.summary}`);
    if (item.preconditions?.length) {
      for (const precondition of item.preconditions) lines.push(`  - ${precondition}`);
    }
  }
  lines.push("");
  lines.push("## Manual owner steps (not performed)");
  lines.push("");
  for (const step of plan.proposal.manual_steps) {
    lines.push(`- **${step.id}** — ${step.owner_action}`);
    lines.push(`  - Why: ${step.why}`);
    if (step.deep_link) lines.push(`  - Link: ${step.deep_link}`);
  }
  lines.push("");
  lines.push("## Approval");
  lines.push("");
  lines.push(
    "Apply is a separate, explicitly gated command. It refuses without `--apply`, a matching `--plan` digest and the exact target guild ID. It re-reads live state, aborts on drift, saves a pre-apply snapshot, preserves unrelated overwrites and never deletes a channel.",
  );
  lines.push("");
  lines.push("```sh");
  lines.push(plan.approval.command);
  lines.push("```");
  lines.push("");
  lines.push(
    "To apply only a subset, regenerate the plan with `--select <action,action>` and approve the new digest. Do not edit a plan file after approval.",
  );
  lines.push("");
  lines.push("## Safety");
  lines.push("");
  lines.push(
    `- Snapshot SHA-256: \`${plan.snapshot_sha256}\`. The snapshot contains IDs, names, topics, permissions and command shapes; it contains no token or secret.`,
  );
  lines.push(
    "- No channel deletion, no channel rename, no role creation, no guild-wide role change, no message post, no command registration and no image upload.",
  );
  lines.push(
    "- The reused channel keeps its existing history. Existing unrelated permission overwrites are preserved on edit.",
  );
  lines.push(
    "- Member-only art remains ephemeral. The public showcase is only for explicitly approved public original-IP shares.",
  );
  return `${lines.join("\n")}\n`;
}

function writeFile(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, contents, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function writeJson(file, value) {
  writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function printUsage() {
  console.log(
    [
      "Usage: node scripts/discord/setup-plan.mjs [options]",
      "",
      "Read-only: official Discord GET requests only. Default mode is dry-run.",
      "",
      "Options:",
      "  --guild <id>    Target guild. Must equal DISCORD_TEST_GUILD_ID; any other guild is refused.",
      "  --json          Print a machine-readable summary to stdout (full plan is written to disk).",
      "  --out <dir>     Output directory (default .foilbury/discord-setup).",
      "  --select <ids>  Comma-separated action ids to include in the approved plan.",
      "  --no-write      Compute and print without writing snapshot/plan/proposal files.",
      "  --help          Show this help.",
      "",
      "There is no --apply here. Use scripts/discord/setup-apply.mjs with its explicit gates.",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const options = {
    guild: null,
    out: DEFAULT_OUT_DIR,
    select: [],
    json: false,
    noWrite: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--guild" || argument === "--out" || argument === "--select") {
      const value = argv[(index += 1)];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
      if (argument === "--guild") options.guild = value.trim();
      if (argument === "--out") options.out = path.resolve(value);
      if (argument === "--select") {
        options.select = value
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);
      }
      continue;
    }
    if (argument === "--json") {
      options.json = true;
      continue;
    }
    if (argument === "--no-write") {
      options.noWrite = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--apply") {
      throw new Error(
        "setup-plan.mjs is read-only and has no --apply. Use setup-apply.mjs with --apply, --plan and --guild.",
      );
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printUsage();
    return;
  }

  const config = loadDiscordConfig();
  if (config.missing.length) {
    throw new Error(
      `Missing required .env key(s): ${config.missing.join(", ")}. Values are never printed.`,
    );
  }
  if (options.guild && options.guild !== config.guildId) {
    throw new Error(
      `Refusing guild ${options.guild}. This workflow is bound to ${config.guildId} (${BOUND_GUILD_ENV}).`,
    );
  }

  const discord = createDiscordClient(config.token);
  const snapshot = await collectSnapshot(discord, config);
  const plan = buildPlan(snapshot, config, { select: options.select });

  let snapshotPath = null;
  let planPath = null;
  let proposalPath = null;
  if (!options.noWrite) {
    snapshotPath = path.join(options.out, "snapshot.json");
    planPath = path.join(options.out, "plan.json");
    proposalPath = path.join(options.out, "proposal.md");
    plan.output_paths = { snapshot: snapshotPath, plan: planPath, proposal: proposalPath };
    plan.approval.verify_command = `pnpm discord:setup:verify --guild ${plan.target.guild_id} --plan ${plan.plan_id} --plan-file ${planPath}`;
    writeJson(snapshotPath, snapshot);
    writeJson(planPath, plan);
    writeFile(proposalPath, renderProposal(plan));
  }

  const summary = {
    schema: PLAN_SCHEMA,
    mode: "dry-run",
    generated_at: plan.generated_at,
    source_revision: plan.source_revision,
    read_only: true,
    target: plan.target,
    plan_id: plan.plan_id,
    digest: plan.digest,
    outputs: { snapshot: snapshotPath, plan: planPath, proposal: proposalPath },
    summary: plan.proposal.summary,
    findings: plan.findings,
    required_bot_permissions: plan.proposal.required_bot_permissions,
    missing_bot_permissions: snapshot.bot_member.administrator
      ? []
      : REQUIRED_BOT_PERMISSIONS.filter(
          (name) => !hasPermission(snapshot.bot_member.guild_permissions.bits, name),
        ),
    approval_command: plan.approval.command,
    verify_command: plan.approval.verify_command,
    note: "Dry-run only. No Discord write, message, command registration or upload was performed.",
  };

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(`Foilbury Discord setup plan · DRY RUN · read-only`);
  console.log(
    `Target: ${plan.target.guild_name} (${plan.target.guild_id}) · ${plan.target.application_name} (${plan.target.application_id})`,
  );
  console.log(`Source: ${plan.source_revision} · snapshot ${plan.snapshot_sha256.slice(0, 16)}`);
  console.log(`Plan id: ${plan.plan_id}`);
  console.log(`Digest: ${plan.digest}`);
  console.log("");
  for (const finding of plan.findings) {
    console.log(`${formatStatus(finding.status)} ${finding.id.padEnd(24)} ${finding.detail}`);
  }
  console.log("");
  console.log(
    `Changes: ${plan.proposal.summary.creates} create · ${plan.proposal.summary.edits} edit · ${plan.proposal.summary.unchanged} unchanged · ${plan.proposal.summary.conflicts} conflict · 0 delete`,
  );
  for (const row of plan.proposal.diff) {
    console.log(`  ${row.status.padEnd(9)} ${row.action_id}`);
    for (const field of row.fields) {
      console.log(
        `      ${field.field}: ${String(field.before ?? "—")} -> ${String(field.after ?? "—")}`,
      );
    }
  }
  if (plan.output_paths) {
    console.log("");
    console.log(`Snapshot: ${plan.output_paths.snapshot}`);
    console.log(`Plan:     ${plan.output_paths.plan}`);
    console.log(`Proposal: ${plan.output_paths.proposal}`);
  }
  const blocked = plan.findings.filter((finding) => finding.status === "BLOCKED");
  const failed = plan.findings.filter((finding) => finding.status === "FAIL");
  const healthy = plan.findings.filter((finding) => finding.status === "PASS");
  const warned = plan.findings.filter((finding) => finding.status === "WARN");
  console.log("");
  console.log(
    `${healthy.length} PASS · ${warned.length} WARN · ${failed.length} FAIL · ${blocked.length} BLOCKED`,
  );
  console.log("No Discord write was made. Apply requires explicit --apply, --plan and --guild.");
  console.log(plan.approval.command);
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`Foilbury Discord setup plan failed: ${error?.message ?? error}`);
    process.exitCode = 1;
  });
}
