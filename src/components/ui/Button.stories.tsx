import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "@/components/ui/button";

const meta = {
  title: "Controls/Button",
  component: Button,
  args: {
    children: "Open a capsule",
    variant: "primary",
    size: "md",
  },
  argTypes: {
    variant: { control: "select", options: ["primary", "secondary", "ghost", "danger", "brass"] },
    size: { control: "select", options: ["sm", "md", "lg", "icon"] },
  },
  tags: ["autodocs"],
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Primary: Story = {};

export const Variants: Story = {
  render: (args) => (
    <div className="storybook-stack">
      <p className="storybook-note">
        One primary action per view. Quiet and destructive actions keep their own hierarchy.
      </p>
      <div className="storybook-row">
        <Button {...args} variant="primary">Open a capsule</Button>
        <Button {...args} variant="secondary">Choose a collection</Button>
        <Button {...args} variant="ghost">Cancel</Button>
        <Button {...args} variant="danger">Remove from wishlist</Button>
      </div>
      <div className="storybook-row">
        <Button {...args} size="sm">Small</Button>
        <Button {...args} size="md">Medium</Button>
        <Button {...args} size="lg">Large</Button>
      </div>
    </div>
  ),
};

export const LongLabelAndDisabled: Story = {
  render: () => (
    <div className="storybook-stack">
      <Button>Open the Protocol 11 capsule for 80 Foil</Button>
      <Button disabled>Not enough Foil</Button>
      <p className="storybook-note">
        A disabled primary action keeps the reason visible in the surrounding copy; it is never a
        dead button without an explanation.
      </p>
    </div>
  ),
};
