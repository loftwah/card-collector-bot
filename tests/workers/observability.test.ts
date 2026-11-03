import { beforeEach, describe, expect, it } from "vitest";
import { operationsStatus } from "../../src/server/modules/economy";
import { bootstrap, ctxFor, runtime } from "./helpers";

const APP = "1566702936615026769";

async function interaction(id: string, status: string, errorCode: string | null, createdAt: string) {
  await runtime.DB.prepare(
    `INSERT INTO fb_discord_interactions
      (interaction_id, application_id, guild_id, channel_id, discord_user_id, command_name, status, error_code, created_at, completed_at)
     VALUES (?, ?, '997734945206313041', '1566700752385081355', '707281352818425929', 'foilbury', ?, ?, ?, ?)`,
  )
    .bind(id, APP, status, errorCode, createdAt, createdAt)
    .run();
}

describe("delivery health is based on verified outcomes", () => {
  beforeEach(async () => {
    await bootstrap();
  });

  it("distinguishes configured-unverified, healthy and degraded", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const empty = await operationsStatus(owner);
    if (empty.discord.connected) {
      expect(empty.discord.status).toBe("configured_unverified");
      expect(empty.discord.recent.total).toBe(0);
    }

    const now = new Date().toISOString();
    await interaction("obs-ok", "completed", null, now);
    const healthy = await operationsStatus(owner);
    expect(healthy.discord.recent.completed).toBe(1);
    expect(healthy.discord.status).toBe("healthy");

    await interaction(
      "obs-failed",
      "completed",
      "delivery_failed",
      new Date(Date.now() + 1000).toISOString(),
    );
    const degraded = await operationsStatus(owner);
    expect(degraded.discord.recent.delivery_failures).toBe(1);
    expect(degraded.discord.status).toBe("degraded");

    await interaction(
      "obs-stuck",
      "processing",
      null,
      new Date(Date.now() - 60 * 60_000).toISOString(),
    );
    const stuck = await operationsStatus(owner);
    expect(stuck.discord.recent.stuck_processing).toBeGreaterThanOrEqual(1);
    expect(stuck.discord.status).toBe("degraded");
  });
});
