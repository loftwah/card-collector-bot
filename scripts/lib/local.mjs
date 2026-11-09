import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export const ROOT = process.cwd();
const DEV_VARS = path.join(ROOT, ".dev.vars");
const STATE_DIR = path.join(ROOT, ".foilbury");
const ALLOWED_DEV_VARS = [
  "FOILBURY_LOCAL_MODE",
  "FOILBURY_DEV_LOGIN",
  "FOILBURY_SESSION_SECRET",
  "FOILBURY_CSRF_SECRET",
  "FOILBURY_AGENT_TOKEN_PEPPER",
  "FOILBURY_BOOTSTRAP_TOKEN",
  "EMDASH_ENCRYPTION_KEY",
  "EMDASH_SITE_URL",
  "DISCORD_APPLICATION_ID",
  "DISCORD_PUBLIC_KEY",
];

export function readVarFile(file) {
  if (!fs.existsSync(file)) return new Map();
  const out = new Map();
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line || line.trimStart().startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index < 1) continue;
    out.set(line.slice(0, index).trim(), line.slice(index + 1).trim());
  }
  return out;
}

function writeVarFile(file, map, header) {
  // Retain configuration owned by the operator or other tools. Only the
  // explicitly managed keys may be changed by local setup.
  const original = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = original ? original.split(/\r?\n/) : [header];
  if (original && lines.at(-1) === "") lines.pop();
  const seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.trimStart().startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index < 1) continue;
    const key = line.slice(0, index).trim();
    if (!ALLOWED_DEV_VARS.includes(key)) continue;
    lines[i] = `${key}=${map.get(key) ?? ""}`;
    seen.add(key);
  }
  for (const key of ALLOWED_DEV_VARS) if (!seen.has(key)) lines.push(`${key}=${map.get(key) ?? ""}`);
  fs.writeFileSync(file, lines.join(newline) + newline, { mode: 0o600 });
}

export function ensureDevVars() {
  const existing = readVarFile(DEV_VARS);
  const next = new Map(ALLOWED_DEV_VARS.map((key) => [key, existing.get(key) ?? ""]));
  next.set("FOILBURY_LOCAL_MODE", "true");
  next.set("FOILBURY_DEV_LOGIN", existing.get("FOILBURY_DEV_LOGIN") ?? "true");
  next.set("EMDASH_SITE_URL", next.get("EMDASH_SITE_URL") || "http://localhost:5173");
  for (const key of ["FOILBURY_SESSION_SECRET", "FOILBURY_CSRF_SECRET", "FOILBURY_AGENT_TOKEN_PEPPER", "FOILBURY_BOOTSTRAP_TOKEN"]) {
    const current = next.get(key);
    if (!current) next.set(key, crypto.randomBytes(32).toString("base64url"));
    else if (current.length < 32) throw new Error(`${key} is configured but too short. Correct it explicitly; local setup did not change it.`);
  }
  if (!next.get("EMDASH_ENCRYPTION_KEY")) {
    next.set("EMDASH_ENCRYPTION_KEY", `emdash_enc_v1_${crypto.randomBytes(32).toString("base64url")}`);
  } else if (!next.get("EMDASH_ENCRYPTION_KEY").startsWith("emdash_enc_v1_")) {
    throw new Error("EMDASH_ENCRYPTION_KEY has an unsupported format. Correct it explicitly; local setup did not change it.");
  }
  writeVarFile(DEV_VARS, next, "# Local Worker secrets. Generated locally; never commit.");
  return next;
}

export function writeSecretFile(name, value) {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(STATE_DIR, name);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  return file;
}

export function readSecretFile(name) {
  const file = path.join(STATE_DIR, name);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function migrateWebhookAlias() {
  const envFile = path.join(ROOT, ".env");
  if (!fs.existsSync(envFile)) return { changed: false, reason: "no .env" };
  const lines = fs.readFileSync(envFile, "utf8").split(/\r?\n/);
  const values = new Map();
  for (const line of lines) {
    const index = line.indexOf("=");
    if (index > 0 && !line.trimStart().startsWith("#")) values.set(line.slice(0, index).trim(), line.slice(index + 1).trim());
  }
  const canonical = values.get("ADMIN_DISCORD_WEBHOOK_URL") ?? "";
  const alias = values.get("DISCORD_WEBHOOK_URL") ?? "";
  if (canonical && alias && canonical !== alias) {
    throw new Error(
      "ADMIN_DISCORD_WEBHOOK_URL and DISCORD_WEBHOOK_URL are both set to different values. Resolve them explicitly; no value was changed.",
    );
  }
  if (canonical || !alias) return { changed: false, reason: "canonical already authoritative" };
  const next = lines.map((line) => {
    const index = line.indexOf("=");
    if (index > 0 && line.slice(0, index).trim() === "ADMIN_DISCORD_WEBHOOK_URL") {
      return `ADMIN_DISCORD_WEBHOOK_URL=${alias}`;
    }
    return line;
  });
  fs.writeFileSync(envFile, next.join("\n"), { mode: 0o600 });
  fs.chmodSync(envFile, 0o600);
  return { changed: true, reason: "migrated alias value without printing it" };
}

export async function waitForServer(url, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return true;
    } catch {
      // not ready
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

export async function startDevServer(port = 5173) {
  const statusUrl = `http://127.0.0.1:${port}/api/v1/status`;
  if (await waitForServer(statusUrl, 1000)) return { started: false, port };
  spawn(path.join(ROOT, "node_modules/.bin/astro"), ["dev", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: ROOT,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
      CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
      NODE_ENV: "development",
    },
  }).unref();
  const ready = await waitForServer(statusUrl);
  if (!ready) throw new Error("The local server did not become ready. Run `pnpm exec astro dev logs` for diagnostics.");
  return { started: true, port };
}

export async function stopDevServer() {
  await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, "node_modules/.bin/astro"), "dev", "stop"], {
      cwd: ROOT,
      stdio: "ignore",
    });
    child.on("exit", resolve);
  });
}

export function statePath(name) {
  return path.join(STATE_DIR, name);
}
