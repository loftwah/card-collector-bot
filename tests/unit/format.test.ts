import { describe, expect, it } from "vitest";
import { newId, token, canonicalJson, sha256Hex } from "../../src/server/ids";
import { formatDate, formatDateTime, formatDualTime } from "../../src/server/time";

describe("machine identifiers", () => {
  it("generates unique prefixed ids", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId("test")));
    expect(ids.size).toBe(1000);
    expect([...ids][0]).toMatch(/^test_[a-z0-9]+$/);
  });

  it("generates unique opaque tokens", () => {
    const values = new Set(Array.from({ length: 100 }, () => token("fba")));
    expect(values.size).toBe(100);
  });

  it("canonicalises object keys for request digests", async () => {
    const a = await sha256Hex(canonicalJson({ b: 2, a: 1 }));
    const b = await sha256Hex(canonicalJson({ a: 1, b: 2 }));
    expect(a).toBe(b);
  });
});

describe("Melbourne display time", () => {
  it("formats dates as YYYY/MM/DD", () => {
    expect(formatDate("2026-11-02T07:37:00.000Z")).toBe("2026/11/02");
    expect(formatDateTime("2026-11-02T07:37:00.000Z")).toBe("2026/11/02 18:37");
  });

  it("includes the UTC record alongside Melbourne time", () => {
    const value = formatDualTime("2026-11-02T07:37:00.000Z");
    expect(value).toContain("2026/11/02 18:37");
    expect(value).toContain("2026/11/02 07:37 UTC");
  });

  it("handles daylight saving rather than a fixed offset", () => {
    expect(formatDateTime("2026-01-15T00:00:00.000Z")).toBe("2026/01/15 11:00");
    expect(formatDateTime("2026-07-15T00:00:00.000Z")).toBe("2026/07/15 10:00");
  });
});
