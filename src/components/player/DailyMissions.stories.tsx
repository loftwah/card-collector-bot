import type { Meta, StoryObj } from "@storybook/react-vite";
import DailyMissions from "@/components/player/DailyMissions";

const initial = {
  period_key: "2026-11-07",
  day: "2026-11-07",
  reset_at: "2026-11-08T00:00:00.000Z",
  reset_local: "2026/11/08 11:00",
  cap: 3,
  earned_today: 120,
  currency_symbol: "Foil",
  missions: [
    {
      key: "open-one",
      title: "Open one capsule",
      description: "Use your allowance or saved Foil on any eligible capsule.",
      reward: 40,
      progress: 1,
      target: 1,
      complete: true,
      claimed: false,
      claimable: true,
      href: "/play/draw",
      action: "Open a capsule",
      claimed_at: null,
    },
    {
      key: "inspect-three",
      title: "Inspect three cards",
      description: "Turn a card over and look at the back of three owned copies.",
      reward: 30,
      progress: 2,
      target: 3,
      complete: false,
      claimed: false,
      claimable: false,
      href: "/play/collection",
      action: "Inspect cards",
      claimed_at: null,
    },
    {
      key: "daily-visit",
      title: "Visit your collection",
      description: "Return to the cabinet and check today's shelf.",
      reward: 50,
      progress: 1,
      target: 1,
      complete: true,
      claimed: true,
      claimable: false,
      href: "/play",
      action: "Go to your library",
      claimed_at: "2026-11-07T01:10:00.000Z",
    },
  ],
};

const meta = {
  title: "Foilbury components/DailyMissions",
  component: DailyMissions,
  args: { initial },
  parameters: { layout: "padded" },
  tags: ["autodocs"],
} satisfies Meta<typeof DailyMissions>;

export default meta;
type Story = StoryObj<typeof meta>;

export const MixedProgress: Story = {};

export const Empty: Story = {
  args: {
    initial: {
      ...initial,
      missions: [],
      earned_today: 0,
      cap: 3,
    },
  },
};

export const AllClaimed: Story = {
  args: {
    initial: {
      ...initial,
      earned_today: 120,
      missions: initial.missions.map((mission) => ({
        ...mission,
        complete: true,
        claimed: true,
        claimable: false,
        progress: mission.target,
      })),
    },
  },
};

export const PhoneWidth: Story = {
  parameters: {
    viewport: { defaultViewport: "phone390" },
  },
};
