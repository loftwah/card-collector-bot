function nextUtcMidnight(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1, 0, 0, 0, 0);
}

/**
 * The entitlement is once per UTC day and also has a cooldown. Report the later
 * boundary so a late-evening claim cannot show a time that the period key will
 * still reject.
 */
export function nextDailyEligibleAt(now: Date, cooldownSeconds: number, lastClaimAt?: string): string {
  const baseline = lastClaimAt ? new Date(lastClaimAt) : now;
  const cooldown = baseline.getTime() + cooldownSeconds * 1000;
  return new Date(Math.max(cooldown, nextUtcMidnight(baseline))).toISOString();
}
