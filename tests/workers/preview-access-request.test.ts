import { beforeEach, expect, it, vi } from "vitest";
import { sendEmail } from "../../src/server/email";
import { findUserByEmail, markEmailVerified } from "../../src/server/modules/identity";
import { requestPreviewAccess } from "../../src/server/modules/preview-access-request";
import { bootstrap, ctxFor } from "./helpers";

vi.mock("../../src/server/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/email")>()),
  sendEmail: vi.fn(),
}));

beforeEach(async () => {
  vi.resetAllMocks();
  await bootstrap();
});

it("notifies the verified owner without creating a visitor account", async () => {
  const owner = await ctxFor("cabinet", "owner@foilbury.local");
  const ctx = { ...owner, user: null };
  const email = "visitor@example.invalid";
  await markEmailVerified(ctx.db, owner.user!.id);
  vi.mocked(sendEmail).mockResolvedValue({ ok: true, id: "receipt" });

  await requestPreviewAccess(ctx, email);
  await requestPreviewAccess(ctx, ` ${email.toUpperCase()} `);
  expect(sendEmail).toHaveBeenCalledWith(
    ctx.config,
    expect.objectContaining({
      to: owner.user!.email,
      replyTo: email,
      subject: "Foilbury preview access request",
    }),
  );
  expect(vi.mocked(sendEmail).mock.calls[0]?.[1]).toEqual(vi.mocked(sendEmail).mock.calls[1]?.[1]);
  await expect(requestPreviewAccess(ctx, email)).rejects.toMatchObject({ status: 429 });
  expect(sendEmail).toHaveBeenCalledTimes(2);
  expect(await findUserByEmail(ctx.db, email)).toBeNull();
});

it("reports failure when the owner or mail delivery is unavailable", async () => {
  const owner = await ctxFor("cabinet", "owner@foilbury.local");
  const ctx = { ...owner, user: null };
  const email = "visitor@example.invalid";

  await expect(requestPreviewAccess(ctx, "not an address")).rejects.toMatchObject({ status: 422 });
  await expect(requestPreviewAccess(ctx, email)).rejects.toMatchObject({ status: 503 });
  expect(sendEmail).not.toHaveBeenCalled();

  await markEmailVerified(ctx.db, owner.user!.id);
  vi.mocked(sendEmail).mockResolvedValue({ ok: false, error: "email_transport" });
  await expect(requestPreviewAccess(ctx, email)).rejects.toMatchObject({ status: 503 });
  expect(sendEmail).toHaveBeenCalledTimes(1);
});
