# Discord setup capability table

Read-only target (verified by `pnpm demo:discord:check` and
`pnpm discord:setup:plan`):

- Guild: Loftwah `997734945206313041`
- Channel: `#card-collector-test` `1566700752385081355`
- Application: Foilbury `1566702936615026769`
- Guild command: `1566755562551779330`

| Operation | Current capability | Evidence / action |
|---|---|---|
| Read application, guild, channel | Yes | Bot token; read-only. |
| Register/edit guild commands | Yes | `applications.commands`; full schema read-back matches source. |
| Receive interactions and respond | Yes | Signed HTTP endpoint; endpoint probe returns 401 for unsigned bodies. |
| Send/edit/follow up bot messages | Yes | Effective channel permissions include VIEW_CHANNEL, SEND_MESSAGES, EMBED_LINKS, ATTACH_FILES, READ_MESSAGE_HISTORY. |
| Attach saved card renders | Yes | Same effective permissions; R2 delivery tested. |
| Pin bot messages | No / blocked | `PIN_MESSAGES` is not effective. This does **not** justify requesting `MANAGE_MESSAGES`; pinning is a separate optional setup action. |
| Create/move channels or categories | No / blocked | Bot has no dedicated guild role and lacks `MANAGE_CHANNELS`; effective position is @everyone. |
| Edit channel overwrites | No / blocked | Lacks `MANAGE_ROLES`; do not request Administrator. |
| Create/assign bot role | No / owner action | Requires `MANAGE_ROLES`; the missing role is not a member to assign. |
| Read guild webhooks | No / blocked | Discord returns 403 Missing Permissions; read-only discovery only. |
| Change application icon/banner | Developer Portal | Not a bot API mutation; owner-facing step. |
| Guild banner | Unavailable | Guild has no BANNER entitlement (boost tier 2). Cosmetic only. |
| Client observation | Human | Requires the authorisation holder's real Discord client. |
| Spectator observation | Human | Requires an independent authorised identity; same-account second tab does not count. |

## Minimal setup subset

The current plan proposes one Foilbury category, moving/re-topic-ing the existing
test channel, and a read-only showcase channel. None of the channel/role changes
can be applied until the owner grants `MANAGE_CHANNELS` and `MANAGE_ROLES` to a
dedicated bot role, or applies the subset manually. Do not grant Administrator.

Missing management rights block **setup mutations**, not command registration,
interaction transport, local/production-path tests, schema verification or the
remaining engineering backlog. No unrelated channel or the Loftwah identity is
changed by this work.

## Verified official distinctions

- `PIN_MESSAGES` (`1 << 51`) is the current pinning permission; `MANAGE_MESSAGES`
  (`1 << 13`) is for deleting others' messages. Pinning does not require it.
- Effective permissions are computed from @everyone, bot roles and channel
  overwrites, not from a role name or a single deny.
- `@everyone` View Channel denial is a policy signal, not proof that every
  member/role is excluded. A genuine spectator must be observed independently.
