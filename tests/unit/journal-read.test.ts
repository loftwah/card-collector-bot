import { describe, expect, it } from "vitest";
import { readJournalCollection, readJournalEntry } from "../../src/server/modules/journal-read";

describe("EmDash journal reads", () => {
  it("distinguishes loader failures from an empty published collection", async () => {
    expect(await readJournalCollection(async () => ({ entries: [], error: new Error("private database detail") })))
      .toEqual({ ok: false, entries: [] });
    expect(await readJournalCollection(async () => ({ entries: [] }))).toEqual({ ok: true, entries: [] });
    expect(await readJournalCollection(async () => { throw new Error("private detail"); })).toEqual({ ok: false, entries: [] });
    expect(await readJournalCollection(async () => ({ entries: [{ id: "published" }] })))
      .toEqual({ ok: true, entries: [{ id: "published" }] });
  });

  it("distinguishes an unavailable article from a missing one", async () => {
    expect(await readJournalEntry(async () => ({ entry: null, error: new Error("private detail") })))
      .toEqual({ ok: false, entry: null });
    expect(await readJournalEntry(async () => ({ entry: null }))).toEqual({ ok: true, entry: null });
    expect(await readJournalEntry(async () => ({ entry: { id: "published" } })))
      .toEqual({ ok: true, entry: { id: "published" } });
  });
});
