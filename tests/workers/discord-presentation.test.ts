import { describe, expect, it } from "vitest";
import { audienceRank as domainAudienceRank } from "../../src/server/modules/visibility";
import {
  CONTACT_SHEET_DISCLAIMER,
  DISCORD_LIMITS,
  FOILBURY_PALETTE,
  PresentationError,
  REVEAL_RECEIPT_FIELDS,
  achievementMessage,
  albumProgressMessage,
  assertDiscordMessage,
  attachmentReference,
  audienceRank,
  buildActionRow,
  buildActionRows,
  buildAttachment,
  buildButton,
  buildEmbed,
  buildFields,
  buildMessage,
  capsulePickerMessage,
  clipText,
  cardFaceMessage,
  contactSheetHtml,
  contactSheetJson,
  missionProgressMessage,
  profileMessage,
  revealReceiptMessage,
  safeAttachmentFilename,
  sharePromptMessage,
  stateFromError,
  stateMessage,
  welcomeMessage,
  type RevealReceiptInput,
  type ShareItem,
} from "../../src/server/discord/presentation";
import type { DiscordCallback, DiscordEmbed, DiscordMessage } from "../../src/server/discord/types";

function firstEmbed(callback: DiscordCallback): DiscordEmbed {
  const embed = callback.data?.embeds?.[0];
  if (!embed) throw new Error("Expected an embed.");
  return embed;
}

function fieldValue(callback: DiscordCallback, name: string): string {
  return firstEmbed(callback).fields?.find((field) => field.name === name)?.value ?? "";
}

function expectPresentationError(
  run: () => unknown,
  code: PresentationError["code"],
): PresentationError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(PresentationError);
    const presentation = error as PresentationError;
    expect(presentation.code).toBe(code);
    return presentation;
  }
  throw new Error(`Expected PresentationError ${code}.`);
}

function privateResponse(callback: DiscordCallback): boolean {
  return ((callback.data?.flags ?? 0) & 64) === 64;
}

const welcomeInput = {
  displayName: "Dean",
  scopeName: "Foilbury Cabinet",
  balance: 320,
  currencySymbol: "✦",
  dailyAvailable: true,
  nextDailyAt: null,
  starterGrant: 350,
  dailyReward: 120,
  actions: {
    daily: "foilbury:daily",
    open: "foilbury:open:cabinet-draw",
    packs: "foilbury:packs",
  },
  helpUrl: "https://foilbury.test/help",
};

const capsuleInput = {
  scopeName: "Foilbury Cabinet",
  currencySymbol: "✦",
  balance: 320,
  capsules: [
    {
      slug: "cabinet-draw",
      name: "Cabinet Draw",
      price: 80,
      eligibleCount: 16,
      odds: [
        { label: "Plain", probabilityBps: 6000 },
        { label: "Silver", probabilityBps: 2500 },
      ],
    },
    {
      slug: "late-night",
      name: "Late Night",
      price: 120,
      eligibleCount: 4,
    },
  ],
};

const render = {
  r2Key: "tenants/ten_presentation/renders/card.webp",
  mime: "image/webp",
  width: 750,
  height: 1050,
};

const revealBase: RevealReceiptInput = {
  card_id: "crd_presentation_card",
  variant_id: "var_presentation_variant",
  card_name: "Pippa",
  variant_name: "Plain",
  material_key: "paper",
  effect_key: null,
  render_url: "/media/render/asset_presentation",
  serial: "FB-1-DE-513D6B",
  pool_name: "Cabinet Draw",
  price: 80,
  currency: { name: "Foil", symbol: "✦" },
  balance_after: 390,
  probability_bps: 1250,
  drawn_at: "2026-11-03T05:00:00.000Z",
  replayed: false,
  rarity_name: "Common",
  audience: "members",
  channel_audience: "members",
  channel_approved: true,
  render,
  open_custom_id: "foilbury:open:cabinet-draw",
  collection_custom_id: "foilbury:collection",
  tour_custom_id: "foilbury:tour:progress",
  album_url: "https://foilbury.test/play/collection",
  public_origin: "https://foilbury.test",
};

function reveal(overrides: Partial<RevealReceiptInput> = {}): DiscordCallback {
  return revealReceiptMessage({ ...revealBase, ...overrides });
}

describe("welcome template", () => {
  it("emits the exact reusable payload shape", () => {
    expect(welcomeMessage(welcomeInput)).toEqual({
      type: 4,
      data: {
        embeds: [
          {
            title: "Welcome to Foilbury",
            description:
              "**Welcome, Dean.** A collector's cabinet in **Foilbury Cabinet**. Claim the free allowance, choose a capsule, and keep the copy. Nothing is charged until you press an open button.",
            color: FOILBURY_PALETTE.electricAqua,
            fields: [
              { name: "Your balance", value: "320 ✦", inline: true },
              { name: "Daily allowance", value: "Ready now", inline: true },
              {
                name: "First run",
                value:
                  "+350 ✦ once. 120 ✦ every day, shared by this Bot across Discord, the website and the API.",
                inline: false,
              },
              {
                name: "Free to look",
                value:
                  "Inspect either face, open your album and read every detail without spending Foil or receiving another copy.",
                inline: false,
              },
            ],
            footer: { text: "Foilbury · Foilbury Cabinet · private response" },
          },
        ],
        components: [
          {
            type: 1,
            components: [
              { type: 2, style: 1, label: "Claim daily", custom_id: "foilbury:daily" },
              {
                type: 2,
                style: 1,
                label: "Open a capsule",
                custom_id: "foilbury:open:cabinet-draw",
              },
              { type: 2, style: 2, label: "Browse capsules", custom_id: "foilbury:packs" },
            ],
          },
          {
            type: 1,
            components: [
              {
                type: 2,
                style: 5,
                label: "Read the field guide",
                url: "https://foilbury.test/help",
              },
            ],
          },
        ],
        allowed_mentions: { parse: [] },
        flags: 64,
      },
    });
  });
});

describe("Discord limits", () => {
  it("truncates title, description, field and button copy", () => {
    const titleEmbed = buildEmbed({ title: "A".repeat(300) });
    expect(titleEmbed.title).toHaveLength(DISCORD_LIMITS.embedTitle);
    expect(titleEmbed.title?.endsWith("…")).toBe(true);

    const descriptionEmbed = buildEmbed({
      title: "Description limit",
      description: "B".repeat(5000),
    });
    expect(descriptionEmbed.description).toHaveLength(DISCORD_LIMITS.embedDescription);

    const fieldEmbed = buildEmbed({
      title: "Field limit",
      fields: [{ name: "C".repeat(300), value: "D".repeat(2000), inline: false }],
    });
    expect(fieldEmbed.fields?.[0]?.name).toHaveLength(DISCORD_LIMITS.fieldName);
    expect(fieldEmbed.fields?.[0]?.value).toHaveLength(DISCORD_LIMITS.fieldValue);

    const footerEmbed = buildEmbed({ title: "Footer limit", footer: "E".repeat(3000) });
    expect(footerEmbed.footer?.text).toHaveLength(DISCORD_LIMITS.footer);

    const button = buildButton({ label: "A".repeat(100), customId: "foilbury:test" });
    expect(button.label).toHaveLength(DISCORD_LIMITS.buttonLabel);
    expect(button.label?.endsWith("…")).toBe(true);

    const emojiClip = clipText("😀".repeat(100), 80);
    expect(emojiClip.length).toBeLessThanOrEqual(80);
    expect(emojiClip.endsWith("…")).toBe(true);
    expect(/[\uD800-\uDBFF]$/.test(emojiClip)).toBe(false);
  });

  it("caps inline fields at five without dropping data", () => {
    const fields = buildFields(
      Array.from({ length: 6 }, (_, index) => ({
        name: `Field ${index + 1}`,
        value: `Value ${index + 1}`,
        inline: true,
      })),
    );
    expect(fields).toHaveLength(6);
    expect(fields.slice(0, 5).every((field) => field.inline)).toBe(true);
    expect(fields[5]?.inline).toBe(false);
  });

  it("rejects structural overflows and unsafe custom ids", () => {
    expectPresentationError(
      () =>
        buildEmbed({
          title: "Too many fields",
          fields: Array.from({ length: 26 }, (_, index) => ({
            name: `Field ${index}`,
            value: "Value",
          })),
        }),
      "discord_limit",
    );
    expectPresentationError(
      () =>
        buildEmbed({
          title: "Oversized field budget",
          fields: Array.from({ length: 25 }, () => ({
            name: "Field",
            value: "V".repeat(DISCORD_LIMITS.fieldValue),
          })),
        }),
      "discord_limit",
    );
    expectPresentationError(
      () =>
        buildActionRows(
          Array.from({ length: 6 }, (_, index) => [
            { label: `Action ${index}`, customId: `foilbury:test:${index}` },
          ]),
        ),
      "discord_limit",
    );
    expectPresentationError(
      () =>
        buildActionRow(
          Array.from({ length: 6 }, (_, index) => ({
            label: `Action ${index}`,
            customId: `foilbury:test:${index}`,
          })),
        ),
      "discord_limit",
    );
    const longCustomId = `foilbury:${"a".repeat(92)}`;
    expect(longCustomId.length).toBe(101);
    expectPresentationError(
      () => buildButton({ label: "Action", customId: longCustomId }),
      "discord_limit",
    );
    expectPresentationError(
      () => buildButton({ label: "Uppercase", customId: "foilbury:Bad" }),
      "invalid_button",
    );
  });

  it("supports valid URL-only buttons and rejects mixed button shapes", () => {
    expect(
      buildButton({ label: "Open album", url: "https://foilbury.test/play/collection" }),
    ).toEqual({
      type: 2,
      style: 5,
      label: "Open album",
      url: "https://foilbury.test/play/collection",
    });
    expectPresentationError(
      () => buildButton({ label: "Open album", url: "/relative" }),
      "invalid_url",
    );

    const raw = (button: Record<string, unknown>): DiscordMessage => ({
      embeds: [{ title: "Test" }],
      components: [{ type: 1, components: [button as never] }],
    });
    expectPresentationError(
      () =>
        assertDiscordMessage(raw({ type: 2, style: 2, label: "Action", url: "https://x.test" })),
      "invalid_button",
    );
    expectPresentationError(
      () =>
        assertDiscordMessage(
          raw({
            type: 2,
            style: 5,
            label: "Link",
            custom_id: "foilbury:test",
            url: "https://x.test",
          }),
        ),
      "invalid_button",
    );
    expect(() =>
      assertDiscordMessage(
        raw({ type: 2, style: 5, label: "Link", url: "https://foilbury.test/play" }),
      ),
    ).not.toThrow();
  });

  it("rejects emoji-only semantics", () => {
    expectPresentationError(
      () => buildButton({ label: "🎉", customId: "foilbury:test" }),
      "invalid_input",
    );
    expectPresentationError(
      () => buildEmbed({ title: "🎉", description: "Party" }),
      "invalid_input",
    );
  });
});

describe("private identifiers and sensitive copy", () => {
  it("rejects secrets, emails and raw account ids in visible copy", () => {
    expectPresentationError(
      () => buildEmbed({ title: "Owner email owner@example.com", description: "Private" }),
      "private_identifier",
    );
    expectPresentationError(
      () => buildEmbed({ title: "Token sk_live_abcdefghijkl", description: "Private" }),
      "private_identifier",
    );
    expectPresentationError(
      () => buildButton({ label: "usr_prod_owner", customId: "foilbury:test" }),
      "private_identifier",
    );
    expectPresentationError(
      () =>
        assertDiscordMessage({
          embeds: [{ title: "Member 123456789012345678", description: "Private" }],
        }),
      "private_identifier",
    );
  });

  it("never echoes a raw error message through the safe copy helper", () => {
    const callback = stateFromError({ code: "insufficient_funds" });
    expect(firstEmbed(callback).title).toBe("Not enough Foil");
    expect(firstEmbed(callback).description).toContain("Nothing was charged");
    expect(JSON.stringify(callback)).not.toContain("sk_live");
    expect(privateResponse(callback)).toBe(true);
  });
});

describe("reveal receipt parity", () => {
  it("declares the same committed fields as the Discord draw receipt", () => {
    expect([...REVEAL_RECEIPT_FIELDS]).toEqual([
      "card_id",
      "variant_id",
      "card_name",
      "variant_name",
      "material_key",
      "effect_key",
      "render_url",
      "serial",
      "pool_name",
      "price",
      "currency",
      "balance_after",
      "probability_bps",
      "drawn_at",
      "replayed",
    ]);
  });

  it("renders every visible domain field and keeps opaque ids out of copy", () => {
    const callback = reveal();
    const embed = firstEmbed(callback);
    expect(embed.title).toBe("Pippa — Plain");
    expect(embed.description).toContain("**Cabinet Draw**");
    expect(fieldValue(callback, "Rarity")).toBe("Common");
    expect(fieldValue(callback, "Finish")).toBe("Plain");
    expect(fieldValue(callback, "Serial")).toBe("`FB-1-DE-513D6B`");
    expect(fieldValue(callback, "Opened from")).toBe("Cabinet Draw · 80 ✦");
    expect(fieldValue(callback, "Opening debit")).toBe("−80 ✦");
    expect(fieldValue(callback, "Settled balance")).toBe("390 ✦");
    expect(fieldValue(callback, "Odds")).toBe("12.50% for this copy");
    expect(embed.timestamp).toBe(revealBase.drawn_at);
    expect(embed.footer?.text).toBe("Foilbury · committed receipt");
    expect(callback.attachments).toEqual([
      {
        r2Key: render.r2Key,
        filename: "foilbury-reveal-card.webp",
        contentType: "image/webp",
      },
    ]);
    expect(embed.image).toEqual({
      url: "attachment://foilbury-reveal-card.webp",
      width: 750,
      height: 1050,
    });
    const serialised = JSON.stringify(callback.data);
    expect(serialised).not.toContain(revealBase.card_id);
    expect(serialised).not.toContain(revealBase.variant_id);
    expect(callback.data?.components?.[0]?.components.map((button) => button.label)).toEqual([
      "Open again",
      "Collection",
      "Tour",
      "Open album",
    ]);
  });

  it("marks replayed receipts and explains that no second pull was made", () => {
    const callback = reveal({ replayed: true });
    expect(fieldValue(callback, "Recorded result")).toContain("No second pull");
  });

  it("uses render_url only for a verified public reveal", () => {
    const publicReveal = reveal({
      audience: "public",
      channel_audience: "public",
      channel_approved: true,
      render: null,
      render_url: "https://foilbury.test/media/render/asset_presentation",
    });
    expect(firstEmbed(publicReveal).image?.url).toBe(
      "https://foilbury.test/media/render/asset_presentation",
    );
    expect(privateResponse(publicReveal)).toBe(false);

    const memberReveal = reveal({
      audience: "members",
      channel_audience: "members",
      channel_approved: true,
      render: null,
      render_url: "https://foilbury.test/media/render/asset_presentation",
    });
    expect(firstEmbed(memberReveal).image).toBeUndefined();
    expect(fieldValue(memberReveal, "Artwork follow-up")).toContain("open your album");
  });

  it("keeps a reveal private when the channel is not verified", () => {
    const callback = reveal({ audience: "public", channel_approved: false });
    expect(privateResponse(callback)).toBe(true);
    expect(fieldValue(callback, "Private reveal")).toContain("has not been verified");
  });
});

describe("no accidental public responses", () => {
  it("defaults every template to a private response with no mentions", () => {
    const shareItems: ShareItem[] = [];
    const callbacks: Array<[string, DiscordCallback]> = [
      ["welcome", welcomeMessage(welcomeInput)],
      ["capsule picker", capsulePickerMessage(capsuleInput)],
      ["reveal", reveal({ channel_approved: false })],
      [
        "card face",
        cardFaceMessage({
          cardName: "Pippa",
          variantName: "Plain",
          materialKey: "paper",
          effectKey: null,
          side: "front",
          description: "A saved published render.",
          collectionName: "Cabinet",
          source: "Foilbury",
          serial: "FB-1-DE-513D6B",
          render,
          swapCustomId: "foilbury:card:crd:var:back",
          detailsCustomId: "foilbury:card:crd:var:details",
          albumUrl: "https://foilbury.test/play/collection",
        }),
      ],
      [
        "album progress",
        albumProgressMessage({
          albumName: "Cabinet",
          scopeName: "Foilbury Cabinet",
          ownedCards: 7,
          totalCards: 8,
          missing: ["Nora"],
          audience: "members",
          albumUrl: "https://foilbury.test/play/collections/cabinet",
        }),
      ],
      [
        "achievement",
        achievementMessage({
          name: "First trial",
          description: "Collect seven unique subjects.",
          state: "earned",
          progress: 7,
          target: 7,
          reward: 120,
          currencySymbol: "✦",
          audience: "members",
          earnedAt: "2026-11-03T05:00:00.000Z",
          albumUrl: "https://foilbury.test/play/achievements",
        }),
      ],
      [
        "mission progress",
        missionProgressMessage({
          day: "2026-11-03",
          resetAt: "2026-11-04T00:00:00.000Z",
          cap: 180,
          earnedToday: 60,
          currencySymbol: "✦",
          missions: [
            {
              key: "explore",
              title: "Visit a world",
              description: "Open any collection you can access.",
              progress: 1,
              target: 1,
              reward: 60,
              complete: true,
              claimed: true,
              claimable: false,
            },
          ],
        }),
      ],
      [
        "profile",
        profileMessage({
          displayName: "Dean",
          scopeName: "Foilbury Cabinet",
          currencySymbol: "✦",
          balance: 320,
          ownedCards: 7,
          dailyAvailable: true,
          profileUrl: "https://foilbury.test/play/profile",
        }),
      ],
      [
        "share prompt",
        sharePromptMessage({
          displayName: "Dean",
          channelLabel: "card-collector-test",
          channelAudience: "public",
          items: shareItems,
          privacyUrl: "https://foilbury.test/privacy",
        }),
      ],
      [
        "state",
        stateMessage({
          kind: "error",
          message: "The interaction stopped before a committed outcome.",
        }),
      ],
    ];
    for (const [label, callback] of callbacks) {
      expect(privateResponse(callback), label).toBe(true);
      expect(callback.data?.allowed_mentions, label).toEqual({ parse: [] });
      expect(callback.data?.content, label).toBeUndefined();
    }
  });

  it("refuses to make a channel response without audience proof", () => {
    const baseMessage = {
      embed: { title: "Card", description: "A saved published render." },
    };
    expectPresentationError(
      () =>
        buildMessage({
          ...baseMessage,
          visibility: "channel",
          audience: "private",
          channelAudience: "private",
          channelApproved: true,
        }),
      "channel_audience_unverified",
    );
    expectPresentationError(
      () =>
        buildMessage({
          ...baseMessage,
          visibility: "channel",
          audience: "members",
          channelAudience: "public",
          channelApproved: true,
        }),
      "channel_audience_unverified",
    );
    expectPresentationError(
      () =>
        buildMessage({
          ...baseMessage,
          visibility: "channel",
          audience: "members",
          channelAudience: "members",
          channelApproved: false,
        }),
      "channel_audience_unverified",
    );
    expect(privateResponse(reveal({ audience: "private", channel_approved: true }))).toBe(true);
    expect(privateResponse(reveal({ audience: "members", channel_audience: "public" }))).toBe(true);
  });

  it("does not share a private or narrower channel audience", () => {
    const callback = reveal({
      audience: "members",
      channel_audience: "members",
      channel_approved: false,
    });
    expect(privateResponse(callback)).toBe(true);
    expect(callback.data?.flags).toBe(64);
  });
});

describe("capsule picker", () => {
  it("shows price, odds and at most five primary choices", () => {
    const callback = capsulePickerMessage(capsuleInput);
    const embed = firstEmbed(callback);
    expect(embed.title).toBe("Choose a capsule");
    expect(fieldValue(callback, "Cabinet Draw")).toContain("80 ✦ · 16 eligible cards");
    expect(fieldValue(callback, "Cabinet Draw")).toContain("Plain 60.00%");
    expect(fieldValue(callback, "Cabinet Draw")).toContain("Silver 25.00%");
    expect(callback.data?.components?.[0]?.components).toHaveLength(2);
    expect(callback.data?.components?.[0]?.components[0]).toMatchObject({
      label: "Open Cabinet Draw · 80 ✦",
      custom_id: "foilbury:open:cabinet-draw",
      style: 1,
    });
    expect(privateResponse(callback)).toBe(true);

    const many = capsulePickerMessage({
      ...capsuleInput,
      capsules: Array.from({ length: 6 }, (_, index) => ({
        slug: `capsule-${index}`,
        name: `Capsule ${index}`,
        price: 80 + index,
        eligibleCount: 4,
      })),
      browseUrl: "https://foilbury.test/play/collections",
    });
    expect(many.data?.components?.[0]?.components).toHaveLength(5);
    expect(many.data?.components?.[1]?.components[0]).toMatchObject({
      style: 5,
      url: "https://foilbury.test/play/collections",
    });
  });

  it("renders a designed empty state when no capsule has eligible cards", () => {
    const callback = capsulePickerMessage({ ...capsuleInput, capsules: [] });
    expect(firstEmbed(callback).title).toBe("No capsule is ready");
    expect(privateResponse(callback)).toBe(true);
  });
});

describe("card faces and albums", () => {
  it("uses the saved render with a per-side safe attachment name", () => {
    const common = {
      cardName: "Pippa",
      variantName: "Plain",
      materialKey: "paper",
      effectKey: null,
      description: "The saved published render.",
      collectionName: "Cabinet",
      source: "Foilbury",
      render,
      detailsCustomId: "foilbury:card:crd:var:details",
      albumUrl: "https://foilbury.test/play/collection",
    };
    const front = cardFaceMessage({
      ...common,
      side: "front",
      swapCustomId: "foilbury:card:crd:var:back",
    });
    const back = cardFaceMessage({
      ...common,
      side: "back",
      swapCustomId: "foilbury:card:crd:var:front",
    });
    expect(firstEmbed(front).image?.url).toBe("attachment://foilbury-card-front.webp");
    expect(front.attachments?.[0]?.filename).toBe("foilbury-card-front.webp");
    expect(firstEmbed(back).image?.url).toBe("attachment://foilbury-card-back.webp");
    expect(back.attachments?.[0]?.filename).toBe("foilbury-card-back.webp");
    expect(fieldValue(front, "Side")).toBe("Front");
    expect(fieldValue(back, "Side")).toBe("Back");
    expect(privateResponse(front)).toBe(true);
  });

  it("shows 7/8 and 8/8 without turning progress into a second metric", () => {
    const nearly = albumProgressMessage({
      albumName: "Three Killing Games",
      scopeName: "Foilbury Cabinet",
      ownedCards: 7,
      totalCards: 8,
      missing: ["Junko"],
      audience: "members",
      albumUrl: "https://foilbury.test/play/collections/three",
      canShareCompletion: true,
      shareCustomId: "foilbury:tourshare:completion:three",
    });
    expect(firstEmbed(nearly).title).toBe("Three Killing Games · 7/8");
    expect(fieldValue(nearly, "Progress")).toContain("7/8");
    expect(
      nearly.data?.components?.[0]?.components.some(
        (button) => button.label === "Share completion",
      ),
    ).toBe(false);

    const complete = albumProgressMessage({
      albumName: "Three Killing Games",
      scopeName: "Foilbury Cabinet",
      ownedCards: 8,
      totalCards: 8,
      audience: "public",
      albumUrl: "https://foilbury.test/play/collections/three",
      canShareCompletion: true,
      shareCustomId: "foilbury:tourshare:completion:three",
    });
    expect(firstEmbed(complete).title).toBe("Three Killing Games · complete");
    expect(firstEmbed(complete).color).toBe(FOILBURY_PALETTE.lime);
    expect(
      complete.data?.components?.[0]?.components.some(
        (button) => button.label === "Share completion",
      ),
    ).toBe(true);
    expect(privateResponse(complete)).toBe(true);
  });

  it("handles an empty roster without invalid progress", () => {
    const callback = albumProgressMessage({
      albumName: "Empty album",
      scopeName: "Foilbury Cabinet",
      ownedCards: 0,
      totalCards: 0,
      audience: "private",
      albumUrl: "https://foilbury.test/play/collections/empty",
    });
    expect(fieldValue(callback, "Progress")).toBe("No published subjects yet");
    expect(firstEmbed(callback).description).toContain("no published subjects");
  });
});

describe("achievement and mission progress", () => {
  it("makes earned state readable without colour alone", () => {
    const callback = achievementMessage({
      name: "Three schools",
      description: "Complete the release roster.",
      state: "earned",
      progress: 8,
      target: 8,
      reward: 640,
      currencySymbol: "✦",
      audience: "public",
      earnedAt: "2026-11-03T05:00:00.000Z",
      albumUrl: "https://foilbury.test/play/achievements",
      shareEligible: true,
      shareCustomId: "foilbury:tourshare:achievement:three",
    });
    expect(firstEmbed(callback).title).toBe("Three schools");
    expect(fieldValue(callback, "Status")).toBe("Earned");
    expect(fieldValue(callback, "Progress")).toBe("8/8");
    expect(fieldValue(callback, "Reward")).toBe("+640 ✦");
    expect(firstEmbed(callback).color).toBe(FOILBURY_PALETTE.lime);
    expect(
      callback.data?.components?.[0]?.components.some(
        (button) => button.label === "Share achievement",
      ),
    ).toBe(true);
  });

  it("does not offer a private achievement for sharing", () => {
    const callback = achievementMessage({
      name: "Private milestone",
      description: "A private album milestone.",
      state: "earned",
      progress: 4,
      target: 4,
      currencySymbol: "✦",
      audience: "private",
      shareEligible: true,
      shareCustomId: "foilbury:tourshare:achievement:private",
    });
    expect(
      Boolean(
        callback.data?.components?.[0]?.components.some(
          (button) => button.label === "Share achievement",
        ),
      ),
    ).toBe(false);
  });

  it("renders morning-to-claimed mission states with bounded buttons", () => {
    const callback = missionProgressMessage({
      day: "2026-11-03",
      resetAt: "2026-11-04T00:00:00.000Z",
      cap: 180,
      earnedToday: 60,
      currencySymbol: "✦",
      missions: [
        {
          key: "explore",
          title: "Visit a world",
          description: "Open any collection you can access.",
          progress: 1,
          target: 1,
          reward: 60,
          complete: true,
          claimed: false,
          claimable: true,
          claimCustomId: "foilbury:mission:claim:explore",
        },
        {
          key: "inspect",
          title: "Inspect a card",
          description: "Look at both faces.",
          progress: 1,
          target: 1,
          reward: 60,
          complete: true,
          claimed: true,
          claimable: false,
        },
        {
          key: "open",
          title: "Open a capsule",
          description: "Complete one intentional opening.",
          progress: 0,
          target: 1,
          reward: 60,
          complete: false,
          claimed: false,
          claimable: false,
        },
      ],
      refreshCustomId: "foilbury:mission:refresh",
      missionsUrl: "https://foilbury.test/play/missions",
    });
    expect(fieldValue(callback, "Visit a world · +60 ✦")).toContain("Ready to claim");
    expect(fieldValue(callback, "Inspect a card · +60 ✦")).toContain("Claimed");
    expect(fieldValue(callback, "Open a capsule · +60 ✦")).toContain("0/1");
    expect(callback.data?.components?.[0]?.components).toHaveLength(1);
    expect(callback.data?.components?.[1]?.components.map((button) => button.label)).toEqual([
      "Refresh missions",
      "Open missions on the web",
    ]);
    expect(privateResponse(callback)).toBe(true);
  });

  it("shows a real empty mission day instead of a blank embed", () => {
    const callback = missionProgressMessage({
      day: "2026-11-03",
      resetAt: "2026-11-04T00:00:00.000Z",
      cap: 180,
      earnedToday: 0,
      currencySymbol: "✦",
      missions: [],
    });
    expect(firstEmbed(callback).title).toBe("No missions assigned today");
    expect(privateResponse(callback)).toBe(true);
  });
});

describe("profile and share prompt", () => {
  it("keeps a profile private while showing real totals", () => {
    const callback = profileMessage({
      displayName: "Dean",
      scopeName: "Foilbury Cabinet",
      currencySymbol: "✦",
      balance: 320,
      ownedCards: 7,
      uniqueCards: 6,
      dailyAvailable: false,
      nextDailyAt: "2026-11-04T00:00:00.000Z",
      achievementsEarned: 3,
      publicBadgeCount: 1,
      profileUrl: "https://foilbury.test/play/profile",
    });
    expect(firstEmbed(callback).title).toBe("Dean");
    expect(fieldValue(callback, "Balance")).toBe("320 ✦");
    expect(fieldValue(callback, "Owned cards")).toBe("7");
    expect(fieldValue(callback, "Unique cards")).toBe("6");
    expect(fieldValue(callback, "Badges")).toBe("3 earned · 1 public");
    expect(privateResponse(callback)).toBe(true);
  });

  it("checks every offered share item against the channel audience", () => {
    const base = {
      displayName: "Dean",
      channelLabel: "card-collector-test",
      privacyUrl: "https://foilbury.test/privacy",
    };
    const publicItem: ShareItem = {
      label: "Share Pippa — Plain",
      kind: "card",
      audience: "public",
      customId: "foilbury:tourshare:card:crd",
    };
    const callback = sharePromptMessage({
      ...base,
      channelAudience: "members",
      items: [publicItem],
      privateItems: [{ label: "Member-only card", reason: "Channel is public" }],
    });
    expect(firstEmbed(callback).title).toBe("Share deliberately");
    expect(fieldValue(callback, "Ready to share")).toContain("Public showcase");
    expect(fieldValue(callback, "Stays private")).toContain("Member-only card");
    expect(privateResponse(callback)).toBe(true);

    expectPresentationError(
      () =>
        sharePromptMessage({
          ...base,
          channelAudience: "public",
          items: [{ ...publicItem, audience: "members" }],
        }),
      "channel_audience_unverified",
    );
    expectPresentationError(
      () =>
        sharePromptMessage({
          ...base,
          channelAudience: "members",
          items: [{ ...publicItem, audience: "private" }],
        }),
      "channel_audience_unverified",
    );
    expectPresentationError(
      () =>
        sharePromptMessage({
          ...base,
          channelLabel: "<#123456789012345678>",
          channelAudience: "public",
          items: [publicItem],
        }),
      "private_identifier",
    );
  });
});

describe("state templates", () => {
  it("uses distinct text for error, empty and denied states", () => {
    const error = stateMessage({ kind: "error", message: "The interaction stopped." });
    const empty = stateMessage({ kind: "empty", message: "No cards match that name." });
    const denied = stateMessage({
      kind: "denied",
      message: "This administrator view is private.",
    });
    expect(firstEmbed(error).title).toBe("That did not complete");
    expect(firstEmbed(empty).title).toBe("Nothing here yet");
    expect(firstEmbed(denied).title).toBe("Not available for this account");
    expect(firstEmbed(error).footer?.text).toBe("Nothing was charged or changed.");
    expect(firstEmbed(empty).footer?.text).toBe("No action was taken.");
    expect(firstEmbed(denied).footer?.text).toBe("No change was made.");
    for (const callback of [error, empty, denied]) expect(privateResponse(callback)).toBe(true);
  });

  it("shows a private diagnostic reference only when explicitly supplied", () => {
    const withReference = stateFromError({ code: "internal_error", correlationId: "REQ-1234" });
    expect(fieldValue(withReference, "Reference")).toBe("`REQ-1234`");
    const withoutReference = stateFromError({ code: "internal_error" });
    expect(firstEmbed(withoutReference).fields?.some((field) => field.name === "Reference")).toBe(
      false,
    );
    expectPresentationError(
      () => stateFromError({ code: "internal_error", correlationId: "dwr_1234567890" }),
      "invalid_input",
    );
  });
});

describe("safe attachments", () => {
  it("neutralises traversal, separators and MIME mismatches", () => {
    expect(safeAttachmentFilename("../../etc/passwd.webp", "image/png")).toBe(
      "foilbury-passwd.png",
    );
    expect(safeAttachmentFilename("Foilbury Card Front.WEBP", "image/webp")).toBe(
      "foilbury-card-front.webp",
    );
    expect(safeAttachmentFilename("a".repeat(140), "image/webp")).toHaveLength(
      DISCORD_LIMITS.attachmentFilename,
    );
    expect(() => safeAttachmentFilename("card.webp", "text/html")).toThrowError(PresentationError);
  });

  it("keeps the server-only R2 key out of the visible payload", () => {
    const attachment = buildAttachment({
      r2Key: "tenants/ten_presentation/renders/card.webp",
      contentType: "image/webp",
      filename: "../../etc/passwd.webp",
    });
    expect(attachment).toEqual({
      r2Key: "tenants/ten_presentation/renders/card.webp",
      filename: "foilbury-passwd.webp",
      contentType: "image/webp",
    });
    expect(attachment.filename).not.toContain("/");
    expect(attachment.filename).not.toContain("..");
    expect(() => buildAttachment({ r2Key: "../secret", contentType: "image/webp" })).toThrowError(
      PresentationError,
    );
  });

  it("requires attachment references to match a delivered filename", () => {
    expect(attachmentReference("foilbury-card-front.webp")).toBe(
      "attachment://foilbury-card-front.webp",
    );
    expectPresentationError(
      () =>
        buildMessage({
          embed: {
            title: "Card",
            image: { attachment: "foilbury-card-front.webp" },
          },
        }),
      "unsafe_attachment",
    );
    expectPresentationError(
      () =>
        buildEmbed({
          title: "Card",
          image: { attachment: "../card.webp" },
        }),
      "unsafe_attachment",
    );
    expectPresentationError(
      () =>
        revealReceiptMessage({
          ...revealBase,
          render: { ...render, mime: "text/html" },
        }),
      "unsafe_attachment",
    );
  });
});

describe("raw payload guard", () => {
  it("rejects mention parsing, extra rows and oversized fields", () => {
    expectPresentationError(
      () =>
        assertDiscordMessage({
          embeds: [{ title: "Hello" }],
          allowed_mentions: { parse: ["everyone"] },
        }),
      "invalid_input",
    );
    expectPresentationError(
      () =>
        assertDiscordMessage({
          embeds: [{ title: "Hello" }],
          components: Array.from({ length: 6 }, () => ({
            type: 1,
            components: [{ type: 2, style: 2, label: "Action", custom_id: "foilbury:test" }],
          })),
        }),
      "discord_limit",
    );
    expectPresentationError(
      () =>
        assertDiscordMessage({
          embeds: [
            {
              title: "Too many inline fields",
              fields: Array.from({ length: 6 }, (_, index) => ({
                name: `Field ${index}`,
                value: "Value",
                inline: true,
              })),
            },
          ],
        }),
      "discord_limit",
    );
    expectPresentationError(
      () => assertDiscordMessage({ embeds: [{ title: "A".repeat(257) }] }),
      "discord_limit",
    );
  });
});

describe("audience and template determinism", () => {
  it("matches the domain audience ordering", () => {
    const values = ["public", "members", "private", "unknown"];
    expect(values.map(audienceRank)).toEqual([0, 1, 2, 2]);
    expect(values.map(audienceRank)).toEqual(values.map(domainAudienceRank));
  });

  it("is deterministic and escapes local review output", () => {
    const entries = [
      { label: "Welcome", message: welcomeMessage(welcomeInput) },
      {
        label: "Reveal",
        note: "<script>alert('contact sheet')</script>",
        message: reveal(),
      },
    ];
    const firstJson = contactSheetJson(entries);
    const secondJson = contactSheetJson(entries);
    expect(firstJson).toBe(secondJson);
    expect(firstJson).toContain("foilbury.discord.contact-sheet.v1");
    expect(firstJson).toContain(CONTACT_SHEET_DISCLAIMER);
    expect(firstJson).toContain('"filename":"foilbury-reveal-card.webp"');
    expect(firstJson).not.toContain(render.r2Key);

    const firstHtml = contactSheetHtml(entries);
    const secondHtml = contactSheetHtml(entries);
    expect(firstHtml).toBe(secondHtml);
    expect(firstHtml).toContain("Structural preview only");
    expect(firstHtml).toContain("not a real Discord client render");
    expect(firstHtml).toContain("&lt;script&gt;alert");
    expect(firstHtml).not.toContain(render.r2Key);
    expect(firstHtml).toContain("foilbury-reveal-card.webp");
  });
});
