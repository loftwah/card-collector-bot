import type { D1Database } from "@cloudflare/workers-types";
import { all, first, nowIso } from "../db";
import { newId } from "../ids";
import { ApiError } from "../context";

export type LedgerKind =
  | "issue"
  | "spend"
  | "burn"
  | "correction"
  | "transfer_in"
  | "transfer_out"
  | "recycle";

export interface WalletSummary {
  balance: number;
  currencyName: string;
  currencySymbol: string;
  ledger: Array<{
    id: string;
    kind: string;
    amount: number;
    balance_after: number;
    description: string;
    created_at: string;
    reference_type: string | null;
    reference_id: string | null;
  }>;
}

export async function getWallet(
  db: D1Database,
  tenantId: string,
  userId: string,
): Promise<{ balance: number; currency_name: string; currency_symbol: string }> {
  const row = await first<{ balance: number; currency_name: string; currency_symbol: string }>(
    db,
    `SELECT w.balance, e.currency_name, e.currency_symbol
       FROM fb_wallets w JOIN fb_economy_settings e ON e.tenant_id = w.tenant_id
      WHERE w.tenant_id = ? AND w.user_id = ?`,
    tenantId,
    userId,
  );
  if (!row) throw new ApiError(404, "wallet_not_found", "This member has no wallet in this tenant.");
  return row;
}

export async function getWalletSummary(
  db: D1Database,
  tenantId: string,
  userId: string,
  limit = 50,
): Promise<WalletSummary> {
  const wallet = await getWallet(db, tenantId, userId);
  const ledger = await all<{
    id: string;
    kind: string;
    amount: number;
    balance_after: number;
    description: string;
    created_at: string;
    reference_type: string | null;
    reference_id: string | null;
  }>(
    db,
    `SELECT id, kind, amount, balance_after, description, created_at, reference_type, reference_id
       FROM fb_ledger_entries WHERE tenant_id = ? AND user_id = ?
      ORDER BY created_at DESC LIMIT ?`,
    tenantId,
    userId,
    limit,
  );
  return {
    balance: wallet.balance,
    currencyName: wallet.currency_name,
    currencySymbol: wallet.currency_symbol,
    ledger,
  };
}

/**
 * Credits an existing wallet and writes the matching ledger row in one D1 batch.
 * The wallet update and ledger insert either both commit or both roll back.
 */
export async function creditWallet(
  db: D1Database,
  input: {
    tenantId: string;
    userId: string;
    amount: number;
    kind: LedgerKind;
    description: string;
    idempotencyKey: string;
    referenceType?: string;
    referenceId?: string;
    metadata?: Record<string, unknown>;
    actorType?: string;
    actorId?: string;
  },
): Promise<{ balance: number; ledgerId: string }> {
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw new ApiError(422, "amount_invalid", "Credit amount must be a positive integer.");
  }
  // A retry after an uncertain commit must reconcile against the authoritative
  // ledger, not add a second credit. The unique idempotency index is the final
  // guard; this read makes the common retry path quiet and deterministic.
  const previous = await first<{ id: string }>(
    db,
    "SELECT id FROM fb_ledger_entries WHERE tenant_id = ? AND user_id = ? AND idempotency_key = ?",
    input.tenantId,
    input.userId,
    input.idempotencyKey,
  );
  if (previous) {
    const current = await getWallet(db, input.tenantId, input.userId);
    return { balance: current.balance, ledgerId: previous.id };
  }
  const wallet = await getWallet(db, input.tenantId, input.userId);
  const ledgerId = newId("led");
  const now = nowIso();
  await db.batch([
    db
      .prepare("UPDATE fb_wallets SET balance = balance + ?, updated_at = ? WHERE tenant_id = ? AND user_id = ?")
      .bind(input.amount, now, input.tenantId, input.userId),
    db
      .prepare(
        `INSERT INTO fb_ledger_entries
          (id, tenant_id, user_id, kind, amount, balance_after, reference_type, reference_id,
           description, idempotency_key, metadata_json, actor_type, actor_id, created_at)
         SELECT ?, ?, ?, ?, ?, balance, ?, ?, ?, ?, ?, ?, ?, ?
           FROM fb_wallets WHERE tenant_id = ? AND user_id = ?`,
      )
      .bind(
        ledgerId,
        input.tenantId,
        input.userId,
        input.kind,
        input.amount,
        input.referenceType ?? null,
        input.referenceId ?? null,
        input.description,
        input.idempotencyKey,
        JSON.stringify(input.metadata ?? {}),
        input.actorType ?? "user",
        input.actorId ?? input.userId,
        now,
        input.tenantId,
        input.userId,
      ),
  ]);
  const after = await getWallet(db, input.tenantId, input.userId);
  const ledger = await first<{ id: string }>(
    db,
    "SELECT id FROM fb_ledger_entries WHERE tenant_id = ? AND user_id = ? AND idempotency_key = ?",
    input.tenantId,
    input.userId,
    input.idempotencyKey,
  );
  if (!ledger) throw new ApiError(409, "credit_not_applied", "The ledger row was not written.");
  return { balance: after.balance, ledgerId: ledger.id };
}

/**
 * Applies a signed correction without ever deleting or rewriting ledger history.
 */
export async function correctWallet(
  db: D1Database,
  input: {
    tenantId: string;
    userId: string;
    amount: number;
    description: string;
    idempotencyKey: string;
    referenceType?: string;
    referenceId?: string;
    metadata?: Record<string, unknown>;
    actorType?: string;
    actorId?: string;
  },
): Promise<{ balance: number; ledgerId: string }> {
  if (!Number.isInteger(input.amount) || input.amount === 0) {
    throw new ApiError(422, "amount_invalid", "Correction amount must be a non-zero integer.");
  }
  if (input.amount > 0) {
    return creditWallet(db, { ...input, kind: "correction" });
  }
  const wallet = await getWallet(db, input.tenantId, input.userId);
  if (wallet.balance + input.amount < 0) {
    throw new ApiError(409, "insufficient_funds", "The correction would make this wallet negative.");
  }
  const ledgerId = newId("led");
  const now = nowIso();
  await db.batch([
    db
      .prepare(
        "UPDATE fb_wallets SET balance = balance + ?, updated_at = ? WHERE tenant_id = ? AND user_id = ? AND balance + ? >= 0",
      )
      .bind(input.amount, now, input.tenantId, input.userId, input.amount),
    db
      .prepare(
        `INSERT INTO fb_ledger_entries
          (id, tenant_id, user_id, kind, amount, balance_after, reference_type, reference_id,
           description, idempotency_key, metadata_json, actor_type, actor_id, created_at)
         SELECT ?, ?, ?, 'correction', ?, balance, ?, ?, ?, ?, ?, ?, ?, ?
           FROM fb_wallets WHERE tenant_id = ? AND user_id = ?`,
      )
      .bind(
        ledgerId,
        input.tenantId,
        input.userId,
        input.amount,
        input.referenceType ?? null,
        input.referenceId ?? null,
        input.description,
        input.idempotencyKey,
        JSON.stringify(input.metadata ?? {}),
        input.actorType ?? "user",
        input.actorId ?? input.userId,
        now,
        input.tenantId,
        input.userId,
      ),
  ]);
  const ledger = await first<{ id: string }>(
    db,
    "SELECT id FROM fb_ledger_entries WHERE tenant_id = ? AND user_id = ? AND idempotency_key = ?",
    input.tenantId,
    input.userId,
    input.idempotencyKey,
  );
  if (!ledger) throw new ApiError(409, "correction_not_applied", "The correction was not applied.");
  return { balance: (await getWallet(db, input.tenantId, input.userId)).balance, ledgerId: ledger.id };
}
