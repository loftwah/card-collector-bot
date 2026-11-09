#!/usr/bin/env node
/**
 * Read-only Discord showcase preflight.
 *
 * Verifies the configured application, guild, channel, command registration,
 * member album, renders, achievements, channel audience policy and test
 * identities. It never draws, grants, spends, posts or calls a paid provider.
 *
 * Usage:
 *   pnpm demo:discord:check           # production configuration
 *   pnpm demo:discord:check --local   # local installation/database
 *   pnpm demo:discord:check --json
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DISCORD_COMMANDS } from "../../src/server/discord/command-definitions.ts";

const args = new Set(process.argv.slice(2));
const local = args.has("--local");
const acceptance = args.has("--acceptance");
const jsonOutput = args.has("--json");
const root = process.cwd();
const env = readEnv(path.join(root, ".env"));
const checks = [];
let deployedBuild = null;

function readEnv(file) {
  const values = {};
  if (!fs.existsSync(file)) return values;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) values[match[1]] = match[2].trim();
  }
  return values;
}

function add(id, status, detail) {
  checks.push({ id, status, detail });
}

function findLocalDatabase() {
  const base = path.join(root, ".wrangler/state/v3/d1");
  if (!fs.existsSync(base)) return null;
  for (const entry of fs.readdirSync(base, { recursive: true })) {
    const file = path.join(base, String(entry));
    if (!file.endsWith(".sqlite") || file.endsWith("metadata.sqlite")) continue;
    try {
      const tables = execFileSync(
        "sqlite3",
        [
          file,
          "SELECT name FROM sqlite_master WHERE type='table' AND name='fb_discord_installations';",
        ],
        {
          encoding: "utf8",
        },
      ).trim();
      if (tables) return file;
    } catch {
      // Not the application database.
    }
  }
  return null;
}

function sqliteRows(file, sql) {
  const output = execFileSync("sqlite3", ["-json", file, sql], { encoding: "utf8" }).trim();
  return output ? JSON.parse(output) : [];
}

function remoteRows(sql) {
  const output = execFileSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "execute",
      "foilbury",
      "--config",
      "wrangler.production.jsonc",
      "--remote",
      "--json",
      "--command",
      sql,
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  const parsed = JSON.parse(output.slice(output.indexOf("[")));
  return Array.isArray(parsed) ? (parsed[0]?.results ?? []) : (parsed.results ?? []);
}

function rows(sql) {
  const file = local ? findLocalDatabase() : null;
  if (local) {
    if (!file) throw new Error("Local D1 database was not found. Run pnpm setup:local first.");
    return sqliteRows(file, sql);
  }
  return remoteRows(sql);
}

function compareCommandSchema(actual, expected) {
  if (!expected) return ["source command definition is missing"];
  const problems = [];
  const walk = (actualOptions = [], expectedOptions = [], path = "") => {
    if (actualOptions.length !== expectedOptions.length) {
      problems.push(`${path || "options"} count ${actualOptions.length}/${expectedOptions.length}`);
    }
    for (const expectedOption of expectedOptions) {
      const actualOption = actualOptions.find((option) => option.name === expectedOption.name);
      const label = `${path}${path ? "." : ""}${expectedOption.name}`;
      if (!actualOption) {
        problems.push(`${label} missing`);
        continue;
      }
      if (actualOption.type !== expectedOption.type) {
        problems.push(`${label} type ${actualOption.type}/${expectedOption.type}`);
      }
      if (Boolean(actualOption.required) !== Boolean(expectedOption.required)) {
        problems.push(`${label} required ${Boolean(actualOption.required)}/${Boolean(expectedOption.required)}`);
      }
      walk(actualOption.options ?? [], expectedOption.options ?? [], label);
    }
  };
  if (actual?.description !== expected.description) problems.push("description differs");
  walk(actual?.options ?? [], expected.options ?? []);
  return problems;
}

const PERMISSIONS = {
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  MANAGE_MESSAGES: 1n << 13n,
  EMBED_LINKS: 1n << 14n,
  ATTACH_FILES: 1n << 15n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  PIN_MESSAGES: 1n << 51n,
  ADMINISTRATOR: 1n << 3n,
};

function computePermissions({ guild, channel, member, roles, botUserId }) {
  if (member?.user?.id === guild.owner_id) return (1n << 64n) - 1n;
  const everyone = roles.find((role) => role.id === guild.id);
  let permissions = BigInt(everyone?.permissions ?? "0");
  for (const roleId of member?.roles ?? []) {
    const role = roles.find((item) => item.id === roleId);
    if (role) permissions |= BigInt(role.permissions ?? "0");
  }
  if ((permissions & PERMISSIONS.ADMINISTRATOR) === PERMISSIONS.ADMINISTRATOR) {
    return (1n << 64n) - 1n;
  }
  const overwriteEveryone = (channel.permission_overwrites ?? []).find((item) => item.id === guild.id);
  if (overwriteEveryone) {
    permissions &= ~BigInt(overwriteEveryone.deny ?? "0");
    permissions |= BigInt(overwriteEveryone.allow ?? "0");
  }
  let allow = 0n;
  let deny = 0n;
  for (const roleId of member?.roles ?? []) {
    const overwrite = (channel.permission_overwrites ?? []).find((item) => item.id === roleId);
    if (overwrite) {
      allow |= BigInt(overwrite.allow ?? "0");
      deny |= BigInt(overwrite.deny ?? "0");
    }
  }
  permissions &= ~deny;
  permissions |= allow;
  const memberOverwrite = (channel.permission_overwrites ?? []).find((item) => item.id === botUserId);
  if (memberOverwrite) {
    permissions &= ~BigInt(memberOverwrite.deny ?? "0");
    permissions |= BigInt(memberOverwrite.allow ?? "0");
  }
  return permissions;
}

function hasPermission(permissions, bit) {
  return (permissions & bit) === bit;
}

async function discord(pathname) {
  const token = env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error("DISCORD_BOT_TOKEN is not configured.");
  const response = await fetch(`https://discord.com/api/v10${pathname}`, {
    headers: { authorization: `Bot ${token}`, "user-agent": "Foilbury-preflight/1.0" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Discord HTTP ${response.status} for ${pathname}`);
  return response.json();
}

const guildId = env.DISCORD_TEST_GUILD_ID;
const channelId = env.DISCORD_TEST_CHANNEL_ID;
const applicationId = env.DISCORD_APPLICATION_ID;
const origin = local
  ? "http://localhost:5173"
  : env.FOILBURY_PUBLIC_ORIGIN || "https://foilbury.loftwah.com";

try {
  const status = await fetch(`${origin}/api/v1/status`, { signal: AbortSignal.timeout(10_000) });
  const statusBody = await status.json().catch(() => null);
  deployedBuild = status.headers.get("x-foilbury-build");
  add(
    "origin",
    status.ok && statusBody?.name === "Foilbury" ? "PASS" : "FAIL",
    `${origin} · HTTP ${status.status} · ${statusBody?.name ?? "unexpected body"}`,
  );
  const interactionProbe = await fetch(`${origin}/api/discord/interactions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(10_000),
  });
  add(
    "interactions endpoint",
    [401, 400].includes(interactionProbe.status) ? "PASS" : "FAIL",
    `Unsigned probe returned HTTP ${interactionProbe.status}; expected 401/400, not a 404 or 5xx.`,
  );
} catch (error) {
  add("origin", "BLOCKED", error instanceof Error ? error.message : String(error));
}

if (!applicationId || !guildId || !channelId) {
  add(
    "Discord configuration",
    "BLOCKED",
    "Set DISCORD_APPLICATION_ID, DISCORD_TEST_GUILD_ID and DISCORD_TEST_CHANNEL_ID in .env.",
  );
} else {
  try {
    const [application, guild, channel, commands] = await Promise.all([
      discord("/applications/@me"),
      discord(`/guilds/${guildId}`),
      discord(`/channels/${channelId}`),
      discord(`/applications/${applicationId}/guilds/${guildId}/commands`),
    ]);
    add(
      "application",
      application.id === applicationId ? "PASS" : "FAIL",
      `${application.name} · ${application.id}`,
    );
    add("guild", guild.id === guildId ? "PASS" : "FAIL", `${guild.name} · ${guild.id}`);
    add(
      "channel",
      channel.guild_id === guildId ? "PASS" : "FAIL",
      `#${channel.name} · ${channel.id}`,
    );
    const command = commands.find((item) => item.name === "foilbury");
    const expected = DISCORD_COMMANDS.find((item) => item.name === "foilbury");
    const mismatches = compareCommandSchema(command, expected);
    add(
      "command schema",
      command && mismatches.length === 0 ? "PASS" : "FAIL",
      command
        ? `foilbury ${command.id} · ${mismatches.length === 0 ? "complete schema matches the source definition" : `mismatch: ${mismatches.slice(0, 6).join("; ")}`}`
        : "The /foilbury guild command is not registered.",
    );

    // The persistent tour entry is part of the visible product, not a probe.
    // Read it back by the recorded message id (or find the newest bot-authored
    // entry) and assert that it still carries a real tour component.
    let tourEntry = null;
    const stateFile = path.join(root, ".foilbury", "discord-tour-entry.json");
    let recordedId = null;
    try {
      recordedId = JSON.parse(fs.readFileSync(stateFile, "utf8")).message_id ?? null;
    } catch {
      recordedId = null;
    }
    if (recordedId) {
      try {
        tourEntry = await discord(
          `/channels/${channelId}/messages/${encodeURIComponent(recordedId)}`,
        );
      } catch {
        tourEntry = null;
      }
    }
    if (!tourEntry) {
      const recent = await discord(`/channels/${channelId}/messages?limit=100`);
      tourEntry =
        recent.find(
          (item) =>
            item.author?.bot === true &&
            (item.components ?? [])
              .flatMap((row) => row.components ?? [])
              .some((component) => component.custom_id === "foilbury:tour:welcome"),
        ) ?? null;
    }
    const tourComponents = (tourEntry?.components ?? []).flatMap((row) => row.components ?? []);
    const hasTourButton = tourComponents.some(
      (component) => component.custom_id === "foilbury:tour:welcome",
    );
    const hasTourLink = tourComponents.some(
      (component) => typeof component.url === "string" && component.url.includes("/tour"),
    );
    add(
      "tour entry",
      tourEntry && hasTourButton ? "PASS" : "FAIL",
      tourEntry
        ? `https://discord.com/channels/${guildId}/${channelId}/${tourEntry.id} · ${hasTourButton ? "interactive Start the tour control" : "missing interactive tour control"}${hasTourLink ? " · web tour link" : ""}`
        : "No persistent Start the Foilbury tour entry was found in the configured channel. Run pnpm discord:tour:entry.",
    );

    // A real production draw is a separate authorised human step. The safe
    // default gate is the emitted Worker against an isolated D1/R2 fixture.
    const healthFile = path.join(root, ".foilbury", "evidence", "discord-command-health.json");
    let health = null;
    try {
      health = JSON.parse(fs.readFileSync(healthFile, "utf8"));
    } catch {
      health = null;
    }
    const healthAgeHours = health?.generated_at
      ? (Date.now() - Date.parse(health.generated_at)) / 3_600_000
      : null;
    const healthFresh = healthAgeHours !== null && healthAgeHours >= 0 && healthAgeHours <= 24;
    const healthBuildMatches =
      !deployedBuild || !health?.source_sha || health.source_sha === deployedBuild;
    add(
      "command execution health",
      health?.passed === true && healthFresh && healthBuildMatches ? "PASS" : "BLOCKED",
      health?.passed === true && healthFresh && healthBuildMatches
        ? `Emitted Worker fixture draw passed · ${health.tests_passed} test(s) · source ${String(health.source_sha).slice(0, 12)} · ${health.generated_at}. This does not prove a live production draw.`
        : health?.passed === true && !healthFresh
          ? "The emitted-Worker command receipt is stale. Run pnpm discord:command-health."
          : health?.passed === true && !healthBuildMatches
            ? `The command receipt is for source ${String(health.source_sha).slice(0, 12)}, not deployed ${String(deployedBuild).slice(0, 12)}. Run pnpm discord:command-health against the reviewed build.`
            : "No recent emitted-Worker draw receipt. Run pnpm discord:command-health; a live production draw remains a separate authorised human step.",
    );

    const everyoneOverwrite = (channel.permission_overwrites ?? []).find(
      (overwrite) => overwrite.id === guildId,
    );
    const viewBit = 1n << 10n;
    const denied = Boolean(everyoneOverwrite && (BigInt(everyoneOverwrite.deny) & viewBit) !== 0n);
    const allowed = Boolean(
      everyoneOverwrite && (BigInt(everyoneOverwrite.allow) & viewBit) !== 0n,
    );

    const botUserId = application.bot?.id ?? applicationId;
    const [roles, member] = await Promise.all([
      discord(`/guilds/${guildId}/roles`),
      discord(`/guilds/${guildId}/members/${botUserId}`),
    ]);
    const permissions = computePermissions({ guild, channel, member, roles, botUserId });
    const required = ["VIEW_CHANNEL", "SEND_MESSAGES", "EMBED_LINKS", "ATTACH_FILES", "READ_MESSAGE_HISTORY"];
    const missing = required.filter((name) => !hasPermission(permissions, PERMISSIONS[name]));
    add(
      "bot effective permissions",
      missing.length === 0 ? "PASS" : "FAIL",
      missing.length === 0
        ? `${botUserId} can view, send, embed, attach and read history in #${channel.name}`
        : `missing in #${channel.name}: ${missing.join(", ")}`,
    );
    const canPin =
      hasPermission(permissions, PERMISSIONS.PIN_MESSAGES) ||
      hasPermission(permissions, PERMISSIONS.MANAGE_MESSAGES) ||
      hasPermission(permissions, PERMISSIONS.ADMINISTRATOR);
    add(
      "pin capability",
      canPin ? "PASS" : "BLOCKED",
      hasPermission(permissions, PERMISSIONS.PIN_MESSAGES)
        ? "PIN_MESSAGES is effective; pinning does not require MANAGE_MESSAGES."
        : canPin
          ? "PIN_MESSAGES is absent but another granted permission covers pinning; do not request MANAGE_MESSAGES merely to pin."
          : "The bot cannot pin. This blocks pinning only, not command integration or local transport tests.",
    );
    add(
      "channel visibility",
      "BLOCKED",
      denied
        ? "@everyone is explicitly denied View Channel, but other roles, member overwrites and administrators may still have access. Durable viewer authorisation is unverified."
        : allowed
          ? "An @everyone overwrite explicitly allows View Channel; the channel is public to guild members."
          : "No explicit @everyone View Channel override; effective permissions and inherited overwrites must be reviewed for all potential viewers.",
    );
    const spectatorEvidenceFile = process.env.FOILBURY_SPECTATOR_EVIDENCE;
    let spectator = null;
    if (spectatorEvidenceFile) {
      try {
        spectator = JSON.parse(fs.readFileSync(spectatorEvidenceFile, "utf8"));
      } catch {
        spectator = null;
      }
    }
    add(
      "spectator observation",
      spectator?.observed === true && spectator?.actor_id ? "PASS" : "BLOCKED",
      spectator?.observed === true && spectator?.actor_id
        ? `Independent actor ${spectator.actor_id} observed the delivered message at ${spectator.observed_at ?? "a recorded time"}.`
        : "No independent authorised identity has observed anything. A second tab of the same account is not a spectator. Use the assisted acceptance runner and record the observation artifact.",
    );
  } catch (error) {
    add("Discord API", "BLOCKED", error instanceof Error ? error.message : String(error));
  }
}

try {
  const installations = rows(
    `SELECT id, guild_id, channel_allowlist_json, game_enabled, active, channel_audience_json
       FROM fb_discord_installations WHERE application_id = '${String(applicationId).replaceAll("'", "''")}' AND active = 1 AND revoked_at IS NULL`,
  );
  const installation = installations.find((item) => item.guild_id === guildId);
  add(
    "installation",
    installation && Number(installation.game_enabled) === 1 ? "PASS" : "FAIL",
    installation
      ? `Active installation ${installation.id} · game ${installation.game_enabled ? "enabled" : "disabled"} · channel policy ${installation.channel_audience_json ?? "{}"}`
      : "No active installation for this guild and application.",
  );
  if (installation) {
    const allowlist = JSON.parse(installation.channel_allowlist_json || "[]");
    add(
      "channel allowlist",
      Array.isArray(allowlist) && allowlist.includes(channelId) ? "PASS" : "FAIL",
      JSON.stringify(allowlist),
    );
    const policy = JSON.parse(installation.channel_audience_json || "{}");
    const configured = policy[channelId];
    // A channel overwrite or a historical census does not establish a
    // revocable mapping between Discord viewers and Foilbury members.
    add(
      "reveal policy",
      "BLOCKED",
      `Stored channel audience is ${configured ?? "public (default)"}; durable viewer-to-membership authorisation and deployed share enforcement are not established by this probe. Restricted channel shares must remain blocked.`,
    );
  }

  const collection = rows(
    `SELECT id, slug, name, status, view_audience, release_version
       FROM fb_collections WHERE slug = 'danganronpa-three-games' AND archived_at IS NULL`,
  )[0];
  add(
    "selected album",
    collection && collection.status === "published" && collection.view_audience === "members"
      ? "PASS"
      : "FAIL",
    collection
      ? `${collection.name} · release ${collection.release_version} · ${collection.view_audience}`
      : "Missing Danganronpa album.",
  );
  if (collection) {
    const cards = rows(
      `SELECT COUNT(*) AS cards FROM fb_collection_cards cc
         JOIN fb_card_definitions cd ON cd.id = cc.card_id AND cd.status = 'published' AND cd.archived_at IS NULL
        WHERE cc.collection_id = '${collection.id}'`,
    )[0];
    add(
      "album roster",
      Number(cards?.cards) > 0 ? "PASS" : "FAIL",
      `${cards?.cards ?? 0} published cards · collection release ${collection.release_version ?? 1} (no universal eight-card ceiling)`,
    );
    const renders = rows(
      `SELECT
         (SELECT COUNT(DISTINCT v.id) FROM fb_collection_cards cc
            JOIN fb_variants v ON v.card_id = cc.card_id AND v.status = 'published' AND v.archived_at IS NULL
           WHERE cc.collection_id = '${collection.id}') AS variants,
         (SELECT COUNT(DISTINCT vr.variant_id) FROM fb_collection_cards cc
            JOIN fb_variants v ON v.card_id = cc.card_id AND v.status = 'published' AND v.archived_at IS NULL
            JOIN fb_variant_renders vr ON vr.variant_id = v.id AND vr.status = 'published'
           WHERE cc.collection_id = '${collection.id}') AS fronts,
         (SELECT COUNT(DISTINCT br.variant_id) FROM fb_collection_cards cc
            JOIN fb_variants v ON v.card_id = cc.card_id AND v.status = 'published' AND v.archived_at IS NULL
            JOIN fb_variant_back_renders br ON br.variant_id = v.id AND br.status = 'published'
           WHERE cc.collection_id = '${collection.id}') AS backs`,
    )[0];
    add(
      "album renders",
      Number(renders?.fronts) === Number(renders?.variants) &&
        Number(renders?.backs) === Number(renders?.variants)
        ? "PASS"
        : "FAIL",
      `${renders?.fronts ?? 0}/${renders?.variants ?? 0} fronts · ${renders?.backs ?? 0}/${renders?.variants ?? 0} backs`,
    );
    const achievements = rows(
      `SELECT key, name, criteria_json FROM fb_achievement_definitions
        WHERE status = 'active' AND criteria_json LIKE '%${collection.id}%'`,
    );
    const parsedAchievements = achievements
      .map((achievement) => {
        try {
          return { ...achievement, criteria: JSON.parse(achievement.criteria_json) };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const completion = parsedAchievements.sort(
      (left, right) =>
        Number(right.criteria?.target ?? 0) - Number(left.criteria?.target ?? 0),
    )[0];
    const roster = completion?.criteria?.roster_card_ids?.length ?? 0;
    const target = Number(completion?.criteria?.target ?? 0);
    add(
      "completion achievement",
      completion && roster > 0 && target > 0 && roster === target
        ? "PASS"
        : "FAIL",
      completion
        ? `${completion.name} · frozen roster ${roster} · target ${target} · current published cards ${Number(cards?.cards ?? 0)} · collection release ${collection.release_version ?? 1}. Additions do not rewrite the frozen roster.`
        : "No collection achievement.",
    );
  }

  const showcase = rows(
    "SELECT COUNT(*) AS count FROM fb_collections WHERE status = 'published' AND view_audience = 'public' AND public_approved_at IS NOT NULL AND archived_at IS NULL",
  )[0];
  add(
    "public showcase",
    Number(showcase?.count) > 0 ? "PASS" : "FAIL",
    `${showcase?.count ?? 0} approved public collections`,
  );

  const identities = rows(
    `SELECT COUNT(*) AS count,
            SUM(CASE WHEN u.platform_admin = 1 THEN 1 ELSE 0 END) AS platform_admins
       FROM fb_discord_identities di JOIN fb_users u ON u.id = di.user_id
      WHERE di.revoked_at IS NULL`,
  )[0];
  add(
    "linked identity presence",
    local ? "BLOCKED" : Number(identities?.count) > 0 ? "PASS" : "FAIL",
    local
      ? "Local D1 has no production Discord identities. Verify the owner identity on the deployed installation instead."
      : `${identities?.count ?? 0} linked Discord identities · ${identities?.platform_admins ?? 0} platform admin links`,
  );
  let actorEvidence = null;
  if (process.env.FOILBURY_ACTOR_EVIDENCE) {
    try {
      actorEvidence = JSON.parse(fs.readFileSync(process.env.FOILBURY_ACTOR_EVIDENCE, "utf8"));
    } catch {
      actorEvidence = null;
    }
  }
  add(
    "authenticated actor session",
    actorEvidence?.authenticated === true && actorEvidence?.actor_id ? "PASS" : "BLOCKED",
    actorEvidence?.authenticated === true && actorEvidence?.actor_id
      ? `Recorded authenticated actor ${actorEvidence.actor_id}.`
      : "A linked identity row is not a usable authenticated actor session. Run the assisted runner with a real authorised sign-in; do not infer a session from D1.",
  );
} catch (error) {
  add("database", "BLOCKED", error instanceof Error ? error.message : String(error));
}

const failed = checks.filter((check) => check.status === "FAIL");
const blocked = checks.filter((check) => check.status === "BLOCKED");
const passed = checks.filter((check) => check.status === "PASS");
const acceptanceVerdict =
  failed.length > 0 || blocked.length > 0 ? "INCOMPLETE" : "PASS";
const result = {
  generated_at: new Date().toISOString(),
  mode: local ? "local" : "production",
  kind: acceptance ? "acceptance" : "readiness",
  origin,
  checks,
  passed: passed.length,
  failed: failed.length,
  blocked: blocked.length,
  verdict: acceptance ? acceptanceVerdict : failed.length ? "NOT_READY" : "READY_UNTESTED",
  note:
    "This is a readiness probe, not product acceptance. A BLOCKED or unperformed scenario is not a pass.",
};

if (jsonOutput) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(
    `Foilbury Discord ${acceptance ? "acceptance" : "readiness"} probe · ${result.mode} · ${origin}`,
  );
  for (const check of checks)
    console.log(`${check.status.padEnd(7)} ${check.id.padEnd(28)} ${check.detail}`);
  console.log(
    `\n${passed.length} PASS · ${failed.length} FAIL · ${blocked.length} BLOCKED · ${result.verdict}`,
  );
  if (!acceptance) {
    console.log(
      "Readiness only: BLOCKED scenarios are unperformed, not accepted. Re-run with --acceptance only after completing them.",
    );
  }
  console.log("No draw, grant, spend, message or paid provider was used.");
}
if (failed.length) process.exit(1);
if (acceptance && blocked.length) process.exit(2);
process.exit(0);
