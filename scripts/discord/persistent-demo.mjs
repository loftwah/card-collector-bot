#!/usr/bin/env node
/**
 * Publish the persistent, narrated Foilbury demonstration in the authorised
 * Discord channel.
 *
 * The sequence is ordinary retained channel messages. Economic actions run
 * through the deployed shared HTTP API with a labelled, non-human demo actor;
 * this script never inserts a draw, instance, serial, mission claim or reward
 * directly into D1. Discord sends use a deterministic nonce and a channel
 * read-back so an interrupted run resumes instead of double-posting.
 *
 *   node scripts/discord/persistent-demo.mjs --dry-run
 *   node scripts/discord/persistent-demo.mjs --publish
 *
 * Private state and downloaded source renders stay under .foilbury/.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import sharp from "sharp";
import { ROOT } from "../lib/local.mjs";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run") || !args.has("--publish");
const resume = !args.has("--fresh");
const refreshArg = process.argv.find((arg) => arg.startsWith("--refresh="));
const refreshStages = new Set(
  refreshArg
    ? refreshArg
        .slice("--refresh=".length)
        .split(",")
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0)
    : [],
);
const RUN_ID = "foilbury-demo-2026-11-04";
const GUILD_ID = "997734945206313041";
const CHANNEL_ID = "1566700752385081355";
const APPLICATION_ID = "1566702936615026769";
const INSTALLATION_ID = "dci_loftwah_test";
const COLLECTION_SLUG = "danganronpa-three-games";
const POOL_SLUG = "danganronpa-three-games-capsule";
const PRICE_CEILING = 6500;
const MAX_DRAWS = 45;
const PUBLIC_ORIGIN = "https://foilbury.loftwah.com";
const STATE_DIR = path.join(ROOT, ".foilbury", "demo");
const ASSET_DIR = path.join(ROOT, ".foilbury", "demo-assets", RUN_ID);
const STATE_FILE = path.join(STATE_DIR, `${RUN_ID}.json`);
const ACTOR_FILE = path.join(ROOT, ".foilbury", "demo-actor.json");

fs.mkdirSync(STATE_DIR, { recursive: true });
fs.mkdirSync(ASSET_DIR, { recursive: true });

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
const botToken = env.DISCORD_BOT_TOKEN;
const actor = fs.existsSync(ACTOR_FILE) ? JSON.parse(fs.readFileSync(ACTOR_FILE, "utf8")) : null;
if (!dryRun && !botToken) throw new Error("DISCORD_BOT_TOKEN is missing.");
if (!dryRun && !actor?.token) throw new Error("Run scripts/discord/provision-demo-actor.mjs --apply first.");

function quote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function d1(sql) {
  const result = spawnSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      "foilbury",
      "--remote",
      "--config",
      "wrangler.production.jsonc",
      "--json",
      "--command",
      sql,
    ],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 24 * 1024 * 1024 },
  );
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  const parsed = JSON.parse(result.stdout);
  return parsed[0]?.results ?? [];
}

function d1Write(sql) {
  const result = spawnSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      "foilbury",
      "--remote",
      "--config",
      "wrangler.production.jsonc",
      "--command",
      sql,
    ],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
}

function workerBuild() {
  const metaFile = path.join(ROOT, "dist", "server", "build-meta.json");
  if (fs.existsSync(metaFile)) {
    const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
    return { source_sha: meta.source_sha ?? meta.git_sha ?? null, tree_hash: meta.tree_hash ?? null };
  }
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" });
  return { source_sha: result.stdout.trim(), tree_hash: null };
}

function workerVersion() {
  const result = spawnSync(
    "npx",
    [
      "wrangler",
      "deployments",
      "list",
      "--name",
      "foilbury",
      "--config",
      "wrangler.production.jsonc",
      "--json",
    ],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );
  if (result.status !== 0) return null;
  const parsed = JSON.parse(result.stdout);
  const last = Array.isArray(parsed) ? parsed[parsed.length - 1] : null;
  return last?.versions?.[0]?.version_id ?? null;
}

async function discord(method, endpoint, body, files = [], attempt = 0) {
  const headers = { authorization: `Bot ${botToken}` };
  let payload = body;
  if (files.length) {
    const form = new FormData();
    form.append("payload_json", JSON.stringify(body));
    files.forEach((file, index) => {
      form.append(
        `files[${index}]`,
        new Blob([fs.readFileSync(file.path)], { type: "image/png" }),
        file.name,
      );
    });
    payload = form;
  } else {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const response = await fetch(`https://discord.com/api/v10${endpoint}`, {
    method,
    headers,
    body: payload,
  });
  const text = await response.text();
  if (response.status === 429 && attempt < 4) {
    let retryAfter = 1;
    try {
      retryAfter = Number(JSON.parse(text).retry_after ?? 1);
    } catch {
      // Keep the conservative default.
    }
    await new Promise((resolve) => setTimeout(resolve, Math.ceil(retryAfter * 1000) + 250));
    return discord(method, endpoint, body, files, attempt + 1);
  }
  if (!response.ok) {
    const error = new Error(`Discord ${method} ${endpoint} failed: ${response.status} ${text.slice(0, 500)}`);
    error.status = response.status;
    throw error;
  }
  return text ? JSON.parse(text) : null;
}

async function api(method, endpoint, body, idempotencyKey) {
  const headers = {
    authorization: `Bearer ${actor.token}`,
    "content-type": "application/json",
  };
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  const response = await fetch(`${PUBLIC_ORIGIN}${endpoint}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`API ${method} ${endpoint} failed: ${response.status} ${text.slice(0, 800)}`);
    error.status = response.status;
    error.body = text;
    throw error;
  }
  return text ? JSON.parse(text) : null;
}

function sha(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function dualTime(iso) {
  const date = new Date(iso);
  const melbourne = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Melbourne",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
  const utc = date.toISOString().replace("T", " ").slice(0, 16);
  return `${melbourne} AEDT (${utc} UTC)`;
}

function stateDefault() {
  return {
    run_id: RUN_ID,
    status: "planned",
    started_at: new Date().toISOString(),
    guild_id: GUILD_ID,
    channel_id: CHANNEL_ID,
    installation_id: INSTALLATION_ID,
    collection_slug: COLLECTION_SLUG,
    collection_id: null,
    collection_name: null,
    release_version: null,
    scope_digest: null,
    bot_id: null,
    ai_art_enabled: false,
    channel_audience: null,
    build: workerBuild(),
    worker_version: null,
    actor: { user_id: actor?.userId ?? "usr_demo_discord", label: "Foilbury Demo Collector" },
    stages: {},
    draws: [],
    mission: null,
    achievement: null,
    progress_before: null,
    progress_after: null,
    conclusion_message_id: null,
  };
}

function loadState() {
  if (!resume || !fs.existsSync(STATE_FILE)) return stateDefault();
  try {
    return { ...stateDefault(), ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) };
  } catch {
    return stateDefault();
  }
}

function saveState(state) {
  state.updated_at = new Date().toISOString();
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

function assertDiscordPayload(payload) {
  const embeds = payload.embeds ?? [];
  if (embeds.length > 10) throw new Error("Discord allows at most 10 embeds per message.");
  let total = 0;
  for (const embed of embeds) {
    total += (embed.title ?? "").length + (embed.description ?? "").length + (embed.footer?.text ?? "").length;
    if ((embed.title ?? "").length > 256) throw new Error("Embed title exceeds 256 characters.");
    if ((embed.description ?? "").length > 4096) throw new Error("Embed description exceeds 4096 characters.");
    if ((embed.fields ?? []).length > 25) throw new Error("Embed field count exceeds 25.");
    for (const field of embed.fields ?? []) {
      if (field.name.length > 256) throw new Error("Embed field name exceeds 256 characters.");
      if (field.value.length > 1024) throw new Error("Embed field value exceeds 1024 characters.");
      total += field.name.length + field.value.length;
    }
    if ((embed.footer?.text ?? "").length > 2048) throw new Error("Embed footer exceeds 2048 characters.");
  }
  if (total > 6000) throw new Error(`Message text is ${total} characters; Discord allows 6000.`);
  const rows = payload.components ?? [];
  if (rows.length > 5) throw new Error("Discord allows at most 5 action rows.");
  for (const row of rows) {
    if ((row.components ?? []).length > 5) throw new Error("Discord allows at most 5 buttons per row.");
    for (const component of row.components ?? []) {
      if ((component.label ?? "").length > 80) throw new Error("Button label exceeds 80 characters.");
      if (component.custom_id && component.custom_id.length > 100) throw new Error("Button custom_id exceeds 100 characters.");
    }
  }
}

function messageLink(messageId) {
  return `https://discord.com/channels/${GUILD_ID}/${CHANNEL_ID}/${messageId}`;
}

function runFooter(stage) {
  return `Foilbury · ${RUN_ID} · stage ${stage}`;
}

async function downloadR2(key, fileName) {
  const destination = path.join(ASSET_DIR, fileName.replace(/\.webp$/, ".png"));
  if (fs.existsSync(destination) && fs.statSync(destination).size > 1000) return destination;
  const temporary = path.join(ASSET_DIR, `${fileName.replace(/\.webp$/, "")}.source.webp`);
  const result = spawnSync(
    "npx",
    [
      "wrangler",
      "r2",
      "object",
      "get",
      `foilbury-media/${key}`,
      "--file",
      temporary,
      "--remote",
      "--config",
      "wrangler.production.jsonc",
    ],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  await sharp(temporary).png().toFile(destination);
  fs.rmSync(temporary, { force: true });
  return destination;
}

async function composeGrid({ cards, owned, title, subtitle, out, columns = 4 }) {
  const cellW = 300;
  const cellH = 420;
  const gap = 16;
  const margin = 24;
  const header = 96;
  const labelH = 46;
  const rows = Math.ceil(cards.length / columns);
  const width = margin * 2 + columns * cellW + (columns - 1) * gap;
  const height = margin * 2 + header + rows * cellH + (rows - 1) * gap + rows * labelH;
  const composites = [];
  const overlays = [];
  for (let index = 0; index < cards.length; index += 1) {
    const card = cards[index];
    const column = index % columns;
    const row = Math.floor(index / columns);
    const left = margin + column * (cellW + gap);
    const top = margin + header + row * (cellH + gap + labelH);
    const bytes = await sharp(card.file).resize(cellW, cellH, { fit: "cover" }).png().toBuffer();
    composites.push({ input: bytes, left, top });
    const isOwned = owned ? owned.has(card.card_id) : null;
    const badge = isOwned === null ? "" : isOwned ? "OWNED" : "MISSING";
    const badgeFill = isOwned ? "#3f9d5a" : "#8a8f98";
    overlays.push(
      `<text x="${left + 8}" y="${top + 22}" fill="#0f1512" font-family="sans-serif" font-size="14" font-weight="700">${escapeXml(card.name)}</text>` +
        (badge
          ? `<rect x="${left + cellW - 78}" y="${top + 8}" width="70" height="22" rx="3" fill="${badgeFill}" opacity="0.92"/><text x="${left + cellW - 43}" y="${top + 24}" text-anchor="middle" fill="#0f1512" font-family="sans-serif" font-size="12" font-weight="700">${badge}</text>`
          : "") +
        `<text x="${left}" y="${top + cellH + 26}" fill="#d8d2c4" font-family="sans-serif" font-size="17" font-weight="600">${escapeXml(card.name)}</text>` +
        `<text x="${left}" y="${top + cellH + 44}" fill="#8a8f98" font-family="sans-serif" font-size="13">${escapeXml(card.caption ?? "")}</text>`,
    );
  }
  overlays.push(
    `<text x="${margin}" y="${margin + 38}" fill="#f4f0e6" font-family="sans-serif" font-size="34" font-weight="700">${escapeXml(title)}</text>` +
      `<text x="${margin}" y="${margin + 70}" fill="#b9b2a3" font-family="sans-serif" font-size="17">${escapeXml(subtitle)}</text>`,
  );
  const svg = Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${overlays.join("")}</svg>`,
  );
  await sharp({ create: { width, height, channels: 4, background: "#0f1512" } })
    .composite([...composites, { input: svg, left: 0, top: 0 }])
    .png()
    .toFile(out);
  return out;
}

async function composeFinishStrip({ variants, out, title, subtitle }) {
  const cellW = 300;
  const cellH = 420;
  const gap = 16;
  const margin = 24;
  const header = 82;
  const labelH = 44;
  const width = margin * 2 + variants.length * cellW + (variants.length - 1) * gap;
  const height = margin * 2 + header + cellH + labelH;
  const composites = [];
  const overlays = [];
  variants.forEach((variant, index) => {
    const left = margin + index * (cellW + gap);
    const top = margin + header;
    overlays.push(
      `<text x="${left}" y="${top + cellH + 26}" fill="#f4f0e6" font-family="sans-serif" font-size="20" font-weight="700">${escapeXml(variant.label)}</text>` +
        `<text x="${left}" y="${top + cellH + 44}" fill="#8a8f98" font-family="sans-serif" font-size="13">${escapeXml(variant.caption ?? "")}</text>`,
    );
  });
  overlays.push(
    `<text x="${margin}" y="${margin + 34}" fill="#f4f0e6" font-family="sans-serif" font-size="30" font-weight="700">${escapeXml(title)}</text>` +
      `<text x="${margin}" y="${margin + 62}" fill="#b9b2a3" font-family="sans-serif" font-size="16">${escapeXml(subtitle)}</text>`,
  );
  for (let index = 0; index < variants.length; index += 1) {
    const bytes = await sharp(variants[index].file).resize(cellW, cellH, { fit: "cover" }).png().toBuffer();
    composites.push({ input: bytes, left: margin + index * (cellW + gap), top: margin + header });
  }
  const svg = Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${overlays.join("")}</svg>`,
  );
  await sharp({ create: { width, height, channels: 4, background: "#0f1512" } })
    .composite([...composites, { input: svg, left: 0, top: 0 }])
    .png()
    .toFile(out);
  return out;
}

async function composePair({ front, back, out, title, subtitle }) {
  const cellW = 450;
  const cellH = 630;
  const gap = 20;
  const margin = 24;
  const header = 82;
  const labelH = 44;
  const width = margin * 2 + cellW * 2 + gap;
  const height = margin * 2 + header + cellH + labelH;
  const [frontBytes, backBytes] = await Promise.all([
    sharp(front).resize(cellW, cellH, { fit: "cover" }).png().toBuffer(),
    sharp(back).resize(cellW, cellH, { fit: "cover" }).png().toBuffer(),
  ]);
  const svg = Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <text x="${margin}" y="${margin + 34}" fill="#f4f0e6" font-family="sans-serif" font-size="30" font-weight="700">${escapeXml(title)}</text>
      <text x="${margin}" y="${margin + 62}" fill="#b9b2a3" font-family="sans-serif" font-size="16">${escapeXml(subtitle)}</text>
      <text x="${margin}" y="${margin + header + cellH + 30}" fill="#f4f0e6" font-family="sans-serif" font-size="20" font-weight="700">Front</text>
      <text x="${margin + cellW + gap}" y="${margin + header + cellH + 30}" fill="#f4f0e6" font-family="sans-serif" font-size="20" font-weight="700">Back</text>
    </svg>`,
  );
  await sharp({ create: { width, height, channels: 4, background: "#0f1512" } })
    .composite([
      { input: frontBytes, left: margin, top: margin + header },
      { input: backBytes, left: margin + cellW + gap, top: margin + header },
      { input: svg, left: 0, top: 0 },
    ])
    .png()
    .toFile(out);
  return out;
}

function finishLabel(variant) {
  if ((variant.effect ?? "").includes("holo")) return "Holographic";
  if (variant.material === "gold") return "Gold";
  if (variant.material === "silver") return "Silver";
  return "Plain";
}

async function main() {
  console.log(`Foilbury persistent demo · ${RUN_ID} · ${dryRun ? "dry run" : "publish"}`);
  const installation = d1(
    `SELECT * FROM fb_discord_installations WHERE id = ${quote(INSTALLATION_ID)}`,
  )[0];
  if (!installation) throw new Error("Installation not found.");
  const bot = d1(
    `SELECT id, name, ai_art_enabled FROM fb_bots WHERE id = ${quote(installation.bot_id ?? "")} OR tenant_id = ${quote(installation.tenant_id)} ORDER BY CASE WHEN id = ${quote(installation.bot_id ?? "")} THEN 0 ELSE 1 END LIMIT 1`,
  )[0];
  const collection = d1(
    `SELECT id, slug, name, release_version, view_audience, banner_asset_id, logo_asset_id
       FROM fb_collections WHERE slug = ${quote(COLLECTION_SLUG)} AND status = 'published'`,
  )[0];
  if (!collection) throw new Error("Collection not found.");
  const cards = d1(
    `SELECT cc.sort, cd.id AS card_id, cd.name,
            (SELECT v.id FROM fb_variants v JOIN fb_materials m ON m.id = v.material_id
              WHERE v.card_id = cd.id AND v.status = 'published' AND m.key = 'gold' LIMIT 1) AS variant_id
       FROM fb_collection_cards cc JOIN fb_card_definitions cd ON cd.id = cc.card_id
      WHERE cc.collection_id = ${quote(collection.id)} AND cd.status = 'published' AND cd.archived_at IS NULL
      ORDER BY cc.sort, cd.name`,
  );
  if (cards.length === 0) throw new Error("The collection has no published cards.");
  const variantRows = d1(
    `SELECT v.id AS variant_id, v.card_id, cd.name AS card_name, v.name AS variant_name,
            m.key AS material, COALESCE(fx.key, '') AS effect,
            fr.r2_key AS front_key, br.r2_key AS back_key
       FROM fb_variants v
       JOIN fb_card_definitions cd ON cd.id = v.card_id
       JOIN fb_materials m ON m.id = v.material_id
       LEFT JOIN fb_effects fx ON fx.id = v.effect_id
       JOIN fb_variant_renders vr ON vr.variant_id = v.id AND vr.status = 'published'
       JOIN fb_assets fr ON fr.id = vr.asset_id
       LEFT JOIN fb_variant_back_renders vbr ON vbr.variant_id = v.id AND vbr.status = 'published'
       LEFT JOIN fb_assets br ON br.id = vbr.asset_id
      WHERE cd.id IN (${cards.map((card) => quote(card.card_id)).join(",")})
        AND v.status = 'published'`,
  );
  const bannerKey = collection.banner_asset_id
    ? d1(`SELECT r2_key FROM fb_assets WHERE id = ${quote(collection.banner_asset_id)}`)[0]?.r2_key
    : null;

  const state = loadState();
  state.collection_id = collection.id;
  state.collection_name = collection.name;
  state.release_version = collection.release_version;
  state.bot_id = bot?.id ?? null;
  state.ai_art_enabled = Number(bot?.ai_art_enabled ?? 0) === 1;
  state.channel_audience = JSON.parse(installation.channel_audience_json ?? "{}")[CHANNEL_ID] ?? "public";
  state.worker_version = workerVersion();
  state.build = workerBuild();
  state.scope_digest = state.scope_digest ?? null;
  saveState(state);

  if (state.channel_audience !== "members") {
    throw new Error(
      `The channel audience is ${state.channel_audience}; the enabled collection is members-only. Refusing to post restricted artwork.`,
    );
  }

  // Server-side scope read-back: the deployed API must agree with the
  // installation and must return the selected capsule with eligible entries.
  const previewEndpoint = `/api/v1/pools/${POOL_SLUG}?installation=${encodeURIComponent(INSTALLATION_ID)}&channel=${encodeURIComponent(CHANNEL_ID)}`;
  let preview = null;
  if (!dryRun) {
    preview = await api("GET", previewEndpoint);
    if (!preview?.eligible_count) {
      throw new Error("The deployed scope returned no eligible entries; refusing to publish.");
    }
    state.scope_digest = preview.filters?.scope_digest ?? state.scope_digest;
    saveState(state);
  }

  // Download source renders once.
  const cardFiles = [];
  for (const card of cards) {
    const variants = variantRows.filter((variant) => variant.card_id === card.card_id);
    const gold = variants.find((variant) => variant.material === "gold") ?? variants[0];
    if (!gold?.front_key) continue;
    cardFiles.push({
      card_id: card.card_id,
      name: card.name,
      file: await downloadR2(gold.front_key, `front-${card.card_id}.webp`),
      back: gold.back_key ? await downloadR2(gold.back_key, `back-${card.card_id}.webp`) : null,
      variant_id: gold.variant_id,
      finish: finishLabel(gold),
    });
  }
  const banner = bannerKey
    ? await downloadR2(bannerKey, "collection-banner.webp").catch(() => null)
    : null;

  const rosterPath = await composeGrid({
    cards: cardFiles.map((card) => ({ ...card, caption: `${card.finish} · published front` })),
    title: `${collection.name}`,
    subtitle: `Release ${collection.release_version} · ${cardFiles.length} subjects · ${variantRows.length} published variants`,
    out: path.join(ASSET_DIR, "roster.png"),
  });

  // Draw to completion through the real shared API, bounded and idempotent.
  if (!dryRun) {
    let unique = new Set(state.draws.map((draw) => draw.card_id));
    let attempts = state.draws.length;
    while (unique.size < cardFiles.length && attempts < MAX_DRAWS) {
      const key = `${RUN_ID}-draw-${String(attempts + 1).padStart(2, "0")}`;
      const existing = state.draws.find((draw) => draw.key === key);
      if (existing) {
        unique = new Set(state.draws.map((draw) => draw.card_id));
        attempts += 1;
        continue;
      }
      const fresh = await api("GET", previewEndpoint);
      if (!fresh?.eligible_count) throw new Error("The capsule became ineligible during the run.");
      const spend = fresh.price * (state.draws.length + 1);
      if (spend > PRICE_CEILING) {
        throw new Error(`Draw ceiling reached at ${spend} Foil; stopping without another draw.`);
      }
      let receipt;
      try {
        receipt = await api(
          "POST",
          "/api/v1/draws",
          {
            pool: POOL_SLUG,
            expectedRevision: fresh.revision,
            expectedDistribution: fresh.distribution_fingerprint,
            installationId: INSTALLATION_ID,
            channelId: CHANNEL_ID,
          },
          key,
        );
      } catch (error) {
        if (error.status === 409 && /stale|conflict/i.test(error.body ?? "")) {
          // No debit occurred; re-read consent and retry once with the new
          // distribution. The deterministic key may be reused because the
          // previous request did not commit.
          const retry = await api("GET", previewEndpoint);
          receipt = await api(
            "POST",
            "/api/v1/draws",
            {
              pool: POOL_SLUG,
              expectedRevision: retry.revision,
              expectedDistribution: retry.distribution_fingerprint,
              installationId: INSTALLATION_ID,
              channelId: CHANNEL_ID,
            },
            key,
          );
        } else {
          throw error;
        }
      }
      state.draws.push({ ...receipt, key });
      unique = new Set(state.draws.map((draw) => draw.card_id));
      attempts += 1;
      saveState(state);
      if (state.draws.length > PRICE_CEILING / fresh.price) {
        throw new Error("The bounded draw ceiling was reached.");
      }
    }
    if (unique.size < cardFiles.length) {
      throw new Error(`Only ${unique.size}/${cardFiles.length} unique subjects after ${state.draws.length} draws; the demonstration is incomplete.`);
    }
    saveState(state);
  }

  // Persist the run and stage map in D1. The channel messages are the primary
  // durable record; this row binds them to the configuration and build.
  if (!dryRun) {
    const stagesJson = JSON.stringify(state.stages).replaceAll("'", "''");
    d1Write(
      `INSERT INTO fb_discord_demo_runs
         (id, tenant_id, installation_id, guild_id, channel_id, actor_user_id, actor_kind, actor_label,
          collection_id, collection_slug, collection_release_version, scope_digest, source_sha, worker_version,
          status, stages_json, created_at, updated_at)
       VALUES (${quote(RUN_ID)}, ${quote(installation.tenant_id)}, ${quote(INSTALLATION_ID)}, ${quote(GUILD_ID)}, ${quote(CHANNEL_ID)},
               ${quote(actor.userId)}, 'demo', ${quote("Foilbury Demo Collector")},
               ${quote(collection.id)}, ${quote(COLLECTION_SLUG)}, ${collection.release_version},
               ${quote(state.scope_digest ?? "")}, ${quote(state.build.source_sha ?? "")}, ${quote(state.worker_version ?? "")},
               'running', ${quote(stagesJson)}, ${quote(state.started_at)}, ${quote(new Date().toISOString())})
       ON CONFLICT(id) DO UPDATE SET scope_digest = excluded.scope_digest, worker_version = excluded.worker_version,
         source_sha = excluded.source_sha, status = excluded.status, stages_json = excluded.stages_json,
         updated_at = excluded.updated_at;`,
    );
  }

  // A dry run still composes every asset and validates every payload, but it
  // does not draw, claim, post or mutate D1.
  const progressBefore = new Set(state.draws.slice(0, 1).map((draw) => draw.card_id));
  const progressAfter = new Set(state.draws.map((draw) => draw.card_id));
  const featured = state.draws[0] ?? null;
  const completing = state.draws[state.draws.length - 1] ?? null;
  const completion = state.achievement ?? null;
  if (!dryRun && completing) {
    const achievement = d1(
      `SELECT d.name, u.reward_amount, u.reward_state, u.reward_ledger_id, u.earned_at
         FROM fb_achievement_unlocks u JOIN fb_achievement_definitions d ON d.id = u.achievement_id
        WHERE u.tenant_id = ${quote(installation.tenant_id)} AND u.user_id = ${quote(actor.userId)}
          AND json_extract(d.criteria_json, '$.collection_id') = ${quote(collection.id)}
          AND json_extract(d.criteria_json, '$.type') = 'collection_unique'
        ORDER BY u.earned_at DESC LIMIT 1`,
    )[0];
    const reward = achievement?.reward_ledger_id
      ? d1(
          `SELECT amount, balance_after, id, created_at FROM fb_ledger_entries
            WHERE tenant_id = ${quote(installation.tenant_id)} AND user_id = ${quote(actor.userId)} AND id = ${quote(achievement.reward_ledger_id)}`,
        )[0]
      : d1(
          `SELECT amount, balance_after, id, created_at FROM fb_ledger_entries
            WHERE tenant_id = ${quote(installation.tenant_id)} AND user_id = ${quote(actor.userId)}
              AND reference_type = 'achievement' ORDER BY created_at DESC LIMIT 1`,
        )[0];
    state.achievement = achievement ? { ...achievement, reward: reward ?? null } : null;
    saveState(state);
  }

  // Claim one real mission and replay the same claim to prove no extra credit.
  if (!dryRun) {
    const missions = await api("GET", "/api/v1/missions/daily");
    const claimable = missions.missions?.find((mission) => mission.claimable);
    if (claimable) {
      const first = await api(
        "POST",
        "/api/v1/missions/daily/claim",
        { key: claimable.key },
        `${RUN_ID}-mission-${claimable.key}`,
      );
      const replay = await api(
        "POST",
        "/api/v1/missions/daily/claim",
        { key: claimable.key },
        `${RUN_ID}-mission-${claimable.key}`,
      );
      state.mission = { key: claimable.key, title: claimable.title, first, replay, claim_count: 1 };
      saveState(state);
    }
  }

  console.log(JSON.stringify({
    collection: collection.name,
    cards: cardFiles.length,
    draws: state.draws.length,
    unique: new Set(state.draws.map((draw) => draw.card_id)).size,
    scope_digest: state.scope_digest,
    achievement: state.achievement,
    mission: state.mission,
    dry_run: dryRun,
  }, null, 2));

  if (dryRun) {
    console.log("Dry run: composing and validating the narrated sequence without drawing or posting.");
  }

  // The actual message publication is implemented in publishStages() below.
  await publishStages({ state, collection, cardFiles, banner, rosterPath, preview, installation });
}

async function fetchRecentMessages() {
  const messages = await discord("GET", `/channels/${CHANNEL_ID}/messages?limit=100`);
  return Array.isArray(messages) ? messages : [];
}

function stageFromMessage(message) {
  const footer = message.embeds?.map((embed) => embed.footer?.text ?? "").join("\n") ?? "";
  const match = footer.match(new RegExp(`${RUN_ID} · stage (\\d+)`));
  return match ? Number(match[1]) : null;
}

async function publishStages({ state, collection, cardFiles, banner, rosterPath, preview, installation }) {
  if (!dryRun && state.stages[1]?.message_id && state.stages[12]?.message_id && refreshStages.size === 0) {
    console.log("The demonstration is already complete; leaving the retained messages unchanged.");
    return;
  }
  const recent = dryRun ? [] : await fetchRecentMessages().catch(() => []);
  const existing = new Map();
  for (const message of recent) {
    const stage = stageFromMessage(message);
    if (stage && message.author?.id === APPLICATION_ID) existing.set(stage, message);
  }
  for (const [stage, message] of existing) {
    if (!state.stages[stage]) state.stages[stage] = { message_id: message.id, posted_at: message.timestamp };
  }
  saveState(state);

  const featured = state.draws[0];
  const completing = state.draws[state.draws.length - 1];
  const uniqueBefore = new Set(state.draws.slice(0, 1).map((draw) => draw.card_id)).size;
  const uniqueAfter = new Set(state.draws.map((draw) => draw.card_id)).size;
  const duplicates = state.draws.length - uniqueAfter;
  const achievement = state.achievement;
  const mission = state.mission;

  const cardById = new Map(cardFiles.map((card) => [card.card_id, card]));
  const featuredCard = cardById.get(featured?.card_id);
  const completingCard = cardById.get(completing?.card_id);
  const featuredVariant = featured?.variant_id
    ? d1(
        `SELECT fr.r2_key AS front_key, br.r2_key AS back_key
           FROM fb_variants v
           JOIN fb_variant_renders vr ON vr.variant_id = v.id AND vr.status = 'published'
           JOIN fb_assets fr ON fr.id = vr.asset_id
           LEFT JOIN fb_variant_back_renders vbr ON vbr.variant_id = v.id AND vbr.status = 'published'
           LEFT JOIN fb_assets br ON br.id = vbr.asset_id
          WHERE v.id = ${quote(featured.variant_id)} LIMIT 1`,
      )[0]
    : null;
  const featuredFront = featuredVariant?.front_key
    ? await downloadR2(featuredVariant.front_key, "featured-variant-front.webp")
    : featuredCard?.file;
  const featuredBack = featuredVariant?.back_key
    ? await downloadR2(featuredVariant.back_key, "featured-variant-back.webp")
    : featuredCard?.back;
  const finishSpecs = [
    { label: "Plain", material: "plain", effect: "none" },
    { label: "Silver", material: "silver", effect: "none" },
    { label: "Gold", material: "gold", effect: "none" },
    { label: "Holographic", material: "gold", effect: "holographic" },
  ];
  const finishVariants = featuredCard
    ? (await Promise.all(
        finishSpecs.map(async (spec) => {
          const row = d1(
            `SELECT fr.r2_key, v.name, v.id AS variant_id FROM fb_variants v
               JOIN fb_materials m ON m.id = v.material_id
               LEFT JOIN fb_effects fx ON fx.id = v.effect_id
               JOIN fb_variant_renders vr ON vr.variant_id = v.id AND vr.status = 'published'
               JOIN fb_assets fr ON fr.id = vr.asset_id
              WHERE v.card_id = ${quote(featured.card_id)}
                AND m.key = ${quote(spec.material)}
                AND COALESCE(fx.key, 'none') = ${quote(spec.effect)}
                AND v.status = 'published' LIMIT 1`,
          )[0];
          if (!row?.r2_key) return null;
          return {
            label: spec.label,
            file: await downloadR2(row.r2_key, `finish-${spec.label.toLowerCase()}.webp`),
            caption:
              row.variant_id === featured.variant_id
                ? "owned by the demo collector"
                : "catalogue example, not owned",
          };
        }),
      )).filter(Boolean)
    : [];

  const finishPath = finishVariants.length
    ? await composeFinishStrip({
        variants: finishVariants,
        title: `Supported finishes · ${featuredCard?.name ?? "card"}`,
        subtitle: "Catalogue examples. A comparison does not imply the collector owns every finish.",
        out: path.join(ASSET_DIR, "finishes.png"),
      })
    : null;
  const pairPath = featuredFront && featuredBack
    ? await composePair({
        front: featuredFront,
        back: featuredBack,
        title: `${featured?.card_name ?? "Awarded card"} · saved front and back`,
        subtitle: `Serial ${featured?.serial ?? ""} · ${dualTime(featured?.drawn_at ?? new Date().toISOString())}`,
        out: path.join(ASSET_DIR, "front-back.png"),
      })
    : null;
  const beforePath = await composeGrid({
    cards: cardFiles.map((card) => ({ ...card, caption: "Gold reference front" })),
    owned: new Set(state.draws.slice(0, 1).map((draw) => draw.card_id)),
    title: "Progress before the run",
    subtitle: `${uniqueBefore}/${cardFiles.length} unique subjects after the featured opening`,
    out: path.join(ASSET_DIR, "progress-before.png"),
  });
  const afterPath = await composeGrid({
    cards: cardFiles.map((card) => ({ ...card, caption: "Gold reference front" })),
    owned: new Set(state.draws.map((draw) => draw.card_id)),
    title: "Progress after the run",
    subtitle: `${uniqueAfter}/${cardFiles.length} unique subjects · ${duplicates} duplicate ${duplicates === 1 ? "copy" : "copies"}`,
    out: path.join(ASSET_DIR, "progress-after.png"),
  });
  const completionPath = await composeGrid({
    cards: cardFiles.map((card) => ({ ...card, caption: "Gold reference front" })),
    owned: new Set(state.draws.map((draw) => draw.card_id)),
    title: `${collection.name} · complete`,
    subtitle: `${uniqueAfter}/${cardFiles.length} subjects · achievement ${achievement?.name ?? "evaluated from the committed draw"}`,
    out: path.join(ASSET_DIR, "completion.png"),
  });

  const stageLinks = (stage) => (state.stages[stage]?.message_id ? messageLink(state.stages[stage].message_id) : null);
  const nextLink = (stage) => {
    const link = stageLinks(stage);
    return link ? [{ type: 2, style: 5, label: `Stage ${stage} →`, url: link }] : [];
  };
  const web = (label, path) => ({ type: 2, style: 5, label, url: `${PUBLIC_ORIGIN}${path}` });

  const stages = [
    {
      stage: 1,
      embed: {
        title: "Foilbury · persistent demonstration",
        description: [
          "Foilbury is a collectible-card cabinet: claim a free allowance, open a capsule, keep the copy, inspect both faces and complete a set.",
          "This is an ordinary retained channel sequence, not an ephemeral tour. Start here and scroll to the conclusion; every stage is a real bot message with a stable ID.",
        ].join("\n\n"),
        color: 0xc9a227,
        fields: [
          { name: "Server", value: `Loftwah · <#${CHANNEL_ID}>`, inline: true },
          { name: "Collection", value: `${collection.name} · release ${collection.release_version}`, inline: true },
          { name: "Audience", value: "Members · verified channel", inline: true },
          {
            name: "Actor",
            value: "Foilbury Demo Collector — a labelled, non-human demonstration account. Not Dean and not a Discord member.",
            inline: false,
          },
          {
            name: "Recorded versus replayed",
            value: "The opening, further pulls, mission claim, completion and reward below were executed for this run through the shared services. No historical receipt is presented as a new action.",
            inline: false,
          },
          {
            name: "Configuration",
            value: `Scope \`${(state.scope_digest ?? "").slice(0, 16)}\` · build \`${(state.build.source_sha ?? "").slice(0, 12)}\` · Worker \`${(state.worker_version ?? "").slice(0, 12)}\`\n${dualTime(state.started_at)}`,
            inline: false,
          },
          {
            name: "Artwork provenance",
            value: "Sourced character references (Danganronpa Wiki/Fandom), reviewed for this private non-commercial album; card design and finishes are Foilbury originals. Not AI-generated.",
            inline: false,
          },
        ],
        footer: { text: `Foilbury · ${RUN_ID} · stage 1` },
        ...(banner ? { image: { url: "attachment://collection-banner.png" } } : {}),
      },
      files: banner ? [{ name: "collection-banner.png", path: banner }] : [],
      rows: [[web("Open the web album", "/play/collections"), ...nextLink(2)]],
    },
    {
      stage: 2,
      embed: {
        title: "The complete released roster · eight subjects",
        description: `Every subject in the version ${collection.release_version} release, using the saved Gold front renders. The album publishes Plain, Silver, Gold and Holographic variants — ${preview?.eligible_count ?? 32} eligible variants in the capsule.`,
        color: 0x245c4b,
        fields: [
          {
            name: "Released roster",
            value: cardFiles.map((card, index) => `${index + 1}. ${card.name}`).join("\n"),
            inline: false,
          },
          { name: "Audience", value: "Members only · not a public showcase", inline: true },
          { name: "Source", value: "Sourced references · Foilbury card design", inline: true },
        ],
        footer: { text: `Foilbury · ${RUN_ID} · stage 2` },
        image: { url: "attachment://roster.png" },
      },
      files: [{ name: "roster.png", path: rosterPath }],
      rows: [[web("Browse the album", `/play/collections/${COLLECTION_SLUG}`), ...nextLink(3)]],
    },
    {
      stage: 3,
      embed: {
        title: "Free play · the pack this run used",
        description: "The demonstration collector used a bounded, labelled demo balance. Each opening below cost the ordinary price from the collection capsule; the odds are the real per-variant odds returned by the deployed preview.",
        color: 0x7c6b4f,
        fields: [
          { name: "Capsule", value: `${preview?.pool?.name ?? "Danganronpa capsule"} · ${preview?.price ?? 80} Foil`, inline: true },
          { name: "Eligible variants", value: String(preview?.eligible_count ?? 32), inline: true },
          {
            name: "Finish odds",
            value: (() => {
              const odds = new Map();
              for (const entry of preview?.entries ?? []) {
                const key = finishLabel({ material: entry.material_key, effect: entry.effect_key });
                odds.set(key, (odds.get(key) ?? 0) + entry.probability_bps);
              }
              return [...odds.entries()].sort((a, b) => b[1] - a[1]).map(([key, bps]) => `${key} ${(bps / 100).toFixed(2)}%`).join(" · ") || "Read from the live capsule preview";
            })(),
            inline: false,
          },
          { name: "No automatic draw", value: "The next stage is a real opening that was committed before this message was posted. Viewing this stage never spends Foil.", inline: false },
        ],
        footer: { text: `Foilbury · ${RUN_ID} · stage 3` },
        ...(banner ? { image: { url: "attachment://collection-banner.png" } } : {}),
      },
      files: banner ? [{ name: "collection-banner.png", path: banner }] : [],
      rows: [[web("How free play works", "/play/draw"), ...nextLink(4)]],
    },
    {
      stage: 4,
      embed: {
        title: `A real opening · ${featured?.card_name ?? "awarded card"} — ${featured ? finishLabel({ material: featured.material_key, effect: featured.effect_key }) : ""}`,
        description: "This copy was awarded by the shared draw service, not a grant or a mock. The serial, draw ID and one debit are recorded in D1; a retry returns the same receipt and cannot re-roll.",
        color: 0xd97757,
        fields: [
          { name: "Serial", value: `\`${featured?.serial ?? "—"}\``, inline: true },
          { name: "Draw", value: `\`${featured?.draw_id ?? "—"}\``, inline: true },
          { name: "Finish", value: featured ? finishLabel({ material: featured.material_key, effect: featured.effect_key }) : "—", inline: true },
          { name: "Pool", value: `${featured?.pool_name ?? "Danganronpa capsule"} · ${featured?.price ?? 80} Foil`, inline: true },
          { name: "Odds for this copy", value: `${((featured?.probability_bps ?? 0) / 100).toFixed(2)}%`, inline: true },
          { name: "New subject", value: featured?.new_subject ? "Yes" : "No — duplicate", inline: true },
          { name: "Recorded", value: dualTime(featured?.drawn_at ?? new Date().toISOString()), inline: false },
        ],
        footer: { text: `Foilbury · ${RUN_ID} · stage 4` },
        image: { url: "attachment://featured-card.png" },
      },
      files: featuredFront ? [{ name: "featured-card.png", path: featuredFront }] : [],
      rows: [[web("Open this card in 3D", `/play/card/${featured?.instance_id ?? ""}`), ...nextLink(5)]],
    },
    {
      stage: 5,
      embed: {
        title: "Inspection · saved front and back",
        description: "The saved front and back renders for the awarded copy. Discord shows the saved renders and readable details; the web album opens the signed-in 3D inspector — this is not native Discord 3D.",
        color: 0x3b82f6,
        fields: [
          { name: "Card", value: featured?.card_name ?? "—", inline: true },
          { name: "Collection", value: collection.name, inline: true },
          { name: "Serial", value: `\`${featured?.serial ?? "—"}\``, inline: true },
          { name: "Artwork origin", value: "Sourced character reference; card design and finishes are Foilbury originals. Not AI-generated.", inline: false },
        ],
        footer: { text: `Foilbury · ${RUN_ID} · stage 5` },
        image: { url: "attachment://front-back.png" },
      },
      files: pairPath ? [{ name: "front-back.png", path: pairPath }] : [],
      rows: [
        [
          web("Inspect front in the web album", `/play/card/${featured?.instance_id ?? ""}`),
          ...nextLink(6),
        ],
      ],
    },
    {
      stage: 6,
      embed: {
        title: `Supported finishes · ${featuredCard?.name ?? "catalogue comparison"}`,
        description: "Plain, Silver, Gold and Holographic are real catalogue finishes. These are published examples for this subject; the demonstration collector owns one of these four, and this comparison does not imply ownership of the others.",
        color: 0xa855f7,
        fields: finishVariants.map((variant) => ({
          name: variant.label,
          value: variant.caption,
          inline: true,
        })),
        footer: { text: `Foilbury · ${RUN_ID} · stage 6` },
        ...(finishPath ? { image: { url: "attachment://finishes.png" } } : {}),
      },
      files: finishPath ? [{ name: "finishes.png", path: finishPath }] : [],
      rows: [[web("Open the album", `/play/collections/${COLLECTION_SLUG}`), ...nextLink(7)]],
    },
    {
      stage: 7,
      embed: {
        title: "Progress · before and after",
        description: `Before this run the demonstration collector owned ${uniqueBefore}/${cardFiles.length} unique subjects. After ${state.draws.length} real openings it owns ${uniqueAfter}/${cardFiles.length}, with ${duplicates} duplicate ${duplicates === 1 ? "copy" : "copies"}. The completion target is the frozen release ${collection.release_version} roster, not a moving count.`,
        color: uniqueAfter === cardFiles.length ? 0x3f9d5a : 0x7c6b4f,
        fields: [
          { name: "Unique subjects", value: `${uniqueBefore}/${cardFiles.length} → ${uniqueAfter}/${cardFiles.length}`, inline: true },
          { name: "Owned copies", value: String(state.draws.length), inline: true },
          { name: "Duplicates", value: String(duplicates), inline: true },
          { name: "Completion target", value: `Frozen release ${collection.release_version} · ${cardFiles.length} subjects`, inline: false },
        ],
        footer: { text: `Foilbury · ${RUN_ID} · stage 7` },
        image: { url: "attachment://progress-after.png" },
      },
      extraEmbeds: [
        {
          title: `Before the run · ${uniqueBefore}/${cardFiles.length} unique`,
          color: 0x7c6b4f,
          image: { url: "attachment://progress-before.png" },
          footer: { text: "Captured from the committed inventory after the featured opening" },
        },
      ],
      files: [
        { name: "progress-after.png", path: afterPath },
        { name: "progress-before.png", path: beforePath },
      ],
      rows: [[web("See the full album", `/play/collections/${COLLECTION_SLUG}`), ...nextLink(8)]],
    },
    {
      stage: 8,
      embed: {
        title: `Completion · ${achievement?.name ?? "frozen roster milestone"} earned once`,
        description: `The final unique subject was acquired by a real opening at ${dualTime(completing?.drawn_at ?? new Date().toISOString())}. The achievement engine evaluated the frozen roster, unlocked the milestone and credited the one-time reward exactly once.`,
        color: 0x3f9d5a,
        fields: [
          { name: "Achievement", value: achievement?.name ?? "Three schools", inline: true },
          { name: "Target", value: `${cardFiles.length}/${cardFiles.length} subjects`, inline: true },
          { name: "Reward", value: achievement?.reward?.amount ? `+${achievement.reward.amount} Foil · credited once` : achievement?.reward_amount ? `+${achievement.reward_amount} Foil · credited once` : "Recorded in the reward ledger", inline: true },
          { name: "Final draw", value: `\`${completing?.draw_id ?? "—"}\``, inline: false },
          { name: "Final card", value: `${completing?.card_name ?? "—"} — ${completing ? finishLabel({ material: completing.material_key, effect: completing.effect_key }) : ""} · \`${completing?.serial ?? "—"}\``, inline: false },
          { name: "Earned", value: achievement?.earned_at ? dualTime(achievement.earned_at) : "Correlated from the committed draw", inline: false },
        ],
        footer: { text: `Foilbury · ${RUN_ID} · stage 8` },
        image: { url: "attachment://completion.png" },
      },
      files: [{ name: "completion.png", path: completionPath }],
      rows: [[web("Open achievements", "/play/achievements"), ...nextLink(9)]],
    },
    {
      stage: 9,
      embed: {
        title: "Daily mission · claim once, replay shows no extra credit",
        description: mission
          ? `The opening progress made the daily mission “${mission.title}” claimable. The first claim credited ${mission.first.amount} Foil; replaying the same claim returned the recorded result (${mission.replay.amount} Foil) and did not credit again.`
          : "The daily mission was not claimable at publication time; no claim is claimed here. The stage records that honestly rather than inventing a reward.",
        color: 0x245c4b,
        fields: mission
          ? [
              { name: "Mission", value: mission.title, inline: true },
              { name: "First claim", value: `+${mission.first.amount} Foil · \`${mission.first.claim_id}\``, inline: false },
              { name: "Replay", value: `\`${mission.replay.claim_id}\` · replayed ${mission.replay.replayed ? "yes" : "no"} · no additional credit`, inline: false },
            ]
          : [{ name: "Claim", value: "No claimable mission at publication time.", inline: false }],
        footer: { text: `Foilbury · ${RUN_ID} · stage 9` },
      },
      files: [],
      rows: [[web("Open missions", "/play/missions"), ...nextLink(10)]],
    },
    {
      stage: 10,
      embed: {
        title: "Profile and achievements · member-safe summary",
        description: "Counts are scoped to this server's configured collection. No wallet total, email, session or administrator control is shown. No NPC collector is configured in this Bot, so no synthetic spectator is presented.",
        color: 0x7c6b4f,
        fields: [
          { name: "Owned copies", value: String(state.draws.length), inline: true },
          { name: "Unique subjects", value: `${uniqueAfter}/${cardFiles.length}`, inline: true },
          { name: "Completion milestone", value: achievement ? achievement.name : "Not evaluated", inline: true },
          { name: "Scope", value: `${collection.name} · members audience · AI artwork ${state.ai_art_enabled ? "included" : "excluded"}`, inline: false },
        ],
        footer: { text: `Foilbury · ${RUN_ID} · stage 10` },
        ...(banner ? { image: { url: "attachment://collection-banner.png" } } : {}),
      },
      files: banner ? [{ name: "collection-banner.png", path: banner }] : [],
      rows: [[web("Open the profile", "/play/profile"), ...nextLink(11)]],
    },
    {
      stage: 11,
      embed: {
        title: `Deliberate share · ${collection.name} complete`,
        description: `The demonstration collector explicitly shared the completed album to this verified members channel. Sharing does not transfer ownership; the attachment can be copied after delivery. ${uniqueAfter}/${cardFiles.length} unique subjects.`,
        color: 0x3f9d5a,
        fields: [
          { name: "Album", value: collection.name, inline: true },
          { name: "Progress", value: `${uniqueAfter}/${cardFiles.length}`, inline: true },
          { name: "Audience", value: "Members · verified channel", inline: true },
          { name: "Share receipt", value: `Recorded against this message after delivery.`, inline: false },
        ],
        footer: { text: `Foilbury · ${RUN_ID} · stage 11` },
        image: { url: "attachment://completion.png" },
      },
      files: [{ name: "completion.png", path: completionPath }],
      rows: [[web("Open the album", `/play/collections/${COLLECTION_SLUG}`), ...nextLink(12)]],
    },
    {
      stage: 12,
      embed: {
        title: "Demonstration index · what ran",
        description: "This is the end of the retained sequence. Every stage above is an ordinary bot message with a stable ID; reloading the channel preserves the order. The start link is in the first message and repeated below.",
        color: 0xc9a227,
        fields: [
          {
            name: "Stage index · 1–6",
            value: Array.from({ length: 6 }, (_, index) => {
              const stage = index + 1;
              const link = stageLinks(stage);
              return link ? `[${stage}](${link})` : `${stage}`;
            }).join(" · "),
            inline: false,
          },
          {
            name: "Stage index · 7–12",
            value: Array.from({ length: 6 }, (_, index) => {
              const stage = index + 7;
              const link = stageLinks(stage);
              return link ? `[${stage}](${link})` : `${stage}`;
            }).join(" · "),
            inline: false,
          },
          {
            name: "Source events",
            value: `${state.draws.length} real openings · ${uniqueAfter} unique subjects · ${duplicates} duplicates · ${mission ? `mission ${mission.title} claimed once` : "no mission claim"} · ${achievement?.name ?? "completion milestone"} with one reward`,
            inline: false,
          },
          {
            name: "Identity",
            value: `Build \`${(state.build.source_sha ?? "").slice(0, 12)}\` · Worker \`${(state.worker_version ?? "").slice(0, 12)}\` · scope \`${(state.scope_digest ?? "").slice(0, 16)}\` · schema 0027`,
            inline: false,
          },
          {
            name: "Unperformed",
            value: "Independent second-account spectator observation and a real mobile client review remain open; this sequence does not claim them. The desktop channel read-back is the delivery proof.",
            inline: false,
          },
          {
            name: "Rollback",
            value: "Worker rollback target and D1 backup are recorded in the release receipt; the demonstration messages are retained and are not deleted by rollback.",
            inline: false,
          },
        ],
        footer: { text: `Foilbury · ${RUN_ID} · stage 12` },
      },
      files: [],
      rows: [
        [
          state.stages[1]?.message_id
            ? { type: 2, style: 5, label: "Back to the introduction", url: messageLink(state.stages[1].message_id) }
            : web("Open the web album", "/play/collections"),
          web("Open the cabinet", "/play"),
        ],
      ],
    },
  ];

  for (const stage of stages) {
    const existingStage = state.stages[stage.stage]?.message_id;
    const payload = {
      embeds: [stage.embed, ...(stage.extraEmbeds ?? [])],
      components: stage.rows
        .filter((row) => row.length)
        .map((row) => ({ type: 1, components: row })),
      allowed_mentions: { parse: [] },
      nonce: sha(`${RUN_ID}:${stage.stage}`).slice(0, 25),
      enforce_nonce: true,
    };
    assertDiscordPayload(payload);
    if (existingStage) {
      // Verify the message still exists and belongs to the run. If it was
      // removed, repost; otherwise leave the retained message untouched unless
      // this stage was explicitly selected for repair.
      try {
        await discord("GET", `/channels/${CHANNEL_ID}/messages/${existingStage}`);
        if (!refreshStages.has(stage.stage)) continue;
        if (dryRun) {
          console.log(`Stage ${stage.stage} would be refreshed (dry run).`);
          continue;
        }
        const refreshed = await discord(
          "PATCH",
          `/channels/${CHANNEL_ID}/messages/${existingStage}`,
          { ...payload, attachments: [] },
          stage.files,
        );
        state.stages[stage.stage] = {
          message_id: refreshed.id,
          posted_at: refreshed.timestamp,
          title: stage.embed.title,
          refreshed_at: new Date().toISOString(),
        };
        saveState(state);
        console.log(`Stage ${stage.stage} refreshed → ${messageLink(refreshed.id)}`);
        continue;
      } catch (error) {
        if (error.status !== 404) throw error;
        delete state.stages[stage.stage];
        saveState(state);
      }
    }
    if (dryRun) {
      console.log(`Stage ${stage.stage} validated: ${payload.embeds[0].title}`);
      continue;
    }
    const message = await discord("POST", `/channels/${CHANNEL_ID}/messages`, payload, stage.files);
    state.stages[stage.stage] = {
      message_id: message.id,
      posted_at: message.timestamp,
      title: stage.embed.title,
    };
    saveState(state);
    console.log(`Stage ${stage.stage} → ${messageLink(message.id)}`);
  }

  if (state.stages[1]?.message_id && state.stages[12]?.message_id) {
    const intro = messageLink(state.stages[1].message_id);
    const conclusion = messageLink(state.stages[12].message_id);
    if (state.stages[11]?.message_id) {
      d1Write(
        `INSERT OR IGNORE INTO fb_discord_shares
           (id, tenant_id, user_id, channel_id, object_type, object_id, message_id, created_at)
         VALUES ('shr_demo_2026_11', ${quote(installation.tenant_id)}, ${quote(actor.userId)}, ${quote(CHANNEL_ID)},
                 'demo_completion', ${quote(collection.id)}, ${quote(state.stages[11].message_id)}, ${quote(new Date().toISOString())});`,
      );
    }
    const current = await discord("GET", `/channels/${CHANNEL_ID}/messages/${state.stages[1].message_id}`);
    const embed = current.embeds?.[0];
    if (embed && !JSON.stringify(embed).includes(conclusion)) {
      const fields = (embed.fields ?? []).filter((field) => field.name !== "Conclusion");
      fields.push({ name: "Conclusion", value: `[Jump to the index and results](${conclusion})`, inline: false });
      await discord("PATCH", `/channels/${CHANNEL_ID}/messages/${state.stages[1].message_id}`, {
        embeds: [{ ...embed, fields }],
      });
    }
    state.conclusion_message_id = state.stages[12].message_id;
    state.status = "completed";
    saveState(state);
    d1Write(
      `UPDATE fb_discord_demo_runs SET status = 'completed', stages_json = ${quote(JSON.stringify(state.stages))}, updated_at = ${quote(new Date().toISOString())} WHERE id = ${quote(RUN_ID)};`,
    );
    console.log(JSON.stringify({
      start: intro,
      conclusion,
      stages: Object.fromEntries(Object.entries(state.stages).map(([stage, value]) => [stage, messageLink(value.message_id)])),
    }, null, 2));
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
