# Identity, passwordless authentication and administration acceptance

## Authentication correction awaiting deployment

The acceptance record below is historical. Its statement that only human MFA
enrolment remained was incomplete. A live dashboard comparison established that
App Composer inherits the organisation's Access MFA setting (currently off),
whereas Foilbury's Platform Administration, Platform Admin API and Editorial
applications explicitly require an independent Access factor every eight hours.
Dean requested the existing Cloudflare-account sign-in without this second
enrolment requirement.

This correction:

- Removes the three application MFA overrides and inherits the organisation's
  setting. It does not set `mfa_disabled: true`, modify the organisation, replace
  the applications or broaden the owner policy. The provisioning script reads
  the complete app configuration before writing and verifies the same app ID,
  audience and domain plus absence of the override afterwards.
- Validates standard signed Access application tokens without relying on an
  undocumented `payload.idp.type`. Signature, issuer, exact route audience,
  expiry, application-token type, subject and email remain mandatory. Dedicated
  platform audiences still require the explicitly provisioned Foilbury Super
  Admin; admission alone never creates that role.
- Uses verified Access assurance for the current linked request even if a
  matching OAuth/email session already exists. The session and CSRF token are
  reused, and no stronger assurance is written into that existing session.
  Fresh convenience cookies carry email assurance; old Access-assured cookies
  cannot substitute for a current verified Access request.
- Keeps email-PIN Bot Admin entry separate. Sensitive Bot admin mutations may
  use a recent local passkey/MFA proof or a matching Cloudflare-account provider
  response from the official Access identity endpoint. Unavailable, mismatched
  or OTP responses grant no extra assurance. Provider identity is not represented
  as proof that a second factor occurred.
- Always installs EmDash's supported Access adapter, reads
  `FOILBURY_ACCESS_EDITORIAL_AUD` at Worker runtime, and preserves existing CMS
  user provisioning and role settings.
- Establishes each separate admin API application's session with a read-only
  probe before operational requests. An Access redirect becomes one top-level
  handoff, returning only to a validated page in the same admin area. A marker
  prevents repeated handoffs; it is not authentication evidence. No mutation is
  sent before admission or replayed afterwards. Initial Platform Admin errors
  are shown with a reload action instead of an indefinite loading placeholder.

### Validation and release gates

The pull-request workflow uses the repository's required Node 22.23.4 and pnpm
10.34.4. It runs configuration tests, typechecking, unit and Workers tests, then
the production build before any local environment file exists. It verifies that
`dist/server/.dev.vars` is absent. Chromium then exercises authentication,
Foilbury card editorial, album and privacy journeys against a local Worker.
The workflow run for the final source commit is the authoritative test record.

`scripts/setup-ci-fixtures.mjs` creates explicitly labelled synthetic fixtures
from tracked Foilbury brand images for these local journeys. It requires CI,
loopback port 5173, the configured local environment, disabled external
providers and an empty catalogue. It never resets existing data. No launch
manifest, private roster, production credential or external artwork import is
used. Real local front/back renders and a positive member search are required
before running privacy assertions, so those checks cannot pass on missing data.

These local suites do not prove delivered email, production launch-data
integrity or native EmDash console admission. The documented existing Dean CMS
mapping has not been independently verified in a live native-console session.

The album gate also exposed a pre-existing capsule-selection race: drawing
could use the previous pool's preview while the newly selected pool loaded.
The correction only enables drawing with a loaded preview for the current
pool and community filter, ignores superseded responses and locks both
selectors during an in-flight draw. The browser test deliberately holds the
new preview, verifies that drawing is disabled, then checks the exact awarded
card and its earned, granted achievement without forcing a re-evaluation.

Before release, the full check and relevant local auth/editorial browser tests
must pass. After the approved Access change and Worker deployment, use an
authorised fresh browser session to verify `/platform-admin`, its API,
`/admin`, its API and `/_emdash/admin`. Explicitly verify page-to-API admission
without manual API warm-up: the handoff completes, its probe returns 204,
operational requests succeed, and the navigation marker disappears. Successful
redirects alone do not establish this.
Verify the existing Dean identities and roles, successful permitted operations,
cross-user denial, non-owner denial and expired-token denial. Do not mark these
live cases passed from a fixture, mock, a 302 or a screenshot of the gate.

The API reset encoding is checked by read-back: if an omitted `mfa_config` does
not remove the override, the script stops and requires the supported dashboard
setting **Respect global enforcement setting**. It must not silently substitute
an explicit exemption from organisation MFA.

No production data migration is required. Rollback restores the previous Worker
and the saved application configurations; the previous three application MFA
overrides used TOTP/biometrics/security key with an eight-hour duration. Never
recreate the applications or change their audience tags to roll back this fix.

## Historical acceptance record

Pass run: 2026-11-02. Production Worker: `e188ea0e-e73c-4c37-a62b-b5134cc2abc3`. Repository base: `0077fb3` plus this working tree. Test baseline before the pass: 44 passing tests. Current: 64 passing tests (19 unit + 45 Workers).

## Preserved production identity

| Before                                                            | After                                                                                                                                                                    |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `usr_prod_owner`                                                  | `usr_prod_owner` (stable internal ID retained)                                                                                                                           |
| `owner@foilbury.loftwah.com`                                      | `dean@deanlofts.xyz` (verified)                                                                                                                                          |
| Display name `Dean`                                               | Display name `Dean`                                                                                                                                                      |
| Discord `707281352818425929` → `usr_prod_owner`                   | Unchanged                                                                                                                                                                |
| Discord guild `997734945206313041`, channel `1566700752385081355` | Unchanged                                                                                                                                                                |
| 7 owned cards / 120 Foil / 10 ledger rows at pass baseline        | 8 owned / 40 Foil / 11 ledger rows after a real Discord draw at `2026-11-02T11:37:20.751Z` (`discord:1566778217401024603:open`)                                          |
| No Super Admin                                                    | Sole explicitly provisioned Super Admin                                                                                                                                  |
| 0 global collections in the new model                             | 4 global collections, 16 collection-card memberships                                                                                                                     |
| No Access identity link                                           | Real Access identity linked: `dean@deanlofts.xyz`, subject `cc245d5e-fe7f-58c3-aa0b-3dc7efcca6cc`, first linked `2026-11-02T12:21:41Z`, last seen `2026-11-02T12:26:08Z` |

The extra card and 80 Foil spend are a recorded live Discord draw, not a migration side effect. Card serials and ownership for all seven earlier copies are unchanged.

## Migration and provisioning

- Pre-change backup: `.foilbury/backups/prod-pre-auth-2026-11-02.json` (60 tables, 621 rows, SHA-256 `c0cc31dcb898b3cd1b932670313eac01012863ff1d6b754d9b25a0871c652447`). It is git-ignored and mode 600.
- Schema migration `0006_identity_auth_bots_collections.sql` is additive; `0007_card_editorial.sql` only fills `bio`/`quote` fields.
- `scripts/provision-owner.mjs --apply --email dean@deanlofts.xyz` verified:
  - the account was exactly `usr_prod_owner`;
  - Discord `707281352818425929` resolved to that account and was not revoked;
  - the Cloudflare Access user `dean@deanlofts.xyz` existed and was allowed by all five Access policies;
  - no other account used the email;
  - no other Super Admin existed.
- It then changed the primary email, marked it verified, allowlisted the Access email, set `platform_admin=1`, inserted `fb_platform_admins`, and wrote `identity.primary_email.migrated` and `super_admin.provisioned` audit events.
- Rollback: restore the JSON backup or set the account email back to `owner@foilbury.loftwah.com`, remove the `fb_access_emails` row and `fb_platform_admins` row, and set `platform_admin=0`. The schema is additive; no inventory/ledger rollback is needed for identity changes.

## Cloudflare Access configuration

| Application                      | Path               | IdP                       | Policy                                                               | MFA                                                      |
| -------------------------------- | ------------------ | ------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------- |
| Foilbury Administration          | `/admin`           | Cloudflare + one-time PIN | Dean email; creator group; creator email entry (authentication only) | App-level TOTP/passkey for sensitive Foilbury actions    |
| Foilbury Admin API               | `/api/v1/admin`    | Cloudflare + one-time PIN | Same                                                                 | Same                                                     |
| Foilbury Platform Administration | `/platform-admin`  | Cloudflare only           | Dean email only                                                      | Independent Access MFA: TOTP/biometrics/security key, 8h |
| Foilbury Platform Admin API      | `/api/v1/platform` | Cloudflare only           | Dean email only                                                      | Same                                                     |
| Foilbury Editorial               | `/_emdash`         | Cloudflare only           | Dean email only                                                      | Same                                                     |

The `/admin` one-time-PIN entry is authentication, not authorization: the Worker still requires an active Bot membership and the applicable capability. A verified creator email is added to `fb_access_emails` when the Bot is created or an invitation is accepted, so the same person can link their Access identity to the same Foilbury account without SQL. Platform Administration does not have the OTP entry. No policy uses `Include Everyone`, an email suffix or all valid emails.

The Worker validates the Access JWT itself (`src/server/access.ts`): signature through the team JWKS, issuer, audience and expiry. It resolves a subject only through `fb_access_emails` plus a verified matching account email, and records the subject in `fb_access_identities`. A valid Access identity does not create a Foilbury role.

## Test evidence

| ID       | Result                              | Evidence                                                                                                                                                                                                                                                    |
| -------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ID-01    | PASS                                | Production D1: Discord `707281352818425929` → `usr_prod_owner`; same account owns all 8 cards; 11 ledger rows.                                                                                                                                              |
| ID-02    | PASS                                | Pre/post counts and serials above; email migration audit events.                                                                                                                                                                                            |
| ID-03    | PASS (real Access link)             | `fb_access_identities` row for `dean@deanlofts.xyz` after a real Access-authenticated production request; `last_seen_at` 12:26Z.                                                                                                                            |
| ID-04    | PASS (automated) / human UI BLOCKED | Forged header → 302 at Access edge. Expired/wrong audience/wrong issuer/missing email tests reject in `tests/unit/access.test.ts`. Application cookie alone is not the boundary. A human Cloudflare MFA prompt is still required for a fresh browser login. |
| ID-05    | PASS                                | `fb_platform_admins` has exactly one active row: `usr_prod_owner`. Unique partial index prevents a second `platform_admin=1`.                                                                                                                               |
| ID-06    | PASS                                | Access email allowlist requires a verified exact email match; a different received email returns `email_mismatch`; no automatic merge.                                                                                                                      |
| AUTH-01  | PASS                                | Live Resend accepted a magic link to `dean@deanlofts.xyz`; local Chromium redeemed it, rejected replay, and rejected expiry.                                                                                                                                |
| AUTH-02  | PASS                                | Virtual passkey registration/sign-in, TOTP confirmation, recovery code step-up, session listing/revocation in `scripts/test-auth-e2e.mjs`.                                                                                                                  |
| AUTH-03  | PARTIAL                             | Production callback exact; local registered callback now `http://localhost:5173/auth/discord/callback` and dev origin matches. A completed local Discord consent needs a human Discord session.                                                             |
| AUTH-04  | PASS with retained fallback         | Replacement access and recovery proven locally; production Access identity linked. The bootstrap password remains available as a documented emergency fallback until Dean completes a fresh Access/MFA login.                                               |
| ADMIN-01 | PASS local                          | Independent creator creates an account by magic link, adds a passkey, creates a Bot and enters only that Bot.                                                                                                                                               |
| ADMIN-02 | PASS                                | Worker tests cover invitation binding, email mismatch, capability grant and revocation.                                                                                                                                                                     |
| ADMIN-03 | PASS                                | Sensitive routes require `access`, `passkey` or `mfa`; tests cover password rejection and stale MFA.                                                                                                                                                        |

## Sign-in journeys

- **Dean / platform administration:** open `/platform-admin` → Cloudflare Access → Cloudflare account → independent Access MFA if not already satisfied → Worker validates JWT → linked `usr_prod_owner` → Platform Administration. No Foilbury password form.
- **Dean / Bot administration:** open `/admin` → choose Cloudflare Access (or a creator email code for a Bot Admin) → Worker validates JWT → Bot membership/capability → Bot administration.
- **Player:** Continue with Discord or email magic link; passkey is available after first sign-in. A magic link is 15 minutes, single-use, and requires a confirmation POST.
- **Creator:** magic link → verify email → add passkey/TOTP → create Bot → invite a Bot Admin. The invite is single-use, expiring, bound to the invitee email, and acceptance requires a protected account.
- **Account switch:** `/logout` clears the Foilbury application session. The security page links to Cloudflare Access logout; application session revocation is separate from Access SSO.
- **Emergency access:** the legacy password form is hidden under “Legacy password fallback”; it is not the primary journey. It can be retired after a fresh Dean Access login and a successful recovery test.

## What still needs human action

1. Dean (or the owner of the Access account) should open `/platform-admin` and complete the Cloudflare Access MFA prompt. The Access identity is already linked and the Worker has seen it; a fresh authenticated screenshot is the remaining evidence.
2. Open `/_emdash/admin` through the same Access session to exercise the native EmDash console and verify the existing Dean CMS account/passkey is not stranded.
3. Complete one local Discord OAuth consent at `http://localhost:5173` with the registered callback.
4. A second human creator/invitee is needed for the two-person acceptance matrix; do not create or act as Kaylee without permission.

These are human consent/MFA steps, not missing implementation.

---

# Owner sign-in release — 2026-11-03

## Integrated source and deployment

- PR #5 was integrated into `release/owner-sign-in-demo-tour` over main at `f87a812` with the demo, Discord and artwork changes preserved.
- Production Worker: `b5a8d35d-7911-4d1e-a7e8-d4d08fd9bb21`; deployed source `f161b6879a3a9d209e1b565c500ebc420659f492`.
- Production D1 migration: `0013_discord_channel_audience.sql` (additive channel policy/share receipt only).
- Pre-change backup: `.foilbury/backups/prod-pre-tour-2026-11-03.json` (85 tables, 30,688 rows, SHA-256 `b40080a3b77b3cd344827760530711537365ad7a5962aad192f5ef55a8b99ee1`).
- Production baseline preserved: 2 accounts, 2 active memberships, 11 instances (11 owned), 20 ledger rows, 1,800 Foil total, 21 collections, 156 cards, 640 variants, 640 published renders, 45 achievements, 4 unlocks, 2 Discord identities and 1 installation.

## Saved Access configuration

The Access application IDs and audiences were not recreated:

| Application                      | ID                                     | Audience             | MFA override after read-back      |
| -------------------------------- | -------------------------------------- | -------------------- | --------------------------------- |
| Foilbury Administration          | `81570cb1-bc16-4b7c-9133-249302a2579e` | `c2529a1b…e14be16`   | unchanged (inherits organisation) |
| Foilbury Admin API               | `e95cb61b-3163-4e84-8476-e34355016f74` | `ecc6e454…cbe8aa`    | unchanged                         |
| Foilbury Platform Administration | `5db60bf3-09c8-4bb1-bee7-7296bab7d9a9` | `89a773ff…0c37733`   | `mfa_config: null`                |
| Foilbury Platform Admin API      | `9a76651c-cd8d-4dfc-993e-b1adbe6fa7b8` | `df35f87f…5e33b6e9`  | `mfa_config: null`                |
| Foilbury Editorial               | `f0e372f1-f229-4603-8122-b86872e16af3` | `d012a3aa…3b3a46639` | `mfa_config: null`                |

`mfa_config: null` is the supported “Respect global enforcement setting” state, not a `mfa_disabled: true` exemption. The organisation-wide MFA setting was read before and after and was not changed. All policies were preserved: Dean's email only for platform/platform API/editorial, and the existing owner/creator policies for `/admin`.

## Verification

- `pnpm check`: 0 type errors; 72 unit + 68 Workers tests = **140 passing**.
- `tests/scripts/cloudflare-access-app.test.mjs`: app identity preservation, read-back and retained-override rejection.
- `tests/unit/access*.test.ts`: signature, issuer, audience, expiry, allowlist, mismatch and local-assurance cases.
- `tests/workers/bot-switch.test.ts`: a Bot switch copies the original strong-auth time instead of refreshing it.
- Production `/platform-admin` and `/_emdash/admin` redirect to their Access applications; `/api/v1/admin/*` and `/api/v1/platform/*` redirect at the edge; an unsigned Discord POST returns 401.
- Production public smoke: `pnpm test:deployed` PASS.

## Still human / BLOCKED

1. **Fresh owner session:** Dean opens `https://foilbury.loftwah.com/platform-admin` in a browser and completes the Cloudflare account flow. This is a consent/MFA step; no agent can complete it without impersonation.
2. **API admission without visiting the API URL:** the first platform/admin API call after the page handoff should return data rather than an Access redirect. This is covered by unit/browser tests but needs the fresh human session in production.
3. **Native EmDash console:** open `https://foilbury.loftwah.com/_emdash/admin` in the same Cloudflare session and perform one reversible content operation with the existing Dean CMS account. `autoProvision:false` remains in force; no duplicate CMS account was created.
4. **Bot Admin production:** open `https://foilbury.loftwah.com/admin` as Dean and verify the Bot-scoped screens and one permitted mutation. Local browser evidence and Worker tests pass.

These are human authentication checks, not missing implementation or a new authentication system.

## Signal and scoped-role release — 2026/11/03

- Source: `af9eb27` (`feat: scoped roles, Signal identity and premium collection experience` plus export refresh).
- Production Worker: `bc57af7e-7a9e-4e2c-84cc-263018157f02`.
- D1 migration: `0014_scoped_roles_and_shares.sql` (additive; 7 commands).
- Backup: `.foilbury/backups/prod-pre-signal-2026-11-03.json` (86 tables, 30,695 rows).
- Access applications and policies were not recreated. `pnpm access:configure` remained a plan-only read-back.
- Production role: `usr_mvzm5yiky28tmcyedbg20wdx` (`Kaye ⋆˚꩜｡`) is a scoped Global Collection Admin; `platform_admin=0`; one active Super Admin remains.
- Production mastery catalogue: 126 definitions inserted; 0 pending.
- `pnpm check`: 148 tests. `pnpm test:deployed`: 17 PASS.
- Human proof still required: Dean's fresh Access session for `/platform-admin`, `/platform-admin/people`, `/_emdash/admin`; Kaylee's passkey enrolment before Bot creation; live Discord desktop/mobile and a controlled spectator.
