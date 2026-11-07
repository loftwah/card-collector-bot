import type { Meta, StoryObj } from "@storybook/react-vite";
import { Badge } from "@/components/ui/badge";

const meta = {
  title: "Controls/Badge",
  component: Badge,
  args: { children: "Plain" },
  argTypes: {
    variant: { control: "select", options: ["default", "secondary", "destructive", "outline", "ghost", "link"] },
  },
  tags: ["autodocs"],
} satisfies Meta<typeof Badge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Finishes: Story = {
  render: () => (
    <div className="storybook-stack">
      <div className="storybook-row">
        <Badge variant="secondary">Plain</Badge>
        <Badge variant="secondary">Silver</Badge>
        <Badge>Gold</Badge>
        <Badge variant="outline">Holographic</Badge>
      </div>
      <p className="storybook-note">
        Finish is always named in text as well as colour. Holographic Gold is Holographic, not a
        second Gold.
      </p>
    </div>
  ),
};

export const Status: Story = {
  render: () => (
    <div className="storybook-row">
      <Badge variant="secondary">Owned</Badge>
      <Badge variant="outline">Preview only</Badge>
      <Badge variant="destructive">Revoked</Badge>
      <Badge variant="ghost">Expired</Badge>
    </div>
  ),
};
