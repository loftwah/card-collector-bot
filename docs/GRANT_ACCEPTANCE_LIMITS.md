# Foil grant qualification limits

The local adjustment path commits its wallet change, ledger row, idempotency
receipt and audit entry in one D1 batch. The batch rechecks the Bot, actor,
recipient and applicable session or linked Access identity. A successful local
fixture is not evidence of a production grant.

Agent credentials currently fail closed for adjustments because the domain
context does not bind the exact grant/token for commit-time revocation checks.
Discord confirmations also fail closed: they do not bind a recent strong-auth
session. The message directs the person to complete the adjustment in signed-in
Studio. Both remain unfinished supported journeys, not accepted functionality.

The Access branch uses the verified request-scoped identity, its JWT expiry and
the current identity link. The existing Access context establishes its own
assurance for that verified request; it does not prove the age of the user's
actual Access login. The focused fixture supplies a mock verified context and
does not establish real Access JWT or provider acceptance. A real qualified
Access journey and a reliable, documented recency guarantee remain open.
