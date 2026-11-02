import { runtimeEnv } from "./context";
import type { RuntimeConfig } from "./config";

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  idempotencyKey?: string;
}

/**
 * Send transactional mail through the existing Resend account. Callers must
 * never include full sign-in links in logs or audit metadata.
 */
export async function sendEmail(config: RuntimeConfig, message: EmailMessage): Promise<{ ok: boolean; id?: string; error?: string }> {
  const raw = runtimeEnv() as unknown as { RESEND_API_KEY?: string; RESEND_REPLY_TO?: string };
  const key = raw.RESEND_API_KEY?.trim();
  if (!key) return { ok: false, error: "email_not_configured" };
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        ...(message.idempotencyKey ? { "idempotency-key": message.idempotencyKey } : {}),
      },
      body: JSON.stringify({
        from: `Foilbury <${config.resendFrom}>`,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
        reply_to: message.replyTo ?? raw.RESEND_REPLY_TO ?? undefined,
      }),
    });
    const body = (await response.json().catch(() => null)) as { id?: string; message?: string } | null;
    if (!response.ok) return { ok: false, error: body?.message ?? `resend_${response.status}` };
    return { ok: true, id: body?.id };
  } catch {
    return { ok: false, error: "email_transport" };
  }
}

export function magicLinkEmail(input: {
  displayName: string;
  link: string;
  expiresMinutes: number;
  purpose: "signin" | "verify_email" | "link_email";
}): { subject: string; html: string; text: string } {
  const title = input.purpose === "signin" ? "Your Foilbury sign-in link" : "Confirm your Foilbury email";
  const action = input.purpose === "signin" ? "Sign in to Foilbury" : "Confirm email";
  const html = `<!doctype html>
<html><body style="margin:0;background:#f4f0e6;color:#141512;font-family:ui-sans-serif,system-ui,sans-serif">
  <div style="max-width:560px;margin:0 auto;padding:40px 24px">
    <div style="border:1px solid #d6cdbc;background:#fffdf8;padding:36px">
      <p style="margin:0 0 8px;font-family:ui-monospace,monospace;font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#6e6657">Foilbury · the cabinet</p>
      <h1 style="margin:0 0 16px;font-family:Georgia,serif;font-size:32px;line-height:1.05">${escapeHtml(title)}</h1>
      <p style="margin:0 0 12px;line-height:1.6">Hello ${escapeHtml(input.displayName)},</p>
      <p style="margin:0 0 24px;line-height:1.6">Use the button below within ${input.expiresMinutes} minutes. The link works once. If you did not ask for it, you can ignore this message.</p>
      <p style="margin:0 0 24px"><a href="${escapeHtml(input.link)}" style="display:inline-block;background:#245c4b;color:#fffdf8;padding:13px 20px;text-decoration:none;font-weight:600">${escapeHtml(action)}</a></p>
      <p style="margin:0;color:#6e6657;font-size:12px;line-height:1.6">For security, Foilbury will never ask for your password or a code by reply.</p>
    </div>
    <p style="margin:18px 0 0;color:#6e6657;font-size:12px;text-align:center">Foilbury · foilbury.loftwah.com</p>
  </div>
</body></html>`;
  const text = `${title}\n\nHello ${input.displayName},\n\nUse this link within ${input.expiresMinutes} minutes. It works once:\n${input.link}\n\nIf you did not ask for it, ignore this message.`;
  return { subject: title, html, text };
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
