import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("OpenAPI distinguishes the player and administrative resources", () => {
  const spec = JSON.parse(fs.readFileSync("public/openapi.json", "utf8"));
  const paths = spec.paths;
  assert.ok(paths["/api/v1/gifts"].get);
  assert.ok(paths["/api/v1/gifts/received"].get);
  assert.ok(paths["/api/v1/trades/{id}"].get);
  assert.ok(paths["/api/v1/members"].get);
  assert.ok(paths["/api/v1/admin/members"].get);
  const schema = paths["/api/v1/trades"].post.requestBody.content["application/json"].schema;
  assert.deepEqual(schema.required, ["proposerInstanceIds", "recipientInstanceIds"]);
  assert.deepEqual(schema.anyOf, [{ required: ["recipientId"] }, { required: ["recipientEmail"] }]);
});
