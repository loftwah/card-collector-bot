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
const prepareOnly = args.has("--prepare");
const dryRun = args.has("--dry-run") || (!args.has("--publish") && !prepareOnly);
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
const FINAL_STAGE = 17;
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
if (!dryRun && !actor?.token)
  throw new Error("Run scripts/discord/provision-demo-actor.mjs --apply first.");

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
    return {
      source_sha: meta.source_sha ?? meta.git_sha ?? null,
      tree_hash: meta.tree_hash ?? null,
    };
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
    const error = new Error(
      `Discord ${method} ${endpoint} failed: ${response.status} ${text.slice(0, 500)}`,
    );
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
    const error = new Error(
      `API ${method} ${endpoint} failed: ${response.status} ${text.slice(0, 800)}`,
    );
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
    mission_draw: null,
    missions: null,
    achievement: null,
    achievements: null,
    profile: null,
    progress_before: null,
    progress_after: null,
    conclusion_message_id: null,
    extended_at: null,
    backup: ".foilbury/backups/prod-pre-demo-extension-2026-11-07.json",
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
    total +=
      (embed.title ?? "").length +
      (embed.description ?? "").length +
      (embed.footer?.text ?? "").length;
    if ((embed.title ?? "").length > 256) throw new Error("Embed title exceeds 256 characters.");
    if ((embed.description ?? "").length > 4096)
      throw new Error("Embed description exceeds 4096 characters.");
    if ((embed.fields ?? []).length > 25) throw new Error("Embed field count exceeds 25.");
    for (const field of embed.fields ?? []) {
      if (field.name.length > 256) throw new Error("Embed field name exceeds 256 characters.");
      if (field.value.length > 1024) throw new Error("Embed field value exceeds 1024 characters.");
      total += field.name.length + field.value.length;
    }
    if ((embed.footer?.text ?? "").length > 2048)
      throw new Error("Embed footer exceeds 2048 characters.");
  }
  if (total > 6000) throw new Error(`Message text is ${total} characters; Discord allows 6000.`);
  const rows = payload.components ?? [];
  if (rows.length > 5) throw new Error("Discord allows at most 5 action rows.");
  for (const row of rows) {
    if ((row.components ?? []).length > 5)
      throw new Error("Discord allows at most 5 buttons per row.");
    for (const component of row.components ?? []) {
      if ((component.label ?? "").length > 80)
        throw new Error("Button label exceeds 80 characters.");
      if (component.custom_id && component.custom_id.length > 100)
        throw new Error("Button custom_id exceeds 100 characters.");
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

const PROFILE_LOOK_LABELS = {
  quiet: "Quiet archive",
  signal: "Signal room",
  binder: "Binder desk",
  night: "Night shelf",
};
const PROFILE_FRAME_LABELS = {
  none: "No frame",
  hairline: "Hairline",
  double: "Double rule",
  signal: "Signal rule",
};
const PROFILE_AVATAR_LABELS = {
  none: "No decoration",
  ring: "Ring",
  corner: "Corner marks",
  stamp: "Stamp",
};
const PROFILE_NAME_LABELS = {
  plain: "Plain",
  wide: "Wide tracking",
  boxed: "Boxed",
};
const PROFILE_EFFECT_LABELS = {
  none: "None",
  sheen: "Soft sheen",
  edge: "Accent edge",
};

function profileLookLabel(key) {
  return PROFILE_LOOK_LABELS[key] ?? key;
}

async function readMissionState(installation) {
  const board = await api("GET", "/api/v1/missions/daily");
  const claims = d1(
    `SELECT id, rule_key, amount, created_at FROM fb_reward_claims
      WHERE tenant_id = ${quote(installation.tenant_id)} AND user_id = ${quote(actor.userId)}
        AND period_key = ${quote(board.period_key)} AND rule_key LIKE 'mission:%'
      ORDER BY created_at`,
  );
  const claimByKey = new Map(
    claims.map((claim) => [claim.rule_key.slice(claim.rule_key.lastIndexOf(":") + 1), claim]),
  );
  const items = board.missions.map((mission) => ({
    ...mission,
    claim: claimByKey.get(mission.key) ?? null,
  }));
  return {
    ...board,
    items,
    claimed_count: items.filter((mission) => mission.claimed).length,
    ready_count: items.filter((mission) => mission.claimable).length,
  };
}

function recentDraws(day, installation) {
  return d1(
    `SELECT d.id AS draw_id, d.instance_id, d.created_at, d.price, d.pool_revision,
            cd.name AS card_name, ci.serial, v.name AS variant_name,
            m.key AS material_key, COALESCE(fx.key, 'none') AS effect_key
       FROM fb_draws d
       JOIN fb_card_instances ci ON ci.id = d.instance_id
       JOIN fb_card_definitions cd ON cd.id = ci.card_id
       JOIN fb_variants v ON v.id = d.variant_id
       JOIN fb_materials m ON m.id = v.material_id
       LEFT JOIN fb_effects fx ON fx.id = v.effect_id
      WHERE d.tenant_id = ${quote(installation.tenant_id)} AND d.user_id = ${quote(actor.userId)}
        AND substr(d.created_at, 1, 10) = ${quote(day)}
      ORDER BY d.created_at`,
  );
}

async function ensureMissionProgress({ state, installation, previewEndpoint }) {
  let board = await readMissionState(installation);
  const openMission = board.missions.find((mission) => mission.key === "open");
  if (openMission && !openMission.complete && !openMission.claimed) {
    const key = `${RUN_ID}-mission-${board.day}-open`;
    try {
      const fresh = await api("GET", previewEndpoint);
      if (!fresh?.eligible_count)
        throw new Error("The mission capsule is not eligible; no draw was made.");
      const spend = fresh.price;
      if (spend > PRICE_CEILING)
        throw new Error("The mission opening would exceed the bounded ceiling.");
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
      state.mission_draw = { ...receipt, key };
      saveState(state);
      board = await readMissionState(installation);
    } catch (error) {
      state.mission_draw = { ...(state.mission_draw ?? {}), error: error.message, key };
      saveState(state);
    }
  }

  const claims = [];
  for (const mission of board.missions.filter((item) => item.claimable)) {
    try {
      const claim = await api(
        "POST",
        "/api/v1/missions/daily/claim",
        { key: mission.key },
        `${RUN_ID}-mission-${board.day}-${mission.key}`,
      );
      claims.push({ key: mission.key, title: mission.title, ...claim });
    } catch (error) {
      claims.push({ key: mission.key, title: mission.title, error: error.message });
    }
  }
  if (claims.length) {
    saveState(state);
    board = await readMissionState(installation);
  }

  let replay = null;
  const firstClaimed = board.items.find((mission) => mission.claimed && mission.claim);
  if (firstClaimed) {
    const before = await api("GET", "/api/v1/missions/daily");
    try {
      const result = await api(
        "POST",
        "/api/v1/missions/daily/claim",
        { key: firstClaimed.key },
        `${RUN_ID}-mission-replay-${board.day}-${firstClaimed.key}`,
      );
      const after = await api("GET", "/api/v1/missions/daily");
      replay = {
        key: firstClaimed.key,
        title: firstClaimed.title,
        claim_id: result.claim_id,
        amount: result.amount,
        replayed: result.replayed === true,
        earned_before: before.earned_today,
        earned_after: after.earned_today,
        balance_after: result.balance_after,
      };
    } catch (error) {
      replay = { key: firstClaimed.key, title: firstClaimed.title, error: error.message };
    }
  }

  const draws = recentDraws(board.day, installation);
  return {
    day: board.day,
    period_key: board.period_key,
    reset_at: board.reset_at,
    reset_local: board.reset_local,
    cap: board.cap,
    currency_symbol: board.currency_symbol,
    earned_today: board.earned_today,
    claimed_count: board.claimed_count,
    ready_count: board.ready_count,
    items: board.items.map((mission) => ({
      key: mission.key,
      title: mission.title,
      description: mission.description,
      reward: mission.reward,
      progress: mission.progress,
      target: mission.target,
      complete: mission.complete,
      claimed: mission.claimed,
      claimable: mission.claimable,
      claimed_at: mission.claimed_at,
      claim_id: mission.claim?.id ?? null,
    })),
    claims,
    replay,
    draws,
  };
}

async function ensureProfileShare({ state, installation }) {
  let prefs = await api("GET", "/api/v1/me/preferences");
  if (!prefs.sharing_enabled) {
    prefs = await api("PATCH", "/api/v1/me/preferences", { sharingEnabled: true });
  }
  const selection = JSON.stringify(prefs.profile_presentation);
  const existing = state.profile?.share;
  if (existing?.id && state.profile?.selection === selection) {
    const list = await api("GET", "/api/v1/shares").catch(() => ({ items: [] }));
    const row = list.items?.find((item) => item.id === existing.id);
    if (row?.status === "active" && new Date(row.expires_at) > new Date()) {
      state.profile = { ...state.profile, prefs, share: { ...existing, status: "active" } };
      saveState(state);
      return { prefs, share: { ...existing, status: "active" }, reused: true };
    }
  }

  const share = await api("POST", "/api/v1/shares", { kind: "profile", expiresInDays: 7 });
  const next = {
    id: share.id,
    url: share.url,
    token: share.token,
    audience: share.audience,
    expires_at: share.expires_at,
    created_at: new Date().toISOString(),
    status: "active",
  };
  state.profile = {
    prefs,
    look: prefs.profile_look,
    bio: prefs.profile_bio,
    version: prefs.profile_presentation_version,
    updated_at: prefs.updated_at,
    selection,
    selection_values: prefs.profile_presentation,
    presentation: share.preview?.presentation ?? null,
    share_preview: share.preview ?? null,
    share: next,
  };
  saveState(state);
  return { prefs, share: next, reused: false };
}

async function readAchievementState({ state, installation }) {
  const count = () =>
    d1(
      `SELECT
         (SELECT COUNT(*) FROM fb_achievement_unlocks WHERE tenant_id = ${quote(installation.tenant_id)} AND user_id = ${quote(actor.userId)}) AS unlocks,
         (SELECT COALESCE(SUM(amount), 0) FROM fb_ledger_entries
           WHERE tenant_id = ${quote(installation.tenant_id)} AND user_id = ${quote(actor.userId)}
             AND reference_type = 'achievement') AS reward_foil`,
    )[0];
  const before = count();
  let evaluation = null;
  try {
    evaluation = await api("POST", "/api/v1/achievements/evaluate", {});
  } catch (error) {
    evaluation = { error: error.message };
  }
  const after = count();
  const items = (await api("GET", "/api/v1/achievements")).items ?? [];
  const stateOf = (item) => item.state;
  const compact = (item) => ({
    id: item.id,
    name: item.name,
    description: item.description,
    state: item.state,
    progress: item.progress,
    target: item.target,
    earned_at: item.earned_at,
    reward_amount: item.reward_amount,
    art_key: item.art_key,
    category: item.category,
    collection_name: item.collection_name ?? null,
    collection_slug: item.collection_slug ?? null,
  });
  const earned = items.filter((item) => stateOf(item) === "earned").map(compact);
  const inProgress = items
    .filter((item) => stateOf(item) === "in_progress")
    .map(compact)
    .sort((a, b) => b.progress / Math.max(1, b.target) - a.progress / Math.max(1, a.target));
  const locked = items.filter((item) => stateOf(item) === "locked");
  state.achievements = {
    total: items.length,
    earned,
    in_progress: inProgress,
    locked_count: locked.length,
    evaluation: {
      returned: Array.isArray(evaluation?.unlocked) ? evaluation.unlocked.length : 0,
      error: evaluation?.error ?? null,
      unlocks_before: before?.unlocks ?? 0,
      unlocks_after: after?.unlocks ?? 0,
      reward_foil_before: before?.reward_foil ?? 0,
      reward_foil_after: after?.reward_foil ?? 0,
    },
  };
  saveState(state);
  return state.achievements;
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
    const bytes = await sharp(variants[index].file)
      .resize(cellW, cellH, { fit: "cover" })
      .png()
      .toBuffer();
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
  console.log(`Foilbury persistent demo · ${RUN_ID} · ${dryRun ? "dry run" : prepareOnly ? "prepare" : "publish"}`);
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
  state.channel_audience =
    JSON.parse(installation.channel_audience_json ?? "{}")[CHANNEL_ID] ?? "public";
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
      throw new Error(
        `Only ${unique.size}/${cardFiles.length} unique subjects after ${state.draws.length} draws; the demonstration is incomplete.`,
      );
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

  // Exercise the real mission board, collector identity and achievement
  // cabinet. The browser pass records the human-session actions (world visit,
  // inspection, opening and claims); these reads prove the persisted result
  // and replay one claim without crediting it again.
  if (!dryRun) {
    state.extended_at = new Date().toISOString();
    state.missions = await ensureMissionProgress({ state, installation, previewEndpoint });
    await ensureProfileShare({ state, installation });
    await readAchievementState({ state, installation });
    saveState(state);
  }

  console.log(
    JSON.stringify(
      {
        collection: collection.name,
        cards: cardFiles.length,
        draws: state.draws.length,
        unique: new Set(state.draws.map((draw) => draw.card_id)).size,
        scope_digest: state.scope_digest,
        achievement: state.achievement?.name ?? null,
        mission: state.missions
          ? {
              day: state.missions.day,
              claimed: state.missions.claimed_count,
              ready: state.missions.ready_count,
              earned_today: state.missions.earned_today,
            }
          : null,
        profile_share: state.profile?.share
          ? {
              id: state.profile.share.id,
              status: state.profile.share.status,
              expires_at: state.profile.share.expires_at,
            }
          : null,
        achievements: state.achievements
          ? {
              earned: state.achievements.earned.length,
              in_progress: state.achievements.in_progress.length,
              locked: state.achievements.locked_count,
            }
          : null,
        dry_run: dryRun,
        prepare_only: prepareOnly,
      },
      null,
      2,
    ),
  );

  if (dryRun) {
    console.log(
      "Dry run: composing and validating the narrated sequence without drawing or posting.",
    );
  }
  if (prepareOnly) {
    console.log(
      "Prepare-only: production reads and idempotent journey actions completed; no channel messages were posted.",
    );
    return;
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

async function publishStages({
  state,
  collection,
  cardFiles,
  banner,
  rosterPath,
  preview,
  installation,
}) {
  if (
    !dryRun &&
    state.stages[1]?.message_id &&
    state.stages[FINAL_STAGE]?.message_id &&
    refreshStages.size === 0
  ) {
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
    if (!state.stages[stage])
      state.stages[stage] = { message_id: message.id, posted_at: message.timestamp };
  }
  saveState(state);

  const featured = state.draws[0];
  const completing = state.draws[state.draws.length - 1];
  const uniqueBefore = new Set(state.draws.slice(0, 1).map((draw) => draw.card_id)).size;
  const uniqueAfter = new Set(state.draws.map((draw) => draw.card_id)).size;
  const duplicates = state.draws.length - uniqueAfter;
  const achievement = state.achievement;
  const mission = state.mission;
  const missionBoard = state.missions;
  const achievementBoard = state.achievements;
  const profile = state.profile;

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
    ? (
        await Promise.all(
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
        )
      ).filter(Boolean)
    : [];

  const finishPath = finishVariants.length
    ? await composeFinishStrip({
        variants: finishVariants,
        title: `Supported finishes · ${featuredCard?.name ?? "card"}`,
        subtitle:
          "Catalogue examples. A comparison does not imply the collector owns every finish.",
        out: path.join(ASSET_DIR, "finishes.png"),
      })
    : null;
  const pairPath =
    featuredFront && featuredBack
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

  const stageLinks = (stage) =>
    state.stages[stage]?.message_id ? messageLink(state.stages[stage].message_id) : null;
  const nextLink = (stage) => {
    const link = stageLinks(stage);
    return link ? [{ type: 2, style: 5, label: `Stage ${stage} →`, url: link }] : [];
  };
  const chapterIndexLink = () => {
    const link = stageLinks(12);
    return link ? [{ type: 2, style: 5, label: "Chapter index", url: link }] : [];
  };
  const missionsBoardPath = path.join(ASSET_DIR, "missions-board.png");
  const achievementsBoardPath = path.join(ASSET_DIR, "achievements-board.png");
  const profileHeroPath = path.join(ASSET_DIR, "profile-hero.png");
  const profileSharePath = path.join(ASSET_DIR, "profile-share.png");
  const newStageImages = new Map([
    [13, { name: "missions-board.png", path: missionsBoardPath }],
    [14, { name: "achievements-board.png", path: achievementsBoardPath }],
    [15, { name: "profile-hero.png", path: profileHeroPath }],
    [16, { name: "profile-share.png", path: profileSharePath }],
  ]);
  if (!dryRun) {
    for (const [stage, image] of newStageImages) {
      if (state.stages[stage]?.message_id) continue;
      if (!fs.existsSync(image.path) || fs.statSync(image.path).size < 1000) {
        throw new Error(
          `Stage ${stage} needs ${image.path}; capture the real rendered surface before publishing.`,
        );
      }
    }
  }
  const imageFor = (stage) => {
    const image = newStageImages.get(stage);
    if (!image || !fs.existsSync(image.path)) return {};
    return {
      embed: { image: { url: `attachment://${image.name}` } },
      files: [{ name: image.name, path: image.path }],
    };
  };
  const web = (label, path) => ({ type: 2, style: 5, label, url: `${PUBLIC_ORIGIN}${path}` });

  const missionDraw =
    missionBoard?.draws?.[missionBoard.draws.length - 1] ?? state.mission_draw ?? null;
  const missionReplay = missionBoard?.replay ?? null;
  const profilePresentation = profile?.presentation ?? null;
  const profileSelection = profile?.selection_values ?? null;
  const profileShare = profile?.share ?? null;
  const profileSharePreview = profile?.share_preview ?? null;
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
          {
            name: "Collection",
            value: `${collection.name} · release ${collection.release_version}`,
            inline: true,
          },
          { name: "Audience", value: "Members · verified channel", inline: true },
          {
            name: "Actor",
            value:
              "Foilbury Demo Collector — a labelled, non-human demonstration account. Not Dean and not a Discord member.",
            inline: false,
          },
          {
            name: "Recorded versus replayed",
            value:
              "The opening, further pulls, mission claim, completion and reward below were executed for this run through the shared services. No historical receipt is presented as a new action.",
            inline: false,
          },
          {
            name: "Starting state",
            value:
              "The labelled demo collector started with a bounded, audited 8,000 Foil provisioning grant and no cards. It is not Dean's wallet and not a real player's balance. Every opening below is a real draw from the configured capsule.",
            inline: false,
          },
          {
            name: "Configuration",
            value: `Scope \`${(state.scope_digest ?? "").slice(0, 16)}\` · build \`${(state.build.source_sha ?? "").slice(0, 12)}\` · Worker \`${(state.worker_version ?? "").slice(0, 12)}\`\n${dualTime(state.started_at)}`,
            inline: false,
          },
          {
            name: "Artwork provenance",
            value:
              "Sourced character references (Danganronpa Wiki/Fandom), reviewed for this private non-commercial album; card design and finishes are Foilbury originals. Not AI-generated.",
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
        description:
          "The demonstration collector used a bounded, audited demo grant, not Dean's Foil or a real player's wallet. Each opening below cost the ordinary price from the collection capsule; the odds are the real per-variant odds returned by the deployed preview.",
        color: 0x7c6b4f,
        fields: [
          {
            name: "Capsule",
            value: `${preview?.pool?.name ?? "Danganronpa capsule"} · ${preview?.price ?? 80} Foil`,
            inline: true,
          },
          { name: "Eligible variants", value: String(preview?.eligible_count ?? 32), inline: true },
          {
            name: "Finish odds",
            value: (() => {
              const odds = new Map();
              for (const entry of preview?.entries ?? []) {
                const key = finishLabel({ material: entry.material_key, effect: entry.effect_key });
                odds.set(key, (odds.get(key) ?? 0) + entry.probability_bps);
              }
              return (
                [...odds.entries()]
                  .sort((a, b) => b[1] - a[1])
                  .map(([key, bps]) => `${key} ${(bps / 100).toFixed(2)}%`)
                  .join(" · ") || "Read from the live capsule preview"
              );
            })(),
            inline: false,
          },
          {
            name: "No automatic draw",
            value:
              "The next stage is a real opening that was committed before this message was posted. Viewing this stage never spends Foil.",
            inline: false,
          },
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
        description:
          "This copy was awarded by the shared draw service, not a grant or a mock. The serial, draw ID and one debit are recorded in D1; a retry returns the same receipt and cannot re-roll.",
        color: 0xd97757,
        fields: [
          { name: "Serial", value: `\`${featured?.serial ?? "—"}\``, inline: true },
          { name: "Draw", value: `\`${featured?.draw_id ?? "—"}\``, inline: true },
          {
            name: "Finish",
            value: featured
              ? finishLabel({ material: featured.material_key, effect: featured.effect_key })
              : "—",
            inline: true,
          },
          {
            name: "Pool",
            value: `${featured?.pool_name ?? "Danganronpa capsule"} · ${featured?.price ?? 80} Foil`,
            inline: true,
          },
          {
            name: "Odds for this copy",
            value: `${((featured?.probability_bps ?? 0) / 100).toFixed(2)}%`,
            inline: true,
          },
          {
            name: "New subject",
            value: featured?.new_subject ? "Yes" : "No — duplicate",
            inline: true,
          },
          {
            name: "Recorded",
            value: dualTime(featured?.drawn_at ?? new Date().toISOString()),
            inline: false,
          },
        ],
        footer: { text: `Foilbury · ${RUN_ID} · stage 4` },
        image: { url: "attachment://featured-card.png" },
      },
      files: featuredFront ? [{ name: "featured-card.png", path: featuredFront }] : [],
      rows: [
        [web("Open this card in 3D", `/play/card/${featured?.instance_id ?? ""}`), ...nextLink(5)],
      ],
    },
    {
      stage: 5,
      embed: {
        title: "Inspection · saved front and back",
        description:
          "The saved front and back renders for the awarded copy. Discord shows the saved renders and readable details; the web album opens the signed-in 3D inspector — this is not native Discord 3D.",
        color: 0x3b82f6,
        fields: [
          { name: "Card", value: featured?.card_name ?? "—", inline: true },
          { name: "Collection", value: collection.name, inline: true },
          { name: "Serial", value: `\`${featured?.serial ?? "—"}\``, inline: true },
          {
            name: "Artwork origin",
            value:
              "Sourced character reference; card design and finishes are Foilbury originals. Not AI-generated.",
            inline: false,
          },
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
        description:
          "Plain, Silver, Gold and Holographic are real catalogue finishes. These are published examples for this subject; the demonstration collector owns one of these four, and this comparison does not imply ownership of the others.",
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
          {
            name: "Unique subjects",
            value: `${uniqueBefore}/${cardFiles.length} → ${uniqueAfter}/${cardFiles.length}`,
            inline: true,
          },
          { name: "Owned copies", value: String(state.draws.length), inline: true },
          { name: "Duplicates", value: String(duplicates), inline: true },
          {
            name: "Completion target",
            value: `Frozen release ${collection.release_version} · ${cardFiles.length} subjects`,
            inline: false,
          },
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
          {
            name: "Target",
            value: `${cardFiles.length}/${cardFiles.length} subjects`,
            inline: true,
          },
          {
            name: "Reward",
            value: achievement?.reward?.amount
              ? `+${achievement.reward.amount} Foil · credited once`
              : achievement?.reward_amount
                ? `+${achievement.reward_amount} Foil · credited once`
                : "Recorded in the reward ledger",
            inline: true,
          },
          { name: "Final draw", value: `\`${completing?.draw_id ?? "—"}\``, inline: false },
          {
            name: "Final card",
            value: `${completing?.card_name ?? "—"} — ${completing ? finishLabel({ material: completing.material_key, effect: completing.effect_key }) : ""} · \`${completing?.serial ?? "—"}\``,
            inline: false,
          },
          {
            name: "Earned",
            value: achievement?.earned_at
              ? dualTime(achievement.earned_at)
              : "Correlated from the committed draw",
            inline: false,
          },
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
              {
                name: "First claim",
                value: `+${mission.first.amount} Foil · \`${mission.first.claim_id}\``,
                inline: false,
              },
              {
                name: "Replay",
                value: `\`${mission.replay.claim_id}\` · replayed ${mission.replay.replayed ? "yes" : "no"} · no additional credit`,
                inline: false,
              },
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
        description:
          "Counts are scoped to this server's configured collection. No wallet total, email, session or administrator control is shown. No NPC collector is configured in this Bot, so no synthetic spectator is presented.",
        color: 0x7c6b4f,
        fields: [
          { name: "Owned copies", value: String(state.draws.length), inline: true },
          { name: "Unique subjects", value: `${uniqueAfter}/${cardFiles.length}`, inline: true },
          {
            name: "Completion milestone",
            value: achievement ? achievement.name : "Not evaluated",
            inline: true,
          },
          {
            name: "Scope",
            value: `${collection.name} · members audience · AI artwork ${state.ai_art_enabled ? "included" : "excluded"}`,
            inline: false,
          },
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
          {
            name: "Share receipt",
            value: `Recorded against this message after delivery.`,
            inline: false,
          },
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
        description:
          "This is the end of the retained sequence. Every stage above is an ordinary bot message with a stable ID; reloading the channel preserves the order. The start link is in the first message and repeated below.",
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
            value:
              "Independent second-account spectator observation and a real mobile client review remain open; this sequence does not claim them. The desktop channel read-back is the delivery proof.",
            inline: false,
          },
          {
            name: "Rollback",
            value:
              "Worker rollback target and D1 backup are recorded in the release receipt; the demonstration messages are retained and are not deleted by rollback.",
            inline: false,
          },
        ],
        footer: { text: `Foilbury · ${RUN_ID} · stage 12` },
      },
      files: [],
      rows: [
        [
          state.stages[1]?.message_id
            ? {
                type: 2,
                style: 5,
                label: "Back to the introduction",
                url: messageLink(state.stages[1].message_id),
              }
            : web("Open the web album", "/play/collections"),
          web("Open the cabinet", "/play"),
        ],
      ],
    },
    {
      stage: 13,
      embed: {
        title: "Missions · the real board, a real opening and a replayed claim",
        description: missionBoard
          ? `The daily board is the same one the player sees at /play/missions. A world visit, a front/back inspection and one ordinary capsule opening were completed through the player controls; each claim was then read back from the persisted board.`
          : "The mission board was not read in this run; the stage records that honestly rather than inventing progress.",
        color: 0x245c4b,
        fields: missionBoard
          ? [
              {
                name: "Today's board",
                value: `${missionBoard.claimed_count}/${missionBoard.items.length} claimed · ${missionBoard.currency_symbol} ${missionBoard.earned_today} / ${missionBoard.cap} earned`,
                inline: true,
              },
              {
                name: "Ready to claim",
                value: String(missionBoard.ready_count),
                inline: true,
              },
              ...(missionDraw?.card_name
                ? [
                    {
                      name: "Today's opening",
                      value: `${missionDraw.card_name} — ${finishLabel({ material: missionDraw.material_key, effect: missionDraw.effect_key })} · \`${missionDraw.serial}\`\n−${missionDraw.price} Foil · pool revision ${missionDraw.pool_revision}`,
                      inline: false,
                    },
                  ]
                : []),
              ...(missionReplay
                ? [
                    {
                      name: "Claim replay",
                      value: missionReplay.error
                        ? `Replay could not be read: ${missionReplay.error}`
                        : `\`${missionReplay.claim_id}\` · ${missionReplay.title} · replayed ${missionReplay.replayed ? "yes" : "no"} · earned ${missionReplay.earned_before} → ${missionReplay.earned_after} ${missionBoard.currency_symbol}`,
                      inline: false,
                    },
                  ]
                : []),
              {
                name: "Reset",
                value: missionBoard.reset_local,
                inline: false,
              },
            ]
          : [{ name: "Board", value: "No persisted mission board was read.", inline: false }],
        footer: { text: `Foilbury · ${RUN_ID} · stage 13` },
        ...(imageFor(13).embed ?? {}),
      },
      files: imageFor(13).files ?? [],
      rows: [[web("Open missions", "/play/missions"), ...chapterIndexLink()]],
    },
    {
      stage: 14,
      embed: {
        title: "Achievements · earned, in progress and still locked",
        description: achievementBoard
          ? "These are the real achievement states and reward receipts for the demonstration collector. Earned badges are permanent; a re-evaluation retries fulfilment without writing a second reward."
          : "The achievement cabinet was not read in this run; no state is claimed here.",
        color: 0x7c6b4f,
        fields: achievementBoard
          ? [
              {
                name: "Earned",
                value:
                  achievementBoard.earned
                    .slice(0, 4)
                    .map(
                      (item) =>
                        `${item.name}${item.reward_amount ? ` · +${item.reward_amount} Foil` : ""}`,
                    )
                    .join("\n") || "No earned badges.",
                inline: false,
              },
              {
                name: "In progress",
                value:
                  achievementBoard.in_progress
                    .slice(0, 3)
                    .map((item) => `${item.name} · ${item.progress}/${item.target}`)
                    .join("\n") || "No in-progress achievements.",
                inline: false,
              },
              {
                name: "Still locked",
                value: `${achievementBoard.locked_count} not yet earned · ${achievementBoard.total} visible definitions`,
                inline: true,
              },
              {
                name: "Re-evaluation",
                value: achievementBoard.evaluation.error
                  ? `Evaluation could not run: ${achievementBoard.evaluation.error}`
                  : `Unlocks ${achievementBoard.evaluation.unlocks_before} → ${achievementBoard.evaluation.unlocks_after} · achievement Foil ${achievementBoard.evaluation.reward_foil_before} → ${achievementBoard.evaluation.reward_foil_after} · no duplicate award written.`,
                inline: false,
              },
            ]
          : [{ name: "Cabinet", value: "No persisted achievement state was read.", inline: false }],
        footer: { text: `Foilbury · ${RUN_ID} · stage 14` },
        ...(imageFor(14).embed ?? {}),
      },
      files: imageFor(14).files ?? [],
      rows: [[web("Open achievements", "/play/achievements"), ...chapterIndexLink()]],
    },
    {
      stage: 15,
      embed: {
        title: "Collector identity · chosen look, exact featured copy and earned badges",
        description:
          "The collector composition is saved independently of the cards: portrait, banner, frame, avatar decoration, name treatment, effect, exact featured copy, shelf order and badge order. The composition below is the same one returned by the profile and by the recipient share.",
        color: 0x3b82f6,
        fields: profile
          ? [
              {
                name: "Look",
                value: `${profileLookLabel(profile.look)} · saved composition version ${profile.version}`,
                inline: true,
              },
              {
                name: "Composition",
                value: profileSelection
                  ? `${PROFILE_FRAME_LABELS[profileSelection.frame] ?? profileSelection.frame} frame · ${PROFILE_AVATAR_LABELS[profileSelection.avatarDecoration] ?? profileSelection.avatarDecoration} · ${PROFILE_NAME_LABELS[profileSelection.nameTreatment] ?? profileSelection.nameTreatment} · ${PROFILE_EFFECT_LABELS[profileSelection.effect] ?? profileSelection.effect}`
                  : "Saved selection not read.",
                inline: false,
              },
              {
                name: "Portrait and banner",
                value: profilePresentation
                  ? `Portrait: ${profilePresentation.portrait?.label ?? "Monogram"}\nBanner: ${profilePresentation.banner?.label ?? "No banner"}`
                  : "Saved artwork not read.",
                inline: false,
              },
              {
                name: "Featured copy",
                value: profilePresentation?.featured
                  ? `${profilePresentation.featured.card_name} · ${profilePresentation.featured.variant_name}`
                  : "No featured copy.",
                inline: false,
              },
              {
                name: "Shelf and badges",
                value: profilePresentation
                  ? `${(profilePresentation.favourites ?? []).map((item) => item.card_name).join(" · ") || "No shelf"} · ${(profilePresentation.badges ?? []).map((item) => item.name).join(" · ") || "No badges"}`
                  : "No shelf or badges.",
                inline: false,
              },
              {
                name: "Return check",
                value:
                  "The saved profile and the recipient share resolve the same look, featured copy, shelf and badge order. Changing the look does not change ownership or past awards.",
                inline: false,
              },
            ]
          : [{ name: "Profile", value: "No saved composition was read.", inline: false }],
        footer: { text: `Foilbury · ${RUN_ID} · stage 15` },
        ...(imageFor(15).embed ?? {}),
      },
      files: imageFor(15).files ?? [],
      rows: [[web("Open my profile", "/play/profile"), ...chapterIndexLink()]],
    },
    {
      stage: 16,
      embed: {
        title: "Deliberate share · the real collector-profile share service",
        description:
          "The demonstration collector used the normal Share profile control. The shared service created an audited, member-audience snapshot and the recipient view is shown below. This is not a direct database insert and does not transfer ownership.",
        color: 0x3f9d5a,
        fields: profileShare
          ? [
              {
                name: "Share",
                value: `${profileSharePreview?.label ?? "Collector profile"} · ${profileShare.audience ?? "member"} audience · ${profileShare.status}`,
                inline: true,
              },
              {
                name: "Created and expiry",
                value: `${dualTime(profileShare.created_at)} · expires ${String(profileShare.expires_at).slice(0, 10)}`,
                inline: false,
              },
              {
                name: "Control",
                value:
                  "Share profile on /play/profile. The share service wrote the link and audit record; the script did not insert a Discord share receipt or compose a substitute profile.",
                inline: false,
              },
              {
                name: "Privacy",
                value:
                  "The snapshot omits wallet balance, email, account ID, private ledger and card serials. The private recipient link stays in the run state and is not republished in this channel.",
                inline: false,
              },
            ]
          : [{ name: "Share", value: "No profile share was created in this run.", inline: false }],
        footer: { text: `Foilbury · ${RUN_ID} · stage 16` },
        ...(imageFor(16).embed ?? {}),
      },
      files: imageFor(16).files ?? [],
      rows: [[web("Open the profile page", "/play/profile"), ...chapterIndexLink()]],
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

  // The new chapters are retained ordinary messages. The final index is posted
  // after them so every link is stable, then the earlier chapter index and the
  // introduction are refreshed to point at the completed sequence.
  const indexFields = () => [
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
      name: "Stage index · 13–17",
      value: Array.from({ length: 5 }, (_, index) => {
        const stage = index + 13;
        const link = stageLinks(stage);
        return link ? `[${stage}](${link})` : `${stage}`;
      }).join(" · "),
      inline: false,
    },
    {
      name: "Source events",
      value: `${state.draws.length} original-run openings · ${uniqueAfter} unique subjects · ${duplicates} duplicates · ${missionBoard ? `${missionBoard.claimed_count}/${missionBoard.items.length} daily missions claimed` : "mission board not read"} · ${achievement?.name ?? "completion milestone"} with one reward · one deliberate profile share`,
      inline: false,
    },
    {
      name: "Identity",
      value: `Build \`${(state.build.source_sha ?? "").slice(0, 12)}\` · Worker \`${(state.worker_version ?? "").slice(0, 12)}\` · scope \`${(state.scope_digest ?? "").slice(0, 16)}\` · schema 0029`,
      inline: false,
    },
    {
      name: "Unperformed",
      value:
        "Independent second-account spectator observation and a real mobile client review remain open; this sequence does not claim them. NPC cast and trading stages are delivered under #9 and are not claimed here until those stages are posted.",
      inline: false,
    },
    {
      name: "Rollback",
      value: `Pre-change D1 backup \`${state.backup}\` with SHA-256 recorded beside it. Worker rollback is recorded in the release receipt; retained messages, owned cards, serials and ledger rows are not deleted by rollback.`,
      inline: false,
    },
  ];
  const finalStage = {
    stage: FINAL_STAGE,
    embed: {
      title: "Conclusion and full chapter index",
      description:
        "This is the end of the retained sequence. Every chapter is an ordinary bot message with a stable ID; reloading the channel preserves the order. The introduction links here and this index links to every chapter.",
      color: 0xc9a227,
      fields: indexFields(),
      footer: { text: `Foilbury · ${RUN_ID} · stage ${FINAL_STAGE}` },
    },
    files: [],
    rows: [
      [
        state.stages[1]?.message_id
          ? {
              type: 2,
              style: 5,
              label: "Back to the introduction",
              url: messageLink(state.stages[1].message_id),
            }
          : web("Open the web album", "/play/collections"),
        web("Open the cabinet", "/play"),
      ],
    ],
  };
  const finalPayload = {
    embeds: [finalStage.embed],
    components: finalStage.rows.map((row) => ({ type: 1, components: row })),
    allowed_mentions: { parse: [] },
    nonce: sha(`${RUN_ID}:${FINAL_STAGE}`).slice(0, 25),
    enforce_nonce: true,
  };
  assertDiscordPayload(finalPayload);
  if (dryRun) {
    console.log(`Stage ${FINAL_STAGE} validated: ${finalStage.embed.title}`);
  } else {
    const existingFinal = state.stages[FINAL_STAGE]?.message_id;
    let finalMessage = null;
    if (existingFinal) {
      try {
        finalMessage = await discord("GET", `/channels/${CHANNEL_ID}/messages/${existingFinal}`);
      } catch (error) {
        if (error.status !== 404) throw error;
        delete state.stages[FINAL_STAGE];
        saveState(state);
      }
    }
    if (!finalMessage) {
      finalMessage = await discord("POST", `/channels/${CHANNEL_ID}/messages`, finalPayload);
    } else if (refreshStages.has(FINAL_STAGE)) {
      finalMessage = await discord("PATCH", `/channels/${CHANNEL_ID}/messages/${existingFinal}`, {
        ...finalPayload,
        attachments: [],
      });
    }
    state.stages[FINAL_STAGE] = {
      message_id: finalMessage.id,
      posted_at: finalMessage.timestamp,
      title: finalStage.embed.title,
    };
    saveState(state);
    console.log(`Stage ${FINAL_STAGE} → ${messageLink(finalMessage.id)}`);
    const finalCurrent = await discord("GET", `/channels/${CHANNEL_ID}/messages/${finalMessage.id}`);
    const finalEmbed = finalCurrent.embeds?.[0];
    if (finalEmbed) {
      const nextEmbed = { ...finalEmbed, fields: indexFields() };
      if (JSON.stringify(finalEmbed) !== JSON.stringify(nextEmbed)) {
        await discord("PATCH", `/channels/${CHANNEL_ID}/messages/${finalMessage.id}`, {
          embeds: [nextEmbed],
        });
        console.log(`Stage ${FINAL_STAGE} refreshed with its own index link.`);
      }
    }
  }

  if (state.stages[1]?.message_id && state.stages[FINAL_STAGE]?.message_id) {
    const intro = messageLink(state.stages[1].message_id);
    const conclusion = messageLink(state.stages[FINAL_STAGE].message_id);
    if (state.stages[11]?.message_id) {
      d1Write(
        `INSERT OR IGNORE INTO fb_discord_shares
           (id, tenant_id, user_id, channel_id, object_type, object_id, message_id, created_at)
         VALUES ('shr_demo_2026_11', ${quote(installation.tenant_id)}, ${quote(actor.userId)}, ${quote(CHANNEL_ID)},
                 'demo_completion', ${quote(collection.id)}, ${quote(state.stages[11].message_id)}, ${quote(new Date().toISOString())});`,
      );
    }

    const refreshIndex = async (stageNumber, title, description) => {
      const existing = state.stages[stageNumber]?.message_id;
      if (!existing) return;
      const current = await discord("GET", `/channels/${CHANNEL_ID}/messages/${existing}`);
      const embed = current.embeds?.[0];
      if (!embed) return;
      const fields = indexFields();
      const nextEmbed = { ...embed, title, description, fields };
      if (JSON.stringify(embed) === JSON.stringify(nextEmbed)) return;
      if (dryRun) {
        console.log(`Stage ${stageNumber} would be refreshed (dry run).`);
        return;
      }
      const refreshed = await discord("PATCH", `/channels/${CHANNEL_ID}/messages/${existing}`, {
        embeds: [nextEmbed],
      });
      state.stages[stageNumber] = {
        ...state.stages[stageNumber],
        message_id: refreshed.id,
        posted_at: refreshed.timestamp,
        title,
        refreshed_at: new Date().toISOString(),
      };
      saveState(state);
      console.log(`Stage ${stageNumber} refreshed → ${messageLink(refreshed.id)}`);
    };
    await refreshIndex(
      12,
      `Chapter index · stages 1–${FINAL_STAGE}`,
      "Every retained chapter is linked below. The introduction links to the final conclusion; the final conclusion links back to this chapter index.",
    );

    const currentIntro = await discord(
      "GET",
      `/channels/${CHANNEL_ID}/messages/${state.stages[1].message_id}`,
    );
    const introEmbed = currentIntro.embeds?.[0];
    if (introEmbed) {
      const fields = (introEmbed.fields ?? []).filter(
        (field) => field.name !== "Conclusion" && field.name !== "Extension",
      );
      fields.push({
        name: "Extension",
        value:
          "Collector identity, missions and achievements chapters were added on 2026/11/08. The original opening, completion and reward receipts above are unchanged.",
        inline: false,
      });
      fields.push({
        name: "Conclusion",
        value: `[Jump to the index and results](${conclusion})`,
        inline: false,
      });
      const nextEmbed = { ...introEmbed, fields };
      if (JSON.stringify(introEmbed) !== JSON.stringify(nextEmbed)) {
        if (dryRun) {
          console.log("Stage 1 would be refreshed (dry run).");
        } else {
          await discord("PATCH", `/channels/${CHANNEL_ID}/messages/${state.stages[1].message_id}`, {
            embeds: [nextEmbed],
          });
          console.log("Stage 1 refreshed with the extension and conclusion links.");
        }
      }
    }
    state.conclusion_message_id = state.stages[FINAL_STAGE].message_id;
    state.status = "completed";
    saveState(state);
    d1Write(
      `UPDATE fb_discord_demo_runs SET status = 'completed', stages_json = ${quote(JSON.stringify(state.stages))}, source_sha = ${quote(state.build.source_sha ?? "")}, worker_version = ${quote(state.worker_version ?? "")}, updated_at = ${quote(new Date().toISOString())} WHERE id = ${quote(RUN_ID)};`,
    );
    console.log(
      JSON.stringify(
        {
          start: intro,
          conclusion,
          stages: Object.fromEntries(
            Object.entries(state.stages).map(([stage, value]) => [
              stage,
              messageLink(value.message_id),
            ]),
          ),
        },
        null,
        2,
      ),
    );
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
