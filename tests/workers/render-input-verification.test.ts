import { describe, expect, it } from "vitest";
import { runtime } from "./helpers";
import { readVerifiedRenderInput } from "../../src/server/modules/assets";
import { sha256Hex } from "../../src/server/ids";

describe("version-bound render input prerequisite", () => {
  it("returns only the recorded R2 version and verified bytes", async () => {
    const key = `test/render-input/${crypto.randomUUID()}`;
    const bytes = new TextEncoder().encode("recorded input");
    const original = await runtime.MEDIA.put(key, bytes);
    const expected = { key, version: original.version, etag: original.etag, sha256: await sha256Hex(bytes), bytes: bytes.length };
    expect(await readVerifiedRenderInput(runtime.MEDIA, expected)).toEqual(bytes);
    await expect(readVerifiedRenderInput(runtime.MEDIA, { ...expected, sha256: "0".repeat(64) })).rejects.toMatchObject({ code: "render_input_changed" });
    await expect(readVerifiedRenderInput(runtime.MEDIA, { ...expected, bytes: bytes.length + 1 })).rejects.toMatchObject({ code: "render_input_changed" });
    await expect(readVerifiedRenderInput(runtime.MEDIA, { ...expected, bytes: 8 * 1024 * 1024 + 1 })).rejects.toMatchObject({ code: "render_input_changed" });
    await runtime.MEDIA.put(key, bytes);
    await expect(readVerifiedRenderInput(runtime.MEDIA, expected)).rejects.toMatchObject({ code: "render_input_changed" });
    await runtime.MEDIA.put(key, "different input");
    await expect(readVerifiedRenderInput(runtime.MEDIA, expected)).rejects.toMatchObject({ code: "render_input_changed" });
    await runtime.MEDIA.delete(key);
    await expect(readVerifiedRenderInput(runtime.MEDIA, expected)).rejects.toMatchObject({ code: "render_input_changed" });
  });

  it("checks actual bytes and propagates storage failures", async () => {
    const bytes = new TextEncoder().encode("expected");
    const expected = { key: "input", version: "version", etag: "etag", sha256: await sha256Hex(bytes), bytes: bytes.length };
    const corrupt = { get: async () => ({ body: {}, version: "version", size: bytes.length, arrayBuffer: async () => new TextEncoder().encode("tampered").buffer }) } as unknown as R2Bucket;
    await expect(readVerifiedRenderInput(corrupt, expected)).rejects.toMatchObject({ code: "render_input_changed" });
    const outage = new Error("storage unavailable");
    const unavailable = { get: async () => { throw outage; } } as unknown as R2Bucket;
    await expect(readVerifiedRenderInput(unavailable, expected)).rejects.toBe(outage);
  });
});
