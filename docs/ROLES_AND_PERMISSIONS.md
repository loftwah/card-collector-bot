# Roles, scopes and permissions

Foilbury keeps five authorities separate. None is inferred from another.

| Authority | Provenance | Where it applies |
|---|---|---|
| Super Admin | Explicit `fb_platform_admins` row, currently only `usr_prod_owner` (Dean) | Platform root: provisioning, Access links, Bot lifecycle, public approval, all global collections |
| Global Collection Admin | Audited `fb_platform_role_assignments` row, granted by Super Admin | Only the assigned shared collections: metadata, branding, card membership, release state. Never root |
| Bot Owner | `fb_bots.owner_user_id` plus active owner membership | One Bot: economy, catalogue, collections, team, pools, audit |
| Bot Admin | Expiring, single-use invitation bound to an email; capability set | One Bot, only the granted capabilities |
| User | Ordinary account | Own play, inventory, wishlist, shares; no administration |

## Permission matrix

| Capability | Super Admin | Global Collection Admin | Bot Owner | Bot Admin | User |
|---|---|---|---|---|---|
| Read assigned shared collections | All | Scoped | Their Bot + enabled globals | Their Bot + enabled globals | Enabled member albums |
| Edit shared metadata / description / source context | Yes | Scoped | No | No | No |
| Upload shared branding (logo/cover/banner) | Yes | Scoped | No | No | No |
| Add/remove cards in a shared collection | Yes | Scoped | No | No | No |
| Draft → published → archived shared collection | Yes | Scoped | No | No | No |
| Approve `view_audience=public` | Yes | **No** | No | No | No |
| Enable/disable a shared collection for a Bot | Yes | Only a Bot they own/administer | Yes | With `content` | No |
| Edit a Bot collection | All | Only their own Bot | Their Bot | With `content` | No |
| Invite/revoke a Bot Admin | Yes | Only their own Bot | Yes | With `members` | No |
| Grant Foil with `grants` capability | Yes (existing audited limits) | No | Yes | Scoped: positive only, within visible self/other policy | No |
| Enable/disable self-grants and set ceiling | Yes | No | Yes (Super Admin or Bot Owner) | No | No |
| Grant Super Admin | Provisioning script only | No | No | No | No |
| Manage Access / secrets / deployment | Cloudflare owner path | No | No | No | No |
| Mint cards, spend Foil, alter another inventory | No direct UI; domain services only | No | Scoped grants only | Scoped grants only | Own play only |
| Read another member's wallet or ledger | No | No | No | No | No |
| Grant the scoped platform role | Yes | No | No | No | No |

## Member pickers and contact records

Operational pickers use `GET /api/v1/admin/people`, which returns only `id`,
`display_name` and `role`. The economy, gift composer and agent-grant screens
use this directory so an operator can choose a person without enumerating email
addresses.

Contact records and pending invitations use `GET /api/v1/admin/team` (or the
lower-level `GET /api/v1/admin/members`). Both are human-only and require the
Bot Owner, Super Admin, or a Bot Admin with the live `members` capability. An
agent grant is denied even with `ops:read`. `GET /api/v1/admin/bot` returns Bot
settings only and cannot be used as a back door to the people directory.

## Kaylee

Target account:

- user `usr_mvzm5yiky28tmcyedbg20wdx`
- email `discord.863331540095467520@players.foilbury.invalid`
- Discord `863331540095467520` (`strawberrymarmalade420_`, “Kaye ⋆˚꩜｡”)

She should receive **Global Collection Admin**, not Super Admin. The grant is a
single audited row with an explicit collection scope. It does not make her a Bot
Owner; she still needs to create or be invited to her own Bot, exactly like any
other protected account. Her Discord OAuth link is a real identity proof even
though the account has no routable mailbox. A passkey or authenticator is still
required before creating or administering a Bot; that is the strong-auth proof,
not an email string.

To attach a real email, she signs in with Discord, adds a passkey, then uses
**Account security → Add or change the primary email**. The one-use link is bound
to the signed-in account and the new mailbox; it never merges accounts by matching
an email string. Until then the placeholder address is expected and harmless.

```sh
# read-only plan; exact identity and Discord link are rechecked
pnpm roles:provision

# apply after a D1 backup and owner approval
pnpm roles:provision -- --apply
```

The script refuses to invent an account, refuses a mismatched email/Discord
identity, and never changes `fb_users.platform_admin` or `fb_platform_admins`.

## Surfaces and enforcement

- `/studio` is a normal Foilbury session with live role checks. It is available
  to Bot Owners/Admins and scoped Global Collection Admins. No Cloudflare Access
  identity is required, and none is treated as a role.
- `/admin` remains the Cloudflare-Access-protected operator surface.
- `/platform-admin` remains Cloudflare Access plus the provisioned Super Admin.
- `/api/v1/studio/*` uses the same domain routes as `/api/v1/admin/*` but is
  reachable by a scoped session. The Worker enforces the role on every request.
- A Global Collection Admin's agent grant can use `content:read` and
  `content:write` for the same scope; it cannot use platform routes.
- Revocation takes effect on the next request because roles are loaded from D1,
  not copied into a long-lived session.

## Audit

Every grant, scope change and revocation writes `platform.role.assigned` or
`platform.role.revoked` with the actor, target, scope and reason. Collection
edits write `collection.*` audit rows. The People & roles and Audit screens read
the same records.

## Explicit exclusions

- Cloudflare Access admission is authentication, not a Foilbury role.
- Discord guild ownership and moderator status create no Foilbury authority.
- A Bot Admin invitation cannot escape its Bot or its capability set.
- Public approval is never delegated to a scoped collection administrator.
- `scope`, `status`, `view_audience` and distribution remain separate dimensions.


## Scoped Foil grants (2026-11-04)

A Bot Admin's money authority is explicit and separable from content work:

- capability `grants` is required; it does not come from Discord roles, guild
  ownership or Cloudflare Access;
- `self_grants_enabled` and `grant_limit` are stored on the live membership and
  reread at the mutation boundary;
- a scoped grant is a positive whole number only, within the visible ceiling;
- self-grants fail when disabled; another person's grant still requires the
  capability and ceiling;
- revocation, expiry and stale forms fail on the next request because the live
  membership is rechecked;
- the Super Admin/Bot Owner can edit an existing account's capabilities and
  policy without deleting or reinviting it; every change is audited with reason
  and increments `capability_revision`;
- the scoped workspace is `/studio`; `/studio/economy` is the Foil page where
  permitted. `/admin` and `/platform-admin` remain owner/Super Admin entrances,
  not destinations for scoped Admins;
- an agent token intersects the represented person's live authority; it cannot
  restore a revoked capability.
