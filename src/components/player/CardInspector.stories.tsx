import type { Meta, StoryObj } from "@storybook/react-vite";
import CardInspector from "@/components/player/CardInspector";

const meta = {
  title: "Foilbury card/CardInspector",
  component: CardInspector,
  args: {
    frontUrl: "/media/showcase/card-4x5-1080.png",
    backUrl: "/art/layers/card-back.png",
    name: "Kestrel",
    subtitle: "Protocol 11",
    finish: "Holographic",
    collection: "Neon Alley",
    serial: "FB-1-DE-705527",
  },
  parameters: { layout: "centered" },
  tags: ["autodocs"],
} satisfies Meta<typeof CardInspector>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const OpenOnFlippedBack: Story = {
  args: { initialEnabled: true, initialFlipped: true },
};

export const LongName: Story = {
  args: {
    name: "The Collector Who Kept Every Plain Card",
    subtitle: "A very long collection subtitle that must remain readable",
    collection: "The Longest Collection Name in the Cabinet",
  },
};

export const MissingBack: Story = {
  args: { backUrl: null },
};
