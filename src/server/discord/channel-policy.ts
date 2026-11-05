import { ApiError } from "../context";
import type { DiscordInstallation } from "./types";

type ChannelAudience = "public" | "members" | "private";
const snowflake = /^\d{15,22}$/;

function invalid(): never {
  throw new ApiError(403, "discord_channel_policy_invalid", "This server's channel policy is invalid. Ask an administrator to repair the installation configuration.");
}

/** Strictly parse the flat channel map without losing duplicate decoded keys.
 * JSON.parse first validates JSON syntax; the second pass preserves key order. */
function audienceMap(raw: string | null | undefined): Map<string, ChannelAudience> {
  const text = raw ?? "{}";
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return invalid(); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return invalid();
  let i = 0;
  const whitespace = () => { while (i < text.length && /[\t\n\r ]/.test(text[i]!)) i++; };
  const token = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
  const readString = (): string => {
    token.lastIndex = i;
    const match = token.exec(text);
    if (!match) return invalid();
    i = token.lastIndex;
    try { return JSON.parse(match[0]) as string; } catch { return invalid(); }
  };
  whitespace();
  if (text[i++] !== "{") return invalid();
  whitespace();
  const values = new Map<string, ChannelAudience>();
  if (text[i] === "}") { i++; whitespace(); if (i !== text.length) return invalid(); return values; }
  for (;;) {
    const key = readString();
    whitespace();
    if (text[i++] !== ":") return invalid();
    whitespace();
    const value = readString();
    if (!snowflake.test(key) || values.has(key) || !["public", "members", "private"].includes(value)) return invalid();
    values.set(key, value as ChannelAudience);
    whitespace();
    const delimiter = text[i++];
    if (delimiter === "}") break;
    if (delimiter !== ",") return invalid();
    whitespace();
  }
  whitespace();
  if (i !== text.length) return invalid();
  return values;
}

export function parseChannelPolicy(installation: DiscordInstallation) {
  let channels: unknown;
  try { channels = JSON.parse(installation.channel_allowlist_json); } catch { return invalid(); }
  if (!Array.isArray(channels) || channels.some((id) => typeof id !== "string" || !snowflake.test(id))) return invalid();
  return { allowedChannels: channels as string[], audiences: audienceMap(installation.channel_audience_json) };
}

export function assertChannelAllowed(channels: string[], channelId: string | null | undefined): void {
  if (channels.length && (!channelId || !channels.includes(channelId))) {
    throw new ApiError(403, "discord_channel_not_enabled", "Foilbury is not enabled in this channel. Try the configured play channel.");
  }
}
