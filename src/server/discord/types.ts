import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import type { RawEnv } from "../config";

export interface DiscordEnv extends RawEnv {
  DB: D1Database;
  MEDIA: R2Bucket;
  DISCORD_PUBLIC_KEY?: string;
  DISCORD_APPLICATION_ID?: string;
  DISCORD_BOT_TOKEN?: string;
}

export interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  discriminator?: string;
  bot?: boolean;
}

export interface DiscordMember {
  user?: DiscordUser;
  roles?: string[];
  permissions?: string;
  nick?: string | null;
}

export interface DiscordOption {
  name: string;
  type: number;
  value?: string | number | boolean;
  options?: DiscordOption[];
  focused?: boolean;
}

export interface DiscordInteraction {
  id: string;
  application_id: string;
  type: number;
  data?: {
    id?: string;
    name?: string;
    type?: number;
    custom_id?: string;
    component_type?: number;
    values?: string[];
    options?: DiscordOption[];
  };
  guild_id?: string;
  channel_id?: string;
  member?: DiscordMember;
  user?: DiscordUser;
  token: string;
  version: number;
  locale?: string;
  guild_locale?: string;
}

export interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  image?: { url: string; width?: number; height?: number };
  thumbnail?: { url: string };
  footer?: { text: string };
  timestamp?: string;
}

export interface DiscordComponent {
  type: number;
  style?: number;
  label?: string;
  custom_id?: string;
  url?: string;
  disabled?: boolean;
  emoji?: { name: string };
}

export interface DiscordMessage {
  content?: string;
  embeds?: DiscordEmbed[];
  components?: Array<{ type: number; components: DiscordComponent[] }>;
  allowed_mentions?: { parse: string[]; users?: string[]; roles?: string[] };
  flags?: number;
}

export interface DiscordAttachment {
  r2Key: string;
  filename: string;
  contentType: string;
}

export interface DiscordCallback {
  type: number;
  data?: DiscordMessage;
  attachments?: DiscordAttachment[];
}

export interface DiscordInstallation {
  id: string;
  tenant_id: string;
  application_id: string;
  guild_id: string;
  guild_name: string | null;
  channel_allowlist_json: string;
  channel_key: string | null;
  game_enabled: number;
  website_enabled: number;
  api_enabled: number;
  public_catalogue_enabled: number;
  admin_gui_enabled: number;
  active: number;
  installed_by_discord_id: string | null;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
}

export interface DiscordIdentity {
  id: string;
  tenant_id: string;
  discord_user_id: string;
  user_id: string;
  username: string | null;
  global_name: string | null;
  linked_at: string;
  last_seen_at: string;
  revoked_at: string | null;
}
