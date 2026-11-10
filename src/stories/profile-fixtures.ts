import type {
  ProfilePresentationOptions,
  ResolvedProfilePresentation,
} from "@/server/modules/profile-presentation";

export const profileLooksFixture = [
  { key: "quiet", name: "Quiet archive", note: "Bone paper, restrained type and one featured card." },
  { key: "signal", name: "Signal room", note: "Deep current, electric aqua and a brighter specimen shelf." },
  { key: "binder", name: "Binder desk", note: "Warm cabinet surfaces with a working-collection feel." },
  { key: "night", name: "Night shelf", note: "Low light, cool paper and a quiet gallery wall." },
];

const copies = [
  {
    id: "ins_01",
    cardId: "crd_kestrel",
    cardName: "Kestrel",
    variantName: "Protocol 11",
    finish: "Plain",
    serial: "FB-1-DE-705527",
    renderUrl: "/media/showcase/card-4x5-1080.png",
    thumbnailUrl: "/media/showcase/card-4x5-1080.png",
    favourite: true,
    collectionId: "col_protocol",
    collectionSlug: "protocol-11",
    collectionName: "Protocol 11",
    collectionBannerUrl: "/media/showcase/card-16x9-1920.png",
    collectionLogoUrl: "/art/collections/protocol-11.svg",
  },
  {
    id: "ins_02",
    cardId: "crd_ronin",
    cardName: "Ronin-9",
    variantName: "Neon Alley",
    finish: "Silver",
    serial: "FB-1-DE-6A448B",
    renderUrl: "/media/showcase/card-1x1-1080.png",
    thumbnailUrl: "/media/showcase/card-1x1-1080.png",
    favourite: true,
    collectionId: "col_neon",
    collectionSlug: "neon-alley",
    collectionName: "Neon Alley",
    collectionBannerUrl: "/media/showcase/finish-mastery-16x9-1920.png",
    collectionLogoUrl: "/art/collections/shared.svg",
  },
  {
    id: "ins_03",
    cardId: "crd_moss",
    cardName: "Moss",
    variantName: "Binder desk",
    finish: "Gold",
    serial: "FB-32-JU-F0C4DD",
    renderUrl: "/media/showcase/card-9x16-1080.png",
    thumbnailUrl: "/media/showcase/card-9x16-1080.png",
    favourite: false,
    collectionId: "col_neon",
    collectionSlug: "neon-alley",
    collectionName: "Neon Alley",
    collectionBannerUrl: "/media/showcase/finish-mastery-16x9-1920.png",
    collectionLogoUrl: "/art/collections/shared.svg",
  },
];

const badges = [
  { id: "ach_first", name: "First card", category: "milestone", artKey: "medal-first", collectionLogoUrl: null },
  { id: "ach_protocol", name: "Protocol complete", category: "collection", artKey: "medal-collection", collectionLogoUrl: "/art/collections/protocol-11.svg" },
  { id: "ach_mastery", name: "Finish mastery", category: "mastery", artKey: "medal-mastery", collectionLogoUrl: null },
];

export const profileOptionsFixture: ProfilePresentationOptions = {
  collections: [
    {
      id: "col_protocol",
      slug: "protocol-11",
      name: "Protocol 11",
      logoUrl: "/art/collections/protocol-11.svg",
      bannerUrl: "/media/showcase/card-16x9-1920.png",
    },
    {
      id: "col_neon",
      slug: "neon-alley",
      name: "Neon Alley",
      logoUrl: "/art/collections/shared.svg",
      bannerUrl: "/media/showcase/finish-mastery-16x9-1920.png",
    },
  ],
  copies,
  badges,
};

export const profilePresentationFixture: ResolvedProfilePresentation = {
  version: 1,
  avatar: {
    kind: "default",
    defaultKey: "keeper",
    label: "The Keeper",
    src: "/avatars/default/keeper-256.png",
    srcSet: "/avatars/default/keeper-64.png 64w, /avatars/default/keeper-128.png 128w, /avatars/default/keeper-256.png 256w",
    assetId: null,
    updatedAt: null,
    fallback: false,
    note: "Foilbury's cabinet mascot.",
  },
  selection: {
    portrait: "collection:col_protocol",
    banner: "collection:col_protocol",
    frame: "signal",
    avatarDecoration: "ring",
    nameTreatment: "wide",
    effect: "sheen",
    featuredInstanceId: "ins_01",
    favouriteInstanceIds: ["ins_01", "ins_02"],
    badgeIds: ["ach_first", "ach_protocol"],
  },
  portrait: {
    key: "collection:col_protocol",
    kind: "collection",
    label: "Protocol 11",
    imageUrl: "/art/collections/protocol-11.svg",
  },
  banner: {
    key: "collection:col_protocol",
    kind: "collection",
    label: "Protocol 11",
    imageUrl: "/media/showcase/card-16x9-1920.png",
    assetId: null,
  },
  featured: copies[0]!,
  favourites: [copies[0]!, copies[1]!],
  badges: badges.slice(0, 2),
  fallbackNotes: [],
};
