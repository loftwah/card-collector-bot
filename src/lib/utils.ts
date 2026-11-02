import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDateTime(iso: string): string {
  if (!iso) return "—";
  const parts = dateParts(iso, { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${parts.year}/${parts.month}/${parts.day} ${parts.hour ?? "00"}:${parts.minute ?? "00"}`;
}

export function formatDate(iso: string): string {
  if (!iso) return "—";
  const parts = dateParts(iso);
  return `${parts.year}/${parts.month}/${parts.day}`;
}

function dateParts(iso: string, extra: Intl.DateTimeFormatOptions = {}): Record<string, string> {
  const formatter = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Melbourne",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...extra,
  });
  const out: Record<string, string> = {};
  for (const part of formatter.formatToParts(new Date(iso))) if (part.type !== "literal") out[part.type] = part.value;
  return out;
}

export function formatDual(iso: string): string {
  if (!iso) return "—";
  const local = formatDateTime(iso);
  const utc = new Date(iso).toISOString().replace(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}).*$/, "$1/$2/$3 $4:$5 UTC");
  return `${local} Melbourne · ${utc}`;
}

export function melbourneZone(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Melbourne", timeZoneName: "short" }).formatToParts(new Date(iso));
  return parts.find((part) => part.type === "timeZoneName")?.value ?? "AEST";
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function pct(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

export function titleCase(value: string): string {
  return value
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .replace(/\bAnd\b/g, "and");
}

export function statusTone(status: string): string {
  if (["active", "published", "complete", "succeeded", "delivered"].includes(status)) return "green";
  if (["draft", "pending", "running"].includes(status)) return "brass";
  if (["failed", "revoked", "retired", "cancelled"].includes(status)) return "oxblood";
  return "muted";
}

/** Player-facing finish language: the legacy diamond material reads as Holographic. */
export function displayFinish(name: string | null | undefined, material?: string | null, effect?: string | null): string {
  if (material === "diamond" && (!effect || effect === "none")) return "Holographic";
  return name ?? "Plain";
}
