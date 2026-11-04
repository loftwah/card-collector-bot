#!/usr/bin/env node
/**
 * Publish or update the persistent "Start the Foilbury tour" entry in the
 * existing Loftwah test channel.
 *
 * The entry is an ordinary bot-authored channel message. Its first button is a
 * real interaction component (`foilbury:tour:welcome`) handled by the existing
 * signed HTTP endpoint; pressing it opens the private guided tour. The other
 * action buttons call the same `/foilbury daily` and `/foilbury packs` domain
 * paths. Link buttons point at the public website.
 *
 * The payload is built and validated by the production presentation module, so
 * an invalid custom id, embed length or URL fails before Discord is called.
 *
 *   node scripts/discord/publish-tour-entry.mjs --dry-run
 *   node scripts/discord/publish-tour-entry.mjs
 *   node scripts/discord/publish-tour-entry.mjs --message 1567185366014763079
 *
 * By default the last message id is reused from
 * `.foilbury/discord-tour-entry.json`; if none exists the message is posted
 * once and the id is recorded. It never deletes another member's message and
 * needs only View Channel, Send Messages, Embed Links and Read Message History.
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../lib/local.mjs";
import {
  assertDiscordMessage,
  buildActionRows,
  buildEmbed,
} from "../../src/server/discord/presentation.ts";

const API = "https://discord.com/api/v10";
const STATE_FILE = path.join(ROOT, ".foilbury", "discord-tour-entry.json");
const EVIDENCE_DIR = path.join(ROOT, ".foilbury", "evidence");
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const dryRun = args.includes("--dry-run");

function readEnv(file) {
  const values = {};
  if (!fs.existsSync(file)) return values;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) values[match[1]] = match[2].trim();
  }
  return values;
}

const env = { ...readEnv(path.join(ROOT, ".env")), ...process.env };
const token = env.DISCORD_BOT_TOKEN;
const applicationId = env.DISCORD_APPLICATION_ID;
const guildId = env.DISCORD_TEST_GUILD_ID ?? "997734945206313041";
const channelId = env.DISCORD_TEST_CHANNEL_ID ?? "1566700752385081355";
const origin = (env.FOILBURY_PUBLIC_ORIGIN ?? "https://foilbury.loftwah.com").replace(/\/$/, "");

if (!token) {
  console.error("DISCORD_BOT_TOKEN is not configured.");
  process.exit(1);
}

const publicLinks = {
  tour: `${origin}/tour`,
  cabinet: `${origin}/cabinet`,
  showcase: `${origin}/showcase`,
};

const message = {
  content:
    "**Start the Foilbury tour** — a real collecting journey, not a command list. Nothing is charged until you choose an action.",
  embeds: [
    buildEmbed({
      title: "Foilbury · start the tour",
      description:
        "A collectible-card cabinet with a real wallet, real odds and a permanent album. This entry starts the guided Discord tour. It is private to you, skippable and resumable, and it never spends Foil until you deliberately choose an action.",
      accent: 0x044e4a,
      fields: [
        {
          name: "The route",
          value: [
            "1 · Welcome and free play",
            "2 · Authorised collections and visibility",
            "3 · Daily allowance, packs, prices and odds",
            "4 · A real opening with serial",
            "5 · Saved front, back and details",
            "6 · Progress, duplicates and missing subjects",
            "7 · Achievements and one-time rewards",
            "8 · Missions and replay-safe claims",
            "9 · Profile and NPC inspection",
            "10 · Deliberate sharing",
            "11 · Private admin appendix",
          ].join("\n"),
        },
        {
          name: "Press to begin",
          value:
            "**Start the tour** opens stage 1 privately. Every stage has Back, Next and Tour home. **Claim daily** and **Packs** use the same commands as the slash commands below. No button on this entry draws a card or grants a reward by itself.",
        },
        {
          name: "Exact commands",
          value:
            "`/foilbury tour` · `/foilbury daily` · `/foilbury packs` · `/foilbury open` · `/foilbury collection` · `/foilbury card <name>` · `/foilbury achievements` · `/foilbury missions` · `/foilbury profile` · `/foilbury npc` · `/foilbury admin` (Bot Owner or Bot Admin only). All are subcommands of `/foilbury`.",
        },
        {
          name: "What others can see",
          value:
            "Your tour replies are private. This channel is readable by every guild member, so member-only artwork stays in private responses and only a deliberate public-safe share appears here. A server moderator is not Foilbury administration. The private admin appendix is separate from Cloudflare Access platform administration.",
        },
        {
          name: "On the web",
          value: `[Web tour](${publicLinks.tour}) · [Cabinet](${publicLinks.cabinet}) · [Public showcase](${publicLinks.showcase})\n3D card inspection is a labelled website feature; Discord does not claim native 3D.`,
        },
      ],
      image: { url: `${origin}/brand/kit/systems/signal-fold/banner-960x540.png`, width: 960, height: 540 },
      footer: "Foilbury · Signal Fold · free play, no wagering · 2026/11/04",
    }),
  ],
  components: buildActionRows([
    [
      { label: "Start the tour", customId: "foilbury:tour:welcome", style: 1 },
      { label: "Claim daily", customId: "foilbury:daily", style: 2 },
      { label: "Packs", customId: "foilbury:packs", style: 2 },
    ],
    [
      { label: "Web tour", url: publicLinks.tour },
      { label: "Open cabinet", url: publicLinks.cabinet },
      { label: "Public showcase", url: publicLinks.showcase },
    ],
  ]),
  allowed_mentions: { parse: [], users: [], roles: [] },
};
assertDiscordMessage(message);

async function discord(method, url, body) {
  const response = await fetch(`${API}${url}`, {
    method,
    headers: {
      authorization: `Bot ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: response.status, ok: response.ok, parsed, text };
}

if (dryRun) {
  console.log(JSON.stringify({ channel_id: channelId, guild_id: guildId, payload: message }, null, 2));
  process.exit(0);
}

const me = await discord("GET", "/users/@me");
if (!me.ok) {
  console.error(`Discord bot identity read failed: HTTP ${me.status}`);
  process.exit(1);
}
if (applicationId && me.parsed?.id !== applicationId) {
  console.error("The configured bot token does not belong to DISCORD_APPLICATION_ID.");
  process.exit(1);
}

const channel = await discord("GET", `/channels/${encodeURIComponent(channelId)}`);
if (!channel.ok) {
  console.error(`Channel read failed: HTTP ${channel.status}`);
  process.exit(1);
}
if (channel.parsed?.guild_id !== guildId) {
  console.error("The configured channel is not in the configured guild.");
  process.exit(1);
}

let previous = null;
if (fs.existsSync(STATE_FILE)) {
  try {
    previous = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    previous = null;
  }
}
const messageId = option("--message") ?? previous?.message_id ?? null;

let result;
let action;
if (messageId) {
  // Only edit a message this same bot authored. Discord enforces this too, but
  // the read-back keeps the failure message truthful and avoids touching a
  // human's message if a stale id is supplied.
  const existing = await discord("GET", `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`);
  if (!existing.ok) {
    console.error(`Existing entry read failed: HTTP ${existing.status}. Nothing was changed.`);
    process.exit(1);
  }
  if (existing.parsed?.author?.id !== me.parsed?.id) {
    console.error("The recorded entry id belongs to another author. Nothing was changed.");
    process.exit(1);
  }
  result = await discord(
    "PATCH",
    `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
    message,
  );
  action = "updated";
} else {
  result = await discord("POST", `/channels/${encodeURIComponent(channelId)}/messages`, message);
  action = "created";
}

if (!result.ok) {
  console.error(`Discord message ${action === "updated" ? "update" : "post"} failed: HTTP ${result.status}`);
  if (result.text) console.error(result.text.slice(0, 500));
  process.exit(1);
}

const savedMessageId = result.parsed?.id ?? messageId;
const link = `https://discord.com/channels/${guildId}/${channelId}/${savedMessageId}`;
fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
const state = {
  guild_id: guildId,
  channel_id: channelId,
  message_id: savedMessageId,
  message_link: link,
  application_id: me.parsed?.id ?? applicationId ?? null,
  action,
  published_at: new Date().toISOString(),
  entry_revision: "2026-11-04.1",
};
fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
const evidenceFile = path.join(
  EVIDENCE_DIR,
  `discord-tour-entry-${new Date().toISOString().replaceAll(":", "-")}.json`,
);
fs.writeFileSync(
  evidenceFile,
  `${JSON.stringify(
    {
      ...state,
      dry_run: false,
      payload_digest_input: {
        title: message.embeds[0]?.title,
        action_custom_ids: message.components
          .flatMap((row) => row.components ?? [])
          .map((component) => component.custom_id)
          .filter(Boolean),
        link_urls: message.components
          .flatMap((row) => row.components ?? [])
          .map((component) => component.url)
          .filter(Boolean),
      },
      read_back: {
        id: result.parsed?.id,
        channel_id: result.parsed?.channel_id,
        author_id: result.parsed?.author?.id,
        edited_timestamp: result.parsed?.edited_timestamp ?? null,
        embeds: (result.parsed?.embeds ?? []).length,
        component_rows: (result.parsed?.components ?? []).length,
      },
    },
    null,
    2,
  )}\n`,
);

console.log(`Tour entry ${action}.`);
console.log(link);
console.log(`Evidence: ${path.relative(ROOT, evidenceFile)}`);
