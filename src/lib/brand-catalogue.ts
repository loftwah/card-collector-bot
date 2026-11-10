import { CARD_STYLES } from "./card-styles";

/**
 * The real brand-art inventory that ships under /public. Paths are validated
 * against this list before a selection is stored; the catalogue is a view of
 * files that exist, not a second asset library.
 */
export type BrandKind =
  "icons" | "logos" | "og_images" | "banners" | "shareables" | "card_styles" | "other";
export type BrandSlot = "favicon" | "og_image" | "banner" | "card_style";

export interface BrandAsset {
  id: string;
  kind: BrandKind;
  label: string;
  path: string;
  width: number | null;
  height: number | null;
  note: string;
  slot: BrandSlot | null;
  tone: "paper" | "ink";
}

export interface BrandSelections {
  favicon: string;
  og_image: string;
  banner: string;
  card_style: string;
}

export interface BrandGroup {
  kind: BrandKind;
  label: string;
  note: string;
  slot: BrandSlot | null;
}

export const BRAND_GROUPS: BrandGroup[] = [
  {
    kind: "icons",
    label: "Favicons",
    note: "The browser tab, home-screen tile and Discord application icon.",
    slot: "favicon",
  },
  {
    kind: "logos",
    label: "Wordmarks and logos",
    note: "The Foil Standard mark, wordmark and lockup masters.",
    slot: null,
  },
  {
    kind: "og_images",
    label: "Open Graph",
    note: "The default social card for pages without their own card render.",
    slot: "og_image",
  },
  {
    kind: "banners",
    label: "Banners",
    note: "Wide 16:9 brand art for the Discord cover and campaign headers.",
    slot: "banner",
  },
  {
    kind: "shareables",
    label: "Shareables",
    note: "Square, portrait and story exports composed from the same system.",
    slot: null,
  },
  {
    kind: "card_styles",
    label: "Card styles",
    note: "Named art directions for whole-card generation. Finishes stay separate.",
    slot: "card_style",
  },
  {
    kind: "other",
    label: "Other brand art",
    note: "Card back, Discord avatar, Keeper mascots and NPC portraits.",
    slot: null,
  },
];

export const BRAND_ASSETS: BrandAsset[] = [
  {
    id: "favicon-mark",
    kind: "icons",
    label: "Mark · vector",
    path: "/brand/mark.svg",
    width: 256,
    height: 256,
    note: "The current tab icon. Paper F over a foil plane.",
    slot: "favicon",
    tone: "ink",
  },
  {
    id: "favicon-ink-32",
    kind: "icons",
    label: "Ink tile · 32",
    path: "/brand/variants/icon-ink-32.png",
    width: 32,
    height: 32,
    note: "Opaque ink ground for tabs and small avatars.",
    slot: "favicon",
    tone: "ink",
  },
  {
    id: "favicon-paper-32",
    kind: "icons",
    label: "Paper tile · 32",
    path: "/brand/variants/icon-paper-32.png",
    width: 32,
    height: 32,
    note: "Paper ground with an ink glyph.",
    slot: "favicon",
    tone: "paper",
  },
  {
    id: "favicon-32",
    kind: "icons",
    label: "Foilbury 32",
    path: "/brand/favicon-32.png",
    width: 32,
    height: 32,
    note: "The shipped 32 px favicon.",
    slot: "favicon",
    tone: "ink",
  },
  {
    id: "favicon-48",
    kind: "icons",
    label: "Foilbury 48",
    path: "/brand/favicon-48.png",
    width: 48,
    height: 48,
    note: "The shipped 48 px favicon.",
    slot: "favicon",
    tone: "ink",
  },
  {
    id: "apple-touch",
    kind: "icons",
    label: "Apple touch · 180",
    path: "/brand/apple-touch-icon.png",
    width: 180,
    height: 180,
    note: "Home-screen icon.",
    slot: "favicon",
    tone: "ink",
  },
  {
    id: "icon-192",
    kind: "icons",
    label: "App icon · 192",
    path: "/brand/icon-192.png",
    width: 192,
    height: 192,
    note: "Manifest icon.",
    slot: "favicon",
    tone: "ink",
  },
  {
    id: "icon-ink-512",
    kind: "icons",
    label: "Ink tile · 512",
    path: "/brand/variants/icon-ink-512.png",
    width: 512,
    height: 512,
    note: "Opaque 512 master with the foil shadow.",
    slot: "favicon",
    tone: "ink",
  },
  {
    id: "icon-paper-512",
    kind: "icons",
    label: "Paper tile · 512",
    path: "/brand/variants/icon-paper-512.png",
    width: 512,
    height: 512,
    note: "Paper 512 master with an ink glyph.",
    slot: "favicon",
    tone: "paper",
  },
  {
    id: "logo-wordmark-svg",
    kind: "logos",
    label: "Wordmark · vector",
    path: "/brand/kit/wordmarks/foil-standard.svg",
    width: 1600,
    height: 400,
    note: "The Foil Standard wordmark master.",
    slot: null,
    tone: "paper",
  },
  {
    id: "logo-wordmark-png",
    kind: "logos",
    label: "Wordmark · paper",
    path: "/brand/wordmark.png",
    width: 1600,
    height: 400,
    note: "Wordmark on paper.",
    slot: null,
    tone: "paper",
  },
  {
    id: "logo-wordmark-reverse",
    kind: "logos",
    label: "Wordmark · reverse",
    path: "/brand/wordmark-reverse.png",
    width: 1600,
    height: 400,
    note: "Wordmark on ink.",
    slot: null,
    tone: "ink",
  },
  {
    id: "logo-lockup",
    kind: "logos",
    label: "Lockup · 1600",
    path: "/brand/kit/foil-standard/lockup-1600x400.png",
    width: 1600,
    height: 400,
    note: "Mark and wordmark lockup.",
    slot: null,
    tone: "paper",
  },
  {
    id: "logo-mark",
    kind: "logos",
    label: "Mark · glyph",
    path: "/brand/kit/foil-standard/glyph.svg",
    width: 200,
    height: 200,
    note: "Transparent glyph for UI.",
    slot: null,
    tone: "paper",
  },
  {
    id: "og-current",
    kind: "og_images",
    label: "Current · ink",
    path: "/brand/social-preview.jpg",
    width: 1200,
    height: 630,
    note: "The shipped default social card.",
    slot: "og_image",
    tone: "ink",
  },
  {
    id: "og-paper",
    kind: "og_images",
    label: "Paper shelf",
    path: "/brand/variants/og-paper.png",
    width: 1200,
    height: 630,
    note: "Paper ground, serif headline, card fan.",
    slot: "og_image",
    tone: "paper",
  },
  {
    id: "og-ink",
    kind: "og_images",
    label: "Ink shelf",
    path: "/brand/variants/og-ink.png",
    width: 1200,
    height: 630,
    note: "Ink ground, reverse wordmark, card fan.",
    slot: "og_image",
    tone: "ink",
  },
  {
    id: "og-index",
    kind: "og_images",
    label: "Catalogue index",
    path: "/brand/variants/og-index.png",
    width: 1200,
    height: 630,
    note: "Hairline index with one foil-edged card.",
    slot: "og_image",
    tone: "paper",
  },
  {
    id: "og-master",
    kind: "og_images",
    label: "Current · PNG master",
    path: "/brand/kit/social/og-1200x630.png",
    width: 1200,
    height: 630,
    note: "The same shipped art as a lossless master.",
    slot: "og_image",
    tone: "ink",
  },
  {
    id: "banner-standard-1920",
    kind: "banners",
    label: "Foil Standard · 1920",
    path: "/brand/kit/banners/foil-standard-1920x1080.png",
    width: 1920,
    height: 1080,
    note: "The selected identity banner.",
    slot: "banner",
    tone: "ink",
  },
  {
    id: "banner-standard-960",
    kind: "banners",
    label: "Foil Standard · 960",
    path: "/brand/kit/banners/foil-standard-960x540.png",
    width: 960,
    height: 540,
    note: "Server banner size for the selected identity.",
    slot: "banner",
    tone: "ink",
  },
  {
    id: "banner-paper",
    kind: "banners",
    label: "Paper shelf · 1920",
    path: "/brand/variants/banner-paper.png",
    width: 1920,
    height: 1080,
    note: "Paper ground, serif headline, card fan.",
    slot: "banner",
    tone: "paper",
  },
  {
    id: "banner-ink",
    kind: "banners",
    label: "Ink shelf · 1920",
    path: "/brand/variants/banner-ink.png",
    width: 1920,
    height: 1080,
    note: "Ink ground, reverse wordmark, card fan.",
    slot: "banner",
    tone: "ink",
  },
  {
    id: "share-square",
    kind: "shareables",
    label: "Square · 1080",
    path: "/brand/variants/share-square-1080.png",
    width: 1080,
    height: 1080,
    note: "Feed post and Discord embed.",
    slot: null,
    tone: "paper",
  },
  {
    id: "share-portrait",
    kind: "shareables",
    label: "Portrait · 4:5",
    path: "/brand/variants/share-portrait-1080x1350.png",
    width: 1080,
    height: 1350,
    note: "Portrait feed export.",
    slot: null,
    tone: "ink",
  },
  {
    id: "share-story",
    kind: "shareables",
    label: "Story · 9:16",
    path: "/brand/variants/share-story-1080x1920.png",
    width: 1080,
    height: 1920,
    note: "Story and short-form cover frame.",
    slot: null,
    tone: "paper",
  },
  {
    id: "share-banner",
    kind: "shareables",
    label: "Wide · 16:9",
    path: "/brand/variants/banner-paper.png",
    width: 1920,
    height: 1080,
    note: "Wide share and header export.",
    slot: null,
    tone: "paper",
  },
  {
    id: "other-card-back",
    kind: "other",
    label: "Card back",
    path: "/brand/card-back.webp",
    width: 750,
    height: 1050,
    note: "The generic designed card back.",
    slot: null,
    tone: "ink",
  },
  {
    id: "other-discord-avatar",
    kind: "other",
    label: "Discord avatar",
    path: "/brand/discord-avatar.png",
    width: 512,
    height: 512,
    note: "Application avatar upload.",
    slot: null,
    tone: "ink",
  },
  {
    id: "other-keeper-neutral",
    kind: "other",
    label: "Keeper · neutral",
    path: "/brand/mascot/keeper-neutral-512.png",
    width: 512,
    height: 512,
    note: "The universal Keeper fallback.",
    slot: null,
    tone: "paper",
  },
  {
    id: "other-keeper-curious",
    kind: "other",
    label: "Keeper · curious",
    path: "/brand/mascot/keeper-curious-512.png",
    width: 512,
    height: 512,
    note: "Paper-craft Keeper expression.",
    slot: null,
    tone: "paper",
  },
  {
    id: "other-keeper-pleased",
    kind: "other",
    label: "Keeper · pleased",
    path: "/brand/mascot/keeper-pleased-512.png",
    width: 512,
    height: 512,
    note: "Paper-craft Keeper expression.",
    slot: null,
    tone: "paper",
  },
  {
    id: "other-keeper-mischievous",
    kind: "other",
    label: "Keeper · mischievous",
    path: "/brand/mascot/keeper-mischievous-512.png",
    width: 512,
    height: 512,
    note: "Paper-craft Keeper expression.",
    slot: null,
    tone: "paper",
  },
  ...CARD_STYLES.map((style): BrandAsset => ({
    id: `style-${style.key}`,
    kind: "card_styles",
    label: style.label,
    path: style.thumb,
    width: 480,
    height: 480,
    note: style.note,
    slot: "card_style",
    tone: "paper",
  })),
];

export function brandAssetByPath(path: string): BrandAsset | null {
  return BRAND_ASSETS.find((asset) => asset.path === path) ?? null;
}

export function brandAssetByStyle(key: string): BrandAsset | null {
  return BRAND_ASSETS.find((asset) => asset.id === `style-${key}`) ?? null;
}

export function brandAssetsForKind(kind: BrandKind): BrandAsset[] {
  return BRAND_ASSETS.filter((asset) => asset.kind === kind);
}
