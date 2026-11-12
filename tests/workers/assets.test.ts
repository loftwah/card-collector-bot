import { describe, expect, it } from "vitest";
import { bootstrap, ctxFor, runtime } from "./helpers";
import { getAsset, uploadAsset } from "../../src/server/modules/assets";

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function bytes(): Uint8Array {
  return Uint8Array.from(atob(PNG_1X1), (character) => character.charCodeAt(0));
}

describe("asset storage keys", () => {
  it("keeps identical bytes in different kinds as separate, readable assets", async () => {
    await bootstrap();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const subject = await uploadAsset(owner, {
      kind: "subject",
      name: "Shared bytes subject",
      bytes: bytes(),
    });
    const background = await uploadAsset(owner, {
      kind: "background",
      name: "Shared bytes background",
      bytes: bytes(),
    });

    expect(subject.id).not.toBe(background.id);
    expect(subject.r2_key).not.toBe(background.r2_key);
    expect(subject.r2_key).toContain("/subject/");
    expect(background.r2_key).toContain("/background/");
    expect(await runtime.MEDIA.get(subject.r2_key)).toBeTruthy();
    expect(await runtime.MEDIA.get(background.r2_key)).toBeTruthy();
    expect((await getAsset(owner, subject.id))?.id).toBe(subject.id);
    expect((await getAsset(owner, background.id))?.id).toBe(background.id);

    const rows = await runtime.DB.prepare(
      "SELECT COUNT(*) AS count FROM fb_assets WHERE tenant_id = ? AND sha256 = ?",
    )
      .bind(owner.tenant.id, subject.sha256)
      .first<{ count: number }>();
    expect(rows?.count).toBe(2);
  });

  it("deduplicates the same bytes and kind without changing the stable asset or key", async () => {
    await bootstrap();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const first = await uploadAsset(owner, {
      kind: "subject",
      name: "First name",
      bytes: bytes(),
      source: { credit: "Original credit" },
    });
    const second = await uploadAsset(owner, {
      kind: "subject",
      name: "Revised name",
      bytes: bytes(),
      source: { credit: "Revised credit" },
    });
    expect(second.id).toBe(first.id);
    expect(second.r2_key).toBe(first.r2_key);
    expect(second.name).toBe("Revised name");
    expect(second.credit).toBe("Revised credit");
    const rows = await runtime.DB.prepare(
      "SELECT COUNT(*) AS count FROM fb_assets WHERE tenant_id = ? AND sha256 = ? AND kind = 'subject'",
    )
      .bind(owner.tenant.id, first.sha256)
      .first<{ count: number }>();
    expect(rows?.count).toBe(1);
    expect(await runtime.MEDIA.get(first.r2_key)).toBeTruthy();
  });

  it("retains explicit AI provenance when the artwork is uploaded again", async () => {
    await bootstrap();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const input = { kind: "subject" as const, name: "Print proof", bytes: bytes() };
    const generation = { provider: "OpenAI", endpoint: "codex:imagegen" };
    const asset = await uploadAsset(owner, { ...input, origin: "ai_assisted", generation });
    const reused = await uploadAsset(owner, input);

    expect(reused.id).toBe(asset.id);
    expect(reused.origin).toBe("ai_assisted");
    expect(JSON.parse(reused.generation_json!)).toEqual(generation);
    await expect(uploadAsset(owner, { ...input, origin: "sourced" })).rejects.toMatchObject({
      code: "asset_origin_conflict",
    });
    await expect(uploadAsset(owner, { ...input, origin: "ai_generated" })).rejects.toMatchObject({
      code: "asset_generation_invalid",
    });
  });
});
