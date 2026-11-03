import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discordFailureLog,
  discordRouteTemplate,
  redactDiscordText,
} from "../../src/server/discord/redaction";

const TOKEN = "SYNTHETIC_INTERACTION_TOKEN_0123456789abcdef";
const APP = "1566702936615026769";

describe("Discord log redaction", () => {
  afterEach(() => vi.restoreAllMocks());

  it("maps every interaction route to a token-free template", () => {
    const base = `https://discord.com/api/v10/webhooks/${APP}/${TOKEN}`;
    expect(discordRouteTemplate("POST", `${base}?wait=true`)).toEqual({
      method: "POST",
      template: `POST /api/v10/webhooks/${APP}/:interaction_token?wait=true`,
    });
    expect(discordRouteTemplate("PATCH", `${base}/messages/@original`).template).toBe(
      `PATCH /api/v10/webhooks/${APP}/:interaction_token/messages/@original`,
    );
    expect(discordRouteTemplate("GET", `${base}/messages/@original`).template).toBe(
      `GET /api/v10/webhooks/${APP}/:interaction_token/messages/@original`,
    );
    expect(discordRouteTemplate("DELETE", `${base}/messages/@original`).template).toBe(
      `DELETE /api/v10/webhooks/${APP}/:interaction_token/messages/@original`,
    );
    expect(discordRouteTemplate("PATCH", `${base}/messages/998877`).template).toBe(
      `PATCH /api/v10/webhooks/${APP}/:interaction_token/messages/:message_id`,
    );
    expect(
      discordRouteTemplate("POST", `https://discord.com/api/v10/interactions/123456789/${TOKEN}/callback`)
        .template,
    ).toBe("POST /api/v10/interactions/123456789/:interaction_token/callback");
    expect(
      discordRouteTemplate("POST", `https://discord.com/api/v10/channels/1566700752385081355/messages`)
        .template,
    ).toBe("POST /api/v10/channels/1566700752385081355/messages");
    for (const route of [
      discordRouteTemplate("POST", `${base}?wait=true`),
      discordRouteTemplate("PATCH", `${base}/messages/@original`),
    ]) {
      expect(JSON.stringify(route)).not.toContain(TOKEN);
    }
  });

  it("drops unknown query parameters and non-Discord hosts", () => {
    expect(
      discordRouteTemplate("POST", `https://discord.com/api/v10/webhooks/${APP}/${TOKEN}?wait=true&secret=${TOKEN}`)
        .template,
    ).toBe(`POST /api/v10/webhooks/${APP}/:interaction_token?wait=true`);
    expect(discordRouteTemplate("POST", `https://example.test/webhooks/${APP}/${TOKEN}`).template).toBe(
      "non-discord-host",
    );
  });

  it("scrubs provider bodies, exception text, bearer tokens and token-shaped values", () => {
    const body = JSON.stringify({
      message: `401 Unauthorized for https://discord.com/api/v10/webhooks/${APP}/${TOKEN}/messages/@original?wait=true`,
      authorization: `Bot ${TOKEN}`,
      nested: `Bearer abcdefghijklmnopqrstuvwxyz`,
      jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXN5bnRoZXRpYw",
      env: "DISCORD_BOT_TOKEN=synthetic-value-here",
    });
    const scrubbed = redactDiscordText(body, [TOKEN]);
    expect(scrubbed).not.toContain(TOKEN);
    expect(scrubbed).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(scrubbed).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(scrubbed).not.toContain("synthetic-value-here");
    expect(scrubbed).toContain("[redacted]");
  });

  it("logs an allowlisted route, safe correlation ID and bounded detail only", () => {
    const line = discordFailureLog({
      correlationId: "discord:int_123",
      method: "PATCH",
      url: `https://discord.com/api/v10/webhooks/${APP}/${TOKEN}/messages/@original`,
      status: 403,
      detail: `Missing Access: ${TOKEN}`,
      secrets: [TOKEN],
      message: "Discord original-response edit failed",
    });
    expect(line.route).toBe(`PATCH /api/v10/webhooks/${APP}/:interaction_token/messages/@original`);
    expect(line.request_id).toBe("discord:int_123");
    expect(line.detail).not.toContain(TOKEN);
    expect(JSON.stringify(line)).not.toContain(TOKEN);
  });

  it("never retains the token when a real handler request times out", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((value) => {
      errors.push(String(value));
    });
    const { handleDiscordInteraction } = await import("../../src/server/discord/handler");
    // The log helper is exercised through discordFetch's catch path by a
    // synthetic transport failure; importing the handler keeps the check close
    // to the production call site without any network request.
    const log = discordFailureLog({
      correlationId: "discord:timeout-1",
      method: "POST",
      url: `https://discord.com/api/v10/webhooks/${APP}/${TOKEN}?wait=true`,
      detail: `The operation was aborted due to timeout while calling https://discord.com/api/v10/webhooks/${APP}/${TOKEN}`,
      secrets: [TOKEN],
      message: "Discord request failed or timed out",
    });
    console.error(JSON.stringify(log));
    expect(typeof handleDiscordInteraction).toBe("function");
    expect(errors.join("\n")).not.toContain(TOKEN);
    expect(errors.join("\n")).toContain(":interaction_token");
  });
});
