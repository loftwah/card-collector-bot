import { ApiError, type Ctx } from "../context";
import { first, nowIso } from "../db";
import { auditStatement } from "../http";
import { newId, sha256Hex } from "../ids";
import { getInventory } from "../modules/collection";
import { adjustWallet, claimDailyReward, getEconomy } from "../modules/economy";
import { getWalletSummary } from "../modules/wallet";
import { getCard, listCards } from "../modules/catalogue";
import { executeDraw, getPoolPreview, listPools } from "../modules/pools";
import { HELP_TEXT } from "./command-definitions";
import { isBotAdmin, requireBotAdmin } from "./context";
import type {
  DiscordCallback,
  DiscordComponent,
  DiscordEmbed,
  DiscordInstallation,
  DiscordInteraction,
  DiscordMessage,
  DiscordOption,
} from "./types";

interface DrawReceipt {
  card_id: string;
  variant_id: string;
  card_name: string;
  variant_name: string;
  render_url: string | null;
  serial: string;
  pool_name: string;
  price: number;
  currency: { name: string; symbol: string };
  balance_after: number;
  probability_bps: number;
  drawn_at: string;
  replayed: boolean;
}

interface DailyReceipt {
  amount: number;
  currency: { name: string; symbol: string };
  balance_after: number;
  next_eligible_at: string;
  replayed: boolean;
}

interface GrantReceipt {
  amount: number;
  balance_after: number;
  replayed: boolean;
}

const RARITY_COLORS: Record<string, number> = {
  common: 0x8a8f98,
  uncommon: 0x3f9d5a,
  rare: 0x3b82f6,
  cabinet_rare: 0xa855f7,
  legendary: 0xf59e0b,
};

const SURFACE_COLUMNS: Record<string, string> = {
  game: "game_enabled",
  website: "website_enabled",
  api: "api_enabled",
  catalogue: "public_catalogue_enabled",
  admin: "admin_gui_enabled",
};

function absoluteUrl(origin: string, value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  if (/^https?:\/\//i.test(value)) return value;
  return `${origin.replace(/\/$/, "")}${value.startsWith("/") ? "" : "/"}${value}`;
}

function colorFor(rarityKey: string | null | undefined): number {
  return RARITY_COLORS[rarityKey ?? "common"] ?? 0x8a8f98;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function components(rows: DiscordComponent[][]): Array<{ type: number; components: DiscordComponent[] }> {
  return rows.filter((row) => row.length > 0).map((row) => ({ type: 1, components: row }));
}

function button(label: string, customId: string, style = 2): DiscordComponent {
  return { type: 2, style, label: label.slice(0, 80), custom_id: customId.slice(0, 100) };
}

function callback(message: DiscordMessage, ephemeral = false): DiscordCallback {
  return {
    type: 4,
    data: {
      ...message,
      allowed_mentions: { parse: [] },
      ...(ephemeral ? { flags: 64 } : {}),
    },
  };
}

function errorCallback(error: unknown, ephemeral = true): DiscordCallback {
  const apiError = error instanceof ApiError ? error : null;
  const detail =
    apiError?.details && typeof apiError.details.next_eligible_at === "string"
      ? `\nNext eligible: <t:${Math.floor(new Date(apiError.details.next_eligible_at).getTime() / 1000)}:R>`
      : "";
  const message = apiError?.message ?? "Foilbury could not complete that action. Nothing was changed.";
  return callback(
    {
      embeds: [
        {
          title: apiError?.code === "reward_cooldown" ? "Allowance not ready" : "Foilbury could not do that",
          description: `${truncate(message, 1500)}${detail}`,
          color: 0xd97757,
        },
      ],
    },
    ephemeral,
  );
}

function parseCommand(data: DiscordInteraction["data"]): {
  subcommand: string;
  values: Record<string, string | number | boolean>;
} {
  if (!data?.name) throw new ApiError(400, "discord_command_missing", "This interaction has no command name.");
  if (data.name !== "foilbury") throw new ApiError(404, "discord_command_unknown", "Unknown Foilbury command.");
  const top = data.options?.find((option) => option.type === 1 || option.type === 2);
  if (!top) throw new ApiError(400, "discord_subcommand_missing", "Choose a Foilbury subcommand.");
  let subcommand = top.name;
  let options: DiscordOption[] = top.options ?? [];
  if (top.type === 2) {
    const inner = options.find((option) => option.type === 1);
    if (!inner) throw new ApiError(400, "discord_subcommand_missing", "Choose an admin subcommand.");
    subcommand = `${top.name}:${inner.name}`;
    options = inner.options ?? [];
  }
  const values: Record<string, string | number | boolean> = {};
  for (const option of options) {
    if (option.type === 1 || option.type === 2) continue;
    if (option.value !== undefined) values[option.name] = option.value;
  }
  return { subcommand, values };
}

function poolName(values: Record<string, string | number | boolean>): string | undefined {
  const value = values.pool;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function validatePoolSlug(value: string): string {
  if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(value)) {
    throw new ApiError(422, "pool_invalid", "That pool name is not valid.");
  }
  return value;
}

async function openCard(
  ctx: Ctx,
  interaction: DiscordInteraction,
  installation: DiscordInstallation,
  requestedPool: string | undefined,
  idempotencyKey: string,
): Promise<DiscordCallback> {
  const poolSlug = validatePoolSlug(requestedPool ?? "cabinet-draw");
  const preview = await getPoolPreview(ctx, poolSlug, installation.channel_key ?? undefined);
  if (preview.eligible_count === 0) {
    throw new ApiError(
      409,
      "empty_pool",
      preview.filters.empty_reason ?? "This pool has no eligible cards right now. You were not charged.",
    );
  }
  const digest = await sha256Hex(`discord-open:${ctx.tenant.id}:${ctx.user!.id}:${poolSlug}:${interaction.id}`);
  const result = (await executeDraw(ctx, {
    pool: poolSlug,
    expectedRevision: preview.revision,
    channelKey: installation.channel_key ?? undefined,
    idempotency: { key: idempotencyKey, digest },
  })) as unknown as DrawReceipt;
  const image = absoluteUrl(ctx.config.publicOrigin, result.render_url);
  const render = await first<{ width: number; height: number; r2_key: string; mime: string }>(
    ctx.db,
    `SELECT vr.width, vr.height, a.r2_key, a.mime
       FROM fb_variant_renders vr JOIN fb_assets a ON a.id = vr.asset_id AND a.tenant_id = vr.tenant_id
      WHERE vr.tenant_id = ? AND vr.variant_id = ? AND vr.status = 'published' LIMIT 1`,
    ctx.tenant.id,
    result.variant_id,
  );
  const rarityName = await cardRarity(ctx, result.card_id);
  const rarityKey = await cardRarityKey(ctx, result.card_id);
  const fields = [
    { name: "Rarity", value: rarityName ?? "Unclassified", inline: true },
    { name: "Variant", value: result.variant_name, inline: true },
    { name: "Serial", value: `\`${result.serial}\``, inline: true },
    { name: "Pool", value: `${result.pool_name} · ${result.price} ${result.currency.symbol}`, inline: true },
    { name: "Balance", value: `${result.balance_after} ${result.currency.symbol}`, inline: true },
    { name: "Odds", value: `${(result.probability_bps / 100).toFixed(2)}% for this copy`, inline: true },
  ];
  if (result.replayed) {
    fields.push({ name: "Retry", value: "This is the recorded result of the original request; no second pull was made.", inline: false });
  }
  const embed: DiscordEmbed = {
    title: `${result.card_name} — ${result.variant_name}`,
    description: `Pulled from **${result.pool_name}**. This copy is in your collection immediately.`,
    color: colorFor(rarityKey),
    fields,
    footer: { text: `Foilbury · ${ctx.tenant.name} · inventory is Bot-scoped` },
    timestamp: result.drawn_at,
    ...(render?.r2_key
      ? { image: { url: "attachment://foilbury-card.webp", width: render.width, height: render.height } }
      : image
        ? { image: { url: image } }
        : {}),
  };
  const resultCallback = callback({
    embeds: [embed],
    components: components([
      [button("Open again", `foilbury:open:${poolSlug}`, 1), button("Collection", "foilbury:collection", 2)],
    ]),
  });
  if (render?.r2_key) {
    resultCallback.attachments = [{ r2Key: render.r2_key, filename: "foilbury-card.webp", contentType: render.mime || "image/webp" }];
  }
  return resultCallback;
}

async function cardRarity(ctx: Ctx, cardId: string): Promise<string | null> {
  const row = await first<{ name: string }>(
    ctx.db,
    `SELECT r.name FROM fb_card_definitions cd JOIN fb_rarities r ON r.id = cd.rarity_id WHERE cd.tenant_id = ? AND cd.id = ?`,
    ctx.tenant.id,
    cardId,
  );
  return row?.name ?? null;
}

async function cardRarityKey(ctx: Ctx, cardId: string): Promise<string | null> {
  const row = await first<{ key: string }>(
    ctx.db,
    `SELECT r.key FROM fb_card_definitions cd JOIN fb_rarities r ON r.id = cd.rarity_id WHERE cd.tenant_id = ? AND cd.id = ?`,
    ctx.tenant.id,
    cardId,
  );
  return row?.key ?? null;
}

async function daily(ctx: Ctx, interaction: DiscordInteraction): Promise<DiscordCallback> {
  const digest = await sha256Hex(`discord-daily:${ctx.tenant.id}:${ctx.user!.id}:${interaction.id}`);
  const result = (await claimDailyReward(ctx, { key: `discord:${interaction.id}:daily`, digest })) as unknown as DailyReceipt;
  return callback(
    {
      embeds: [
        {
          title: result.replayed ? "Allowance already claimed" : "Daily allowance claimed",
          description: `**+${result.amount}** ${result.currency.symbol} ${result.currency.name} added to your balance.${result.replayed ? "\nThis is the recorded result of the original request; no second credit was made." : ""}`,
          color: 0x3f9d5a,
          fields: [
            { name: "Balance", value: `${result.balance_after} ${result.currency.symbol}`, inline: true },
            {
              name: "Next allowance",
              value: `<t:${Math.floor(new Date(result.next_eligible_at).getTime() / 1000)}:R>`,
              inline: true,
            },
            { name: "Reset policy", value: "Daily, shared for this Bot across servers, website and API. Periods use UTC.", inline: false },
          ],
        },
      ],
      components: components([[button("Open a capsule", "foilbury:open:cabinet-draw", 1), button("Packs", "foilbury:packs", 2)]]),
    },
    true,
  );
}

async function collection(ctx: Ctx): Promise<DiscordCallback> {
  const inventory = await getInventory(ctx, { limit: 200 });
  const wallet = await getWalletSummary(ctx.db, ctx.tenant.id, ctx.user!.id, 1);
  if (inventory.length === 0) {
    return callback(
      {
        embeds: [
          {
            title: "Your cabinet is empty",
            description: "Claim `/foilbury daily`, then open a capsule. Your cards are tied to this Bot and will be here on every server where it is installed.",
            color: 0x8a8f98,
            fields: [{ name: "Balance", value: `${wallet.balance} ${wallet.currencySymbol}`, inline: true }],
          },
        ],
        components: components([[button("Open a capsule", "foilbury:open:cabinet-draw", 1), button("Packs", "foilbury:packs", 2)]]),
      },
      true,
    );
  }
  const counts = new Map<string, number>();
  for (const item of inventory) counts.set(item.card_id, (counts.get(item.card_id) ?? 0) + 1);
  const duplicates = [...counts.values()].filter((count) => count > 1).length;
  const lines = inventory.slice(0, 8).map(
    (item) =>
      `• **${item.card_name}** — ${item.variant_name} · ${item.rarity_name ?? "Unclassified"} · \`${item.serial}\``,
  );
  return callback(
    {
      embeds: [
        {
          title: "Your collection",
          description: lines.join("\n"),
          color: 0xc9a227,
          fields: [
            { name: "Owned", value: String(inventory.length), inline: true },
            { name: "Unique", value: String(counts.size), inline: true },
            { name: "Duplicates", value: String(duplicates), inline: true },
            { name: "Balance", value: `${wallet.balance} ${wallet.currencySymbol}`, inline: true },
            { name: "Scope", value: `Bot: **${ctx.tenant.name}**`, inline: true },
            { name: "More", value: "Open the website collection for filters, favourites and full provenance.", inline: false },
          ],
          footer: { text: "Showing the 8 most recent copies" },
        },
      ],
      components: components([[button("Open again", "foilbury:open:cabinet-draw", 1), button("Packs", "foilbury:packs", 2)]]),
    },
    true,
  );
}

async function card(ctx: Ctx, query: string): Promise<DiscordCallback> {
  let found: Awaited<ReturnType<typeof getCard>> | null = null;
  try {
    found = await getCard(ctx, query);
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== "card_not_found") throw error;
    const matches = await listCards(ctx, { search: query, limit: 5 });
    found = matches[0] ?? null;
    if (!found) throw error;
  }
  if (found.status !== "published" || found.archived_at) {
    if (!isBotAdmin(ctx.user!)) throw new ApiError(404, "card_not_found", "That card is not available in the public catalogue.");
  }
  const variants = found.editions.flatMap((edition) => edition.variants.filter((variant) => variant.status === "published"));
  const imageVariant = variants.find((variant) => variant.render_url);
  const image = absoluteUrl(ctx.config.publicOrigin, imageVariant?.render_url);
  const render = imageVariant
    ? await first<{ width: number; height: number }>(
        ctx.db,
        "SELECT width, height FROM fb_variant_renders WHERE tenant_id = ? AND variant_id = ? AND status = 'published' LIMIT 1",
        ctx.tenant.id,
        imageVariant.id,
      )
    : null;
  const fields = [
    { name: "Rarity", value: found.rarity?.name ?? "Unclassified", inline: true },
    { name: "Category", value: found.category?.name ?? "Uncategorised", inline: true },
    { name: "Variants", value: String(variants.length), inline: true },
    { name: "Tags", value: found.tags.length ? found.tags.map((tag) => tag.name).join(", ") : "None", inline: false },
    { name: "Sets", value: found.sets.length ? found.sets.map((set) => set.name).join(", ") : "None", inline: false },
  ];
  return callback(
    {
      embeds: [
        {
          title: found.name,
          description: truncate(found.description, 1800),
          color: colorFor(found.rarity?.key),
          fields,
          footer: { text: `Foilbury catalogue · ${ctx.tenant.name}` },
          ...(image ? { image: { url: image, width: render?.width, height: render?.height } } : {}),
        },
      ],
    },
    true,
  );
}

async function packs(ctx: Ctx, installation: DiscordInstallation): Promise<DiscordCallback> {
  const pools = await listPools(ctx);
  if (pools.length === 0) {
    return callback(
      { embeds: [{ title: "No packs available", description: "This Bot has no active capsule pools yet.", color: 0x8a8f98 }] },
      true,
    );
  }
  const lines: string[] = [];
  for (const pool of pools.slice(0, 10)) {
    try {
      const preview = await getPoolPreview(ctx, pool.slug, installation.channel_key ?? undefined);
      lines.push(
        `**${pool.name}** · \`${pool.slug}\`\n${pool.description}\n${preview.price} ✦ · ${preview.eligible_count} eligible · revision ${pool.revision}`,
      );
    } catch {
      lines.push(`**${pool.name}** · \`${pool.slug}\`\n${pool.description}\nCurrently unavailable.`);
    }
  }
  return callback(
    {
      embeds: [
        {
          title: "Eligible capsule pools",
          description: lines.join("\n\n"),
          color: 0xc9a227,
          footer: { text: "Use /foilbury open <pool> or the button below" },
        },
      ],
      components: components([[button("Open cabinet-draw", "foilbury:open:cabinet-draw", 1)]]),
    },
    true,
  );
}

async function profile(ctx: Ctx, installation: DiscordInstallation): Promise<DiscordCallback> {
  const wallet = await getWalletSummary(ctx.db, ctx.tenant.id, ctx.user!.id, 1);
  const inventory = await getInventory(ctx, { limit: 500 });
  const lastReward = await first<{ created_at: string }>(
    ctx.db,
    "SELECT created_at FROM fb_reward_claims WHERE tenant_id = ? AND user_id = ? AND rule_key = 'daily-allowance' ORDER BY created_at DESC LIMIT 1",
    ctx.tenant.id,
    ctx.user!.id,
  );
  const economy = await getEconomy(ctx);
  const next = lastReward
    ? new Date(new Date(lastReward.created_at).getTime() + economy.daily_cooldown_seconds * 1000)
    : null;
  return callback(
    {
      embeds: [
        {
          title: ctx.user!.displayName,
          description: `Player in **${ctx.tenant.name}**${isBotAdmin(ctx.user!) ? " · Bot administration available" : ""}`,
          color: 0x7c6b4f,
          fields: [
            { name: "Balance", value: `${wallet.balance} ${wallet.currencySymbol}`, inline: true },
            { name: "Owned cards", value: String(inventory.length), inline: true },
            {
              name: "Daily",
              value: next
                ? next.getTime() > Date.now()
                  ? `<t:${Math.floor(next.getTime() / 1000)}:R>`
                  : "Ready now"
                : "Ready now",
              inline: true,
            },
            { name: "Server", value: installation.guild_name ?? installation.guild_id, inline: true },
            { name: "Inventory scope", value: "This Bot across every server", inline: true },
            { name: "Privacy", value: "This response is only visible to you.", inline: false },
          ],
        },
      ],
      components: components([[button("Daily", "foilbury:daily", 2), button("Collection", "foilbury:collection", 2)]]),
    },
    true,
  );
}

function help(ctx: Ctx): DiscordCallback {
  return callback(
    {
      embeds: [
        {
          title: "Foilbury commands",
          description: HELP_TEXT,
          color: 0xc9a227,
          fields: [
            { name: "This installation", value: `${ctx.tenant.name}`, inline: true },
            { name: "Need a website account?", value: "Only Bot Owners and Admins need one. Players collect immediately with Discord.", inline: false },
          ],
        },
      ],
    },
    true,
  );
}

async function adminStatus(ctx: Ctx, installation: DiscordInstallation): Promise<DiscordCallback> {
  requireBotAdmin(ctx.user!);
  const counts = await first<{ cards: number; pools: number; inventory: number; members: number }>(
    ctx.db,
    `SELECT
       (SELECT COUNT(*) FROM fb_card_definitions WHERE tenant_id = ? AND status = 'published' AND archived_at IS NULL) AS cards,
       (SELECT COUNT(*) FROM fb_pools WHERE tenant_id = ? AND status = 'active') AS pools,
       (SELECT COUNT(*) FROM fb_card_instances WHERE tenant_id = ? AND status IN ('owned','reserved')) AS inventory,
       (SELECT COUNT(*) FROM fb_memberships WHERE tenant_id = ?) AS members`,
    ctx.tenant.id,
    ctx.tenant.id,
    ctx.tenant.id,
    ctx.tenant.id,
  );
  return callback(
    {
      embeds: [
        {
          title: `Bot status · ${ctx.tenant.name}`,
          description: "This is Bot administration, not Foilbury platform administration.",
          color: 0x3f9d5a,
          fields: [
            { name: "Guild", value: `${installation.guild_name ?? "Unknown"} (\`${installation.guild_id}\`)`, inline: false },
            { name: "Channel allowlist", value: installation.channel_allowlist_json, inline: false },
            { name: "Game / website / API", value: `${installation.game_enabled} / ${installation.website_enabled} / ${installation.api_enabled}`, inline: false },
            { name: "Catalogue / admin GUI", value: `${installation.public_catalogue_enabled} / ${installation.admin_gui_enabled}`, inline: false },
            { name: "Published cards", value: String(counts?.cards ?? 0), inline: true },
            { name: "Active pools", value: String(counts?.pools ?? 0), inline: true },
            { name: "Owned cards", value: String(counts?.inventory ?? 0), inline: true },
            { name: "Members", value: String(counts?.members ?? 0), inline: true },
          ],
        },
      ],
    },
    true,
  );
}

async function adminSettings(ctx: Ctx, installation: DiscordInstallation): Promise<DiscordCallback> {
  requireBotAdmin(ctx.user!);
  const economy = await getEconomy(ctx);
  return callback(
    {
      embeds: [
        {
          title: "Bot settings",
          description: "Availability switches are independent. Disabling one does not delete inventory or disable another interface.",
          color: 0x7c6b4f,
          fields: [
            { name: "Currency", value: `${economy.currency_name} (${economy.currency_symbol})`, inline: true },
            { name: "Starter grant", value: String(economy.starter_grant), inline: true },
            { name: "Daily allowance", value: String(economy.daily_reward), inline: true },
            { name: "Cooldown", value: `${Math.round(economy.daily_cooldown_seconds / 3600)} hours`, inline: true },
            { name: "Game", value: installation.game_enabled ? "enabled" : "disabled", inline: true },
            { name: "Website", value: installation.website_enabled ? "enabled" : "disabled", inline: true },
            { name: "External API", value: installation.api_enabled ? "enabled" : "disabled", inline: true },
            { name: "Public catalogue", value: installation.public_catalogue_enabled ? "enabled" : "disabled", inline: true },
            { name: "Admin GUI", value: installation.admin_gui_enabled ? "enabled" : "disabled", inline: true },
            { name: "Sensitive changes", value: "Use /foilbury admin enable|disable and confirm with the button. Grants require confirmation.", inline: false },
          ],
        },
      ],
    },
    true,
  );
}

async function adminPools(ctx: Ctx, installation: DiscordInstallation): Promise<DiscordCallback> {
  requireBotAdmin(ctx.user!);
  const pools = await listPools(ctx, true);
  const lines: string[] = [];
  for (const pool of pools.slice(0, 12)) {
    let eligible = "—";
    try {
      const preview = await getPoolPreview(ctx, pool.slug, installation.channel_key ?? undefined, { includeDraft: true });
      eligible = String(preview.eligible_count);
    } catch {
      eligible = "0";
    }
    lines.push(`• **${pool.name}** \`${pool.slug}\` · ${pool.status} · rev ${pool.revision} · ${pool.price} ✦ · ${eligible} eligible`);
  }
  return callback(
    {
      embeds: [
        {
          title: "Pools",
          description: lines.length ? lines.join("\n") : "No pools configured.",
          color: 0x7c6b4f,
          footer: { text: "Pool membership and card availability are enforced by the domain service." },
        },
      ],
    },
    true,
  );
}

async function createConfirmation(
  ctx: Ctx,
  interaction: DiscordInteraction,
  action: string,
  payload: Record<string, unknown>,
  title: string,
  description: string,
): Promise<DiscordCallback> {
  const id = newId("dcf");
  const expiresAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();
  await ctx.db
    .prepare(
      "INSERT INTO fb_discord_confirmations (id, tenant_id, discord_user_id, action, payload_json, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(id, ctx.tenant.id, interaction.member?.user?.id ?? interaction.user?.id ?? "", action, JSON.stringify(payload), expiresAt, nowIso())
    .run();
  return callback(
    {
      embeds: [
        {
          title,
          description: `${description}\n\nThis confirmation expires <t:${Math.floor(new Date(expiresAt).getTime() / 1000)}:R> and is bound to your Discord account.`,
          color: 0xd97757,
        },
      ],
      components: components([[button("Confirm", `foilbury:confirm:${id}`, 3), button("Cancel", `foilbury:cancel:${id}`, 4)]]),
    },
    true,
  );
}

async function adminToggle(
  ctx: Ctx,
  interaction: DiscordInteraction,
  installation: DiscordInstallation,
  surface: string,
  enabled: boolean,
): Promise<DiscordCallback> {
  requireBotAdmin(ctx.user!);
  const column = SURFACE_COLUMNS[surface];
  if (!column) throw new ApiError(422, "surface_invalid", "Choose a valid availability surface.");
  return createConfirmation(
    ctx,
    interaction,
    "installation.toggle",
    { surface, enabled, installationId: installation.id },
    `${enabled ? "Enable" : "Disable"} ${surface}?`,
    `This changes **${surface}** availability for **${ctx.tenant.name}** in this installation. It does not delete cards, inventory or ledger history.`,
  );
}

async function adminGrant(
  ctx: Ctx,
  interaction: DiscordInteraction,
  values: Record<string, string | number | boolean>,
): Promise<DiscordCallback> {
  requireBotAdmin(ctx.user!);
  if (ctx.user!.role !== "owner" && ctx.user!.role !== "economy_admin") {
    throw new ApiError(403, "insufficient_role", "Only this Bot's Owner or Economy Admin can grant Foil.");
  }
  const rawUser = typeof values.user === "string" ? values.user.trim() : "";
  const discordUserId = rawUser.match(/^<@!?(\d{15,22})>$/) ?.[1] ?? rawUser.match(/^\d{15,22}$/)?.[0];
  if (!discordUserId) throw new ApiError(422, "discord_user_invalid", "Use a Discord user ID or mention.");
  const amount = typeof values.amount === "number" ? values.amount : Number(values.amount);
  if (!Number.isInteger(amount) || amount <= 0) throw new ApiError(422, "amount_invalid", "Amount must be a positive integer.");
  const reason = typeof values.reason === "string" ? values.reason.trim() : "";
  if (reason.length < 3) throw new ApiError(422, "reason_required", "Record a short reason for the grant.");
  const target = await first<{ user_id: string }>(
    ctx.db,
    "SELECT user_id FROM fb_discord_identities WHERE tenant_id = ? AND discord_user_id = ? AND revoked_at IS NULL",
    ctx.tenant.id,
    discordUserId,
  );
  if (!target) throw new ApiError(404, "player_not_linked", "That Discord user has not played this Bot yet, so there is no inventory to credit.");
  return createConfirmation(
    ctx,
    interaction,
    "wallet.grant",
    { targetUserId: target.user_id, amount, reason },
    "Confirm admin grant",
    `Grant **${amount} Foil** to <@${discordUserId}> with reason: ${truncate(reason, 200)}. This is an audited admin grant, not a random drop.`,
  );
}

export async function runCommand(
  ctx: Ctx,
  interaction: DiscordInteraction,
  installation: DiscordInstallation,
): Promise<DiscordCallback> {
  const { subcommand, values } = parseCommand(interaction.data);
  switch (subcommand) {
    case "open":
      return openCard(ctx, interaction, installation, poolName(values), `discord:${interaction.id}:open`);
    case "daily":
      return daily(ctx, interaction);
    case "collection":
      return collection(ctx);
    case "card": {
      const query = typeof values.query === "string" ? values.query.trim() : "";
      if (!query) throw new ApiError(422, "card_query_required", "Provide a card name, slug or ID.");
      return card(ctx, query);
    }
    case "packs":
      return packs(ctx, installation);
    case "profile":
      return profile(ctx, installation);
    case "help":
      return help(ctx);
    case "admin:status":
      return adminStatus(ctx, installation);
    case "admin:settings":
      return adminSettings(ctx, installation);
    case "admin:pools":
      return adminPools(ctx, installation);
    case "admin:enable": {
      const surface = typeof values.surface === "string" ? values.surface : "";
      return adminToggle(ctx, interaction, installation, surface, true);
    }
    case "admin:disable": {
      const surface = typeof values.surface === "string" ? values.surface : "";
      return adminToggle(ctx, interaction, installation, surface, false);
    }
    case "admin:grant":
      return adminGrant(ctx, interaction, values);
    default:
      throw new ApiError(404, "discord_command_unknown", "That Foilbury command is not implemented.");
  }
}

async function executeConfirmation(
  ctx: Ctx,
  interaction: DiscordInteraction,
  confirmationId: string,
): Promise<DiscordCallback> {
  const discordUserId = interaction.member?.user?.id ?? interaction.user?.id ?? "";
  const row = await first<{
    id: string;
    tenant_id: string;
    discord_user_id: string;
    action: string;
    payload_json: string;
    expires_at: string;
    used_at: string | null;
  }>(
    ctx.db,
    "SELECT id, tenant_id, discord_user_id, action, payload_json, expires_at, used_at FROM fb_discord_confirmations WHERE id = ? AND tenant_id = ?",
    confirmationId,
    ctx.tenant.id,
  );
  if (!row) throw new ApiError(404, "confirmation_missing", "That confirmation does not exist.");
  if (row.discord_user_id !== discordUserId) throw new ApiError(403, "confirmation_not_yours", "This confirmation belongs to another user.");
  if (row.used_at) throw new ApiError(409, "confirmation_used", "That confirmation has already been used.");
  if (new Date(row.expires_at).getTime() <= Date.now()) throw new ApiError(409, "confirmation_expired", "That confirmation expired. Run the admin command again.");
  requireBotAdmin(ctx.user!);
  const payload = JSON.parse(row.payload_json) as Record<string, unknown>;

  if (row.action === "installation.toggle") {
    const surface = typeof payload.surface === "string" ? payload.surface : "";
    const enabled = Boolean(payload.enabled);
    const installationId = typeof payload.installationId === "string" ? payload.installationId : "";
    const column = SURFACE_COLUMNS[surface];
    if (!column || !installationId) throw new ApiError(422, "surface_invalid", "Unknown availability surface.");
    await ctx.db.batch([
      ctx.db
        .prepare(`UPDATE fb_discord_installations SET ${column} = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`)
        .bind(enabled ? 1 : 0, nowIso(), installationId, ctx.tenant.id),
      ctx.db
        .prepare("UPDATE fb_discord_confirmations SET used_at = ? WHERE id = ? AND used_at IS NULL")
        .bind(nowIso(), confirmationId),
      auditStatement(ctx, enabled ? "discord.surface.enabled" : "discord.surface.disabled", "discord_installation", installationId, {
        surface,
        enabled,
      }),
    ]);
    return callback(
      {
        embeds: [
          {
            title: `${surface} ${enabled ? "enabled" : "disabled"}`,
            description: "The change is live. Inventory, ownership history and the other interfaces are unchanged.",
            color: enabled ? 0x3f9d5a : 0xd97757,
          },
        ],
      },
      true,
    );
  }

  if (row.action === "wallet.grant") {
    const targetUserId = typeof payload.targetUserId === "string" ? payload.targetUserId : "";
    const amount = typeof payload.amount === "number" ? payload.amount : Number(payload.amount);
    const reason = typeof payload.reason === "string" ? payload.reason : "Discord admin grant";
    if (!targetUserId || !Number.isInteger(amount) || amount <= 0) throw new ApiError(422, "grant_invalid", "The recorded grant is invalid.");
    const digest = await sha256Hex(`discord-grant:${confirmationId}:${targetUserId}:${amount}:${reason}`);
    const result = (await adjustWallet(ctx, {
      userId: targetUserId,
      amount,
      reason,
      idempotency: { key: `discord:grant:${confirmationId}`, digest },
    })) as unknown as GrantReceipt;
    await ctx.db
      .prepare("UPDATE fb_discord_confirmations SET used_at = ? WHERE id = ? AND used_at IS NULL")
      .bind(nowIso(), confirmationId)
      .run();
    return callback(
      {
        embeds: [
          {
            title: "Admin grant recorded",
            description: `Credited **${amount} Foil** to <@${discordUserId}>.\nBalance after: **${result.balance_after}**.\nReason: ${truncate(reason, 300)}`,
            color: 0x3f9d5a,
            footer: { text: "Audited admin grant, separate from random draws" },
          },
        ],
      },
      true,
    );
  }

  throw new ApiError(422, "confirmation_action_unknown", "That confirmation action is not supported.");
}

export async function runComponent(
  ctx: Ctx,
  interaction: DiscordInteraction,
  installation: DiscordInstallation,
): Promise<DiscordCallback> {
  const customId = interaction.data?.custom_id ?? "";
  if (customId.startsWith("foilbury:open:")) {
    const pool = validatePoolSlug(customId.slice("foilbury:open:".length));
    return openCard(ctx, interaction, installation, pool, `discord:${interaction.id}:open`);
  }
  if (customId === "foilbury:collection") return collection(ctx);
  if (customId === "foilbury:daily") return daily(ctx, interaction);
  if (customId === "foilbury:packs") return packs(ctx, installation);
  if (customId === "foilbury:help") return help(ctx);
  if (customId.startsWith("foilbury:confirm:")) {
    return executeConfirmation(ctx, interaction, customId.slice("foilbury:confirm:".length));
  }
  if (customId.startsWith("foilbury:cancel:")) {
    const id = customId.slice("foilbury:cancel:".length);
    const discordUserId = interaction.member?.user?.id ?? interaction.user?.id ?? "";
    const row = await first<{ discord_user_id: string; used_at: string | null }>(
      ctx.db,
      "SELECT discord_user_id, used_at FROM fb_discord_confirmations WHERE id = ? AND tenant_id = ?",
      id,
      ctx.tenant.id,
    );
    if (!row || row.discord_user_id !== discordUserId) throw new ApiError(403, "confirmation_not_yours", "This confirmation belongs to another user.");
    if (!row.used_at) {
      await ctx.db.prepare("UPDATE fb_discord_confirmations SET used_at = ? WHERE id = ?").bind(nowIso(), id).run();
    }
    return callback({ embeds: [{ title: "Cancelled", description: "No change was made.", color: 0x8a8f98 }] }, true);
  }
  throw new ApiError(404, "discord_component_unknown", "That button is not recognised.");
}

export { errorCallback };
