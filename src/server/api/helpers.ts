import { ApiError, assertTrustedLocal, buildContext, type Ctx } from "../context";
import { json } from "../http";

export function sessionCookies(token: string, csrf: string, expiresAt: string, secure: boolean): string[] {
  const base = `Path=/; SameSite=Lax; Expires=${new Date(expiresAt).toUTCString()}`;
  return [
    `fb_session=${encodeURIComponent(token)}; HttpOnly; ${base}${secure ? "; Secure" : ""}`,
    `fb_csrf=${encodeURIComponent(csrf)}; ${base}${secure ? "; Secure" : ""}`,
  ];
}

export function clearSessionCookies(secure: boolean): string[] {
  const base = `Path=/; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  return [
    `fb_session=; HttpOnly; ${base}${secure ? "; Secure" : ""}`,
    `fb_csrf=; ${base}${secure ? "; Secure" : ""}`,
  ];
}

export function cookieHeaders(cookies: string[]): Headers {
  const headers = new Headers();
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return headers;
}

export async function localContext(request: Request): Promise<Ctx> {
  const ctx = await buildContext(request);
  assertTrustedLocal(request, ctx.config);
  return ctx;
}

export function methodNotAllowed(allowed: string[]): Response {
  return json(
    { error: { code: "method_not_allowed", message: `Use ${allowed.join(", ")}.` } },
    405,
    { allow: allowed.join(", ") },
  );
}

export function notFound(): never {
  throw new ApiError(404, "not_found", "That resource does not exist.");
}
