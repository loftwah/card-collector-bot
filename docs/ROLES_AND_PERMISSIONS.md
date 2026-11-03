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
| Grant Super Admin | Provisioning script only | No | No | No | No |
| Manage Access / secrets / deployment | Cloudflare owner path | No | No | No | No |
| Mint cards, spend Foil, alter another inventory | No direct UI; domain services only | No | Scoped grants only | Scoped grants only | Own play only |
| Read another member's wallet or ledger | No | No | No | No | No |
| Grant the scoped platform role | Yes | No | No | No | No |

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
