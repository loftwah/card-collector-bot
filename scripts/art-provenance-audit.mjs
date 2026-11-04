#!/usr/bin/env node
/**
 * Read-only artwork provenance audit.
 *
 * Reports every asset by typed origin and flags AI-assisted assets without a
 * usable generation record. Run against production with the existing
 * Cloudflare credentials:
 *
 *   node scripts/art-provenance-audit.mjs --json
 *
 * It never writes, renders, publishes or calls a paid provider.
 */
import "dotenv/config";

const account = process.env.CF_ACCOUNT_ID;
const token = process.env.CF_API_TOKEN;
const databaseId = process.env.FOILBURY_D1_ID || "b67bb3d4-ace6-43f1-821a-f5620936bd3c";
const jsonOutput = process.argv.includes("--json");
if (!account || !token) throw new Error("CF_ACCOUNT_ID and CF_API_TOKEN are required.");
const base = `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${databaseId}/query`;
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

async function query(sql) {
  const response = await fetch(base, {
    method: "POST",
    headers,
    body: JSON.stringify({ sql, params: [] }),
  });
  const body = await response.json();
  if (!response.ok || body.success === false) {
    throw new Error(`${response.status} ${JSON.stringify(body.errors)}`);
  }
  return body.result?.[0]?.results ?? [];
}

const byOrigin = await query(
  `SELECT origin, kind, COUNT(*) AS assets
     FROM fb_assets
    GROUP BY origin, kind
    ORDER BY origin, kind`,
);
const aiMissing = await query(
  `SELECT id, name, origin,
          CASE WHEN generation_json IS NULL OR generation_json = '' THEN 'missing'
               WHEN json_valid(generation_json) = 0 THEN 'invalid_json'
               WHEN json_extract(generation_json, '$.provider') IS NULL THEN 'missing_provider'
               WHEN json_extract(generation_json, '$.endpoint') IS NULL THEN 'missing_endpoint'
               ELSE 'ok' END AS generation_state
     FROM fb_assets
    WHERE origin IN ('ai_assisted','ai_generated')
    ORDER BY name`,
);
const unknown = await query(
  `SELECT kind, COUNT(*) AS assets
     FROM fb_assets WHERE origin = 'unknown' GROUP BY kind ORDER BY kind`,
);
const totals = await query(
  `SELECT COUNT(*) AS assets,
          SUM(CASE WHEN origin = 'unknown' THEN 1 ELSE 0 END) AS unknown_assets,
          SUM(CASE WHEN origin IN ('ai_assisted','ai_generated') THEN 1 ELSE 0 END) AS ai_assets
     FROM fb_assets`,
);
const report = {
  generated_at: new Date().toISOString(),
  scope: "production D1 · read-only",
  totals: totals[0] ?? null,
  by_origin: byOrigin,
  unknown_by_kind: unknown,
  ai_assets: aiMissing,
  ai_assets_with_incomplete_generation: aiMissing.filter((row) => row.generation_state !== "ok").length,
  policy: {
    bot_default: "AI-assisted artwork excluded",
    toggle: "PATCH /api/v1/admin/bot { aiArtEnabled: boolean }",
    historical_copies: "Never deleted by changing the toggle",
    label: "Every card detail surfaces the artwork origin",
  },
};
if (jsonOutput) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Artwork provenance · ${report.generated_at}`);
  console.log(`Assets: ${report.totals?.assets ?? 0} · AI: ${report.totals?.ai_assets ?? 0} · unknown: ${report.totals?.unknown_assets ?? 0}`);
  for (const row of byOrigin) console.log(`  ${row.origin.padEnd(18)} ${row.kind.padEnd(10)} ${row.assets}`);
  if (report.ai_assets_with_incomplete_generation) {
    console.log(`\nAI records needing repair: ${report.ai_assets_with_incomplete_generation}`);
    for (const row of aiMissing.filter((item) => item.generation_state !== "ok")) {
      console.log(`  ${row.id} ${row.name} · ${row.generation_state}`);
    }
  }
}
