import { describe, expect, it, beforeAll, vi } from "vitest";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK } from "jose";
import { assertPlatformAccessIdentity, resolveAccessIdentityProvider, verifyAccessToken } from "../../src/server/access";
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

  async function token(overrides: {
    aud?: string | null;
    iss?: string;
    exp?: number | null;
    email?: string | null;
    sub?: string | null;
    type?: string;
  } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const builder = new SignJWT({
      email: overrides.email === null ? undefined : overrides.email ?? "dean@deanlofts.xyz",
      type: overrides.type ?? "app",
      identity_nonce: "test-identity-cache-key",
      country: "AU",
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(overrides.iss ?? `https://${teamDomain}`)
      .setIssuedAt(now - 10)
      .setNotBefore(now - 10);
    if (overrides.aud !== null) builder.setAudience(overrides.aud ?? audience);
    if (overrides.sub !== null) builder.setSubject(overrides.sub ?? "access-subject-1");
    if (overrides.exp !== null) builder.setExpirationTime(overrides.exp ?? now + 300);
    return builder.sign(privateKey);
  }

  it("accepts the standard Access JWT shape without an IdP or MFA claim", async () => {
    const identity = await verifyAccessToken(await token(), config(), audience, { jwks });
    expect(identity.email).toBe("dean@deanlofts.xyz");
    expect(identity.subject).toBe("access-subject-1");
    expect(identity.audience).toBe(audience);
    expect(identity.payload).not.toHaveProperty("idp");
    expect(identity).not.toHaveProperty("idpType");
    expect(identity).not.toHaveProperty("mfa");
  });

  it("rejects the wrong audience", async () => {
    await expect(verifyAccessToken(await token({ aud: "other" }), config(), audience, { jwks })).rejects.toMatchObject({ code: "access_token_invalid" });
  });

  it("rejects a token without an application audience", async () => {
    await expect(verifyAccessToken(await token({ aud: null }), config(), audience, { jwks })).rejects.toMatchObject({ code: "access_token_invalid" });
  });

  it("rejects the wrong issuer", async () => {
    await expect(verifyAccessToken(await token({ iss: "https://evil.cloudflareaccess.com" }), config(), audience, { jwks })).rejects.toMatchObject({ code: "access_token_invalid" });
  });

  it("rejects an expired token", async () => {
    await expect(verifyAccessToken(await token({ exp: Math.floor(Date.now() / 1000) - 60 }), config(), audience, { jwks })).rejects.toMatchObject({ code: "access_token_invalid" });
  });

  it("rejects a token with no expiry", async () => {
    await expect(verifyAccessToken(await token({ exp: null }), config(), audience, { jwks })).rejects.toMatchObject({ code: "access_token_invalid" });
  });

  it("rejects an invalid signature", async () => {
    const otherKey = await generateKeyPair("RS256");
    const otherJwk = await exportJWK(otherKey.publicKey);
    otherJwk.kid = "test-key";
    otherJwk.alg = "RS256";
    const otherJwks = createLocalJWKSet({ keys: [otherJwk] });
    await expect(verifyAccessToken(await token(), config(), audience, { jwks: otherJwks })).rejects.toMatchObject({ code: "access_token_invalid" });
  });

  it("rejects a global session token even with a matching audience", async () => {
    await expect(verifyAccessToken(await token({ type: "org" }), config(), audience, { jwks })).rejects.toMatchObject({ code: "access_token_invalid" });
  });

  it("rejects a token without an email identity", async () => {
    await expect(verifyAccessToken(await token({ email: null }), config(), audience, { jwks })).rejects.toMatchObject({ code: "access_identity_missing" });
  });

  it.each([null, "", " "])("rejects a missing or empty stable subject (%s)", async (sub) => {
    await expect(verifyAccessToken(await token({ sub }), config(), audience, { jwks })).rejects.toMatchObject({ code: "access_identity_missing" });
  });

  it.each(["aud-platform", "aud-platform-api"])("accepts the dedicated platform audience %s without inventing an IdP claim", async (platformAudience) => {
    const identity = await verifyAccessToken(await token({ aud: platformAudience }), config(), platformAudience, { jwks });
    expect(() => assertPlatformAccessIdentity(identity, config())).not.toThrow();
    expect(identity).not.toHaveProperty("platformAdmin");
  });

  it("does not treat a mixed Bot-administration audience as platform authority", async () => {
    const identity = await verifyAccessToken(await token(), config(), audience, { jwks });
    expect(() => assertPlatformAccessIdentity(identity, config())).toThrow(/platform administration/);
  });

  it("fails closed when platform audiences are not configured", async () => {
    const identity = await verifyAccessToken(await token(), config(), audience, { jwks });
    const missingPlatformConfig = config();
    missingPlatformConfig.access.platformAudience = "";
    missingPlatformConfig.access.platformApiAudience = "";
    expect(() => assertPlatformAccessIdentity(identity, missingPlatformConfig)).toThrow(/platform administration/);
  });

  it("proves the Cloudflare provider through the fixed-team identity endpoint", async () => {
    const assertion = await token();
    const identity = await verifyAccessToken(assertion, config(), audience, { jwks });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      user_uuid: identity.subject,
      email: "Dean@deanlofts.xyz",
      idp: { type: "cloudflare" },
    }));

    await expect(resolveAccessIdentityProvider(assertion, identity, config(), { fetcher })).resolves.toBe("cloudflare");
    expect(fetcher).toHaveBeenCalledWith(`https://${teamDomain}/cdn-cgi/access/get-identity`, {
      headers: { cookie: `CF_Authorization=${assertion}` },
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
    expect(identity).not.toHaveProperty("mfa");
  });

  it.each([
    { user_uuid: "other-user", email: "dean@deanlofts.xyz", idp: { type: "cloudflare" } },
    { user_uuid: "access-subject-1", email: "other@example.com", idp: { type: "cloudflare" } },
    { user_uuid: "access-subject-1", email: "dean@deanlofts.xyz", idp: { type: "onetimepin" } },
    { user_uuid: "access-subject-1", email: "dean@deanlofts.xyz" },
  ])("grants no provider assurance for a mismatched identity or non-Cloudflare provider: %j", async (profile) => {
    const assertion = await token();
    const identity = await verifyAccessToken(assertion, config(), audience, { jwks });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(profile));
    await expect(resolveAccessIdentityProvider(assertion, identity, config(), { fetcher })).resolves.toBeNull();
  });

  it("fails closed when the identity endpoint is unavailable or returns an invalid response", async () => {
    const assertion = await token();
    const identity = await verifyAccessToken(assertion, config(), audience, { jwks });
    const fetcher = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new DOMException("Timed out", "TimeoutError"))
      .mockResolvedValueOnce(new Response("Unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("not JSON"));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(resolveAccessIdentityProvider(assertion, identity, config(), { fetcher })).resolves.toBeNull();
    }
  });

  it("bounds the identity response before parsing it", async () => {
    const assertion = await token();
    const identity = await verifyAccessToken(assertion, config(), audience, { jwks });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      user_uuid: identity.subject,
      email: identity.email,
      idp: { type: "cloudflare" },
      groups: "x".repeat(65_536),
    }));
    await expect(resolveAccessIdentityProvider(assertion, identity, config(), { fetcher })).resolves.toBeNull();
  });
});

