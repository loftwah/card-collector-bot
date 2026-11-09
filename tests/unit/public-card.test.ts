import { describe, expect, it } from "vitest";
import { publicCard } from "../../src/server/api/public";
import type { CardView } from "../../src/server/modules/catalogue";

describe("public card provenance", () => {
  it("retains public work metadata without serializing private reference URLs or paths", () => {
    const card = {
      id: "fixture",
      slug: "fixture",
      name: "Fixture",
      description: "Public description",
      source_work: "Public work",
      source_refs_json: JSON.stringify([
        "https://private.example/secret",
        "/Users/private/source.png",
      ]),
      attributes_json: "[]",
      tags: [],
      collections: [],
      editions: [],
      sets: [],
    } as unknown as CardView;
    const json = JSON.stringify(publicCard(card));
    expect(json).toContain("Public work");
    expect(json).not.toContain("source_refs");
    expect(json).not.toContain("private.example");
    expect(json).not.toContain("/Users/private");
  });
});
