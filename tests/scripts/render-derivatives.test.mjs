import test from "node:test";
import assert from "node:assert/strict";
import { derivativeSources } from "../../scripts/lib/render-derivatives.mjs";

test("back derivatives require actual back bytes and never use the front path", () => {
  const result = { assetId: "front", back: { assetId: "back" } };
  assert.deepEqual(derivativeSources(result, "/front.webp", null), [{ assetId: "front", sourcePath: "/front.webp" }]);
  assert.deepEqual(derivativeSources(result, "/front.webp", "/back.webp"), [
    { assetId: "front", sourcePath: "/front.webp" },
    { assetId: "back", sourcePath: "/back.webp" },
  ]);
  assert.throws(() => derivativeSources(result, "/front.webp", "/front.webp"), /separate source files/);
});
