import presentations from "../data/collection-presentations.json";

export interface CollectionGroup {
  key: string;
  label: string;
  caption: string;
  match: string;
}

export interface CollectionPresentation {
  theme: "trial" | "table";
  titleLead?: string;
  titleTail?: string;
  eyebrow: string;
  lede: string;
  openingPool: string;
  openingCta: string;
  rosterLabel: string;
  groups: CollectionGroup[];
}

const collectionPresentations = presentations as Record<string, CollectionPresentation>;

export function collectionPresentation(
  slug: string | null | undefined,
): CollectionPresentation | null {
  if (!slug) return null;
  return collectionPresentations[slug] ?? null;
}

export function cardThemeForCollection(slug: string | null | undefined): "trial" | "table" | null {
  return collectionPresentation(slug)?.theme ?? null;
}

/** Group a binder card by the collection's authored shelf language. */
export function groupForCard(
  subtitle: string | null | undefined,
  presentation: CollectionPresentation,
): string {
  const value = String(subtitle ?? "");
  const found = presentation.groups.find((group) => group.match && value.startsWith(group.match));
  if (found) return found.key;
  if (presentation.groups.every((group) => !group.match)) {
    return presentation.groups[0]?.key ?? "all";
  }
  return "other";
}
