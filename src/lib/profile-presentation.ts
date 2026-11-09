export const PROFILE_FRAMES = ["none", "hairline", "double", "signal"] as const;
export const PROFILE_AVATAR_DECORATIONS = ["none", "ring", "corner", "stamp"] as const;
export const PROFILE_NAME_TREATMENTS = ["plain", "wide", "boxed"] as const;
export const PROFILE_EFFECTS = ["none", "sheen", "edge"] as const;

export type ProfileFrame = (typeof PROFILE_FRAMES)[number];
export type ProfileAvatarDecoration = (typeof PROFILE_AVATAR_DECORATIONS)[number];
export type ProfileNameTreatment = (typeof PROFILE_NAME_TREATMENTS)[number];
export type ProfileEffect = (typeof PROFILE_EFFECTS)[number];

export interface ProfilePresentationSelection {
  portrait: string;
  banner: string;
  frame: ProfileFrame;
  avatarDecoration: ProfileAvatarDecoration;
  nameTreatment: ProfileNameTreatment;
  effect: ProfileEffect;
  featuredInstanceId: string | null;
  favouriteInstanceIds: string[];
  badgeIds: string[];
}

export const DEFAULT_PROFILE_PRESENTATION: ProfilePresentationSelection = {
  portrait: "mascot",
  banner: "none",
  frame: "none",
  avatarDecoration: "none",
  nameTreatment: "plain",
  effect: "none",
  featuredInstanceId: null,
  favouriteInstanceIds: [],
  badgeIds: [],
};

export const PROFILE_FRAME_LABELS: Record<ProfileFrame, string> = {
  none: "No frame",
  hairline: "Hairline",
  double: "Double rule",
  signal: "Signal rule",
};

export const PROFILE_AVATAR_DECORATION_LABELS: Record<ProfileAvatarDecoration, string> = {
  none: "None",
  ring: "Ring",
  corner: "Corner marks",
  stamp: "Stamp",
};

export const PROFILE_NAME_TREATMENT_LABELS: Record<ProfileNameTreatment, string> = {
  plain: "Plain",
  wide: "Wide tracking",
  boxed: "Boxed",
};

export const PROFILE_EFFECT_LABELS: Record<ProfileEffect, string> = {
  none: "None",
  sheen: "Soft sheen",
  edge: "Accent edge",
};
