#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../lib/local.mjs";
import { DISCORD_COMMANDS } from "../../src/server/discord/command-definitions.ts";

function readEnv(name) {
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) throw new Error(".env not found.");
  const value = fs.readFileSync(file, "utf8").match(new RegExp(`^${name}=(.*)$`, "m"))?.[1]?.trim();
  if (!value) throw new Error(`${name} is not set in .env.`);
  return value;
}

const token = readEnv("DISCORD_BOT_TOKEN");
const applicationId = readEnv("DISCORD_APPLICATION_ID");
const guildId = readEnv("DISCORD_TEST_GUILD_ID");
const headers = { authorization: `Bot ${token}`, "content-type": "application/json" };

const listResponse = await fetch(`https://discord.com/api/v10/applications/${applicationId}/guilds/${guildId}/commands`, { headers });
if (!listResponse.ok) throw new Error(`Could not list guild commands: HTTP ${listResponse.status}`);
const existing = await listResponse.json();
const ours = new Map(DISCORD_COMMANDS.map((command) => [command.name, command]));
const merged = [...existing.filter((command) => !ours.has(command.name)), ...DISCORD_COMMANDS];

const putResponse = await fetch(`https://discord.com/api/v10/applications/${applicationId}/guilds/${guildId}/commands`, {
  method: "PUT",
  headers,
  body: JSON.stringify(merged),
});
const body = await putResponse.json().catch(() => null);
if (!putResponse.ok) throw new Error(`Could not register guild commands: HTTP ${putResponse.status} ${JSON.stringify(body).slice(0, 300)}`);

console.log(
  JSON.stringify(
    {
      guild_id: guildId,
      commands: Array.isArray(body) ? body.map((command) => ({ name: command.name, id: command.id, options: command.options?.length ?? 0 })) : [],
      preserved_unrelated: Math.max(0, existing.length - DISCORD_COMMANDS.length),
    },
    null,
    2,
  ),
);
