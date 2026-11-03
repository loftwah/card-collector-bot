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

const args = new Set(process.argv.slice(2));
const local = args.has("--local");
const jsonOutput = args.has("--json");
const root = process.cwd();
const env = readEnv(path.join(root, ".env"));
const checks = [];
let channelDenied = false;

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
    const optionNames = (command?.options ?? []).map((option) => option.name);
    add(
      "command registration",
      command && optionNames.includes("tour") && optionNames.includes("admin") ? "PASS" : "FAIL",
      command
        ? `foilbury ${command.id} · ${optionNames.join(", ")}`
        : "The /foilbury guild command is not registered.",
    );

    const everyoneOverwrite = (channel.permission_overwrites ?? []).find(
      (overwrite) => overwrite.id === guildId,
    );
    const viewBit = 1n << 10n;
    const denied = Boolean(everyoneOverwrite && (BigInt(everyoneOverwrite.deny) & viewBit) !== 0n);
    const allowed = Boolean(
      everyoneOverwrite && (BigInt(everyoneOverwrite.allow) & viewBit) !== 0n,
    );
    channelDenied = denied;
    add(
      "channel visibility",
      denied ? "PASS" : "BLOCKED",
      denied
        ? "@everyone is denied View Channel; this can be treated as a restricted member destination after policy review."
        : allowed
          ? "An @everyone overwrite explicitly allows View Channel; the channel is public to guild members."
          : "No @everyone View Channel override: every guild member can read the channel.",
    );
    add(
      "spectator setup",
      denied ? "PASS" : "BLOCKED",
      denied
        ? "A genuinely non-member spectator cannot read this channel; use a second controlled account that is not a Foilbury member for the outsider test."
        : "The channel is readable by every guild member. Member-only artwork must stay ephemeral here; public original-IP content may be shared.",
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
    add(
      "reveal policy",
      channelDenied
        ? configured === "members" || configured === "private"
          ? "PASS"
          : "BLOCKED"
        : configured === "members" || configured === "private"
          ? "FAIL"
          : "PASS",
      configured
        ? `Channel audience is configured as ${configured}.`
        : channelDenied
          ? "Restricted reveals will stay ephemeral until the operator records the verified channel audience."
          : "No channel audience is configured; restricted reveals stay ephemeral and public reveals may be shared.",
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
      Number(cards?.cards) === 8 ? "PASS" : "FAIL",
      `${cards?.cards ?? 0}/8 published cards`,
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
    const achievement = rows(
      `SELECT key, name, criteria_json FROM fb_achievement_definitions
        WHERE status = 'active' AND criteria_json LIKE '%${collection.id}%' AND criteria_json LIKE '%"target":8%' LIMIT 1`,
    )[0];
    let roster = 0;
    try {
      roster = JSON.parse(achievement?.criteria_json ?? "{}").roster_card_ids?.length ?? 0;
    } catch {
      roster = 0;
    }
    add(
      "completion achievement",
      achievement && roster === 8 ? "PASS" : "FAIL",
      achievement
        ? `${achievement.name} · frozen roster ${roster}/8`
        : "No target-8 collection achievement.",
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
    "test identities",
    local ? "BLOCKED" : Number(identities?.count) > 0 ? "PASS" : "FAIL",
    local
      ? "Local D1 has no production Discord identities. Verify the owner identity on the deployed installation instead."
      : `${identities?.count ?? 0} linked Discord identities · ${identities?.platform_admins ?? 0} platform admin links`,
  );
} catch (error) {
  add("database", "BLOCKED", error instanceof Error ? error.message : String(error));
}

const failed = checks.filter((check) => check.status === "FAIL");
const blocked = checks.filter((check) => check.status === "BLOCKED");
const result = {
  generated_at: new Date().toISOString(),
  mode: local ? "local" : "production",
  origin,
  checks,
  failed: failed.length,
  blocked: blocked.length,
};

if (jsonOutput) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`Foilbury Discord preflight · ${result.mode} · ${origin}`);
  for (const check of checks)
    console.log(`${check.status.padEnd(7)} ${check.id.padEnd(24)} ${check.detail}`);
  console.log(
    `\n${checks.length - failed.length - blocked.length} PASS · ${failed.length} FAIL · ${blocked.length} BLOCKED`,
  );
  console.log("No draw, grant, spend, message or paid provider was used.");
}
process.exit(failed.length ? 1 : 0);
