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
 *   pnpm discord:tour:entry --dry-run
 *   pnpm discord:tour:entry --prints --dry-run
 *   pnpm discord:tour:entry --prints --publish
 *   pnpm discord:tour:entry
 *   pnpm discord:tour:entry --message 1567185366014763079
 *
 * By default the last message id is reused from
 * `.foilbury/discord-tour-entry.json`; if none exists the message is posted
 * once and the id is recorded. It never deletes another member's message and
 * needs only View Channel, Send Messages, Embed Links and Read Message History.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../lib/local.mjs";
import {
  assertDiscordMessage,
  buildActionRows,
  buildEmbed,
  DISCORD_PALETTE,
} from "../../src/server/discord/presentation.ts";

const API = "https://discord.com/api/v10";
const EVIDENCE_DIR = path.join(ROOT, ".foilbury", "evidence");
const args = process.argv.slice(2);
const prints = args.includes("--prints");
const entry = prints ? "discord-print-demo" : "discord-tour-entry";
const STATE_FILE = path.join(ROOT, ".foilbury", `${entry}.json`);
const TEST_GUILD_ID = "997734945206313041";
const TEST_CHANNEL_ID = "1566700752385081355";
const ORIGINAL_DEMO_INDEX_ID = "1568794099039998004";
const FOILBURY_BOT_ID = "1566702936615026769";
const PRINT_FOOTER = "Foilbury · Print room · November 2026";
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const dryRun = args.includes("--dry-run") || (prints && !args.includes("--publish"));

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
const applicationId = prints ? FOILBURY_BOT_ID : env.DISCORD_APPLICATION_ID;
const guildId = prints ? TEST_GUILD_ID : (env.DISCORD_TEST_GUILD_ID ?? TEST_GUILD_ID);
const channelId = prints ? TEST_CHANNEL_ID : (env.DISCORD_TEST_CHANNEL_ID ?? TEST_CHANNEL_ID);
const productionOrigin = "https://foilbury.loftwah.com";
const origin = (
  prints ? productionOrigin : (env.FOILBURY_PUBLIC_ORIGIN ?? productionOrigin)
).replace(/\/$/, "");

if (!dryRun && !token) {
  console.error("DISCORD_BOT_TOKEN is not configured.");
  process.exit(1);
}

const publicLinks = {
  tour: `${origin}/tour`,
  cabinet: `${origin}/cabinet`,
  showcase: `${origin}/showcase`,
};

const tourMessage = {
  content:
    "**Start the Foilbury tour** — a real collecting journey, not a command list. Nothing is charged until you choose an action.",
  embeds: [
    buildEmbed({
      title: "Foilbury · start the tour",
      description:
        "A collectible-card cabinet with a real wallet, real odds and a permanent album. This entry starts the guided Discord tour. It is private to you, skippable and resumable, and it never spends Foil until you deliberately choose an action.",
      accent: DISCORD_PALETTE.action,
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
      image: {
        url: `${origin}/brand/kit/banners/foil-standard-960x540.png`,
        width: 960,
        height: 540,
      },
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
// Exact published catalogue versions, so the comparison keeps its meaning when a
// newer print arrives. The interaction handler checks membership, Bot scope and
// the current render before returning artwork in a private Discord reply.
const homura = "crd_mvzcynj7z5p212zw9ffcwwwn";
const card = (label, cardId, variantId) => ({
  label,
  customId: `foilbury:card:${cardId}:${variantId}:front`,
  style: 2,
});
const printReply = { message_id: ORIGINAL_DEMO_INDEX_ID, fail_if_not_exists: true };
const printMessage = {
  embeds: [
    buildEmbed({
      title: "Foilbury Print Room",
      accent: DISCORD_PALETTE.action,
      description:
        "New to Foilbury? **Start guided tour** walks you through your first session in a private reply. The card buttons below let you browse for free.",
      fields: [
        {
          name: "Your first session",
          value:
            "1. Start the tour and check how much free Foil you can claim.\n2. Open **Browse capsules** to see the choices, prices and odds. Press **Open** on a capsule to spend its listed price for one card, then press **Reveal** to see what you got.\n3. Open **My collection** to see the copy you own. Use **View back** or **Next version** to explore a card.",
        },
        {
          name: "After your first card",
          value:
            "`/foilbury missions` for daily goals · `/foilbury achievements` for milestones · `/foilbury profile` for your collector look · `/foilbury npc` to find a trade partner. Use the original demo chapters above to see saved examples.",
        },
        {
          name: "Featured prints",
          value:
            "**Ryuk** · Rain over Kira · Death Note\n**Pochita** · After Hours · Chainsaw Man\n**Mizi** · Centre Stage · Alien Stage\n**Gucci Morty** · Unofficial fan print · Rick and Morty",
        },
        {
          name: "NBA · Opening Night",
          value:
            "Open the Gold cards for **Victor Wembanyama**, **Shai Gilgeous-Alexander** and **Nikola Jokić**.",
        },
        {
          name: "Inspect a print",
          value:
            "Choose a card below, then use **View back** and **Next version** in your private reply. These are catalogue previews. Browsing is free.",
        },
      ],
      footer: PRINT_FOOTER,
    }),
  ],
  components: buildActionRows([
    [
      { label: "Start guided tour", customId: "foilbury:tour:welcome", style: 1 },
      { label: "Browse capsules", customId: "foilbury:packs", style: 2 },
      { label: "My collection", customId: "foilbury:collection", style: 2 },
    ],
    [
      card("Original Plain", homura, "var_mvzcynl93pg16t0h3hv6ervt"),
      card("Rain Plain", homura, "var_mwdhtaq22bfn9a51r48shtk6"),
      card("Silver", homura, "var_mwdhtaq2zb09tqybkjv55swm"),
      card("Gold", homura, "var_mwdhtaq2v7mz4qp7ngbdd2cf"),
      card("Holographic", homura, "var_mwdhtaq2gq6xqn4tn0yxh575"),
    ],
    [
      card("Ryuk", "crd_mvzcxnu4msq53vz6evg6fbkw", "var_mwdiijokmqbn6pjczhqnnk7z"),
      card("Pochita", "crd_mvzcwoomr5j2q1rfk1tk9n7x", "var_mwdjlj6c7mcw9xtxyhf8p0wr"),
      card("Mizi", "crd_mvzcw77pb52f07rpq90qg4cb", "var_mwdiiozzvzmm7r1yzbsha5m7"),
      card("Gucci Morty", "crd_mvzd0yynwqmt1yh2nszsqtn3", "var_mwedieow33m2kzgyn3fmh83k"),
    ],
    [
      card("Wembanyama", "crd_mvzczq0gnyqtfqbm8y9p13tp", "var_mvzczq2t95d985h7xaymh5br"),
      card("Gilgeous-Alexander", "crd_mvzczn8lncyb2j7k6wvgvj5r", "var_mvzcznaiq7k7h1cz729jd811"),
      card("Jokić", "crd_mvzczpqe2va2sz4bvgccmgkn", "var_mvzczpst6j09q5cxs40p0m2k"),
    ],
    [{ label: "Open web cabinet", url: publicLinks.cabinet }],
  ]),
  allowed_mentions: { parse: [], users: [], roles: [], replied_user: false },
};
const message = prints ? printMessage : tourMessage;
assertDiscordMessage(message);

async function discord(method, url, body) {
  const response = await fetch(`${API}${url}`, {
    method,
    signal: AbortSignal.timeout(15_000),
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
  const payload = prints ? { ...message, message_reference: printReply } : message;
  console.log(JSON.stringify({ channel_id: channelId, guild_id: guildId, payload }, null, 2));
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

const isPrintChapter = (item) =>
  item?.author?.id === me.parsed.id &&
  item.embeds?.[0]?.footer?.text === PRINT_FOOTER &&
  item.message_reference?.message_id === ORIGINAL_DEMO_INDEX_ID;

let previous = null;
if (fs.existsSync(STATE_FILE)) {
  try {
    previous = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (error) {
    if (prints) throw new Error("The Print Room receipt could not be read.", { cause: error });
  }
}
if (prints && previous && (previous.guild_id !== guildId || previous.channel_id !== channelId)) {
  throw new Error("The Print Room receipt points to a different Discord destination.");
}
let messageId = option("--message") ?? previous?.message_id ?? null;
if (prints && !messageId) {
  const recent = await discord("GET", `/channels/${channelId}/messages?limit=100`);
  if (!recent.ok) throw new Error(`Could not check recent channel history: HTTP ${recent.status}.`);
  messageId = recent.parsed.find(isPrintChapter)?.id ?? null;
  if (!messageId && previous?.status === "pending") {
    throw new Error(
      "A previous publish is unresolved. Check the channel and pass --message with the retained chapter ID.",
    );
  }
}

let result;
let action;
if (messageId) {
  // Only edit a message this same bot authored. Discord enforces this too, but
  // the read-back keeps the failure message truthful and avoids touching a
  // human's message if a stale id is supplied.
  const existing = await discord(
    "GET",
    `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
  );
  if (!existing.ok) {
    console.error(`Existing entry read failed: HTTP ${existing.status}. Nothing was changed.`);
    process.exit(1);
  }
  if (existing.parsed?.author?.id !== me.parsed?.id) {
    console.error("The recorded entry id belongs to another author. Nothing was changed.");
    process.exit(1);
  }
  if (prints && !isPrintChapter(existing.parsed)) {
    throw new Error("The supplied message is not the retained Print Room chapter.");
  }
  result = await discord(
    "PATCH",
    `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
    message,
  );
  action = "updated";
} else {
  let body = message;
  if (prints) {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify({ guild_id: guildId, channel_id: channelId, status: "pending" }),
      {
        flag: "wx",
        mode: 0o600,
      },
    );
    const nonce = createHash("sha256")
      .update(`${channelId}:${PRINT_FOOTER}`)
      .digest("hex")
      .slice(0, 25);
    body = {
      ...message,
      message_reference: printReply,
      nonce,
      enforce_nonce: true,
    };
  }
  result = await discord("POST", `/channels/${encodeURIComponent(channelId)}/messages`, body);
  action = "created";
}

if (!result.ok) {
  // A definitive rejection did not create a message. Leave pending receipts
  // intact for timeouts, server errors and other ambiguous outcomes.
  if (prints && action === "created" && [400, 401, 403, 404, 429].includes(result.status)) {
    fs.unlinkSync(STATE_FILE);
  }
  console.error(
    `Discord message ${action === "updated" ? "update" : "post"} failed: HTTP ${result.status}`,
  );
  if (result.text) console.error(result.text.slice(0, 500));
  process.exit(1);
}

const savedMessageId = result.parsed?.id ?? messageId;
const link = `https://discord.com/channels/${guildId}/${channelId}/${savedMessageId}`;
if (prints) {
  const observed = await discord("GET", `/channels/${channelId}/messages/${savedMessageId}`);
  const buttons = (item) =>
    item.components.flatMap((row) =>
      row.components.map(({ label, style, custom_id, url }) => [label, style, custom_id, url]),
    );
  if (
    !observed.ok ||
    !isPrintChapter(observed.parsed) ||
    observed.parsed.channel_id !== channelId ||
    observed.parsed.embeds[0].title !== message.embeds[0].title ||
    observed.parsed.embeds[0].description !== message.embeds[0].description ||
    observed.parsed.attachments?.length !== 0 ||
    JSON.stringify(buttons(observed.parsed)) !== JSON.stringify(buttons(message))
  ) {
    throw new Error(
      `Print Room read-back failed. Reconcile the retained message before retrying: ${link}`,
    );
  }
}
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
  entry_revision: prints ? "2026-11-13.2" : "2026-11-04.1",
};
fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
const evidenceFile = path.join(
  EVIDENCE_DIR,
  `${entry}-${new Date().toISOString().replaceAll(":", "-")}.json`,
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

console.log(`${prints ? "Print Room" : "Tour entry"} ${action}.`);
console.log(link);
console.log(`Evidence: ${path.relative(ROOT, evidenceFile)}`);
