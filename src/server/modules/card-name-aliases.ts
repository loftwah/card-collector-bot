/**
 * Canonical display-name normalization for alternate names. The alias table
 * stores one normalized key per Bot so transliteration, width and spacing
 * variants resolve to the same card instead of creating a second identity.
 */
export function normalizeCardName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}
