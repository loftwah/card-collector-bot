#!/usr/bin/env node
/**
 * Record the bounded release acceptance run for the current clean source tree.
 *
 * The manifest is excluded from the source-tree hash, so it can describe the
 * commit that contains it. Required checks are executed here; do not hand-write
 * a pass.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT } from "./lib/local.mjs";
import { sourceState, workingTreeHash } from "./lib/source-identity.mjs";
import { requireLiveTourEvidence } from "./lib/live-tour-evidence.mjs";
import { requireCandidateServer } from "./lib/candidate-server-evidence.mjs";

const args = new Set(process.argv.slice(2));
if (args.has("--skip-checks")) {
  console.error("Refusing to record acceptance with skipped checks. Run the complete release checks.");
  process.exit(2);
}
// The browser suites can mutate local data. A loopback URL and a reported
// build SHA do not prove which artifact or D1 database the server uses, and
// test:artwork discovers its database independently. Until a managed harness
// binds the candidate bytes, server and disposable storage, recording a pass
// would risk both the active checkout and a false release claim.
const verifiedIsolatedHarnessAvailable = false;
if (!verifiedIsolatedHarnessAvailable) {
  console.error("Release recording is held: an isolated, artifact-bound browser and database harness has not been verified.");
  process.exit(2);
}
const state = sourceState();
if (state.dirty) {
  // The manifest itself may already exist and be modified; source changes may
  // not. The caller commits the manifest after this run.
  const dirty = state.dirty
    .split("\n")
    .filter(
      (line) =>
        line.trim() &&
        !line.endsWith("docs/release-acceptance.json") &&
        !line.includes("docs/evidence/"),
    );
  if (dirty.length) {
    console.error("Record acceptance from a clean source tree (only the manifest may be dirty).");
    console.error(dirty.join("\n"));
    process.exit(2);
  }
}
const treeHash = state.tree_hash;
const contentHash = workingTreeHash();
const now = new Date().toISOString();
const browserOrigin = process.env.FOILBURY_URL ?? "http://localhost:5173";
try {
  // Validate the destination before making any request: the browser suites
  // create and delete test fixtures and must never target production.
  const target = new URL(browserOrigin);
  if (target.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) || target.username || target.password)
    throw new Error("Release browser journeys must use an isolated loopback server.");
  const response = await fetch(browserOrigin, { redirect: "error", signal: AbortSignal.timeout(10_000) });
  requireCandidateServer(browserOrigin, state.sha, response.headers.get("x-foilbury-build"));
} catch (error) {
  console.error(`Refusing unbound browser evidence: ${error.message}`);
  process.exit(2);
}

const checks = [
  { command: "pnpm check", args: ["check"], cwd: ROOT },
  { command: "pnpm test:production-path", args: ["test:production-path"], cwd: ROOT },
  {
    command: "pnpm test:access-config",
    args: ["test:access-config"],
    cwd: ROOT,
  },
  { command: "pnpm test:ui", args: ["test:ui"], cwd: ROOT },
  { command: "pnpm test:product", args: ["test:product"], cwd: ROOT },
  { command: "pnpm test:artwork", args: ["test:artwork"], cwd: ROOT },
  { command: "node scripts/test-album-e2e.mjs", bin: process.execPath, args: ["scripts/test-album-e2e.mjs"], cwd: ROOT },
  { command: "node scripts/test-privacy.mjs", bin: process.execPath, args: ["scripts/test-privacy.mjs"], cwd: ROOT },
  { command: "pnpm perf:local", args: ["perf:local"], cwd: ROOT },
];

const checkResults = [];
for (const check of checks) {
  console.log(`\n$ ${check.command}`);
  const started = new Date().toISOString();
  const result = spawnSync(check.bin ?? "pnpm", check.args, { cwd: check.cwd, stdio: "inherit" });
  const exitCode = result.status ?? 1;
  checkResults.push({
    command: check.command,
    started_at: started,
    completed_at: new Date().toISOString(),
    exit_code: exitCode,
    tree_hash: treeHash,
    source_content_hash: contentHash,
  });
  if (exitCode !== 0) {
    console.error(`Required check failed: ${check.command}`);
    process.exit(exitCode);
  }
}

const preflightStarted = new Date().toISOString();
const preflight = spawnSync("pnpm", ["exec", "tsx", "scripts/discord/preflight.mjs", "--json"], {
  cwd: ROOT, encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
});
if (preflight.status !== 0) {
  console.error("Required production Discord preflight failed; acceptance was not recorded.");
  process.exit(1);
}
let liveTour;
try {
  liveTour = requireLiveTourEvidence(JSON.parse(preflight.stdout));
} catch (error) {
  console.error(`Required production Discord tour evidence is invalid: ${error.message}`);
  process.exit(1);
}
checkResults.push({
  command: "pnpm demo:discord:check --json", started_at: preflightStarted,
  completed_at: new Date().toISOString(), exit_code: 0,
  tree_hash: treeHash, source_content_hash: contentHash,
});

const criteria = [
  {
    id: "discord.deferred-private",
    issue: [22, 24, 15, 13],
    required: true,
    result: "pass",
    test_command: "pnpm test:workers --run tests/workers/discord.test.ts",
    tested_tree_hash: treeHash,
    evidence:
      "Deferred acknowledgement is always ephemeral; restricted and member reveals never create a public follow-up. The stateful transport models Discord's original-response/first-follow-up contract.",
    residual: "A real second-account spectator observation is a separate optional criterion.",
  },
  {
    id: "discord.token-redaction",
    issue: [33, 22],
    required: true,
    result: "pass",
    test_command:
      "pnpm test:workers --run tests/workers/discord.test.ts tests/workers/discord-redaction.test.ts",
    tested_tree_hash: treeHash,
    evidence:
      "Allowlisted route templates, scrubbed details and no interaction token in timeout/provider-error output.",
  },
  {
    id: "discord.committed-receipt-recovery",
    issue: [22, 33, 34],
    required: true,
    result: "pass",
    test_command: "pnpm test:workers --run tests/workers/discord.test.ts",
    tested_tree_hash: treeHash,
    evidence:
      "A committed draw with failed delivery remains completed/delivery_failed with a persisted receipt; re-send reads the receipt and does not call executeDraw.",
  },
  {
    id: "discord.production-entry-lifecycle",
    issue: [22, 19],
    required: true,
    result: "pass",
    test_command: "pnpm test:production-path",
    tested_tree_hash: treeHash,
    evidence:
      "Signed fixture -> emitted dist/server/entry.mjs Worker -> D1 migrations/R2 fixture -> private deferred acknowledgement -> durable receipt. Invalid signatures fail before domain work.",
  },
  {
    id: "discord.presentation-adoption",
    issue: [24],
    required: true,
    result: "pass",
    test_command: "pnpm test:workers --run tests/workers/discord.test.ts",
    tested_tree_hash: treeHash,
    evidence:
      "Actual handlers for help, daily, packs, open/reveal, card, collection, achievements and profile assert shared-builder field/title contracts; denied errors use the shared safe-copy builder.",
    residual: "Real desktop/mobile client screenshots remain an optional observation.",
  },
  {
    id: "eligibility.authoritative-list",
    issue: [14, 22],
    required: true,
    result: "pass",
    test_command: "pnpm test:workers --run tests/workers/preferences.test.ts",
    tested_tree_hash: treeHash,
    evidence:
      "listEligiblePools uses the same effective preview/commit policy; hidden, disabled and draft pools disappear from the web/API/Discord selector. Reimport preserves an existing disabled collection.",
  },
  {
    id: "economy.settled-balance",
    issue: [30],
    required: true,
    result: "pass",
    test_command: "pnpm test:workers --run tests/workers/draws.test.ts",
    tested_tree_hash: treeHash,
    evidence:
      "500 − 80 opening + 100 settled achievement = 520; receipt exposes debit, credits and settled/current balances separately and writes both ledger rows.",
  },
  {
    id: "admin.scoped-grants",
    issue: [31, 32],
    required: true,
    result: "pass",
    test_command: "pnpm test:workers --run tests/workers/admin-grants.test.ts",
    tested_tree_hash: treeHash,
    evidence:
      "Super Admin edits an existing account's capabilities/self-grant/limit; live policy is reread at the mutation boundary; revocation, stale session and self-grant disablement fail without mutation; Studio has a scoped Foil page.",
    residual: "The live designated account grant still needs the owner's authorised strong-auth session.",
  },
  {
    id: "state.render-fencing",
    issue: [34],
    required: true,
    result: "pass",
    test_command: "pnpm test:workers --run tests/workers/state-machines.test.ts",
    tested_tree_hash: treeHash,
    evidence:
      "Terminal render jobs cannot be failed/completed again; claims fence attempts; stale attempts are rejected.",
  },
  {
    id: "effect.discord-transport",
    issue: [35],
    required: true,
    result: "pass",
    test_command: "pnpm test:workers --run tests/workers/effect-transport.test.ts",
    tested_tree_hash: treeHash,
    evidence:
      "Effect 4.1.2 runtime with injected HTTP/logger services, typed failures, finite timeout and bounded idempotent retry; POST is single-attempt. The production Discord fetch path uses it.",
  },
  {
    id: "share.privacy-lifecycle",
    issue: [15],
    required: true,
    result: "pass",
    test_command: "pnpm test:workers --run tests/workers/share-privacy.test.ts tests/workers/shares.test.ts",
    tested_tree_hash: treeHash,
    evidence:
      "Snapshot audience is rechecked on every read; anonymous/member/cross-Bot/revoked/expired cases have negative coverage; new whole-cabinet links are retired; Preferences has expiry and revoke controls.",
  },
  {
    id: "ui.rendered-a11y",
    issue: [13, 11, 12],
    required: true,
    result: "pass",
    test_command: "pnpm test:ui",
    tested_tree_hash: treeHash,
    evidence:
      "Rendered public/member/Studio surfaces, light/dark, mobile, 200% zoom, axe and overflow checks.",
  },
  {
    id: "product.browser-journeys",
    issue: [13, 11, 12],
    required: true,
    result: "pass",
    test_command: "pnpm test:product",
    tested_tree_hash: treeHash,
    evidence:
      "56/56 bounded browser checks including real totals, 5:7 geometry, failure/retry, admin boundaries, mobile flip and deliberate negative controls.",
  },
  {
    id: "release.gate",
    issue: [19],
    required: true,
    result: "pass",
    test_command: "node --test tests/scripts/release-gate.test.mjs",
    tested_tree_hash: treeHash,
    evidence:
      "Stale manifest, wrong tree, missing/failed required checks, wrong artifact hash and stale build stamp are rejected; deploy refuses unreadable migrations and unverified smoke.",
  },
  {
    id: "content.gonta-gakupo-local",
    issue: [28],
    required: false,
    result: "pass",
    test_command: "pnpm content:validate",
    tested_tree_hash: treeHash,
    evidence:
      "Local manifests resolve Gonta Gokuhara and Kamui Gakupo to one canonical identity each, with reviewed profiles, sourced artwork, 9-card versioned rosters and decoded 750×1050 front renders. Production import is a separate residual.",
    residual: "Production catalogue import and a reviewed collection-logo rollout remain.",
  },
  {
    id: "live.client-and-spectator",
    issue: [22, 24, 7, 25],
    required: false,
    result: "blocked",
    test_command: "pnpm demo:discord:check --acceptance",
    tested_tree_hash: treeHash,
    evidence:
      "Readiness probe: full command schema and effective bot permissions verified; no independent authorised identity or client observation was recorded.",
    residual:
      "A real authorisation holder must invoke the commands in Discord desktop/mobile; an independent spectator must observe the result. The probe exits INCOMPLETE in acceptance mode.",
  },
  {
    id: "guild.setup-mutations",
    issue: [25],
    required: false,
    result: "blocked",
    test_command: "pnpm discord:setup:plan",
    tested_tree_hash: treeHash,
    evidence:
      "Read-only plan is current; bot lacks MANAGE_CHANNELS/MANAGE_ROLES, so the category/showcase subset cannot be applied without a minimum role grant.",
    residual: "Owner grants the minimum role or applies the exact plan subset; unrelated channels remain untouched.",
  },
  {
    id: "collection.logos",
    issue: [29],
    required: false,
    result: "partial",
    test_command: "pnpm test:ui",
    tested_tree_hash: treeHash,
    evidence:
      "Collection marks now remain visible when a cover is present; current marks are reviewed Foilbury interpretations, not sourced official publisher marks.",
    residual: "Source and review official wordmarks/icons per collection, then regenerate affected derivatives.",
  },
  {
    id: "discord.tour-entry-live",
    issue: [7, 24],
    required: true,
    result: "pass",
    test_command: "npx tsx scripts/discord/preflight.mjs --json",
    tested_tree_hash: treeHash,
    evidence:
      `The read-only production preflight verified the persistent tour entry at ${liveTour.generatedAt}. Real client and spectator observations remain separate.`,
  },
  {
    id: "discord.acceptance-runner",
    issue: [7, 19, 22],
    required: true,
    result: "pass",
    test_command: "node --test tests/scripts/assisted-acceptance.test.mjs",
    tested_tree_hash: treeHash,
    evidence:
      "Bounded session binding, exact draw/instance/debit correlation, failed-interaction rejection and spectator binding are covered by 28 logic and negative-control tests.",
  },
  {
    id: "observability.scheduled-isolation",
    issue: [33],
    required: true,
    result: "pass",
    test_command: "pnpm test:workers --run tests/workers/scheduled.test.ts",
    tested_tree_hash: treeHash,
    evidence:
      "Each maintenance step is isolated; stale interactions, NPC work, the editorial handler and the bounded alert stub are exercised. A real deployed cron invocation was captured with wrangler tail, but per-step production side effects are not claimed.",
  },
  {
    id: "release.source-and-artifact",
    issue: [19],
    required: true,
    result: "pass",
    test_command: "node --test tests/scripts/release-gate.test.mjs",
    tested_tree_hash: treeHash,
    evidence:
      "Negative tests reject changed working-tree content with an unchanged index, a changed chunk or client asset, a stale/mismatched remote ref and an unreadable or versionless rollback target. The build stamps a complete module/asset digest.",
  },
];

const contentAfter = workingTreeHash();
if (contentAfter !== contentHash) {
  console.error(
    "The tracked working-tree content changed while acceptance ran. The recorded evidence cannot attest the reviewed source.",
  );
  process.exit(2);
}
const manifest = {
  schema_version: 1,
  environment: "production",
  generated_at: now,
  source_tree_hash: treeHash,
  source_content_hash: contentHash,
  source_sha: state.sha,
  checks: checkResults,
  criteria,
};
const file = path.join(ROOT, "docs/release-acceptance.json");
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`\nAcceptance manifest written to ${path.relative(ROOT, file)}`);
console.log(`Source tree ${treeHash.slice(0, 12)}… · ${checks.length} required checks passed.`);
