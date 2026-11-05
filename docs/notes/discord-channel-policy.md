# Discord channel policy parser

The Discord installation resolver and installation-scoped preview share a strict parser for channel lists and audience maps. Invalid JSON, malformed entries and duplicate decoded channel keys fail closed. A missing audience map defaults to public; a valid channel-less headless preview uses public audience. The Discord handler still requires its actual channel to pass the installation allowlist.

This change does not fence policy changes between preview, draw, recovery and external Discord delivery. It does not establish current media-byte authorization or qualify deployment. A malformed installation requires an administrator to repair its configuration through an authorized management route.

Discord interactions resolve scope against their actual signed channel. An
active Discord-linked Bot membership by itself is insufficient for a restricted
collection because first interaction can create that membership automatically.
Restricted Discord scope additionally requires the nonrevoked explicit viewer
grant on that collection, or the provisioned `usr_prod_owner` account with
its current Super Admin flag. The Discord identity, account, installation and
membership must still be active. This does not create grants or turn on any
collection. Other previously active members without an explicit grant are
denied restricted Discord access until a trusted admission is recorded; public
onboarding remains available. This is a conservative compatibility restriction,
not a claim that OAuth-link provenance has been reconstructed.

These checks are current at scope resolution; they are not atomic with later
D1 draw commits, R2 reads or Discord delivery. A permission change during that
window remains a release blocker for restricted content, and an ephemeral
response is not proof that the bytes cannot be accessed by a wider audience.
No Discord or production interaction was performed for this draft.

Persistent channel sharing is narrowed in this candidate: card posts require a
currently public-safe card even in a members-labelled channel. Completion and
profile posts are withheld if the resolved scope contains a restricted
collection; completion also requires every linked collection for its cards to
be public and inside that scope. Public-safe card sharing is available only
when the Bot's AI-art setting is enabled; it is held entirely when AI art is
disabled until complete render lineage can be verified. This changes what members can share publicly and is not full tour
acceptance. The checks still precede external delivery; a concurrent policy,
membership, content or grant change can race the R2 read or Discord send.

Because the present render reader does not prove complete recipe and asset
lineage, this candidate withholds persistent card, completion and profile shares
for Bots with AI art disabled, including stale button presses. This is an
intentional temporary restriction, not a claim that every public image uses AI.
Historical receipt retries recheck current scope and the current published
card/variant before showing names, serials or artwork; they use the balance
recorded with the draw and omit potentially out-of-scope historical labels.
The current reader still checks only direct AI origin for those private retries,
and does not fence an authorization change after the check. Full lineage and
delivery fencing remain required before restricted-content release.
