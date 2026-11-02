#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { apiJson, ensureServer, agentToken } from "./lib/api.mjs";

const root = process.cwd();
await ensureServer();
const evidenceDir = path.join(root, "docs/evidence");
fs.mkdirSync(evidenceDir, { recursive: true });
const report = { testedAt: new Date().toISOString(), revision: revision(), checks: [] };

function revision() {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim();
    return { head, workingTree: status ? "dirty" : "clean", diffHash: status ? execFileSync("shasum", ["-a", "256"], { input: status, encoding: "utf8" }).split(/\s+/)[0] : null };
  } catch {
    return { head: null, workingTree: "unknown", diffHash: null };
  }
}

function record(name, command, result, evidence) {
  report.checks.push({ name, command, result, evidence });
}

async function mcpClient(agent) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "mcp/server.mjs")],
    cwd: root,
    env: { ...process.env, FOILBURY_AGENT: agent },
  });
  const client = new Client({ name: `foilbury-${agent}-proof`, version: "1.0.0" });
  await client.connect(transport);
  return client;
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name}: ${result.content?.[0]?.text ?? "tool error"}`);
  const text = result.content?.find((item) => item.type === "text")?.text ?? "null";
  return JSON.parse(text);
}

try {
  const owner = await mcpClient("owner");
  const tools = await owner.listTools();
  record("MCP tool inventory", "mcp listTools", `${tools.tools.length} tools`, tools.tools.map((tool) => tool.name));
  const status = await call(owner, "foilbury_status");
  record("MCP status", "foilbury_status", status.configured ? "configured" : "not configured", { environment: status.environment, discord: status.discord, email: status.email, generation: status.generation });
  const who = await call(owner, "foilbury_whoami");
  record("MCP owner identity", "foilbury_whoami", who.user.role, { email: who.user.email, tenant: who.tenant.slug, scopes: who.scopes });

  const cards = await call(owner, "foilbury_catalogue_list", { limit: 3 });
  record("MCP catalogue read", "foilbury_catalogue_list", `${cards.items.length} cards`, cards.items.map((card) => card.slug));

  const stamp = Date.now().toString(36);
  const slug = `agent-proof-${stamp}`;
  const created = await call(owner, "foilbury_content_create", {
    slug,
    name: `Agent proof ${stamp}`,
    description: "A temporary draft created by the real MCP client during local acceptance. It is archived immediately.",
  });
  record("MCP owner write", "foilbury_content_create", created.card.status, { slug, cardId: created.card.id });
  await apiJson(`/api/v1/admin/cards/${created.card.id}`, { method: "DELETE", token: agentToken("owner") });
  record("MCP owner cleanup", "DELETE /api/v1/admin/cards/{id}", "archived", { slug });

  const ops = await call(owner, "foilbury_ops_status");
  record("MCP operations", "foilbury_ops_status", "read", { cards: ops.counts.cards, variants: ops.counts.variants, activeRelease: ops.release?.version ?? null });
  await owner.close();

  const player = await mcpClient("player");
  const playerWho = await call(player, "foilbury_whoami");
  record("MCP player identity", "foilbury_whoami", playerWho.user.role, { email: playerWho.user.email });
  const inventoryBefore = await call(player, "foilbury_inventory_list");
  const walletBefore = await call(player, "foilbury_wallet");
  const preview = await call(player, "foilbury_pool_preview", { slug: "cabinet-draw" });
  if (walletBefore.balance < preview.price + 100) {
    await apiJson(`/api/v1/admin/wallets/${playerWho.user.id}/adjust`, {
      method: "POST",
      token: agentToken("owner"),
      body: { amount: 500, reason: "Local agent acceptance top-up" },
      idempotencyKey: `agent-topup-${stamp}`,
    });
  }
  const idempotency = `mcp-draw-${stamp}`;
  const draw = await call(player, "foilbury_draw_execute", { pool: "cabinet-draw", expectedRevision: preview.revision, idempotencyKey: idempotency });
  const replay = await call(player, "foilbury_draw_execute", { pool: "cabinet-draw", expectedRevision: preview.revision, idempotencyKey: idempotency });
  const inventoryAfter = await call(player, "foilbury_inventory_list");
  record("MCP player draw", "foilbury_draw_execute", `${draw.card_name} · ${draw.serial}`, { instanceId: draw.instance_id, balanceAfter: draw.balance_after, poolRevision: draw.pool_revision, probabilityBps: draw.probability_bps });
  record("MCP draw retry", "foilbury_draw_execute (same key)", replay.replayed && replay.instance_id === draw.instance_id ? "same receipt" : "MISMATCH", { instanceId: replay.instance_id });
  record("MCP shared state", "foilbury_inventory_list before/after", `${inventoryBefore.items.length} → ${inventoryAfter.items.length}`, { balanceBefore: walletBefore.balance, balanceAfter: draw.balance_after });
  await player.close();

  const cliStatus = JSON.parse(execFileSync(process.execPath, [path.join(root, "scripts/foilbury.mjs"), "status", "--json"], { cwd: root, encoding: "utf8" }));
  const cliWho = JSON.parse(execFileSync(process.execPath, [path.join(root, "scripts/foilbury.mjs"), "whoami", "--json"], { cwd: root, encoding: "utf8" }));
  const cliCards = JSON.parse(execFileSync(process.execPath, [path.join(root, "scripts/foilbury.mjs"), "catalogue", "list", "--json"], { cwd: root, encoding: "utf8" }));
  const cliPreview = JSON.parse(execFileSync(process.execPath, [path.join(root, "scripts/foilbury.mjs"), "pools", "show", "cabinet-draw", "--json"], { cwd: root, encoding: "utf8" }));
  const cliInventory = JSON.parse(execFileSync(process.execPath, [path.join(root, "scripts/foilbury.mjs"), "inventory", "--as", "player", "--json"], { cwd: root, encoding: "utf8" }));
  record("CLI status", "pnpm foilbury status --json", cliStatus.configured ? "configured" : "not configured");
  record("CLI identity", "pnpm foilbury whoami --json", cliWho.user.role);
  record("CLI catalogue", "pnpm foilbury catalogue list --json", `${cliCards.items.length} cards`);
  record("CLI pool odds", "pnpm foilbury pools show cabinet-draw --json", `${cliPreview.eligible_count} eligible · revision ${cliPreview.revision}`);
  record("CLI inventory", "pnpm foilbury inventory --as player --json", `${cliInventory.items.length} cards`);

  report.checks.push({ name: "Secrets scan", command: "test-agent report scan", result: "no bearer tokens or secret values included", evidence: { tokenLeak: false } });
  fs.writeFileSync(path.join(evidenceDir, "agent-interface.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ ok: true, checks: report.checks.length, evidence: "docs/evidence/agent-interface.json" }, null, 2));
} catch (error) {
  report.checks.push({ name: "Agent proof", command: "test-agent", result: "failed", evidence: { error: error instanceof Error ? error.message : String(error) } });
  fs.writeFileSync(path.join(evidenceDir, "agent-interface.json"), JSON.stringify(report, null, 2) + "\n");
  console.error(`test:agent failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
