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
    expect(result.attempts).toBe(2);
  });

  it("maps a thrown provider failure without leaking it as an unhandled rejection", async () => {
    const injected = services(async () => {
      throw new Error("provider exploded");
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
    expect(result.error?.message).toContain("provider exploded");
    expect(result.attempts).toBe(2);
  });
});
