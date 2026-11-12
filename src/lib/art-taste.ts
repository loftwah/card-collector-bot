export const ART_TASTE_FILTERS = [
  ["all", "All art"],
  ["candidates", "Card candidates"],
  ["collections", "Collection art"],
  ["icons", "Icons"],
  ["mascots", "Mascots"],
  ["styles", "Card styles"],
  ["brand", "Other brand art"],
] as const;

export const ART_GRADES = [
  [1, "Pass"],
  [2, "Needs work"],
  [3, "Promising"],
  [4, "Strong"],
  [5, "Favourite"],
] as const;

export type ArtTasteKind = Exclude<(typeof ART_TASTE_FILTERS)[number][0], "all">;
export type ArtTaste = { grade: number | null; note: string };
export interface ArtTastePiece {
  id: string;
  kind: ArtTasteKind;
  name: string;
  caption: string;
  image: string;
  back?: string;
  width?: number | null;
  height?: number | null;
  collection?: string | null;
  provenance?: string;
  status?: string;
  brief?: string;
  candidateReview?: {
    endpoint: string;
    likes: number;
    dislikes: number;
    decision: "like" | "dislike" | null;
  };
  taste?: ArtTaste;
}
