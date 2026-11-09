#!/usr/bin/env node
// Explicitly local, authenticated, draft-only. No asset upload or publication.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { subjects } from "./two-subject-plan.mjs";

const args = process.argv.slice(2);
if (args.length !== 5 || args[0] !== "--manifest-dir" || args[2] !== "--subject" || args[4] !== "--apply") throw new Error("Usage: node scripts/content/import-local-subject-draft.mjs --manifest-dir DIR --subject gonta-gokuhara|kamui-gakupo --apply");
const subject = subjects.find((item) => item.slug === args[3]);
if (!subject) throw new Error("Unknown subject.");
const cookie = process.env.FOILBURY_LOCAL_COOKIE;
const csrf = process.env.FOILBURY_LOCAL_CSRF;
if (!cookie || !csrf) throw new Error("Set FOILBURY_LOCAL_COOKIE and FOILBURY_LOCAL_CSRF from a recently strongly authenticated local owner session.");
const manifest = JSON.parse(fs.readFileSync(path.join(args[1], subject.file), "utf8"));
const matches = manifest.cards?.filter((card) => card.slug === subject.slug) ?? [];
if (manifest.collection?.slug !== subject.collection || matches.length !== 1 || matches[0].logical_id !== subject.logicalId) throw new Error("Manifest identity mismatch.");
const recordJson = JSON.stringify(matches[0]);
const sha256 = createHash("sha256").update(recordJson).digest("hex");
const port = Number(process.env.FOILBURY_LOCAL_PORT ?? "5173");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid local port.");
const response = await fetch(`http://localhost:${port}/api/v1/admin/local-subject-drafts`, { method: "POST", redirect: "manual", headers: { "content-type": "application/json", cookie, "x-foilbury-csrf": csrf }, body: JSON.stringify({ recordJson, sha256 }) });
const result = await response.json();
if (!response.ok) throw new Error(`${response.status}: ${result.error?.message ?? "Draft import failed."}`);
console.log(JSON.stringify(result));
