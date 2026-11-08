/**
 * Explicit, typed transition tables for the workflows that matter most.
 *
 * These are deliberately small functions, not a state-machine framework. They
 * make invalid transitions fail loudly in tests and in services, while the
 * database constraints and idempotency records remain the real authority.
 */
import { ApiError } from "./context";

export type Machine =
  | "card"
  | "collection"
  | "membership"
  | "gift_campaign"
  | "render_job"
  | "draw"
  | "import";

const TRANSITIONS: Record<Machine, Record<string, readonly string[]>> = {
  card: {
    draft: ["published"],
    published: ["draft", "retired"],
    retired: ["draft", "published"],
  },
  collection: {
    draft: ["published", "archived"],
    published: ["draft", "archived"],
    archived: ["draft"],
  },
  membership: {
    invited: ["active", "revoked"],
    active: ["suspended", "revoked"],
    suspended: ["active", "revoked"],
    revoked: ["active"],
  },
  gift_campaign: {
    previewed: ["sending", "cancelled"],
    sending: ["completed", "partial", "failed"],
    partial: ["sending", "completed"],
    failed: ["sending"],
    completed: ["completed"],
    cancelled: [],
  },
  render_job: {
    pending: ["running", "cancelled"],
    running: ["succeeded", "failed", "cancelled"],
    failed: ["pending", "running"],
    succeeded: [],
    cancelled: [],
  },
  draw: {
    ready: ["submitting"],
    submitting: ["committed", "unknown"],
    unknown: ["committed", "failed"],
    committed: ["revealed"],
    revealed: [],
    failed: [],
  },
  import: {
    previewed: ["running"],
    running: ["complete", "partial", "failed"],
    partial: ["running"],
    failed: ["running"],
    complete: [],
  },
};

export function canTransition(machine: Machine, from: string, to: string): boolean {
  return (TRANSITIONS[machine][from] ?? []).includes(to);
}

export function assertTransition(machine: Machine, from: string, to: string): void {
  if (!canTransition(machine, from, to)) {
    throw new ApiError(409, "invalid_transition", `${machine} cannot move from ${from} to ${to}.`);
  }
}

export function nextStates(machine: Machine, from: string): readonly string[] {
  return TRANSITIONS[machine][from] ?? [];
}
