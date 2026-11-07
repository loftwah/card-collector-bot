# Delivery showcase

The owner's Woodhouse Discord showcase is the running, human-facing record of
delivered **Foilbury** work. It answers: what changed, why it matters, which
issue or pull request owns it, and where to inspect the result.

It is not a second release system and not acceptance evidence. The release
receipt, the issue checkpoint and the exercised live journey remain authoritative.

The shared contract lives in
[Woodhouse `docs/DISCORD_SHOWCASE.md`](https://github.com/loftwah/woodhouse-new/blob/main/docs/DISCORD_SHOWCASE.md)
and is tracked by [Woodhouse #171](https://github.com/loftwah/woodhouse-new/issues/171).

## Transport

`WOODHOUSE_DISCORD_CHANNEL` is the **webhook URL**, not a numeric channel ID.
It is a secret: keep it in `.env` or the host's private environment, never in a
tracked file, payload, screenshot or log. `WOODHOUSE_DISCORD_WEBHOOK_URL` is an
optional alias only when the canonical variable is absent.

Use the shared Woodhouse wrapper from a trusted local checkout, with this
repository as the working directory:

```sh
node /path/to/woodhouse-new/scripts/showcase-delivery.mjs \
  /private/foilbury-event.json
```

Omit `--send` first and inspect the payload. Add `--send` only when the event is
accurate and public-safe. The wrapper verifies the repository, observes remote
`main`, deduplicates, sends, and reads the message back. Do not curl-and-run
moving remote code.

The wrapper's state directory defaults to
`~/.local/state/woodhouse-discord-showcase`. Keep it outside the repository and
use the same directory when continuing on the same host.

## Status vocabulary

| Status | Meaning |
| --- | --- |
| `MERGED_TO_MAIN` | Source is integrated; production may still be pending |
| `PRODUCTION_VERIFIED` | The exact deployed source/version and the affected live flow were checked |
| `DOCS_TOOLING_DONE` | Non-runtime work is checked on `main`; no redeploy needed |
| `BLOCKED` | A concrete external impediment; state the next action |
| `RELEASE_FAILED` | The release failed; state the exact failing step |
| `PROJECT_HIGHLIGHT` | A useful milestone or authentic visual; makes no release claim |

## Event shape

The shared wrapper validates the event. A Foilbury event should include:

```json
{
  "project": "Foilbury",
  "repo": "loftwah/card-collector-bot",
  "stage": "PRODUCTION_VERIFIED",
  "outcomeId": "collector-identity-discord-2026-11-07",
  "title": "Collector identity in Discord",
  "summary": "The saved profile composition appears in /foilbury profile and deliberate profile shares.",
  "whyItMatters": "A collector can show a chosen look, exact featured copy and earned badges instead of a count-only summary.",
  "issues": [
    { "number": 46, "url": "https://github.com/loftwah/card-collector-bot/issues/46", "state": "open" }
  ],
  "pullRequests": [
    { "number": 100, "url": "https://github.com/loftwah/card-collector-bot/pull/100", "state": "merged" }
  ],
  "commit": "90929837d0a3a0dd3863441847f2dd10fd5e7a71",
  "source": "90929837d0a3a0dd3863441847f2dd10fd5e7a71",
  "version": "Worker 5e523dd3-692b-44ee-b971-0ee533f89e59",
  "inspect": "https://foilbury.loftwah.com/play/profile",
  "verified": "Deployed build identity and read-only smoke; signed-in profile/share composition inspected.",
  "limits": "Real Discord client invocation, mobile capture and independent spectator remain for #7/#19.",
  "demoUrl": "https://foilbury.loftwah.com/play/profile"
}
```

Use the actual field names required by the current shared wrapper; the example
above is the intended semantic content, not a substitute for reading its
validator. Keep text concise and suitable for the channel audience.

## What belongs in a post

- one coherent outcome, announced by the integrator;
- real issue and pull request links with their actual state;
- source SHA and deployed version;
- changed behaviour and why it matters;
- the exact route, command or share to inspect;
- what was verified and what remains;
- public-safe screenshots or a real feature link when useful.

Do not post per commit, per test run or per review finding. Never post secrets,
private card art, member data, restricted screenshots, or a claim that a blocked
human step passed. A notification failure is a notification fault, not a reason
to redeploy or to claim the post succeeded.
