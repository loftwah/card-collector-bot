import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { build, normalizedInventory } from "../../scripts/api/route-inventory.mjs";

const inventory = build();

test("the route inventory is complete and has no shadowed branch", () => {
  assert.equal(inventory.shadowed.length, 0);
  assert.ok(inventory.route_count >= 160, `expected the dispatcher inventory, saw ${inventory.route_count}`);
  assert.ok(inventory.direct_route_count >= 18, "expected the direct Astro routes");
});

test("every browser, CLI, MCP and OpenAPI path resolves to an implemented route", () => {
  assert.deepEqual(inventory.unresolved_consumers, []);
  assert.deepEqual(inventory.unresolved_openapi, []);
});

test("the committed inventory matches the dispatcher", () => {
  const committed = JSON.parse(fs.readFileSync("docs/api-route-inventory.json", "utf8"));
  assert.deepEqual(normalizedInventory(inventory), committed);
});

test("the contact, gift, trade and merge boundaries stay explicit", () => {
  const routes = inventory.routes;
  const route = (method, path) => routes.find((item) => item.method === method && item.path === path);

  assert.deepEqual(route("GET", "/api/v1/admin/members")?.guards, ["ensureMemberAdmin"]);
  assert.deepEqual(route("GET", "/api/v1/admin/team")?.guards, ["ensureMemberAdmin"]);
  assert.deepEqual(route("GET", "/api/v1/admin/people")?.guards, ["ensureOps"]);
  assert.equal(route("GET", "/api/v1/admin/people")?.studio_alias, false);

  assert.ok(route("GET", "/api/v1/gifts"));
  assert.ok(route("GET", "/api/v1/gifts/received"));
  assert.ok(route("GET", "/api/v1/trades/:param"));
  assert.ok(route("POST", "/api/v1/admin/cards/:param/merge"));

  const studioRecipients = inventory.consumers.find((consumer) =>
    consumer.path.endsWith("/studio/wallet-recipients"),
  );
  assert.ok(studioRecipients?.matches.includes("GET /api/v1/admin/wallet-recipients"));
});
