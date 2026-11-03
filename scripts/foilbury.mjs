#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { apiJson, agentToken, BASE_URL } from "./lib/api.mjs";
const pct = (bps) => `${(bps / 100).toFixed(2)}%`;

const argv = process.argv.slice(2);
const json = argv.includes("--json");
const asIndex = argv.indexOf("--as");
const as = asIndex >= 0 ? argv[asIndex + 1] : "owner";
const token = agentToken(as);
const flags = new Map();
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg.startsWith("--")) {
    const key = arg.slice(2);
    if (["json", "help"].includes(key)) flags.set(key, true);
    else if (key === "as") i++;
    else if (argv[i + 1] && !argv[i + 1].startsWith("--")) {
      flags.set(key, argv[i + 1]);
      i++;
    } else flags.set(key, true);
  } else if (!(asIndex >= 0 && i === asIndex + 1)) positional.push(arg);
}

function out(value) {
  if (json) console.log(JSON.stringify(value, null, 2));
  else if (typeof value === "string") console.log(value);
  else console.log(JSON.stringify(value, null, 2));
}
function fail(message, code = 1) {
  if (json) console.error(JSON.stringify({ ok: false, error: message }));
  else console.error(`foilbury: ${message}`);
  process.exit(code);
}
function help() {
  console.log(`Foilbury CLI — the same command layer as REST and MCP

Usage:
  foilbury <command> [subcommand] [options] [--json] [--as owner|player]

Commands:
  status                         Read local runtime status (no auth)
  whoami                         Show the authenticated member
  catalogue list                 List owner catalogue cards
  catalogue create --slug --name --description [--class --category --rarity --tags]
  catalogue publish <id>         Publish a card identity
  catalogue archive <id>         Remove a draft or archive a collectible
  catalogue merge <id> --into <id>  Merge a duplicate identity, preserving aliases
  taxonomy list                  List classes, categories, tags, rarities, materials, effects
  taxonomy create --kind --key --name
  sets list                      List sets and completion versions
  sets publish <id>              Publish a set checklist
  pools list                     List pools (owner)
  pools show <slug>              Public odds preview
  pools update <id> --revision --price
  pools publish <id>
  inventory list                 Player inventory (uses --as player)
  wallet                         Player wallet and recent ledger
  reward claim                   Claim the daily allowance
  draw preview <slug>            Inspect eligible odds before drawing
  draw execute <slug> --revision <n>
  recycle preview <instance-id>
  recycle commit <instance-id> --credit <n>
  trade list
  trade create --recipient <email> [--offer id] [--request id]
  trade accept <trade-id>
  gift --recipient <email> --instance <instance-id>
  agents list
  agents create --name --represents <user-id> --scopes a,b --days 30
  agents revoke <grant-id>
  imports preview --file <manifest.json>
  imports apply --file <manifest.json>
  jobs list [--status pending]
  jobs drain                     Process local render jobs (same runner as pnpm jobs:run)
  generation plan --prompt ... [--model ...] [--count n]
  generation jobs                List generation plans/results
  generation show <id>
  generation submit <id>         Refuses without a recorded ceiling and verified adapter
  generation review <id> --decision approve|reject
  generation adopt <id>
  openapi                        Print the local OpenAPI path
  help

Environment:
  FOILBURY_URL        Default ${BASE_URL}
  FOILBURY_AGENT      owner or player (or use --as)
  FOILBURY_AGENT_TOKEN  explicit bearer for automation

Local agent credentials are read from .foilbury/agents.json and never printed.`);
}

async function main() {
  const [command, sub, ...rest] = positional;
  if (!command || command === "help" || flags.has("help")) return help();
  if (command === "status") {
    const response = await fetch(`${BASE_URL}/api/v1/status`);
    return out(await response.json());
  }
  if (command === "openapi") return out({ path: "/openapi.json", url: `${BASE_URL}/openapi.json` });
  if (command === "whoami") return out(await apiJson("/api/v1/me", { token }));

  if (command === "catalogue") {
    if (sub === "list" || !sub) {
      const result = await apiJson("/api/v1/admin/cards?limit=200", { token });
      if (json) return out(result);
      for (const card of result.items) console.log(`${card.status.padEnd(10)} ${card.slug.padEnd(20)} ${card.name}`);
      return;
    }
    if (sub === "create") {
      const result = await apiJson("/api/v1/admin/cards", { method: "POST", token, body: { slug: flags.get("slug"), name: flags.get("name"), description: flags.get("description"), classKey: flags.get("class"), categorySlug: flags.get("category"), rarityKey: flags.get("rarity"), tags: flags.get("tags") ? String(flags.get("tags")).split(",") : undefined } });
      return out(result);
    }
    if (sub === "publish") {
      const id = rest[0];
      if (!id) fail("catalogue publish needs a card id", 2);
      return out(await apiJson(`/api/v1/admin/cards/${id}/status`, { method: "POST", token, body: { status: "published" } }));
    }
    if (sub === "archive") {
      const id = rest[0];
      if (!id) fail("catalogue archive needs a card id", 2);
      return out(await apiJson(`/api/v1/admin/cards/${id}`, { method: "DELETE", token }));
    }
    if (sub === "merge") {
      const id = rest[0];
      if (!id || !flags.get("into")) fail("catalogue merge needs a source id and --into <target-id>", 2);
      return out(await apiJson(`/api/v1/admin/cards/${id}/merge`, { method: "POST", token, body: { targetId: flags.get("into") } }));
    }
    return fail("unknown catalogue command", 2);
  }

  if (command === "taxonomy") {
    if (sub === "list" || !sub) return out(await apiJson("/api/v1/admin/taxonomy", { token }));
    if (sub === "create") return out(await apiJson("/api/v1/admin/taxonomy", { method: "POST", token, body: { kind: flags.get("kind"), key: flags.get("key"), name: flags.get("name") } }));
    return fail("unknown taxonomy command", 2);
  }

  if (command === "sets") {
    if (sub === "list" || !sub) {
      const result = await apiJson("/api/v1/admin/sets", { token });
      if (json) return out(result);
      for (const set of result.items) console.log(`${set.status.padEnd(10)} v${set.version} ${set.slug.padEnd(18)} ${set.name} (${set.cards.length} cards)`);
      return;
    }
    if (sub === "publish") {
      const id = rest[0];
      if (!id) fail("sets publish needs a set id", 2);
      return out(await apiJson(`/api/v1/admin/sets/${id}/publish`, { method: "POST", token, body: {} }));
    }
    return fail("unknown sets command", 2);
  }

  if (command === "pools") {
    if (sub === "list" || !sub) {
      const result = await apiJson("/api/v1/admin/pools", { token });
      if (json) return out(result);
      for (const pool of result.items) console.log(`${pool.status.padEnd(9)} v${pool.revision} ✦${String(pool.price).padEnd(4)} ${pool.slug}`);
      return;
    }
    if (sub === "show") {
      const slug = rest[0];
      if (!slug) fail("pools show needs a slug", 2);
      return out(await apiJson(`/api/v1/pools/${slug}`, { token }));
    }
    if (sub === "update") {
      const id = rest[0];
      if (!id) fail("pools update needs a pool id", 2);
      return out(await apiJson(`/api/v1/admin/pools/${id}`, { method: "PATCH", token, body: { expectedRevision: Number(flags.get("revision")), price: flags.get("price") === undefined ? undefined : Number(flags.get("price")) } }));
    }
    if (sub === "publish") {
      const id = rest[0];
      if (!id) fail("pools publish needs a pool id", 2);
      return out(await apiJson(`/api/v1/admin/pools/${id}/publish`, { method: "POST", token, body: {} }));
    }
    return fail("unknown pools command", 2);
  }

  if (command === "inventory") {
    const result = await apiJson("/api/v1/inventory?limit=300", { token });
    if (json) return out(result);
    for (const item of result.items) console.log(`${item.card_name.padEnd(20)} ${item.variant_name.padEnd(20)} ${item.serial}  ${item.status}`);
    console.log(`${result.items.length} cards`);
    return;
  }
  if (command === "wallet") return out(await apiJson("/api/v1/wallet", { token }));
  if (command === "reward" && sub === "claim") return out(await apiJson("/api/v1/rewards/claim", { method: "POST", token, body: {}, idempotencyKey: `cli-${crypto.randomUUID()}` }));
  if (command === "reward") return fail("unknown reward command", 2);
  if (command === "missions") {
    if (sub === "claim") {
      const key = rest[0];
      if (!key) return fail("missions claim needs a mission key", 2);
      return out(await apiJson("/api/v1/missions/daily/claim", { method: "POST", token, body: { key }, idempotencyKey: `cli-mission-${crypto.randomUUID()}` }));
    }
    const result = await apiJson("/api/v1/missions/daily", { token });
    if (json) return out(result);
    console.log(`Daily missions · ${result.day} UTC · earned ${result.earned_today}/${result.cap} · reset ${result.reset_local}`);
    for (const mission of result.missions) console.log(`  ${mission.claimed ? "claimed " : mission.complete ? "ready   " : `${mission.progress}/${mission.target}   `} ${mission.key.padEnd(10)} ✦ ${mission.reward}  ${mission.title}`);
    return;
  }

  if (command === "draw") {
    const slug = rest[0];
    if (!slug) fail("draw needs a pool slug", 2);
    if (sub === "preview" || !sub) {
      const result = await apiJson(`/api/v1/pools/${slug}${flags.get("channel") ? `?channel=${encodeURIComponent(String(flags.get("channel")))}` : ""}`, { token });
      if (json) return out(result);
      console.log(`${result.pool.name} · revision ${result.revision} · price ✦ ${result.price} · ${result.eligible_count} eligible · pity ${result.pity}`);
      for (const entry of result.entries.slice(0, 30)) console.log(`  ${entry.card_name.padEnd(20)} ${entry.variant_name.padEnd(20)} ${pct(entry.probability_bps)}`);
      if (result.entries.length > 30) console.log(`  … ${result.entries.length - 30} more`);
      return;
    }
    if (sub === "execute") {
      const revision = Number(flags.get("revision"));
      if (!revision) fail("draw execute needs --revision", 2);
      const preview = await apiJson(`/api/v1/pools/${slug}${flags.get("channel") ? `?channel=${encodeURIComponent(String(flags.get("channel")))}` : ""}`, { token });
      return out(await apiJson("/api/v1/draws", {
        method: "POST",
        token,
        body: {
          pool: slug,
          expectedRevision: revision,
          expectedDistribution: preview.distribution_fingerprint,
          channelKey: flags.get("channel") || undefined,
        },
        idempotencyKey: flags.get("idempotency-key") ? String(flags.get("idempotency-key")) : `cli-draw-${crypto.randomUUID()}`,
      }));
    }
    return fail("unknown draw command", 2);
  }

  if (command === "recycle") {
    const instanceId = rest[0];
    if (!instanceId) fail("recycle needs an instance id", 2);
    if (sub === "preview") return out(await apiJson("/api/v1/recycle/preview", { method: "POST", token, body: { instanceId } }));
    if (sub === "commit") return out(await apiJson("/api/v1/recycle", { method: "POST", token, body: { instanceId, expectedCredit: Number(flags.get("credit")) }, idempotencyKey: `cli-recycle-${crypto.randomUUID()}` }));
    return fail("unknown recycle command", 2);
  }

  if (command === "trade") {
    if (sub === "list" || !sub) {
      const result = await apiJson("/api/v1/trades", { token });
      if (json) return out(result);
      for (const trade of result.items) console.log(`${trade.status.padEnd(10)} ${trade.id}  ${trade.proposer_name} → ${trade.recipient_name}  ${trade.item_count} cards`);
      return;
    }
    if (sub === "create") {
      const body = { recipientEmail: flags.get("recipient"), proposerInstanceIds: flags.get("offer") ? [String(flags.get("offer"))] : [], recipientInstanceIds: flags.get("request") ? [String(flags.get("request"))] : [] };
      return out(await apiJson("/api/v1/trades", { method: "POST", token, body }));
    }
    if (sub === "accept") {
      const id = rest[0];
      if (!id) fail("trade accept needs a trade id", 2);
      return out(await apiJson(`/api/v1/trades/${id}/accept`, { method: "POST", token, body: {} }));
    }
    return fail("unknown trade command", 2);
  }

  if (command === "gift") {
    return out(await apiJson("/api/v1/gifts", { method: "POST", token, body: { recipientEmail: flags.get("recipient"), instanceId: flags.get("instance") }, idempotencyKey: `cli-gift-${crypto.randomUUID()}` }));
  }

  if (command === "agents") {
    if (sub === "list" || !sub) {
      const result = await apiJson("/api/v1/admin/agents", { token });
      if (json) return out(result);
      for (const agent of result.items) console.log(`${agent.status.padEnd(9)} ${agent.agent_name.padEnd(28)} → ${agent.represented_name.padEnd(18)} expires ${agent.expires_at}`);
      return;
    }
    if (sub === "create") {
      return out(await apiJson("/api/v1/admin/agents", { method: "POST", token, body: { agentName: flags.get("name"), representedUserId: flags.get("represents"), scopes: String(flags.get("scopes") ?? "content:read").split(","), expiresInDays: Number(flags.get("days") ?? 30) } }));
    }
    if (sub === "revoke") {
      const id = rest[0];
      if (!id) fail("agents revoke needs a grant id", 2);
      return out(await apiJson(`/api/v1/admin/agents/${id}/revoke`, { method: "POST", token, body: {} }));
    }
    return fail("unknown agents command", 2);
  }

  if (command === "imports") {
    const file = flags.get("file");
    const manifest = file ? JSON.parse(fs.readFileSync(path.resolve(String(file)), "utf8")) : null;
    if (!manifest) fail("imports needs --file <manifest.json>", 2);
    if (sub === "preview") return out(await apiJson("/api/v1/admin/imports/preview", { method: "POST", token, body: manifest }));
    if (sub === "apply") return out(await apiJson("/api/v1/admin/imports", { method: "POST", token, body: { ...manifest, publish: false } }));
    return fail("unknown imports command", 2);
  }

  if (command === "jobs") {
    if (sub === "list" || !sub) return out(await apiJson(`/api/v1/admin/jobs${flags.get("status") ? `?status=${encodeURIComponent(String(flags.get("status")))}` : ""}`, { token }));
    if (sub === "drain") {
      const { spawnSync } = await import("node:child_process");
      const result = spawnSync(process.execPath, [path.join(process.cwd(), "scripts/render-cards.mjs")], { stdio: "inherit", cwd: process.cwd() });
      process.exit(result.status ?? 1);
    }
    return fail("unknown jobs command", 2);
  }

  if (command === "generation") {
    if (sub === "jobs" || !sub) return out(await apiJson("/api/v1/admin/generation/jobs", { token }));
    if (sub === "show") {
      const id = rest[0];
      if (!id) fail("generation show needs a job id", 2);
      return out(await apiJson(`/api/v1/admin/generation/jobs/${id}`, { token }));
    }
    if (sub === "plan") return out(await apiJson("/api/v1/admin/generation/plan", { method: "POST", token, body: { prompt: flags.get("prompt"), model: flags.get("model"), count: Number(flags.get("count") ?? 1) }, idempotencyKey: `cli-generation-${crypto.randomUUID()}` }));
    if (sub === "submit") {
      const id = rest[0];
      if (!id) fail("generation submit needs a job id", 2);
      return out(await apiJson(`/api/v1/admin/generation/jobs/${id}/submit`, { method: "POST", token, body: {} }));
    }
    if (sub === "review") {
      const id = rest[0];
      if (!id) fail("generation review needs a job id", 2);
      return out(await apiJson(`/api/v1/admin/generation/jobs/${id}/review`, { method: "POST", token, body: { decision: flags.get("decision") } }));
    }
    if (sub === "adopt") {
      const id = rest[0];
      if (!id) fail("generation adopt needs a job id", 2);
      return out(await apiJson(`/api/v1/admin/generation/jobs/${id}/adopt`, { method: "POST", token, body: {} }));
    }
    return fail("unknown generation command", 2);
  }

  fail(`unknown command: ${command}`, 2);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
