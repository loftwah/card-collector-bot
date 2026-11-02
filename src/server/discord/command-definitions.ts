/** The single guild command contract. Registration and the help response share it. */
export const DISCORD_COMMANDS = [
  {
    name: "foilbury",
    description: "Foilbury collectible cabinet",
    type: 1,
    options: [
      {
        type: 1,
        name: "open",
        description: "Open an eligible capsule",
        options: [
          { type: 3, name: "pool", description: "Pool slug; defaults to cabinet-draw", required: false },
        ],
      },
      { type: 1, name: "daily", description: "Claim today's free allowance" },
      { type: 1, name: "collection", description: "View your owned cards" },
      {
        type: 1,
        name: "card",
        description: "Inspect a card",
        options: [{ type: 3, name: "query", description: "Card name, slug or ID", required: true }],
      },
      { type: 1, name: "packs", description: "List eligible capsule pools" },
      { type: 1, name: "achievements", description: "View your achievements and next milestones" },
      { type: 1, name: "profile", description: "View your player profile" },
      { type: 1, name: "help", description: "Explain Foilbury commands and next steps" },
      {
        type: 2,
        name: "admin",
        description: "Bot administration (Bot Owner/Admin only)",
        options: [
          { type: 1, name: "status", description: "Show this installation and Bot status" },
          { type: 1, name: "settings", description: "Show economy and availability settings" },
          { type: 1, name: "pools", description: "List pools and their eligibility" },
          {
            type: 1,
            name: "enable",
            description: "Enable one availability surface",
            options: [
              {
                type: 3,
                name: "surface",
                description: "Surface to enable",
                required: true,
                choices: [
                  { name: "Discord gameplay", value: "game" },
                  { name: "Website gameplay", value: "website" },
                  { name: "External API", value: "api" },
                  { name: "Public catalogue", value: "catalogue" },
                  { name: "Admin GUI", value: "admin" },
                ],
              },
            ],
          },
          {
            type: 1,
            name: "disable",
            description: "Disable one availability surface",
            options: [
              {
                type: 3,
                name: "surface",
                description: "Surface to disable",
                required: true,
                choices: [
                  { name: "Discord gameplay", value: "game" },
                  { name: "Website gameplay", value: "website" },
                  { name: "External API", value: "api" },
                  { name: "Public catalogue", value: "catalogue" },
                  { name: "Admin GUI", value: "admin" },
                ],
              },
            ],
          },
          {
            type: 1,
            name: "grant",
            description: "Grant Foil to a linked player (audited)",
            options: [
              { type: 3, name: "user", description: "Discord user ID or mention", required: true },
              { type: 4, name: "amount", description: "Amount of Foil to grant", required: true, min_value: 1, max_value: 5000 },
              { type: 3, name: "reason", description: "Why this grant is being made", required: true },
            ],
          },
        ],
      },
    ],
  },
] as const;

export const HELP_TEXT = [
  "**Foilbury** is a collectible cabinet. Your cards belong to this Bot, not to this server.",
  "",
  "`/foilbury open [pool]` — open a capsule and receive a card",
  "`/foilbury daily` — claim the shared daily allowance",
  "`/foilbury collection` — see your owned cards and duplicates",
  "`/foilbury card <query>` — inspect a catalogue card",
  "`/foilbury packs` — list eligible pools and prices",
  "`/foilbury achievements` — see earned badges and what is close",
  "`/foilbury profile` — see your balance and daily status",
  "",
  "Admin commands: `/foilbury admin status|settings|pools|enable|disable|grant`.",
  "Admin commands require a Bot Owner or Bot Admin Foilbury account; server moderator is not platform authority.",
  "",
  "Start with `/foilbury daily`, then `/foilbury open`. No website registration is needed to play.",
].join("\n");
