import type { Meta, StoryObj } from "@storybook/react-vite";
import RewardCenter from "@/components/player/RewardCenter";

const meta = {
  title: "Foilbury components/RewardCenter",
  component: RewardCenter,
  args: {
    dailyReward: 120,
    canClaimDaily: true,
    nextEligible: null,
    sets: [
      {
        id: "set_protocol",
        name: "Protocol 11 — first set",
        version: 1,
        reward_amount: 320,
        total: 8,
        owned: 8,
        complete: true,
        claimed: false,
      },
      {
        id: "set_neon",
        name: "Neon Alley — core roster",
        version: 2,
        reward_amount: 640,
        total: 40,
        owned: 19,
        complete: false,
        claimed: false,
      },
      {
        id: "set_binder",
        name: "Binder desk — starter set",
        version: 1,
        reward_amount: 120,
        total: 6,
        owned: 6,
        complete: true,
        claimed: true,
      },
    ],
  },
  parameters: { layout: "padded" },
  tags: ["autodocs"],
} satisfies Meta<typeof RewardCenter>;

export default meta;
type Story = StoryObj<typeof meta>;

export const MixedProgress: Story = {};

export const Cooldown: Story = {
  args: {
    canClaimDaily: false,
    nextEligible: "2026-11-08T00:00:00.000Z",
  },
};

export const Empty: Story = {
  args: { sets: [] },
};
