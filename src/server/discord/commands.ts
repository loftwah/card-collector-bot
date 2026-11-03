import { ApiError, type Ctx } from "../context";
import { first, nowIso } from "../db";
import { auditStatement } from "../http";
import { newId, sha256Hex } from "../ids";
import { getInventory } from "../modules/collection";
import { displayFinish } from "../../lib/utils";
import { adjustWallet, claimDailyReward, getEconomy } from "../modules/economy";
import { getWalletSummary } from "../modules/wallet";
import { getCard, listCards } from "../modules/catalogue";
import {
  collectionProgress,
  getCollection,
  listCollectionCards,
  listCollections,
  listPublicCollections,
} from "../modules/collections";
import { executeDraw, getPoolPreview, listPools } from "../modules/pools";
import { finishKey, listAchievements } from "../modules/achievements";
import { compareNpc, listNpcProfiles } from "../modules/npcs";
import { audienceRank, canViewCard, effectiveCardAudience } from "../modules/visibility";
import { HELP_TEXT } from "./command-definitions";
import { channelAudienceFor, isBotAdmin, requireBotAdmin } from "./context";
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
  material_key: string;
  effect_key: string | null;
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

function components(
  rows: DiscordComponent[][],
): Array<{ type: number; components: DiscordComponent[] }> {
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
  const message =
    apiError?.message ?? "Foilbury could not complete that action. Nothing was changed.";
  return callback(
    {
      embeds: [
        {
          title:
            apiError?.code === "reward_cooldown"
              ? "Allowance not ready"
              : "Foilbury could not do that",
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
  if (!data?.name)
    throw new ApiError(400, "discord_command_missing", "This interaction has no command name.");
  if (data.name !== "foilbury")
    throw new ApiError(404, "discord_command_unknown", "Unknown Foilbury command.");
  const top = data.options?.find((option) => option.type === 1 || option.type === 2);
  if (!top) throw new ApiError(400, "discord_subcommand_missing", "Choose a Foilbury subcommand.");
  let subcommand = top.name;
  let options: DiscordOption[] = top.options ?? [];
  if (top.type === 2) {
    const inner = options.find((option) => option.type === 1);
    if (!inner)
      throw new ApiError(400, "discord_subcommand_missing", "Choose an admin subcommand.");
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
      preview.filters.empty_reason ??
        "This pool has no eligible cards right now. You were not charged.",
    );
  }
  const digest = await sha256Hex(
    `discord-open:${ctx.tenant.id}:${ctx.user!.id}:${poolSlug}:${interaction.id}`,
  );
  const result = (await executeDraw(ctx, {
    pool: poolSlug,
    expectedRevision: preview.revision,
    expectedDistribution: preview.distribution_fingerprint,
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
  const cardAudience = await effectiveCardAudience(ctx, result.card_id);
  const channelAudience = channelAudienceFor(installation, interaction.channel_id);
  const shareInChannel =
    cardAudience !== "private" && audienceRank(channelAudience) >= audienceRank(cardAudience);
  const fields = [
    { name: "Rarity", value: rarityName ?? "Unclassified", inline: true },
    {
      name: "Variant",
      value: displayFinish(result.variant_name, result.material_key, result.effect_key),
      inline: true,
    },
    { name: "Serial", value: `\`${result.serial}\``, inline: true },
    {
      name: "Pool",
      value: `${result.pool_name} · ${result.price} ${result.currency.symbol}`,
      inline: true,
    },
    { name: "Balance", value: `${result.balance_after} ${result.currency.symbol}`, inline: true },
    {
      name: "Odds",
      value: `${(result.probability_bps / 100).toFixed(2)}% for this copy`,
      inline: true,
    },
  ];
  if (!shareInChannel) {
    fields.push({
      name: "Private reveal",
      value: `This collection is ${cardAudience === "private" ? "private" : "members-only"}. The card is yours, but this channel has not been verified for that audience, so the artwork is visible only to you.`,
      inline: false,
    });
  }
  if (result.replayed) {
    fields.push({
      name: "Retry",
      value: "This is the recorded result of the original request; no second pull was made.",
      inline: false,
    });
  }
  const embed: DiscordEmbed = {
    title: `${result.card_name} — ${result.variant_name}`,
    description: `Pulled from **${result.pool_name}**. This copy is in your collection immediately.`,
    color: colorFor(rarityKey),
    fields,
    footer: { text: `Foilbury · ${ctx.tenant.name} · inventory is Bot-scoped` },
    timestamp: result.drawn_at,
    ...(render?.r2_key
      ? {
          image: {
            url: "attachment://foilbury-card.webp",
            width: render.width,
            height: render.height,
          },
        }
      : image
        ? { image: { url: image } }
        : {}),
  };
  const resultCallback = callback(
    {
      embeds: [embed],
      components: components([
        [
          button("Open again", `foilbury:open:${poolSlug}`, 1),
          button("Collection", "foilbury:collection", 2),
          button("Tour", "foilbury:tour:progress", 2),
        ],
      ]),
    },
    !shareInChannel,
  );
  if (render?.r2_key) {
    resultCallback.attachments = [
      {
        r2Key: render.r2_key,
        filename: "foilbury-card.webp",
        contentType: render.mime || "image/webp",
      },
    ];
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
  const digest = await sha256Hex(
    `discord-daily:${ctx.tenant.id}:${ctx.user!.id}:${interaction.id}`,
  );
  const result = (await claimDailyReward(ctx, {
    key: `discord:${interaction.id}:daily`,
    digest,
  })) as unknown as DailyReceipt;
  return callback(
    {
      embeds: [
        {
          title: result.replayed ? "Allowance already claimed" : "Daily allowance claimed",
          description: `**+${result.amount}** ${result.currency.symbol} ${result.currency.name} added to your balance.${result.replayed ? "\nThis is the recorded result of the original request; no second credit was made." : ""}`,
          color: 0x3f9d5a,
          fields: [
            {
              name: "Balance",
              value: `${result.balance_after} ${result.currency.symbol}`,
              inline: true,
            },
            {
              name: "Next allowance",
              value: `<t:${Math.floor(new Date(result.next_eligible_at).getTime() / 1000)}:R>`,
              inline: true,
            },
            {
              name: "Reset policy",
              value: "Daily, shared for this Bot across servers, website and API. Periods use UTC.",
              inline: false,
            },
          ],
        },
      ],
      components: components([
        [
          button("Open a capsule", "foilbury:open:cabinet-draw", 1),
          button("Packs", "foilbury:packs", 2),
        ],
      ]),
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
            description:
              "Claim `/foilbury daily`, then open a capsule. Your cards are tied to this Bot and will be here on every server where it is installed.",
            color: 0x8a8f98,
            fields: [
              {
                name: "Balance",
                value: `${wallet.balance} ${wallet.currencySymbol}`,
                inline: true,
              },
            ],
          },
        ],
        components: components([
          [
            button("Open a capsule", "foilbury:open:cabinet-draw", 1),
            button("Packs", "foilbury:packs", 2),
          ],
        ]),
      },
      true,
    );
  }
  const counts = new Map<string, number>();
  for (const item of inventory) counts.set(item.card_id, (counts.get(item.card_id) ?? 0) + 1);
  const duplicates = [...counts.values()].filter((count) => count > 1).length;
  const lines = inventory
    .slice(0, 8)
    .map(
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
            {
              name: "More",
              value: "Open the website collection for filters, favourites and full provenance.",
              inline: false,
            },
          ],
          footer: { text: "Showing the 8 most recent copies" },
        },
      ],
      components: components([
        [
          button("Open again", "foilbury:open:cabinet-draw", 1),
          button("Packs", "foilbury:packs", 2),
        ],
      ]),
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
    if (!isBotAdmin(ctx.user!))
      throw new ApiError(
        404,
        "card_not_found",
        "That card is not available in the public catalogue.",
      );
  }
  const variants = found.editions.flatMap((edition) =>
    edition.variants.filter((variant) => variant.status === "published"),
  );
  const imageVariant = variants.find((variant) => variant.render_url);
  const render = imageVariant
    ? await first<{ width: number; height: number; r2_key: string; mime: string }>(
        ctx.db,
        `SELECT vr.width, vr.height, a.r2_key, a.mime FROM fb_variant_renders vr
           JOIN fb_assets a ON a.id = vr.asset_id AND a.tenant_id = vr.tenant_id
          WHERE vr.tenant_id = ? AND vr.variant_id = ? AND vr.status = 'published' LIMIT 1`,
        ctx.tenant.id,
        imageVariant.id,
      )
    : null;
  const fields = [
    { name: "Rarity", value: found.rarity?.name ?? "Unclassified", inline: true },
    { name: "Category", value: found.category?.name ?? "Uncategorised", inline: true },
    { name: "Variants", value: String(variants.length), inline: true },
    {
      name: "Tags",
      value: found.tags.length ? found.tags.map((tag) => tag.name).join(", ") : "None",
      inline: false,
    },
    {
      name: "Sets",
      value: found.sets.length ? found.sets.map((set) => set.name).join(", ") : "None",
      inline: false,
    },
  ];
  const resultCallback = callback(
    {
      embeds: [
        {
          title: found.name,
          description: truncate(found.description, 1800),
          color: colorFor(found.rarity?.key),
          fields,
          footer: { text: `Foilbury catalogue · ${ctx.tenant.name}` },
          ...(render
            ? {
                image: {
                  url: "attachment://foilbury-card.webp",
                  width: render.width,
                  height: render.height,
                },
              }
            : {}),
        },
        ...(variants.length
          ? [
              {
                title: "Private next steps",
                description:
                  "Viewing another side or reading details never spends Foil or awards another copy.",
                color: 0x7c6b4f,
              },
            ]
          : []),
      ],
      components: components([
        ...(imageVariant
          ? [
              [
                button("View back", `foilbury:card:${found.id}:${imageVariant.id}:back`, 2),
                button("Details", `foilbury:card:${found.id}:${imageVariant.id}:details`, 2),
                {
                  type: 2,
                  style: 5,
                  label: "Open my album",
                  url: absoluteUrl(ctx.config.publicOrigin, "/play/collection")!,
                },
              ],
            ]
          : []),
      ]),
    },
    true,
  );
  if (render)
    resultCallback.attachments = [
      {
        r2Key: render.r2_key,
        filename: "foilbury-card.webp",
        contentType: render.mime || "image/webp",
      },
    ];
  return resultCallback;
}

async function cardFace(
  ctx: Ctx,
  cardId: string,
  variantId: string | null,
  side: "front" | "back",
): Promise<DiscordCallback> {
  const found = await getCard(ctx, cardId);
  if (found.status !== "published")
    throw new ApiError(404, "card_not_found", "That card is not published.");
  const variants = found.editions.flatMap((edition) =>
    edition.variants.filter((variant) => variant.status === "published"),
  );
  const variant =
    variants.find((item) => item.id === variantId) ?? variants.find((item) => item.render_url);
  if (!variant) throw new ApiError(404, "render_missing", "That card has no finished render yet.");
  const render = await first<{ width: number; height: number; r2_key: string; mime: string }>(
    ctx.db,
    side === "front"
      ? `SELECT vr.width, vr.height, a.r2_key, a.mime FROM fb_variant_renders vr
           JOIN fb_assets a ON a.id = vr.asset_id AND a.tenant_id = vr.tenant_id
          WHERE vr.tenant_id = ? AND vr.variant_id = ? AND vr.status = 'published' LIMIT 1`
      : `SELECT br.width, br.height, a.r2_key, a.mime FROM fb_variant_back_renders br
           JOIN fb_assets a ON a.id = br.asset_id AND a.tenant_id = br.tenant_id
          WHERE br.tenant_id = ? AND br.variant_id = ? AND br.status = 'published' LIMIT 1`,
    ctx.tenant.id,
    variant.id,
  );
  if (!render)
    throw new ApiError(404, "render_missing", `That card has no finished ${side} render yet.`);
  const collection = found.collections[0];
  const embed: DiscordEmbed = {
    title: `${found.name} — ${variant.name}`,
    description: truncate(
      side === "front" ? found.description : (found.bio_safe ?? found.bio ?? found.description),
      1500,
    ),
    color: colorFor(found.rarity?.key),
    fields: [
      { name: "Collection", value: collection?.name ?? "Cabinet", inline: true },
      { name: "Side", value: side === "front" ? "Front" : "Back", inline: true },
      {
        name: "Source",
        value: found.source_work ?? found.sets[0]?.name ?? "Foilbury",
        inline: true,
      },
    ],
    footer: { text: "Private member view · viewing does not spend Foil or award another copy" },
    image: {
      url: `attachment://foilbury-${side}.webp`,
      width: render.width,
      height: render.height,
    },
  };
  const resultCallback = callback(
    {
      embeds: [embed],
      components: components([
        [
          button(
            side === "front" ? "View back" : "View front",
            `foilbury:card:${found.id}:${variant.id}:${side === "front" ? "back" : "front"}`,
            2,
          ),
          button("Details", `foilbury:card:${found.id}:${variant.id}:details`, 2),
          {
            type: 2,
            style: 5,
            label: "Open my album",
            url: absoluteUrl(ctx.config.publicOrigin, "/play/collection")!,
          },
        ],
      ]),
    },
    true,
  );
  resultCallback.attachments = [
    {
      r2Key: render.r2_key,
      filename: `foilbury-${side}.webp`,
      contentType: render.mime || "image/webp",
    },
  ];
  return resultCallback;
}

async function cardDetails(ctx: Ctx, cardId: string): Promise<DiscordCallback> {
  const found = await getCard(ctx, cardId);
  const owned = await first<{ copies: number; finishes: number; serials: string | null }>(
    ctx.db,
    `SELECT COUNT(*) AS copies, COUNT(DISTINCT material.key) AS finishes,
            GROUP_CONCAT(ci.serial, ', ') AS serials
       FROM fb_card_instances ci
       JOIN fb_variants v ON v.id = ci.variant_id
       JOIN fb_materials material ON material.id = v.material_id
      WHERE ci.tenant_id = ? AND ci.user_id = ? AND ci.card_id = ? AND ci.status IN ('owned','reserved')`,
    ctx.tenant.id,
    ctx.user!.id,
    found.id,
  );
  const attributes = (() => {
    try {
      return JSON.parse(found.attributes_json ?? "[]") as Array<{ label?: string; value?: string }>;
    } catch {
      return [];
    }
  })();
  return callback(
    {
      embeds: [
        {
          title: `${found.name} · details`,
          description: truncate(found.bio_safe ?? found.bio ?? found.description, 1800),
          color: colorFor(found.rarity?.key),
          fields: [
            { name: "Collection", value: found.collections[0]?.name ?? "Cabinet", inline: true },
            { name: "Source", value: found.source_work ?? "Foilbury", inline: true },
            { name: "Rarity", value: found.rarity?.name ?? "Unclassified", inline: true },
            ...attributes
              .slice(0, 5)
              .map((attr) => ({
                name: attr.label ?? "Detail",
                value: attr.value ?? "—",
                inline: true,
              })),
            {
              name: "Your copies",
              value: owned?.copies
                ? `${owned.copies} across ${owned.finishes} finish${owned.finishes === 1 ? "" : "es"}`
                : "Not in your album yet",
              inline: false,
            },
            {
              name: "Spoilers",
              value: found.spoiler_level
                ? `This profile has ${found.spoiler_level} spoiler layer${found.spoiler_level === 1 ? "" : "s"}. The full text is available in the website album after opting in.`
                : "This profile is spoiler-safe.",
              inline: false,
            },
          ],
          footer: { text: "Private member view · no draw, charge or new copy" },
        },
      ],
    },
    true,
  );
}

async function achievements(ctx: Ctx): Promise<DiscordCallback> {
  const items = await listAchievements(ctx, ctx.user!.id);
  const earned = items.filter((item) => item.state === "earned");
  const close = items
    .filter((item) => item.state !== "earned")
    .sort((a, b) => b.progress / Math.max(1, b.target) - a.progress / Math.max(1, a.target))
    .slice(0, 5);
  return callback(
    {
      embeds: [
        {
          title: "Achievements",
          description: earned.length
            ? `You have earned **${earned.length}** of ${items.length}. Rewards are credited once and never removed when a collection grows.`
            : "Your first card is the first badge. Every milestone below uses your committed collection history.",
          color: 0xc9a227,
          fields: [
            {
              name: "Earned",
              value: earned.length
                ? earned
                    .slice(0, 8)
                    .map(
                      (item) =>
                        `• **${item.name}** — ${item.reward_amount ? `+${item.reward_amount} Foil` : "badge"}`,
                    )
                    .join("\n")
                : "No badges yet.",
              inline: false,
            },
            {
              name: "Closest next",
              value: close.length
                ? close
                    .map(
                      (item) =>
                        `• **${item.name}** — ${Math.min(item.progress, item.target)}/${item.target}`,
                    )
                    .join("\n")
                : "Everything visible is complete.",
              inline: false,
            },
            {
              name: "Privacy",
              value: "This private response only shows achievements for albums you can access.",
              inline: false,
            },
          ],
          footer: { text: "Open the website album for full progress, criteria and earned dates" },
        },
      ],
      components: components([
        [
          {
            type: 2,
            style: 5,
            label: "Open achievements",
            url: absoluteUrl(ctx.config.publicOrigin, "/play/achievements")!,
          },
        ],
      ]),
    },
    true,
  );
}

async function packs(ctx: Ctx, installation: DiscordInstallation): Promise<DiscordCallback> {
  const pools = await listPools(ctx);
  if (pools.length === 0) {
    return callback(
      {
        embeds: [
          {
            title: "No packs available",
            description: "This Bot has no active capsule pools yet.",
            color: 0x8a8f98,
          },
        ],
      },
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
      lines.push(
        `**${pool.name}** · \`${pool.slug}\`\n${pool.description}\nCurrently unavailable.`,
      );
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
            {
              name: "Server",
              value: installation.guild_name ?? installation.guild_id,
              inline: true,
            },
            { name: "Inventory scope", value: "This Bot across every server", inline: true },
            { name: "Privacy", value: "This response is only visible to you.", inline: false },
          ],
        },
      ],
      components: components([
        [button("Daily", "foilbury:daily", 2), button("Collection", "foilbury:collection", 2)],
      ]),
    },
    true,
  );
}

async function npcView(ctx: Ctx, query: string): Promise<DiscordCallback> {
  const profiles = await listNpcProfiles(ctx);
  if (profiles.length === 0) {
    return callback(
      {
        embeds: [
          {
            title: "No NPC collectors are active",
            description: "This Bot has no labelled synthetic collectors yet. A Bot Owner can create one in Studio → NPC collectors. Nothing is simulated in the meantime.",
            color: 0x7c6b4f,
            footer: { text: "Foilbury · NPC lounge" },
          },
        ],
        components: components([[{ type: 2, style: 5, label: "Open Studio", url: absoluteUrl(ctx.config.publicOrigin, "/studio/npcs")! }]]),
      },
      true,
    );
  }
  const needle = query.trim().toLowerCase();
  const selected = needle
    ? profiles.find((npc) => npc.id.toLowerCase() === needle || npc.slug.toLowerCase() === needle || npc.name.toLowerCase().includes(needle))
    : null;
  if (!selected) {
    return callback(
      {
        embeds: [
          {
            title: "NPC collectors · synthetic cast",
            description: "Clearly labelled fictional game actors with real persisted cards. They are not Discord members or human engagement.",
            color: 0x7c6b4f,
            fields: profiles.slice(0, 8).map((npc) => ({
              name: `${npc.name} · ${npc.preset_label}`,
              value: `${npc.status} · ${npc.subjects} subjects · ${npc.gold} Gold · ${npc.holographic} Holographic\n\`/foilbury npc name:${npc.slug}\``,
              inline: false,
            })),
            footer: { text: "NPC · synthetic collector · not a human member" },
          },
        ],
        components: components([[{ type: 2, style: 5, label: "Open the NPC lounge", url: absoluteUrl(ctx.config.publicOrigin, "/play/rivals")! }]]),
      },
      true,
    );
  }
  const comparison = await compareNpc(ctx, selected.id);
  return callback(
    {
      embeds: [
        {
          title: `${selected.name} · NPC`,
          description: selected.bio,
          color: 0x00c8b8,
          thumbnail: selected.avatar_url ? { url: absoluteUrl(ctx.config.publicOrigin, selected.avatar_url) ?? selected.avatar_url } : undefined,
          fields: [
            { name: "Preset", value: selected.preset_label, inline: true },
            { name: "Status", value: selected.status, inline: true },
            { name: "Recorded actions", value: String(selected.actions_count), inline: true },
            { name: "NPC album", value: `${selected.subjects} subjects · ${selected.cards} copies\n${selected.gold} Gold · ${selected.holographic} Holographic`, inline: true },
            { name: "Your album", value: `${comparison.viewer.subjects} subjects · ${comparison.viewer.cards} copies\n${comparison.viewer.gold} Gold · ${comparison.viewer.holographic} Holographic`, inline: true },
            { name: "Honesty", value: "NPC · synthetic collector. Real draws, serials and ledger entries; never a human member or fabricated testimonial.", inline: false },
          ],
          footer: { text: "Foilbury · on-demand NPC inspection" },
        },
      ],
      components: components([[{ type: 2, style: 5, label: "Compare in the lounge", url: absoluteUrl(ctx.config.publicOrigin, "/play/rivals")! }]]),
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
            {
              name: "Need a website account?",
              value:
                "Only Bot Owners and Admins need one. Players collect immediately with Discord.",
              inline: false,
            },
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
            {
              name: "Guild",
              value: `${installation.guild_name ?? "Unknown"} (\`${installation.guild_id}\`)`,
              inline: false,
            },
            {
              name: "Channel allowlist",
              value: installation.channel_allowlist_json,
              inline: false,
            },
            {
              name: "Game / website / API",
              value: `${installation.game_enabled} / ${installation.website_enabled} / ${installation.api_enabled}`,
              inline: false,
            },
            {
              name: "Catalogue / admin GUI",
              value: `${installation.public_catalogue_enabled} / ${installation.admin_gui_enabled}`,
              inline: false,
            },
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

async function adminSettings(
  ctx: Ctx,
  installation: DiscordInstallation,
): Promise<DiscordCallback> {
  requireBotAdmin(ctx.user!);
  const economy = await getEconomy(ctx);
  return callback(
    {
      embeds: [
        {
          title: "Bot settings",
          description:
            "Availability switches are independent. Disabling one does not delete inventory or disable another interface.",
          color: 0x7c6b4f,
          fields: [
            {
              name: "Currency",
              value: `${economy.currency_name} (${economy.currency_symbol})`,
              inline: true,
            },
            { name: "Starter grant", value: String(economy.starter_grant), inline: true },
            { name: "Daily allowance", value: String(economy.daily_reward), inline: true },
            {
              name: "Cooldown",
              value: `${Math.round(economy.daily_cooldown_seconds / 3600)} hours`,
              inline: true,
            },
            {
              name: "Game",
              value: installation.game_enabled ? "enabled" : "disabled",
              inline: true,
            },
            {
              name: "Website",
              value: installation.website_enabled ? "enabled" : "disabled",
              inline: true,
            },
            {
              name: "External API",
              value: installation.api_enabled ? "enabled" : "disabled",
              inline: true,
            },
            {
              name: "Public catalogue",
              value: installation.public_catalogue_enabled ? "enabled" : "disabled",
              inline: true,
            },
            {
              name: "Admin GUI",
              value: installation.admin_gui_enabled ? "enabled" : "disabled",
              inline: true,
            },
            {
              name: "Sensitive changes",
              value:
                "Use /foilbury admin enable|disable and confirm with the button. Grants require confirmation.",
              inline: false,
            },
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
      const preview = await getPoolPreview(ctx, pool.slug, installation.channel_key ?? undefined, {
        includeDraft: true,
      });
      eligible = String(preview.eligible_count);
    } catch {
      eligible = "0";
    }
    lines.push(
      `• **${pool.name}** \`${pool.slug}\` · ${pool.status} · rev ${pool.revision} · ${pool.price} ✦ · ${eligible} eligible`,
    );
  }
  return callback(
    {
      embeds: [
        {
          title: "Pools",
          description: lines.length ? lines.join("\n") : "No pools configured.",
          color: 0x7c6b4f,
          footer: {
            text: "Pool membership and card availability are enforced by the domain service.",
          },
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
    .bind(
      id,
      ctx.tenant.id,
      interaction.member?.user?.id ?? interaction.user?.id ?? "",
      action,
      JSON.stringify(payload),
      expiresAt,
      nowIso(),
    )
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
      components: components([
        [
          button("Confirm", `foilbury:confirm:${id}`, 3),
          button("Cancel", `foilbury:cancel:${id}`, 4),
        ],
      ]),
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
    throw new ApiError(
      403,
      "insufficient_role",
      "Only this Bot's Owner or Economy Admin can grant Foil.",
    );
  }
  const rawUser = typeof values.user === "string" ? values.user.trim() : "";
  const discordUserId =
    rawUser.match(/^<@!?(\d{15,22})>$/)?.[1] ?? rawUser.match(/^\d{15,22}$/)?.[0];
  if (!discordUserId)
    throw new ApiError(422, "discord_user_invalid", "Use a Discord user ID or mention.");
  const amount = typeof values.amount === "number" ? values.amount : Number(values.amount);
  if (!Number.isInteger(amount) || amount <= 0)
    throw new ApiError(422, "amount_invalid", "Amount must be a positive integer.");
  const reason = typeof values.reason === "string" ? values.reason.trim() : "";
  if (reason.length < 3)
    throw new ApiError(422, "reason_required", "Record a short reason for the grant.");
  const target = await first<{ user_id: string }>(
    ctx.db,
    "SELECT user_id FROM fb_discord_identities WHERE tenant_id = ? AND discord_user_id = ? AND revoked_at IS NULL",
    ctx.tenant.id,
    discordUserId,
  );
  if (!target)
    throw new ApiError(
      404,
      "player_not_linked",
      "That Discord user has not played this Bot yet, so there is no inventory to credit.",
    );
  return createConfirmation(
    ctx,
    interaction,
    "wallet.grant",
    { targetUserId: target.user_id, amount, reason },
    "Confirm admin grant",
    `Grant **${amount} Foil** to <@${discordUserId}> with reason: ${truncate(reason, 200)}. This is an audited admin grant, not a random drop.`,
  );
}

const TOUR_STAGES = [
  "welcome",
  "albums",
  "fresh",
  "open",
  "inspect",
  "progress",
  "share",
  "admin",
] as const;
type TourStage = (typeof TOUR_STAGES)[number];

function isTourStage(value: string): value is TourStage {
  return (TOUR_STAGES as readonly string[]).includes(value);
}

function tourNav(
  stage: TourStage,
  extra: DiscordComponent[][] = [],
): Array<{ type: number; components: DiscordComponent[] }> {
  const index = TOUR_STAGES.indexOf(stage);
  const row: DiscordComponent[] = [];
  if (index > 0) row.push(button("Back", `foilbury:tour:${TOUR_STAGES[index - 1]}`, 2));
  if (index < TOUR_STAGES.length - 1)
    row.push(button("Next", `foilbury:tour:${TOUR_STAGES[index + 1]}`, 1));
  row.push(button("Tour home", "foilbury:tour:welcome", 2));
  return components([...extra, row]);
}

async function tourAlbum(ctx: Ctx) {
  const collections = (await listCollections(ctx)).filter(
    (collection) => collection.enabled && collection.status === "published",
  );
  const preferred =
    collections.find(
      (collection) => collection.slug === "danganronpa-three-games" && collection.card_count === 8,
    ) ??
    collections.find((collection) => collection.card_count === 8) ??
    collections[0] ??
    null;
  if (!preferred) return null;
  const detail = await getCollection(ctx, preferred.id);
  const [cards, progress] = await Promise.all([
    listCollectionCards(ctx, detail.id),
    collectionProgress(ctx, detail.id),
  ]);
  return { detail, cards, progress };
}

async function tour(
  ctx: Ctx,
  installation: DiscordInstallation,
  stage: TourStage,
  channelId?: string,
): Promise<DiscordCallback> {
  const wallet = await getWalletSummary(ctx.db, ctx.tenant.id, ctx.user!.id, 1);
  const economy = await getEconomy(ctx);
  const album = await tourAlbum(ctx);

  if (stage === "welcome") {
    const showcase = await listPublicCollections(ctx);
    const memberCount = (await listCollections(ctx)).filter(
      (collection) => collection.enabled,
    ).length;
    return callback(
      {
        embeds: [
          {
            title: "Foilbury · guided tour",
            description: [
              "Foilbury is a collectible-card cabinet. Claim a free allowance, open a capsule, and keep the copy in this Bot's cabinet.",
              "",
              "**What you can see here:** this private response, your own inventory and the albums your account can enter. Nothing in the tour spends Foil, draws a card or grants a reward until you choose an action.",
            ].join("\n"),
            color: 0xc9a227,
            fields: [
              {
                name: "Public showcase",
                value: showcase.length
                  ? showcase
                      .slice(0, 4)
                      .map((item) => `• ${item.name}`)
                      .join("\n")
                  : "No public showcase is published yet.",
                inline: false,
              },
              {
                name: "Member albums",
                value: `${memberCount} available to this Bot`,
                inline: true,
              },
              {
                name: "Free play",
                value: `${economy.starter_grant} welcome · ${economy.daily_reward} daily`,
                inline: true,
              },
              {
                name: "Your balance",
                value: `${wallet.balance} ${wallet.currencySymbol}`,
                inline: true,
              },
            ],
            footer: { text: "Private tour · authorised members only · use Next to continue" },
          },
        ],
        components: tourNav("welcome", [
          [
            button("Start with an album", "foilbury:tour:albums", 1),
            button("How free play works", "foilbury:tour:fresh", 2),
          ],
          [button("Claim daily", "foilbury:daily", 2), button("Packs", "foilbury:packs", 2)],
        ]),
      },
      true,
    );
  }

  if (!album) {
    return callback(
      {
        embeds: [
          {
            title: "No member album is available",
            description:
              "This Bot has no enabled album your account can enter right now. Ask the Bot Owner to enable a collection. Nothing was charged or awarded.",
            color: 0x8a8f98,
          },
        ],
        components: tourNav(stage),
      },
      true,
    );
  }

  if (stage === "albums") {
    const achievement = (await listAchievements(ctx, ctx.user!.id)).find(
      (item) => item.criteria.collection_id === album.detail.id,
    );
    return callback(
      {
        embeds: [
          {
            title: album.detail.name,
            description: truncate(album.detail.description, 700),
            color: 0x7c6b4f,
            fields: [
              { name: "Audience", value: album.detail.audience_label, inline: true },
              { name: "Cards", value: `${album.cards.length} in the release roster`, inline: true },
              {
                name: "Published variants",
                value: String(album.progress.total_variants),
                inline: true,
              },
              {
                name: "Release roster",
                value: album.cards.length
                  ? album.cards.map((card) => `• ${card.name}`).join("\n")
                  : "No published cards.",
                inline: false,
              },
              {
                name: "Collection milestone",
                value: achievement
                  ? `${achievement.name} · ${Math.min(achievement.progress, achievement.target)}/${achievement.target} · ${achievement.state === "earned" ? `earned${achievement.reward_amount ? ` · +${achievement.reward_amount} Foil` : ""}` : "in progress"}`
                  : "No collection achievement is published.",
                inline: false,
              },
              {
                name: "Your progress",
                value: `${album.progress.owned_cards}/${album.progress.total_cards} unique cards · ${album.progress.complete ? "complete" : "incomplete"}`,
                inline: true,
              },
              {
                name: "Finish families",
                value: `4 core finishes`,
                inline: true,
              },
            ],
            footer: {
              text: "Prepared release roster and frozen achievement target · no cards were granted",
            },
          },
        ],
        components: tourNav("albums", [
          [
            button("How free play works", "foilbury:tour:fresh", 1),
            button("Inspect an album card", "foilbury:tour:inspect", 2),
          ],
        ]),
      },
      true,
    );
  }

  if (stage === "fresh") {
    const pools = await listPools(ctx);
    const lines: string[] = [];
    for (const pool of pools.slice(0, 4)) {
      try {
        const preview = await getPoolPreview(ctx, pool.slug, installation.channel_key ?? undefined);
        const odds = new Map<string, number>();
        for (const entry of preview.entries) {
          const key = displayFinish(entry.variant_name, entry.material_key, entry.effect_key);
          odds.set(key, (odds.get(key) ?? 0) + entry.probability_bps);
        }
        const oddsText = [...odds.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 4)
          .map(([key, bps]) => `${key} ${(bps / 100).toFixed(2)}%`)
          .join(" · ");
        lines.push(
          `**${pool.name}** · ${preview.price} ${wallet.currencySymbol} · ${preview.eligible_count} eligible\n${oddsText || "No eligible odds"}`,
        );
      } catch (error) {
        lines.push(
          `**${pool.name}** · currently unavailable. ${error instanceof ApiError ? truncate(error.message, 180) : ""}`,
        );
      }
    }
    return callback(
      {
        embeds: [
          {
            title: "Free play, first run",
            description: [
              `Your first verified Discord interaction creates a player and credits the **${economy.starter_grant} Foil** welcome grant once.`,
              `The daily allowance is **${economy.daily_reward} Foil** every ${Math.round(economy.daily_cooldown_seconds / 3600)} hours; the allowance is shared by this Bot across Discord, the website and the API.`,
              `**Your balance:** ${wallet.balance} ${wallet.currencySymbol}. Pools and the exact current odds are shown below before you open anything.`,
            ].join("\n"),
            color: 0x245c4b,
            fields: lines.length
              ? lines.map((line, index) => ({
                  name: `Pool ${index + 1}`,
                  value: line,
                  inline: false,
                }))
              : [
                  {
                    name: "Pools",
                    value: "No active pool is currently eligible. Nothing can be charged.",
                    inline: false,
                  },
                ],
            footer: {
              text: "Opening is a deliberate action and spends the displayed price. This stage never draws.",
            },
          },
        ],
        components: tourNav("fresh", [
          [
            button("Claim daily", "foilbury:daily", 2),
            button("Open a capsule", "foilbury:tour:open", 1),
          ],
        ]),
      },
      true,
    );
  }

  if (stage === "open") {
    let poolLine = "No eligible pool right now. Nothing can be charged.";
    let poolButton: DiscordComponent[] = [];
    const pools = await listPools(ctx);
    const pool = pools[0];
    if (pool) {
      try {
        const preview = await getPoolPreview(ctx, pool.slug, installation.channel_key ?? undefined);
        if (preview.eligible_count > 0 && wallet.balance >= preview.price) {
          poolLine = `**${pool.name}** · ${preview.price} ${wallet.currencySymbol} · ${preview.eligible_count} eligible variant${preview.eligible_count === 1 ? "" : "s"}. Your balance is ${wallet.balance} ${wallet.currencySymbol}.`;
          poolButton = [button(`Open ${pool.name}`, `foilbury:open:${pool.slug}`, 1)];
        } else if (preview.eligible_count === 0) {
          poolLine = `${pool.name} is currently empty. ${preview.filters.empty_reason ?? "Nothing was charged."}`;
        } else {
          poolLine = `${pool.name} costs ${preview.price} ${wallet.currencySymbol}; your balance is ${wallet.balance} ${wallet.currencySymbol}. Claim the daily allowance first.`;
        }
      } catch (error) {
        poolLine =
          error instanceof ApiError
            ? error.message
            : "The pool could not be read. Nothing was charged.";
      }
    }
    return callback(
      {
        embeds: [
          {
            title: "A real opening",
            description: [
              "The next stage opens a real capsule when you choose it. The award, serial, finish, price and balance are committed together in one D1 transaction.",
              "",
              poolLine,
              "",
              "After the reveal, use **View front**, **View back**, **Details** and **Collection**. Those controls never spend or award another copy.",
              "3D inspection is a website feature, not a native Discord 3D view; the tour labels that link clearly.",
            ].join("\n"),
            color: 0xd97757,
            fields: [
              {
                name: "Balance",
                value: `${wallet.balance} ${wallet.currencySymbol}`,
                inline: true,
              },
              {
                name: "Spend",
                value: pool ? `${pool.price} ${wallet.currencySymbol}` : "—",
                inline: true,
              },
              { name: "Passive navigation", value: "Free", inline: true },
            ],
            footer: { text: "No automatic draw. Choose the open button only when you are ready." },
          },
        ],
        components: tourNav("open", poolButton.length ? [poolButton] : []),
      },
      true,
    );
  }

  if (stage === "inspect") {
    const finishRows = await ctx.db
      .prepare(
        `SELECT cd.id AS card_id, cd.name AS card_name, v.id AS variant_id, v.name AS variant_name,
                m.key AS material_key, fx.key AS effect_key
           FROM fb_collection_cards cc
           JOIN fb_card_definitions cd ON cd.id = cc.card_id AND cd.status = 'published' AND cd.archived_at IS NULL
           JOIN fb_variants v ON v.card_id = cd.id AND v.status = 'published' AND v.archived_at IS NULL
           JOIN fb_materials m ON m.id = v.material_id
           LEFT JOIN fb_effects fx ON fx.id = v.effect_id
           JOIN fb_variant_renders vr ON vr.variant_id = v.id AND vr.status = 'published'
          WHERE cc.collection_id = ? AND cc.tenant_id = ?
          ORDER BY cc.sort, v.name`,
      )
      .bind(album.detail.id, ctx.tenant.id)
      .all<{
        card_id: string;
        card_name: string;
        variant_id: string;
        variant_name: string;
        material_key: string;
        effect_key: string | null;
      }>();
    const example = new Map<string, (typeof finishRows.results)[number]>();
    for (const row of finishRows.results) {
      const key = finishKey(row.material_key, row.effect_key);
      if (!example.has(key)) example.set(key, row);
    }
    const finishButtons: DiscordComponent[][] = [];
    for (const key of ["plain", "silver", "gold", "holographic"] as const) {
      const item = example.get(key);
      if (item)
        finishButtons.push([
          button(
            key === "holographic" ? "Holographic" : key[0]!.toUpperCase() + key.slice(1),
            `foilbury:card:${item.card_id}:${item.variant_id}:front`,
            2,
          ),
        ]);
    }
    const owned = await first<{ instance_id: string; card_id: string; variant_id: string }>(
      ctx.db,
      `SELECT ci.id AS instance_id, ci.card_id, ci.variant_id
         FROM fb_card_instances ci
         JOIN fb_collection_cards cc ON cc.card_id = ci.card_id AND cc.collection_id = ?
        WHERE ci.tenant_id = ? AND ci.user_id = ? AND ci.status IN ('owned','reserved')
        ORDER BY ci.acquired_at DESC LIMIT 1`,
      album.detail.id,
      ctx.tenant.id,
      ctx.user!.id,
    );
    const fields = Object.entries(Object.fromEntries(example)).map(([key, item]) => ({
      name: key[0]!.toUpperCase() + key.slice(1),
      value: `${item.card_name} · ${item.variant_name}`,
      inline: true,
    }));
    return callback(
      {
        embeds: [
          {
            title: `Inspect · ${album.detail.name}`,
            description: [
              "These buttons open real published front renders for the four core finishes in this album. Viewing a side or details is private and free.",
              owned
                ? "A card from this album is in your cabinet. Use the inspection controls below."
                : "You do not own a card from this album yet. The finish examples are still real catalogue renders; open the album to add your first copy.",
              "",
              "**3D:** open the signed-in web album. Discord does not present native 3D cards.",
            ].join("\n"),
            color: 0x3b82f6,
            fields: fields.length
              ? fields
              : [
                  {
                    name: "Renders",
                    value: "No published finish renders are available.",
                    inline: false,
                  },
                ],
            footer: {
              text: "Private member view · viewing does not spend Foil or award another copy",
            },
          },
        ],
        components: tourNav("inspect", [
          ...finishButtons,
          ...(owned
            ? [
                [
                  button(
                    "View front",
                    `foilbury:card:${owned.card_id}:${owned.variant_id}:front`,
                    2,
                  ),
                  button("View back", `foilbury:card:${owned.card_id}:${owned.variant_id}:back`, 2),
                  button("Details", `foilbury:card:${owned.card_id}:details`, 2),
                  {
                    type: 2,
                    style: 5,
                    label: "Open in web album (3D)",
                    url: absoluteUrl(ctx.config.publicOrigin, `/play/card/${owned.instance_id}`)!,
                  },
                ],
              ]
            : []),
        ]),
      },
      true,
    );
  }

  if (stage === "progress") {
    const inventory = await getInventory(ctx, { collection: album.detail.slug, limit: 500 });
    const unique = new Set(inventory.map((item) => item.card_id));
    const variants = new Set(inventory.map((item) => item.variant_id));
    const duplicates = inventory.length - unique.size;
    const achievements = await listAchievements(ctx, ctx.user!.id);
    const collectionAchievements = achievements.filter(
      (item) => item.criteria.collection_id === album.detail.id,
    );
    const earned = collectionAchievements.filter((item) => item.state === "earned");
    const next = collectionAchievements
      .filter((item) => item.state !== "earned")
      .sort((a, b) => b.progress / Math.max(1, b.target) - a.progress / Math.max(1, a.target))[0];
    const completion = collectionAchievements
      .filter((item) => item.target === album.progress.total_cards && item.state === "earned")
      .sort((a, b) => b.reward_amount - a.reward_amount)[0];
    const celebration = album.progress.complete
      ? completion
        ? `Completion unlocked: **${completion.name}**${completion.reward_amount ? ` · +${completion.reward_amount} Foil credited once` : ""}${completion.earned_at ? ` · ${new Date(completion.earned_at).toISOString().slice(0, 10)}` : ""}`
        : "The album is complete. The milestone will be evaluated by the next committed acquisition; the tour does not award it passively."
      : `Next target: ${next ? `${next.name} · ${Math.min(next.progress, next.target)}/${next.target}` : "keep collecting"}`;
    return callback(
      {
        embeds: [
          {
            title: `Progress · ${album.detail.name}`,
            description: celebration,
            color: album.progress.complete ? 0x3f9d5a : 0x7c6b4f,
            fields: [
              {
                name: "Unique subjects",
                value: `${unique.size}/${album.progress.total_cards}`,
                inline: true,
              },
              { name: "Owned copies", value: String(inventory.length), inline: true },
              { name: "Duplicates", value: String(duplicates), inline: true },
              {
                name: "Variant progress",
                value: `${variants.size}/${album.progress.total_variants}`,
                inline: true,
              },
              {
                name: "Earned badges",
                value: `${earned.length}/${collectionAchievements.length}`,
                inline: true,
              },
              {
                name: "Completion",
                value: album.progress.complete ? "8/8 complete" : "Incomplete",
                inline: true,
              },
              ...(next
                ? [
                    {
                      name: "Next milestone",
                      value: `${next.name} · ${Math.min(next.progress, next.target)}/${next.target}${next.reward_amount ? ` · +${next.reward_amount} Foil` : ""}`,
                      inline: false,
                    },
                  ]
                : []),
              {
                name: "What becomes public",
                value:
                  "Nothing until you explicitly share. This response is private, and a shared post never contains your balance, email or admin controls.",
                inline: false,
              },
            ],
            footer: { text: "Progress uses committed receipts, not local counters" },
          },
        ],
        components: tourNav("progress", [
          [
            button("Achievements", "foilbury:achievements", 2),
            button("Share progress", "foilbury:tour:share", 2),
            ...(album.progress.complete
              ? [button("Share completion", `foilbury:tourshare:completion:${album.detail.id}`, 1)]
              : []),
          ],
        ]),
      },
      true,
    );
  }

  if (stage === "share") {
    const inventory = await getInventory(ctx, { limit: 500 });
    const channelAudience = channelAudienceFor(installation, channelId);
    let publicCard: (typeof inventory)[number] | null = null;
    for (const item of inventory.slice(0, 20)) {
      if ((await effectiveCardAudience(ctx, item.card_id)) === "public") {
        publicCard = item;
        break;
      }
    }
    const albumCard =
      inventory.find((item) => album.cards.some((card) => card.id === item.card_id)) ?? null;
    const albumCardAudience = albumCard ? await effectiveCardAudience(ctx, albumCard.card_id) : "private";
    const canShareAlbumCard =
      albumCard !== null &&
      albumCardAudience !== "private" &&
      audienceRank(channelAudience) >= audienceRank(albumCardAudience);
    const canShareCompletion =
      album.detail.view_audience !== "private" &&
      audienceRank(channelAudience) >= audienceRank(album.detail.view_audience);
    const available = [
      publicCard
        ? `• Public showcase card: ${publicCard.card_name} — ${publicCard.variant_name}`
        : "",
      canShareAlbumCard && albumCard
        ? `• Member album card: ${albumCard.card_name} — ${albumCard.variant_name}`
        : "",
      "• Your profile summary (no wallet or private account data)",
      album.progress.complete && canShareCompletion ? "• This complete album" : "",
    ].filter(Boolean);
    return callback(
      {
        embeds: [
          {
            title: "Share deliberately",
            description: [
              "Sharing is a separate, explicit action. A shared post is visible to everyone with access to this channel and its attachments can be copied after delivery.",
              "Foilbury checks the card or achievement audience and the channel policy before posting. Consent does not override a restricted collection.",
              "The tour never shares automatically, and no shared post includes your balance, email, sessions or administrator controls.",
            ].join("\n"),
            color: 0x7c6b4f,
            fields: [
              {
                name: "Destination",
                value: channelId ? `<#${channelId}>` : "This channel",
                inline: false,
              },
              {
                name: "Available here",
                value: available.length
                  ? available.join("\n")
                  : "Only your profile summary is available in this channel.",
                inline: false,
              },
              ...(albumCard && !canShareAlbumCard
                ? [
                    {
                      name: "Restricted artwork",
                      value:
                        "This channel has not been verified for the member album's audience, so its card art stays private to you.",
                      inline: false,
                    },
                  ]
                : []),
            ],
            footer: { text: "An already-posted Discord attachment cannot be made private later" },
          },
        ],
        components: tourNav("share", [
          [
            ...(publicCard
              ? [button("Share public card", `foilbury:tourshare:card:${publicCard.id}`, 1)]
              : []),
            ...(canShareAlbumCard && albumCard
              ? [button("Share album card", `foilbury:tourshare:card:${albumCard.id}`, 1)]
              : []),
            button("Share profile", `foilbury:tourshare:profile:${ctx.user!.id}`, 2),
            ...(album.progress.complete && canShareCompletion
              ? [button("Share completion", `foilbury:tourshare:completion:${album.detail.id}`, 1)]
              : []),
          ],
        ]),
      },
      true,
    );
  }

  if (stage === "admin") {
    if (!isBotAdmin(ctx.user!)) {
      return callback(
        {
          embeds: [
            {
              title: "Administration is private",
              description:
                "This appendix is only available to this Bot's Owner or Admin. Server moderator status does not grant Foilbury administration.",
              color: 0x8a8f98,
            },
          ],
          components: tourNav("admin"),
        },
        true,
      );
    }
    const counts = await first<{ cards: number; pools: number; members: number }>(
      ctx.db,
      `SELECT
         (SELECT COUNT(*) FROM fb_card_definitions WHERE tenant_id = ? AND status = 'published' AND archived_at IS NULL) AS cards,
         (SELECT COUNT(*) FROM fb_pools WHERE tenant_id = ? AND status = 'active') AS pools,
         (SELECT COUNT(*) FROM fb_memberships WHERE tenant_id = ? AND status = 'active') AS members`,
      ctx.tenant.id,
      ctx.tenant.id,
      ctx.tenant.id,
    );
    return callback(
      {
        embeds: [
          {
            title: "Administration appendix · private",
            description: [
              "**Bot administration** is scoped to this Bot. Use `/foilbury admin status|settings|pools|enable|disable|grant` or the web console.",
              "**Platform administration** and the native EmDash console are separate Cloudflare Access areas. Neither is granted by Discord guild ownership or a Bot role.",
            ].join("\n"),
            color: 0x245c4b,
            fields: [
              { name: "Bot", value: ctx.tenant.name, inline: true },
              { name: "Published cards", value: String(counts?.cards ?? 0), inline: true },
              { name: "Active pools", value: String(counts?.pools ?? 0), inline: true },
              { name: "Active members", value: String(counts?.members ?? 0), inline: true },
              {
                name: "Channel policy",
                value:
                  "Reveals are channel-visible only when the installation has verified the channel audience. Otherwise restricted art stays ephemeral.",
                inline: false,
              },
            ],
            footer: { text: "This response is private to the administrator" },
          },
        ],
        components: tourNav("admin", [
          [
            {
              type: 2,
              style: 5,
              label: "Open Bot Admin",
              url: absoluteUrl(ctx.config.publicOrigin, "/admin")!,
            },
            ...(ctx.user!.platformAdmin
              ? [
                  {
                    type: 2,
                    style: 5,
                    label: "Open Platform Admin",
                    url: absoluteUrl(ctx.config.publicOrigin, "/platform-admin")!,
                  },
                  {
                    type: 2,
                    style: 5,
                    label: "Open EmDash",
                    url: absoluteUrl(ctx.config.publicOrigin, "/_emdash/admin")!,
                  },
                ]
              : []),
          ],
        ]),
      },
      true,
    );
  }

  throw new ApiError(404, "tour_stage_unknown", "That tour stage is not recognised.");
}

async function tourShare(
  ctx: Ctx,
  interaction: DiscordInteraction,
  installation: DiscordInstallation,
  kind: string,
  objectId: string,
): Promise<DiscordCallback> {
  if (!["card", "completion", "profile"].includes(kind)) {
    throw new ApiError(422, "share_kind_invalid", "That share type is not available.");
  }
  if (!interaction.channel_id)
    throw new ApiError(
      403,
      "share_channel_required",
      "Sharing needs an authorised server channel.",
    );
  const channelAudience = channelAudienceFor(installation, interaction.channel_id);
  let embed: DiscordEmbed;
  let audience: "public" | "members" | "private" = "public";
  let render: { r2_key: string; mime: string; width: number; height: number } | null = null;

  if (kind === "card") {
    const row = await first<{
      id: string;
      card_id: string;
      variant_id: string;
      card_name: string;
      variant_name: string;
      material_key: string;
      effect_key: string | null;
      serial: string;
      collection_name: string | null;
      r2_key: string;
      mime: string;
      width: number;
      height: number;
    }>(
      ctx.db,
      `SELECT ci.id, ci.card_id, ci.variant_id, cd.name AS card_name, v.name AS variant_name,
              m.key AS material_key, fx.key AS effect_key, ci.serial,
              (SELECT c.name FROM fb_collection_cards cc JOIN fb_collections c ON c.id = cc.collection_id WHERE cc.card_id = cd.id ORDER BY CASE c.scope WHEN 'global' THEN 0 ELSE 1 END LIMIT 1) AS collection_name,
              a.r2_key, a.mime, vr.width, vr.height
         FROM fb_card_instances ci
         JOIN fb_card_definitions cd ON cd.id = ci.card_id
         JOIN fb_variants v ON v.id = ci.variant_id
         JOIN fb_materials m ON m.id = v.material_id
         LEFT JOIN fb_effects fx ON fx.id = v.effect_id
         JOIN fb_variant_renders vr ON vr.variant_id = v.id AND vr.status = 'published'
         JOIN fb_assets a ON a.id = vr.asset_id AND a.tenant_id = vr.tenant_id
        WHERE ci.tenant_id = ? AND ci.user_id = ? AND ci.id = ? AND ci.status IN ('owned','reserved')
        LIMIT 1`,
      ctx.tenant.id,
      ctx.user!.id,
      objectId,
    );
    if (!row)
      throw new ApiError(404, "share_card_missing", "That owned card is not in your cabinet.");
    if (!(await canViewCard(ctx, row.card_id)))
      throw new ApiError(404, "share_card_missing", "That card is not available to this album.");
    audience = await effectiveCardAudience(ctx, row.card_id);
    if (audience === "private") {
      throw new ApiError(403, "share_private_not_available", "Private collection artwork cannot be shared to a channel.");
    }
    if (audienceRank(channelAudience) < audienceRank(audience)) {
      throw new ApiError(
        403,
        "share_channel_audience",
        "This channel has not been verified for that card's audience. It stays private.",
      );
    }
    embed = {
      title: `${row.card_name} — ${row.variant_name}`,
      description: `Shared by **${ctx.user!.displayName}** with explicit consent. The copy remains owned by the collector; sharing does not grant it to anyone else.`,
      color: 0xc9a227,
      fields: [
        { name: "Collection", value: row.collection_name ?? "Foilbury", inline: true },
        {
          name: "Finish",
          value: displayFinish(row.variant_name, row.material_key, row.effect_key),
          inline: true,
        },
        { name: "Serial", value: `\`${row.serial}\``, inline: true },
      ],
      footer: {
        text: "Shared attachment · viewers cannot operate this copy · no wallet or account data",
      },
      image: { url: "attachment://foilbury-share.webp", width: row.width, height: row.height },
    };
    render = row;
    objectId = row.card_id;
  } else if (kind === "completion") {
    const album = await getCollection(ctx, objectId);
    const progress = await collectionProgress(ctx, album.id);
    if (!progress.complete)
      throw new ApiError(
        409,
        "completion_incomplete",
        "That album is not complete yet. Nothing was shared.",
      );
    audience = album.view_audience;
    if (audience === "private") {
      throw new ApiError(403, "share_private_not_available", "Private collection artwork cannot be shared to a channel.");
    }
    if (audienceRank(channelAudience) < audienceRank(audience)) {
      throw new ApiError(
        403,
        "share_channel_audience",
        "This channel has not been verified for that album's audience. It stays private.",
      );
    }
    embed = {
      title: `${album.name} · complete`,
      description: `**${ctx.user!.displayName}** completed this member album: ${progress.owned_cards}/${progress.total_cards} unique subjects.`,
      color: 0x3f9d5a,
      fields: [
        { name: "Album", value: album.name, inline: true },
        {
          name: "Progress",
          value: `${progress.owned_cards}/${progress.total_cards}`,
          inline: true,
        },
        { name: "Audience", value: album.audience_label, inline: true },
      ],
      footer: { text: "Explicit completion share · no balance, email or admin controls" },
    };
  } else {
    const inventory = await getInventory(ctx, { limit: 200 });
    const achievements = await listAchievements(ctx, ctx.user!.id);
    const publicCards: string[] = [];
    for (const item of inventory.slice(0, 20)) {
      if ((await effectiveCardAudience(ctx, item.card_id)) === "public") publicCards.push(item.card_id);
    }
    const publicBadges = achievements.filter(
      (item) => item.state === "earned" && item.visibility === "public",
    );
    objectId = ctx.user!.id;
    embed = {
      title: `${ctx.user!.displayName} · collector profile`,
      description: "A member chose to share this public profile summary in an authorised channel.",
      color: 0x7c6b4f,
      fields: [
        {
          name: "Public showcase cards",
          value: String(new Set(publicCards).size),
          inline: true,
        },
        { name: "Public badges", value: String(publicBadges.length), inline: true },
      ],
      footer: {
        text: "Only approved public counts · no wallet, email, member roster, session or administrator data",
      },
    };
  }

  const shareId = newId("shr");
  try {
    await ctx.db
      .prepare(
        `INSERT INTO fb_discord_shares (id, tenant_id, user_id, channel_id, object_type, object_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(shareId, ctx.tenant.id, ctx.user!.id, interaction.channel_id, kind, objectId, nowIso())
      .run();
  } catch (error) {
    if (String(error).includes("UNIQUE")) {
      throw new ApiError(
        409,
        "share_already_delivered",
        "That item was already shared in this channel. Nothing was posted again.",
      );
    }
    throw error;
  }

  const result = callback(
    {
      embeds: [embed],
      components: components([
        [
          {
            type: 2,
            style: 5,
            label: "Open the album",
            url: absoluteUrl(ctx.config.publicOrigin, "/play")!,
          },
        ],
      ]),
    },
    false,
  );
  if (render) {
    result.attachments = [
      {
        r2Key: render.r2_key,
        filename: "foilbury-share.webp",
        contentType: render.mime || "image/webp",
      },
    ];
  }
  return result;
}

export async function runCommand(
  ctx: Ctx,
  interaction: DiscordInteraction,
  installation: DiscordInstallation,
): Promise<DiscordCallback> {
  const { subcommand, values } = parseCommand(interaction.data);
  switch (subcommand) {
    case "open":
      return openCard(
        ctx,
        interaction,
        installation,
        poolName(values),
        `discord:${interaction.id}:open`,
      );
    case "daily":
      return daily(ctx, interaction);
    case "collection":
      return collection(ctx);
    case "card": {
      const query = typeof values.query === "string" ? values.query.trim() : "";
      if (!query)
        throw new ApiError(422, "card_query_required", "Provide a card name, slug or ID.");
      return card(ctx, query);
    }
    case "packs":
      return packs(ctx, installation);
    case "achievements":
      return achievements(ctx);
    case "tour":
      return tour(ctx, installation, "welcome", interaction.channel_id);
    case "profile":
      return profile(ctx, installation);
    case "npc":
      return npcView(ctx, typeof values.name === "string" ? values.name : "");
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
      throw new ApiError(
        404,
        "discord_command_unknown",
        "That Foilbury command is not implemented.",
      );
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
  if (row.discord_user_id !== discordUserId)
    throw new ApiError(403, "confirmation_not_yours", "This confirmation belongs to another user.");
  if (row.used_at)
    throw new ApiError(409, "confirmation_used", "That confirmation has already been used.");
  if (new Date(row.expires_at).getTime() <= Date.now())
    throw new ApiError(
      409,
      "confirmation_expired",
      "That confirmation expired. Run the admin command again.",
    );
  requireBotAdmin(ctx.user!);
  const payload = JSON.parse(row.payload_json) as Record<string, unknown>;

  if (row.action === "installation.toggle") {
    const surface = typeof payload.surface === "string" ? payload.surface : "";
    const enabled = Boolean(payload.enabled);
    const installationId = typeof payload.installationId === "string" ? payload.installationId : "";
    const column = SURFACE_COLUMNS[surface];
    if (!column || !installationId)
      throw new ApiError(422, "surface_invalid", "Unknown availability surface.");
    await ctx.db.batch([
      ctx.db
        .prepare(
          `UPDATE fb_discord_installations SET ${column} = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`,
        )
        .bind(enabled ? 1 : 0, nowIso(), installationId, ctx.tenant.id),
      ctx.db
        .prepare("UPDATE fb_discord_confirmations SET used_at = ? WHERE id = ? AND used_at IS NULL")
        .bind(nowIso(), confirmationId),
      auditStatement(
        ctx,
        enabled ? "discord.surface.enabled" : "discord.surface.disabled",
        "discord_installation",
        installationId,
        {
          surface,
          enabled,
        },
      ),
    ]);
    return callback(
      {
        embeds: [
          {
            title: `${surface} ${enabled ? "enabled" : "disabled"}`,
            description:
              "The change is live. Inventory, ownership history and the other interfaces are unchanged.",
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
    if (!targetUserId || !Number.isInteger(amount) || amount <= 0)
      throw new ApiError(422, "grant_invalid", "The recorded grant is invalid.");
    const digest = await sha256Hex(
      `discord-grant:${confirmationId}:${targetUserId}:${amount}:${reason}`,
    );
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

  throw new ApiError(
    422,
    "confirmation_action_unknown",
    "That confirmation action is not supported.",
  );
}

export async function runComponent(
  ctx: Ctx,
  interaction: DiscordInteraction,
  installation: DiscordInstallation,
): Promise<DiscordCallback> {
  const customId = interaction.data?.custom_id ?? "";
  if (customId.startsWith("foilbury:tour:")) {
    const stage = customId.slice("foilbury:tour:".length);
    if (!isTourStage(stage))
      throw new ApiError(404, "tour_stage_unknown", "That tour stage is not recognised.");
    return tour(ctx, installation, stage, interaction.channel_id);
  }
  if (customId.startsWith("foilbury:tourshare:")) {
    const [kind, objectId] = customId.slice("foilbury:tourshare:".length).split(":");
    if (!kind || !objectId)
      throw new ApiError(422, "share_invalid", "That share control is incomplete.");
    return tourShare(ctx, interaction, installation, kind, objectId);
  }
  if (customId.startsWith("foilbury:open:")) {
    const pool = validatePoolSlug(customId.slice("foilbury:open:".length));
    return openCard(ctx, interaction, installation, pool, `discord:${interaction.id}:open`);
  }
  if (customId === "foilbury:collection") return collection(ctx);
  if (customId === "foilbury:daily") return daily(ctx, interaction);
  if (customId === "foilbury:packs") return packs(ctx, installation);
  if (customId === "foilbury:help") return help(ctx);
  if (customId.startsWith("foilbury:card:")) {
    const [, , cardId, variantId, action] = customId.split(":");
    if (!cardId)
      throw new ApiError(422, "card_component_invalid", "That card control is incomplete.");
    if (action === "front" || action === "back")
      return cardFace(ctx, cardId, variantId ?? null, action);
    if (action === "details") return cardDetails(ctx, cardId);
    throw new ApiError(404, "card_component_unknown", "That card control is not recognised.");
  }
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
    if (!row || row.discord_user_id !== discordUserId)
      throw new ApiError(
        403,
        "confirmation_not_yours",
        "This confirmation belongs to another user.",
      );
    if (!row.used_at) {
      await ctx.db
        .prepare("UPDATE fb_discord_confirmations SET used_at = ? WHERE id = ?")
        .bind(nowIso(), id)
        .run();
    }
    return callback(
      { embeds: [{ title: "Cancelled", description: "No change was made.", color: 0x8a8f98 }] },
      true,
    );
  }
  throw new ApiError(404, "discord_component_unknown", "That button is not recognised.");
}

export { errorCallback };
