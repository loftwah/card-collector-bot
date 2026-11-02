#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { ROOT, readSecretFile } from "./lib/local.mjs";

const localDb = execFileSync("find", [".wrangler/state/v3/d1", "-name", "*.sqlite", "-type", "f"], { cwd: ROOT, encoding: "utf8" })
  .split(/\r?\n/)
  .map((value) => value.trim())
  .find((file) => {
    try {
      return execFileSync("sqlite3", [file, "SELECT COUNT(*) FROM fb_tenants;"], { encoding: "utf8" }).trim() === "3";
    } catch {
      return false;
    }
  });
if (!localDb) throw new Error("Local D1 database not found.");

const credentials = readSecretFile("local-credentials.json");
const owner = credentials?.accounts?.find((account) => account.role === "owner");
if (!owner) throw new Error("Local owner credentials not found.");
const login = await fetch("http://localhost:5173/api/v1/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: owner.email, password: owner.password }),
});
if (!login.ok) throw new Error(`Local owner login failed with HTTP ${login.status}. Run pnpm dev.`);
const cookie = (login.headers.getSetCookie?.() ?? []).map((value) => value.split(";")[0]).join("; ");
if (!cookie) throw new Error("Local login returned no session cookie.");

const rows = JSON.parse(
  execFileSync("sqlite3", ["-json", localDb, "SELECT id, r2_key, mime, visibility FROM fb_assets ORDER BY kind, id;"], { encoding: "utf8" }) || "[]",
);
if (!rows.length) throw new Error("No local assets found.");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "foilbury-media-"));
let done = 0;
let failed = 0;
const concurrency = 3;
let cursor = 0;

async function worker() {
  while (cursor < rows.length) {
    const index = cursor++;
    const row = rows[index];
    try {
      const endpoint = row.visibility === "private" ? `/media/asset/${row.id}` : `/media/public/${row.id}`;
      const response = await fetch(`http://localhost:5173${endpoint}`, { headers: { cookie } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const file = path.join(temp, `${index}.bin`);
      fs.writeFileSync(file, bytes);
      let lastError = null;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          await new Promise((resolve, reject) => {
            const child = spawn(
              path.join(ROOT, "node_modules/.bin/wrangler"),
              ["r2", "object", "put", `foilbury-media/${row.r2_key}`, "--file", file, "--content-type", row.mime, "--config", "wrangler.production.jsonc", "--remote"],
              { cwd: ROOT, stdio: ["ignore", "ignore", "pipe"] },
            );
            let stderr = "";
            child.stderr.on("data", (chunk) => { stderr += String(chunk); });
            child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`wrangler exited ${code}: ${stderr.slice(-200)}`))));
            child.on("error", reject);
          });
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          await new Promise((resolve) => setTimeout(resolve, 750 * (attempt + 1)));
        }
      }
      if (lastError) throw lastError;
      fs.unlinkSync(file);
      done += 1;
      if (done % 20 === 0) console.log(`uploaded ${done}/${rows.length}`);
    } catch (error) {
      failed += 1;
      console.error(`FAILED ${row.id}: ${error instanceof Error ? error.message : "unknown"}`);
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));
fs.rmSync(temp, { recursive: true, force: true });
console.log(JSON.stringify({ total: rows.length, uploaded: done, failed }, null, 2));
if (failed) process.exit(1);
