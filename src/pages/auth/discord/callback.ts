import type { APIRoute } from "astro";
import { buildContext, runtimeEnv } from "../../../server/context";
import { createSession } from "../../../server/modules/identity";
import { ensureDiscordPlayer,linkDiscordIdentity } from "../../../server/discord/context";
import { beginVerifiedDiscordRecovery,discordRecoveryEnabled } from "../../../server/discord/recovery";
import type { DiscordEnv, DiscordUser } from "../../../server/discord/types";
import { sessionCookies } from "../../../server/api/helpers";

export const prerender = false;

function cookiesForClear(secure: boolean): string[] {
  const base = `Path=/auth/discord; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
  return ["fb_oauth_state=; " + base, "fb_oauth_verifier=; " + base, "fb_oauth_next=; " + base, "fb_oauth_recovery=; " + base];
}

function safeNext(value: string | undefined): string {
  return value && value.startsWith("/") && !value.startsWith("//") ? value : "/play";
}

function redirectWithCookies(location: string, cookies: string[]): Response {
  const headers = new Headers({ location, "cache-control": "no-store", "referrer-policy": "no-referrer" });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

export const GET: APIRoute = async ({ request, cookies }) => {
  const raw = runtimeEnv() as unknown as DiscordEnv;
  const secure = raw.FOILBURY_ENV === "production";
  const fail = (code: string) =>
    redirectWithCookies(`/login?error=${encodeURIComponent(code)}`, cookiesForClear(secure));

  const state = cookies.get("fb_oauth_state")?.value;
  const verifier = cookies.get("fb_oauth_verifier")?.value;
  const next = safeNext(cookies.get("fb_oauth_next")?.value);
  const recovery = cookies.get("fb_oauth_recovery")?.value === "1";
  const query = new URL(request.url).searchParams;

  if (query.get("error") || !query.get("code")) return fail("discord_cancelled");
  if (!state || !verifier || query.get("state") !== state) return fail("discord_state");

  const clientId = raw.DISCORD_CLIENT_ID?.trim() || raw.DISCORD_APPLICATION_ID?.trim();
  const clientSecret = raw.DISCORD_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return fail("discord_not_configured");
  const redirectUri = raw.DISCORD_REDIRECT_URI?.trim() || `${new URL(request.url).origin}/auth/discord/callback`;

  let tokenResponse: Response;
  try {
    tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "authorization_code",
        code: query.get("code")!,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
    });
  } catch {
    return fail("discord_exchange");
  }
  if (!tokenResponse.ok) return fail("discord_exchange");
  const token = (await tokenResponse.json().catch(() => null)) as { access_token?: string } | null;
  if (!token?.access_token) return fail("discord_exchange");

  let discordUser: DiscordUser;
  try {
    const profile = await fetch("https://discord.com/api/users/@me", {
      headers: { authorization: `Bearer ${token.access_token}` },
    });
    if (!profile.ok) return fail("discord_profile");
    discordUser = (await profile.json()) as DiscordUser;
  } catch {
    return fail("discord_profile");
  }
  if (!discordUser?.id || !/^\d{15,22}$/.test(discordUser.id)) return fail("discord_profile");

  try {
    const ctx = await buildContext(request);
    let user = ctx.user;
    if (recovery) {
      if (!user || !discordRecoveryEnabled(raw)) return fail("discord_link");
      const challenge=await beginVerifiedDiscordRecovery(ctx,state,discordUser);
      return redirectWithCookies(`/auth/discord/recovery/confirm?challenge=${encodeURIComponent(challenge)}`,cookiesForClear(secure));
    } else if (user && discordRecoveryEnabled(raw)) {
      // Account linking is a sensitive, deliberate action, not a side effect
      // of an ordinary Discord sign-in callback.
      return redirectWithCookies('/auth/discord/recovery?error=explicit',cookiesForClear(secure));
    } else if (user) {
      // Preserve the existing sign-in/link journey while the explicit recovery
      // flow is disabled. The binding schema and the rollout remain held.
      await linkDiscordIdentity(raw,ctx.tenant,user,discordUser);
    } else {
      const player = await ensureDiscordPlayer(raw, ctx.tenant, discordUser);
      user = player.user;
    }
    const session = await createSession(ctx.db, ctx.tenant, user, {
      authMethod: "discord",
      assurance: "discord",
      requireActiveMembership: true,
      requireDiscordIdentity: discordUser.id,
      userAgent: request.headers.get("user-agent"),
    });
    const headers = new Headers({ location: next, "cache-control": "no-store" });
    for (const cookie of [...cookiesForClear(secure), ...sessionCookies(session.token, session.csrf, session.expiresAt, secure)]) {
      headers.append("set-cookie", cookie);
    }
    return new Response(null, { status: 302, headers });
  } catch {
    return fail("discord_link");
  }
};
