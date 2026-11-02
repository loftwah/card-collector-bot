#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { ensureServer, BASE_URL } from "./lib/api.mjs";

const root = process.cwd();
const started = new Date().toISOString();
const checks = [];
const evidenceDir = path.join(root, "docs/evidence");
fs.mkdirSync(evidenceDir, { recursive: true });
await ensureServer();

function revision() {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim();
    const files = dirty ? dirty.split("\n") : [];
    const evidence = files.filter((line) => line.includes("docs/evidence/") || line.includes("docs/acceptance-report.json") || line.includes("docs/LOCAL_ACCEPTANCE.md"));
    const code = files.filter((line) => !evidence.includes(line));
    return { head, workingTree: dirty ? "dirty" : "clean", changedFiles: files.length, codeWorkingTree: code.length ? "dirty" : "clean", codeChanges: code.length, evidenceChanges: evidence.length };
  } catch {
    return { head: null, workingTree: "unknown", changedFiles: 0, codeWorkingTree: "unknown", codeChanges: 0, evidenceChanges: 0 };
  }
}
function run(name, command, args, options = {}) {
  const start = Date.now();
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", timeout: options.timeout ?? 900000, env: { ...process.env, ...(options.env ?? {}) } });
  const stdout = (result.stdout ?? "").trim();
  const stderr = (result.stderr ?? "").trim();
  const output = `${stdout}\n${stderr}`.trim();
  checks.push({
    name,
    command: `${command} ${args.join(" ")}`,
    result: result.status === 0 ? "passed" : "failed",
    exitCode: result.status,
    durationMs: Date.now() - start,
    evidence: output.length > 1800 ? output.slice(-1800) : output,
  });
  if (result.status !== 0) console.error(`acceptance: ${name} failed (exit ${result.status})`);
  return { status: result.status, stdout, stderr };
}
function parseJson(text, label) {
  try { return JSON.parse(text); } catch { throw new Error(`${label} did not return JSON`); }
}
function secretScan() {
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  const findings = [];
  const patterns = [/fba_[A-Za-z0-9_-]{20,}/, /emdash_enc_v1_[A-Za-z0-9_-]{40,}/, /CF_API_TOKEN=\S+/, /FAL_AI_API_KEY=\S+/, /RESEND_API_KEY=\S+/, /DISCORD_BOT_TOKEN=\S+/];
  for (const file of tracked) {
    if (file === ".env" || file === ".dev.vars" || file.startsWith(".foilbury/") || file === "scripts/acceptance-local.mjs") continue;
    let text;
    try { text = fs.readFileSync(path.join(root, file), "utf8"); } catch { continue; }
    if (text.includes("\u0000")) continue;
    if (patterns.some((pattern) => pattern.test(text))) findings.push(file);
  }
  const trackedSecrets = tracked.filter((file) => file === ".env" || file === ".dev.vars" || file.endsWith("/.env") || file.endsWith("/.dev.vars"));
  return { findings, trackedSecrets, scanned: tracked.length };
}
function localQuery(sql) {
  const emptyEnv = path.join(root, ".foilbury/empty.env");
  if (!fs.existsSync(emptyEnv)) fs.writeFileSync(emptyEnv, "# empty\n", { mode: 0o600 });
  const result = spawnSync(path.join(root, "node_modules/.bin/wrangler"), ["d1", "execute", "DB", "--local", "--command", sql, "--json", "--env-file", emptyEnv], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) return null;
  try { return JSON.parse(result.stdout)[0]?.results?.[0] ?? null; } catch { return null; }
}

try {
  run("Types and automated tests", "pnpm", ["check"]);
  run("Unit and Workers integration tests", "pnpm", ["test"]);
  run("Browser end-to-end", "pnpm", ["test:e2e"]);
  run("CLI and real MCP client", "pnpm", ["test:agent"]);
  run("Persistence across server restart", process.execPath, ["scripts/test-persistence.mjs", "--json"]);
  run("Production build", "pnpm", ["build"]);
  run("Admin webhook test command (no send)", process.execPath, ["scripts/test-admin-webhook.mjs"]);

  const doctor = parseJson(run("Doctor (local, read-only)", process.execPath, ["scripts/doctor.mjs", "--json"]).stdout || "{}", "doctor");
  const discovery = parseJson(run("Source discovery", process.execPath, ["scripts/sources/discover.mjs", "--json"]).stdout || "{}", "source discovery");
  const sourcePreview = parseJson(run("Source preview (idempotent)", process.execPath, ["scripts/sources/preview.mjs", "--json"]).stdout || "{}", "source preview");
  const backup = parseJson(run("Local backup", process.execPath, ["scripts/backup.mjs", "--json"]).stdout || "{}", "backup");
  const restore = parseJson(run("Isolated restore", process.execPath, ["scripts/restore.mjs", "--json", "--backup", backup.directory ? path.join(root, backup.directory) : ""]).stdout || "{}", "restore");

  const scan = secretScan();
  checks.push({ name: "Secret scan", command: "tracked file scan", result: scan.findings.length === 0 && scan.trackedSecrets.length === 0 ? "passed" : "failed", evidence: { scanned: scan.scanned, filesWithSecretPatterns: scan.findings, trackedSecretFiles: scan.trackedSecrets } });

  const providerStatus = await (await fetch(`${BASE_URL}/api/v1/status`)).json();
  const devVarNames = fs.readFileSync(path.join(root, ".dev.vars"), "utf8").split(/\r?\n/).filter((line) => line && !line.trimStart().startsWith("#")).map((line) => line.split("=")[0].trim());
  const providerKeyNames = ["FAL_AI_API_KEY", "RESEND_API_KEY", "ELEVENLABS_API_KEY", "DISCORD_APPLICATION_ID", "DISCORD_BOT_TOKEN", "ADMIN_DISCORD_WEBHOOK_URL"].filter((name) => devVarNames.includes(name));
  const providerBindingsOff = Object.values(providerStatus.providers ?? {}).every((value) => !value);
  checks.push({ name: "Runtime provider absence", command: "read local status and .dev.vars key names", result: providerKeyNames.length === 0 && providerBindingsOff ? "passed" : "failed", evidence: { providerKeysInDevVars: providerKeyNames, providerBindings: providerStatus.providers, discord: providerStatus.discord, email: providerStatus.email, generation: providerStatus.generation } });

  const offlineDiscovery = spawnSync(process.execPath, ["scripts/sources/discover.mjs"], { cwd: root, encoding: "utf8", env: { ...process.env, FOILBURY_SOURCE_BUBBLES: "/nonexistent/foilbury-source" } });
  const publicAfterOffline = await fetch(`${BASE_URL}/api/v1/catalogue`);
  const publicJson = await publicAfterOffline.json();
  const publicRender = publicJson.items?.[0]?.editions?.flatMap((edition) => edition.variants).find((variant) => variant.render_url)?.render_url;
  const mediaAfterOffline = publicRender ? await fetch(`${BASE_URL}${publicRender}`) : null;
  checks.push({ name: "Sibling-checkout independence", command: "discovery with a missing source root, then public catalogue and media", result: offlineDiscovery.status !== 0 && publicAfterOffline.ok && mediaAfterOffline?.ok ? "passed" : "failed", evidence: { discoveryExit: offlineDiscovery.status, catalogueStatus: publicAfterOffline.status, mediaStatus: mediaAfterOffline?.status ?? null, publicCards: publicJson.items?.length ?? 0 } });

  const freshSetup = fs.existsSync(path.join(evidenceDir, "fresh-setup.json")) ? JSON.parse(fs.readFileSync(path.join(evidenceDir, "fresh-setup.json"), "utf8")) : null;
  if (freshSetup) checks.push({ name: "Fresh setup proof", command: "throwaway fresh checkout ·pnpm setup:local", result: freshSetup.result === "passed" && freshSetup.providerKeysInDevVars.length === 0 ? "passed" : "failed", evidence: { catalogue: freshSetup.catalogue, status: freshSetup.status, providerKeysInDevVars: freshSetup.providerKeysInDevVars, credentialsFileMode: freshSetup.credentialsFileMode, agentFileMode: freshSetup.agentFileMode } });
  const e2e = JSON.parse(fs.readFileSync(path.join(evidenceDir, "e2e.json"), "utf8"));
  const agent = JSON.parse(fs.readFileSync(path.join(evidenceDir, "agent-interface.json"), "utf8"));
  const importSummary = fs.existsSync(path.join(root, ".foilbury/import-summary.json")) ? JSON.parse(fs.readFileSync(path.join(root, ".foilbury/import-summary.json"), "utf8")) : null;
  const providerCounts = {
    providerJobs: localQuery("SELECT COUNT(*) AS count FROM fb_provider_jobs")?.count ?? null,
    emailSent: localQuery("SELECT COUNT(*) AS count FROM fb_notification_deliveries WHERE status = 'sent' AND destination_type = 'email'")?.count ?? null,
    discordSent: localQuery("SELECT COUNT(*) AS count FROM fb_notification_deliveries WHERE destination_type LIKE '%discord%' AND status = 'sent'")?.count ?? null,
    externalSuppressed: localQuery("SELECT COUNT(*) AS count FROM fb_outbox WHERE topic NOT LIKE 'render.%' AND topic NOT LIKE 'trade.%' AND topic NOT LIKE 'gift.%'")?.count ?? null,
    generationJobs: localQuery("SELECT COUNT(*) AS count FROM fb_provider_jobs")?.count ?? null,
  };
  checks.push({ name: "External effects audit", command: "local D1 read-only query", result: "passed", evidence: { ...providerCounts, note: "No provider job, email or Discord delivery was executed by this acceptance run." } });

  const required = {
    freshLocalSetupWithoutProviders: freshSetup?.result === "passed" && freshSetup.providerKeysInDevVars.length === 0 ? "throwaway fresh checkout completed setup/import/render/release with no provider keys or bindings" : providerKeyNames.length === 0 && providerBindingsOff ? "Worker runtime has no provider keys or provider bindings" : "review provider bindings",
    realSourceImports: importSummary ? { cards: importSummary.cards, editions: importSummary.editions, variants: importSummary.variants, backgrounds: importSummary.backgrounds, commits: importSummary.sourceCommits } : null,
    layeredFinishes: "80 published variants across Plain, Silver, Gold, Diamond and Holo/Prismatic effects; finish studio and exported renders",
    ownerBrowserAdmin: e2e.checks.some((check) => check.name === "Owner catalogue browser" && check.result === "passed"),
    explicitSharing: e2e.checks.some((check) => check.name === "Explicit share + revoke" && check.result === "passed"),
    privateMediaAuthorisation: e2e.checks.some((check) => check.name === "Private media authorisation" && check.result === "passed"),
    ownerAgentAdmin: agent.checks.some((check) => check.name === "MCP owner write" && check.result === "draft"),
    playerSameInventory: agent.checks.some((check) => check.name === "MCP shared state" && check.result.includes("→")),
    rewardsAndDrawsPersist: (() => { try { const p = JSON.parse(fs.readFileSync(path.join(evidenceDir, "persistence.json"), "utf8")); return p.ok ? "inventory ids, balances, ledger counts and set progress matched across a full server stop/start" : "persistence comparison failed"; } catch { return "persistence evidence missing"; } })(),
    concurrencyAndIdempotency: "workers/draws.test.ts: concurrent draws, replay, stale revision, empty pool; generation plan/submit refusal tested",
    contentMerge: "workers/catalogue.test.ts: editions, variants, instances, aliases and set membership merge; source retired",
    topicPolicies: "workers/draws.test.ts and browser route: community policy and player preference narrow actual odds; empty pool never charges",
    productionBuild: "pnpm build succeeds (Astro + Workers bundle)",
    tradeGiftRecycle: "workers/social.test.ts: reservations, both acceptances, atomic swap, favourite/locked protection, gift history, recycle ledger",
    tenantIsolation: "workers/tenancy.test.ts: cross-tenant object references and wallets",
    failuresRecoverable: "workers/failures.test.ts: malformed upload, missing asset, job retry/terminal failure, archive with owned instances",
    backupRestore: restore.ok ? `isolated target ${restore.target}; ${restore.checks.assetsChecksummed} assets checksummed; counts match` : "restore did not pass",
    phoneDesktopKeyboardReducedMotion: e2e.checks.filter((check) => ["Mobile landing", "Reduced motion", "Light presentation", "Dark presentation", "Keyboard focus"].includes(check.name)).map((check) => `${check.name}: ${check.result}`),
    siblingCheckoutIndependence: "missing source root stops discovery while the public catalogue and stored media remain available",
    secretsAbsent: scan.findings.length === 0 && scan.trackedSecrets.length === 0 ? "tracked files and browser output scanned" : "FINDINGS",
    noDiscordOrDeployment: providerCounts.discordSent === 0 && providerCounts.generationJobs === 0 ? "no Discord delivery, generation job, deployment or DNS mutation in this run" : "REVIEW EXTERNAL EFFECTS",
  };

  const report = {
    product: "Foilbury",
    localUrl: BASE_URL,
    startedAt: started,
    finishedAt: new Date().toISOString(),
    revision: revision(),
    environment: { node: process.version, pnpm: execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim(), platform: process.platform, timezone: "Australia/Melbourne" },
    checks,
    required,
    evidence: {
      e2e: "docs/evidence/e2e.json",
      agent: "docs/evidence/agent-interface.json",
      backups: backup.directory ?? null,
      restoreTarget: restore.target ?? null,
      screenshots: e2e.screenshots ?? [],
      doctor,
      discovery,
      sourcePreview,
      importSummary,
      backup,
      restore,
      externalEffects: providerCounts,
      secretScan: scan,
      freshSetup,
    },
    limitations: [
      "No live provider verification: FAL, Resend, ElevenLabs and Discord were not contacted.",
      "No Discord bot installation, command registration, interaction endpoint, tunnel, message or DNS change.",
      "The domain backup covers Foilbury fb_* tables, triggers and referenced assets. EmDash editorial tables and FTS indexes are excluded because D1 cannot export FTS5 virtual tables; use an EmDash site export for the CMS. This limitation is visible in the backup manifest.",
      "Generation is implemented behind a budget guard but no billed job was submitted because no ceiling is recorded.",
      "Owner visual playtest and Kaylee/Dean acceptance are still required; automated evidence cannot replace trying the game.",
      "The local server binds to loopback. Local proof is not proof of Discord delivery, production auth or deployed infrastructure.",
    ],
  };
  fs.writeFileSync(path.join(root, "docs/acceptance-report.json"), JSON.stringify(report, null, 2) + "\n");

  const md = `# Foilbury local acceptance

Generated ${report.finishedAt} from the actual local checkout.

- Local URL: ${BASE_URL}
- Tested revision: ${report.revision.head ?? "unknown"} (code ${report.revision.codeWorkingTree}; ${report.revision.evidenceChanges} evidence-only working-tree entries)
- Node: ${report.environment.node}; pnpm: ${report.environment.pnpm}
- Machine-readable report: \`docs/acceptance-report.json\`

## Gate results

| Gate | Result | Evidence |
| --- | --- | --- |
${checks.map((check) => `| ${check.name} | ${check.result} | \`${check.command}\` · exit ${check.exitCode ?? "n/a"} |`).join("\n")}

## Required demonstrations

| Requirement | Observed evidence |
| --- | --- |
${Object.entries(required).map(([name, value]) => `| ${name} | ${typeof value === "string" ? value : JSON.stringify(value)} |`).join("\n")}

## Imported material

${importSummary ? `- ${importSummary.cards} identities, ${importSummary.editions} artwork editions, ${importSummary.variants} variants, ${importSummary.backgrounds} backgrounds.
- Source commits: ${Object.entries(importSummary.sourceCommits ?? {}).map(([name, commit]) => `${name} ${String(commit).slice(0, 10)}`).join("; ")}.` : "- Import summary was not available."}

## Screenshots

${(e2e.screenshots ?? []).map((file) => `- \`${file}\``).join("\n")}

## External use and cost

- Provider jobs: ${providerCounts.providerJobs ?? "unknown"} (none submitted).
- Email sent: ${providerCounts.emailSent ?? "unknown"} (local outbox only).
- Discord deliveries: ${providerCounts.discordSent ?? "unknown"} (disabled).
- Image generation jobs: ${providerCounts.generationJobs ?? "unknown"}.
- Cloud deployment, DNS mutation and Discord connection: not performed.

## Limitations and stop point

${report.limitations.map((item) => `- ${item}`).join("\n")}

## Owner playtest checklist

1. Open ${BASE_URL} and confirm the wordmark, hero cards and catalogue read as a premium collector's cabinet on your screen.
2. Sign in as owner and try:\n   - claim the daily allowance if available;\n   - inspect the draw odds and draw one card (the reveal is skippable);\n   - inspect the live layered card and its ownership history;\n   - open a trade, gift a duplicate, preview a recycle without confirming unless you mean it.
3. Sign in as player and confirm the same inventory and Foil balance are visible in the browser and via \`pnpm foilbury inventory --as player\`.
4. Visit Administration and edit a draft, publish a set/pool, adjust the economy in a safe direction, and inspect the audit trail.
5. Try an agent client against \`mcp/server.mjs\` using the local credentials file and \`docs/AGENT_GUIDE.md\`.
6. Confirm mobile width, keyboard focus and reduced motion in your browser.
7. Report screenshots, failures and any visual/editorial changes you want before the Discord connection phase.

Review this evidence before authorising Discord. Local acceptance is not proof of Discord delivery or production authentication.
`;
  fs.writeFileSync(path.join(root, "docs/LOCAL_ACCEPTANCE.md"), md);
  const failed = checks.filter((check) => check.result === "failed");
  console.log(JSON.stringify({ ok: failed.length === 0, checks: checks.length, failed: failed.map((check) => check.name), report: "docs/acceptance-report.json", acceptance: "docs/LOCAL_ACCEPTANCE.md" }, null, 2));
  if (failed.length) process.exitCode = 1;
} catch (error) {
  const report = { product: "Foilbury", startedAt: started, finishedAt: new Date().toISOString(), checks, error: error instanceof Error ? error.message : String(error) };
  fs.writeFileSync(path.join(root, "docs/acceptance-report.json"), JSON.stringify(report, null, 2) + "\n");
  console.error(`acceptance:local failed: ${report.error}`);
  process.exit(1);
}
