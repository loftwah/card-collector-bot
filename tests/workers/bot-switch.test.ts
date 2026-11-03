import { describe, expect, it } from "vitest";
import { bootstrap, ctxFor, runtime } from "./helpers";
import { createSession, createSwitchedSession } from "../../src/server/modules/identity";
import { requireRecentStrongAuth } from "../../src/server/context";
import { sha256Hex } from "../../src/server/ids";

describe("session switching", () => {
  it("copies the original strong-auth time instead of refreshing it", async () => {
    await bootstrap();
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const oldAuthTime = new Date(Date.now() - 90 * 60 * 1000).toISOString();
    await createSession(runtime.DB, player.tenant, player.user!, {
      authMethod: "passkey",
      assurance: "passkey",
      authTime: oldAuthTime,
    });
    const switched = await createSwitchedSession(runtime.DB, player.tenant, player.user!, {
      sessionAssurance: "passkey",
      sessionAuthTime: oldAuthTime,
    });
    const row = await runtime.DB.prepare(
      "SELECT assurance, auth_time FROM fb_sessions WHERE token_hash = ?",
    )
      .bind(await sha256Hex(switched.token))
      .first<{ assurance: string; auth_time: string }>();
    expect(row?.assurance).toBe("passkey");
    expect(row?.auth_time).toBe(oldAuthTime);
    expect(() =>
      requireRecentStrongAuth(
        { ...player, sessionAssurance: "passkey", sessionAuthTime: oldAuthTime },
        20,
      ),
    ).toThrow(/stale/i);
  });
});
