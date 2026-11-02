import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../../src/server/password";

describe("local password hashing", () => {
  it("verifies the correct password and rejects another", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(stored.startsWith("pbkdf2_sha256$100000$")).toBe(true);
    expect(await verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(await verifyPassword("wrong password entirely", stored)).toBe(false);
  });

  it("uses a unique salt per hash", async () => {
    const first = await hashPassword("same password twice");
    const second = await hashPassword("same password twice");
    expect(first).not.toBe(second);
  });
});
