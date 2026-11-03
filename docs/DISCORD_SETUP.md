# Foilbury Discord setup: inspect, propose, apply, verify

Status: **implemented locally; nothing applied to Discord**. Work started from baseline `a39e2bf`; HEAD moved to `34ed8f2` during the run because another workstream committed daily missions. This document describes the #25 read-only inspect → propose → diff workflow and the approval-gated apply/verify path. The plan digest stayed stable across that change.

The existing `#card-collector-test` pilot is preserved. This workflow does not change the Worker, router, auth, schema, collection audience policy, Discord identity, OAuth application, bot token or Access policy.

## Commands

```sh
# Read-only snapshot, proposal, diff and stable plan digest.
pnpm discord:setup:plan

# Machine-readable summary for an agent; the full plan is still written to disk.
pnpm discord:setup:plan --json

# Approve only a subset by regenerating the plan; this changes the digest.
pnpm discord:setup:plan --select category.foilbury,channel.foilbury-showcase

# Explicitly gated write. Refuses without all three flags.
pnpm discord:setup:apply --guild 997734945206313041 --plan <plan-id-or-digest> --apply

# Read-only read-back after an apply.
pnpm discord:setup:verify --guild 997734945206313041 --plan <plan-id-or-digest>
```

Direct script equivalents:

```sh
node scripts/discord/setup-plan.mjs
node scripts/discord/setup-apply.mjs --guild <id> --plan <id> --apply
node scripts/discord/setup-apply.mjs --guild <id> --plan <id> --verify
```

Default output, under the gitignored `.foilbury/discord-setup/` directory:

- `snapshot.json` — sanitised live Discord state.
- `plan.json` — full machine-readable plan, findings, actions, diff and approval metadata.
- `proposal.md` — human-readable proposal with exact overwrites and rationale.
- `apply/pre-apply-snapshot.json` — reversible snapshot written before the first mutation.
- `apply/receipt.json` — applied/unchanged/failed actions with request/response metadata.
- `apply/reverse-checklist.md` — manual reversal notes; never deletes a pre-existing channel.
- `verify.json` — read-only read-back results.

## Required `.env` keys

The script reads `.env` by presence and never prints values:

- `DISCORD_BOT_TOKEN`
- `DISCORD_APPLICATION_ID`
- `DISCORD_TEST_GUILD_ID`
- `DISCORD_TEST_CHANNEL_ID`

The token is used only in the `Authorization: Bot …` header. It is not written to the snapshot, plan, proposal, receipt or logs. The snapshot/plan/proposal were checked for the literal token and for `authorization`/bot-header-shaped strings; none were present.

The workflow is bound to `DISCORD_TEST_GUILD_ID`. A different `--guild` is refused in both plan and apply. The current binding is Loftwah `997734945206313041`; the current test channel is `#card-collector-test` `1566700752385081355`.

## Read-only discovery

`setup-plan.mjs` uses only official Discord REST v10 `GET` requests:

| Endpoint                                          | Purpose                                                          |
| ------------------------------------------------- | ---------------------------------------------------------------- |
| `GET /users/@me`                                  | Confirm the credential is the Foilbury bot                       |
| `GET /applications/@me`                           | Application ID, name, icon, flags, public-bot setting, tags      |
| `GET /guilds/{guild}`                             | Guild name, icon, banner hash, features, boost tier/count, owner |
| `GET /guilds/{guild}/roles`                       | Role hierarchy, permissions, managed roles                       |
| `GET /guilds/{guild}/channels`                    | Categories, channels, topics, parents, overwrites                |
| `GET /guilds/{guild}/members/{bot-user}`          | Bot roles, join time, managed role, effective guild permissions  |
| `GET /applications/{app}/guilds/{guild}/commands` | Guild command IDs and shapes                                     |
| `GET /applications/{app}/commands`                | Global command IDs and shapes                                    |
| `GET /guilds/{guild}/webhooks`                    | Webhook targets, or an honest 403                                |

It does not use a Gateway connection, privileged intents, a self-bot, a user token, a browser login, CAPTCHA/MFA bypass or client automation. It does not call the Worker, D1 or R2.

Effective permissions are computed from the `@everyone` role, the bot's roles and the channel overwrites. Role names alone are never treated as authority. A missing permission is reported, not bypassed.

## What the current dry run found

At the recorded dry run (HEAD `34ed8f2`, work started from baseline `a39e2bf`), the plan generated from the live Loftwah guild reported:

```text
Plan id: 281111f372e47c80
Digest:  281111f372e47c808c25670ce71ab020e61a8ef5ba17aaacc406f62f49e8ece3
8 PASS · 3 WARN · 0 FAIL · 7 BLOCKED
```

The exact digest is state-bound. Re-run the plan after any live change; do not reuse this digest.

Recorded facts:

- Guild **Loftwah** `997734945206313041`; application **Foilbury** `1566702936615026769`; bot user is the same snowflake.
- `#card-collector-test` `1566700752385081355` is in the guild, currently under **Text Channels** `997734945206313042`, with topic `Card Collector`.
- The test channel has **no `@everyone` View Channel deny** and no permission overwrites. Every guild member can read it. Member-only artwork must stay ephemeral there.
- The bot has **no guild role** (`roles: []`) and sits at `@everyone` position 0. Its guild permissions include View Channel, Send Messages, Embed Links, Attach Files, Read Message History and Use Application Commands, but **not Manage Channels or Manage Roles**.
- Effective permissions are computed from the `@everyone` role, bot roles and channel overwrites. In `#card-collector-test` the bot has View Channel, Send Messages, Embed Links, Attach Files and Read Message History, so the runtime channel check passes even though the guild-level write permissions are blocked.
- There is no managed Foilbury bot role. The proposal therefore targets the bot **member** with a channel overwrite where an allow is needed; it does not create a role.
- Guild features are `[]`, premium tier `0`, premium subscription count `0`, guild banner `null`, guild icon set. A static guild banner needs the `BANNER` entitlement (Boost tier 2); an animated banner needs `ANIMATED_BANNER` (tier 3). Neither is available.
- Application icon is set; application flags are `0`; public bot is `true`. The application profile/banner is a Developer Portal surface and is reported as a manual step, not a proved API mutation.
- Guild command `/foilbury` ID `1566755562551779330` differed from the current `src/server/discord/command-definitions.ts` in three places: missing `missions`, missing `npc`, and a changed `open` description. The plan imports that contract at run time, so the drift result should be re-read after any contract change. No global `/foilbury` command exists.
- `GET /guilds/{guild}/webhooks` returns **403 Missing Permissions** with the current bot rights. Webhook targets are therefore **BLOCKED** for discovery; no webhook is created, edited or called.
- There is no verified, revocable Discord-role ↔ Foilbury membership mapping. The members-only surface is **BLOCKED**.
- A genuine outsider/spectator observation needs a second controlled Discord account. It is **BLOCKED** as a human step.

These checks expose the old `15 PASS, 0 FAIL, 2 BLOCKED` preflight as historical, not current proof. The plan does not assume an old result.

## Proposal

The plan proposes three actions and zero deletions:

```text
Foilbury (category, new)
├── #card-collector-test (reused, public play/test)
└── #foilbury-showcase (new, public read-only showcase)
```

### `category.foilbury`

- Create one category named `Foilbury`, type `4`.
- No overwrites; it inherits the guild default.
- No unrelated Loftwah channel is renamed, moved or deleted.

### `channel.card-collector-test`

- Reuse the existing channel; do not create a duplicate `#foilbury-play`.
- Move it under the new category.
- Topic: `Foilbury test bench · public play and demos · member-only art stays private and ephemeral here`.
- `@everyone` overwrite: allow `VIEW_CHANNEL`, `READ_MESSAGE_HISTORY`, `USE_APPLICATION_COMMANDS`; deny none. This is channel-scoped and does not create a members-only surface or a guild-wide role change.
- No bot member overwrite is needed here because the bot already inherits the required send/attach permissions.

### `channel.foilbury-showcase`

- Create one public read-only text channel.
- Topic: `Approved Foilbury public showcase · original-IP cards only · member albums and third-party art stay private`.
- `@everyone`: allow `VIEW_CHANNEL`, `READ_MESSAGE_HISTORY`; deny `SEND_MESSAGES`, `SEND_MESSAGES_IN_THREADS`, `CREATE_PUBLIC_THREADS`, `CREATE_PRIVATE_THREADS`, `MENTION_EVERYONE`.
- Foilbury bot member `1566702936615026769`: allow `VIEW_CHANNEL`, `SEND_MESSAGES`, `EMBED_LINKS`, `ATTACH_FILES`, `READ_MESSAGE_HISTORY`, `ADD_REACTIONS`; deny none. The bot needs the explicit allow because the `@everyone` send deny also applies to it.
- This channel is justified because the test bench is not a showcase and public shares need a stable, obviously public destination. It does not unlock member content: the Discord handler still checks each card's effective audience before posting.

### Deliberately not created

- `#foilbury-play`: the reused test channel is already the play surface.
- `#foilbury-start`: channel topic, `/foilbury help` and `/foilbury tour` already cover discovery. A pinned post is a message write and remains a manual step.
- `#foilbury-ops`: Foilbury administration is `/admin` and `/platform-admin` behind Cloudflare Access. A Discord ops room would blur server moderator and platform authority.
- `#foilbury-members`: **blocked**. No verified, revocable Discord-role ↔ Foilbury membership mapping exists. An `@everyone` View Channel deny is necessary but not sufficient; the allowed role must be verified and revocable. The proposal includes the exact future overwrite and preconditions in `proposal.md`, but does not apply them.

## Diff and stable digest

`plan.json` contains:

- `proposal.actions` — the approved mutation intent.
- `proposal.diff` — per-action `add` / `change` / `unchanged` rows with before/after fields.
- `proposal.deferred` — skipped, manual and blocked decisions.
- `proposal.summary` — create/edit/delete/rename/role/message counts.
- `digest` — SHA-256 over the canonical target, actions, pre-state and deferred decisions.
- `plan_id` — the first 16 hex characters, for human use.

The digest excludes timestamps and findings prose. Re-running the plan against unchanged live state produced the same digest twice. A live topic, parent, overwrite or channel change alters the pre-state and therefore the digest; that is intentional. If the owner edits a channel manually, re-run and re-approve.

`--select` regenerates a plan containing only the selected actions. The new plan has a new digest. Selecting a child channel without its new category is refused unless the category already exists.

## Approval rules

`setup-apply.mjs` refuses to write unless all of these are true:

1. `--apply` is present.
2. `--plan` exactly equals the plan's `plan_id` or full `digest`.
3. `--guild` exactly equals the plan target, the plan snapshot guild and `DISCORD_TEST_GUILD_ID`.
4. The plan schema is supported and the recomputed digest matches `plan.digest`.
5. Every action is a supported channel/category create or edit. No delete, rename, role creation, guild-wide permission change, message or command registration is allowed.
6. Every targeted resource belongs to the approved snapshot and guild; overwrite targets are limited to `@everyone` and the Foilbury bot member.
7. A fresh live read confirms the same guild, application and bot identity.
8. The bot has the required write permissions.
9. The live state is either the approved pre-state or the approved result. Anything else is drift and refuses before a write.

Refusals exit with code `2`. A wrong guild, a stale/edited plan, a missing digest, a missing `--apply` and a missing bot permission all refuse before any Discord write.

Planned write permissions:

- `MANAGE_CHANNELS` — create channels/category and edit the channel parent/topic.
- `MANAGE_ROLES` — set the channel overwrites.
- `VIEW_CHANNEL`, `SEND_MESSAGES`, `EMBED_LINKS`, `ATTACH_FILES`, `READ_MESSAGE_HISTORY` — operate in the resulting channels.

The current bot is missing `MANAGE_CHANNELS` and `MANAGE_ROLES`, so apply is **BLOCKED**. The owner must grant a dedicated guild role with those permissions (and the runtime send/attach permissions) before applying. Do not grant Administrator. Role creation/assignment is a human Server Settings action; this workflow does not create a role.

## Apply safety

- The plan is dry-run by default. There is no default apply.
- Before the first write, apply saves the full live snapshot and the exact approved actions to `apply/pre-apply-snapshot.json`.
- It writes an `in_progress` receipt before the first request and updates it after every action.
- Channel creation preserves the planned order; no unrelated channel is moved or renamed.
- Editing the reused channel merges only the planned `@everyone`/bot overwrite entries and preserves all unrelated overwrites.
- There is no `DELETE` request and no rename field in an edit.
- Duplicate runs are idempotent: a live state that already exactly matches the approved result becomes `unchanged` and sends no request.
- A partial apply stops at the first failure, records the exact HTTP status/detail, keeps the receipt and writes a reverse checklist of resources created by that run. It does not attempt an unsafe automatic delete.
- 429 responses respect `retry_after` within a bounded wait; other 403/4xx responses fail closed with the Discord status and body. There is no permission bypass.
- The operator must run `--verify` after apply and then verify the real Discord client.

## Verify

`--verify` is read-only. It:

- validates the same plan digest and bound guild;
- reads live channels/overwrites and compares each planned action;
- reports `PASS`, `FAIL` or `BLOCKED` with field-level differences;
- re-checks command registration drift;
- writes `verify.json` and prints the summary.

It does not claim success from a mocked read. A plan that has not been applied reports `FAIL` for each action. The current read-only run reports 3 action `FAIL`s because the plan is intentionally unapplied, plus the recorded blockers (missing bot permissions, no member mapping, no spectator, banner unavailability, application banner manual, webhook discovery 403). That is the honest state, not a green result.

`--verify` reads `apply/receipt.json` under the same `--out` directory to reuse IDs created by the apply. If a custom receipt path was used, pass `--receipt <path>`. A receipt from a different plan is ignored for IDs; verification falls back to name/parent lookup.

## Unsupported or manual steps

These are not performed by the bot API path and are listed in `proposal.md`:

- **Bot guild role and permissions** — Server Settings → Roles: `https://discord.com/channels/997734945206313041/settings/roles`. Grant only the minimum above; remove `Manage Channels`/`Manage Roles` after setup if the owner prefers. Never grant Administrator.
- **Command registration** — the live `/foilbury` command has drifted. The canonical merge script is `pnpm discord:register`. It writes command registrations, so it needs a separate approval. This setup apply deliberately does not call it.
- **Application profile** — icon, description, tags, public-bot setting and profile banner are Developer Portal surfaces: `https://discord.com/developers/applications/1566702936615026769`. The bot API read does not prove those fields can be changed.
- **Guild banner** — feature-gated by Boost tier. Current guild features are `[]` and tier 0. Upload in Server Settings → Overview after the entitlement exists: `https://discord.com/channels/997734945206313041/settings/overview`.
- **Pinned how-to-play post** — a message write. Post it manually after the channels exist; link `/foilbury help` and the real tour, never an admin URL or personal data.
- **Member-only channel** — blocked until a verified, revocable membership↔role mapping exists, the channel denies `@everyone` View Channel, and a controlled outsider proves it cannot read it. After that, the Bot Admin must record the channel audience; this workflow does not write the D1 `channel_audience_json`.
- **Human spectator** — a second controlled Discord account with consent. Self-bots, user-token scraping, automated human login and CAPTCHA/MFA bypass are prohibited. If no second account is available, the spectator item remains **BLOCKED**.
- **Browser verification** — real desktop/mobile Discord client checks and screenshots. API read-back is not a substitute for the rendered client. Keep private screenshots under `.foilbury/`.

## Current acceptance matrix

| Item                                | Status           | Evidence                                               |
| ----------------------------------- | ---------------- | ------------------------------------------------------ |
| Script syntax                       | PASS             | `node --check` on both new scripts                     |
| Read-only snapshot/proposal/diff    | PASS             | `pnpm discord:setup:plan`, `.foilbury/discord-setup/`  |
| Stable digest on repeated plan      | PASS             | Two runs produced `281111f372e47c80…`                  |
| No secret in snapshot/plan/proposal | PASS             | Literal-token and auth-header checks returned false    |
| Wrong guild refused                 | PASS             | Plan exit 1; apply exit 2                              |
| Apply without `--apply` refused     | PASS             | Exit 2, no network write                               |
| Apply without `--plan` refused      | PASS             | Exit 2, no network write                               |
| Wrong digest refused                | PASS             | Exit 2, no network write                               |
| Current bot write permission        | BLOCKED          | Missing `MANAGE_CHANNELS`, `MANAGE_ROLES`              |
| Apply itself                        | NOT RUN          | Intentionally unapplied                                |
| Read-only verify                    | PASS (read-only) | 3 action `FAIL` because unapplied; 7 blockers recorded |
| Member-only channel                 | BLOCKED          | No verified mapping                                    |
| Genuine spectator                   | BLOCKED          | No second controlled account                           |
| Guild banner                        | BLOCKED          | Features `[]`, tier 0                                  |
| Command registration drift          | WARN             | Missing `missions`, `npc`; `open` description changed  |
| Live client desktop/mobile          | BLOCKED          | Manual after apply                                     |

## Official references

- Automated user accounts / self-bots: https://support.discord.com/hc/en-us/articles/115002192352-Automated-User-Accounts-Self-Bots
- Discord Developer Policy: https://support-dev.discord.com/hc/en-us/articles/8563934450327-Discord-Developer-Policy
- Roles and permissions: https://support.discord.com/hc/en-us/articles/214836687-Discord-Roles-and-Permissions

## Approval still required

1. Grant the Foilbury bot a dedicated least-privilege guild role with `Manage Channels` and `Manage Roles` (plus the runtime send/attach permissions). Without it, apply refuses.
2. Decide whether to run `pnpm discord:register` to fix the `missions`/`npc` and `open` description drift. That is a separate write.
3. Approve the exact plan digest and target guild, then run the gated apply.
4. After apply, run `--verify`, then perform the real desktop/mobile and second-account spectator checks.
