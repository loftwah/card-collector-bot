import { describe, expect, it } from "vitest";
import { cabinetNextStep } from "../../src/lib/cabinet-next-step";

const base = { canClaim: false, dailyReward: 480, nextEligible: "tomorrow", balance: 500 };

describe("cabinet next step", () => {
  it("offers the allowance when it is ready", () => {
    expect(cabinetNextStep({ ...base, canClaim: true, pool: null }).kind).toBe("claim");
  });

  it("does not confuse an unavailable capsule preview with a lack of Foil", () => {
    const step = cabinetNextStep({ ...base, pool: null });
    expect(step.kind).toBe("unavailable");
    expect(step.href).toBe("/play/draw");
  });

  it("does not suggest opening an empty capsule", () => {
    const step = cabinetNextStep({ ...base, pool: { price: 80, eligible_count: 0 } });
    expect(step.kind).toBe("empty");
    expect(step.href).toBe("/play/draw");
  });

  it("distinguishes a playable capsule from insufficient Foil", () => {
    const pool = { price: 80, eligible_count: 3 };
    expect(cabinetNextStep({ ...base, pool }).kind).toBe("draw");
    const step = cabinetNextStep({ ...base, balance: 79, pool });
    expect(step.kind).toBe("wait");
    expect(step.href).toBe("/play/draw");
  });

  it("does not recommend a disabled zero-Foil allowance", () => {
    expect(
      cabinetNextStep({
        ...base,
        dailyReward: 0,
        canClaim: true,
        pool: { price: 80, eligible_count: 3 },
      }).kind,
    ).toBe("draw");
    expect(
      cabinetNextStep({
        ...base,
        dailyReward: 0,
        canClaim: true,
        balance: 0,
        pool: { price: 80, eligible_count: 3 },
      }).body,
    ).not.toContain("allowance");
  });
});
