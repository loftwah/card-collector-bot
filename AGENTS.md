# Foilbury agent workflow

Read `PRODUCT.md`, `DESIGN.md`, `docs/AGENT_GUIDE.md` and `docs/DISCORD_ACCEPTANCE.md` before changing this repository. The production origin is `https://foilbury.loftwah.com`; the canonical local origin is `http://localhost:5173`.

## Required skills

Use the installed project skills under `.agents/skills/` through the harness, not by copying files into prompts:

- `impeccable` for any UI/UX change. Run its context script, critique the rendered product, implement, polish, then audit in the browser. A clean detector is not design acceptance.
- `shadcn` for component work. Inspect `components.json` and the resolved UI alias before adding components. Use the project token palette; do not introduce a second primitive library or palette.
- `cloudflare-one`, `wrangler` and `workers-best-practices` before Access, Worker, D1, R2 or deployment changes.
- `building-emdash-site`, `creating-plugins` and `emdash-cli` before EmDash schema, admin, auth or deployment changes.
- Playwright for real browser journeys, screenshots, network/console inspection and axe checks.

Record source → installed location → actual use → findings → changes → evidence in `docs/SKILLS.md`.

## Identity and authority

- One Foilbury account per person. `usr_prod_owner` is Dean; do not create a duplicate because an email changed.
- Discord OAuth, magic links and passkeys resolve the existing account. Never merge accounts on an unverified email string.
- Cloudflare Access authenticates administration; it never grants a Foilbury role. The Worker validates the Access JWT on every administrative request.
- Only the explicitly provisioned Dean account is Super Admin. Never grant it from guild ownership, first registration, email suffix, Access group or an ordinary admin API.
- Bot Owner and Bot Admin are Bot-scoped. Invitations are expiring, single-use and bound to the invitee's email.
- Sensitive mutations require recent strong authentication (`access`, `passkey` or `mfa`), not just a valid cookie.

## Collections and cards

- Global collections are curated by the Super Admin and enabled/disabled per Bot.
- Bot collections are private to their Bot; a Bot Admin must never see another Bot's private collections.
- Disabling a collection prevents its cards from dropping in that Bot. It does not delete inventory, serials or ledger history.
- Foilbury owns card identity, artwork editions, categories, tags, pools, awards and inventory. EmDash owns journal content/media. Do not create two editable card catalogues.

## Safe execution

- Before a production data change: inspect the live state, take a D1 JSON backup (`node scripts/backup-d1-json.mjs`), prepare rollback, then apply an idempotent migration or trusted provisioning script.
- Do not reset, clean or overwrite an active checkout. Preserve `.foilbury/`, `.dev.vars`, `.env` and existing evidence.
- Never rotate the Discord bot token, OAuth secret, application identity or Access policy without a demonstrated need.
- Run `pnpm check` and the relevant Playwright scripts before deploying. Do not count skipped or mocked human steps as passes.
- Keep `.dev.vars` out of the production bundle; `scripts/deploy-production.mjs` removes it.
