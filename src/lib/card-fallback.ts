/** Interface placeholder only; this is not an issued card render. */
export const MISSING_CARD_ART = "/brand/kit/colophon/artwork-unavailable.svg";
const LEGACY_BACK = "/brand/card-back.webp";

export function uiCardFallback(url?: string | null): string {
  return !url || url === LEGACY_BACK ? MISSING_CARD_ART : url;
}
