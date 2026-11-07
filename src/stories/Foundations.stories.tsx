import type { Meta, StoryObj } from "@storybook/react-vite";

const tokens = [
  ["--paper", "Page"],
  ["--paper-2", "Panel"],
  ["--paper-3", "Raised"],
  ["--ink", "Primary text"],
  ["--muted", "Secondary text"],
  ["--line", "Hairline"],
  ["--brass", "Action"],
  ["--green", "Positive ledger"],
  ["--saffron", "Pending"],
  ["--oxblood", "Destructive"],
];

function TokenBoard() {
  return (
    <div className="storybook-stack">
      <section className="storybook-frame">
        <h2 className="display-sm">Surface and signal</h2>
        <p className="storybook-note">
          The shell is quiet; the cards and collection artwork carry the personality. These are the
          live CSS custom properties, not a second palette.
        </p>
        <div className="storybook-row" style={{ alignItems: "stretch" }}>
          {tokens.map(([token, label]) => (
            <div className="storybook-swatch" key={token}>
              <div
                className="storybook-swatch__chip"
                style={{ background: `var(${token})` }}
                aria-hidden="true"
              />
              <strong>{label}</strong>
              <code>{token}</code>
            </div>
          ))}
        </div>
      </section>

      <section className="storybook-frame">
        <h2 className="display-sm">Type and number</h2>
        <div className="storybook-type-row">
          <span className="eyebrow">Collection · Protocol 11</span>
          <strong className="display-lg">The cards lead.</strong>
          <span>Body copy uses Manrope and stays readable at 200% zoom.</span>
          <code>FB-1-DE-705527 · 80 Foil · 0.40%</code>
        </div>
      </section>

      <section className="storybook-frame">
        <h2 className="display-sm">Card contract</h2>
        <p className="storybook-note">
          One 5:7 object, a reserved art window and an information band. Controls live outside the
          object. Member surfaces use the saved front and back renders.
        </p>
      </section>
    </div>
  );
}

const meta = {
  title: "Foundations/Tokens and type",
  component: TokenBoard,
  parameters: { layout: "padded" },
} satisfies Meta<typeof TokenBoard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
