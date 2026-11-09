import { describe, expect, it, vi } from "vitest";
import { bootstrap, ctxFor, runtime, setBalance } from "./helpers";
import { handleDiscordInteraction } from "../../src/server/discord/handler";
import { signDiscordRequest } from "../../src/server/discord/signature";
import type { DiscordEnv } from "../../src/server/discord/types";
import { deliverDeferred, safeRecoveryReason } from "../../src/server/discord/delivery";
import { recordInteractionReceipt, type DiscordReceipt } from "../../src/server/discord/receipts";
import { ApiError } from "../../src/server/context";
import { creditWallet } from "../../src/server/modules/wallet";
import { safeDrawFailureFields } from "../../src/server/discord/draw-runtime";
import { DiscordDrawProviderTransient } from "../../src/server/effect/discord-draw-workflow";

describe("Discord unexpected-error logging", () => {
  it("retains allowlisted draw failure stage without provider text", () => {
    const failure = new DiscordDrawProviderTransient({ operation: "receipt", message: "Cookie secret", retryAfterMs: null });
    expect(safeDrawFailureFields(failure)).toEqual({ failure_type: "DiscordDrawProviderTransient", operation: "receipt" });
    const unknownOperation = new DiscordDrawProviderTransient({ operation: "private prompt", message: "Cookie secret", retryAfterMs: null });
    expect(safeDrawFailureFields(unknownOperation)).toEqual({ failure_type: "DiscordDrawProviderTransient" });
    expect(safeDrawFailureFields(new Error("Cookie secret"))).toEqual({ failure_type: "unexpected_defect" });
  });
  it("preserves the reviewed missing-render recovery explanation", () => {
    for (const code of ["card_render_unavailable", "render_missing"]) {
      expect(safeRecoveryReason(new ApiError(404, code, "untrusted provider text"))).toBe("The saved card render was unavailable, but the draw and serial are recorded.");
    }
  });
  it.each(["immediate", "deferred"] as const)("keeps arbitrary provider text out of %s signed-interaction logs", async (phase) => {
    await bootstrap();
    const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const rawPublic = await crypto.subtle.exportKey("raw", keys.publicKey);
    const publicKey = Array.from(new Uint8Array(rawPublic), byte => byte.toString(16).padStart(2, "0")).join("");
    const body = JSON.stringify({ id: "1567443524209872926", application_id: "1566702936615026769", type: 2,
      token: "fixture-interaction-token", guild_id: "997734945206313041", channel_id: "1566700752385081355",
      member: { user: { id: "707281352818425929", username: "fixture" }, roles: [] },
      data: { name: "foilbury", type: 1, options: [{ name: "help", type: 1 }] } });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await signDiscordRequest({ body, timestamp, privateKey: keys.privateKey });
    const request = new Request("https://foilbury.test/api/discord/interactions", { method: "POST",
      headers: { "content-type": "application/json", "x-signature-ed25519": signature, "x-signature-timestamp": timestamp }, body });
    const secret = "fixture-sensitive-cookie";
    const db = new Proxy(runtime.DB, { get(target, key) {
      if (key === "prepare") return (sql: string) => {
        if (sql.includes("SELECT * FROM fb_discord_installations")) throw new Error(`Cookie: session=${secret} https://private.test/?token=${secret} private prompt`);
        return target.prepare(sql);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const env = new Proxy(runtime as unknown as DiscordEnv, { get(target, key) {
      if (key === "DB") return db;
      if (key === "DISCORD_APPLICATION_ID") return "1566702936615026769";
      if (key === "DISCORD_PUBLIC_KEY") return publicKey;
      return Reflect.get(target, key, target);
    } });
    const logs: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((value) => { logs.push(String(value)); });
    const fetchStub = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchStub);
    try {
      const pending: Promise<unknown>[] = [];
      const response = await handleDiscordInteraction(request, env, { publicKey, ...(phase === "deferred" ? { waitUntil: (promise: Promise<unknown>) => pending.push(promise) } : {}) });
      expect(response.status).toBe(200);
      await Promise.all(pending);
      const output = logs.join("\n");
      expect(output).toContain("discord.interaction.unexpected_failure");
      expect(output).toContain("discord:1567443524209872926");
      expect(output).toContain(`\"phase\":\"${phase}\"`);
      for (const value of [secret, "Cookie", "private.test", "private prompt", "fixture-interaction-token"]) expect(output).not.toContain(value);
    } finally { vi.unstubAllGlobals(); spy.mockRestore(); }
  });

  it("keeps provider response bodies and database exceptions out of delivery and receipt logs", async () => {
    await bootstrap();
    const secret = "fixture-private-provider-value";
    const logs: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((value) => { logs.push(String(value)); });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`Cookie: session=${secret} https://private.test/?token=${secret} private prompt`, { status: 403 })));
    try {
      const outcome = await deliverDeferred(runtime as unknown as DiscordEnv, {
        id: "1567443524209872926", application_id: "1566702936615026769", token: "fixture-interaction-token", type: 2,
      }, { type: 4, data: { flags: 64, content: "private result" } });
      expect(outcome.delivered).toBe(false);
      const db = new Proxy(runtime.DB, { get(target, key) {
        if (key === "prepare") return () => { throw new Error(`Cookie: session=${secret} https://private.test/?token=${secret} private prompt`); };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
      expect(await recordInteractionReceipt(db, "1567443524209872926", { kind: "draw" } as DiscordReceipt)).toBe(false);
      const output = logs.join("\n");
      expect(output).toContain("HTTP 403");
      expect(output).toContain("discord.receipt.operation_failed");
      expect(output).toContain("1567443524209872926");
      for (const value of [secret, "Cookie", "private.test", "private prompt", "fixture-interaction-token"]) expect(output).not.toContain(value);
    } finally { vi.unstubAllGlobals(); spy.mockRestore(); }
  });

  it.each([204, 403])("keeps unknown recovery errors and an existing draw receipt private when delivery returns %s", async (status) => {
    await bootstrap();
    const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const publicKey = Array.from(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)), byte => byte.toString(16).padStart(2, "0")).join("");
    const id = "1567443524209872926";
    const body = JSON.stringify({ id, application_id: "1566702936615026769", type: 2, token: "fixture-interaction-token",
      guild_id: "997734945206313041", channel_id: "1566700752385081355", member: { user: { id: "707281352818425929", username: "fixture" }, roles: [] },
      data: { name: "foilbury", type: 1, options: [{ name: "help", type: 1 }] } });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await signDiscordRequest({ body, timestamp, privateKey: keys.privateKey });
    const request = new Request("https://foilbury.test/api/discord/interactions", { method: "POST", headers: {
      "content-type": "application/json", "x-signature-ed25519": signature, "x-signature-timestamp": timestamp }, body });
    const receipt = { kind: "draw", draw_id: "drw_fixture", instance_id: "ins_fixture", variant_id: "var_fixture", card_id: "card_fixture",
      card_name: "Fixture", edition_name: null, variant_name: "Plain", serial: "FB-FIXTURE", pool_name: "Fixture pool", price: 80, currency_symbol: "F", balance_after: 100, drawn_at: new Date().toISOString() };
    await runtime.DB.prepare("INSERT INTO fb_discord_interactions (interaction_id, application_id, command_name, status, created_at, receipt_kind, receipt_json) VALUES (?, ?, 'foilbury', 'processing', ?, 'draw', ?)")
      .bind(id, "1566702936615026769", new Date().toISOString(), JSON.stringify(receipt)).run();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    await setBalance(owner, owner.user!.id, 100);
    const later = await creditWallet(owner.db, { tenantId: owner.tenant.id, userId: owner.user!.id, amount: 25, kind: "issue", description: "Later fixture transaction", idempotencyKey: "later-recovery-fixture" });
    expect(later.balance).toBe(125);
    const secret = "fixture-recovery-secret";
    const db = new Proxy(runtime.DB, { get(target, key) {
      if (key === "prepare") return (sql: string) => {
        if (sql.includes("SELECT * FROM fb_discord_installations")) throw new ApiError(500, "unknown_provider_error", `Cookie: ${secret} https://private.test/?token=${secret} private prompt`);
        return target.prepare(sql);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const env = new Proxy(runtime as unknown as DiscordEnv, { get(target, key) {
      if (key === "DB") return db;
      if (key === "DISCORD_APPLICATION_ID") return "1566702936615026769";
      if (key === "DISCORD_PUBLIC_KEY") return publicKey;
      return Reflect.get(target, key, target);
    } });
    const fetchStub = vi.fn(async () => new Response(status === 204 ? null : `Cookie ${secret}`, { status }));
    const logs: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((value) => { logs.push(String(value)); });
    vi.stubGlobal("fetch", fetchStub);
    try {
      const pending: Promise<unknown>[] = [];
      const response = await handleDiscordInteraction(request, env, { publicKey, waitUntil: (promise) => pending.push(promise) });
      expect(response.status).toBe(200);
      await Promise.all(pending);
      expect(fetchStub).toHaveBeenCalledTimes(1);
      const [url, init] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toContain("/messages/@original");
      expect(init.method).toBe("PATCH");
      const sent = String(init.body);
      expect(sent).toContain("The recorded result remains in your cabinet");
      expect(sent).toContain("FB-FIXTURE");
      expect(sent).toContain("Balance after draw");
      expect(sent).not.toContain("Current balance");
      for (const value of [secret, "Cookie", "private.test", "private prompt"]) expect(sent).not.toContain(value);
      expect(logs.join("\n")).not.toContain(secret);
      const persisted = await runtime.DB.prepare("SELECT status, receipt_json FROM fb_discord_interactions WHERE interaction_id = ?").bind(id).first<{ status: string; receipt_json: string }>();
      expect(persisted?.status).toBe("completed");
      expect(JSON.parse(persisted!.receipt_json).serial).toBe("FB-FIXTURE");
    } finally { vi.unstubAllGlobals(); spy.mockRestore(); }
  });
});
