/** A dedicated rollback build, not a runtime flag on a legacy Worker. */
export function isQuarantinedDiscordPath(pathname: string): boolean {
  let path=pathname;
  try {
    // Reject unresolved encodings rather than depend on the downstream router's
    // number of decoding passes during the emergency rollback.
    for(let i=0;i<4 && path.includes('%');i++) path=decodeURIComponent(path);
  } catch {return true;}
  if(path.includes('%')) return true;
  path=path.replace(/\/{2,}/g,'/');
  return path === '/api/discord' || path.startsWith('/api/discord/') ||
    path === '/auth/discord' || path.startsWith('/auth/discord/');
}

export function discordQuarantineResponse(): Response {
  return new Response('Discord is temporarily unavailable. Please try again later.', {
    status: 503,
    headers: {'content-type':'text/plain; charset=utf-8','cache-control':'no-store','retry-after':'300'},
  });
}

export function withDiscordQuarantine<TEnv>(delegate: ExportedHandler<TEnv>): ExportedHandler<TEnv> {
  return {
    ...delegate,
    async fetch(request, env, context) {
      if (isQuarantinedDiscordPath(new URL(request.url).pathname)) return discordQuarantineResponse();
      if (!delegate.fetch) return new Response('Unavailable', { status: 503 });
      return delegate.fetch(request, env, context);
    },
  };
}
