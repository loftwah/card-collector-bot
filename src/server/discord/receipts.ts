import { all, first, nowIso } from "../db";
import type { DrawReceipt } from "./draw-types";
import { DISCORD_PALETTE } from "./presentation";
import { redactDiscordText } from "./redaction";
import type { DiscordEmbed, DiscordMessage } from "./types";

/**
 * A receipt is written after the domain commit and before presentation work.
 * If a render lookup or Discord delivery then fails, the handler can retrieve
 * the same result instead of claiming nothing changed or starting a new draw.
 *
 * The interaction receipt is only a convenience copy. The authoritative
 * transaction record is the deterministic draw row (`fb_draws`) written in the
 * same atomic batch as the debit and the card instance. Recovery therefore
 * works even when the receipt write failed.
 */
export const DRAW_OPERATION = "draw.execute";

export function drawIdempotencyKey(interactionId: string): string {
  return `discord:${interactionId}:open`;
}

export interface DiscordDrawCredit {
  id: string;
  name: string;
  amount: number;
}

export type DrawSettlementStatus = "settled" | "pending";

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
  pool_slug?: string;
  price: number;
  currency_symbol: string;
  balance_after: number;
  balance_after_debit?: number;
  new_subject?: boolean;
  new_finish?: boolean;
  owned_copies?: number;
  probability_bps?: number;
  material_key?: string;
  effect_key?: string | null;
  credits_total?: number;
  achievement_credits?: DiscordDrawCredit[];
  settlement_status?: DrawSettlementStatus;
  settlement_pending?: boolean;
  drawn_at: string;
  replayed: boolean;
}

export type DiscordReceipt = DiscordDrawReceipt;

export function drawReceiptFromResult(result: DrawReceipt): DiscordDrawReceipt {
  return {
    kind: "draw",
    draw_id: result.draw_id,
    instance_id: result.instance_id,
    card_id: result.card_id,
    variant_id: result.variant_id,
    card_name: result.card_name,
    edition_name: result.edition_name,
    variant_name: result.variant_name,
    serial: result.serial,
    pool_name: result.pool_name,
    pool_slug: result.pool_slug,
    price: result.price,
    currency_symbol: result.currency.symbol,
    balance_after: result.balance_after,
    balance_after_debit: result.balance_after_debit,
    new_subject: result.new_subject,
    new_finish: result.new_finish,
    owned_copies: result.owned_copies,
    probability_bps: result.probability_bps,
    material_key: result.material_key,
    effect_key: result.effect_key,
    credits_total: result.credits_total,
    achievement_credits: result.achievement_credits,
    settlement_status: result.settlement_status,
    settlement_pending: result.settlement_pending,
    drawn_at: result.drawn_at,
    // The shared draw service omits `replayed` on the first commit. Persisting
    // `undefined` made the first reveal look like a recovered re-send.
    replayed: result.replayed === true,
  };
}

function logReceiptIssue(
  message: string,
  fields: Record<string, string | number>,
  error?: unknown,
): void {
  console.error(
    JSON.stringify({
      level: "error",
      message,
      ...fields,
      ...(error === undefined
        ? {}
        : { detail: redactDiscordText(error instanceof Error ? error.message : String(error)) }),
    }),
  );
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Persist the domain result before presentation work. A failed write must not
 * mask a committed draw, so this reports success instead of throwing and the
 * handler falls back to the draw row. It retries once and checks affected rows
 * because an UPDATE that matches nothing looks like success to D1.
 */
export async function recordInteractionReceipt(
  db: D1Database,
  interactionId: string,
  receipt: DiscordReceipt,
): Promise<boolean> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const result = await db
        .prepare(
          `UPDATE fb_discord_interactions
              SET receipt_kind = ?, receipt_json = ?
            WHERE interaction_id = ?`,
        )
        .bind(receipt.kind, JSON.stringify(receipt), interactionId)
        .run();
      if ((result.meta?.changes ?? 0) > 0) return true;
      logReceiptIssue("Discord draw receipt update affected no rows", {
        interaction_id: interactionId,
        receipt_kind: receipt.kind,
        attempt,
      });
    } catch (error) {
      logReceiptIssue(
        "Discord draw receipt write failed",
        { interaction_id: interactionId, receipt_kind: receipt.kind, attempt },
        error,
      );
    }
  }
  return false;
}

/**
 * Strict persistence for the Effect workflow. It must know whether the durable
 * receipt exists before deciding to reconcile or retry, so a failed write is a
 * typed transient rather than a silent success.
 */
export async function persistInteractionReceipt(
  db: D1Database,
  interactionId: string,
  receipt: DiscordReceipt,
): Promise<void> {
  const ok = await recordInteractionReceipt(db, interactionId, receipt);
  if (!ok) {
    throw new Error(`Discord draw receipt could not be persisted for ${interactionId}`);
  }
}

/**
 * Read a persisted interaction receipt. Read failures are surfaced to the
 * caller; treating an unavailable database as a missing receipt would turn a
 * committed draw into a false "nothing changed" response.
 */
export async function readInteractionReceipt(
  db: D1Database,
  interactionId: string,
): Promise<DiscordReceipt | null> {
  const row = await first<{ receipt_kind: string | null; receipt_json: string | null }>(
    db,
    "SELECT receipt_kind, receipt_json FROM fb_discord_interactions WHERE interaction_id = ?",
    interactionId,
  );
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

interface DrawRow {
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
  drawn_at: string;
  receipt_json: string;
  currency_symbol: string | null;
}

interface SettlementSnapshot {
  balance_after: number;
  balance_after_debit: number | null;
  credits_total: number;
  achievement_credits: DiscordDrawCredit[];
  settlement_status: DrawSettlementStatus;
  settlement_pending: boolean;
}

function parsedReceipt(row: DrawRow): Partial<DiscordDrawReceipt> & {
  currency?: { symbol?: string };
} {
  try {
    const value = JSON.parse(row.receipt_json) as unknown;
    return value && typeof value === "object"
      ? (value as Partial<DiscordDrawReceipt> & { currency?: { symbol?: string } })
      : {};
  } catch {
    return {};
  }
}

async function readDrawRow(
  db: D1Database,
  input: { tenantId: string; userId: string; interactionId: string },
): Promise<DrawRow | null> {
  return first<DrawRow>(
    db,
    `SELECT d.id AS draw_id, d.instance_id, d.variant_id, d.price, d.created_at AS drawn_at,
            d.receipt_json, ci.card_id, ci.serial,
            cd.name AS card_name, v.name AS variant_name,
            ae.name AS edition_name, p.name AS pool_name,
            e.currency_symbol
       FROM fb_draws d
       JOIN fb_card_instances ci
         ON ci.id = d.instance_id AND ci.tenant_id = d.tenant_id
       JOIN fb_variants v ON v.id = d.variant_id
       JOIN fb_card_definitions cd ON cd.id = v.card_id
       LEFT JOIN fb_artwork_editions ae ON ae.id = v.edition_id
       JOIN fb_pools p ON p.id = d.pool_id AND p.tenant_id = d.tenant_id
       LEFT JOIN fb_economy_settings e ON e.tenant_id = d.tenant_id
      WHERE d.tenant_id = ? AND d.user_id = ? AND d.idempotency_key = ?
      LIMIT 1`,
    input.tenantId,
    input.userId,
    drawIdempotencyKey(input.interactionId),
  );
}

async function readSettlementSnapshot(
  db: D1Database,
  input: { tenantId: string; userId: string; drawId: string; idempotencyKey: string },
): Promise<SettlementSnapshot> {
  let pending = false;
  let stored: Record<string, unknown> | null = null;
  try {
    const row = await first<{ response_json: string }>(
      db,
      `SELECT response_json FROM fb_idempotency_keys
        WHERE tenant_id = ? AND actor_type = 'user' AND actor_id = ?
          AND operation = ? AND idempotency_key = ?`,
      input.tenantId,
      input.userId,
      DRAW_OPERATION,
      input.idempotencyKey,
    );
    if (row) {
      const parsed = JSON.parse(row.response_json) as unknown;
      stored = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    }
  } catch (error) {
    pending = true;
    logReceiptIssue(
      "Discord draw settlement receipt read failed",
      { draw_id: input.drawId },
      error,
    );
  }

  let credits: DiscordDrawCredit[] | null = null;
  if (stored && Array.isArray(stored.achievement_credits)) {
    credits = stored.achievement_credits
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const credit = item as Record<string, unknown>;
        const amount = numberOrNull(credit.amount);
        if (amount === null || amount <= 0) return null;
        return {
          id: typeof credit.id === "string" ? credit.id : "",
          name: typeof credit.name === "string" ? credit.name : "Achievement",
          amount,
        };
      })
      .filter((item): item is DiscordDrawCredit => item !== null);
  } else {
    try {
      const rows = await all<{
        id: string;
        name: string;
        amount: number;
        ledger_amount: number | null;
      }>(
        db,
        `SELECT u.achievement_id AS id, d.name,
                u.reward_amount AS amount, l.amount AS ledger_amount
           FROM fb_achievement_unlocks u
           JOIN fb_achievement_definitions d ON d.id = u.achievement_id
           LEFT JOIN fb_ledger_entries l
             ON l.tenant_id = u.tenant_id AND l.user_id = u.user_id
            AND l.reference_type = 'achievement' AND l.reference_id = u.id
          WHERE u.tenant_id = ? AND u.user_id = ?
            AND u.event_id IN (
              SELECT e.id FROM fb_domain_events e
               WHERE e.tenant_id = ? AND e.user_id = ? AND e.dedupe_key = ?
            )
          ORDER BY u.earned_at, u.rowid`,
        input.tenantId,
        input.userId,
        input.tenantId,
        input.userId,
        `draw:${input.drawId}`,
      );
      credits = rows
        .map((row) => {
          const amount =
            row.ledger_amount !== null ? Number(row.ledger_amount) : Number(row.amount);
          if (!Number.isFinite(amount) || amount <= 0) return null;
          return { id: row.id, name: row.name, amount };
        })
        .filter((item): item is DiscordDrawCredit => item !== null);
    } catch (error) {
      pending = true;
      credits = [];
      logReceiptIssue(
        "Discord draw achievement credits could not be read",
        { draw_id: input.drawId },
        error,
      );
    }
  }
  const creditRows = credits ?? [];
  const storedCredits = numberOrNull(stored?.credits_total);
  const creditsTotal = storedCredits ?? creditRows.reduce((sum, item) => sum + item.amount, 0);

  let debitBalance: number | null = null;
  try {
    const debit = await first<{ balance_after: number }>(
      db,
      `SELECT balance_after FROM fb_ledger_entries
        WHERE tenant_id = ? AND user_id = ? AND reference_type = 'draw' AND reference_id = ?
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      input.tenantId,
      input.userId,
      input.drawId,
    );
    debitBalance = numberOrNull(debit?.balance_after);
  } catch (error) {
    logReceiptIssue(
      "Discord draw debit balance could not be read",
      { draw_id: input.drawId },
      error,
    );
  }

  const storedDebitBalance = numberOrNull(stored?.balance_after_debit);
  const balanceAfterDebit = storedDebitBalance ?? debitBalance;
  let balanceAfter = numberOrNull(stored?.balance_after);
  if (balanceAfter === null && balanceAfterDebit !== null) {
    balanceAfter = balanceAfterDebit + creditsTotal;
  }
  if (balanceAfter === null) {
    try {
      const wallet = await first<{ balance: number }>(
        db,
        "SELECT balance FROM fb_wallets WHERE tenant_id = ? AND user_id = ?",
        input.tenantId,
        input.userId,
      );
      balanceAfter = numberOrNull(wallet?.balance);
    } catch (error) {
      logReceiptIssue(
        "Discord draw balance could not be read during recovery",
        { draw_id: input.drawId },
        error,
      );
    }
  }
  if (balanceAfter === null) {
    balanceAfter = 0;
    pending = true;
  }

  return {
    balance_after: balanceAfter,
    balance_after_debit: balanceAfterDebit,
    credits_total: creditsTotal,
    achievement_credits: creditRows,
    settlement_status: pending ? "pending" : "settled",
    settlement_pending: pending,
  };
}

function normaliseReceipt(
  row: DrawRow,
  parsed: Partial<DiscordDrawReceipt> & { currency?: { symbol?: string } },
  interactionReceipt: DiscordReceipt | null,
  settlement: SettlementSnapshot,
): DiscordDrawReceipt {
  const base = interactionReceipt;
  const credits =
    settlement.achievement_credits.length > 0
      ? settlement.achievement_credits
      : (base?.achievement_credits ?? []);
  const creditsTotal =
    credits.length > 0
      ? credits.reduce((sum, item) => sum + item.amount, 0)
      : settlement.credits_total;
  const currencySymbol =
    base?.currency_symbol ||
    (typeof parsed.currency?.symbol === "string" ? parsed.currency.symbol : null) ||
    row.currency_symbol ||
    "✦";
  return {
    kind: "draw",
    draw_id: row.draw_id,
    instance_id: row.instance_id,
    card_id: base?.card_id || row.card_id,
    variant_id: row.variant_id,
    card_name: base?.card_name || parsed.card_name || row.card_name,
    edition_name: base?.edition_name ?? parsed.edition_name ?? row.edition_name,
    variant_name: base?.variant_name || parsed.variant_name || row.variant_name,
    serial: row.serial,
    pool_name: base?.pool_name || parsed.pool_name || row.pool_name,
    ...(base?.pool_slug || typeof parsed.pool_slug === "string"
      ? { pool_slug: base?.pool_slug || (parsed.pool_slug as string) }
      : {}),
    price: numberOrNull(parsed.price) ?? row.price,
    currency_symbol: currencySymbol,
    new_subject:
      base?.new_subject ??
      (typeof parsed.new_subject === "boolean" ? parsed.new_subject : undefined),
    new_finish:
      base?.new_finish ?? (typeof parsed.new_finish === "boolean" ? parsed.new_finish : undefined),
    owned_copies:
      base?.owned_copies ??
      (typeof parsed.owned_copies === "number" ? parsed.owned_copies : undefined),
    probability_bps:
      base?.probability_bps ??
      (typeof parsed.probability_bps === "number" ? parsed.probability_bps : undefined),
    ...(base?.material_key || typeof parsed.material_key === "string"
      ? { material_key: base?.material_key || (parsed.material_key as string) }
      : {}),
    ...(base?.effect_key !== undefined || parsed.effect_key !== undefined
      ? { effect_key: base?.effect_key ?? (parsed.effect_key as string | null) }
      : {}),
    balance_after:
      typeof base?.balance_after === "number" ? base.balance_after : settlement.balance_after,
    ...(base?.balance_after_debit !== undefined
      ? { balance_after_debit: base.balance_after_debit }
      : settlement.balance_after_debit !== null
        ? { balance_after_debit: settlement.balance_after_debit }
        : {}),
    credits_total: creditsTotal,
    achievement_credits: credits,
    settlement_status: base?.settlement_status ?? settlement.settlement_status,
    settlement_pending: base?.settlement_pending ?? settlement.settlement_pending,
    drawn_at: row.drawn_at,
    replayed: base?.replayed ?? true,
  };
}

/**
 * Recover the original draw result for one interaction. The interaction
 * receipt is read first for speed, but it is accepted only when the scoped
 * draw row proves it belongs to this tenant and user. If the receipt is
 * missing, unreadable or stale, the deterministic draw row reconstructs the
 * same card, serial, debit and settled rewards.
 */
export async function recoverDrawReceipt(
  db: D1Database,
  input: { tenantId: string; userId: string; interactionId: string },
): Promise<DiscordReceipt | null> {
  let interactionReceipt: DiscordReceipt | null = null;
  try {
    interactionReceipt = await readInteractionReceipt(db, input.interactionId);
  } catch (error) {
    logReceiptIssue(
      "Discord interaction receipt read failed; falling back to the draw row",
      { interaction_id: input.interactionId },
      error,
    );
  }

  let row: DrawRow | null;
  try {
    row = await readDrawRow(db, input);
  } catch (error) {
    logReceiptIssue(
      "Discord draw row could not be read during recovery",
      { interaction_id: input.interactionId },
      error,
    );
    return null;
  }
  if (!row) return null;

  let settlement: SettlementSnapshot;
  try {
    settlement = await readSettlementSnapshot(db, {
      tenantId: input.tenantId,
      userId: input.userId,
      drawId: row.draw_id,
      idempotencyKey: drawIdempotencyKey(input.interactionId),
    });
  } catch (error) {
    logReceiptIssue("Discord draw settlement recovery failed", { draw_id: row.draw_id }, error);
    settlement = {
      balance_after:
        typeof interactionReceipt?.balance_after === "number"
          ? interactionReceipt.balance_after
          : (numberOrNull(parsedReceipt(row).balance_after) ?? 0),
      balance_after_debit: interactionReceipt?.balance_after_debit ?? null,
      credits_total: interactionReceipt?.credits_total ?? 0,
      achievement_credits: interactionReceipt?.achievement_credits ?? [],
      settlement_status: "pending",
      settlement_pending: true,
    };
  }

  const scopedReceipt =
    interactionReceipt && interactionReceipt.draw_id === row.draw_id ? interactionReceipt : null;
  return normaliseReceipt(row, parsedReceipt(row), scopedReceipt, settlement);
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
}): DiscordMessage {
  const { receipt } = input;
  const print = receipt.edition_name?.trim();
  const title = print
    ? `${receipt.card_name} — ${print}`
    : `${receipt.card_name} — ${receipt.variant_name}`;
  const collectionUrl = `${input.origin.replace(/\/$/, "")}/collection`;
  const credits = receipt.credits_total ?? 0;
  const creditNames = receipt.achievement_credits?.map((item) => item.name).filter(Boolean) ?? [];
  const settlementNote = receipt.settlement_pending
    ? "Reward settlement is still being confirmed from the ledger. The draw, serial and debit are already recorded; rewards are never paid twice."
    : credits > 0
      ? `Settled rewards: **+${receiptNumber(credits)} ${receipt.currency_symbol}**${creditNames.length ? ` · ${creditNames.join(", ")}` : ""}.`
      : null;
  return {
    embeds: [
      {
        title: "Draw completed — display interrupted",
        description: [
          `Your draw **did** complete before the display failed. ${title} is already in your cabinet as serial \`${receipt.serial}\`.`,
          `${receipt.price} ${receipt.currency_symbol} was charged once from **${receipt.pool_name}**. Current balance: **${receiptNumber(receipt.balance_after)} ${receipt.currency_symbol}**.`,
          ...(settlementNote ? [settlementNote] : []),
          input.reason,
          "Do not open again to recover this result. Use View cabinet, or Re-send receipt to retry only the display of this same card.",
        ].join("\n\n"),
        color: DISCORD_PALETTE.danger,
        fields: [
          { name: "Serial", value: `\`${receipt.serial}\``, inline: true },
          {
            name: "Balance",
            value: `${receiptNumber(receipt.balance_after)} ${receipt.currency_symbol}`,
            inline: true,
          },
          { name: "Receipt", value: `\`${receipt.draw_id}\``, inline: false },
        ],
        footer: {
          text: `Foilbury · committed ${receipt.drawn_at} · reference ${input.interactionId.slice(0, 24)}`,
        },
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
