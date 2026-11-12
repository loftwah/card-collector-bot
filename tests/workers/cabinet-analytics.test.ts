import { expect, it } from "vitest";
import { bootstrap, runtime } from "./helpers";
import {
  cabinetReportingWindow,
  publicCabinetAnalytics,
  recordCabinetVisit,
} from "../../src/server/modules/cabinet-analytics";

it("preserves unknown coverage and counts only accepted visits on UTC days", async () => {
  await bootstrap();
  const now = new Date("2026-11-12T09:00:00Z");
  const window = cabinetReportingWindow(new URLSearchParams("from=2026-11-09&to=2026-11-12"), now)!;
  const report = () =>
    publicCabinetAnalytics(
      runtime.DB,
      window,
      now,
      "https://foilbury.example/api/portfolio-analytics",
      null,
    );
  expect((await report()).metrics[0]).toMatchObject({ value: null, quality: "unavailable" });

  const firstVisit = new Date("2026-11-10T23:59:59Z");
  await Promise.all([
    recordCabinetVisit(runtime.DB, firstVisit),
    recordCabinetVisit(runtime.DB, new Date("2026-11-12T01:00:00Z")),
    recordCabinetVisit(runtime.DB, new Date("2026-11-12T08:00:00Z")),
  ]);
  expect(await report()).toMatchObject({
    project: "foilbury",
    period: { complete: false, days: 4 },
    coverage: { startedAt: firstVisit.toISOString() },
    metrics: [
      {
        key: "cabinet_views",
        value: 3,
        daily: [
          { date: "2026-11-10", value: 1 },
          { date: "2026-11-11", value: 0 },
          { date: "2026-11-12", value: 2 },
        ],
      },
    ],
  });
  for (const query of [
    "days=7&days=30",
    "from=2026-02-30&to=2026-03-05",
    "days=90&from=2026-11-10&to=2026-11-11",
    "from=2026-11-10&to=2026-11-13",
  ]) {
    expect(cabinetReportingWindow(new URLSearchParams(query), now)).toBeNull();
  }
});
