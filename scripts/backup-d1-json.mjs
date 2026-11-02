#!/usr/bin/env node
/**
 * Logical JSON backup of Foilbury domain tables using the Cloudflare D1 HTTP API.
 * This avoids D1 export's FTS5 limitation while preserving every fb_* row.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const account = process.env.CF_ACCOUNT_ID;
const token = process.env.CF_API_TOKEN;
const databaseId = process.env.FOILBURY_D1_ID || "b67bb3d4-ace6-43f1-821a-f5620936bd3c";
if (!account || !token) throw new Error("CF_ACCOUNT_ID and CF_API_TOKEN are required.");
const output = process.argv[2] || path.join(".foilbury", "backups", `d1-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
const base = `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${databaseId}/query`;
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

async function query(sql, params = []) {
  const response = await fetch(base, { method: "POST", headers, body: JSON.stringify({ sql, params }) });
  const body = await response.json();
  if (!response.ok || body.success === false) throw new Error(`${response.status} ${JSON.stringify(body.errors)}`);
  return body.result?.[0]?.results ?? [];
}

const tables = (await query("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'fb_%' ORDER BY name")).map((row) => row.name);
const snapshot = { generated_at: new Date().toISOString(), database_id: databaseId, tables: {} };
for (const table of tables) snapshot.tables[table] = await query(`SELECT * FROM "${table}"`);
fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
const json = JSON.stringify(snapshot, null, 2);
fs.writeFileSync(output, json, { mode: 0o600 });
const hash = crypto.createHash("sha256").update(json).digest("hex");
fs.writeFileSync(`${output}.sha256`, `${hash}  ${path.basename(output)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ output, tables: tables.length, rows: Object.values(snapshot.tables).reduce((sum, rows) => sum + rows.length, 0), sha256: hash }, null, 2));
