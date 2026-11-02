# Foilbury product truth

Foilbury is a collectible-card cabinet. A player claims a free allowance, opens a capsule pool, receives a card copy, and keeps that copy in a Bot-scoped inventory. The website, Discord slash commands, REST API, CLI and MCP server all call the same domain services and the same D1 award ledger.

## Actors

- **Account** — one persistent Foilbury identity.
- **User** — an ordinary player. A verified Discord interaction creates a lightweight player without a website registration step.
- **Bot Owner** — the account that owns a Foilbury Bot. This is not platform administration.
- **Bot Admin** — an account explicitly authorised for part of that Bot.
- **Super Admin** — platform-wide authority. It is not granted by a Discord guild role, email match or first sign-up. The current pilot has not provisioned a Super Admin.
- **Installation** — a server-to-Bot binding. A guild is resolved on the server; a tenant or guild ID in an interaction payload is not authority.

## Current product surface

- Public landing page, catalogue, journal and card pages.
- Password sign-in for the production bootstrap owner.
- Player cabinet: collection, draw studio, rewards, trades, preferences and share links.
- Bot management at `/admin/*`, protected at the Cloudflare edge by Access and at the application layer by membership role.
- Discord HTTP interactions at `/api/discord/interactions`: `/foilbury open`, `daily`, `collection`, `card`, `packs`, `profile`, `help` and guarded `admin` subcommands.
- Headless REST API, CLI and stdio MCP server using scoped agent grants.

## Trust boundaries

- Bot A permissions do not grant Bot B authority.
- Discord server moderator status is not Foilbury platform authority.
- Inventory, quotas and awards are authoritative in D1. Editorial/CMS publication cannot mint cards or mutate a wallet.
- Every draw is one D1 batch: entitlement debit, selected outcome, inventory insert, ledger row and idempotency receipt.
- Interaction retries use the interaction ID as an idempotency key. A replayed interaction returns the recorded outcome and cannot re-roll or double-award.
- Private media is authorised by ownership or membership, not by a secret URL.

## Known product gaps

- Magic-link, passkey and authenticator MFA flows are not implemented in this pass. Website Discord OAuth is implemented and production-verified.
- Creator self-service Bot creation, second-guild installation and Kaylee's independent acceptance are not implemented.
- The CMS editorial flow is integrated locally but has not been exercised on the production deployment.
- Cloudflare Access protects `/admin` and `/api/v1/admin` at the edge; the Worker does not yet validate the Access JWT itself.
- Paid generation, email delivery and scheduled announcements remain unverified.
