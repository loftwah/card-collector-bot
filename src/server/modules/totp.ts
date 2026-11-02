import type { D1Database } from "@cloudflare/workers-types";
import { ApiError, type Ctx } from "../context";
import { first, nowIso } from "../db";
import { base64url, newId, sha256Hex } from "../ids";
import type { RuntimeConfig } from "../config";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const PERIOD = 30;
const DIGITS = 6;

export function generateTotpSecret(): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(20)));
}

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const character of clean) {
    const index = ALPHABET.indexOf(character);
    if (index < 0) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(output);
}

export async function totpCode(secret: string, timestamp = Date.now()): Promise<string> {
  const counter = Math.floor(timestamp / 1000 / PERIOD);
  const counterBytes = new Uint8Array(8);
  let value = counter;
  for (let index = 7; index >= 0; index -= 1) {
    counterBytes[index] = value & 255;
    value = Math.floor(value / 256);
  }
  const key = await crypto.subtle.importKey("raw", base32Decode(secret) as unknown as BufferSource, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, counterBytes));
  const offset = signature[signature.length - 1]! & 15;
  const binary =
    ((signature[offset]! & 127) << 24) |
    ((signature[offset + 1]! & 255) << 16) |
    ((signature[offset + 2]! & 255) << 8) |
    (signature[offset + 3]! & 255);
  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

export async function verifyTotp(secret: string, code: string, timestamp = Date.now(), window = 1): Promise<boolean> {
  const normalized = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(normalized)) return false;
  for (let offset = -window; offset <= window; offset += 1) {
    const expected = await totpCode(secret, timestamp + offset * PERIOD * 1000);
    if (constantTimeEqual(expected, normalized)) return true;
  }
  return false;
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

async function encryptionKey(config: RuntimeConfig): Promise<CryptoKey> {
  const material = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`foilbury-totp:${config.sessionSecret}`));
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(secret: string, config: RuntimeConfig): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await encryptionKey(config), new TextEncoder().encode(secret));
  return `${base64url(iv)}.${base64url(new Uint8Array(encrypted))}`;
}

export async function decryptSecret(value: string, config: RuntimeConfig): Promise<string> {
  const [ivPart, cipherPart] = value.split(".");
  if (!ivPart || !cipherPart) throw new Error("Invalid encrypted TOTP secret");
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64url(ivPart) as unknown as BufferSource },
    await encryptionKey(config),
    fromBase64url(cipherPart) as unknown as BufferSource,
  );
  return new TextDecoder().decode(decrypted);
}

function fromBase64url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function otpauthUrl(input: { secret: string; email: string; issuer?: string }): string {
  const issuer = input.issuer ?? "Foilbury";
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(input.email)}?secret=${input.secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${PERIOD}`;
}

export async function startTotpSetup(ctx: Ctx) {
  if (!ctx.user) throw new ApiError(401, "authentication_required", "Sign in first.");
  const existing = await first<{ confirmed_at: string | null }>(ctx.db, "SELECT confirmed_at FROM fb_totp_secrets WHERE user_id = ?", ctx.user.id);
  if (existing?.confirmed_at) throw new ApiError(409, "totp_already_configured", "An authenticator is already configured. Remove it before adding another.");
  const secret = generateTotpSecret();
  await ctx.db
    .prepare(
      `INSERT INTO fb_totp_secrets (user_id, secret_enc, created_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET secret_enc = excluded.secret_enc, confirmed_at = NULL, created_at = excluded.created_at`,
    )
    .bind(ctx.user.id, await encryptSecret(secret, ctx.config), nowIso())
    .run();
  return { secret, otpauth_url: otpauthUrl({ secret, email: ctx.user.email }) };
}

export async function confirmTotpSetup(ctx: Ctx, code: string): Promise<{ recoveryCodes: string[] }> {
  if (!ctx.user) throw new ApiError(401, "authentication_required", "Sign in first.");
  const row = await first<{ secret_enc: string; confirmed_at: string | null }>(
    ctx.db,
    "SELECT secret_enc, confirmed_at FROM fb_totp_secrets WHERE user_id = ?",
    ctx.user.id,
  );
  if (!row) throw new ApiError(404, "totp_not_started", "Start authenticator setup first.");
  if (row.confirmed_at) throw new ApiError(409, "totp_already_configured", "The authenticator is already configured.");
  const secret = await decryptSecret(row.secret_enc, ctx.config);
  if (!(await verifyTotp(secret, code))) throw new ApiError(422, "totp_code_invalid", "That authenticator code is not valid.");
  await ctx.db.prepare("UPDATE fb_totp_secrets SET confirmed_at = ?, last_used_at = ? WHERE user_id = ?").bind(nowIso(), nowIso(), ctx.user.id).run();
  const recoveryCodes = await issueRecoveryCodes(ctx.db, ctx.user.id);
  return { recoveryCodes };
}

export async function verifyUserTotp(ctx: Ctx, userId: string, code: string): Promise<boolean> {
  const row = await first<{ secret_enc: string; confirmed_at: string | null; last_used_at: string | null }>(
    ctx.db,
    "SELECT secret_enc, confirmed_at, last_used_at FROM fb_totp_secrets WHERE user_id = ?",
    userId,
  );
  if (!row?.confirmed_at) return false;
  if (row.last_used_at && Date.now() - new Date(row.last_used_at).getTime() < PERIOD * 1000) return false;
  const secret = await decryptSecret(row.secret_enc, ctx.config);
  if (!(await verifyTotp(secret, code))) return false;
  await ctx.db.prepare("UPDATE fb_totp_secrets SET last_used_at = ? WHERE user_id = ?").bind(nowIso(), userId).run();
  return true;
}

export async function removeTotp(ctx: Ctx): Promise<void> {
  if (!ctx.user) throw new ApiError(401, "authentication_required", "Sign in first.");
  await ctx.db.prepare("DELETE FROM fb_totp_secrets WHERE user_id = ?").bind(ctx.user.id).run();
  await ctx.db.prepare("DELETE FROM fb_recovery_codes WHERE user_id = ?").bind(ctx.user.id).run();
}

export async function issueRecoveryCodes(db: D1Database, userId: string): Promise<string[]> {
  await db.prepare("DELETE FROM fb_recovery_codes WHERE user_id = ?").bind(userId).run();
  const codes: string[] = [];
  for (let index = 0; index < 10; index += 1) {
    const code = `${randomGroup()}-${randomGroup()}`;
    codes.push(code);
    await db
      .prepare("INSERT INTO fb_recovery_codes (id, user_id, code_hash, created_at) VALUES (?, ?, ?, ?)")
      .bind(newId("rcv"), userId, await sha256Hex(code.toUpperCase()), nowIso())
      .run();
  }
  return codes;
}

export async function consumeRecoveryCode(ctx: Ctx, userId: string, code: string): Promise<boolean> {
  const hash = await sha256Hex(code.trim().toUpperCase());
  const row = await first<{ id: string }>(ctx.db, "SELECT id FROM fb_recovery_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL", userId, hash);
  if (!row) return false;
  const updated = await ctx.db.prepare("UPDATE fb_recovery_codes SET used_at = ? WHERE id = ? AND used_at IS NULL").bind(nowIso(), row.id).run();
  return (updated.meta?.changes ?? 0) === 1;
}

export async function recoveryCodeCount(db: D1Database, userId: string): Promise<number> {
  const row = await first<{ count: number }>(db, "SELECT COUNT(*) AS count FROM fb_recovery_codes WHERE user_id = ? AND used_at IS NULL", userId);
  return row?.count ?? 0;
}

function randomGroup(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}
