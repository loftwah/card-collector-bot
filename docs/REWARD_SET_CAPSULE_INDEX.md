# Set-specific capsule recommendations: outstanding contract

Rewards currently links an incomplete set to the Draw Room without claiming
that any capsule contains a missing set card. The Draw Room shows the current
viewer's eligible cards and live odds.

A set-specific recommendation is not yet implemented. Public set releases
make their reviewed roster public, but a pool's eligibility still depends on
the viewer's membership, collection visibility, Bot configuration, personal
filters and art lineage. Member-set review currently authorises the roster to
eligible members; it does not separately approve disclosure of a missing
card's association with a pool.

Before enabling targeted recommendations:

- Define an authorised release-to-pool disclosure for each audience, including
  explicit member-release policy.
- Build a complete viewer-authorised eligible-pool intersection with bounded
  work before expanding hidden rows. An overload or partial result must not
  reveal the number or existence of inaccessible pools or cards.
- Bind publication and reads to the current viewer, live session, release and
  roster, pool distribution, preferences, art lineage and cross-Bot authority;
  invalidate atomically on every dependency and check current ownership.
- Show live odds again at the Draw Room, with a safe generic fallback for
  missing, revoked, stale or unavailable data. Test revocation and membership
  races, unrelated hidden-row growth, overload and user-visible timing.

An isolated public-only prototype and its race tests are retained under
`.foilbury/tmp/rewards-ux-kneZSn/`; it is not wired into the product. Its raw
pool and entry caps were applied too late to prove bounded database work, and
moving those caps before personalised eligibility could create an oracle.
