import { z } from "zod";
import { ApiError, checkRateLimit, type Ctx } from "../context";
import { first } from "../db";
import { escapeHtml, sendEmail } from "../email";
import { hmacHex } from "../ids";

const HOUR = 3600;
const DAY = 24 * HOUR;
const contactEmail = z.email().max(254);
const unavailable = "We couldn't send your request just now. Please try again in a little while.";

export async function requestPreviewAccess(ctx: Ctx, input: unknown): Promise<void> {
  const email = typeof input === "string" ? input.trim().toLowerCase() : "";
  if (!contactEmail.safeParse(email).success) {
    throw new ApiError(422, "email_invalid", "Enter an email address Dean can reply to.");
  }

  await checkRateLimit(ctx.db, `preview-request:client:${ctx.clientKey}`, 3, HOUR);
  const owner = await first<{ email: string }>(
    ctx.db,
    `SELECT u.email FROM fb_platform_admins a JOIN fb_users u ON u.id = a.user_id
      WHERE a.status = 'active' AND a.revoked_at IS NULL AND u.platform_admin = 1
        AND u.disabled_at IS NULL AND u.is_synthetic = 0 AND u.email_verified_at IS NOT NULL`,
  );
  if (!owner) throw new ApiError(503, "preview_request_unavailable", unavailable);

  const addressKey = await hmacHex(ctx.config.sessionSecret || "foilbury-local", email);
  await checkRateLimit(ctx.db, `preview-request:address:${addressKey}`, 2, HOUR);
  await checkRateLimit(ctx.db, "preview-request:service", 20, DAY);

  const subject = "Foilbury preview access request";
  const intro = "A visitor asked to join the Foilbury preview.";
  const next = "Reply if you'd like to follow up. Approve access separately.";
  const sent = await sendEmail(ctx.config, {
    to: owner.email,
    replyTo: email,
    subject,
    text: `${intro}\n\nContact email (unverified): ${email}\n\n${next}`,
    html: `<html lang="en"><body><p>${intro}</p><p>Contact email (unverified): ${escapeHtml(email)}</p><p>${next}</p></body></html>`,
    idempotencyKey: `preview-access/${addressKey}/${Math.floor(Date.now() / (HOUR * 1000))}`,
  });
  if (!sent.ok) throw new ApiError(503, "preview_request_unavailable", unavailable);
}
