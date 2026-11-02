import { describe, expect, it } from "vitest";
import { nextDailyEligibleAt } from "../../src/server/modules/daily-time";

describe("daily entitlement boundary", () => {
  it("reports the later of the cooldown and the next UTC midnight", () => {
    expect(nextDailyEligibleAt(new Date("2026-11-02T10:00:00.000Z"), 72_000)).toBe("2026-11-03T06:00:00.000Z");
    expect(nextDailyEligibleAt(new Date("2026-11-02T23:30:00.000Z"), 72_000)).toBe("2026-11-03T19:30:00.000Z");
    expect(nextDailyEligibleAt(new Date("2026-11-02T00:01:00.000Z"), 72_000)).toBe("2026-11-03T00:00:00.000Z");
  });
});
