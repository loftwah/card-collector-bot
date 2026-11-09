import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import DailyMissions from "@/components/player/DailyMissions";
import ProfileCustomiser from "@/components/player/ProfileCustomiser";
import PublishedCard from "@/components/player/PublishedCard";
import {
  profileLooksFixture,
  profileOptionsFixture,
  profilePresentationFixture,
} from "@/stories/profile-fixtures";

const missionState = {
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
  ],
};

function MemberHead({ title, lede, aside }: { title: string; lede: string; aside?: ReactNode }) {
  return (
    <header className="member-head">
      <div className="member-head__copy">
        <h1 className="page-title">{title}</h1>
        <p className="member-head__lede">{lede}</p>
      </div>
      {aside ? <div className="member-head__aside">{aside}</div> : null}
    </header>
  );
}

function MissionComposition() {
  return (
    <main className="member-page">
      <MemberHead
        title="Missions"
        lede="Optional daily goals. They use the same wallet and ledger as everything else and never ask you to post, invite or spend."
        aside={
          <dl className="member-stats">
            <div className="member-stat">
              <dt>Earned today</dt>
              <dd>Foil 120 <span>/ 3</span></dd>
            </div>
            <div className="member-stat">
              <dt>Ready to claim</dt>
              <dd>1</dd>
            </div>
          </dl>
        }
      />
      <div className="mt-6">
        <DailyMissions initial={missionState} />
      </div>
    </main>
  );
}

function ProfileComposition() {
  return (
    <main className="member-page">
      <MemberHead
        title="Collector profile"
        lede="Your chosen look, featured copy and the shelf you want people to see."
      />
      <div className="profile-page" data-profile-look="quiet">
        <section className="profile-section">
          <div className="profile-section__head">
            <h2 className="profile-section__title">Featured specimen</h2>
            <a className="profile-section__link" href="/play/collection">Manage favourites →</a>
          </div>
          <div className="profile-feature">
            <PublishedCard
              frontUrl="/media/showcase/card-4x5-1080.png"
              backUrl="/art/layers/card-back.png"
              name="Kestrel"
              serial="FB-1-DE-705527"
              inspectHref="/play/card/ins_01"
            />
            <div>
              <p className="eyebrow">Protocol 11 · Plain</p>
              <h2 className="display-md">Kestrel</h2>
              <p className="storybook-note">
                A quiet pull from the first capsule. The saved front and back are shown exactly as
                they were issued.
              </p>
            </div>
          </div>
        </section>
        <ProfileCustomiser
          displayName="Dean"
          avatar={profilePresentationFixture.avatar}
          initialLook="quiet"
          initialBio="Collecting quiet cards and loud covers."
          looks={profileLooksFixture}
          presentation={profilePresentationFixture}
          options={profileOptionsFixture}
        />
      </div>
    </main>
  );
}

const meta = {
  title: "Screen compositions/Member surfaces",
  component: MissionComposition,
  parameters: { layout: "fullscreen" },
  tags: ["autodocs"],
} satisfies Meta<typeof MissionComposition>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Missions: Story = {};

export const Profile: Story = {
  render: () => <ProfileComposition />,
};

export const PhoneMissions: Story = {
  parameters: {
    viewport: { defaultViewport: "phone390" },
  },
};

export const PhoneProfile: Story = {
  render: () => <ProfileComposition />,
  parameters: {
    viewport: { defaultViewport: "phone390" },
  },
};
