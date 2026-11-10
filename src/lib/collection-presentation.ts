import presentations from "../data/collection-presentations.json";
import themes from "../data/collection-themes.json";

export type CollectionThemeKey = keyof typeof themes;

export interface CollectionTheme {
  label: string;
  ground: string;
  paper: string;
  ink: string;
  accent: string;
  backSurface: "paper" | "dark";
  markTreatment: "invert" | "plate" | "wordmark" | "plain";
  markInvert: boolean;
}

export interface CollectionGroup {
  key: string;
  label: string;
  caption: string;
  /** Prefix match against the card subtitle. */
  match?: string;
  /** Exact card names, used when a roster has authored shelves. */
  cards?: string[];
}

export interface CollectionPresentation {
  theme: CollectionThemeKey;
  titleLead?: string;
  titleTail?: string;
  eyebrow: string;
  lede: string;
  /** Optional shorter collection name for the printed card face. */
  cardSetName?: string;
  /** Defaults to `<collection-slug>-capsule`. */
  openingPool?: string;
  openingCta: string;
  rosterLabel: string;
  /** Label for the hero's unique-subject fact. Defaults to "Subjects". */
  rosterFactLabel?: string;
  /** Optional object-position for the real banner at wide widths. */
  bannerPosition?: string;
  groups: CollectionGroup[];
}

const collectionPresentations = presentations as Record<string, CollectionPresentation>;
const collectionThemes = themes as Record<string, CollectionTheme>;

export function collectionPresentation(
  slug: string | null | undefined,
): CollectionPresentation | null {
  if (!slug) return null;
  return collectionPresentations[slug] ?? null;
}

export function collectionTheme(
  theme: string | null | undefined,
): CollectionTheme | null {
  if (!theme) return null;
  return collectionThemes[theme] ?? null;
}

export function cardThemeForCollection(slug: string | null | undefined): CollectionThemeKey | null {
  return collectionPresentation(slug)?.theme ?? null;
}

/** The capsule a collection page offers, unless its presentation names one. */
export function presentationPool(slug: string, presentation: CollectionPresentation): string {
  return presentation.openingPool ?? `${slug}-capsule`;
}

/** Group a binder card by the collection's authored shelf language. */
export function groupForCard(
  card: { name: string; subtitle?: string | null },
  presentation: CollectionPresentation,
): string {
  const name = String(card.name ?? "");
  const value = String(card.subtitle ?? "");
  const exact = presentation.groups.find((group) => group.cards?.includes(name));
  if (exact) return exact.key;
  const prefixed = presentation.groups.find(
    (group) => group.match && value.startsWith(group.match),
  );
  if (prefixed) return prefixed.key;
  if (presentation.groups.every((group) => !group.match && !group.cards?.length)) {
    return presentation.groups[0]?.key ?? "all";
  }
  return "other";
}
