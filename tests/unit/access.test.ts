import { describe, expect, it, beforeAll } from "vitest";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK } from "jose";
import { assertPlatformAccessIdentity, verifyAccessToken } from "../../src/server/access";
import type { RuntimeConfig } from "../../src/server/config";

const teamDomain = "foilbury-test.cloudflareaccess.com";
const audience = "aud-admin";

function config(): RuntimeConfig {
  return {
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
    access: {
      enabled: true,
      teamDomain,
      adminAudience: audience,
      apiAudience: "aud-api",
      platformAudience: "aud-platform",
      platformApiAudience: "aud-platform-api",
      editorialAudience: "aud-editorial",
    },
    providers: {
      fal: false,
      elevenlabs: false,
      resend: false,
      adminWebhook: false,
      discordApplication: false,
      discordBot: false,
      discordOAuth: false,
      cloudflareAccess: true,
    },
  };
}

describe("Cloudflare Access JWT verification", () => {
  let privateKey: CryptoKey;
  let jwks: ReturnType<typeof createLocalJWKSet>;
  let publicJwk: JWK;

  beforeAll(async () => {
    const pair = await generateKeyPair("RS256");
    privateKey = pair.privateKey;
    publicJwk = await exportJWK(pair.publicKey);
    publicJwk.kid = "test-key";
    publicJwk.alg = "RS256";
    jwks = createLocalJWKSet({ keys: [publicJwk] });
  });

  async function token(overrides: { aud?: string; iss?: string; exp?: number; email?: string | null; idp?: string } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const builder = new SignJWT({
      email: overrides.email === null ? undefined : overrides.email ?? "dean@deanlofts.xyz",
      type: "app",
      idp: { type: overrides.idp ?? "cloudflare" },
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(overrides.iss ?? `https://${teamDomain}`)
      .setAudience(overrides.aud ?? audience)
      .setSubject("access-subject-1")
      .setIssuedAt(now - 10)
      .setExpirationTime(overrides.exp ?? now + 300);
    return builder.sign(privateKey);
  }

  it("accepts a signed token with the exact issuer and audience", async () => {
    const identity = await verifyAccessToken(await token(), config(), audience, { jwks });
    expect(identity.email).toBe("dean@deanlofts.xyz");
    expect(identity.subject).toBe("access-subject-1");
    expect(identity.idpType).toBe("cloudflare");
  });

  it("rejects the wrong audience", async () => {
    await expect(verifyAccessToken(await token({ aud: "other" }), config(), audience, { jwks })).rejects.toMatchObject({ code: "access_token_invalid" });
  });

  it("rejects the wrong issuer", async () => {
    await expect(verifyAccessToken(await token({ iss: "https://evil.cloudflareaccess.com" }), config(), audience, { jwks })).rejects.toMatchObject({ code: "access_token_invalid" });
  });

  it("rejects an expired token", async () => {
    await expect(verifyAccessToken(await token({ exp: Math.floor(Date.now() / 1000) - 60 }), config(), audience, { jwks })).rejects.toMatchObject({ code: "access_token_invalid" });
  });

  it("rejects a token without an email identity", async () => {
    await expect(verifyAccessToken(await token({ email: null }), config(), audience, { jwks })).rejects.toMatchObject({ code: "access_identity_missing" });
  });

  it("requires the Cloudflare account IdP for platform administration", async () => {
    const cloudflare = await verifyAccessToken(await token({ idp: "cloudflare" }), config(), audience, { jwks });
    expect(() => assertPlatformAccessIdentity(cloudflare)).not.toThrow();
    const otp = await verifyAccessToken(await token({ idp: "onetimepin" }), config(), audience, { jwks });
    expect(() => assertPlatformAccessIdentity(otp)).toThrow(/Cloudflare account/);
  });
});
