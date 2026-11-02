#!/usr/bin/env node
/**
 * Explicitly labelled admin webhook test command.
 *
 * This is not a bot token, login method or interaction endpoint. It is not run
 * during setup, startup, tests or acceptance. `--send` is deliberately refused
 * in this local-review build so a reviewer cannot accidentally deliver a
 * message before the owner approves the integration phase.
 */
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const envFile = path.join(root, ".env");
if (!fs.existsSync(envFile)) {
  console.error("Admin webhook test: no private .env file. Nothing was sent.");
  process.exit(2);
}
const values = new Map();
for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
  const index = line.indexOf("=");
  if (index > 0 && !line.trimStart().startsWith("#")) values.set(line.slice(0, index).trim(), line.slice(index + 1).trim());
}
const canonical = values.get("ADMIN_DISCORD_WEBHOOK_URL") ?? "";
const alias = values.get("DISCORD_WEBHOOK_URL") ?? "";
if (canonical && alias && canonical !== alias) {
  console.error("Admin webhook test: canonical and alias names hold different values. Resolve them explicitly; nothing was sent.");
  process.exit(2);
}
const configured = canonical || alias;
if (!configured) {
  console.error("Admin webhook test: no ADMIN_DISCORD_WEBHOOK_URL configured. Nothing was sent.");
  process.exit(2);
}
const send = process.argv.includes("--send");
if (send) {
  console.error("Admin webhook test: delivery is intentionally disabled in this local-review build. No request was made.");
  process.exit(2);
}
console.log("Admin webhook test: destination is configured (URL redacted).");
console.log("No request was sent. This labelled command is prepared for the owner-authorised integration phase; it is not a bot token, login or incoming command endpoint.");
console.log("To review the future delivery plan, read docs/DISCORD_HANDOFF.md.");
