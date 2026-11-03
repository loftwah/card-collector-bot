export type AccessArea = "admin" | "platform";

export const ACCESS_HANDOFF_QUERY = "__fb_access_handoff";
export const ACCESS_SESSION_HEADER = "x-foilbury-access-session";

export function accessPagePath(area: AccessArea): string {
  return area === "platform" ? "/platform-admin" : "/admin";
}

export function accessSessionPath(area: AccessArea): string {
  return `/api/v1/${area}/access-session`;
}

function within(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function accessAreaForPage(pathname: string): AccessArea | null {
  if (within(pathname, "/platform-admin")) return "platform";
  if (within(pathname, "/admin")) return "admin";
  return null;
}

function accessAreaForApi(pathname: string): AccessArea | null {
  if (within(pathname, "/api/v1/platform")) return "platform";
  if (within(pathname, "/api/v1/admin")) return "admin";
  return null;
}

/** A handoff may return only to a page in the same administration area. */
export function safeAccessReturnTo(value: string | null, area: AccessArea): string {
  const fallback = accessPagePath(area);
  if (!value || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(value)) return fallback;
  try {
    const url = new URL(value, "https://foilbury.invalid");
    if (url.origin !== "https://foilbury.invalid" || accessAreaForPage(url.pathname) !== area) return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}

interface AccessSessionBrowser {
  href: () => string | null;
  fetcher: typeof fetch;
  navigate: (path: string) => void;
  replaceHistory: (path: string) => void;
}

/**
 * Admit the browser to the separate API Access application before sending any
 * operational request. This sends only a GET probe; it never retries a write.
 * A URL marker bounds the top-level handoff to once, including across reloads.
 * The marker controls navigation only and is never authentication evidence.
 */
export function createAccessSessionGate(browser: AccessSessionBrowser): (path: string) => Promise<void> {
  const checks = new Map<AccessArea, Promise<void>>();

  async function check(area: AccessArea, current: URL): Promise<void> {
    let response: Response;
    try {
      response = await browser.fetcher(`${accessSessionPath(area)}?check=1`, {
        method: "GET",
        headers: { accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new Error("Administration could not be reached. Reload the page to try again.");
    }

    if (response.status === 204 && response.headers.get(ACCESS_SESSION_HEADER) === area) {
      if (current.searchParams.get(ACCESS_HANDOFF_QUERY) === area) {
        current.searchParams.delete(ACCESS_HANDOFF_QUERY);
        browser.replaceHistory(`${current.pathname}${current.search}${current.hash}`);
      }
      return;
    }

    // Manual fetch exposes an Access login redirect without following it across
    // origins. Complete that login as a top-level browser navigation instead.
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      if (current.searchParams.get(ACCESS_HANDOFF_QUERY) === area) {
        throw new Error("Sign-in could not be completed. Reload administration to try again.");
      }
      const returnTo = safeAccessReturnTo(`${current.pathname}${current.search}${current.hash}`, area);
      browser.navigate(`${accessSessionPath(area)}?returnTo=${encodeURIComponent(returnTo)}`);
      throw new Error("Finishing sign-in. Please wait.");
    }

    let message = "Administration access could not be confirmed. Reload the page to try again.";
    if (response.headers.get("content-type")?.includes("application/json")) {
      const body = await response.json().catch(() => null) as { error?: { message?: unknown } } | null;
      if (typeof body?.error?.message === "string") message = body.error.message;
    }
    throw new Error(message);
  }

  return async (path: string) => {
    const href = browser.href();
    if (!href) return;
    const current = new URL(href);
    const apiUrl = new URL(path, current);
    if (apiUrl.origin !== current.origin) return;
    const area = accessAreaForApi(apiUrl.pathname);
    if (!area || accessAreaForPage(current.pathname) !== area) return;
    let pending = checks.get(area);
    if (!pending) {
      pending = check(area, current);
      checks.set(area, pending);
    }
    await pending;
  };
}

export const ensureAccessApiSession = createAccessSessionGate({
  href: () => typeof window === "undefined" ? null : window.location.href,
  fetcher: (...args) => fetch(...args),
  navigate: (path) => window.location.replace(path),
  replaceHistory: (path) => window.history.replaceState(window.history.state, "", path),
});
