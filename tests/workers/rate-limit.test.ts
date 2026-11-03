import { beforeEach, describe, expect, it } from "vitest";
import { bootstrap, ctxFor } from "./helpers";
import { requestMagicLink } from "../../src/server/modules/magic-links";
import { trustedClientKey, type RuntimeConfig } from "../../src/server/context";
import { newId } from "../../src/server/ids";

async function clientKeyFor(address: string, config: RuntimeConfig): Promise<string> {
  return trustedClientKey(new Request("https://foilbury.example/api/v1/auth/magic-link", { method: "POST", headers: { "cf-connecting-ip": address } }), config);
}

describe("auth abuse limits use a trusted bounded client identity", () => {
  beforeEach(async () => {
    await bootstrap();
  });

  it("does not derive the client bucket from the per-request correlation ID", async () => {
    const base = await ctxFor("cabinet", "owner@foilbury.local");
    const client = await ctxFor("cabinet", "owner@foilbury.local");
    while (true) {
      let limited = false;
      try {
        await requestMagicLink(
          { ...client, requestId: newId("ray"), clientKey: "client-a" },
          { email: `${newId("mail")}@example.com`, purpose: "signin" },
        );
      } catch (error) {
        limited = (error as { code?: string }).code === "rate_limited";
        if (!limited) throw error;
      }
      if (limited) break;
    }
    // A different trusted client still has usable recovery capacity.
    await expect(
      requestMagicLink({ ...base, clientKey: "client-b" }, { email: "fresh-client@example.com", purpose: "signin" }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("keeps the per-email limit independent of the client bucket", async () => {
    const ctx = await ctxFor("cabinet", "owner@foilbury.local");
    for (let index = 0; index < 5; index += 1) {
      await requestMagicLink({ ...ctx, clientKey: `client-${index}` }, { email: "same-address@example.com", purpose: "signin" });
    }
    await expect(
      requestMagicLink({ ...ctx, clientKey: "another-client" }, { email: "same-address@example.com", purpose: "signin" }),
    ).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("trusts only the edge address, not arbitrary forwarding headers", async () => {
    const base = await ctxFor("cabinet", "owner@foilbury.local");
    const production: RuntimeConfig = {
      ...base.config,
      environment: "production",
      sessionSecret: "a".repeat(32),
    };
    const one = new Request("https://foilbury.example/api/v1/auth/magic-link", {
      headers: { "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "198.51.100.1", "cf-ray": "ray-one" },
    });
    const two = new Request("https://foilbury.example/api/v1/auth/magic-link", {
      headers: { "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "192.0.2.44", "cf-ray": "ray-two" },
    });
    const other = new Request("https://foilbury.example/api/v1/auth/magic-link", {
      headers: { "cf-connecting-ip": "198.51.100.7", "cf-ray": "ray-three" },
    });
    const [keyOne, keyTwo, keyOther] = await Promise.all([
      trustedClientKey(one, production),
      trustedClientKey(two, production),
      trustedClientKey(other, production),
    ]);
    expect(keyOne).toBe(keyTwo);
    expect(keyOther).not.toBe(keyOne);
    expect(keyOne).not.toContain("203.0.113.9");

    const stored = await base.db.prepare("SELECT key FROM fb_rate_limits").all<{ key: string }>();
    for (const row of stored.results ?? []) expect(row.key).not.toContain("203.0.113.9");
  });

  it("keeps local test traffic in one explicit local bucket regardless of spoofed headers", async () => {
    const base = await ctxFor("cabinet", "owner@foilbury.local");
    const local: RuntimeConfig = { ...base.config, environment: "local", sessionSecret: "b".repeat(32) };
    const first = await trustedClientKey(
      new Request("http://localhost:5173/api/v1/auth/magic-link", { headers: { "cf-connecting-ip": "1.1.1.1" } }),
      local,
    );
    const second = await trustedClientKey(
      new Request("http://localhost:5173/api/v1/auth/magic-link", { headers: { "cf-connecting-ip": "2.2.2.2" } }),
      local,
    );
    expect(first).toBe(second);
    expect(first).toBe(await clientKeyFor("3.3.3.3", local));
  });
});
