import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("workerd bindings", () => {
  it("runs D1 and R2 in the real Workers runtime", async () => {
    const row = await env.DB.prepare("SELECT value FROM fb_schema_meta WHERE key = 'domain_schema_version'").first<{ value: string }>();
    expect(row?.value).toBe("1");
    await env.MEDIA.put("tests/smoke.txt", "ok");
    const object = await env.MEDIA.get("tests/smoke.txt");
    expect(await object?.text()).toBe("ok");
  });
});
