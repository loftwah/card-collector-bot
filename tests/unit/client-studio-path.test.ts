import { afterEach, describe, expect, it, vi } from "vitest";
import { apiPath } from "../../src/lib/client";

describe("Studio API routing", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the scoped endpoint on a Studio page without relying on an inline script", () => {
    vi.stubGlobal("window", { location: { pathname: "/studio/collections" } });
    expect(apiPath("/api/v1/admin/collections")).toBe("/api/v1/studio/collections");
    expect(apiPath("/api/v1/cards")).toBe("/api/v1/cards");
  });

  it("handles the Studio root and only rewrites the admin route segment", () => {
    vi.stubGlobal("window", { location: { pathname: "/studio" } });
    expect(apiPath("/api/v1/admin/collections")).toBe("/api/v1/studio/collections");
    expect(apiPath("/api/v1/administrator/collections")).toBe("/api/v1/administrator/collections");
    expect(apiPath("/api/v1/admin")).toBe("/api/v1/admin");
  });

  it("keeps platform and similarly named pages on their original routes", () => {
    vi.stubGlobal("window", { location: { pathname: "/studio-other" } });
    expect(apiPath("/api/v1/admin/collections")).toBe("/api/v1/admin/collections");
    vi.stubGlobal("window", { location: { pathname: "/platform-admin" } });
    expect(apiPath("/api/v1/admin/collections")).toBe("/api/v1/admin/collections");
  });

  it("keeps the existing explicit Studio flag for embedded callers", () => {
    vi.stubGlobal("window", { location: { pathname: "/embedded" }, __FOILBURY_STUDIO__: true });
    expect(apiPath("/api/v1/admin/collections")).toBe("/api/v1/studio/collections");
  });
});
