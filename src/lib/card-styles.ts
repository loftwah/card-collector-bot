/**
 * Named card art directions. These are directions, not finishes: Plain,
 * Silver, Gold and Holographic remain the material finishes of a single print.
 *
 * A style is a durable, shared vocabulary — the Art Lab brief, every candidate,
 * the approval and the published render all carry one of these keys so the
 * catalogue is filterable and the member surfaces can name what they show.
 */
export const CARD_STYLES = [
  {
    key: "atelier",
    label: "Atelier",
    note: "Art-led portrait on a deep plinth. Cream type, foil edge.",
    prompt:
      "ATELIER direction: an art-led portrait that stands on a deep plum or ink plinth, lit like a studio sitting. Warm cream type, a single foil-blue hairline at the frame edge, rich painted material and a designed information band. The subject is the hero; the object feels handmade and expensive.",
    thumb: "/art/styles/atelier.webp",
  },
  {
    key: "cinematic",
    label: "Cinematic",
    note: "Subject inside a rain-lit scene. Anamorphic light, deep shadow.",
    prompt:
      "CINEMATIC direction: place the subject inside a rain-lit or neon-lit scene with anamorphic highlights, atmospheric haze and deep shadow. The environment carries the mood; the card frame and information band stay restrained and legible. Teal-and-amber or sodium light, never a poster.",
    thumb: "/art/styles/cinematic.webp",
  },
  {
    key: "editorial",
    label: "Editorial",
    note: "Bright studio spread. Generous paper margin, crisp light.",
    prompt:
      "EDITORIAL direction: a bright magazine studio spread with a large warm paper margin, crisp neutral key light and a restrained palette. Precise typographic hierarchy, one strong portrait, subtle photographic shadow. It should read as a printed page about the character, not a game UI.",
    thumb: "/art/styles/editorial.webp",
  },
  {
    key: "archive",
    label: "Archive",
    note: "Catalogue record on aged paper. Ink rules, sepia tone.",
    prompt:
      "ARCHIVE direction: an antique catalogue record on aged cream paper with fine ink rules, a mounted or tipped-in portrait, sepia and oxblood accents and typed record lines. The collection mark sits on a paper plate. It is a found object from a collector's archive, not a school worksheet.",
    thumb: "/art/styles/archive.webp",
  },
  {
    key: "manga",
    label: "Manga",
    note: "High-contrast ink. Screentone, dynamic diagonal crop.",
    prompt:
      "MANGA direction: high-contrast black-and-white ink with screentone shading, a bold silhouette and a dynamic diagonal crop. A heavy inked gutter, a paper caption panel and one accent colour only. The name stays large and readable at Discord inline size.",
    thumb: "/art/styles/manga.webp",
  },
  {
    key: "minimal",
    label: "Minimal",
    note: "Empty warm paper. Small figure, one foil rule.",
    prompt:
      "MINIMAL direction: mostly empty warm paper, a small centred figure and a single thin foil-blue rule. Enormous negative space, precise small type, no decoration. Premium and quiet, but the name, rarity, finish and print code must still survive at 214 x 300.",
    thumb: "/art/styles/minimal.webp",
  },
] as const;

export type CardStyleKey = (typeof CARD_STYLES)[number]["key"];

export const CARD_STYLE_KEYS = CARD_STYLES.map((style) => style.key);

export const CARD_STYLE_LABEL: Record<string, string> = Object.fromEntries(
  CARD_STYLES.map((style) => [style.key, style.label]),
);

export const DEFAULT_CARD_STYLES: CardStyleKey[] = ["atelier"];

export function cardStyle(key: string | null | undefined) {
  if (!key) return null;
  return CARD_STYLES.find((style) => style.key === key) ?? null;
}

export function normalizeCardStyleKeys(values: unknown): CardStyleKey[] {
  if (!Array.isArray(values)) return [...DEFAULT_CARD_STYLES];
  const keys = values
    .map((value) => String(value).trim().toLowerCase())
    .filter((value): value is CardStyleKey => CARD_STYLE_KEYS.includes(value as CardStyleKey));
  return [...new Set(keys)].slice(0, 4);
}

export function stylePromptLine(keys: string[]): string {
  const chosen = keys
    .map((key) => cardStyle(key))
    .filter((style): style is (typeof CARD_STYLES)[number] => Boolean(style))
    .map((style) => style.prompt);
  return chosen.length ? chosen.join("\n\n") : CARD_STYLES[0].prompt;
}
