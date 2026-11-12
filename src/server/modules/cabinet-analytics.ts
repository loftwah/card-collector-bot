import type { D1Database } from "@cloudflare/workers-types";

const dayMs = 86_400_000;
const utcDay = (date: Date) => date.toISOString().slice(0, 10);

function dayTimestamp(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  const stamp = Date.parse(value);
  return Number.isFinite(stamp) && utcDay(new Date(stamp)) === value ? stamp : NaN;
}

export function cabinetReportingWindow(query: URLSearchParams, now: Date) {
  const keys = [...query.keys()];
  if (keys.some((key) => !["days", "from", "to"].includes(key) || query.getAll(key).length !== 1))
    return null;

  const today = utcDay(now);
  if (!query.has("from") && !query.has("to")) {
    const preset = query.get("days") ?? "7";
    if (!["7", "30", "90"].includes(preset)) return null;
    const days = Number(preset);
    const from = utcDay(new Date(dayTimestamp(today) - (days - 1) * dayMs));
    return { from, to: today, days, complete: false };
  }

  const from = query.get("from") ?? "";
  const to = query.get("to") ?? "";
  const days = (dayTimestamp(to) - dayTimestamp(from)) / dayMs + 1;
  if (query.has("days") || !Number.isInteger(days) || days < 1 || days > 90 || to > today)
    return null;
  return { from, to, days, complete: to < today };
}

export async function hasEmptyCabinetVisitBody(request: Request): Promise<boolean> {
  const length = request.headers.get("content-length");
  if (length !== null && length !== "0") return false;
  if (!request.body) return true;

  // A Cloudflare POST can carry a stream even when its body is empty.
  // Read at most one chunk and never consume or store a supplied payload.
  const reader = request.body.getReader();
  try {
    const first = await reader.read();
    return first.done;
  } catch {
    return false;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export function recordCabinetVisit(db: D1Database, now: Date) {
  return db
    .prepare(
      `INSERT INTO fb_public_cabinet_visits (day, visits, first_seen_at) VALUES (?, 1, ?)
       ON CONFLICT(day) DO UPDATE SET visits = visits + 1,
         first_seen_at = MIN(first_seen_at, excluded.first_seen_at)`,
    )
    .bind(utcDay(now), now.toISOString())
    .run();
}

export async function publicCabinetAnalytics(
  db: D1Database,
  period: NonNullable<ReturnType<typeof cabinetReportingWindow>>,
  now: Date,
  endpoint: string,
  revision: string | null,
) {
  // Read coverage and daily totals together so a concurrent first visit cannot
  // make a counted day appear outside coverage in the same response.
  const [first, selected] = await db.batch<{ day: string; visits: number; first_seen_at: string }>([
    db.prepare("SELECT day, first_seen_at FROM fb_public_cabinet_visits ORDER BY day LIMIT 1"),
    db
      .prepare(
        "SELECT day, visits FROM fb_public_cabinet_visits WHERE day BETWEEN ? AND ? ORDER BY day",
      )
      .bind(period.from, period.to),
  ]);
  if (!first?.success || !selected?.success) throw new Error("Cabinet counts are unavailable");
  const start = first.results[0];
  const counts = new Map(selected.results.map(({ day, visits }) => [day, visits]));
  const daily = [];
  if (start) {
    const firstDay = period.from < start.day ? start.day : period.from;
    for (let stamp = dayTimestamp(firstDay); stamp <= dayTimestamp(period.to); stamp += dayMs) {
      const date = utcDay(new Date(stamp));
      daily.push({ date, value: counts.get(date) ?? 0 });
    }
  }
  const generatedAt = now.toISOString();
  return {
    schema: "woodhouse.portfolio-analytics/1",
    project: "foilbury",
    generatedAt,
    timezone: "UTC",
    period,
    coverage: {
      startedAt: start?.first_seen_at ?? null,
      comparableFrom: start?.first_seen_at ?? null,
      through: generatedAt,
      quality: daily.length ? "partial" : "unavailable",
      limitations: [
        "Collection begins with the first accepted cabinet visit. Earlier activity is unavailable.",
        "Coverage includes participating browsers with scripting and tab storage available. Privacy settings, automated visits, and rate-limited reports are excluded.",
      ],
    },
    metrics: [
      {
        key: "cabinet_views",
        label: "Public cabinet visits",
        unit: "count",
        value: daily.length ? daily.reduce((sum, point) => sum + point.value, 0) : null,
        definition:
          "Accepted visits with a deliberate interaction in the public cabinet, counted once per browser tab every 30 minutes. Repeat visits can count again.",
        quality: daily.length ? "exact" : "unavailable",
        daily,
      },
    ],
    source: { endpoint, revision },
  };
}
