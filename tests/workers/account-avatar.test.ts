import { beforeEach, describe, expect, it } from "vitest";
import { bootstrap, ctxFor, runtime } from "./helpers";
import {
  accountAvatarViewFor,
  loadAccountAvatar,
  setDefaultAvatar,
  setUploadedAvatar,
} from "../../src/server/modules/account-avatar";

const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("account avatar identity", () => {
  beforeEach(async () => {
    await bootstrap();
  });

  it("defaults every account to the illustrated Keeper, never initials", async () => {
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const initial = accountAvatarViewFor(player.user);
    expect(initial.kind).toBe("default");
    expect(initial.defaultKey).toBe("keeper");
    expect(initial.src).toBe("/avatars/default/keeper-256.png");
    expect(initial.fallback).toBe(false);

    const saved = await setDefaultAvatar(player, "archivist");
    expect(saved.kind).toBe("default");
    expect(saved.defaultKey).toBe("archivist");
    expect(saved.label).toBe("The Archivist");
    expect(saved.src).toContain("archivist-256.png");

    const reread = await loadAccountAvatar(player, player.user!.id);
    expect(reread.defaultKey).toBe("archivist");
    const audit = await runtime.DB.prepare(
      "SELECT action, metadata_json FROM fb_audit_events WHERE action = 'account.avatar.updated' ORDER BY created_at DESC LIMIT 1",
    ).first<{ action: string; metadata_json: string }>();
    expect(audit?.action).toBe("account.avatar.updated");
    expect(audit?.metadata_json).toContain("archivist");
  });

  it("rejects an avatar that is not in the illustrated family", async () => {
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await expect(setDefaultAvatar(player, "initials")).rejects.toMatchObject({
      code: "avatar_default_invalid",
    });
    expect((await loadAccountAvatar(player, player.user!.id)).defaultKey).toBe("keeper");
  });

  it("rejects an upload that was not prepared at every square rendition", async () => {
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await expect(
      setUploadedAvatar(player, [
        { size: 256, data: ONE_PIXEL_PNG, mime: "image/png" },
        { size: 128, data: ONE_PIXEL_PNG, mime: "image/png" },
        { size: 64, data: ONE_PIXEL_PNG, mime: "image/png" },
      ]),
    ).rejects.toMatchObject({ code: "avatar_dimensions_invalid" });
    expect((await loadAccountAvatar(player, player.user!.id)).kind).toBe("default");
  });
});
