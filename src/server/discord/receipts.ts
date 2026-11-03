import { first, nowIso } from "../db";
import type { DiscordEmbed } from "./types";

/**
 * A receipt is written after the domain commit and before presentation work.
 * If a render lookup or Discord delivery then fails, the handler can retrieve
 * the same result instead of claiming nothing changed or starting a new draw.
 */
export interface DiscordDrawReceipt {
  kind: "draw";
  draw_id: string;
  instance_id: string;
  card_id: string;
  variant_id: string;
  card_name: string;
  edition_name: string | null;
  variant_name: string;
  serial: string;
  pool_name: string;
  price: number;
  currency_symbol: string;
  balance_after: number;
  drawn_at: string;
  replayed: boolean;
}

export type DiscordReceipt = DiscordDrawReceipt;

export async function recordInteractionReceipt(
  db: D1Database,
  interactionId: string,
  receipt: DiscordReceipt,
): Promise<void> {
  await db
    .prepare(
      `UPDATE fb_discord_interactions
          SET receipt_kind = ?, receipt_json = ?
        WHERE interaction_id = ?`,
    )
    .bind(receipt.kind, JSON.stringify(receipt), interactionId)
    .run()
    .catch(() => undefined);
}

export async function readInteractionReceipt(
  db: D1Database,
  interactionId: string,
): Promise<DiscordReceipt | null> {
  const row = await first<{ receipt_kind: string | null; receipt_json: string | null }>(
    db,
    "SELECT receipt_kind, receipt_json FROM fb_discord_interactions WHERE interaction_id = ?",
    interactionId,
  ).catch(() => null);
  if (!row?.receipt_json || row.receipt_kind !== "draw") return null;
  try {
    const parsed = JSON.parse(row.receipt_json) as DiscordDrawReceipt;
    if (
      parsed.kind !== "draw" ||
      typeof parsed.card_name !== "string" ||
      typeof parsed.serial !== "string" ||
      typeof parsed.instance_id !== "string" ||
      typeof parsed.variant_id !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function receiptNumber(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString("en-AU") : "0";
}

/**
 * A truthful recovery message for a committed draw whose display failed. It
 * never offers a paid retry: the existing instance and serial are the receipt.
 */
export function drawRecoveryMessage(input: {
  receipt: DiscordDrawReceipt;
  origin: string;
  interactionId: string;
  reason: string;
}): { content?: string; embeds: DiscordEmbed[]; components: unknown[] } {
  const { receipt } = input;
  const print = receipt.edition_name?.trim();
  const title = print ? `${receipt.card_name} — ${print}` : `${receipt.card_name} — ${receipt.variant_name}`;
  const collectionUrl = `${input.origin.replace(/\/$/, "")}/collection`;
  return {
    embeds: [
      {
        title: "Draw completed — display interrupted",
        description: [
          `Your draw **did** complete before the display failed. ${title} is already in your cabinet as serial \`${receipt.serial}\`.`,
          `${receipt.price} ${receipt.currency_symbol} was charged once from **${receipt.pool_name}**. Current balance: **${receiptNumber(receipt.balance_after)} ${receipt.currency_symbol}**.`,
          input.reason,
          "Do not open again to recover this result. Use View cabinet, or Re-send receipt to retry only the display of this same card.",
        ].join("\n\n"),
        color: 0xd97757,
        fields: [
          { name: "Serial", value: `\`${receipt.serial}\``, inline: true },
          { name: "Balance", value: `${receiptNumber(receipt.balance_after)} ${receipt.currency_symbol}`, inline: true },
          { name: "Receipt", value: `\`${receipt.draw_id}\``, inline: false },
        ],
        footer: { text: `Foilbury · committed ${receipt.drawn_at} · reference ${input.interactionId.slice(0, 24)}` },
      },
    ],
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 5,
            label: "View cabinet",
            url: collectionUrl,
          },
          {
            type: 2,
            style: 2,
            label: "Re-send receipt",
            custom_id: `foilbury:redeliver:${input.interactionId}`.slice(0, 100),
          },
        ],
      },
    ],
  };
}

export async function markDeliveryVisibility(
  db: D1Database,
  interactionId: string,
  visibility: "private" | "public" | "private_fallback",
): Promise<void> {
  await db
    .prepare("UPDATE fb_discord_interactions SET delivery_visibility = ? WHERE interaction_id = ?")
    .bind(visibility, interactionId)
    .run()
    .catch(() => undefined);
}

export { nowIso };
