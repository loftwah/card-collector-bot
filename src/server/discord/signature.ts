import { ApiError } from "../context";

const MAX_CLOCK_SKEW_SECONDS = 300;

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new ApiError(500, "discord_public_key_invalid", "The Discord public key is not configured correctly.");
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Discord signs the exact raw request body as `<timestamp><body>` with Ed25519.
 * Verify before parsing, and reject a stale timestamp so a captured request
 * cannot be replayed indefinitely.
 */
export async function verifyDiscordSignature(input: {
  body: string;
  signature: string | null;
  timestamp: string | null;
  publicKey: string | undefined;
  nowSeconds?: number;
}): Promise<void> {
  const { body, signature, timestamp, publicKey } = input;
  if (!publicKey) throw new ApiError(503, "discord_not_configured", "The Discord interactions endpoint has no public key configured.");
  if (!signature || !/^[0-9a-f]{128}$/i.test(signature)) {
    throw new ApiError(401, "discord_signature_invalid", "The Discord request signature is missing or malformed.");
  }
  if (!timestamp || !/^\d{1,12}$/.test(timestamp)) {
    throw new ApiError(401, "discord_timestamp_invalid", "The Discord request timestamp is missing or malformed.");
  }
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const sent = Number(timestamp);
  if (!Number.isSafeInteger(sent) || Math.abs(now - sent) > MAX_CLOCK_SKEW_SECONDS) {
    throw new ApiError(401, "discord_timestamp_stale", "The Discord request timestamp is outside the accepted window.");
  }

  const key = await crypto.subtle.importKey(
    "raw",
    hexToBytes(publicKey) as unknown as BufferSource,
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  const signed = new TextEncoder().encode(`${timestamp}${body}`);
  const signatureBytes = new Uint8Array(64);
  for (let index = 0; index < signatureBytes.length; index += 1) {
    signatureBytes[index] = Number.parseInt(signature.slice(index * 2, index * 2 + 2), 16);
  }
  const valid = await crypto.subtle.verify(
    { name: "Ed25519" },
    key,
    signatureBytes as unknown as BufferSource,
    signed as unknown as BufferSource,
  );
  if (!valid) throw new ApiError(401, "discord_signature_invalid", "The Discord request signature did not verify.");
}

export async function signDiscordRequest(input: {
  body: string;
  timestamp: string;
  privateKey: CryptoKey;
}): Promise<string> {
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    input.privateKey,
    new TextEncoder().encode(`${input.timestamp}${input.body}`) as unknown as BufferSource,
  );
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
