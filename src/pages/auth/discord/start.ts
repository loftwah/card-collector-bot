import type { APIRoute } from "astro";
import { runtimeEnv } from "../../../server/context";
import { readConfig } from "../../../server/config";
import { base64url, token } from "../../../server/ids";

export const prerender = false;

function challengeFor(verifier: string): Promise<string> {
  return crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(verifier))
    .then((digest) => base64url(new Uint8Array(digest)));
}

function safeNext(value: string | null): string {
  return value && value.startsWith("/") && !value.startsWith("//") ? value : "/play";
}

export const GET: APIRoute = async ({ request, cookies, redirect }) => {
  const raw = runtimeEnv();
  const config = readConfig(raw);
  const clientId = raw.DISCORD_CLIENT_ID?.trim() || raw.DISCORD_APPLICATION_ID?.trim();
  if (!clientId || !raw.DISCORD_CLIENT_SECRET?.trim()) {
    return new Response("Discord sign-in is not configured.", { status: 503 });
  }
  const redirectUri = raw.DISCORD_REDIRECT_URI?.trim() || `${config.publicOrigin}/auth/discord/callback`;
  const state = token("oauthstate");
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const next = safeNext(new URL(request.url).searchParams.get("next"));
  const cookieOptions = {
    path: "/auth/discord",
    httpOnly: true,
    sameSite: "lax" as const,
    secure: config.environment === "production",
    maxAge: 600,
  };
  cookies.set("fb_oauth_state", state, cookieOptions);
  cookies.set("fb_oauth_verifier", verifier, cookieOptions);
  cookies.set("fb_oauth_next", next, cookieOptions);

  const authorize = new URL("https://discord.com/oauth2/authorize");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("scope", "identify");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("code_challenge", await challengeFor(verifier));
  authorize.searchParams.set("code_challenge_method", "S256");
  return redirect(authorize.toString());
};
