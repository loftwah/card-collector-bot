import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const integration = vi.hoisted(() => ({ gate: vi.fn() }));
vi.mock("../../src/lib/access-session", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/lib/access-session")>(),
  ensureAccessApiSession: integration.gate,
}));

import { ACCESS_HANDOFF_QUERY, ACCESS_SESSION_HEADER, createAccessSessionGate, type AccessArea } from "../../src/lib/access-session";
import { api, apiUpload } from "../../src/lib/client";

function admitted(area: AccessArea = "admin") {
  return new Response(null, { status: 204, headers: { [ACCESS_SESSION_HEADER]: area } });
}

function fixture(path = "/admin") {
  let href = `https://foilbury.example.test${path}`;
  const fetcher = vi.fn<typeof fetch>();
  const navigate = vi.fn<(path: string) => void>();
  const replaceHistory = vi.fn<(path: string) => void>((value) => { href = new URL(value, href).href; });
  const gate = createAccessSessionGate({ href: () => href, fetcher, navigate, replaceHistory });
  return { gate, fetcher, navigate, replaceHistory };
}

beforeEach(() => { vi.resetAllMocks(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("browser admission to the separate API Access application", () => {
  it.each(["admin", "platform"] as const)("probes the %s app once before parallel operational requests", async (area) => {
    const { gate, fetcher, navigate } = fixture(area === "admin" ? "/admin" : "/platform-admin");
    fetcher.mockResolvedValue(admitted(area));
    await Promise.all([gate(`/api/v1/${area}/status`), gate(`/api/v1/${area}/jobs`)]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(`/api/v1/${area}/access-session?check=1`, expect.objectContaining({ method: "GET", credentials: "same-origin", redirect: "manual", cache: "no-store" }));
    expect(navigate).not.toHaveBeenCalled();
  });

  it("converts an opaque Access redirect into one top-level handoff without fetching the operation", async () => {
    const { gate, fetcher, navigate } = fixture("/admin/catalogue?status=draft#edition");
    fetcher.mockResolvedValue({ type: "opaqueredirect", status: 0, headers: new Headers() } as Response);
    const results = await Promise.allSettled([gate("/api/v1/admin/cards"), gate("/api/v1/admin/taxonomy")]);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledExactlyOnceWith(`/api/v1/admin/access-session?returnTo=${encodeURIComponent("/admin/catalogue?status=draft#edition")}`);
  });

  it("stops if API admission still redirects after the handoff", async () => {
    const { gate, fetcher, navigate } = fixture(`/platform-admin/accounts?${ACCESS_HANDOFF_QUERY}=platform`);
    fetcher.mockResolvedValue({ type: "opaqueredirect", status: 0, headers: new Headers() } as Response);
    await expect(gate("/api/v1/platform/accounts")).rejects.toThrow(/Sign-in could not be completed/);
    await expect(gate("/api/v1/platform/overview")).rejects.toThrow(/Sign-in could not be completed/);
    expect(navigate).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("removes the loop marker only after API admission succeeds", async () => {
    const { gate, fetcher, replaceHistory } = fixture(`/admin/catalogue?status=draft&${ACCESS_HANDOFF_QUERY}=admin#edition`);
    fetcher.mockResolvedValue(admitted());
    await gate("/api/v1/admin/cards");
    expect(replaceHistory).toHaveBeenCalledExactlyOnceWith("/admin/catalogue?status=draft#edition");
  });

  it("shows identity or role rejection without trying to navigate around it", async () => {
    const { gate, fetcher, navigate } = fixture();
    fetcher.mockResolvedValue(new Response(JSON.stringify({ error: { message: "This browser is signed in as someone else." } }), { status: 403, headers: { "content-type": "application/json" } }));
    await expect(gate("/api/v1/admin/status")).rejects.toThrow(/someone else/);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("does not mistake a network failure or login HTML for successful admission", async () => {
    const network = fixture();
    network.fetcher.mockRejectedValue(new TypeError("Network unavailable"));
    await expect(network.gate("/api/v1/admin/status")).rejects.toThrow(/could not be reached/);
    expect(network.navigate).not.toHaveBeenCalled();
    const html = fixture();
    html.fetcher.mockResolvedValue(new Response("<html>Sign in</html>", { status: 200, headers: { "content-type": "text/html" } }));
    await expect(html.gate("/api/v1/admin/status")).rejects.toThrow(/could not be confirmed/);
    expect(html.navigate).not.toHaveBeenCalled();
  });

  it("does not bootstrap unrelated pages, external requests, or another administration area", async () => {
    const publicPage = fixture("/play");
    await publicPage.gate("/api/v1/admin/status");
    expect(publicPage.fetcher).not.toHaveBeenCalled();
    const admin = fixture();
    await admin.gate("https://other.example/api/v1/admin/status");
    await admin.gate("/api/v1/platform/overview");
    await admin.gate("/api/v1/collections");
    expect(admin.fetcher).not.toHaveBeenCalled();
  });
});

describe("operational requests wait for admission without being retried", () => {
  it("does not send a mutation or upload when admission starts a browser handoff", async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    integration.gate.mockRejectedValue(new Error("Finishing sign-in. Please wait."));
    await expect(api("/api/v1/admin/catalogue/publish", { method: "POST", body: {} })).rejects.toThrow(/Finishing sign-in/);
    await expect(apiUpload("/api/v1/admin/assets", new FormData())).rejects.toThrow(/Finishing sign-in/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("sends a mutation exactly once after admission succeeds and does not retry its failure", async () => {
    let allow!: () => void;
    integration.gate.mockReturnValue(new Promise<void>((resolve) => { allow = resolve; }));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { code: "conflict", message: "Already changed." } }), { status: 409 }));
    vi.stubGlobal("fetch", fetcher);
    vi.stubGlobal("document", { querySelector: () => ({ content: "csrf-test" }) });
    const result = api("/api/v1/admin/catalogue/publish", { method: "POST", body: {} });
    expect(fetcher).not.toHaveBeenCalled();
    allow();
    await expect(result).rejects.toMatchObject({ status: 409, code: "conflict" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("/api/v1/admin/catalogue/publish", expect.objectContaining({ method: "POST", body: "{}" }));
  });
});
