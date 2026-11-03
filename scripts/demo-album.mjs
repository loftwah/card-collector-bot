#!/usr/bin/env node
/**
 * Prepare the local demonstration album.
 *
 * This is a local-only demonstration helper. It uses the platform owner's
 * local development session and the real administrator gift, inventory,
 * achievement and ledger services. Production has no equivalent bypass.
 *
 * Usage:
 *   pnpm demo:album                          # dry run, 7/8 plan
 *   pnpm demo:album --mode seven --apply     # prepare 7 unique cards
 *   pnpm demo:album --mode complete --apply  # complete the 8-card album
 *   pnpm demo:album --mode reset --apply     # retire only this run's grants
 */
import { ensureServer, BASE_URL } from "./lib/api.mjs";

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const modeArg = process.argv.find((value) => value.startsWith("--mode="));
const mode =
  modeArg?.split("=")[1] ??
  (args.has("--mode") ? process.argv[process.argv.indexOf("--mode") + 1] : "seven");
const emailArg = process.argv.find((value) => value.startsWith("--email="));
const email =
  emailArg?.split("=")[1] ??
  (args.has("--email")
    ? process.argv[process.argv.indexOf("--email") + 1]
    : "player@foilbury.local");
const baseURL = process.env.FOILBURY_URL ?? BASE_URL;

if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(baseURL)) {
  throw new Error("The demonstration album helper only targets the local server.");
}
if (!["seven", "complete", "reset"].includes(mode))
  throw new Error("Use --mode seven, complete or reset.");
if (
  !["player@foilbury.local", "owner@foilbury.local", "tour.demo@foilbury.local"].includes(email)
) {
  throw new Error("Use a clearly labelled local demonstration account.");
}

await ensureServer();

const login = await fetch(`${baseURL}/api/v1/dev/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "owner@foilbury.local" }),
});
if (!login.ok) throw new Error(`Local owner sign-in failed: HTTP ${login.status}`);
const cookies = login.headers
  .getSetCookie()
  .map((cookie) => cookie.split(";")[0])
  .join("; ");

const response = await fetch(`${baseURL}/api/v1/dev/demo-album`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie: cookies },
  body: JSON.stringify({ email, collectionSlug: "danganronpa-three-games", mode, dryRun: !apply }),
});
const payload = await response.json().catch(() => null);
if (!response.ok) {
  throw new Error(
    `Demo album preparation failed: HTTP ${response.status} ${JSON.stringify(payload)?.slice(0, 600)}`,
  );
}
console.log(JSON.stringify({ base_url: baseURL, mode, applied: apply, ...payload }, null, 2));
