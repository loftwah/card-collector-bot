/**
 * A collection's identity is its own banner or mark. `cover_url` on a collection
 * summary is a card render used as a fallback cover elsewhere; it must never be
 * presented as the collection's identity.
 */
export interface CollectionArt {
  banner_url?: string | null;
  logo_url?: string | null;
}

export function collectionBanner(collection: CollectionArt | null | undefined): string | null {
  return collection?.banner_url ?? null;
}

export function collectionMark(collection: CollectionArt | null | undefined): string | null {
  return collection?.logo_url ?? null;
}
