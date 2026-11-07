import type { Meta, StoryObj } from "@storybook/react-vite";
import ProfileCustomiser from "@/components/player/ProfileCustomiser";
import {
  profileLooksFixture,
  profileOptionsFixture,
  profilePresentationFixture,
} from "@/stories/profile-fixtures";

const meta = {
  title: "Foilbury components/ProfileCustomiser",
  component: ProfileCustomiser,
  args: {
    initialLook: "quiet",
    initialBio: "Collecting quiet cards and loud covers.",
    looks: profileLooksFixture,
    presentation: profilePresentationFixture,
    options: profileOptionsFixture,
  },
  parameters: { layout: "padded" },
  tags: ["autodocs"],
} satisfies Meta<typeof ProfileCustomiser>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SavedLook: Story = {};

export const EmptyCollection: Story = {
  args: {
    initialBio: "",
    presentation: {
      ...profilePresentationFixture,
      selection: {
        ...profilePresentationFixture.selection,
        featuredInstanceId: null,
        favouriteInstanceIds: [],
        badgeIds: [],
      },
      featured: null,
      favourites: [],
      badges: [],
      portrait: { key: "monogram", kind: "monogram", label: "Monogram", imageUrl: null },
      banner: { key: "none", kind: "none", label: "No banner", imageUrl: null },
    },
    options: { collections: [], copies: [], badges: [] },
  },
};

export const UnavailableSavedChoice: Story = {
  args: {
    presentation: {
      ...profilePresentationFixture,
      selection: {
        ...profilePresentationFixture.selection,
        featuredInstanceId: "ins_missing",
        favouriteInstanceIds: ["ins_missing", "ins_02"],
        badgeIds: ["ach_missing", "ach_first"],
      },
      featured: profileOptionsFixture.copies[1]!,
      favourites: [profileOptionsFixture.copies[1]!],
      badges: [profileOptionsFixture.badges[0]!],
      fallbackNotes: [
        "The featured copy is no longer in your collection. Showing your first available favourite.",
        "The chosen portrait is no longer available. Showing your monogram.",
      ],
    },
  },
};

export const MaximumNote: Story = {
  args: {
    initialBio:
      "A collection built slowly from daily allowances, traded duplicates and a stubborn refusal to recycle the first card I ever pulled.",
  },
};

export const PhoneWidth: Story = {
  parameters: {
    viewport: { defaultViewport: "phone390" },
  },
};
