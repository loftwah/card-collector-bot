/** Read published journal data without treating a CMS error as an empty list. */
export async function readJournalFeed(load) {
  try {
    const result = await load();
    if (result.error) return { entries: [], error: true };
    return {
      entries: (result.entries ?? []).map((entry) => ({
        id: entry.id,
        slug: entry.slug ?? entry.id,
        title: entry.data.title ?? 'Untitled',
        excerpt: entry.data.excerpt ?? '',
        publishedAt: entry.data.publishedAt ?? null,
      })),
      error: false,
    };
  } catch {
    return { entries: [], error: true };
  }
}
