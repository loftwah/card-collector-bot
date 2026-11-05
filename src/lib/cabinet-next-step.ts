type CabinetStepInput = {
  canClaim: boolean;
  dailyReward: number;
  nextEligible: string | null;
  balance: number;
  pool: { price: number; eligible_count: number } | null;
};

/** Keep the recommendation aligned with the state actually returned by the draw service. */
export function cabinetNextStep({
  canClaim,
  dailyReward,
  nextEligible,
  balance,
  pool,
}: CabinetStepInput) {
  if (canClaim && dailyReward > 0)
    return {
      kind: "claim" as const,
      title: "Claim your daily Foil",
      body: `✦ ${dailyReward} is ready to claim.`,
      href: null,
      action: null,
    };
  if (!pool)
    return {
      kind: "unavailable" as const,
      title: "Check the draw room",
      body: "The capsule preview is unavailable. Visit the draw room to check what you can open.",
      href: "/play/draw",
      action: "Visit draw room",
    };
  if (pool.eligible_count === 0)
    return {
      kind: "empty" as const,
      title: "Find a capsule",
      body: "There are no cards available in this capsule. Check the draw room for other options.",
      href: "/play/draw",
      action: "Find a capsule",
    };
  if (balance >= pool.price)
    return {
      kind: "draw" as const,
      title: "Open a capsule",
      body: `${pool.eligible_count} eligible finishes · ✦ ${pool.price}. Odds are shown before anything leaves your wallet.`,
      href: "/play/draw",
      action: "See capsules",
    };
  return {
    kind: "wait" as const,
    title: "Explore the draw room",
    body:
      dailyReward > 0 && nextEligible
        ? `This capsule costs more than your balance. Check other capsules, or claim your next allowance ${nextEligible}.`
        : "This capsule costs more than your balance. Check the draw room for other options.",
    href: "/play/draw",
    action: "See capsules",
  };
}
