import { describe, expect, it } from "vitest";
import { assertTransition, canTransition, nextStates } from "../../src/server/state";

describe("workflow transitions", () => {
  it("allows the valid collection and membership paths", () => {
    expect(canTransition("collection", "draft", "published")).toBe(true);
    expect(canTransition("collection", "published", "archived")).toBe(true);
    expect(canTransition("collection", "archived", "draft")).toBe(true);
    expect(canTransition("membership", "active", "suspended")).toBe(true);
    expect(canTransition("membership", "suspended", "active")).toBe(true);
    expect(canTransition("membership", "revoked", "active")).toBe(true);
  });

  it("rejects invalid collection and membership paths", () => {
    expect(() => assertTransition("collection", "archived", "published")).toThrow("cannot move");
    expect(() => assertTransition("membership", "suspended", "invited")).toThrow("cannot move");
    expect(() => assertTransition("membership", "revoked", "suspended")).toThrow("cannot move");
  });

  it("allows a retired card to be restored but not a draft to retire directly", () => {
    expect(canTransition("card", "draft", "published")).toBe(true);
    expect(canTransition("card", "published", "retired")).toBe(true);
    expect(canTransition("card", "retired", "published")).toBe(true);
    expect(canTransition("card", "retired", "draft")).toBe(true);
    expect(() => assertTransition("card", "draft", "retired")).toThrow("cannot move");
  });

  it("models retryable render jobs and non-retryable success", () => {
    expect(nextStates("render_job", "pending")).toEqual(["running", "cancelled"]);
    expect(canTransition("render_job", "running", "failed")).toBe(true);
    expect(canTransition("render_job", "failed", "pending")).toBe(true);
    expect(canTransition("render_job", "succeeded", "pending")).toBe(false);
  });

  it("separates a lost draw response from a new draw", () => {
    expect(canTransition("draw", "ready", "submitting")).toBe(true);
    expect(canTransition("draw", "submitting", "unknown")).toBe(true);
    expect(canTransition("draw", "unknown", "committed")).toBe(true);
    expect(canTransition("draw", "committed", "ready")).toBe(false);
    expect(canTransition("draw", "unknown", "submitting")).toBe(false);
  });

  it("keeps gift delivery retry-safe but terminal success terminal", () => {
    expect(canTransition("gift_campaign", "previewed", "sending")).toBe(true);
    expect(canTransition("gift_campaign", "sending", "partial")).toBe(true);
    expect(canTransition("gift_campaign", "partial", "sending")).toBe(true);
    expect(canTransition("gift_campaign", "completed", "sending")).toBe(false);
    expect(canTransition("gift_campaign", "cancelled", "sending")).toBe(false);
  });
});
