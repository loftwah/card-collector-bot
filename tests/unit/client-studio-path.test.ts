import { afterEach, describe, expect, it, vi } from "vitest";
import { apiPath } from "../../src/lib/client";

describe("Studio API routing", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the scoped endpoint on a Studio page without relying on an inline script", () => {
    vi.stubGlobal("window", { location: { pathname: "/studio/collections" } });
    expect(apiPath("/api/v1/admin/collections")).toBe("/api/v1/studio/collections");
    expect(apiPath("/api/v1/cards")).toBe("/api/v1/cards");
  });

  it("keeps platform and similarly named pages on their original routes", () => {
    vi.stubGlobal("window", { location: { pathname: "/studio-other" } });
    expect(apiPath("/api/v1/admin/collections")).toBe("/api/v1/admin/collections");
  });
});
