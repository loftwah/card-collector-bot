// EmDash reports loader failures as results as well as thrown exceptions.
// Keep those failures distinct from an empty collection or a missing entry.
export async function readJournalCollection<T>(query: () => Promise<{ entries: T[]; error?: unknown }>) {
  try {
    const result = await query();
    return result.error ? { ok: false as const, entries: [] } : { ok: true as const, entries: result.entries };
  } catch {
    return { ok: false as const, entries: [] };
  }
}

export async function readJournalEntry<T>(query: () => Promise<{ entry: T | null; error?: unknown }>) {
  try {
    const result = await query();
    return result.error ? { ok: false as const, entry: null } : { ok: true as const, entry: result.entry };
  } catch {
    return { ok: false as const, entry: null };
  }
}
