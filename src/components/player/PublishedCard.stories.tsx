import type { Meta, StoryObj } from "@storybook/react-vite";
import PublishedCard from "@/components/player/PublishedCard";

const meta = {
  title: "Foilbury card/PublishedCard",
  component: PublishedCard,
  args: {
    frontUrl: "/media/showcase/card-4x5-1080.png",
    backUrl: "/art/layers/card-back.png",
    name: "Kestrel",
    serial: "FB-1-DE-705527",
    href: "#inspect",
    inspectHref: "#inspect",
  },
  parameters: { layout: "centered" },
  tags: ["autodocs"],
} satisfies Meta<typeof PublishedCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const LongNameAndNoBack: Story = {
  args: {
    name: "The Collector Who Kept Every Plain Card",
    serial: "FB-32-JU-F0C4DD",
    backUrl: null,
  },
};

export const DisplayOnly: Story = {
  args: { showToolbar: false, href: undefined, inspectHref: undefined },
};

export const PhoneWidth: Story = {
  parameters: {
    viewport: { defaultViewport: "phone390" },
    layout: "padded",
  },
};
