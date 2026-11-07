# Delivery showcase channel

The owner's Woodhouse Discord channel is the **human-facing delivery showcase**
for Foilbury. It is where the owner can see what reached `main` and production,
which issue or pull request it belongs to, and what to look for in the product.

It is **not** acceptance evidence. A posted message does not replace a deployed
build identity, a focused test, a rendered browser check or a real Discord-client
observation. Keep those receipts in the usual places.

## Configuration

The webhook lives in `.env` as `WOODHOUSE_DISCORD_CHANNEL`. It is a secret and is
never committed. `.env.example` keeps an empty placeholder.

```sh
# .env
WOODHOUSE_DISCORD_CHANNEL=https://discord.com/api/webhooks/...
```

## When to post

Post one concise update after a coherent outcome reaches production:

- one issue or a small, tightly coupled issue/PR set;
- the exact source revision and Worker version;
- the live URL or the exact Discord command/share to try;
- the visible behaviour to look for;
- an honest status: `PRODUCTION_VERIFIED`, `IN_PROGRESS` or `BLOCKED`;
- the real residual (for example mobile or independent spectator proof).

Do not post per commit, per test run or per review finding. Do not post private
card art, member data, tokens, emails, screenshots of restricted content or a
claim that a blocked human step passed.

## Command

```sh
pnpm showcase:post -- \
  --title "Collector identity in Discord" \
  --summary "The saved profile composition now appears in /foilbury profile and in deliberate profile shares." \
  --issues 46,43,41,42 \
  --pr 100 \
  --source 90929837d0a3a0dd3863441847f2dd10fd5e7a71 \
  --worker 5e523dd3-692b-44ee-b971-0ee533f89e59 \
  --url "https://foilbury.loftwah.com/play/profile" \
  --look-for "Open /foilbury profile: selected look, featured owned copy and badges." \
  --look-for "Use Share preview in a members channel: the same composition is posted; public channels stay counts-only." \
  --status PRODUCTION_VERIFIED \
  --key profile-discord-2026-11-07
```

The script:

- reads the webhook from `.env` or the environment;
- posts one embed with issue/PR links, source/Worker, live URL, what to look for
  and status;
- never prints the webhook URL;
- records the posted message under `.foilbury/showcase/<key>.json`;
- refuses to repost the same `--key` unless `--force` is passed;
- supports `--dry-run` to inspect the exact payload;
- suppresses mentions.

## Message shape

| Field | Content |
| --- | --- |
| Issues and pull request | Links to the exact issue(s) and PR |
| Source and deployment | Source SHA and Worker version |
| Live | Production URL or the command to run |
| What to look for | One to four concrete visible checks |
| Status | `PRODUCTION_VERIFIED`, `IN_PROGRESS` or `BLOCKED` |
| Footer | Foilbury delivery showcase and short source |

## Relationship to the release contract

The showcase is the owner's view of delivery, not a second release system. The
release receipt, the issue checkpoint and the live journey remain the authority.
If the showcase says `PRODUCTION_VERIFIED`, the production build identity and the
affected journey must have actually been exercised on that revision.
