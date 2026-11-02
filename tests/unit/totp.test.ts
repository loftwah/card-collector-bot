import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, decryptSecret, encryptSecret, totpCode, verifyTotp } from "../../src/server/modules/totp";
import type { RuntimeConfig } from "../../src/server/config";

const config: RuntimeConfig = {
  appName: "Foilbury",
  environment: "test",
  publicOrigin: "http://127.0.0.1:4321",
  tenantSlug: "cabinet",
  localMode: false,
  devLogin: false,
  sessionSecret: "test-session-secret-at-least-32-characters",
  csrfSecret: "test-csrf-secret-at-least-32-characters",
  agentPepper: "test-pepper-at-least-32-characters",
  emdashSiteUrl: "http://127.0.0.1:4321",
  resendFrom: "foilbury@example.com",
  access: { enabled: false, teamDomain: "", adminAudience: "", apiAudience: "", platformAudience: "", platformApiAudience: "", editorialAudience: "" },
  providers: { fal: false, elevenlabs: false, resend: false, adminWebhook: false, discordApplication: false, discordBot: false, discordOAuth: false, cloudflareAccess: false },
};

describe("TOTP", () => {
  it("matches the RFC 6238 SHA-1 vector", async () => {
    const secret = base32Encode(new TextEncoder().encode("12345678901234567890"));
    expect(secret).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(await totpCode(secret, 59_000)).toBe("287082");
  });

  it("verifies the current and adjacent time steps but not a wrong code", async () => {
    const secret = base32Encode(new TextEncoder().encode("12345678901234567890"));
    const now = 1_111_111_109_000;
    const code = await totpCode(secret, now);
    expect(await verifyTotp(secret, code, now)).toBe(true);
    expect(await verifyTotp(secret, code, now + 30_000)).toBe(true);
    expect(await verifyTotp(secret, "000000", now)).toBe(false);
  });

  it("round-trips an encrypted secret with AES-GCM", async () => {
    const secret = base32Encode(crypto.getRandomValues(new Uint8Array(20)));
    const encrypted = await encryptSecret(secret, config);
    expect(encrypted).toContain(".");
    expect(await decryptSecret(encrypted, config)).toBe(secret);
    await expect(decryptSecret(encrypted, { ...config, sessionSecret: "different-secret-at-least-32-characters-long" })).rejects.toBeTruthy();
  });

  it("decodes base32 with separators and lowercase", () => {
    expect([...base32Decode("gezd gnbv gy3t qojq")].length).toBeGreaterThan(5);
  });
});
