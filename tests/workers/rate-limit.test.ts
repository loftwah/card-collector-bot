import { beforeEach, describe, expect, it } from "vitest";
import { bootstrap, ctxFor } from "./helpers";
import { pruneRateLimits, requestMagicLink } from "../../src/server/modules/magic-links";
import { checkRateLimit, rateLimitEmailKey, trustedClientKey, type RuntimeConfig } from "../../src/server/context";
import { newId } from "../../src/server/ids";
import { apiErrorResponse } from "../../src/server/http";
import { POST as passwordLogin } from "../../src/pages/api/v1/auth/login";

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

  it("uses keyed normalized email buckets and preserves an active legacy count", async () => {
    const ctx=await ctxFor("cabinet", "owner@foilbury.local");
    const email="person@example.test", key=await rateLimitEmailKey(ctx.config,"login:email",email);
    expect(await rateLimitEmailKey(ctx.config,"login:email"," Person@Example.Test ")).toBe(key);
    expect(await rateLimitEmailKey(ctx.config,"passkey-login:email",email)).not.toBe(key);
    expect(key).not.toContain(email);
    const windowSeconds=300, now=Math.floor(Date.now()/1000), window=now-(now%windowSeconds);
    await ctx.db.prepare("INSERT INTO fb_rate_limits (key,window_start,count) VALUES (?,?,?)").bind(`login:${email}`,window,7).run();
    await checkRateLimit(ctx.db,key,8,windowSeconds,`login:${email}`);
    let failure:unknown;
    try { await checkRateLimit(ctx.db,key,8,windowSeconds,`login:${email}`); } catch (error) { failure=error; }
    expect(failure).toMatchObject({code:'rate_limited'});
    const response=apiErrorResponse(failure,'fixture');
    expect(response.status).toBe(429);
    const retry=Number(response.headers.get('retry-after'));
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(windowSeconds);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await ctx.db.prepare('SELECT count FROM fb_rate_limits WHERE key=?').bind(key).first<{count:number}>())?.count).toBe(9);
    expect((await ctx.db.prepare('SELECT count FROM fb_rate_limits WHERE key=?').bind(`login:${email}`).first<{count:number}>())?.count).toBe(7);
    const other=await rateLimitEmailKey(ctx.config,'login:email','other@example.test');
    await checkRateLimit(ctx.db,other,8,windowSeconds,'login:other@example.test');
    const stored=await ctx.db.prepare('SELECT key FROM fb_rate_limits WHERE key=?').bind(other).first<{key:string}>();
    expect(stored?.key).not.toContain('other@example.test');
    const migrating=await rateLimitEmailKey(ctx.config,'login:email','returning@example.test');
    await ctx.db.prepare('INSERT INTO fb_rate_limits (key,window_start,count) VALUES (?,?,?)').bind(migrating,window-windowSeconds,99).run();
    await ctx.db.prepare('INSERT INTO fb_rate_limits (key,window_start,count) VALUES (?,?,?)').bind('login:returning@example.test',window,8).run();
    await expect(checkRateLimit(ctx.db,migrating,8,windowSeconds,'login:returning@example.test')).rejects.toMatchObject({code:'rate_limited'});
    expect((await ctx.db.prepare('SELECT count FROM fb_rate_limits WHERE key=?').bind(migrating).first<{count:number}>())?.count).toBe(9);
  });

  it("returns Retry-After and stores no new raw email key on password login", async () => {
    const email='limit-person@example.test';
    let response:Response | undefined;
    for (let i=0;i<9;i++) {
      const request=new Request('http://localhost:5173/api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:i%2 ? email.toUpperCase() : email,password:'not-a-password'})});
      response=await passwordLogin({request} as never) as Response;
      expect(response.status).toBe(i<8 ? 401 : 429);
    }
    expect(Number(response!.headers.get('retry-after'))).toBeGreaterThan(0);
    const ctx=await ctxFor('cabinet','owner@foilbury.local');
    const keys=await ctx.db.prepare('SELECT key FROM fb_rate_limits').all<{key:string}>();
    expect((keys.results ?? []).some(row=>row.key.includes(email))).toBe(false);
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

  it("bounds concurrent attempts and prunes expired buckets", async () => {
    const ctx = await ctxFor("cabinet", "owner@foilbury.local");
    const attempts = await Promise.allSettled(
      Array.from({ length: 25 }, (_, index) =>
        requestMagicLink({ ...ctx, clientKey: "concurrent-client", requestId: `ray-${index}` }, { email: `burst-${index}@example.com`, purpose: "signin" }),
      ),
    );
    const allowed = attempts.filter((item) => item.status === "fulfilled").length;
    const limited = attempts.filter((item) => item.status === "rejected" && (item.reason as { code?: string }).code === "rate_limited").length;
    expect(allowed).toBe(20);
    expect(limited).toBe(5);
    await ctx.db.prepare("INSERT OR REPLACE INTO fb_rate_limits (key, window_start, count) VALUES ('expired:bucket', ?, 99)").bind(Math.floor(Date.now() / 1000) - 90000).run();
    await pruneRateLimits(ctx.db);
    const old = await ctx.db.prepare("SELECT key FROM fb_rate_limits WHERE key = 'expired:bucket'").first();
    expect(old).toBeNull();
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
