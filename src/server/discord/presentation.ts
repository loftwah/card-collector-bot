import { displayFinish } from "../../lib/utils";
import type {
  DiscordAttachment,
  DiscordCallback,
  DiscordComponent,
  DiscordEmbed,
  DiscordMessage,
} from "./types";

/**
 * Reusable Discord presentation layer for Foilbury.
 *
 * This module only builds payloads. It never reads D1, spends Foil, awards a
 * card or decides authority. The command router owns those decisions and passes
 * the committed domain result in here. Every builder defaults to a private
 * response; a channel response is only possible when the caller states the
 * card/album audience, the verified channel audience and explicit approval.
 *
 * Visual vocabulary: deep aqua, electric aqua, ice, signal lime and ink from
 * DESIGN.md. Colour is always a second channel; titles, labels and status text
 * carry the meaning. No emoji-only semantics and no second card renderer: card
 * images are the saved published renders, attached with safe filenames.
 */

export const DISCORD_LIMITS = {
  embedTitle: 256,
  embedDescription: 4096,
  embedFields: 25,
  inlineFields: 5,
  fieldName: 256,
  fieldValue: 1024,
  footer: 2048,
  embedsPerMessage: 10,
  embedCharacters: 6000,
  componentRows: 5,
  buttonsPerRow: 5,
  customId: 100,
  buttonLabel: 80,
  buttonUrl: 512,
  attachmentFilename: 100,
  messageContent: 2000,
} as const;

export const FOILBURY_PALETTE = {
  deepAqua: 0x044e4a,
  electricAqua: 0x00a99c,
  ice: 0xc8f4ee,
  lime: 0xc9f25f,
  ink: 0x07110f,
  bone: 0xeff5f1,
  albumSage: 0x84978a,
} as const;

export type FoilburyAccent = (typeof FOILBURY_PALETTE)[keyof typeof FOILBURY_PALETTE];

export type Audience = "public" | "members" | "private";

const AUDIENCE_RANK: Record<Audience, number> = { public: 0, members: 1, private: 2 };
const PALETTE_VALUES = new Set<number>(Object.values(FOILBURY_PALETTE));

export type PresentationErrorCode =
  | "discord_limit"
  | "invalid_input"
  | "invalid_url"
  | "invalid_button"
  | "duplicate_custom_id"
  | "private_identifier"
  | "channel_audience_unverified"
  | "unsafe_attachment";

export class PresentationError extends Error {
  readonly code: PresentationErrorCode;
  readonly path: string;

  constructor(code: PresentationErrorCode, path: string, message: string) {
    super(message);
    this.name = "PresentationError";
    this.code = code;
    this.path = path;
  }
}

function fail(code: PresentationErrorCode, path: string, message: string): never {
  throw new PresentationError(code, path, message);
}

/**
 * These patterns deliberately never echo the offending value. They are a
 * backstop against a caller passing a token, raw account/installation id, R2
 * path or email into visible copy.
 */
const PRIVATE_IDENTIFIER_PATTERNS: RegExp[] = [
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
  /\b(?:sk|pk|rk|whsec)_(?:live|test)?_?[A-Za-z0-9_-]{8,}\b/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\b(?:api[_-]?key|client[_-]?secret|bot[_-]?token|access[_-]?token|refresh[_-]?token)\b/i,
  /\b(?:usr|ten|dci|drw|ins|rwd|shr|dcf)_[A-Za-z0-9_-]{6,}\b/,
  /\b\d{17,22}\b/,
  /\b(?:password|passwd)\s*[:=]\s*\S+/i,
];

export function hasTextSemantics(value: string): boolean {
  return /[\p{L}\p{N}]/u.test(value);
}

export function clipText(value: string, max: number): string {
  if (max <= 0) return "";
  if (value.length <= max) return value;
  let cut = value.slice(0, Math.max(0, max - 1));
  // Never leave a lone high surrogate when the limit lands inside an emoji.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
}

function normaliseText(value: string, multiline = false): string {
  const normalised = value.replace(/\r\n?/g, "\n").trim();
  return multiline ? normalised : normalised.replace(/\s+/g, " ");
}

function assertNoPrivateIdentifiers(value: string, path: string): void {
  for (const pattern of PRIVATE_IDENTIFIER_PATTERNS) {
    if (pattern.test(value)) {
      fail(
        "private_identifier",
        path,
        "Visible Discord copy must not contain secrets or private identifiers.",
      );
    }
  }
}

function visibleText(
  value: string,
  path: string,
  options: { multiline?: boolean; required?: boolean } = {},
): string {
  const normalised = normaliseText(value, options.multiline ?? false);
  if ((options.required ?? true) && !hasTextSemantics(normalised)) {
    fail(
      "invalid_input",
      path,
      "Visible Discord copy needs a word or number, not a symbol or emoji alone.",
    );
  }
  assertNoPrivateIdentifiers(normalised, path);
  return normalised;
}

function assertNumber(value: number, path: string, options: { integer?: boolean } = {}): number {
  if (!Number.isFinite(value) || (options.integer && !Number.isInteger(value))) {
    fail("invalid_input", path, "Expected a finite number.");
  }
  return value;
}

function assertNonNegative(value: number, path: string): number {
  assertNumber(value, path);
  if (value < 0) fail("invalid_input", path, "Expected a non-negative number.");
  return value;
}

function assertCurrencySymbol(value: string): string {
  const normalised = normaliseText(value);
  if (!normalised || normalised.length > 8 || /[\u0000-\u001f\u007f]/.test(normalised)) {
    fail("invalid_input", "currencySymbol", "Currency symbol must be a short printable token.");
  }
  assertNoPrivateIdentifiers(normalised, "currencySymbol");
  return normalised;
}

export function formatDiscordTimestamp(value: string, style: "R" | "f" | "D" | "t" = "R"): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()))
    fail("invalid_input", "timestamp", "Expected an ISO timestamp.");
  return `<t:${Math.floor(date.getTime() / 1000)}:${style}>`;
}

function assertIsoTimestamp(value: string, path: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) fail("invalid_input", path, "Expected an ISO timestamp.");
  return value;
}

function assertFoilburyAccent(value: number): number {
  if (!PALETTE_VALUES.has(value)) {
    fail("invalid_input", "accent", "Use a Foilbury Signal palette colour.");
  }
  return value;
}

export function audienceRank(value: string): number {
  return AUDIENCE_RANK[(value as Audience) in AUDIENCE_RANK ? (value as Audience) : "private"];
}

export function audienceLabel(value: Audience): string {
  if (value === "public") return "Public showcase";
  if (value === "members") return "Members only";
  return "Private";
}

export function canShareToChannel(input: {
  audience?: Audience;
  channelAudience?: Audience;
  channelApproved?: boolean;
}): boolean {
  if (!input.audience || input.audience === "private") return false;
  if (input.channelApproved !== true) return false;
  return audienceRank(input.channelAudience ?? "public") >= audienceRank(input.audience);
}

/* ------------------------------------------------------------------ */
/* Fields, embeds, buttons and attachments                             */
/* ------------------------------------------------------------------ */

export interface FieldInput {
  name: string;
  value: string;
  inline?: boolean;
}

export interface BuiltField {
  name: string;
  value: string;
  inline: boolean;
}

export function buildField(input: FieldInput): BuiltField {
  const name = visibleText(input.name, "field.name");
  const value = visibleText(input.value, "field.value", { multiline: true });
  return {
    name: clipText(name, DISCORD_LIMITS.fieldName),
    value: clipText(value, DISCORD_LIMITS.fieldValue),
    inline: input.inline === true,
  };
}

/**
 * Discord allows 25 fields but three inline fields per visual row. Foilbury
 * deliberately caps a panel at five inline fields; any extra inline field is
 * demoted to a full-width field rather than dropped.
 */
export function buildFields(inputs: FieldInput[]): BuiltField[] {
  if (inputs.length > DISCORD_LIMITS.embedFields) {
    fail(
      "discord_limit",
      "fields",
      `An embed may contain at most ${DISCORD_LIMITS.embedFields} fields.`,
    );
  }
  let inlineCount = 0;
  return inputs.map((input) => {
    const field = buildField(input);
    if (!field.inline) return field;
    if (inlineCount >= DISCORD_LIMITS.inlineFields) return { ...field, inline: false };
    inlineCount += 1;
    return field;
  });
}

export interface EmbedImageInput {
  attachment?: string;
  url?: string;
  width?: number;
  height?: number;
}

export interface EmbedInput {
  title: string;
  description?: string;
  fields?: FieldInput[];
  footer?: string;
  timestamp?: string;
  accent?: number;
  image?: EmbedImageInput;
}

function assertPublicUrl(
  value: string,
  path: string,
  options: { allowResourceObjectIds?: boolean } = {},
): string {
  const raw = value.trim();
  if (!raw || raw.length > DISCORD_LIMITS.buttonUrl) {
    fail("invalid_url", path, "Expected an http(s) URL within Discord's length limit.");
  }
  // A deep link to an owned card necessarily carries an opaque resource id.
  // The web route re-authorises the viewer; account, tenant, draw and user ids
  // remain rejected. Visible copy never gets this exception.
  const checked = options.allowResourceObjectIds
    ? raw.replace(/\b(?:ins|crd|col|var|edt|pool|rnd|poe|ast|ach|unl|obx|gft|job|set|cat|tag|lk)_[A-Za-z0-9_-]{4,}\b/g, "[resource]")
    : raw;
  assertNoPrivateIdentifiers(checked, path);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    fail("invalid_url", path, "Expected a valid absolute URL.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    fail("invalid_url", path, "Only http(s) links may be used in Discord buttons.");
  }
  if (parsed.username || parsed.password) {
    fail("invalid_url", path, "A Discord link must not embed credentials.");
  }
  for (const key of parsed.searchParams.keys()) {
    if (/(?:token|secret|api[_-]?key|password|passwd)/i.test(key)) {
      fail("invalid_url", path, "A Discord link must not carry a secret in its query string.");
    }
  }
  return parsed.toString();
}

export function attachmentReference(filename: string): string {
  assertSafeAttachmentFilename(filename, undefined);
  return `attachment://${filename}`;
}

function buildEmbedImage(input: EmbedImageInput): { url: string; width?: number; height?: number } {
  const hasAttachment = typeof input.attachment === "string" && input.attachment.length > 0;
  const hasUrl = typeof input.url === "string" && input.url.length > 0;
  if (hasAttachment === hasUrl) {
    fail("invalid_input", "embed.image", "Provide exactly one attachment or public image URL.");
  }
  const width =
    input.width === undefined
      ? undefined
      : Math.round(assertNumber(input.width, "embed.image.width"));
  const height =
    input.height === undefined
      ? undefined
      : Math.round(assertNumber(input.height, "embed.image.height"));
  if ((width === undefined) !== (height === undefined)) {
    fail("invalid_input", "embed.image", "Provide both image dimensions or neither.");
  }
  if (width !== undefined && (width <= 0 || height === undefined || height <= 0)) {
    fail("invalid_input", "embed.image", "Image dimensions must be positive.");
  }
  const url = hasAttachment
    ? attachmentReference(input.attachment as string)
    : assertPublicUrl(input.url as string, "embed.image.url");
  return { url, ...(width !== undefined && height !== undefined ? { width, height } : {}) };
}

function embedCharacterCount(embed: DiscordEmbed): number {
  let total = (embed.title?.length ?? 0) + (embed.description?.length ?? 0);
  total +=
    embed.fields?.reduce((sum, field) => sum + field.name.length + field.value.length, 0) ?? 0;
  total += embed.footer?.text.length ?? 0;
  total += embed.timestamp?.length ?? 0;
  return total;
}

export function buildEmbed(input: EmbedInput): DiscordEmbed {
  const title = clipText(visibleText(input.title, "embed.title"), DISCORD_LIMITS.embedTitle);
  const description =
    input.description === undefined
      ? undefined
      : clipText(
          visibleText(input.description, "embed.description", { multiline: true }),
          DISCORD_LIMITS.embedDescription,
        );
  const fields = input.fields?.length ? buildFields(input.fields) : undefined;
  const footer =
    input.footer === undefined
      ? undefined
      : clipText(visibleText(input.footer, "embed.footer"), DISCORD_LIMITS.footer);
  const accent = assertFoilburyAccent(input.accent ?? FOILBURY_PALETTE.deepAqua);
  const image = input.image ? buildEmbedImage(input.image) : undefined;
  const timestamp =
    input.timestamp === undefined
      ? undefined
      : assertIsoTimestamp(input.timestamp, "embed.timestamp");

  const embed: DiscordEmbed = {
    title,
    ...(description ? { description } : {}),
    color: accent,
    ...(fields ? { fields } : {}),
    ...(footer ? { footer: { text: footer } } : {}),
    ...(timestamp ? { timestamp } : {}),
    ...(image ? { image } : {}),
  };

  const total = embedCharacterCount(embed);
  if (total > DISCORD_LIMITS.embedCharacters) {
    const fixed = total - (embed.description?.length ?? 0);
    const room = DISCORD_LIMITS.embedCharacters - fixed;
    const shrunk = clipText(
      embed.description ?? "",
      Math.min(DISCORD_LIMITS.embedDescription, room),
    );
    if (shrunk) embed.description = shrunk;
    else delete embed.description;
    if (embedCharacterCount(embed) > DISCORD_LIMITS.embedCharacters) {
      fail(
        "discord_limit",
        "embed",
        "The fixed title, fields and footer exceed Discord's 6000-character embed budget.",
      );
    }
  }
  assertDiscordEmbed(embed);
  return embed;
}

export interface ActionButtonInput {
  label: string;
  customId: string;
  style?: 1 | 2 | 3 | 4;
  disabled?: boolean;
}

export interface LinkButtonInput {
  label: string;
  url: string;
  disabled?: boolean;
}

export type ButtonInput = ActionButtonInput | LinkButtonInput;

export function assertCustomId(value: string, path = "button.custom_id"): string {
  const customId = value.trim();
  if (!/^foilbury:[a-z0-9:_-]+$/.test(customId)) {
    fail(
      "invalid_button",
      path,
      "Custom ids must start with foilbury: and use lowercase letters, digits, colons, underscores or hyphens.",
    );
  }
  if (customId.length > DISCORD_LIMITS.customId) {
    fail("discord_limit", path, "Discord custom ids may be at most 100 characters.");
  }
  return customId;
}

function buildButtonLabel(value: string): string {
  return clipText(visibleText(value, "button.label"), DISCORD_LIMITS.buttonLabel);
}

export function buildButton(input: ButtonInput): DiscordComponent {
  const label = buildButtonLabel(input.label);
  if ("url" in input) {
    return {
      type: 2,
      style: 5,
      label,
      url: assertPublicUrl(input.url, "button.url"),
      ...(input.disabled === true ? { disabled: true } : {}),
    };
  }
  const style = input.style ?? 2;
  if (![1, 2, 3, 4].includes(style)) {
    fail("invalid_button", "button.style", "Action buttons use styles 1 to 4.");
  }
  return {
    type: 2,
    style,
    label,
    custom_id: assertCustomId(input.customId),
    ...(input.disabled === true ? { disabled: true } : {}),
  };
}

export function buildActionRow(buttons: ButtonInput[]): {
  type: 1;
  components: DiscordComponent[];
} {
  if (buttons.length === 0) {
    fail("invalid_button", "components", "An action row needs at least one button.");
  }
  if (buttons.length > DISCORD_LIMITS.buttonsPerRow) {
    fail(
      "discord_limit",
      "components",
      `An action row may contain at most ${DISCORD_LIMITS.buttonsPerRow} buttons.`,
    );
  }
  return { type: 1, components: buttons.map(buildButton) };
}

export function buildActionRows(
  rows: ButtonInput[][],
): Array<{ type: 1; components: DiscordComponent[] }> {
  const nonEmpty = rows.filter((row) => row.length > 0);
  if (nonEmpty.length > DISCORD_LIMITS.componentRows) {
    fail(
      "discord_limit",
      "componentRows",
      `A message may contain at most ${DISCORD_LIMITS.componentRows} action rows.`,
    );
  }
  return nonEmpty.map(buildActionRow);
}

const IMAGE_MIME_EXTENSIONS: Record<string, string> = {
  "image/webp": "webp",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
};

function imageMime(value: string, path: string): { mime: string; extension: string } {
  const mime = value.split(";")[0]?.trim().toLowerCase() ?? "";
  const extension = IMAGE_MIME_EXTENSIONS[mime];
  if (!extension) {
    fail("unsafe_attachment", path, "Attachments must be a supported image type.");
  }
  return { mime, extension };
}

/**
 * Discord serves an attachment by its exact filename. A safe filename is a
 * hostile-name backstop, not a second attachment identity: the server-only R2
 * key never appears in the payload or the contact sheet.
 */
export function safeAttachmentFilename(name: string, contentType: string): string {
  const { extension } = imageMime(contentType, "attachment.contentType");
  const basename = name.trim().split(/[\\/]/).pop() ?? "";
  const withoutExtension = basename.replace(/\.[A-Za-z0-9]+$/, "");
  let stem = withoutExtension
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");
  const maxStem = DISCORD_LIMITS.attachmentFilename - extension.length - 1;
  if (!stem) stem = "card";
  if (!stem.startsWith("foilbury-")) stem = `foilbury-${stem}`;
  stem = stem.slice(0, maxStem).replace(/[-._]+$/g, "");
  if (!stem) stem = "foilbury-card";
  return `${stem}.${extension}`;
}

export function assertSafeAttachmentFilename(
  filename: string,
  contentType: string | undefined,
  path = "attachment.filename",
): string {
  if (
    !filename ||
    filename.length > DISCORD_LIMITS.attachmentFilename ||
    filename.includes("..") ||
    filename.includes("/") ||
    filename.includes("\\") ||
    !/^[a-z0-9][a-z0-9._-]*$/.test(filename) ||
    !/\.(?:webp|png|jpg|gif)$/.test(filename)
  ) {
    fail("unsafe_attachment", path, "Attachment filename must be a safe image basename.");
  }
  if (contentType) {
    const { extension } = imageMime(contentType, "attachment.contentType");
    if (!filename.endsWith(`.${extension}`)) {
      fail("unsafe_attachment", path, "Attachment extension does not match its content type.");
    }
  }
  return filename;
}

function assertR2Key(value: string): string {
  if (
    !value ||
    value.length > 512 ||
    value.includes("..") ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)
  ) {
    fail("unsafe_attachment", "attachment.r2Key", "Expected a safe server-side object key.");
  }
  return value;
}

export interface AttachmentInput {
  r2Key: string;
  contentType: string;
  filename?: string;
}

export function buildAttachment(input: AttachmentInput): DiscordAttachment {
  const { mime } = imageMime(input.contentType, "attachment.contentType");
  const filename = safeAttachmentFilename(input.filename ?? "foilbury-card", mime);
  return { r2Key: assertR2Key(input.r2Key), filename, contentType: mime };
}

export interface RenderAssetInput {
  r2Key: string;
  mime?: string;
  width?: number;
  height?: number;
}

export type CardAttachmentKind = "reveal" | "front" | "back" | "share";

const CARD_ATTACHMENT_STEM: Record<CardAttachmentKind, string> = {
  reveal: "foilbury-reveal-card",
  front: "foilbury-card-front",
  back: "foilbury-card-back",
  share: "foilbury-share",
};

export function cardAttachment(
  render: RenderAssetInput,
  kind: CardAttachmentKind,
): DiscordAttachment {
  return buildAttachment({
    r2Key: render.r2Key,
    contentType: render.mime ?? "image/webp",
    filename: CARD_ATTACHMENT_STEM[kind],
  });
}

function assertDiscordEmbed(embed: DiscordEmbed, path = "embed"): void {
  if (!embed.title || embed.title.length > DISCORD_LIMITS.embedTitle) {
    fail("discord_limit", `${path}.title`, "Embed titles need 1 to 256 characters.");
  }
  assertNoPrivateIdentifiers(embed.title, `${path}.title`);
  if (embed.description && embed.description.length > DISCORD_LIMITS.embedDescription) {
    fail(
      "discord_limit",
      `${path}.description`,
      "Embed descriptions may be at most 4096 characters.",
    );
  }
  if (embed.description) assertNoPrivateIdentifiers(embed.description, `${path}.description`);
  if (embed.fields && embed.fields.length > DISCORD_LIMITS.embedFields) {
    fail("discord_limit", `${path}.fields`, "An embed may contain at most 25 fields.");
  }
  let inlineCount = 0;
  for (const [index, field] of (embed.fields ?? []).entries()) {
    if (
      !field.name ||
      field.name.length > DISCORD_LIMITS.fieldName ||
      !field.value ||
      field.value.length > DISCORD_LIMITS.fieldValue
    ) {
      fail("discord_limit", `${path}.fields[${index}]`, "A field is outside Discord's limits.");
    }
    assertNoPrivateIdentifiers(field.name, `${path}.fields[${index}].name`);
    assertNoPrivateIdentifiers(field.value, `${path}.fields[${index}].value`);
    if (field.inline) inlineCount += 1;
  }
  if (inlineCount > DISCORD_LIMITS.inlineFields) {
    fail(
      "discord_limit",
      `${path}.fields`,
      `A Foilbury embed may present at most ${DISCORD_LIMITS.inlineFields} inline fields.`,
    );
  }
  if (embed.footer && (!embed.footer.text || embed.footer.text.length > DISCORD_LIMITS.footer)) {
    fail("discord_limit", `${path}.footer`, "Embed footers may be at most 2048 characters.");
  }
  if (embed.footer) assertNoPrivateIdentifiers(embed.footer.text, `${path}.footer`);
  if (embed.image) {
    const url = embed.image.url;
    if (url.startsWith("attachment://")) {
      assertSafeAttachmentFilename(
        url.slice("attachment://".length),
        undefined,
        `${path}.image.url`,
      );
    } else {
      assertPublicUrl(url, `${path}.image.url`);
    }
  }
  if (embedCharacterCount(embed) > DISCORD_LIMITS.embedCharacters) {
    fail("discord_limit", path, "The embed exceeds Discord's 6000-character budget.");
  }
}

function assertComponentRow(
  row: { type: number; components: DiscordComponent[] },
  index: number,
): void {
  if (
    row.type !== 1 ||
    row.components.length === 0 ||
    row.components.length > DISCORD_LIMITS.buttonsPerRow
  ) {
    fail(
      "discord_limit",
      `components[${index}]`,
      "Each action row needs 1 to 5 buttons and type 1.",
    );
  }
  row.components.forEach((component, componentIndex) => {
    const path = `components[${index}].components[${componentIndex}]`;
    if (component.type !== 2) {
      fail(
        "invalid_button",
        path,
        "Only button components are supported by this presentation layer.",
      );
    }
    if (!component.label || component.label.length > DISCORD_LIMITS.buttonLabel) {
      fail("discord_limit", `${path}.label`, "Button labels need 1 to 80 characters.");
    }
    if (!hasTextSemantics(component.label)) {
      fail("invalid_button", `${path}.label`, "Button labels need a word or number.");
    }
    assertNoPrivateIdentifiers(component.label, `${path}.label`);
    if (component.style === 5) {
      if (!component.url || component.custom_id) {
        fail("invalid_button", path, "Link buttons use a URL and no custom_id.");
      }
      assertPublicUrl(component.url, `${path}.url`, { allowResourceObjectIds: true });
      return;
    }
    if (!component.custom_id || component.url) {
      fail("invalid_button", path, "Action buttons use a custom_id and no URL.");
    }
    assertCustomId(component.custom_id, `${path}.custom_id`);
  });
}

export function assertDiscordMessage(message: DiscordMessage): void {
  if (message.content !== undefined) {
    if (message.content.length > DISCORD_LIMITS.messageContent) {
      fail("discord_limit", "content", "Message content may be at most 2000 characters.");
    }
    assertNoPrivateIdentifiers(message.content, "content");
  }
  if ((message.embeds?.length ?? 0) > DISCORD_LIMITS.embedsPerMessage) {
    fail("discord_limit", "embeds", "A message may contain at most 10 embeds.");
  }
  const embeds = message.embeds ?? [];
  let total = 0;
  for (const [index, embed] of embeds.entries()) {
    assertDiscordEmbed(embed, `embeds[${index}]`);
    total += embedCharacterCount(embed);
  }
  if (total > DISCORD_LIMITS.embedCharacters) {
    fail("discord_limit", "embeds", "The combined embeds exceed Discord's 6000-character budget.");
  }
  if ((message.components?.length ?? 0) > DISCORD_LIMITS.componentRows) {
    fail("discord_limit", "components", "A message may contain at most 5 action rows.");
  }
  const customIds = new Set<string>();
  (message.components ?? []).forEach((row, rowIndex) => {
    assertComponentRow(row, rowIndex);
    for (const [componentIndex, component] of row.components.entries()) {
      if (!component.custom_id) continue;
      if (customIds.has(component.custom_id)) {
        fail(
          "duplicate_custom_id",
          `components[${rowIndex}].components[${componentIndex}].custom_id`,
          `Discord rejects a message when the custom id ${component.custom_id} appears more than once, including across rows.`,
        );
      }
      customIds.add(component.custom_id);
    }
  });
  if (message.allowed_mentions) {
    if (
      message.allowed_mentions.parse.length > 0 ||
      (message.allowed_mentions.users?.length ?? 0) > 0 ||
      (message.allowed_mentions.roles?.length ?? 0) > 0
    ) {
      fail(
        "invalid_input",
        "allowed_mentions",
        "Foilbury never allows mentions in interaction replies.",
      );
    }
  }
}

export function assertDiscordAttachments(attachments: DiscordAttachment[]): void {
  const seen = new Set<string>();
  for (const [index, attachment] of attachments.entries()) {
    assertR2Key(attachment.r2Key);
    assertSafeAttachmentFilename(
      attachment.filename,
      attachment.contentType,
      `attachments[${index}].filename`,
    );
    if (seen.has(attachment.filename)) {
      fail(
        "unsafe_attachment",
        `attachments[${index}].filename`,
        "Attachment filenames must be unique.",
      );
    }
    seen.add(attachment.filename);
  }
}

function assertAttachmentReferences(
  embeds: DiscordEmbed[],
  attachments: DiscordAttachment[],
): void {
  const filenames = new Set(attachments.map((attachment) => attachment.filename));
  for (const embed of embeds) {
    const url = embed.image?.url;
    if (!url?.startsWith("attachment://")) continue;
    const filename = url.slice("attachment://".length);
    if (!filenames.has(filename)) {
      fail(
        "unsafe_attachment",
        "embed.image.url",
        "An attachment image reference must match a delivered attachment filename.",
      );
    }
  }
}

export interface BuildMessageInput {
  embed: EmbedInput;
  rows?: ButtonInput[][];
  attachments?: DiscordAttachment[];
  visibility?: "private" | "channel";
  audience?: Audience;
  channelAudience?: Audience;
  channelApproved?: boolean;
}

function resolveVisibility(input: BuildMessageInput): "private" | "channel" {
  if (input.visibility === "channel") {
    if (!canShareToChannel(input)) {
      fail(
        "channel_audience_unverified",
        "visibility",
        "A channel response needs a known non-private audience, a verified channel audience and explicit approval.",
      );
    }
    return "channel";
  }
  return "private";
}

export function buildMessage(input: BuildMessageInput): DiscordCallback {
  const embed = buildEmbed(input.embed);
  const rows = buildActionRows(input.rows ?? []);
  const attachments = input.attachments ?? [];
  assertDiscordAttachments(attachments);
  assertAttachmentReferences([embed], attachments);
  const visibility = resolveVisibility(input);
  const data: DiscordMessage = {
    embeds: [embed],
    ...(rows.length ? { components: rows } : {}),
    allowed_mentions: { parse: [] },
    ...(visibility === "private" ? { flags: 64 } : {}),
  };
  assertDiscordMessage(data);
  return {
    type: 4,
    data,
    ...(attachments.length ? { attachments } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Rating and reward vocabulary                                        */
/* ------------------------------------------------------------------ */

export function progressMeter(current: number, total: number): string {
  const safeTotal = Math.max(0, Math.floor(total));
  if (safeTotal === 0) return "No published subjects yet";
  const safeCurrent = Math.max(0, Math.min(Math.floor(current), safeTotal));
  const filled = Math.round((safeCurrent / safeTotal) * 10);
  const percent = Math.round((safeCurrent / safeTotal) * 100);
  return `${"█".repeat(filled)}${"░".repeat(10 - filled)} ${safeCurrent}/${safeTotal} (${percent}%)`;
}

function claimStatus(item: MissionProgressItem): string {
  if (item.claimed) return "Claimed";
  if (item.claimable)
    return item.claimCustomId ? "Ready to claim" : "Complete · claim on the website";
  if (item.complete) return "Complete · claim on the website";
  return `${Math.max(0, Math.min(item.progress, item.target))}/${item.target}`;
}

/* ------------------------------------------------------------------ */
/* Template: welcome / getting started                                 */
/* ------------------------------------------------------------------ */

export interface WelcomeInput {
  displayName: string;
  scopeName: string;
  balance: number;
  currencySymbol: string;
  dailyAvailable: boolean;
  nextDailyAt?: string | null;
  starterGrant?: number;
  dailyReward?: number;
  guide?: string;
  actions: { daily: string; open: string; packs: string };
  helpUrl: string;
}

export function welcomeMessage(input: WelcomeInput): DiscordCallback {
  const displayName = visibleText(input.displayName, "displayName");
  const scopeName = visibleText(input.scopeName, "scopeName");
  const balance = assertNonNegative(input.balance, "balance");
  const symbol = assertCurrencySymbol(input.currencySymbol);
  const daily =
    input.dailyAvailable || !input.nextDailyAt
      ? "Ready now"
      : formatDiscordTimestamp(input.nextDailyAt);
  const firstRun =
    input.starterGrant !== undefined || input.dailyReward !== undefined
      ? [
          input.starterGrant !== undefined
            ? `+${assertNonNegative(input.starterGrant, "starterGrant")} ${symbol} once.`
            : "",
          input.dailyReward !== undefined
            ? `${assertNonNegative(input.dailyReward, "dailyReward")} ${symbol} every day, shared by this Bot across Discord, the website and the API.`
            : "",
        ]
          .filter(Boolean)
          .join(" ")
      : "Claim the free allowance, choose a capsule and keep the copy. Nothing is charged until you press an open button.";
  return buildMessage({
    visibility: "private",
    embed: {
      title: "Welcome to Foilbury",
      description: `**Welcome, ${displayName}.** A collector's cabinet in **${scopeName}**. Claim the free allowance, choose a capsule, and keep the copy. Nothing is charged until you press an open button.`,
      accent: FOILBURY_PALETTE.electricAqua,
      fields: [
        { name: "Your balance", value: `${balance} ${symbol}`, inline: true },
        { name: "Daily allowance", value: daily, inline: true },
        { name: "First run", value: firstRun, inline: false },
        {
          name: "Free to look",
          value:
            "Inspect either face, open your album and read every detail without spending Foil or receiving another copy.",
          inline: false,
        },
        ...(input.guide
          ? [{ name: "Commands", value: clipText(input.guide, 1000), inline: false }]
          : []),
      ],
      footer: `Foilbury · ${scopeName} · private response`,
    },
    rows: [
      [
        { label: "Claim daily", customId: input.actions.daily, style: 1 },
        { label: "Open a capsule", customId: input.actions.open, style: 1 },
        { label: "Browse capsules", customId: input.actions.packs, style: 2 },
      ],
      [{ label: "Read the field guide", url: input.helpUrl }],
    ],
  });
}

/* ------------------------------------------------------------------ */
/* Template: daily allowance                                           */
/* ------------------------------------------------------------------ */

export interface DailyClaimInput {
  amount: number;
  currencySymbol: string;
  balanceAfter: number;
  nextEligibleAt: string;
  replayed: boolean;
  scopeName: string;
  openCustomId: string;
  packsCustomId: string;
}

export function dailyClaimMessage(input: DailyClaimInput): DiscordCallback {
  const amount = assertNonNegative(input.amount, "amount");
  const symbol = assertCurrencySymbol(input.currencySymbol);
  const balance = assertNonNegative(input.balanceAfter, "balanceAfter");
  const next = assertIsoTimestamp(input.nextEligibleAt, "nextEligibleAt");
  return buildMessage({
    visibility: "private",
    embed: {
      title: input.replayed ? "Allowance already claimed" : "Daily allowance claimed",
      description: input.replayed
        ? "This is the recorded result of the original request. No second credit was made."
        : "The allowance is shared by this Bot across Discord, the website and the API.",
      accent: FOILBURY_PALETTE.lime,
      fields: [
        { name: "Credited", value: `+${amount} ${symbol}`, inline: true },
        { name: "Settled balance", value: `${balance} ${symbol}`, inline: true },
        { name: "Next allowance", value: formatDiscordTimestamp(next), inline: true },
        {
          name: "Reset policy",
          value: "Daily, shared for this Bot across servers, website and API. Periods use UTC.",
          inline: false,
        },
      ],
      footer: `Foilbury · ${visibleText(input.scopeName, "scopeName")} · one credit per period`,
    },
    rows: [
      [
        { label: "Open a capsule", customId: input.openCustomId, style: 1 },
        { label: "Packs", customId: input.packsCustomId, style: 2 },
      ],
    ],
  });
}

/* ------------------------------------------------------------------ */
/* Template: capsule picker                                            */
/* ------------------------------------------------------------------ */

export interface CapsuleOdds {
  label: string;
  probabilityBps: number;
}

export interface CapsuleChoice {
  slug: string;
  name: string;
  price: number;
  eligibleCount: number;
  odds?: CapsuleOdds[];
  disabled?: boolean;
  unavailableReason?: string;
}

export interface CapsulePickerInput {
  scopeName: string;
  currencySymbol: string;
  balance: number;
  capsules: CapsuleChoice[];
  openIdPrefix?: string;
  browseUrl?: string;
  packsCustomId?: string;
}

function assertPoolSlug(value: string, path: string): string {
  if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(value)) {
    fail("invalid_input", path, "Expected a lowercase capsule slug.");
  }
  return value;
}

function capsuleFieldValue(choice: CapsuleChoice, symbol: string): string {
  const price = assertNonNegative(choice.price, "capsule.price");
  const eligible = assertNonNegative(choice.eligibleCount, "capsule.eligibleCount");
  const lines = [`${price} ${symbol} · ${eligible} eligible card${eligible === 1 ? "" : "s"}`];
  if (choice.odds?.length) {
    const odds = choice.odds
      .slice(0, 4)
      .map((entry) => {
        const bps = assertNonNegative(entry.probabilityBps, "capsule.odds");
        if (bps > 10000) fail("invalid_input", "capsule.odds", "Odds must use basis points.");
        return `${visibleText(entry.label, "capsule.odds.label")} ${(bps / 100).toFixed(2)}%`;
      })
      .join(" · ");
    lines.push(`Odds: ${odds}`);
  }
  if (choice.disabled)
    lines.push(choice.unavailableReason ? choice.unavailableReason : "Unavailable right now.");
  return lines.join("\n");
}

export function capsulePickerMessage(input: CapsulePickerInput): DiscordCallback {
  const scopeName = visibleText(input.scopeName, "scopeName");
  const symbol = assertCurrencySymbol(input.currencySymbol);
  const balance = assertNonNegative(input.balance, "balance");
  const prefix = input.openIdPrefix ?? "foilbury:open:";
  if (!/^foilbury:[a-z0-9:_-]*:$/.test(prefix)) {
    fail(
      "invalid_button",
      "openIdPrefix",
      "The open id prefix must start with foilbury: and end with a colon.",
    );
  }
  const capsules = input.capsules.map((choice) => ({
    ...choice,
    slug: assertPoolSlug(choice.slug, "capsule.slug"),
    name: visibleText(choice.name, "capsule.name"),
  }));
  if (capsules.length === 0) {
    return stateMessage({
      kind: "empty",
      title: "No capsule is ready",
      message:
        "No capsule pool has eligible cards for this account right now. Viewing a picker never charges Foil, and no card was awarded.",
      nextStep: "Claim the daily allowance, then try again after the pool refresh.",
      ...(input.browseUrl ? { helpUrl: input.browseUrl } : {}),
    });
  }
  const shown = capsules.slice(0, DISCORD_LIMITS.inlineFields);
  const buttons: ButtonInput[] = shown.map((choice, index) => ({
    label: `Open ${choice.name} · ${choice.price} ${symbol}`,
    customId: `${prefix}${choice.slug}`,
    style: index === 0 ? 1 : 2,
    disabled: choice.disabled === true,
  }));
  const rows: ButtonInput[][] = [buttons];
  if (capsules.length > shown.length || input.browseUrl || input.packsCustomId) {
    const row: ButtonInput[] = [];
    if (input.packsCustomId) {
      row.push({ label: "Browse all capsules", customId: input.packsCustomId, style: 2 });
    }
    if (input.browseUrl) row.push({ label: "Open the cabinet", url: input.browseUrl });
    if (row.length) rows.push(row);
  }
  return buildMessage({
    visibility: "private",
    embed: {
      title: "Choose a capsule",
      description:
        "Each capsule shows its ordinary price and the real odds of its eligible cards. Viewing this picker charges nothing; opening spends the listed price only when you press an open button.",
      accent: FOILBURY_PALETTE.electricAqua,
      fields: [
        ...shown.map((choice) => ({
          name: choice.name,
          value: capsuleFieldValue(choice, symbol),
          inline: false,
        })),
        { name: "Your balance", value: `${balance} ${symbol}`, inline: true },
        { name: "Charged on press", value: "Only the listed capsule price", inline: true },
      ],
      footer: `${Math.min(shown.length, capsules.length)} of ${capsules.length} capsules · viewing is free · ${scopeName}`,
    },
    rows,
  });
}

/* ------------------------------------------------------------------ */
/* Template: reveal receipt                                            */
/* ------------------------------------------------------------------ */

/**
 * The first fifteen fields are intentionally identical to the committed
 * Discord draw receipt in commands.ts. The builder consumes every one of them;
 * card_id and variant_id are used only in the opaque button custom_id, never in
 * visible copy.
 */
export const REVEAL_RECEIPT_FIELDS = [
  "card_id",
  "variant_id",
  "card_name",
  "variant_name",
  "material_key",
  "effect_key",
  "render_url",
  "serial",
  "pool_name",
  "price",
  "currency",
  "balance_after",
  "probability_bps",
  "drawn_at",
  "replayed",
] as const;

export type RevealReceiptField = (typeof REVEAL_RECEIPT_FIELDS)[number];

export interface RevealReceiptDomainFields {
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

export interface RevealReceiptInput extends RevealReceiptDomainFields {
  rarity_name?: string | null;
  scope_name?: string;
  audience: Audience;
  channel_audience?: Audience;
  channel_approved?: boolean;
  render?: RenderAssetInput | null;
  open_custom_id: string;
  collection_custom_id?: string;
  tour_custom_id?: string;
  album_url?: string;
  public_origin?: string;
  /** The reveal acknowledgement is private even when a share is permitted. */
  force_private?: boolean;
  share_custom_id?: string;
  balance_after_debit?: number;
  credits_total?: number;
  achievement_credits?: Array<{ name: string; amount: number }>;
}

function publicRenderUrl(input: RevealReceiptInput): string | undefined {
  if (input.audience !== "public" || !input.render_url) return undefined;
  const raw = input.render_url.trim();
  if (/^https:\/\//i.test(raw)) return assertPublicUrl(raw, "render_url");
  if (raw.startsWith("/") && input.public_origin) {
    return assertPublicUrl(`${input.public_origin.replace(/\/$/, "")}${raw}`, "render_url");
  }
  return undefined;
}

export function revealReceiptMessage(input: RevealReceiptInput): DiscordCallback {
  const cardName = visibleText(input.card_name, "card_name");
  const poolName = visibleText(input.pool_name, "pool_name");
  const serial = visibleText(input.serial, "serial");
  const symbol = assertCurrencySymbol(input.currency.symbol);
  const price = assertNonNegative(input.price, "price");
  const balance = assertNonNegative(input.balance_after, "balance_after");
  const probability = assertNonNegative(input.probability_bps, "probability_bps");
  if (probability > 10000) fail("invalid_input", "probability_bps", "Odds must use basis points.");
  const drawnAt = assertIsoTimestamp(input.drawn_at, "drawn_at");
  const finish = displayFinish(input.variant_name, input.material_key, input.effect_key);
  const canShare = canShareToChannel({
    audience: input.audience,
    channelAudience: input.channel_audience,
    channelApproved: input.channel_approved,
  });
  const attachment = input.render ? cardAttachment(input.render, "reveal") : null;
  const fallbackImage = publicRenderUrl(input);
  const debitBalance =
    input.balance_after_debit === undefined
      ? null
      : assertNonNegative(input.balance_after_debit, "balance_after_debit");
  const credits = input.credits_total === undefined ? 0 : assertNonNegative(input.credits_total, "credits_total");
  const fields: FieldInput[] = [
    { name: "Rarity", value: input.rarity_name || "Unclassified", inline: true },
    { name: "Finish", value: finish, inline: true },
    { name: "Serial", value: `\`${serial}\``, inline: true },
    { name: "Opened from", value: `${poolName} · ${price} ${symbol}`, inline: true },
    { name: "Opening debit", value: `−${price} ${symbol}`, inline: true },
    ...(debitBalance === null
      ? []
      : [{ name: "After debit", value: `${debitBalance} ${symbol}`, inline: true }]),
    ...(credits > 0
      ? [
          {
            name: "Reward credited",
            value: `+${credits} ${symbol}${
              input.achievement_credits?.length
                ? ` · ${input.achievement_credits.map((item) => item.name).join(", ")}`
                : ""
            }`,
            inline: false,
          },
        ]
      : []),
    { name: "Settled balance", value: `${balance} ${symbol}`, inline: true },
    { name: "Odds", value: `${(probability / 100).toFixed(2)}% for this copy`, inline: false },
  ];
  if (!canShare) {
    fields.push({
      name: "Private reveal",
      value:
        input.audience === "private"
          ? "This collection is private. The copy is yours, but the artwork stays visible only to you."
          : "This channel has not been verified for the card's audience, so the artwork stays visible only to you.",
      inline: false,
    });
  }
  if (input.replayed) {
    fields.push({
      name: "Recorded result",
      value:
        "This is the committed result of the original interaction. No second pull, ledger entry or copy was made.",
      inline: false,
    });
  }
  if (!attachment && !fallbackImage) {
    fields.push({
      name: "Artwork follow-up",
      value:
        "The saved render is not attached to this message. Your copy and serial are committed; open your album to view the saved artwork, or ask a Bot Admin to check the render job.",
      inline: false,
    });
  }
  const rows: ButtonInput[][] = [
    [
      { label: "Open again", customId: input.open_custom_id, style: 1 },
      ...(input.collection_custom_id
        ? [{ label: "Collection", customId: input.collection_custom_id, style: 2 } as ButtonInput]
        : []),
      ...(input.tour_custom_id
        ? [{ label: "Tour", customId: input.tour_custom_id, style: 2 } as ButtonInput]
        : []),
      ...(input.album_url ? [{ label: "Open album", url: input.album_url } as ButtonInput] : []),
    ],
  ];
  if (canShare && input.share_custom_id) {
    rows.push([
      { label: "Share to channel", customId: input.share_custom_id, style: 1 },
    ]);
  }
  return buildMessage({
    visibility: input.force_private === true ? "private" : canShare ? "channel" : "private",
    audience: input.audience,
    channelAudience: input.channel_audience,
    channelApproved: input.channel_approved,
    attachments: attachment ? [attachment] : [],
    embed: {
      title: `${cardName} — ${finish}`,
      description: input.replayed
        ? `Recorded from **${poolName}**. **Open again** spends Foil on a new pull.`
        : `From **${poolName}**. This copy is in your cabinet. **Open again** spends Foil on a new pull.`,
      accent: FOILBURY_PALETTE.albumSage,
      fields,
      footer: `Foilbury${input.scope_name ? ` · ${visibleText(input.scope_name, "scope_name")}` : ""}`,
      timestamp: drawnAt,
      ...(attachment
        ? {
            image: {
              attachment: attachment.filename,
              ...(input.render?.width !== undefined && input.render?.height !== undefined
                ? { width: input.render.width, height: input.render.height }
                : {}),
            },
          }
        : fallbackImage
          ? { image: { url: fallbackImage } }
          : {}),
    },
    rows,
  });
}

/* ------------------------------------------------------------------ */
/* Template: cabinet overview                                          */
/* ------------------------------------------------------------------ */

export interface CabinetItem {
  name: string;
  print?: string | null;
  variant: string;
  rarity?: string | null;
  serial: string;
}

export interface CabinetSummaryInput {
  scopeName: string;
  currencySymbol: string;
  balance: number;
  owned: number;
  unique: number;
  duplicates: number;
  items: CabinetItem[];
  albumUrl: string;
  openCustomId: string;
  packsCustomId: string;
  /** Optional truthful note when historical copies are outside this server's current scope. */
  scopeNotice?: string | null;
}

export function cabinetSummaryMessage(input: CabinetSummaryInput): DiscordCallback {
  const symbol = assertCurrencySymbol(input.currencySymbol);
  const owned = assertNonNegative(input.owned, "owned");
  const unique = assertNonNegative(input.unique, "unique");
  const duplicates = assertNonNegative(input.duplicates, "duplicates");
  const items = input.items.slice(0, 8).map((item) => ({
    name: visibleText(item.name, "cabinet.item.name"),
    print: item.print ? visibleText(item.print, "cabinet.item.print", { required: false }) : null,
    variant: visibleText(item.variant, "cabinet.item.variant"),
    rarity: item.rarity ? visibleText(item.rarity, "cabinet.item.rarity", { required: false }) : null,
    serial: visibleText(item.serial, "cabinet.item.serial"),
  }));
  return buildMessage({
    visibility: "private",
    embed: {
      title: input.owned === 0 ? "Your cabinet is empty" : "Your cabinet",
      description:
        input.owned === 0
          ? "Claim the daily allowance, then open a capsule. Your cards are tied to this Bot and appear on every server where it is installed."
          : `${items
              .map(
                (item) =>
                  `• **${item.name}**${item.print ? ` — ${item.print}` : ""} · ${item.variant}${item.rarity ? ` · ${item.rarity}` : ""} · \`${item.serial}\``,
              )
              .join("\n")}${input.scopeNotice ? `\n\n${visibleText(input.scopeNotice, "cabinet.scopeNotice")}` : ""}`,
      accent: FOILBURY_PALETTE.deepAqua,
      fields: [
        { name: "Owned", value: String(owned), inline: true },
        { name: "Unique", value: String(unique), inline: true },
        { name: "Duplicates", value: String(duplicates), inline: true },
        { name: "Balance", value: `${assertNonNegative(input.balance, "balance")} ${symbol}`, inline: true },
        { name: "Scope", value: visibleText(input.scopeName, "scopeName"), inline: true },
        {
          name: "More",
          value:
            "Open the website cabinet for filters, favourites and full provenance. Viewing a card never spends Foil or awards another copy.",
          inline: false,
        },
      ],
      footer:
        input.owned > items.length
          ? `Showing ${items.length} of ${owned} copies · private response`
          : "Private response · viewing never spends Foil",
    },
    rows: [
      [
        { label: "Open a capsule", customId: input.openCustomId, style: 1 },
        { label: "Packs", customId: input.packsCustomId, style: 2 },
        { label: "Open cabinet on the web", url: input.albumUrl },
      ],
    ],
  });
}

/* ------------------------------------------------------------------ */
/* Template: card front / back                                         */
/* ------------------------------------------------------------------ */

export interface CardFaceInput {
  cardName: string;
  variantName: string;
  materialKey: string;
  effectKey: string | null;
  side: "front" | "back";
  description: string;
  collectionName: string;
  source: string;
  serial?: string | null;
  rarityName?: string | null;
  render: RenderAssetInput;
  swapCustomId: string;
  detailsCustomId: string;
  albumUrl: string;
}

export function cardFaceMessage(input: CardFaceInput): DiscordCallback {
  const cardName = visibleText(input.cardName, "cardName");
  const finish = displayFinish(input.variantName, input.materialKey, input.effectKey);
  const side = input.side === "front" ? "Front" : "Back";
  const attachment = cardAttachment(input.render, input.side);
  const fields: FieldInput[] = [
    { name: "Collection", value: input.collectionName, inline: true },
    { name: "Side", value: side, inline: true },
    { name: "Finish", value: finish, inline: true },
  ];
  if (input.rarityName) fields.push({ name: "Rarity", value: input.rarityName, inline: true });
  if (input.serial) fields.push({ name: "Serial", value: `\`${input.serial}\``, inline: true });
  fields.push({ name: "Source", value: input.source, inline: false });
  return buildMessage({
    visibility: "private",
    attachments: [attachment],
    embed: {
      title: `${cardName} — ${finish}`,
      description: input.description,
      accent: FOILBURY_PALETTE.deepAqua,
      fields,
      footer: "Private member view · viewing never spends Foil or awards another copy",
      ...(input.render.width !== undefined && input.render.height !== undefined
        ? {
            image: {
              attachment: attachment.filename,
              width: input.render.width,
              height: input.render.height,
            },
          }
        : { image: { attachment: attachment.filename } }),
    },
    rows: [
      [
        {
          label: input.side === "front" ? "View back" : "View front",
          customId: input.swapCustomId,
          style: 2,
        },
        { label: "Details", customId: input.detailsCustomId, style: 2 },
        { label: "Open my album", url: input.albumUrl },
      ],
    ],
  });
}

/* ------------------------------------------------------------------ */
/* Template: album progress                                            */
/* ------------------------------------------------------------------ */

export interface AlbumProgressInput {
  albumName: string;
  scopeName: string;
  ownedCards: number;
  totalCards: number;
  missing?: string[];
  variantTotal?: number;
  finishProgress?: Array<{ label: string; owned: number; total: number }>;
  awardName?: string | null;
  audience: Audience;
  albumUrl: string;
  canShareCompletion?: boolean;
  shareCustomId?: string;
  browseCustomId?: string;
}

export function albumProgressMessage(input: AlbumProgressInput): DiscordCallback {
  const albumName = visibleText(input.albumName, "albumName");
  const scopeName = visibleText(input.scopeName, "scopeName");
  const total = assertNonNegative(input.totalCards, "totalCards");
  const owned = Math.max(0, Math.min(assertNonNegative(input.ownedCards, "ownedCards"), total));
  const complete = total > 0 && owned >= total;
  const missing = (input.missing ?? []).map((name) => visibleText(name, "missing"));
  const share =
    complete &&
    input.canShareCompletion === true &&
    input.audience !== "private" &&
    Boolean(input.shareCustomId);
  const fields: FieldInput[] = [
    {
      name: "Progress",
      value: complete ? `Complete · ${progressMeter(owned, total)}` : progressMeter(owned, total),
      inline: true,
    },
    {
      name: "Next target",
      value: complete
        ? "Every published subject is in your cabinet."
        : missing.length
          ? `Next: **${missing[0]}**${missing.length > 1 ? ` · ${missing.length - 1} more missing` : ""}`
          : "Open a capsule to add the first subject.",
      inline: true,
    },
    {
      name: "Audience",
      value: `${audienceLabel(input.audience)} · sharing is a separate, explicit action`,
      inline: true,
    },
  ];
  if (input.finishProgress?.length) {
    fields.push({
      name: "Finish families",
      value: input.finishProgress
        .slice(0, 4)
        .map(
          (entry) =>
            `${visibleText(entry.label, "finishProgress.label")} · ${entry.owned}/${entry.total}`,
        )
        .join("\n"),
      inline: false,
    });
  }
  fields.push({
    name: "Milestone",
    value: input.awardName
      ? `**${visibleText(input.awardName, "awardName")}** is the completion milestone. It unlocks once when the album reaches ${total}/${total}.`
      : "No completion award is configured for this album.",
    inline: false,
  });
  if (input.variantTotal !== undefined) {
    fields.push({
      name: "Published variants",
      value: String(assertNonNegative(input.variantTotal, "variantTotal")),
      inline: true,
    });
  }
  const rows: ButtonInput[][] = [
    [
      { label: "Open album", url: input.albumUrl },
      ...(input.browseCustomId
        ? [{ label: "Browse missing", customId: input.browseCustomId, style: 2 } as ButtonInput]
        : []),
      ...(share && input.shareCustomId
        ? [{ label: "Share completion", customId: input.shareCustomId, style: 1 } as ButtonInput]
        : []),
    ],
  ];
  return buildMessage({
    visibility: "private",
    embed: {
      title: complete ? `${albumName} · complete` : `${albumName} · ${owned}/${total}`,
      description: complete
        ? `**${albumName} is complete.** Every published subject is in your cabinet. Viewing or sharing this summary never grants another copy.`
        : total === 0
          ? "This album has no published subjects yet. Nothing is missing and nothing is awarded until the roster is published."
          : `**${owned}/${total} unique subjects.** Missing binder slots are listed by name; finish mastery is tracked separately from roster completion.`,
      accent: complete ? FOILBURY_PALETTE.lime : FOILBURY_PALETTE.electricAqua,
      fields,
      footer: `${scopeName} · unique subjects, not finish mastery · no card was granted by viewing`,
    },
    rows,
  });
}

/* ------------------------------------------------------------------ */
/* Template: achievement                                               */
/* ------------------------------------------------------------------ */

export interface AchievementInput {
  name: string;
  description: string;
  state: "earned" | "in_progress" | "locked";
  progress: number;
  target: number;
  reward?: number | null;
  currencySymbol: string;
  audience: Audience;
  earnedAt?: string | null;
  criteria?: string;
  albumUrl?: string;
  shareEligible?: boolean;
  shareCustomId?: string;
}

export function achievementMessage(input: AchievementInput): DiscordCallback {
  const name = visibleText(input.name, "achievement.name");
  const target = assertNonNegative(input.target, "achievement.target");
  if (target <= 0) fail("invalid_input", "achievement.target", "An achievement needs a target.");
  const progress = Math.max(
    0,
    Math.min(assertNonNegative(input.progress, "achievement.progress"), target),
  );
  const symbol = assertCurrencySymbol(input.currencySymbol);
  const state =
    input.state === "earned" ? "Earned" : input.state === "locked" ? "Locked" : "In progress";
  const share =
    input.state === "earned" &&
    input.shareEligible === true &&
    input.audience !== "private" &&
    Boolean(input.shareCustomId);
  const fields: FieldInput[] = [
    { name: "Status", value: state, inline: true },
    { name: "Progress", value: `${progress}/${target}`, inline: true },
    {
      name: "Reward",
      value: input.reward
        ? `+${assertNonNegative(input.reward, "achievement.reward")} ${symbol}`
        : "Badge only",
      inline: true,
    },
    {
      name: "Visibility",
      value:
        input.audience === "private"
          ? "Private · not shareable"
          : `${audienceLabel(input.audience)} · share requires explicit action`,
      inline: true,
    },
    {
      name: "Earned",
      value: input.earnedAt ? formatDiscordTimestamp(input.earnedAt) : "Not yet earned",
      inline: true,
    },
    {
      name: "Criteria",
      value: input.criteria ?? "Criteria come from the versioned achievement definition.",
      inline: false,
    },
  ];
  const rows: ButtonInput[][] = [
    [
      ...(share && input.shareCustomId
        ? [{ label: "Share achievement", customId: input.shareCustomId, style: 1 } as ButtonInput]
        : []),
      ...(input.albumUrl
        ? [{ label: "Open achievements", url: input.albumUrl } as ButtonInput]
        : []),
    ],
  ];
  return buildMessage({
    visibility: "private",
    embed: {
      title: name,
      description: input.description,
      accent:
        input.state === "earned"
          ? FOILBURY_PALETTE.lime
          : input.state === "locked"
            ? FOILBURY_PALETTE.ice
            : FOILBURY_PALETTE.electricAqua,
      fields,
      footer: "Earned badges are never removed. Rewards are credited once.",
    },
    rows,
  });
}

/* ------------------------------------------------------------------ */
/* Template: achievements overview                                     */
/* ------------------------------------------------------------------ */

export interface AchievementOverviewItem {
  name: string;
  state: "earned" | "in_progress" | "locked";
  progress: number;
  target: number;
  reward: number;
}

export interface AchievementsOverviewInput {
  currencySymbol: string;
  items: AchievementOverviewItem[];
  achievementsUrl: string;
}

export function achievementsOverviewMessage(
  input: AchievementsOverviewInput,
): DiscordCallback {
  const symbol = assertCurrencySymbol(input.currencySymbol);
  const items = input.items.map((item) => ({
    ...item,
    name: visibleText(item.name, "achievement.name"),
    target: assertNonNegative(item.target, "achievement.target"),
    progress: assertNonNegative(item.progress, "achievement.progress"),
    reward: assertNonNegative(item.reward, "achievement.reward"),
  }));
  const earned = items.filter((item) => item.state === "earned");
  const close = items
    .filter((item) => item.state !== "earned")
    .sort(
      (left, right) =>
        right.progress / Math.max(1, right.target) - left.progress / Math.max(1, left.target),
    )
    .slice(0, 5);
  return buildMessage({
    visibility: "private",
    embed: {
      title: "Achievements",
      description: earned.length
        ? `You have earned **${earned.length}** of ${items.length}. Rewards are credited once and never removed when a collection grows.`
        : "Your first card is the first badge. Every milestone below uses your committed collection history.",
      accent: FOILBURY_PALETTE.lime,
      fields: [
        {
          name: "Earned",
          value: earned.length
            ? earned
                .slice(0, 8)
                .map(
                  (item) =>
                    `• **${item.name}** — ${item.reward ? `+${item.reward} ${symbol}` : "badge"}`,
                )
                .join("\n")
            : "No badges yet. Viewing the catalogue does not earn one.",
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
      footer: "Open the website album for full progress, criteria and earned dates",
    },
    rows: [[{ label: "Open achievements", url: input.achievementsUrl }]],
  });
}

/* ------------------------------------------------------------------ */
/* Template: daily missions                                            */
/* ------------------------------------------------------------------ */

export interface MissionProgressItem {
  key: string;
  title: string;
  description: string;
  progress: number;
  target: number;
  reward: number;
  complete: boolean;
  claimed: boolean;
  claimable: boolean;
  claimCustomId?: string;
}

export interface MissionProgressInput {
  day: string;
  resetAt: string;
  cap: number;
  earnedToday: number;
  currencySymbol: string;
  missions: MissionProgressItem[];
  notice?: string;
  refreshCustomId?: string;
  missionsUrl?: string;
}

export function missionProgressMessage(input: MissionProgressInput): DiscordCallback {
  const symbol = assertCurrencySymbol(input.currencySymbol);
  const cap = assertNonNegative(input.cap, "cap");
  const earned = assertNonNegative(input.earnedToday, "earnedToday");
  const resetAt = assertIsoTimestamp(input.resetAt, "resetAt");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.day)) {
    fail("invalid_input", "day", "Mission day must use YYYY-MM-DD.");
  }
  const missions = input.missions.map((mission) => {
    const target = assertNonNegative(mission.target, "mission.target");
    if (target <= 0) fail("invalid_input", "mission.target", "A mission needs a target.");
    return {
      ...mission,
      title: visibleText(mission.title, "mission.title"),
      description: visibleText(mission.description, "mission.description", { multiline: true }),
      target,
      progress: Math.max(
        0,
        Math.min(assertNonNegative(mission.progress, "mission.progress"), target),
      ),
      reward: assertNonNegative(mission.reward, "mission.reward"),
    };
  });
  if (missions.length === 0) {
    return stateMessage({
      kind: "empty",
      title: "No missions assigned today",
      message:
        "Daily missions are optional and use real album activity. Nothing is lost by waiting, and no purchase is required.",
      nextStep: "Claim the daily allowance or open a capsule when you are ready.",
      ...(input.missionsUrl ? { helpUrl: input.missionsUrl } : {}),
    });
  }
  const claimable = missions
    .slice(0, 5)
    .filter((mission) => mission.claimable && !mission.claimed && mission.claimCustomId)
    .slice(0, 4);
  const allSettled = missions.every((mission) => mission.claimed);
  const rows: ButtonInput[][] = [];
  if (claimable.length) {
    rows.push(
      claimable.map((mission) => ({
        label: `Claim ${mission.title} · +${mission.reward} ${symbol}`,
        customId: mission.claimCustomId as string,
        style: 1,
      })),
    );
  }
  const nav: ButtonInput[] = [];
  if (input.refreshCustomId)
    nav.push({ label: "Refresh missions", customId: input.refreshCustomId, style: 2 });
  if (input.missionsUrl) nav.push({ label: "Open missions on the web", url: input.missionsUrl });
  if (nav.length) rows.push(nav);
  return buildMessage({
    visibility: "private",
    embed: {
      title: "Daily missions",
      description: [
        input.notice ? `**${visibleText(input.notice, "notice")}**\n` : "",
        `Earned today **${earned}/${cap} ${symbol}**. Reset ${formatDiscordTimestamp(resetAt)} · ${input.day} UTC. Missions use the same wallet and ledger as the website.`,
      ]
        .filter(Boolean)
        .join("\n"),
      accent: allSettled ? FOILBURY_PALETTE.lime : FOILBURY_PALETTE.electricAqua,
      fields: [
        ...missions.slice(0, 5).map((mission) => ({
          name: `${mission.title} · +${mission.reward} ${symbol}`,
          value: `${mission.description}\n**${claimStatus(mission)}**`,
          inline: false,
        })),
        { name: "Daily cap", value: `${earned}/${cap} ${symbol}`, inline: true },
        { name: "Assignment", value: `${missions.length} missions · optional`, inline: true },
      ],
      footer: "Optional · no purchase · no streak penalty",
    },
    rows,
  });
}

/* ------------------------------------------------------------------ */
/* Template: collector profile                                         */
/* ------------------------------------------------------------------ */

export interface ProfileInput {
  displayName: string;
  scopeName: string;
  currencySymbol: string;
  balance: number;
  ownedCards: number;
  uniqueCards?: number;
  dailyAvailable: boolean;
  nextDailyAt?: string | null;
  achievementsEarned?: number;
  publicBadgeCount?: number;
  isBotAdmin?: boolean;
  profileUrl: string;
  dailyCustomId?: string;
  collectionCustomId?: string;
}

export function profileMessage(input: ProfileInput): DiscordCallback {
  const displayName = visibleText(input.displayName, "displayName");
  const scopeName = visibleText(input.scopeName, "scopeName");
  const symbol = assertCurrencySymbol(input.currencySymbol);
  const daily =
    input.dailyAvailable || !input.nextDailyAt
      ? "Ready now"
      : formatDiscordTimestamp(input.nextDailyAt);
  const fields: FieldInput[] = [
    {
      name: "Balance",
      value: `${assertNonNegative(input.balance, "balance")} ${symbol}`,
      inline: true,
    },
    {
      name: "Owned cards",
      value: String(assertNonNegative(input.ownedCards, "ownedCards")),
      inline: true,
    },
  ];
  if (input.uniqueCards !== undefined) {
    fields.push({
      name: "Unique cards",
      value: String(assertNonNegative(input.uniqueCards, "uniqueCards")),
      inline: true,
    });
  }
  fields.push({ name: "Daily", value: daily, inline: true });
  if (input.achievementsEarned !== undefined) {
    fields.push({
      name: "Badges",
      value: `${assertNonNegative(input.achievementsEarned, "achievementsEarned")} earned${input.publicBadgeCount !== undefined ? ` · ${assertNonNegative(input.publicBadgeCount, "publicBadgeCount")} public` : ""}`,
      inline: true,
    });
  }
  fields.push({ name: "Inventory scope", value: "This Bot across every server", inline: false });
  fields.push({
    name: "Privacy",
    value:
      "This response is private. Public profile sharing is separate, explicit and limited to approved counts.",
    inline: false,
  });
  const rows: ButtonInput[][] = [
    [
      ...(input.dailyCustomId
        ? [{ label: "Daily", customId: input.dailyCustomId, style: 2 } as ButtonInput]
        : []),
      ...(input.collectionCustomId
        ? [{ label: "Collection", customId: input.collectionCustomId, style: 2 } as ButtonInput]
        : []),
      { label: "Open profile", url: input.profileUrl },
    ],
  ];
  return buildMessage({
    visibility: "private",
    embed: {
      title: displayName,
      description: `Collector in **${scopeName}**${input.isBotAdmin ? " · Bot administration available" : ""}.`,
      accent: FOILBURY_PALETTE.deepAqua,
      fields,
      footer: "Private response · sharing is separate and explicit",
    },
    rows,
  });
}

/* ------------------------------------------------------------------ */
/* Template: share prompt                                              */
/* ------------------------------------------------------------------ */

export interface ShareItem {
  label: string;
  kind: "card" | "completion" | "profile";
  audience: Audience;
  customId: string;
}

export interface SharePromptInput {
  displayName: string;
  channelLabel: string;
  channelAudience: Audience;
  items: ShareItem[];
  privateItems?: Array<{ label: string; reason: string }>;
  privacyUrl: string;
}

export function sharePromptMessage(input: SharePromptInput): DiscordCallback {
  const displayName = visibleText(input.displayName, "displayName");
  const channelLabel = visibleText(input.channelLabel, "channelLabel");
  const items = input.items.map((item) => {
    if (item.audience === "private") {
      fail(
        "channel_audience_unverified",
        "items",
        "Private artwork cannot be offered for sharing.",
      );
    }
    if (audienceRank(item.audience) > audienceRank(input.channelAudience)) {
      fail(
        "channel_audience_unverified",
        "items",
        "An offered item is wider than the verified channel audience.",
      );
    }
    return {
      ...item,
      label: visibleText(item.label, "item.label"),
      customId: assertCustomId(item.customId, "item.customId"),
    };
  });
  const privateItems = (input.privateItems ?? []).map((item) => ({
    label: visibleText(item.label, "privateItem.label"),
    reason: visibleText(item.reason, "privateItem.reason"),
  }));
  const fields: FieldInput[] = [
    {
      name: "Destination",
      value: `${channelLabel} · ${audienceLabel(input.channelAudience)}`,
      inline: true,
    },
    { name: "Visible to", value: "Everyone who can read this channel", inline: true },
    {
      name: "Ready to share",
      value: items.length
        ? [
            ...items.map((item) => `• ${item.label} · ${audienceLabel(item.audience)}`),
            ...(items.length > 4
              ? [
                  `• ${items.length - 4} more eligible item${items.length - 4 === 1 ? "" : "s"} on the website.`,
                ]
              : []),
          ].join("\n")
        : "Nothing in this channel is eligible for sharing.",
      inline: false,
    },
    {
      name: "Stays private",
      value: privateItems.length
        ? privateItems.map((item) => `• ${item.label} — ${item.reason}`).join("\n")
        : "No restricted item is listed.",
      inline: false,
    },
    {
      name: "Never shared",
      value:
        "Balance, email, sessions, member rosters and administrator controls are never included.",
      inline: false,
    },
    {
      name: "Consent",
      value:
        "Each button posts one item. Nothing posts automatically. An attachment can be copied after delivery and cannot be made private again.",
      inline: false,
    },
  ];
  const rows: ButtonInput[][] = [];
  if (items.length) {
    rows.push(
      items.slice(0, 4).map((item, index) => ({
        label: item.label,
        customId: item.customId,
        style: index === 0 ? 1 : 2,
      })),
    );
  }
  rows.push([{ label: "Read the sharing policy", url: input.privacyUrl }]);
  return buildMessage({
    visibility: "private",
    embed: {
      title: "Share deliberately",
      description: `**${displayName}**, a shared post is visible to everyone who can read **${channelLabel}**. You choose one item at a time; dismissing this prompt shares nothing.`,
      accent: FOILBURY_PALETTE.deepAqua,
      fields,
      footer: "Explicit consent · audience checked before posting",
    },
    rows,
  });
}

/* ------------------------------------------------------------------ */
/* Template: error, empty and denied states                            */
/* ------------------------------------------------------------------ */

export type StateKind = "error" | "empty" | "denied";

export interface StateInput {
  kind: StateKind;
  title?: string;
  message: string;
  nextStep?: string;
  retryCustomId?: string;
  retryLabel?: string;
  helpUrl?: string;
  correlationId?: string;
}

const STATE_TITLES: Record<StateKind, string> = {
  error: "That did not complete",
  empty: "Nothing here yet",
  denied: "Not available for this account",
};

const STATE_FOOTERS: Record<StateKind, string> = {
  error: "Nothing was charged or changed.",
  empty: "No action was taken.",
  denied: "No change was made.",
};

const STATE_DEFAULT_NEXT: Record<StateKind, string> = {
  error:
    "Try again. If it repeats, open the field guide and quote the reference only to Foilbury staff.",
  empty: "Claim the daily allowance or open a capsule when you are ready.",
  denied:
    "This stays private to the authorised account. Server moderator status is not Foilbury administration.",
};

function assertCorrelationId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{3,31}$/.test(value)) {
    fail("invalid_input", "correlationId", "Correlation ids are short opaque diagnostic tokens.");
  }
  return value;
}

export function stateMessage(input: StateInput): DiscordCallback {
  const nextStep = input.nextStep ?? STATE_DEFAULT_NEXT[input.kind];
  const fields: FieldInput[] = [{ name: "Next step", value: nextStep, inline: false }];
  if (input.correlationId) {
    fields.push({
      name: "Reference",
      value: `\`${assertCorrelationId(input.correlationId)}\``,
      inline: false,
    });
  }
  const rows: ButtonInput[][] = [];
  if (input.retryCustomId) {
    rows.push([
      {
        label: input.retryLabel ?? "Try again",
        customId: input.retryCustomId,
        style: 1,
      },
    ]);
  }
  if (input.helpUrl) rows.push([{ label: "Read the field guide", url: input.helpUrl }]);
  return buildMessage({
    visibility: "private",
    embed: {
      title: input.title ?? STATE_TITLES[input.kind],
      description: input.message,
      accent: input.kind === "empty" ? FOILBURY_PALETTE.ice : FOILBURY_PALETTE.ink,
      fields,
      footer: STATE_FOOTERS[input.kind],
    },
    rows,
  });
}

export interface SafeErrorCopy {
  kind: StateKind;
  title: string;
  message: string;
  nextStep: string;
}

export const SAFE_ERROR_COPY: Record<string, SafeErrorCopy> = {
  reward_cooldown: {
    kind: "empty",
    title: "Allowance not ready",
    message: "The daily allowance is already claimed for this period. No second credit was made.",
    nextStep: "Come back when the timer ends, or open a capsule you can afford.",
  },
  insufficient_funds: {
    kind: "error",
    title: "Not enough Foil",
    message:
      "That capsule costs more than your current balance. Nothing was charged and no card was drawn.",
    nextStep: "Claim the daily allowance or choose a cheaper capsule.",
  },
  empty_pool: {
    kind: "empty",
    title: "No eligible cards here",
    message: "This capsule has no eligible cards for your account right now. Nothing was charged.",
    nextStep: "Try another capsule or check your collection preferences.",
  },
  discord_channel_not_enabled: {
    kind: "denied",
    title: "This channel is not enabled",
    message:
      "Foilbury is not enabled in this channel. Nothing was charged and no player was created.",
    nextStep: "Use the configured play channel or ask a Bot Admin to enable this one.",
  },
  discord_channel_not_allowed: {
    kind: "denied",
    title: "This channel is not enabled",
    message:
      "Foilbury is not enabled in this channel. Nothing was charged and no player was created.",
    nextStep: "Use the configured play channel or ask a Bot Admin to enable this one.",
  },
  discord_game_disabled: {
    kind: "denied",
    title: "Gameplay is paused",
    message: "Discord gameplay is paused for this Bot. Nothing was charged.",
    nextStep:
      "Ask a Bot Admin to re-enable gameplay; administration remains available to authorised staff.",
  },
  discord_installation_missing: {
    kind: "denied",
    title: "This server is not connected",
    message: "This server is not bound to a Foilbury Bot. No player, card or charge was created.",
    nextStep: "Ask the Bot Owner to connect the Bot to this server.",
  },
  discord_guild_required: {
    kind: "denied",
    title: "Use Foilbury in a server",
    message: "Foilbury only works in a server where this Bot is installed.",
    nextStep: "Return to the configured play channel.",
  },
  membership_revoked: {
    kind: "denied",
    title: "Membership is not active",
    message: "This player is no longer an active member of this Bot. Nothing was changed.",
    nextStep: "Ask the Bot Owner or an authorised Bot Admin to restore membership deliberately.",
  },
  discord_identity_revoked: {
    kind: "denied",
    title: "This Discord identity was revoked",
    message: "This Discord identity is no longer linked for this Bot. Nothing was changed.",
    nextStep: "Ask the Bot Owner to restore the identity. Signing in again does not restore it.",
  },
  account_disabled: {
    kind: "denied",
    title: "Account disabled",
    message: "This player account is disabled. Nothing was changed.",
    nextStep: "Contact the Bot Owner.",
  },

  share_channel_audience: {
    kind: "denied",
    title: "This channel is not verified for that artwork",
    message:
      "The card or album is wider than this channel's verified audience. Nothing was posted.",
    nextStep: "Choose a public item, or ask a Bot Admin to verify the channel audience.",
  },
  share_private_not_available: {
    kind: "denied",
    title: "Private artwork stays private",
    message: "Private collection artwork cannot be shared to a channel. Nothing was posted.",
    nextStep: "Choose an approved public or member-safe item.",
  },
  share_already_delivered: {
    kind: "empty",
    title: "Already shared here",
    message: "That item was already shared in this channel. Nothing was posted again.",
    nextStep: "Open the existing message, or share a different item.",
  },
  mission_incomplete: {
    kind: "empty",
    title: "Mission not complete",
    message: "That mission is still in progress. Nothing was credited.",
    nextStep: "Finish the listed action, then claim the reward.",
  },
  mission_not_assigned: {
    kind: "denied",
    title: "Not part of today's assignment",
    message: "That mission is not assigned to you today. Nothing was credited.",
    nextStep: "Refresh the daily mission list.",
  },
  card_not_found: {
    kind: "empty",
    title: "No matching card",
    message: "That card is not available in this album. Nothing was charged.",
    nextStep: "Check the spelling, or browse the album on the website.",
  },
  render_missing: {
    kind: "empty",
    title: "Artwork is still being prepared",
    message: "The saved render for that card is not published yet. Your copy is unaffected.",
    nextStep: "Try again later, or open the card in the website album.",
  },
  insufficient_role: {
    kind: "denied",
    title: "Administration is private",
    message:
      "That action needs a Bot-scoped Foilbury role. Server moderator status does not grant it.",
    nextStep: "Ask the Bot Owner or an authorised Bot Admin.",
  },
  stale_pool_revision: {
    kind: "empty",
    title: "The capsule changed",
    message: "The pool changed before the draw. You were not charged.",
    nextStep: "Review the new odds, then open the capsule again.",
  },
  confirmation_expired: {
    kind: "empty",
    title: "That confirmation expired",
    message: "The confirmation is no longer valid and no change was made.",
    nextStep: "Run the command again to create a fresh confirmation.",
  },
  confirmation_used: {
    kind: "empty",
    title: "That confirmation was already used",
    message: "The confirmation was consumed once and no second change was made.",
    nextStep: "Run the command again only if you intend a new change.",
  },
  confirmation_not_yours: {
    kind: "denied",
    title: "That confirmation belongs to another account",
    message: "The confirmation is bound to a different Discord account. No change was made.",
    nextStep: "Create your own confirmation from the command.",
  },
  completion_incomplete: {
    kind: "empty",
    title: "That album is not complete",
    message: "The album still has missing subjects, so nothing was shared.",
    nextStep: "Check the album's next target, then share only when it is complete.",
  },
  share_card_missing: {
    kind: "empty",
    title: "That card is not in your cabinet",
    message:
      "The card is not owned by this account or is not visible in this album. Nothing was posted.",
    nextStep: "Choose a card from your own collection.",
  },
  share_channel_required: {
    kind: "denied",
    title: "Sharing needs an authorised channel",
    message:
      "Sharing is only available in a server channel that Foilbury can verify. Nothing was posted.",
    nextStep: "Use the configured play or showcase channel.",
  },
  player_not_linked: {
    kind: "denied",
    title: "Link a player first",
    message: "This Discord account is not linked to a Foilbury player. Nothing was changed.",
    nextStep: "Use a normal player command first, or ask the Bot Owner for help.",
  },
  discord_command_unknown: {
    kind: "empty",
    title: "That command is not registered",
    message: "The registered Foilbury command tree does not contain that command. Nothing ran.",
    nextStep: "Use /foilbury help to see the registered commands.",
  },
  discord_component_unknown: {
    kind: "empty",
    title: "That control is no longer available",
    message: "The button or menu is stale or was retired. Nothing was changed.",
    nextStep: "Run the command again to get the current controls.",
  },
  discord_admin_required: {
    kind: "denied",
    title: "Administration is private",
    message: "This view is limited to this Bot's Owner or Admin. Nothing was changed.",
    nextStep: "Ask the Bot Owner or an authorised Bot Admin.",
  },
  internal_error: {
    kind: "error",
    title: "Foilbury could not confirm the outcome",
    message:
      "The interaction stopped before Foilbury could confirm a display result. Check your cabinet and wallet before retrying; a committed draw remains recorded.",
    nextStep:
      "Open your cabinet first. If the card or credit is present, do not draw again. Quote the private reference only to Foilbury staff.",
  },
};

export interface ErrorPresentationInput {
  code?: string;
  /** Reviewed, server-authored detail for configuration/scope failures. Never raw SQL or a stack message. */
  message?: string;
  nextStep?: string;
  retryCustomId?: string;
  retryLabel?: string;
  helpUrl?: string;
  correlationId?: string;
}

/**
 * Never echo a raw ApiError message: stack traces, SQL and raw identifiers are
 * not presentation copy. Only the code selects a reviewed, human sentence.
 */
export function stateFromError(input: ErrorPresentationInput = {}): DiscordCallback {
  const copy = (input.code ? SAFE_ERROR_COPY[input.code] : undefined) ?? {
    kind: "error" as const,
    title: STATE_TITLES.error,
    message: "Foilbury could not complete that interaction. Nothing was charged or changed.",
    nextStep: STATE_DEFAULT_NEXT.error,
  };
  return stateMessage({
    kind: copy.kind,
    title: copy.title,
    message: input.message ?? copy.message,
    nextStep: input.nextStep ?? copy.nextStep,
    ...(input.retryCustomId ? { retryCustomId: input.retryCustomId } : {}),
    ...(input.retryLabel ? { retryLabel: input.retryLabel } : {}),
    ...(input.helpUrl ? { helpUrl: input.helpUrl } : {}),
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
  });
}

/* ------------------------------------------------------------------ */
/* Local contact sheet and deterministic preview JSON                  */
/* ------------------------------------------------------------------ */

export const CONTACT_SHEET_DISCLAIMER =
  "Structural preview generated from the Foilbury presentation builders. This is not a real Discord client render and is not acceptance evidence. Desktop, mobile and spectator review in a real Discord session is still required.";

export interface ContactSheetEntry {
  label: string;
  note?: string;
  message: DiscordCallback;
}

export interface ContactSheetOptions {
  title?: string;
  note?: string;
}

function reviewSafeMessage(callback: DiscordCallback): unknown {
  return {
    type: callback.type,
    data: callback.data ?? {},
    attachments: (callback.attachments ?? []).map((attachment) => ({
      filename: attachment.filename,
      contentType: attachment.contentType,
    })),
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

export function contactSheetJson(
  entries: ContactSheetEntry[],
  options: ContactSheetOptions = {},
): string {
  return stableStringify({
    format: "foilbury.discord.contact-sheet.v1",
    title: options.title ?? "Foilbury Discord presentation",
    note: options.note ?? CONTACT_SHEET_DISCLAIMER,
    disclaimer: CONTACT_SHEET_DISCLAIMER,
    entries: entries.map((entry, index) => ({
      index,
      label: entry.label,
      note: entry.note ?? null,
      message: reviewSafeMessage(entry.message),
    })),
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderInlineMarkdown(value: string): string {
  return escapeHtml(value)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/&lt;t:(\d{1,12})(?::[RfDt])?&gt;/g, (_match, seconds: string) => {
      const date = new Date(Number(seconds) * 1000);
      if (Number.isNaN(date.getTime())) return _match;
      const label = `${date.toISOString().replace("T", " ").slice(0, 16)} UTC`;
      return `<span class="discord-time" title="Discord renders this timestamp in the viewer's locale and timezone.">${escapeHtml(
        label,
      )}</span>`;
    })
    .replace(/\n/g, "<br>");
}

function paletteHex(value: number): string {
  return `#${value.toString(16).padStart(6, "0")}`;
}

function contactSheetImage(embed: DiscordEmbed): string {
  const image = embed.image;
  if (!image) return "";
  if (image.url.startsWith("attachment://")) {
    return `<div class="media-slot"><span class="media-label">Attachment</span><strong>${escapeHtml(
      image.url.slice("attachment://".length),
    )}</strong><span>Discord renders the saved published card render at its source aspect ratio.</span></div>`;
  }
  let host = image.url;
  try {
    host = new URL(image.url).host;
  } catch {
    // The preview is already a local diagnostic; keep the raw text if parsing fails.
  }
  return `<div class="media-slot"><span class="media-label">Remote image</span><strong>${escapeHtml(
    host,
  )}</strong><span>Not fetched by this local contact sheet.</span></div>`;
}

function contactSheetEmbed(embed: DiscordEmbed): string {
  const accent = paletteHex(embed.color ?? FOILBURY_PALETTE.deepAqua);
  const fields = embed.fields?.length
    ? `<div class="fields">${embed.fields
        .map(
          (field) =>
            `<div class="field${field.inline ? " field-inline" : ""}"><div class="field-name">${renderInlineMarkdown(
              field.name,
            )}</div><div class="field-value">${renderInlineMarkdown(field.value)}</div></div>`,
        )
        .join("")}</div>`
    : "";
  return `<section class="embed" style="--accent:${accent}">
    ${embed.title ? `<h3>${renderInlineMarkdown(embed.title)}</h3>` : ""}
    ${embed.description ? `<p class="description">${renderInlineMarkdown(embed.description)}</p>` : ""}
    ${fields}
    ${contactSheetImage(embed)}
    <footer class="embed-footer">
      ${embed.footer ? `<span>${escapeHtml(embed.footer.text)}</span>` : ""}
      ${embed.timestamp ? `<span class="timestamp">${escapeHtml(embed.timestamp)}</span>` : ""}
    </footer>
  </section>`;
}

function contactSheetComponents(message: DiscordMessage): string {
  if (!message.components?.length) return "";
  return `<div class="components">${message.components
    .map(
      (row) =>
        `<div class="component-row">${row.components
          .map((component) => {
            const kind = component.style === 5 ? `<span class="button-kind">Link</span>` : "";
            const style = component.style === 1 ? " primary" : component.style === 5 ? " link" : "";
            const disabled = component.disabled ? " disabled" : "";
            return `<span class="button${style}${disabled}">${kind}${escapeHtml(
              component.label ?? "",
            )}</span>`;
          })
          .join("")}</div>`,
    )
    .join("")}</div>`;
}

function contactSheetEntry(entry: ContactSheetEntry, index: number): string {
  const message = entry.message;
  const privateResponse = ((message.data?.flags ?? 0) & 64) === 64;
  return `<article class="message-card">
    <header class="message-head">
      <div>
        <h2>${escapeHtml(entry.label)}</h2>
        ${entry.note ? `<p class="note">${escapeHtml(entry.note)}</p>` : ""}
      </div>
      <span class="badge ${privateResponse ? "badge-private" : "badge-channel"}">${privateResponse ? "Private" : "Channel"}</span>
    </header>
    <div class="discord-message" data-entry="${index}">
      ${(message.data?.embeds ?? []).map(contactSheetEmbed).join("")}
      ${contactSheetComponents(message.data ?? {})}
      ${
        message.attachments?.length
          ? `<div class="attachments">${message.attachments
              .map(
                (attachment) =>
                  `<span class="attachment">${escapeHtml(attachment.filename)} <small>${escapeHtml(
                    attachment.contentType,
                  )}</small></span>`,
              )
              .join("")}</div>`
          : ""
      }
    </div>
  </article>`;
}

export function contactSheetHtml(
  entries: ContactSheetEntry[],
  options: ContactSheetOptions = {},
): string {
  const title = escapeHtml(options.title ?? "Foilbury Discord presentation");
  const note = escapeHtml(options.note ?? CONTACT_SHEET_DISCLAIMER);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root {
    --deep-current: #044e4a;
    --electric-aqua: #00a99c;
    --ice: #c8f4ee;
    --signal-lime: #c9f25f;
    --ink: #07110f;
    --bone: #eff5f1;
    --panel: #0d1f1c;
    --muted: #a9c8c2;
    --rule: #244a43;
  }
  * { box-sizing: border-box; }
  html { background: var(--bone); color: var(--ink); }
  body {
    margin: 0;
    padding: 32px;
    font-family: ui-sans-serif, "Geist Sans", "Helvetica Neue", Arial, sans-serif;
    line-height: 1.5;
  }
  .sheet-head {
    max-width: 1120px;
    margin: 0 auto 28px;
    border-top: 4px solid var(--electric-aqua);
    padding-top: 18px;
  }
  .sheet-head h1 {
    margin: 0 0 8px;
    font-size: clamp(1.45rem, 3vw, 2.15rem);
    letter-spacing: -0.03em;
    line-height: 1.1;
  }
  .sheet-head p { max-width: 70ch; margin: 0; color: #25443f; }
  .sheet-head .status {
    display: inline-block;
    margin-top: 14px;
    border: 1px solid var(--ink);
    padding: 4px 8px;
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .sheet {
    max-width: 1120px;
    margin: 0 auto;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr));
    gap: 28px;
    align-items: start;
  }
  .message-card {
    min-width: 0;
    background: #ffffff;
    border: 1px solid #c9dbd6;
    border-radius: 6px;
    padding: 18px;
    box-shadow: 0 12px 28px rgba(7, 17, 15, 0.08);
  }
  .message-head { display: flex; justify-content: space-between; gap: 14px; align-items: start; }
  .message-head h2 { margin: 0; font-size: 1rem; letter-spacing: -0.01em; }
  .message-head .note { margin: 4px 0 0; color: #41615b; font-size: 0.82rem; }
  .badge {
    flex: none;
    border: 1px solid currentColor;
    padding: 2px 7px;
    font-size: 0.7rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .badge-private { color: var(--deep-current); }
  .badge-channel { color: #7a4c00; }
  .discord-message {
    margin-top: 14px;
    background: var(--ink);
    color: var(--bone);
    border-radius: 6px;
    padding: 16px;
    overflow-wrap: anywhere;
  }
  .embed {
    border-top: 4px solid var(--accent);
    background: var(--panel);
    padding: 14px 16px;
    border-radius: 0 0 4px 4px;
  }
  .embed + .embed { margin-top: 12px; }
  .embed h3 { margin: 0 0 8px; color: #ffffff; font-size: 1rem; line-height: 1.25; }
  .embed .description { margin: 0 0 12px; color: #d9ebe6; font-size: 0.9rem; }
  .embed strong { color: #ffffff; }
  .embed code {
    font-family: ui-monospace, "Geist Mono", "SFMono-Regular", Menlo, monospace;
    font-size: 0.86em;
    color: var(--signal-lime);
    background: rgba(201, 242, 95, 0.08);
    padding: 1px 4px;
  }
  .fields { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-top: 10px; }
  .field { min-width: 0; }
  .field-inline { grid-column: span 1; }
  .field:not(.field-inline) { grid-column: 1 / -1; }
  .field-name { color: var(--ice); font-size: 0.75rem; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; }
  .field-value { color: #d9ebe6; font-size: 0.86rem; }
  .media-slot {
    display: grid;
    gap: 2px;
    margin-top: 12px;
    padding: 14px;
    border: 1px dashed #3f6b62;
    color: var(--muted);
    font-size: 0.78rem;
    background: rgba(200, 244, 238, 0.04);
  }
  .media-slot strong { color: var(--ice); font-family: ui-monospace, "Geist Mono", Menlo, monospace; }
  .media-label { color: var(--signal-lime); font-size: 0.7rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
  .embed-footer { display: flex; justify-content: space-between; gap: 12px; margin-top: 12px; color: var(--muted); font-size: 0.75rem; }
  .timestamp { font-family: ui-monospace, "Geist Mono", Menlo, monospace; }
  .components { display: grid; gap: 8px; margin-top: 12px; }
  .component-row { display: flex; flex-wrap: wrap; gap: 8px; }
  .button {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    border: 1px solid #466a63;
    background: #1a2f2b;
    color: #eaf6f2;
    padding: 7px 12px;
    border-radius: 3px;
    font-size: 0.82rem;
    font-weight: 600;
  }
  .button.primary { background: var(--electric-aqua); border-color: var(--electric-aqua); color: #04110f; }
  .button.link { background: transparent; border-color: var(--signal-lime); color: var(--signal-lime); }
  .button.disabled { background: #182924; border-color: #4f6d66; border-style: dashed; color: #c3d8d3; cursor: not-allowed; }
  .button-kind {
    font-size: 0.7rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    opacity: 0.78;
  }
  .button.primary .button-kind { opacity: 1; color: #04110f; }
  .button.disabled .button-kind { opacity: 1; color: #c3d8d3; }
  .attachments { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
  .attachment {
    border: 1px solid #35574f;
    padding: 5px 8px;
    color: var(--ice);
    font-family: ui-monospace, "Geist Mono", Menlo, monospace;
    font-size: 0.75rem;
  }
  .attachment small { color: var(--muted); }
  .discord-time { color: var(--ice); border-bottom: 1px dotted #6d948b; }
  .sheet-foot { max-width: 1120px; margin: 30px auto 0; color: #41615b; font-size: 0.78rem; }
  @media (max-width: 560px) {
    body { padding: 18px; }
    .fields { grid-template-columns: 1fr; }
    .field-inline { grid-column: 1 / -1; }
    .message-card { padding: 14px; }
    .embed-footer { flex-direction: column; }
  }
  @media print {
    body { padding: 0; background: #ffffff; }
    .message-card { break-inside: avoid; box-shadow: none; }
  }
</style>
</head>
<body>
<header class="sheet-head">
  <h1>${title}</h1>
  <p>${note}</p>
  <span class="status">Structural preview only · not a real-client verification</span>
</header>
<main class="sheet">
${entries.map(contactSheetEntry).join("\n")}
</main>
<footer class="sheet-foot">${escapeHtml(CONTACT_SHEET_DISCLAIMER)}</footer>
</body>
</html>`;
}
