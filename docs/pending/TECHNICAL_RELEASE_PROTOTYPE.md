# Technical corrective release prototype — held pending review

This is an unqualified implementation, not deployment authorization. The
legacy recorder is held because it can record skipped checks and hard-coded
claims. This path is restricted to the explicit reviewed website and release
files in `requireCorrectivePaths`; it cannot claim completion of the product or
Discord demonstration.

From a clean, committed candidate, run the supervisor with the reviewed local
immutable Docker image ID. It creates an isolated, network-none container with
no host mounts and synthetic state; executes fixed checks; verifies the actual
built-Worker listener, source, and artifact; exports the tested `dist`; and
writes private command logs plus a signed receipt. Any failure leaves its
container and private diagnostics for inspection and issues no receipt. The
image is pinned to the reviewed local ID and its dependency lock must match;
its provenance still requires independent review. Local execution does not
establish remote D1 latency or a real Discord-client journey.

The self-contained Ed25519 signature detects modification after signing; it is
not an identity credential or proof of owner authorization. Pin the receipt
SHA-256 displayed by the supervisor out of band. The release entry point's
`--technical-receipt=PATH --technical-receipt-sha256=HEX --check` validates
that pin, the signature, ordered command-output digests, source, and all artifact
bytes, plus the existing fresh remote, migration, prior Worker/rollback and
scope checks. It requires a verified prior release receipt matching the Worker
version currently serving production. For an actual authorized release the same
options without `--check` use the tested artifact without a rebuild, refuse a
different existing `dist`, and still require the ordinary deployment approval
and post-deploy smoke. Neither this prototype nor `--check` deploys anything.

Do not use this path until its source, image, command-output provenance,
listener ownership, artifact transfer and end-to-end failure controls have
been independently reviewed and its full exact-head run has passed. Product,
full-feature demonstration, independent spectator and client acceptance remain
open even if technical deployment later passes.
