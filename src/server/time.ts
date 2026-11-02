const ZONE = "Australia/Melbourne";

const dateTimeFormatter = new Intl.DateTimeFormat("en-AU", {
  timeZone: ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const dateFormatter = new Intl.DateTimeFormat("en-AU", {
  timeZone: ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function formatDateTime(iso: string): string {
  const parts = partsFor(dateTimeFormatter, new Date(iso));
  return `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
}

export function formatDate(iso: string): string {
  const parts = partsFor(dateFormatter, new Date(iso));
  return `${parts.year}/${parts.month}/${parts.day}`;
}

export function formatDualTime(iso: string): string {
  const local = formatDateTime(iso);
  const utc = new Date(iso)
    .toISOString()
    .replace(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}).*$/, "$1/$2/$3 $4:$5 UTC");
  return `${local} Melbourne · ${utc}`;
}

export function melbourneZoneLabel(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-AU", { timeZone: ZONE, timeZoneName: "short" }).formatToParts(
    new Date(iso),
  );
  return parts.find((part) => part.type === "timeZoneName")?.value ?? "AEST";
}

function partsFor(formatter: Intl.DateTimeFormat, date: Date): Record<string, string> {
  const map: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  return map;
}

export function startOfUtcDay(iso: string): string {
  const date = new Date(iso);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString();
}

export function isPast(iso: string, now = new Date().toISOString()): boolean {
  return new Date(iso).getTime() <= new Date(now).getTime();
}
