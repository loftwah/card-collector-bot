#!/usr/bin/env node
/**
 * Post a concise, human-facing delivery update to the owner's showcase channel.
 *
 * This is a showcase, not acceptance evidence. The message names the exact
 * issue/PR, source revision, deployed Worker, live journey and what to look for.
 * The webhook URL is read from WOODHOUSE_DISCORD_CHANNEL and is never printed or
 * committed.
 *
 *   pnpm showcase:post -- --title "..." --summary "..." --issues 46,43 \
 *     --pr 100 --source 9092983 --worker 5e523dd3 --url https://... \
 *     --look-for "Open /foilbury profile and check the featured copy."
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../lib/local.mjs";

const args = process.argv.slice(2);
function value(name, fallback = "") {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
}
function values(name) {
  const output = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === `--${name}` && args[index + 1]) output.push(args[index + 1]);
  }
  return output;
}
function readEnv() {
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) return {};
  const values = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) values[match[1]] = match[2].trim();
  }
  return values;
}
const env = { ...readEnv(), ...process.env };
const webhook = env.WOODHOUSE_DISCORD_CHANNEL || "";
const dryRun = args.includes("--dry-run");
const force = args.includes("--force");
const key = value("key");
const title = value("title");
const summary = value("summary");
const status = value("status", "DELIVERED");
const url = value("url");
const source = value("source");
const worker = value("worker");
const issues = value("issues")
  .split(",")
  .map((item) => item.trim().replace(/^#/, ""))
  .filter(Boolean);
const pr = value("pr").replace(/^#/, "");
const lookFor = values("look-for");
const extra = values("field").map((entry) => {
  const [name, ...rest] = entry.split("=");
  return { name: name?.trim(), value: rest.join("=").trim() };
});

if (!title) throw new Error("--title is required.");
if (!summary) throw new Error("--summary is required.");
if (!dryRun && !webhook) {
  throw new Error("WOODHOUSE_DISCORD_CHANNEL is not set in .env or the environment.");
}

const field = (name, body, inline = false) =>
  body ? { name, value: String(body).slice(0, 1024), inline } : null;

const fields = [
  field(
    "Issues and pull request",
    [
      issues.length
        ? issues.map((issue) => `[#${issue}](https://github.com/loftwah/card-collector-bot/issues/${issue})`).join(" · ")
        : null,
      pr
        ? `[PR #${pr}](https://github.com/loftwah/card-collector-bot/pull/${pr})`
        : null,
    ]
      .filter(Boolean)
      .join(" · "),
  ),
  field("Source and deployment", [
    source ? `Source \`${source.slice(0, 12)}\`` : null,
    worker ? `Worker \`${worker.slice(0, 24)}\`` : null,
  ].filter(Boolean).join(" · ")),
  field("Live", url ? url : null),
  field("What to look for", lookFor.length ? lookFor.map((item) => `• ${item}`).join("\n") : null),
  ...extra.map((item) => field(item.name, item.value)),
  field("Status", status),
].filter(Boolean);

const payload = {
  username: "Foilbury delivery",
  allowed_mentions: { parse: [] },
  embeds: [
    {
      title: title.slice(0, 256),
      description: summary.slice(0, 4096),
      color: 0x2ce3d3,
      fields,
      footer: {
        text: source
          ? `Foilbury delivery showcase · ${source.slice(0, 12)}`
          : "Foilbury delivery showcase",
      },
      timestamp: new Date().toISOString(),
    },
  ],
};

if (dryRun) {
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

const recordDir = path.join(ROOT, ".foilbury", "showcase");
fs.mkdirSync(recordDir, { recursive: true });
const recordFile = key ? path.join(recordDir, `${key.replace(/[^a-z0-9._-]+/gi, "-")}.json`) : null;
if (recordFile && fs.existsSync(recordFile) && !force) {
  console.log(`Showcase "${key}" already posted. Use --force to post again.`);
  process.exit(0);
}

const response = await fetch(`${webhook}?wait=true`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
  signal: AbortSignal.timeout(15000),
});
if (!response.ok) {
  const body = await response.text();
  throw new Error(`Showcase webhook returned ${response.status}: ${body.slice(0, 300)}`);
}
const message = await response.json();
const record = {
  key: key || null,
  message_id: message.id,
  channel_id: message.channel_id,
  posted_at: new Date().toISOString(),
  source: source || null,
  worker: worker || null,
  title,
  status,
  url: url || null,
};
if (recordFile) fs.writeFileSync(recordFile, `${JSON.stringify(record, null, 2)}\n`);
console.log(`Posted showcase ${message.id}${key ? ` (${key})` : ""}.`);
