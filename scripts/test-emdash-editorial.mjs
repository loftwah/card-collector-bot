#!/usr/bin/env node
/**
 * Local EmDash editorial round-trip acceptance.
 *
 * Proves the supported native CMS workflow against the running local Worker:
 * author a draft with rich Portable Text, confirm it is not public, publish,
 * read the rendered journal entry, revise, schedule, and unpublish.
 *
 * This is a local acceptance fixture. It creates a short-lived local CMS API
 * token in the local D1 database, never prints it, and deletes it in `finally`.
 * It refuses to run against a non-loopback origin. The human native-console
 * Access session remains a separate, explicitly recorded gate.
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const baseURL = process.env.FOILBURY_URL ?? "http://localhost:5173";
const host = new URL(baseURL).hostname;
if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
  console.error("Refusing to run EmDash acceptance against a non-local origin.");
  process.exit(2);
}
if (process.env.FOILBURY_ENV === "production") {
  console.error("Refusing to run EmDash acceptance in production.");
  process.exit(2);
}

const evidenceRoot = path.join(".foilbury", "evidence");
fs.mkdirSync(evidenceRoot, { recursive: true });
const evidence = fs.mkdtempSync(path.join(evidenceRoot, "emdash-editorial-"));
const results = [];
const pass = (name, detail = "") => { results.push({ name, status: "PASS", detail }); console.log(`PASS ${name}${detail ? ` · ${detail}` : ""}`); };
const fail = (name, error) => { results.push({ name, status: "FAIL", detail: String(error?.message ?? error) }); console.error(`FAIL ${name} · ${error?.message ?? error}`); };

function d1(sql) {
  return execFileSync("pnpm", ["exec", "wrangler", "d1", "execute", "foilbury-local", "--local", "--json", "--command", sql], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function cli(args, token) {
  const output = execFileSync("pnpm", ["exec", "emdash", ...args, "--url", baseURL, "--json"], {
    encoding: "utf8",
    env: { ...process.env, EMDASH_TOKEN: token },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const start = output.indexOf("{");
  const arrayStart = output.indexOf("[");
  const index = start === -1 ? arrayStart : arrayStart === -1 ? start : Math.min(start, arrayStart);
  return JSON.parse(index === -1 ? output : output.slice(index));
}

const rawToken = `ec_pat_${crypto.randomBytes(20).toString("hex")}`;
const tokenHash = crypto.createHash("sha256").update(rawToken).digest("base64url");
const tokenId = `tok_emdash_accept_${Date.now()}`;
const slug = `editorial-roundtrip-${Date.now()}`;
let createdId = null;
let scheduledId = null;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
let tokenCreated = false;

const content = [
  { _type: "block", _key: "t1", style: "normal", markDefs: [], children: [{ _type: "span", _key: "s1", text: "A draft authored through the native EmDash content API. ", marks: [] }, { _type: "span", _key: "s2", text: "It must not be public yet.", marks: ["strong"] }] },
  { _type: "block", _key: "h1", style: "h2", markDefs: [], children: [{ _type: "span", _key: "s3", text: "Structure survives the round trip", marks: [] }] },
  { _type: "block", _key: "p2", style: "normal", markDefs: [{ _key: "link1", _type: "link", href: "https://example.com/reviewed-source" }], children: [{ _type: "span", _key: "s4", text: "A reviewed source is linked, not embedded.", marks: ["link1"] }] },
  { _type: "block", _key: "li1", listItem: "bullet", level: 1, markDefs: [], children: [{ _type: "span", _key: "s5", text: "First unordered item" }] },
  { _type: "block", _key: "li2", listItem: "bullet", level: 2, markDefs: [], children: [{ _type: "span", _key: "s6", text: "Nested unordered item" }] },
  { _type: "block", _key: "li3", listItem: "number", level: 2, markDefs: [], children: [{ _type: "span", _key: "s7", text: "Nested ordered item" }] },
  { _type: "block", _key: "li4", listItem: "bullet", level: 1, markDefs: [], children: [{ _type: "span", _key: "s8", text: "Second unordered item" }] },
  { _type: "block", _key: "num1", listItem: "number", level: 1, listStart: 1, markDefs: [], children: [{ _type: "span", _key: "s9", text: "First numbered step" }] },
  { _type: "block", _key: "num2", listItem: "number", level: 1, markDefs: [], children: [{ _type: "span", _key: "s10", text: "Second numbered step" }] },
  { _type: "image", _key: "img1", asset: { _ref: "local-brand", url: "/brand/kit/foil-standard/mark-512.png" }, alt: "The Foil Standard identity mark", caption: "A real image block with alt text and a caption." },
  { _type: "code", _key: "code1", language: "ts", filename: "proof.ts", code: "const published = true;" },
  { _type: "table", _key: "table1", hasHeaderRow: true, rows: [
    { _key: "r1", cells: [{ _type: "tableCell", _key: "c1", isHeader: true, content: [{ _type: "span", _key: "cs1", text: "Block" }] }, { _type: "tableCell", _key: "c2", isHeader: true, content: [{ _type: "span", _key: "cs2", text: "Result" }] }] },
    { _key: "r2", cells: [{ _type: "tableCell", _key: "c3", content: [{ _type: "span", _key: "cs3", text: "Table" }] }, { _type: "tableCell", _key: "c4", content: [{ _type: "span", _key: "cs4", text: "Preserved" }] }] },
  ] },
];

try {
  const statusResponse = await fetch(new URL("/api/v1/status", baseURL));
  const status = await statusResponse.json();
  if (!statusResponse.ok || status.environment !== "local" || status.local !== true) {
    throw new Error("Start a Foilbury local fixture before running the editorial test.");
  }
  const query = "SELECT COUNT(*) AS count FROM users";
  const [users] = JSON.parse(d1(query));
  if (!users.results[0]?.count) {
    const setup = await fetch(new URL("/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin&content=0", baseURL), { redirect: "manual" });
    const [setupUsers] = JSON.parse(d1(query));
    if ((!setup.ok && ![302, 303].includes(setup.status)) || !setupUsers.results[0]?.count) {
      throw new Error("The local EmDash setup did not create a CMS owner.");
    }
  }
  d1(`INSERT INTO _emdash_api_tokens (id, name, token_hash, prefix, user_id, scopes, expires_at, created_at) VALUES ('${tokenId}', 'Foilbury EmDash acceptance', '${tokenHash}', 'ec_pat_acc', (SELECT id FROM users ORDER BY role DESC LIMIT 1), '["admin"]', NULL, datetime('now'));`);
  tokenCreated = true;
  const who = cli(["whoami"], rawToken);
  if (!who?.email) throw new Error("Temporary local EmDash token was not accepted.");
  pass("temporary local EmDash operator session", who.email);

  const created = cli(["content", "create", "posts", "--draft", "--slug", slug, "--data", JSON.stringify({ title: "Editorial round-trip proof", excerpt: "A rich draft proving native blocks and publication status.", content })], rawToken);
  createdId = created?.id ?? created?.data?.id;
  if (!createdId) throw new Error(`Create returned no id: ${JSON.stringify(created).slice(0, 400)}`);
  pass("authored a rich draft through the native CMS API", createdId);

  const draftResponse = await fetch(`${baseURL}/journal/${slug}`);
  if (draftResponse.status !== 404) throw new Error(`Draft was publicly readable: ${draftResponse.status}`);
  pass("draft is not public before publication");

  cli(["content", "publish", "posts", createdId], rawToken);
  const published = await fetch(`${baseURL}/journal/${slug}`);
  const html = await published.text();
  if (published.status !== 200) throw new Error(`Published entry returned ${published.status}`);
  fs.writeFileSync(path.join(evidence, "published.html"), html);
  for (const [name, needle] of [
    ["heading", "<h2>Structure survives the round trip</h2>"],
    ["strong mark", "<strong>It must not be public yet.</strong>"],
    ["safe link", 'href="https://example.com/reviewed-source"'],
    ["unordered list", "<ul><li>First unordered item"],
    ["nested list", "<ul><li>Nested unordered item</li></ul>"],
    ["nested ordered list", "<ol><li>Nested ordered item</li></ol>"],
    ["numbered list", "<ol><li>First numbered step</li><li>Second numbered step</li></ol>"],
    ["image", 'src="/brand/kit/foil-standard/mark-512.png"'],
    ["image alt", 'alt="The Foil Standard identity mark"'],
    ["caption", "<figcaption>A real image block with alt text and a caption.</figcaption>"],
    ["code", "const published = true;"],
    ["table", "<th>Block</th>"],
  ]) {
    if (!html.includes(needle)) throw new Error(`Published HTML is missing ${name}: ${needle}`);
  }
  if (html.includes('<div class="editorial-unavailable"')) throw new Error("A supported block fell into the unsupported fallback");
  pass("published entry renders supported blocks faithfully");
  await page.goto(`${baseURL}/journal/${slug}`);
  await page.getByRole("heading", { name: "Editorial round-trip proof" }).waitFor();
  await page.locator(".prose img").first().waitFor();
  const imageLoaded = await page.locator(".prose img").first().evaluate((image) => image.complete && image.naturalWidth > 0);
  if (!imageLoaded) throw new Error("Published editorial image did not decode");
  for (const [list, marker] of [["ul", "disc"], ["ol", "decimal"], ["li ol", "decimal"]]) {
    const rendered = await page.locator(`.journal-entry-content ${list}`).first().evaluate((element) => {
      const style = getComputedStyle(element);
      return { marker: style.listStyleType, indent: Number.parseFloat(style.paddingInlineStart) };
    });
    if (rendered.marker !== marker || rendered.indent <= 0) {
      throw new Error(`Published list ${list} is missing its marker or indentation.`);
    }
  }
  await page.screenshot({ path: path.join(evidence, "emdash-editorial-roundtrip.png"), fullPage: true });
  pass("browser rendered list markers and decoded the published media");

  const fetched = cli(["content", "get", "posts", createdId, "--raw"], rawToken);
  const revision = fetched?._rev ?? fetched?.data?._rev;
  if (!revision) throw new Error("No revision token returned for the update");
  const updated = cli(["content", "update", "posts", createdId, "--rev", revision, "--data", JSON.stringify({ title: "Editorial round-trip proof — revised", excerpt: "Revised after publication.", content: [...content, { _type: "block", _key: "rev1", style: "normal", markDefs: [], children: [{ _type: "span", _key: "revs1", text: "This paragraph proves a revision reaches the public page." }] }] })], rawToken);
  const revisedHtml = await (await fetch(`${baseURL}/journal/${slug}`)).text();
  if (!revisedHtml.includes("This paragraph proves a revision reaches the public page.")) throw new Error("Revision did not reach the public page");
  if (!revisedHtml.includes("Editorial round-trip proof — revised")) throw new Error("Revised title did not reach the public page");
  pass("revision reached the public page", updated?._rev ?? "updated");

  const scheduledSlug = `${slug}-scheduled`;
  const scheduled = cli(["content", "create", "posts", "--draft", "--slug", scheduledSlug, "--data", JSON.stringify({ title: "Scheduled editorial proof", excerpt: "Not yet public.", content })], rawToken);
  scheduledId = scheduled?.id ?? scheduled?.data?.id;
  const when = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  cli(["content", "schedule", "posts", scheduledId, "--at", when], rawToken);
  const scheduledRow = cli(["content", "get", "posts", scheduledId, "--raw"], rawToken);
  const scheduledStatus = scheduledRow?.status ?? scheduledRow?.data?.status;
  if (scheduledStatus !== "scheduled") throw new Error(`Scheduled entry status is ${scheduledStatus}`);
  const scheduledResponse = await fetch(`${baseURL}/journal/${scheduledSlug}`);
  if (scheduledResponse.status !== 404) throw new Error(`Scheduled entry was publicly readable: ${scheduledResponse.status}`);
  pass("supported scheduled publication is stored and not yet public", when);

  cli(["content", "unpublish", "posts", createdId], rawToken);
  const unpublished = await fetch(`${baseURL}/journal/${slug}`);
  if (unpublished.status !== 404) throw new Error(`Unpublished entry still public: ${unpublished.status}`);
  pass("unpublish removes the public entry");

  cli(["content", "delete", "posts", createdId], rawToken);
  if (scheduledId) cli(["content", "delete", "posts", scheduledId], rawToken);
  pass("acceptance entries removed from the local CMS");
} catch (error) {
  console.error(error?.stack ?? error);
  fail("EmDash editorial round trip", error);
  await page.screenshot({ path: path.join(evidence, "emdash-editorial-failure.png"), fullPage: true }).catch(() => undefined);
} finally {
  await browser.close();
  if (createdId) {
    try { cli(["content", "delete", "posts", createdId], rawToken); } catch { /* already deleted */ }
  }
  if (scheduledId) { try { cli(["content", "delete", "posts", scheduledId], rawToken); } catch { /* already deleted */ } }
  if (tokenCreated) {
    try { d1(`DELETE FROM _emdash_api_tokens WHERE id = '${tokenId}';`); } catch (error) { fail("temporary local CMS token cleanup", error); }
  }
}

const report = { generated_at: new Date().toISOString(), base_url: baseURL, results };
fs.writeFileSync(path.join(evidence, "emdash-editorial.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.log(`Editorial evidence: ${evidence}`);
if (results.some((result) => result.status === "FAIL")) process.exit(1);
