# Foilbury Discord handoff

Status: **connected for the Loftwah pilot**. The original plan below is retained as history; the live implementation and evidence are in `docs/DISCORD_ACCEPTANCE.md`.

The existing Discord application (`1566702936615026769`) is installed in Loftwah (`997734945206313041`). Discord sends signed HTTP interactions to `https://foilbury.loftwah.com/api/discord/interactions`; guild commands are registered for `/foilbury`. No Gateway connection or privileged intent is used. Gameplay is restricted to `#card-collector-test` (`1566700752385081355`) by the server-side installation allowlist.

Foilbury's authority remains its D1/R2 domain services and award ledger. Discord is an adapter over the same authorised commands, not a separate economy.

Website sign-in also supports **Continue with Discord** at `/auth/discord/start`; the callback is `/auth/discord/callback`, using state and PKCE. A production OAuth sign-in has been verified against the same inventory.

## Current local proof

- The website, player cabinet and owner administration run locally at the printed loopback URL.
- REST, CLI and a real stdio MCP client have been exercised against the same running service.
- Player browser inventory and headless inventory match by instance ID in the local acceptance evidence.
- Rewards, draws, trades, gifts and recycling use the same authorised commands in every adapter.
- `ADMIN_DISCORD_WEBHOOK_URL` is an outgoing owner notification destination. It is **not** a bot token, login method or command endpoint. `DISCORD_WEBHOOK_URL` is accepted only as a migration alias when the canonical name is empty.

Do not treat any of that as proof of Discord delivery.

## Prerequisites before the connection phase

1. Obtain a bot token through the Discord developer portal and store it in the operator secret store, never in a tracked file, prompt, CMS entry or log. The owner has not supplied a bot token for this assignment.
2. Create or select a controlled test guild. Set `DISCORD_TEST_GUILD_ID` for the test only.
3. Choose a reviewed HTTPS endpoint for interactions. A local tunnel is a temporary test aid, not a production answer.
4. Retain the existing `DISCORD_APPLICATION_ID` and `DISCORD_PUBLIC_KEY`. A public key is not a connection and an application ID is not a bot credential.
5. Decide the guild-to-tenant mapping. One Discord server maps to one tenant plus a community policy; connecting another server must not create another economy.
6. Define account-linking policy and a revocation path. A Discord identity must resolve to the existing platform identity and tenant membership, not a client-supplied tenant parameter.
7. Set `DISCORD_ENABLED=false` until the live checks are approved. Keep `DISCORD_BOT_TOKEN`, `DISCORD_TEST_GUILD_ID`, `DISCORD_CLIENT_SECRET` and `DISCORD_REDIRECT_URI` out of the Worker unless a deliberately scoped adapter needs them.

## Adapter shape

Use an HTTP-interaction adapter, not a Gateway connection:

- Register slash commands only in the test guild first.
- Verify the Ed25519 signature and timestamp for every interaction using the application public key.
- Acknowledge within Discord's deadline, then defer a response for any command that touches D1 or a render job.
- Resolve the guild/channel to a tenant and community policy on the server. Reject unknown guilds; never trust a tenant ID from the interaction payload.
- Link Discord identity to a Foilbury platform identity through an explicit, revocable account-link flow. The link is not a login bypass.
- Call the same application commands already used by REST, CLI and MCP. Do not create a Discord-only wallet, collection or cooldown.
- Use stable event IDs and idempotency keys. Retries return the original receipt; they must not reroll or double-issue.
- Return private, redacted responses where the command is owner/economy-only or includes private collection data.
- Suppress unintended mentions. Redact the admin webhook URL. Bound retries and log delivery correlation without player personal data.
- Do not request the Message Content intent or keep a Gateway connection for a slash-command-only design.

Minimal permissions should be tested from a clean installation: application commands, send messages in the chosen channel and use external/embedded content only if an approved design needs it. Do not grant Administrator.

## Live acceptance scenarios (executed 2026-11-02)

1. **One identity and inventory across web and Discord**
   - Link one player identity.
   - Draw or receive a card in the browser.
   - Run the Discord inventory command in the test guild and confirm the same instance IDs and Foil balance.
   - Re-run the command after a Discord retry and confirm one receipt, not a duplicate.

2. **Retry-safe draw and reward**
   - Submit the same draw/reward interaction twice with the same event/idempotency key.
   - Confirm the same card or reward receipt and an unchanged balance.
   - Change the pool revision between preview and submission; confirm the stale revision is rejected before charging.

3. **Topic controls and private/public responses**
   - Apply a community policy that excludes a tag.
   - Confirm the Discord pool preview shows the actual narrowed odds.
   - Confirm an empty filtered pool returns a clear explanation and does not charge.
   - Confirm private inventory/owner responses are ephemeral or hidden from public channels.
   - Confirm a player preference cannot re-enable a topic excluded by the channel policy.

4. **Permissions and authority**
   - A player token cannot publish, adjust a wallet or create an agent grant.
   - An agent grant acts only for its represented member; it cannot accept a trade for both sides.
   - Revoke the grant and confirm the next interaction is rejected.
   - Expired grants are rejected.

5. **Failure and recovery**
   - Simulate a Provider/job outage; confirm only that optional capability degrades and core collecting remains available.
   - Simulate a duplicate interaction; confirm the original response is replayed.
   - Simulate a stale ownership/reservation; confirm nothing transfers and a recoverable error is returned.
   - Confirm the admin webhook is never used as a login or command channel.

6. **Operational**
   - Confirm the endpoint has a bounded request timeout, structured redacted logs, request/interaction correlation and a rollback plan.
   - Confirm no deployment or DNS mutation occurs from the local review environment.
   - Confirm the bot token is absent from the browser, CMS content, logs, prompts, tracked files and tool results.

## Command registration

Registration is reproducible with `pnpm discord:register` using `.env`; it merges the project's `/foilbury` command into the test guild without deleting unrelated commands. Registration alone is not delivery proof; the real interaction evidence is in `docs/DISCORD_ACCEPTANCE.md`.

## Stop point

The original local review gate is preserved in `docs/LOCAL_ACCEPTANCE.md`. The deployed pilot has passed the real Discord game loop; public launch and the two-person matrix remain blocked as documented in `docs/DISCORD_ACCEPTANCE.md`.
