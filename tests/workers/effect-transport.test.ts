import { describe, expect, it } from "vitest";
import { runDiscordRequest } from "../../src/server/effect/discord-transport";

function services(handler: (attempt: number) => Promise<Response>) {
  let attempts = 0;
  return {
    attempts: () => attempts,
    http: {
      request: async () => {
        attempts += 1;
        return handler(attempts);
      },
    },
    logger: { error: () => undefined },
  };
}

describe("Effect-owned Discord transport", () => {
  it("retries a bounded idempotent 5xx and succeeds", async () => {
    const injected = services(async (attempt) =>
      attempt < 3
        ? new Response("unavailable", { status: 503 })
        : new Response(JSON.stringify({ id: "msg_1" }), { status: 200 }),
    );
    const result = await runDiscordRequest(
      {
        url: "https://discord.com/api/v10/webhooks/1/token/messages/@original",
        init: { method: "PATCH" },
        timeoutMs: 500,
        idempotent: true,
        maxAttempts: 3,
      },
      injected,
    );
    expect(result.response?.status).toBe(200);
    expect(result.attempts).toBe(3);
    expect(injected.attempts()).toBe(3);
  });

  it("never retries an ambiguous POST", async () => {
    const injected = services(async () => new Response("unavailable", { status: 503 }));
    const result = await runDiscordRequest(
      {
        url: "https://discord.com/api/v10/webhooks/1/token",
        init: { method: "POST" },
        timeoutMs: 500,
        idempotent: false,
      },
      injected,
    );
    expect(result.response?.status).toBe(503);
    expect(result.attempts).toBe(1);
    expect(injected.attempts()).toBe(1);
  });

  it("bounds a stalled request with a typed timeout", async () => {
    const injected = services(
      () => new Promise<Response>((resolve) => setTimeout(() => resolve(new Response("late")), 100)),
    );
    const result = await runDiscordRequest(
      {
        url: "https://discord.com/api/v10/webhooks/1/token/messages/@original",
        init: { method: "GET" },
        timeoutMs: 5,
        idempotent: true,
        maxAttempts: 2,
      },
      injected,
    );
    expect(result.response).toBeNull();
    expect(result.error?.timedOut).toBe(true);
    expect(result.attempts).toBe(1); // The entire request, including retries, has one deadline.
  });

  it("parses provider Retry-After for a bounded idempotent retry", async () => {
    const started: number[] = [];
    const injected = services(
      async () => {
        started.push(Date.now());
        return new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "0.03" },
        });
      },
    );
    const result = await runDiscordRequest(
      {
        url: "https://discord.com/api/v10/webhooks/1/token/messages/@original",
        init: { method: "PATCH" },
        timeoutMs: 500,
        idempotent: true,
        maxAttempts: 2,
      },
      injected,
    );
    expect(result.response).toBeNull();
    expect(result.error?.status).toBe(429);
    expect(result.error?.retryAfterMs).toBe(30);
    expect(result.attempts).toBe(2);
    expect(started[1]! - started[0]!).toBeGreaterThanOrEqual(30);
  });

  it('returns a typed rate limit when the provider delay exceeds the remaining budget', async () => {
    const injected=services(async()=>new Response('rate limited',{status:429,headers:{'retry-after':'6'}}));
    const result=await runDiscordRequest({url:'https://discord.com/api/v10/fixture',init:{method:'PATCH'},timeoutMs:50,idempotent:true,maxAttempts:3},injected);
    expect(result.response).toBeNull();
    expect(result.error).toMatchObject({status:429,retryAfterMs:6000,timedOut:false});
    expect(result.attempts).toBe(1);
  });

  it('does not retry a rate limit without a usable provider delay', async () => {
    for (const header of [undefined, 'invalid', '  ', '1e-3', '0x10', '+0.1', '0.']) {
      const injected=services(async()=>new Response('rate limited',{status:429,headers:header===undefined ? {} : {'retry-after':header}}));
      const result=await runDiscordRequest({url:'https://discord.com/api/v10/fixture',init:{method:'PATCH'},timeoutMs:100,idempotent:true},injected);
      expect(result.error).toMatchObject({status:429,retryAfterMs:null,retryable:false});
      expect(result.attempts).toBe(1);
    }
  });

  it('counts elapsed provider time against the same deadline', async () => {
    const injected=services(async()=>{await new Promise(resolve=>setTimeout(resolve,90));return new Response('rate limited',{status:429,headers:{'retry-after':'0.12'}});});
    const result=await runDiscordRequest({url:'https://discord.com/api/v10/fixture',init:{method:'PATCH'},timeoutMs:200,idempotent:true,maxAttempts:3},injected);
    expect(result.error).toMatchObject({status:429,retryAfterMs:120,timedOut:false});
    expect(result.attempts).toBe(1);
  });

  it('interrupts a stalled request when the overall deadline expires', async () => {
    let aborted=false;
    const result=await runDiscordRequest({url:'https://discord.com/api/v10/fixture',init:{method:'PATCH'},timeoutMs:20,idempotent:true}, {
      http:{request:(_url,_init,signal)=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(new Error('aborted'));},{once:true}))},
      logger:{error:()=>undefined},
    });
    expect(result.error?.timedOut).toBe(true);
    expect(result.attempts).toBe(1);
    expect(aborted).toBe(true);
  });

  it("maps a thrown provider failure without exposing provider secrets", async () => {
    const secret='private-webhook-token-fixture';
    const injected = services(async () => {
      throw new Error(`provider exploded at https://discord.com/api/webhooks/${secret}`);
    });
    const result = await runDiscordRequest(
      {
        url: "https://discord.com/api/v10/webhooks/1/token/messages/@original",
        init: { method: "PATCH" },
        timeoutMs: 500,
        idempotent: true,
        maxAttempts: 2,
      },
      injected,
    );
    expect(result.response).toBeNull();
    expect(result.error?.message).toBe('Discord transport request failed');
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.attempts).toBe(2);
  });
});
