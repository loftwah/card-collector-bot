#!/usr/bin/env node
/**
 * Assisted Discord acceptance runner.
 *
 * It prepares a bounded acceptance session, correlates real interactions with
 * durable receipts and reports which layer established each fact:
 *
 *   api                  -> status/build read-back
 *   database             -> D1 interaction, draw, ledger, instance, claim, share
 *   actual client        -> never claimed by this runner without an observer
 *   observer/attestation -> a hand-authored spectator declaration, not proof
 *
 * It does not impersonate a user, self-bot, harvest tokens or post messages.
 *
 *   node scripts/discord/assisted-acceptance.mjs --prepare \
 *     --guild <guild-id> --channel <channel-id> --actor <discord-user-id>
 *   node scripts/discord/assisted-acceptance.mjs --verify <interaction-id> \
 *     --session <session.json> [--case <case-id>]
 *   node scripts/discord/assisted-acceptance.mjs --watch --session <session.json> --minutes 10
 *   node scripts/discord/assisted-acceptance.mjs --spectator <evidence.json> --session <session.json>
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { ROOT } from "../lib/local.mjs";

export const SESSION_SCHEMA_VERSION = 1;
export const BUILD_HEADER = "x-foilbury-build";
export const OUTPUT_DIR = path.join(ROOT, ".foilbury/evidence/discord-assisted");
export const DEFAULT_WATCH_MINUTES = 10;
export const MAX_WATCH_MINUTES = 60;
export const SESSION_ID_PREFIX = "dacc";
export const PRIVATE_VISIBILITY = ["private", "private_fallback"];

const READ_ONLY_COMMANDS = new Set([
  "help",
  "tour",
  "packs",
  "profile",
  "collection",
  "achievements",
  "card",
  "npc",
]);

const COMPONENT_READ_ONLY = new Map([
  ["foilbury:collection", "collection"],
  ["foilbury:packs", "packs"],
  ["foilbury:help", "help"],
  ["foilbury:profile", "profile"],
  ["foilbury:achievements", "achievements"],
]);

const API_ERROR_DENYLIST = new Set([
  "",
  "{}",
  "error",
  "failed",
  "failure",
  "unknown",
  "unknown_error",
  "internal_error",
  "unhandled_error",
]);

export const DEFAULT_EXPECTED_CASES = Object.freeze([
  {
    case_id: "help",
    command: "help",
    label: "/foilbury help",
    kind: "read_only",
  },
  {
    case_id: "tour",
    command: "tour",
    label: "/foilbury tour and its read-only buttons",
    kind: "read_only",
  },
  {
    case_id: "packs",
    command: "packs",
    label: "/foilbury packs",
    kind: "read_only",
  },
  {
    case_id: "profile",
    command: "profile",
    label: "/foilbury profile",
    kind: "read_only",
  },
  {
    case_id: "collection",
    command: "collection",
    label: "/foilbury collection",
    kind: "read_only",
  },
  {
    case_id: "achievements",
    command: "achievements",
    label: "/foilbury achievements",
    kind: "read_only",
  },
  {
    case_id: "daily",
    command: "daily",
    label: "/foilbury daily",
    kind: "claim",
    claim_type: "daily",
  },
  {
    case_id: "mission",
    command: "mission",
    label: "one daily mission claim",
    kind: "claim",
    claim_type: "mission",
  },
  {
    case_id: "open",
    command: "open",
    label: "/foilbury open or an open component",
    kind: "open",
  },
  {
    case_id: "share",
    command: "share",
    label: "one explicit tour share",
    kind: "share",
  },
]);

function isoNow() {
  return new Date().toISOString();
}

function toIso(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number") {
    return Number.isFinite(value) ? new Date(value).toISOString() : null;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function toTime(value) {
  const iso = toIso(value);
  return iso === null ? null : Date.parse(iso);
}

function inWindow(value, window) {
  const time = toTime(value);
  const start = toTime(window?.start);
  const end = toTime(window?.end);
  return time !== null && start !== null && end !== null && time >= start && time <= end;
}

function isSnowflake(value) {
  return typeof value === "string" && /^\d{15,22}$/.test(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function sqlString(value) {
  return `'${String(value ?? "").replaceAll("'", "''")}'`;
}

function text(value) {
  return typeof value === "string" ? value : "";
}

export function isApiErrorCode(value) {
  if (typeof value !== "string") return false;
  const code = value.trim();
  if (API_ERROR_DENYLIST.has(code)) return false;
  return /^[a-z][a-z0-9_]{2,80}$/.test(code);
}

export function filterDrawLedger(ledger, drawId) {
  if (!drawId || !Array.isArray(ledger)) return [];
  return ledger.filter(
    (row) =>
      row &&
      row.reference_id === drawId &&
      (row.reference_type === "draw" ||
        row.reference_type === null ||
        row.reference_type === undefined) &&
      typeof row.amount === "number",
  );
}

function normaliseExpectedCase(value, index) {
  if (!value || typeof value !== "object") {
    throw new Error(`Expected case ${index} must be an object.`);
  }
  const caseId = isNonEmptyString(value.case_id) ? value.case_id.trim() : "";
  if (!caseId) throw new Error(`Expected case ${index} needs a case_id.`);
  const command = isNonEmptyString(value.command) ? value.command.trim() : caseId;
  let kind = isNonEmptyString(value.kind) ? value.kind.trim() : null;
  if (!kind) {
    if (READ_ONLY_COMMANDS.has(command)) kind = "read_only";
    else if (command === "daily" || command === "mission") kind = "claim";
    else if (command === "open") kind = "open";
    else if (command === "share") kind = "share";
    else kind = "unknown";
  }
  if (!["read_only", "claim", "open", "share"].includes(kind)) {
    throw new Error(`Expected case ${caseId} has unsupported kind ${kind}.`);
  }
  const claimType =
    kind === "claim"
      ? isNonEmptyString(value.claim_type)
        ? value.claim_type.trim()
        : command === "mission"
          ? "mission"
          : "daily"
      : null;
  if (kind === "claim" && !["daily", "mission"].includes(claimType)) {
    throw new Error(`Expected case ${caseId} has unsupported claim_type ${claimType}.`);
  }
  return {
    case_id: caseId,
    command,
    label: isNonEmptyString(value.label) ? value.label.trim() : command,
    kind,
    ...(claimType ? { claim_type: claimType } : {}),
    ...(isNonEmptyString(value.mission_key) ? { mission_key: value.mission_key.trim() } : {}),
  };
}

function normaliseExpectedCases(cases) {
  const source = Array.isArray(cases) && cases.length ? cases : DEFAULT_EXPECTED_CASES;
  const normalised = source.map(normaliseExpectedCase);
  const ids = new Set();
  for (const item of normalised) {
    if (ids.has(item.case_id)) throw new Error(`Duplicate expected case ${item.case_id}.`);
    ids.add(item.case_id);
  }
  return normalised;
}

export function buildSession(input = {}) {
  const environment = input.environment ?? "production";
  if (!["local", "production"].includes(environment)) {
    throw new Error("Session environment must be local or production.");
  }
  const origin = isNonEmptyString(input.origin)
    ? input.origin.trim().replace(/\/+$/, "")
    : environment === "local"
      ? "http://localhost:5173"
      : "https://foilbury.loftwah.com";
  const startedAt = toIso(input.startedAt ?? isoNow());
  if (!startedAt) throw new Error("Session startedAt must be an ISO timestamp.");
  const durationMinutes = Number(input.durationMinutes ?? 60);
  if (!Number.isFinite(durationMinutes) || durationMinutes < 1 || durationMinutes > 24 * 60) {
    throw new Error("Session durationMinutes must be between 1 and 1440.");
  }
  const endsAt = new Date(Date.parse(startedAt) + durationMinutes * 60_000).toISOString();
  const buildValue = isNonEmptyString(input.status?.value) ? input.status.value.trim() : null;
  const sessionId = isNonEmptyString(input.sessionId)
    ? input.sessionId.trim()
    : `${SESSION_ID_PREFIX}-${startedAt.replace(/[-:.]/g, "").slice(0, 15)}-${crypto.randomBytes(3).toString("hex")}`;
  return {
    schema_version: SESSION_SCHEMA_VERSION,
    session_id: sessionId,
    environment,
    origin,
    build: {
      header: BUILD_HEADER,
      value: buildValue,
      verified: Boolean(buildValue),
      http_status: Number.isInteger(input.status?.http_status) ? input.status.http_status : null,
      checked_at: toIso(input.status?.checked_at ?? startedAt),
    },
    worker_version: isNonEmptyString(input.workerVersion) ? input.workerVersion.trim() : null,
    worker_version_source: isNonEmptyString(input.workerVersionSource)
      ? input.workerVersionSource.trim()
      : isNonEmptyString(input.workerVersion)
        ? "operator"
        : "not_discoverable",
    guild_id: isNonEmptyString(input.guildId) ? input.guildId.trim() : null,
    channel_id: isNonEmptyString(input.channelId) ? input.channelId.trim() : null,
    initiating_account_id: isNonEmptyString(input.actorId) ? input.actorId.trim() : null,
    window: {
      start: startedAt,
      end: endsAt,
    },
    expected_cases: normaliseExpectedCases(input.expectedCases),
    created_at: toIso(input.createdAt ?? isoNow()),
    notes: Array.isArray(input.notes) ? input.notes.filter(isNonEmptyString) : [],
    evidence_layers: {
      api: {
        status: buildValue ? "used" : "unavailable",
        detail: buildValue
          ? `${BUILD_HEADER}=${buildValue} was read from ${origin}/api/v1/status at prepare time.`
          : "No verified build header was available at prepare time.",
      },
      database: {
        status: "not_used",
        detail: "Prepare performs no D1 read or write.",
      },
      actual_client: {
        status: "unverified",
        detail: "Prepare makes no Discord client read-back.",
      },
      observer_attestation: {
        status: "not_supplied",
        detail: "No independent spectator declaration is part of the prepared session.",
        proof: false,
      },
    },
  };
}

export function validateSession(session) {
  const errors = [];
  const warnings = [];
  if (!session || typeof session !== "object") {
    return { valid: false, errors: ["Session is not an object."], warnings };
  }
  if (session.schema_version !== SESSION_SCHEMA_VERSION) {
    errors.push(`Session schema_version must be ${SESSION_SCHEMA_VERSION}.`);
  }
  if (!isNonEmptyString(session.session_id)) errors.push("Session has no session_id.");
  if (!["local", "production"].includes(session.environment)) {
    errors.push("Session environment must be local or production.");
  }
  if (!isNonEmptyString(session.origin)) {
    errors.push("Session has no origin.");
  } else {
    try {
      const url = new URL(session.origin);
      if (!["http:", "https:"].includes(url.protocol))
        errors.push("Session origin must be http or https.");
    } catch {
      errors.push("Session origin is not a valid URL.");
    }
  }
  if (!isSnowflake(session.guild_id)) errors.push("Session guild_id must be a Discord snowflake.");
  if (!isSnowflake(session.channel_id))
    errors.push("Session channel_id must be a Discord snowflake.");
  if (!isSnowflake(session.initiating_account_id)) {
    errors.push("Session initiating_account_id must be a Discord snowflake.");
  }
  const start = toTime(session.window?.start);
  const end = toTime(session.window?.end);
  if (start === null || end === null)
    errors.push("Session window must contain valid ISO timestamps.");
  else if (end <= start) errors.push("Session window end must be after start.");
  if (!Array.isArray(session.expected_cases) || !session.expected_cases.length) {
    errors.push("Session must declare at least one expected case.");
  } else {
    const ids = new Set();
    for (const item of session.expected_cases) {
      if (!isNonEmptyString(item?.case_id)) errors.push("Every expected case needs a case_id.");
      else if (ids.has(item.case_id)) errors.push(`Duplicate expected case ${item.case_id}.`);
      else ids.add(item.case_id);
      if (!["read_only", "claim", "open", "share"].includes(item?.kind)) {
        errors.push(`Expected case ${item?.case_id ?? "unknown"} has unsupported kind.`);
      }
    }
  }
  if (session.environment === "production" && !isNonEmptyString(session.build?.value)) {
    errors.push("Production sessions require an observed x-foilbury-build header.");
  }
  if (
    Number.isInteger(session.build?.http_status) &&
    (session.build.http_status < 200 || session.build.http_status > 299)
  ) {
    errors.push(
      `Build header was read from HTTP ${session.build.http_status}, not a successful status response.`,
    );
  }
  if (session.environment === "local" && !isNonEmptyString(session.build?.value)) {
    warnings.push("Local session has no x-foilbury-build header; build binding is unavailable.");
  }
  if (!isNonEmptyString(session.build?.header))
    errors.push("Session build header name is missing.");
  if (!isNonEmptyString(session.worker_version)) {
    warnings.push(
      "Worker version was not discoverable; the build header is the deployment identity.",
    );
  }
  return { valid: errors.length === 0, errors, warnings };
}

function parseReceipt(value) {
  if (value === null || value === undefined || value === "") {
    return { ok: false, code: "receipt_missing", value: null };
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return { ok: true, value };
  }
  if (typeof value !== "string") {
    return { ok: false, code: "receipt_invalid", value: null };
  }
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, code: "receipt_not_object", value: null };
    }
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, code: "receipt_invalid_json", value: null };
  }
}

function commandFromRaw(rawValue) {
  const raw = text(rawValue).trim();
  if (!raw) return { kind: "unknown", command: null, caseId: null, resolution: "database" };
  if (raw.startsWith("foilbury:tourshare:")) {
    return { kind: "share", command: "share", caseId: "share", resolution: "database" };
  }
  if (raw.startsWith("foilbury:mission:claim:")) {
    const key = raw.slice("foilbury:mission:claim:".length).split(":")[0]?.trim() ?? "";
    return {
      kind: "claim",
      command: "mission",
      caseId: key ? `mission:${key}` : "mission",
      claimType: "mission",
      missionKey: key || null,
      resolution: "database",
    };
  }
  if (raw.startsWith("foilbury:open:")) {
    return { kind: "open", command: "open", caseId: "open", resolution: "database" };
  }
  if (raw.startsWith("foilbury:tour:")) {
    return { kind: "read_only", command: "tour", caseId: "tour", resolution: "database" };
  }
  if (raw === "foilbury:daily") {
    return {
      kind: "claim",
      command: "daily",
      caseId: "daily",
      claimType: "daily",
      resolution: "database",
    };
  }
  if (COMPONENT_READ_ONLY.has(raw)) {
    const command = COMPONENT_READ_ONLY.get(raw);
    return { kind: "read_only", command, caseId: command, resolution: "database" };
  }
  if (raw.startsWith("foilbury:card:")) {
    return { kind: "read_only", command: "card", caseId: "card", resolution: "database" };
  }
  if (raw === "foilbury") {
    return { kind: "read_only_slash", command: "foilbury", caseId: null, resolution: "database" };
  }
  const slash = raw.replace(/^foilbury[:\s]+/, "").trim();
  if (slash === "open") {
    return { kind: "open", command: "open", caseId: "open", resolution: "database" };
  }
  if (slash === "daily") {
    return {
      kind: "claim",
      command: "daily",
      caseId: "daily",
      claimType: "daily",
      resolution: "database",
    };
  }
  if (slash === "mission" || slash.startsWith("mission:")) {
    const key = slash.includes(":") ? slash.split(":").slice(1).join(":") : "";
    return {
      kind: "claim",
      command: "mission",
      caseId: key ? `mission:${key}` : "mission",
      claimType: "mission",
      missionKey: key || null,
      resolution: "database",
    };
  }
  if (slash === "share") {
    return { kind: "share", command: "share", caseId: "share", resolution: "database" };
  }
  if (READ_ONLY_COMMANDS.has(slash)) {
    return { kind: "read_only", command: slash, caseId: slash, resolution: "database" };
  }
  return { kind: "unknown", command: slash || raw, caseId: null, resolution: "database" };
}

function resolveCommand(interaction, evidence = {}, attestation) {
  const base = commandFromRaw(interaction?.command_name);
  const interactionId = text(interaction?.interaction_id);
  if (base.kind !== "read_only_slash") return base;

  const drawCandidates = Array.isArray(evidence.drawCandidates) ? evidence.drawCandidates : [];
  const parsedReceipt = parseReceipt(interaction?.receipt_json);
  const hasDrawReceipt =
    parsedReceipt.ok &&
    (parsedReceipt.value.kind === "draw" || isNonEmptyString(parsedReceipt.value.draw_id));
  if (
    interaction?.receipt_kind === "draw" ||
    hasDrawReceipt ||
    evidence.draw ||
    drawCandidates.some((row) => row?.idempotency_key === `discord:${interactionId}:open`)
  ) {
    return { kind: "open", command: "open", caseId: "open", resolution: "database" };
  }
  const claims = Array.isArray(evidence.rewardClaims) ? evidence.rewardClaims : [];
  if (claims.some((row) => row?.idempotency_key === `discord:${interactionId}:daily`)) {
    return {
      kind: "claim",
      command: "daily",
      caseId: "daily",
      claimType: "daily",
      resolution: "database",
    };
  }
  if (isNonEmptyString(attestation?.case_id)) {
    return {
      kind: "attested",
      command: "foilbury",
      caseId: attestation.case_id,
      resolution: "operator_attestation",
    };
  }
  return base;
}

function expectedMatches(resolved, expected) {
  if (!resolved || !expected) return false;
  if (resolved.caseId === expected.case_id) return true;
  if (resolved.command === expected.command) return true;
  if (resolved.kind === expected.kind) {
    if (resolved.kind === "share") return true;
    if (resolved.kind === "claim" && resolved.claimType === expected.claim_type) return true;
    if (resolved.kind === "open") return true;
  }
  if (resolved.caseId && resolved.caseId.split(":")[0] === expected.case_id) return true;
  return false;
}

export function selectTerminalExpectation(input = {}) {
  const session = input.session;
  const interaction = input.interaction;
  const attestation = input.commandAttestation;
  const expectedCases = Array.isArray(session?.expected_cases) ? session.expected_cases : [];
  const resolved = resolveCommand(interaction, input, attestation);
  let expected = null;
  if (isNonEmptyString(input.expectedCase?.case_id)) {
    expected = expectedCases.find((item) => item.case_id === input.expectedCase.case_id) ?? null;
    if (!expected) {
      return {
        case_id: null,
        command: resolved.command,
        kind: "unbound",
        requires_receipt: false,
        delivery: "private",
        command_binding: {
          layer: resolved.resolution,
          raw: text(interaction?.command_name),
          resolved: resolved.command,
        },
        error: {
          code: "expected_case_unknown",
          message: `Expected case ${input.expectedCase.case_id} is not declared in this session.`,
          candidates: expectedCases
            .filter((item) => item.kind === "read_only")
            .map((item) => item.case_id),
        },
      };
    }
  }
  if (!expected && isNonEmptyString(attestation?.case_id)) {
    expected = expectedCases.find((item) => item.case_id === attestation.case_id) ?? null;
  }
  if (!expected) {
    expected = expectedCases.find((item) => expectedMatches(resolved, item)) ?? null;
  }
  if (!expected) {
    const readOnlyCandidates =
      resolved.kind === "read_only_slash" || resolved.kind === "attested"
        ? expectedCases.filter((item) => item.kind === "read_only").map((item) => item.case_id)
        : [];
    return {
      case_id: null,
      command: resolved.command,
      kind: "unbound",
      requires_receipt: false,
      delivery: "private",
      command_binding: {
        layer: resolved.resolution,
        raw: text(interaction?.command_name),
        resolved: resolved.command,
      },
      error: {
        code:
          readOnlyCandidates.length > 0 ? "command_ambiguous_read_only" : "command_not_expected",
        message:
          readOnlyCandidates.length > 0
            ? `Slash interactions store only "foilbury", so a read-only subcommand needs --case to bind it. Candidates: ${readOnlyCandidates.join(", ")}.`
            : `Interaction command ${text(interaction?.command_name) || "(empty)"} does not match a prepared expected case.`,
        candidates: readOnlyCandidates,
      },
    };
  }
  const kind = expected.kind;
  return {
    case_id: expected.case_id,
    command: expected.command,
    label: expected.label,
    kind,
    claim_type: kind === "claim" ? expected.claim_type : null,
    mission_key: expected.mission_key ?? resolved.missionKey ?? null,
    requires_receipt: kind === "open",
    receipt_kind: kind === "open" ? "draw" : null,
    delivery: kind === "share" ? "public" : "private",
    command_binding: {
      layer: resolved.resolution,
      raw: text(interaction?.command_name),
      resolved: resolved.command,
      attested_case_id:
        resolved.resolution === "operator_attestation" ? (attestation?.case_id ?? null) : null,
    },
  };
}

function layerSummary(session, observerStatus = null) {
  return {
    api: session?.build?.verified
      ? {
          status: "used",
          detail: `${BUILD_HEADER}=${session.build.value} observed from ${session.origin}/api/v1/status`,
        }
      : {
          status: "unavailable",
          detail: "No verified build header was recorded in the session.",
        },
    database: {
      status: "used",
      detail: "D1 interaction record, receipt, draw, instance, ledger, claim and share rows.",
    },
    actual_client: {
      status: "unverified",
      detail:
        "This runner never claims a visual Discord client read-back. Delivery visibility is a server record, not proof of what a person saw.",
    },
    observer_attestation: observerStatus ?? {
      status: "not_supplied",
      detail: "No independent spectator declaration was supplied to this report.",
      proof: false,
    },
  };
}

function baseReport(session, interaction) {
  return {
    generated_at: isoNow(),
    session_id: session?.session_id ?? null,
    interaction_id: interaction?.interaction_id ?? null,
    command: interaction?.command_name ?? null,
    status: interaction?.status ?? null,
    error_code: interaction?.error_code ?? null,
    delivery_visibility: interaction?.delivery_visibility ?? null,
    case_id: null,
    expectation: null,
    result: "fail",
    failures: [],
    checks: {},
    receipt: null,
    economics: null,
    evidence_layers: layerSummary(session),
    limitations: [],
  };
}

function addCheck(report, name, ok, layer, detail, code = name) {
  report.checks[name] = { ok: Boolean(ok), layer, detail };
  if (!ok) report.failures.push({ code, message: detail, layer });
  return Boolean(ok);
}

function evaluateOpenEconomics(input, report) {
  const { interaction, identity, draw, instance, receipt, wallet } = input;
  const ledger = Array.isArray(input.ledger) ? input.ledger : [];
  const drawInstances = Array.isArray(input.drawInstances) ? input.drawInstances : [];
  const unlocks = Array.isArray(input.achievementUnlocks) ? input.achievementUnlocks : [];
  const economics = {
    draw_id: receipt.draw_id,
    debit_count: 0,
    instance_count: drawInstances.length,
    achievement_credit_count: 0,
    extra_credit_count: 0,
    balance_reconciliation: "unverifiable",
    replay_delta_zero: false,
  };
  report.economics = economics;

  if (!identity?.tenant_id || !identity?.user_id) {
    addCheck(
      report,
      "identity_present",
      false,
      "database",
      "The Discord user is not linked to a tenant member.",
    );
    return;
  }
  if (!draw) {
    addCheck(
      report,
      "draw_row_present",
      false,
      "database",
      "No draw row exists for the receipt draw_id.",
    );
  } else {
    addCheck(
      report,
      "draw_tenant_user_match",
      draw.tenant_id === identity.tenant_id && draw.user_id === identity.user_id,
      "database",
      "The draw must belong to the same tenant and user as the interaction.",
      "draw_tenant_user_mismatch",
    );
    addCheck(
      report,
      "draw_matches_receipt",
      draw.id === receipt.draw_id &&
        draw.instance_id === receipt.instance_id &&
        Number(draw.price) === Number(receipt.price) &&
        draw.variant_id === receipt.variant_id,
      "database",
      "The draw row must match the receipt draw_id, instance_id, price and variant_id.",
      "draw_receipt_mismatch",
    );
    addCheck(
      report,
      "draw_bound_to_interaction",
      draw.idempotency_key === `discord:${interaction.interaction_id}:open`,
      "database",
      "The draw idempotency key must be the exact Discord interaction binding.",
      "draw_interaction_mismatch",
    );
  }

  if (!instance) {
    addCheck(
      report,
      "instance_present",
      false,
      "database",
      "No card instance exists for the receipt instance_id.",
    );
  } else {
    addCheck(
      report,
      "instance_matches_receipt",
      instance.id === receipt.instance_id &&
        instance.serial === receipt.serial &&
        instance.variant_id === receipt.variant_id &&
        instance.card_id === receipt.card_id &&
        ["owned", "reserved"].includes(instance.status),
      "database",
      "The instance must match the receipt serial, variant and card and still be owned.",
      "instance_receipt_mismatch",
    );
    addCheck(
      report,
      "instance_tenant_user_match",
      instance.tenant_id === identity.tenant_id && instance.user_id === identity.user_id,
      "database",
      "The instance must belong to the same tenant and user as the interaction.",
      "instance_tenant_user_mismatch",
    );
  }

  addCheck(
    report,
    "draw_instance_exactly_one",
    drawInstances.length === 1 && drawInstances[0]?.id === receipt.instance_id,
    "database",
    drawInstances.length === 0
      ? "No owned instance is linked to this draw."
      : drawInstances.length > 1
        ? `The draw is linked to ${drawInstances.length} instances.`
        : "The draw must be linked to exactly one owned instance.",
    drawInstances.length === 0 ? "draw_instance_missing" : "draw_instance_duplicate",
  );
  if (drawInstances.length === 1) {
    const owned = drawInstances[0];
    addCheck(
      report,
      "draw_instance_owner_match",
      owned.tenant_id === identity.tenant_id &&
        owned.user_id === identity.user_id &&
        owned.serial === receipt.serial &&
        ["owned", "reserved"].includes(owned.status),
      "database",
      "The linked instance must carry the receipt serial and be owned by the interaction user.",
      "draw_instance_owner_mismatch",
    );
  }

  const exactDebits = filterDrawLedger(ledger, receipt.draw_id);
  economics.debit_count = exactDebits.length;
  const drawAttempts = Array.isArray(input.drawCandidates)
    ? input.drawCandidates.filter(
        (row) => row?.idempotency_key === `discord:${interaction.interaction_id}:open`,
      )
    : null;
  if (drawAttempts) {
    economics.draw_attempt_count = drawAttempts.length;
    addCheck(
      report,
      "draw_attempt_exactly_one",
      drawAttempts.length === 1 && drawAttempts[0]?.id === receipt.draw_id,
      "database",
      drawAttempts.length === 0
        ? "No draw is bound to this interaction idempotency key."
        : drawAttempts.length > 1
          ? `The interaction has ${drawAttempts.length} draw attempts.`
          : "Exactly one draw is bound to this interaction idempotency key.",
      drawAttempts.length === 0 ? "draw_attempt_missing" : "draw_attempt_duplicate",
    );
  }
  addCheck(
    report,
    "draw_debit_exactly_one",
    exactDebits.length === 1,
    "database",
    exactDebits.length === 0
      ? "No ledger debit references this draw_id exactly. Unrelated rows are not counted."
      : exactDebits.length > 1
        ? `The draw has ${exactDebits.length} ledger debits.`
        : "Exactly one ledger debit references this draw_id.",
    exactDebits.length === 0 ? "draw_debit_missing" : "draw_debit_duplicate",
  );

  const debit = exactDebits.length === 1 ? exactDebits[0] : null;
  if (debit) {
    addCheck(
      report,
      "draw_debit_shape",
      debit.kind === "spend" && Number(debit.amount) === -Number(receipt.price),
      "database",
      "The draw debit must be a spend of exactly minus the receipt price.",
      "draw_debit_amount_mismatch",
    );
    addCheck(
      report,
      "currency_matches",
      wallet?.currency_symbol === receipt.currency_symbol,
      "database",
      `Receipt currency ${receipt.currency_symbol} must match the tenant wallet currency ${wallet?.currency_symbol ?? "(missing)"}.`,
      "currency_mismatch",
    );

    const prior = input.priorLedger;
    if (prior && Number.isFinite(Number(prior.balance_after))) {
      const expectedAfter = Number(prior.balance_after) - Number(receipt.price);
      const reconciled = Number(debit.balance_after) === expectedAfter;
      economics.balance_reconciliation = reconciled ? "reconciled" : "failed";
      addCheck(
        report,
        "balance_after_debit_reconciles",
        reconciled,
        "database",
        `Prior ledger balance ${prior.balance_after} minus price ${receipt.price} must equal debit balance_after ${debit.balance_after}.`,
        "balance_reconciliation_failed",
      );
    } else {
      economics.balance_reconciliation = "unverifiable";
      report.limitations.push(
        "No prior ledger row was available, so the draw debit balance_after is explicitly unverifiable rather than assumed correct.",
      );
    }
    if (receipt.balance_after_debit !== undefined) {
      addCheck(
        report,
        "receipt_balance_after_debit_matches",
        Number(receipt.balance_after_debit) === Number(debit.balance_after),
        "database",
        "The receipt balance_after_debit must equal the debit ledger balance_after.",
        "receipt_debit_balance_mismatch",
      );
    }

    const achievementRows = ledger.filter(
      (row) => row && row.reference_type === "achievement" && Number(row.amount) > 0,
    );
    economics.achievement_credit_count = achievementRows.length;
    const unlockIds = new Set(unlocks.map((item) => item.id));
    const unboundAchievementRows = achievementRows.filter(
      (row) => !row.reference_id || !unlockIds.has(row.reference_id),
    );
    addCheck(
      report,
      "achievement_credits_bound_to_unlocks",
      unboundAchievementRows.length === 0,
      "database",
      "Every achievement credit must reference an unlock earned by this draw.",
      "achievement_reward_unbound",
    );
    const grouped = new Map();
    for (const row of achievementRows) {
      const key = row.reference_id ?? row.id;
      grouped.set(key, (grouped.get(key) ?? 0) + 1);
    }
    const duplicateAchievement = [...grouped.values()].some((count) => count > 1);
    addCheck(
      report,
      "achievement_rewards_at_most_once",
      !duplicateAchievement,
      "database",
      "Each achievement unlock may have at most one reward ledger credit.",
      "achievement_reward_duplicate",
    );
    for (const item of unlocks) {
      if (Number(item.reward_amount) <= 0 || item.reward_state !== "granted") continue;
      const rows = achievementRows.filter((row) => row.reference_id === item.id);
      addCheck(
        report,
        `achievement_reward_${item.id}`,
        rows.length === 1 &&
          Number(rows[0]?.amount) === Number(item.reward_amount) &&
          (!item.reward_ledger_id || rows[0]?.id === item.reward_ledger_id),
        "database",
        `Achievement unlock ${item.id} must have exactly one reward credit matching its amount and reward_ledger_id.`,
        "achievement_reward_missing",
      );
    }
    if (unlocks.some((item) => Number(item.reward_amount) > 0 && item.reward_state !== "granted")) {
      report.limitations.push(
        "An achievement reward was still pending or failed at verification time.",
      );
    }

    const credits = achievementRows.reduce((sum, row) => sum + Number(row.amount), 0);
    const expectedSettled = Number(debit.balance_after) + credits;
    addCheck(
      report,
      "receipt_balance_after_settles",
      Number(receipt.balance_after) === expectedSettled,
      "database",
      `Debit balance_after ${debit.balance_after} plus achievement credits ${credits} must equal receipt balance_after ${receipt.balance_after}.`,
      "receipt_balance_mismatch",
    );
    if (receipt.credits_total !== undefined) {
      addCheck(
        report,
        "receipt_credits_total_matches",
        Number(receipt.credits_total) === credits,
        "database",
        "The receipt achievement credits total must match the ledger.",
        "receipt_credits_mismatch",
      );
    }
  }

  const end = toTime(interaction.completed_at) ?? Date.now();
  const start = toTime(receipt.drawn_at) ?? toTime(interaction.created_at) ?? 0;
  const extraCredits = ledger.filter((row) => {
    if (!row || Number(row.amount) <= 0) return false;
    if (row.reference_type === "achievement") return false;
    if (row.reference_id === receipt.draw_id) return false;
    const created = toTime(row.created_at);
    return created !== null && created >= start && created <= end;
  });
  economics.extra_credit_count = extraCredits.length;
  addCheck(
    report,
    "no_extra_credit_in_interaction_window",
    extraCredits.length === 0,
    "database",
    extraCredits.length
      ? `Unexpected positive ledger rows in the interaction window: ${extraCredits.map((row) => row.id ?? row.description ?? "unknown").join(", ")}.`
      : "No unattributed positive ledger row sits inside this interaction window.",
    "extra_credit",
  );

  economics.replay_delta_zero =
    exactDebits.length === 1 &&
    drawInstances.length === 1 &&
    (!drawAttempts || drawAttempts.length === 1) &&
    report.checks.achievement_rewards_at_most_once?.ok !== false &&
    extraCredits.length === 0;
  addCheck(
    report,
    "replay_delta_zero",
    economics.replay_delta_zero,
    "database",
    "A replay must leave one draw, one debit and one instance with no extra credit.",
    "replay_delta_nonzero",
  );
}

function evaluateClaim(input, report, expectation) {
  const { interaction, identity } = input;
  const claims = Array.isArray(input.rewardClaims) ? input.rewardClaims : [];
  const ledger = Array.isArray(input.ledger) ? input.ledger : [];
  const attempts = Array.isArray(input.drawCandidates) ? input.drawCandidates : [];
  const claimType = expectation.claim_type;
  const interactionId = interaction.interaction_id;
  const windowStart = toTime(interaction.created_at);
  const windowEnd = toTime(interaction.completed_at) ?? Date.now();

  const matching = claims.filter((claim) => {
    if (!claim || claim.tenant_id !== identity?.tenant_id || claim.user_id !== identity?.user_id) {
      return false;
    }
    if (claimType === "daily") {
      return claim.idempotency_key === `discord:${interactionId}:daily`;
    }
    const key = expectation.mission_key;
    const ruleOk = text(claim.rule_key).startsWith("mission:");
    const keyOk = key ? text(claim.rule_key).endsWith(`:${key}`) : true;
    const created = toTime(claim.created_at);
    return (
      ruleOk &&
      keyOk &&
      created !== null &&
      windowStart !== null &&
      created >= windowStart &&
      created <= windowEnd + 2_000
    );
  });

  const economics = {
    claim_id: matching.length === 1 ? matching[0].id : null,
    claim_count: matching.length,
    credit_count: 0,
    balance_reconciliation: "unverifiable",
  };
  report.economics = economics;
  addCheck(
    report,
    "claim_exactly_one",
    matching.length === 1,
    "database",
    matching.length === 0
      ? "No durable reward claim is bound to this interaction."
      : matching.length > 1
        ? `The interaction has ${matching.length} matching reward claims.`
        : "Exactly one durable reward claim is bound to this interaction.",
    matching.length === 0 ? "claim_missing" : "claim_duplicate",
  );
  if (matching.length !== 1) return;
  const claim = matching[0];
  addCheck(
    report,
    "claim_amount_positive",
    Number.isInteger(Number(claim.amount)) && Number(claim.amount) > 0,
    "database",
    "A claim must credit a positive integer amount.",
    "claim_amount_invalid",
  );
  if (claimType === "daily") {
    addCheck(
      report,
      "claim_rule_is_daily",
      claim.rule_key === "daily-allowance",
      "database",
      "A daily interaction must be backed by the daily-allowance reward claim.",
      "claim_rule_mismatch",
    );
  }

  const credits = ledger.filter(
    (row) => row && row.reference_type === "reward" && row.reference_id === claim.id,
  );
  economics.credit_count = credits.length;
  addCheck(
    report,
    "claim_credit_exactly_once",
    credits.length === 1 &&
      Number.isInteger(Number(credits[0]?.amount)) &&
      Number(credits[0].amount) === Number(claim.amount) &&
      credits[0]?.kind === "issue",
    "database",
    credits.length === 0
      ? "The reward claim has no matching ledger credit."
      : credits.length > 1
        ? `The reward claim has ${credits.length} ledger credits.`
        : "The reward claim must have one issue credit with exactly the claim amount.",
    credits.length === 0 ? "claim_credit_missing" : "claim_credit_mismatch",
  );
  if (credits.length === 1) {
    const credit = credits[0];
    if (input.priorLedger && Number.isFinite(Number(input.priorLedger.balance_after))) {
      const expected = Number(input.priorLedger.balance_after) + Number(claim.amount);
      const reconciled = Number(credit.balance_after) === expected;
      economics.balance_reconciliation = reconciled ? "reconciled" : "failed";
      addCheck(
        report,
        "claim_balance_reconciles",
        reconciled,
        "database",
        `Prior ledger balance ${input.priorLedger.balance_after} plus claim ${claim.amount} must equal credit balance_after ${credit.balance_after}.`,
        "claim_balance_mismatch",
      );
    } else {
      report.limitations.push(
        "No prior ledger row was available, so the claim credit balance_after is explicitly unverifiable.",
      );
    }
  }

  addCheck(
    report,
    "claim_has_no_draw",
    attempts.length === 0,
    "database",
    "A claim interaction must not create a draw.",
    "claim_created_draw",
  );
}

function evaluateReadOnly(input, report) {
  const interactionId = input.interaction.interaction_id;
  const draws = Array.isArray(input.drawCandidates) ? input.drawCandidates : [];
  const claims = Array.isArray(input.rewardClaims) ? input.rewardClaims : [];
  const boundDraws = draws.filter(
    (row) => row?.idempotency_key === `discord:${interactionId}:open`,
  );
  const boundClaims = claims.filter(
    (row) =>
      row?.idempotency_key === `discord:${interactionId}:daily` ||
      text(row?.idempotency_key).includes(interactionId),
  );
  const receipt = parseReceipt(input.interaction.receipt_json);
  const economicReceipt =
    receipt.ok && (receipt.value.kind === "draw" || isNonEmptyString(receipt.value.draw_id));
  report.economics = {
    draw_count: boundDraws.length,
    claim_count: boundClaims.length,
    ledger_required: false,
  };
  addCheck(
    report,
    "read_only_no_economic_receipt",
    !economicReceipt,
    "database",
    "A read-only command must not carry a draw receipt.",
    "read_only_economic_mutation",
  );
  addCheck(
    report,
    "read_only_no_draw",
    boundDraws.length === 0,
    "database",
    "A read-only command must not create a draw.",
    "read_only_economic_mutation",
  );
  addCheck(
    report,
    "read_only_no_claim",
    boundClaims.length === 0,
    "database",
    "A read-only command must not create a reward claim.",
    "read_only_economic_mutation",
  );
  report.limitations.push(
    "A read-only slash interaction stores only the top-level foilbury command in D1; the subcommand is bound by --case attestation unless the interaction row carries it directly.",
  );
}

function evaluateShare(input, report, expectation) {
  const { interaction, identity } = input;
  const shares = Array.isArray(input.shares) ? input.shares : [];
  const start = toTime(interaction.created_at);
  const end = (toTime(interaction.completed_at) ?? Date.now()) + 5_000;
  const matching = shares.filter((share) => {
    if (!share || share.tenant_id !== identity?.tenant_id || share.user_id !== identity?.user_id) {
      return false;
    }
    if (share.channel_id !== interaction.channel_id) return false;
    const created = toTime(share.created_at);
    return created !== null && start !== null && created >= start && created <= end;
  });
  const economics = {
    share_id: matching.length === 1 ? matching[0].id : null,
    share_count: matching.length,
  };
  report.economics = economics;
  addCheck(
    report,
    "share_exactly_one",
    matching.length === 1,
    "database",
    matching.length === 0
      ? "No durable Discord share row exists for this interaction."
      : matching.length > 1
        ? `The interaction has ${matching.length} durable share rows.`
        : "Exactly one durable Discord share row exists for this interaction.",
    matching.length === 0 ? "share_missing" : "share_duplicate",
  );
  if (matching.length === 1) {
    const share = matching[0];
    addCheck(
      report,
      "share_object_type",
      ["card", "completion", "profile"].includes(share.object_type),
      "database",
      "The share must be a card, completion or profile share.",
      "share_object_type_invalid",
    );
    if (share.message_id) {
      addCheck(
        report,
        "share_message_id_shape",
        isSnowflake(share.message_id),
        "database",
        "A recorded share message_id must be a Discord snowflake.",
        "share_message_id_invalid",
      );
    } else {
      report.limitations.push(
        "The durable share row has no message_id, so a spectator-supplied Discord message id cannot be cross-checked by this runner.",
      );
    }
  }
  addCheck(
    report,
    "share_no_draw",
    !(Array.isArray(input.drawCandidates) && input.drawCandidates.length),
    "database",
    "A share interaction must not create a draw.",
    "share_created_draw",
  );
  const boundClaims = (Array.isArray(input.rewardClaims) ? input.rewardClaims : []).filter((row) =>
    text(row?.idempotency_key).includes(interaction.interaction_id),
  );
  addCheck(
    report,
    "share_no_claim",
    boundClaims.length === 0,
    "database",
    "A share interaction must not create a reward claim.",
    "share_created_claim",
  );
}

export function evaluateInteraction(input = {}) {
  const session = input.session;
  const interaction = input.interaction;
  const report = baseReport(session, interaction);
  const sessionValidation = validateSession(session);
  if (!sessionValidation.valid) {
    addCheck(
      report,
      "session_valid",
      false,
      "api",
      `Session is invalid: ${sessionValidation.errors.join(" ")}`,
      "session_invalid",
    );
    report.limitations.push(...sessionValidation.warnings);
    return report;
  }
  report.limitations.push(...sessionValidation.warnings);
  if (input.environment && input.environment !== session.environment) {
    addCheck(
      report,
      "environment_matches",
      false,
      "api",
      `Interaction mode ${input.environment} does not match session environment ${session.environment}.`,
      "environment_mismatch",
    );
  }
  if (input.expectedBuild && session.build.value !== input.expectedBuild) {
    addCheck(
      report,
      "build_matches",
      false,
      "api",
      `Session build ${session.build.value} does not match expected build ${input.expectedBuild}.`,
      "build_mismatch",
    );
  }

  if (!interaction) {
    addCheck(
      report,
      "interaction_present",
      false,
      "database",
      "No interaction row exists for that id.",
      "not_found",
    );
    return report;
  }
  addCheck(report, "interaction_present", true, "database", "Interaction row found.");
  addCheck(
    report,
    "session_binding",
    interaction.guild_id === session.guild_id &&
      interaction.channel_id === session.channel_id &&
      interaction.discord_user_id === session.initiating_account_id,
    "database",
    "The interaction must be in the prepared guild, channel and initiating account.",
    interaction.guild_id !== session.guild_id
      ? "guild_mismatch"
      : interaction.channel_id !== session.channel_id
        ? "channel_mismatch"
        : "actor_mismatch",
  );
  addCheck(
    report,
    "inside_session_window",
    inWindow(interaction.created_at, session.window),
    "database",
    `Interaction created_at ${interaction.created_at ?? "(missing)"} must be inside ${session.window.start} to ${session.window.end}.`,
    "outside_session_window",
  );

  const installation = input.installation;
  const identity = input.identity;
  addCheck(
    report,
    "installation_present",
    Boolean(installation?.tenant_id) &&
      Number(installation?.active) === 1 &&
      !installation?.revoked_at,
    "database",
    "The guild must have a live, active Foilbury installation.",
    "installation_missing",
  );
  addCheck(
    report,
    "identity_present",
    Boolean(identity?.tenant_id && identity?.user_id) &&
      (!installation?.tenant_id || identity.tenant_id === installation.tenant_id),
    "database",
    "The Discord actor must resolve to the installation tenant member.",
    "identity_missing",
  );

  const expectation = selectTerminalExpectation({
    session,
    interaction,
    draw: input.draw,
    drawCandidates: input.drawCandidates,
    rewardClaims: input.rewardClaims,
    expectedCase: input.expectedCase,
    commandAttestation: input.commandAttestation,
  });
  report.expectation = expectation;
  if (expectation.kind === "unbound") {
    addCheck(
      report,
      "command_expected",
      false,
      expectation.command_binding.layer,
      expectation.error.message,
      expectation.error.code,
    );
    if (interaction.status === "processing") {
      report.result = "pending";
      return report;
    }
    if (interaction.status === "failed") {
      addCheck(
        report,
        "failed_is_not_success",
        false,
        "database",
        "A failed interaction is never a successful acceptance result.",
        "interaction_failed",
      );
      addCheck(
        report,
        "real_api_error_code",
        isApiErrorCode(interaction.error_code),
        "database",
        `Failed interactions must record a real ApiError code; received ${interaction.error_code ?? "(missing)"}.`,
        "missing_api_error_code",
      );
      report.result = "fail";
    }
    return report;
  }
  report.case_id = expectation.case_id;

  const terminal = ["completed", "failed"].includes(interaction.status);
  addCheck(
    report,
    "terminal",
    terminal,
    "database",
    `Interaction status is ${interaction.status ?? "(missing)"}.`,
    "interaction_not_terminal",
  );
  if (interaction.status === "processing") {
    report.result = "pending";
    report.limitations.push(
      "Processing interactions stay pending. --watch rechecks the same interaction until completed or failed, or reports timeout_pending.",
    );
    return report;
  }
  if (!terminal) {
    report.result = "fail";
    return report;
  }

  if (interaction.status === "failed") {
    addCheck(
      report,
      "failed_is_not_success",
      false,
      "database",
      "A failed interaction is never a successful acceptance result.",
      "interaction_failed",
    );
    addCheck(
      report,
      "real_api_error_code",
      isApiErrorCode(interaction.error_code),
      "database",
      `Failed interactions must record a real ApiError code; received ${interaction.error_code ?? "(missing)"}.`,
      "missing_api_error_code",
    );
    report.result = "fail";
    return report;
  }

  if (interaction.error_code) {
    addCheck(
      report,
      "completed_without_error_code",
      false,
      "database",
      `A completed interaction must not carry error_code ${interaction.error_code}.`,
      "interaction_error_code_present",
    );
  } else {
    addCheck(
      report,
      "completed_without_error_code",
      true,
      "database",
      "Completed without an error code.",
    );
  }

  if (expectation.delivery === "public") {
    addCheck(
      report,
      "public_delivery",
      interaction.delivery_visibility === "public",
      "database",
      `A share must be delivered publicly; delivery_visibility is ${interaction.delivery_visibility ?? "(missing)"}.`,
      "public_delivery_missing",
    );
    if (interaction.error_code && text(interaction.error_code).includes("delivery")) {
      addCheck(
        report,
        "share_delivery_succeeded",
        false,
        "database",
        `Share delivery failed with ${interaction.error_code}.`,
        "failed_delivery",
      );
    }
  } else {
    addCheck(
      report,
      "private_acknowledgement",
      PRIVATE_VISIBILITY.includes(interaction.delivery_visibility),
      "database",
      `This command must be acknowledged privately; delivery_visibility is ${interaction.delivery_visibility ?? "(missing)"}.`,
      "private_delivery_missing",
    );
  }

  if (expectation.kind === "read_only") {
    evaluateReadOnly(input, report);
    report.result = report.failures.length === 0 ? "pass" : "fail";
    return report;
  }

  if (expectation.kind === "claim") {
    evaluateClaim(input, report, expectation);
    report.result = report.failures.length === 0 ? "pass" : "fail";
    return report;
  }

  if (expectation.kind === "share") {
    evaluateShare(input, report, expectation);
    report.result = report.failures.length === 0 ? "pass" : "fail";
    return report;
  }

  const parsedReceipt = parseReceipt(interaction.receipt_json);
  if (!parsedReceipt.ok) {
    addCheck(
      report,
      "draw_receipt_present",
      false,
      "database",
      `An open interaction requires a valid draw receipt; ${parsedReceipt.code}.`,
      parsedReceipt.code,
    );
    report.result = "fail";
    return report;
  }
  const receipt = parsedReceipt.value;
  report.receipt = receipt;
  const requiredFields = [
    "kind",
    "draw_id",
    "instance_id",
    "card_id",
    "variant_id",
    "serial",
    "price",
    "currency_symbol",
    "balance_after",
    "drawn_at",
  ];
  const missing = requiredFields.filter(
    (field) => receipt[field] === undefined || receipt[field] === null || receipt[field] === "",
  );
  addCheck(
    report,
    "draw_receipt_shape",
    missing.length === 0 && receipt.kind === "draw",
    "database",
    missing.length
      ? `Draw receipt is missing ${missing.join(", ")}.`
      : "Draw receipt has kind=draw and all required economic fields.",
    "receipt_missing_fields",
  );
  if (interaction.receipt_kind && interaction.receipt_kind !== "draw") {
    addCheck(
      report,
      "receipt_kind_matches",
      false,
      "database",
      `Receipt kind ${interaction.receipt_kind} is not a draw receipt.`,
      "receipt_kind_mismatch",
    );
  }
  if (report.checks.draw_receipt_shape?.ok) {
    evaluateOpenEconomics(
      {
        ...input,
        receipt,
        ledger: input.ledger,
        drawInstances: input.drawInstances,
        achievementUnlocks: input.achievementUnlocks,
      },
      report,
    );
  }
  report.result = report.failures.length === 0 ? "pass" : "fail";
  return report;
}

function parseEvidence(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return { ok: true, value };
  if (typeof value !== "string") return { ok: false, code: "evidence_not_object", value: null };
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, code: "evidence_not_object", value: null };
    }
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, code: "evidence_invalid_json", value: null };
  }
}

export function evaluateSpectator(input = {}) {
  const session = input.session;
  const parsed = parseEvidence(input.evidence);
  const report = {
    generated_at: isoNow(),
    session_id: session?.session_id ?? null,
    phase: "spectator",
    result: "fail",
    attestation_only: true,
    proof: false,
    failures: [],
    checks: {},
    evidence: parsed.ok ? parsed.value : null,
    evidence_layers: layerSummary(session, {
      status: "provided",
      detail:
        "A hand-authored observer declaration. It is an attestation, not cryptographic proof of what a screen showed.",
      proof: false,
    }),
    limitations: [
      "A hand-authored declaration is an attestation, not proof; it does not cryptographically establish what the observer saw.",
      "Screenshots and API read-back cannot prove absence of private content; only the observer declaration is recorded.",
      "The runner does not read Discord message content, impersonate the observer or verify a screenshot.",
      "The observed message_id is an attestation; the durable share row currently has no message_id to cross-check it.",
    ],
  };
  const add = (name, ok, layer, detail, code = name) => {
    report.checks[name] = { ok: Boolean(ok), layer, detail };
    if (!ok) report.failures.push({ code, message: detail, layer });
  };
  const sessionValidation = validateSession(session);
  if (!sessionValidation.valid) {
    add(
      "session_valid",
      false,
      "api",
      `Session is invalid: ${sessionValidation.errors.join(" ")}`,
      "session_invalid",
    );
    report.evidence_layers.observer_attestation.status = "rejected";
    return report;
  }
  if (!parsed.ok) {
    add(
      "evidence_parsed",
      false,
      "observer_attestation",
      `Spectator evidence is not a JSON object (${parsed.code}).`,
      parsed.code,
    );
    report.evidence_layers.observer_attestation.status = "rejected";
    return report;
  }
  const evidence = parsed.value;
  add(
    "session_matches",
    evidence.session_id === session.session_id,
    "observer_attestation",
    `Spectator evidence session_id must be ${session.session_id}.`,
    "spectator_session_mismatch",
  );
  add(
    "guild_matches",
    evidence.guild_id === session.guild_id,
    "observer_attestation",
    "Spectator evidence must name the prepared guild.",
    "guild_mismatch",
  );
  add(
    "channel_matches",
    evidence.channel_id === session.channel_id,
    "observer_attestation",
    "Spectator evidence must name the prepared channel.",
    "channel_mismatch",
  );
  add(
    "message_id_present",
    isSnowflake(evidence.message_id),
    "observer_attestation",
    "Spectator evidence must include the observed Discord message id as a snowflake.",
    "message_id_missing",
  );
  const actorId = evidence.actor_id ?? evidence.observer_id;
  add(
    "observer_actor_present",
    isSnowflake(actorId),
    "observer_attestation",
    "Spectator evidence must include an independent observer Discord user id.",
    "observer_actor_missing",
  );
  add(
    "observer_is_independent",
    isSnowflake(actorId) && actorId !== session.initiating_account_id,
    "observer_attestation",
    "The observer must be a different account from the initiating account.",
    "observer_is_initiator",
  );
  const observedAt = toTime(evidence.observed_at);
  add(
    "observation_time_valid",
    observedAt !== null,
    "observer_attestation",
    "Spectator evidence must include an ISO observed_at timestamp.",
    "observation_time_invalid",
  );
  if (observedAt !== null) {
    add(
      "observation_inside_window",
      inWindow(observedAt, session.window),
      "observer_attestation",
      `observed_at must be inside the session window ${session.window.start} to ${session.window.end}.`,
      "observation_outside_window",
    );
    const now = toTime(input.now ?? isoNow()) ?? Date.now();
    add(
      "observation_not_in_future",
      observedAt <= now + 60_000,
      "observer_attestation",
      "observed_at must not be in the future beyond a one-minute clock tolerance.",
      "observation_in_future",
    );
  }
  add(
    "intended_share_observed",
    evidence.observed_intended_share === true,
    "observer_attestation",
    "Spectator evidence must explicitly declare observed_intended_share: true.",
    "intended_share_not_observed",
  );
  const absence = evidence.private_content_absent;
  add(
    "private_content_absent_declared",
    absence === true || absence === false || absence === "unverified",
    "observer_attestation",
    'Spectator evidence must declare private_content_absent: true, false or "unverified".',
    "private_content_absent_missing",
  );
  if (absence === false) {
    add(
      "private_content_absent",
      false,
      "observer_attestation",
      "The observer reported that private content was visible.",
      "private_content_visible",
    );
  } else if (absence === "unverified") {
    add(
      "private_content_absent",
      false,
      "observer_attestation",
      "The observer could not establish that private content was absent; this is not a pass.",
      "private_content_unverified",
    );
  } else if (absence === true) {
    add(
      "private_content_absent",
      true,
      "observer_attestation",
      "The observer declared that private content was absent. This is an attestation, not proof.",
    );
  }

  const hardFailures = report.failures.filter(
    (failure) => failure.code !== "private_content_unverified",
  );
  if (hardFailures.length) {
    report.result = "fail";
    report.evidence_layers.observer_attestation.status = "rejected";
  } else if (report.failures.length) {
    report.result = "partial";
    report.evidence_layers.observer_attestation.status = "partial";
  } else {
    report.result = "pass";
    report.evidence_layers.observer_attestation.status = "attested";
  }
  return report;
}

export function evaluateSession(input = {}) {
  const session = input.session;
  const reports = Array.isArray(input.reports) ? input.reports : [];
  const report = {
    generated_at: isoNow(),
    phase: "session",
    session_id: session?.session_id ?? null,
    result: "fail",
    expected_build: input.expectedBuild ?? null,
    cases: [],
    failures: [],
    totals: {
      expected_cases: Array.isArray(session?.expected_cases) ? session.expected_cases.length : 0,
      reports: reports.length,
      passed_reports: reports.filter((item) => item?.result === "pass").length,
      failed_reports: reports.filter((item) => item?.result === "fail").length,
      pending_reports: reports.filter((item) => item?.result === "pending").length,
      timeout_pending_reports: reports.filter((item) => item?.result === "timeout_pending").length,
    },
    evidence_layers: layerSummary(session),
    limitations: [],
  };
  const sessionValidation = validateSession(session);
  if (!sessionValidation.valid) {
    report.failures.push({
      code: "session_invalid",
      message: `Session is invalid: ${sessionValidation.errors.join(" ")}`,
      layer: "api",
    });
    return report;
  }
  report.limitations.push(...sessionValidation.warnings);
  if (input.expectedBuild && session.build.value !== input.expectedBuild) {
    report.failures.push({
      code: "build_mismatch",
      message: `Session build ${session.build.value} does not match expected build ${input.expectedBuild}.`,
      layer: "api",
    });
  }
  for (const expected of session.expected_cases) {
    const matching = reports.filter(
      (item) =>
        item?.case_id === expected.case_id || item?.expectation?.case_id === expected.case_id,
    );
    if (!matching.length) {
      report.cases.push({
        case_id: expected.case_id,
        label: expected.label,
        kind: expected.kind,
        result: "not_performed",
        failures: [
          {
            code: "case_not_performed",
            message: `No interaction was verified for expected case ${expected.case_id}.`,
            layer: "database",
          },
        ],
      });
      continue;
    }
    const pass = matching.find((item) => item.result === "pass");
    const blocking = matching.filter((item) => item.result !== "pass");
    if (pass && !blocking.length) {
      report.cases.push({
        case_id: expected.case_id,
        label: expected.label,
        kind: expected.kind,
        result: "pass",
        interaction_id: pass.interaction_id,
        failures: [],
      });
      continue;
    }
    const pending = matching.find(
      (item) => item.result === "pending" || item.result === "timeout_pending",
    );
    report.cases.push({
      case_id: expected.case_id,
      label: expected.label,
      kind: expected.kind,
      result: pending?.result ?? "fail",
      interaction_id: pending?.interaction_id ?? matching[0]?.interaction_id ?? null,
      failures: [
        ...blocking.flatMap((item) => item.failures ?? []),
        ...(pass
          ? [
              {
                code: "interaction_not_passed",
                message: `A failed or pending interaction for ${expected.case_id} must not be masked by a pass.`,
                layer: "database",
              },
            ]
          : []),
      ],
    });
  }

  const unexpectedFailures = reports.filter((item) => item?.result !== "pass" && !item?.case_id);
  if (unexpectedFailures.length) {
    report.failures.push({
      code: "unexpected_unbound_interaction",
      message: `${unexpectedFailures.length} interaction report(s) did not bind to an expected case.`,
      layer: "database",
    });
  }
  const passedCases = new Set(
    report.cases.filter((item) => item.result === "pass").map((item) => item.case_id),
  );
  const expectedCaseIds = new Set(session.expected_cases.map((item) => item.case_id));
  const blockingReports = reports.filter((item) => item?.result !== "pass");
  for (const item of blockingReports) {
    if (!item?.case_id) {
      report.failures.push(
        ...(item.failures ?? []).map((failure) => ({
          ...failure,
          interaction_id: item.interaction_id,
        })),
      );
      continue;
    }
    if (!expectedCaseIds.has(item.case_id)) {
      report.failures.push({
        code: "unexpected_interaction_not_passed",
        message: `A ${item.result} interaction for undeclared case ${item.case_id} must not be ignored.`,
        layer: "database",
        interaction_id: item.interaction_id,
        case_id: item.case_id,
      });
      continue;
    }
    if (passedCases.has(item.case_id)) {
      report.failures.push({
        code: "interaction_not_passed",
        message: `A ${item.result} interaction for ${item.case_id} must not be masked by a later pass.`,
        layer: "database",
        interaction_id: item.interaction_id,
        case_id: item.case_id,
      });
    }
  }
  const unresolved = report.cases.filter((item) => item.result !== "pass");
  if (unresolved.length) {
    report.failures.push(
      ...unresolved.flatMap((item) =>
        item.failures.map((failure) => ({
          ...failure,
          case_id: item.case_id,
          interaction_id: item.interaction_id ?? null,
        })),
      ),
    );
  }
  report.result = report.failures.length === 0 && unresolved.length === 0 ? "pass" : "fail";
  return report;
}

/* ------------------------------------------------------------------------- */
/* CLI and D1 read layer                                                      */
/* ------------------------------------------------------------------------- */

function requireSessionField(option, value, fallback) {
  const resolved = value ?? fallback;
  if (!isNonEmptyString(resolved)) {
    throw new Error(
      `Missing ${option}. Pass ${option} explicitly or set the corresponding FOILBURY_DISCORD_* environment variable.`,
    );
  }
  return resolved.trim();
}

function fileTimestamp(value = new Date()) {
  const iso = value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  return iso.replace(/[:.]/g, "-");
}

function writeJson(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.chmodSync(temporary, mode);
  fs.renameSync(temporary, file);
  return file;
}

function writeSession(session) {
  const file = path.join(OUTPUT_DIR, `session-${fileTimestamp(session.window.start)}.json`);
  writeJson(file, session);
  return file;
}

function writeReport(session, phase, report) {
  const file = path.join(
    OUTPUT_DIR,
    `report-${session.session_id}-${phase}-${fileTimestamp()}.json`,
  );
  writeJson(file, report);
  return file;
}

/**
 * A prior --verify report is reusable by --watch only when it is already
 * terminal. This is how a read-only slash command verified with --case keeps
 * its operator attestation when the watcher later re-evaluates the session.
 */
function priorVerifyReports(session) {
  let entries = [];
  try {
    entries = fs
      .readdirSync(OUTPUT_DIR)
      .filter(
        (entry) =>
          entry.startsWith(`report-${session.session_id}-verify-`) && entry.endsWith(".json"),
      )
      .sort();
  } catch {
    return new Map();
  }
  const reports = new Map();
  for (const entry of entries) {
    try {
      const report = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, entry), "utf8"));
      if (!report?.interaction_id) continue;
      if (report.session_id !== session.session_id) continue;
      if (!["pass", "fail"].includes(report.result)) continue;
      if (
        report.result === "fail" &&
        report.failures?.some((failure) =>
          ["command_ambiguous_read_only", "command_not_expected"].includes(failure.code),
        )
      ) {
        // An unbound read-only interaction may be corrected by a later
        // --verify --case; let the live row and the newer report win.
        continue;
      }
      reports.set(report.interaction_id, report);
    } catch {
      // Ignore a partial report; the live interaction remains authoritative.
    }
  }
  return reports;
}

function isSessionFile(entry) {
  return /^session-\d{4}-\d{2}-\d{2}T[0-9-]+Z\.json$/.test(entry);
}

function resolveSessionFile(explicit) {
  if (isNonEmptyString(explicit)) {
    return path.isAbsolute(explicit) ? explicit : path.resolve(ROOT, explicit);
  }
  let entries = [];
  try {
    entries = fs.readdirSync(OUTPUT_DIR).filter(isSessionFile).sort();
  } catch {
    entries = [];
  }
  if (!entries.length) {
    throw new Error(
      `No acceptance session found in ${path.relative(ROOT, OUTPUT_DIR)}. Run --prepare first or pass --session.`,
    );
  }
  return path.join(OUTPUT_DIR, entries[entries.length - 1]);
}

function readSessionFile(file) {
  const session = JSON.parse(fs.readFileSync(file, "utf8"));
  return { file, session };
}

function findLocalDatabase() {
  const base = path.join(ROOT, ".wrangler/state/v3/d1");
  if (!fs.existsSync(base)) return null;
  for (const entry of fs.readdirSync(base, { recursive: true })) {
    const file = path.join(base, String(entry));
    if (!file.endsWith(".sqlite") || file.endsWith("metadata.sqlite")) continue;
    try {
      const tables = execFileSync(
        "sqlite3",
        [
          file,
          "SELECT name FROM sqlite_master WHERE type='table' AND name='fb_discord_interactions';",
        ],
        { encoding: "utf8" },
      ).trim();
      if (tables) return file;
    } catch {
      // Another local state file may not be a Foilbury database.
    }
  }
  return null;
}

function readRows(sql, useLocal) {
  if (useLocal) {
    const file = findLocalDatabase();
    if (!file) throw new Error("Local D1 database not found. Run pnpm setup:local.");
    const output = execFileSync("sqlite3", ["-json", file, sql], { encoding: "utf8" }).trim();
    return output ? JSON.parse(output) : [];
  }
  const output = execFileSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "execute",
      "foilbury",
      "--config",
      "wrangler.production.jsonc",
      "--remote",
      "--json",
      "--command",
      sql,
    ],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  const parsed = JSON.parse(output.slice(output.indexOf("[")));
  return Array.isArray(parsed) ? (parsed[0]?.results ?? []) : (parsed.results ?? []);
}

const INTERACTION_COLUMNS = `interaction_id, application_id, guild_id, channel_id, discord_user_id,
  command_name, status, error_code, receipt_kind, receipt_json, delivery_visibility,
  created_at, completed_at`;

function interactionRow(interactionId, useLocal) {
  return (
    readRows(
      `SELECT ${INTERACTION_COLUMNS} FROM fb_discord_interactions
        WHERE interaction_id = ${sqlString(interactionId)}`,
      useLocal,
    )[0] ?? null
  );
}

function collectEvidence(interactionId, session, { minimal = false } = {}) {
  const useLocal = session.environment === "local";
  const interaction = interactionRow(interactionId, useLocal);
  const evidence = {
    interaction,
    installation: null,
    identity: null,
    draw: null,
    instance: null,
    drawInstances: [],
    priorLedger: null,
    ledger: [],
    achievementUnlocks: [],
    rewardClaims: [],
    shares: [],
    drawCandidates: [],
    wallet: null,
  };
  if (!interaction) return evidence;

  const installation =
    readRows(
      `SELECT id, tenant_id, guild_id, application_id, active, revoked_at
         FROM fb_discord_installations
        WHERE guild_id = ${sqlString(interaction.guild_id)}
          AND application_id = ${sqlString(interaction.application_id)}
        ORDER BY active DESC LIMIT 1`,
      useLocal,
    )[0] ?? null;
  evidence.installation = installation;
  const tenantId = installation?.tenant_id ?? null;
  if (!tenantId) return evidence;

  const identity =
    readRows(
      `SELECT tenant_id, user_id, discord_user_id
         FROM fb_discord_identities
        WHERE tenant_id = ${sqlString(tenantId)}
          AND discord_user_id = ${sqlString(interaction.discord_user_id)}
          AND revoked_at IS NULL LIMIT 1`,
      useLocal,
    )[0] ?? null;
  evidence.identity = identity;
  if (minimal || !identity?.user_id) return evidence;

  const userId = identity.user_id;
  const receipt = parseReceipt(interaction.receipt_json);
  const drawId = receipt.ok ? receipt.value.draw_id : null;
  if (drawId) {
    evidence.draw =
      readRows(
        `SELECT id, tenant_id, user_id, pool_id, pool_revision, price, variant_id,
                instance_id, created_at, idempotency_key, receipt_json
           FROM fb_draws
          WHERE id = ${sqlString(drawId)}
            AND tenant_id = ${sqlString(tenantId)}
            AND user_id = ${sqlString(userId)} LIMIT 1`,
        useLocal,
      )[0] ?? null;
  }
  const instanceId = receipt.ok ? receipt.value.instance_id : null;
  if (instanceId) {
    evidence.instance =
      readRows(
        `SELECT id, tenant_id, user_id, card_id, variant_id, serial, status,
                acquired_via, acquired_at
           FROM fb_card_instances
          WHERE id = ${sqlString(instanceId)}
            AND tenant_id = ${sqlString(tenantId)}
            AND user_id = ${sqlString(userId)} LIMIT 1`,
        useLocal,
      )[0] ?? null;
  }
  if (drawId) {
    evidence.drawInstances = readRows(
      `SELECT ci.id, ci.tenant_id, ci.user_id, ci.card_id, ci.variant_id, ci.serial,
              ci.status, ci.acquired_via, ci.acquired_at
         FROM fb_card_instances ci
         JOIN fb_instance_history ih
           ON ih.instance_id = ci.id AND ih.tenant_id = ci.tenant_id
        WHERE ih.tenant_id = ${sqlString(tenantId)}
          AND ih.reference_type = 'draw'
          AND ih.reference_id = ${sqlString(drawId)}
          AND ci.status IN ('owned','reserved')`,
      useLocal,
    );
  }

  const windowStart = interaction.created_at;
  const windowEnd = interaction.completed_at || isoNow();
  evidence.ledger = readRows(
    `SELECT id, tenant_id, user_id, kind, amount, balance_after, reference_type,
            reference_id, description, idempotency_key, metadata_json, created_at
       FROM fb_ledger_entries
      WHERE tenant_id = ${sqlString(tenantId)}
        AND user_id = ${sqlString(userId)}
        AND created_at >= ${sqlString(windowStart)}
        AND created_at <= ${sqlString(windowEnd)}
      ORDER BY created_at, id`,
    useLocal,
  );
  const priorCreatedAt = evidence.draw?.created_at || interaction.created_at;
  evidence.priorLedger =
    readRows(
      `SELECT id, tenant_id, user_id, kind, amount, balance_after, reference_type,
              reference_id, description, idempotency_key, created_at
         FROM fb_ledger_entries
        WHERE tenant_id = ${sqlString(tenantId)}
          AND user_id = ${sqlString(userId)}
          AND created_at < ${sqlString(priorCreatedAt)}
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      useLocal,
    )[0] ?? null;
  evidence.achievementUnlocks = readRows(
    `SELECT id, tenant_id, user_id, achievement_id, achievement_version,
            reward_state, reward_amount, reward_ledger_id, earned_at
       FROM fb_achievement_unlocks
      WHERE tenant_id = ${sqlString(tenantId)}
        AND user_id = ${sqlString(userId)}
        AND earned_at >= ${sqlString(windowStart)}
        AND earned_at <= ${sqlString(windowEnd)}
      ORDER BY earned_at`,
    useLocal,
  );
  evidence.rewardClaims = readRows(
    `SELECT id, tenant_id, user_id, rule_key, rule_version, period_key, amount,
            created_at, idempotency_key
       FROM fb_reward_claims
      WHERE tenant_id = ${sqlString(tenantId)}
        AND user_id = ${sqlString(userId)}
        AND (idempotency_key = ${sqlString(`discord:${interaction.interaction_id}:daily`)}
             OR (created_at >= ${sqlString(windowStart)} AND created_at <= ${sqlString(windowEnd)}))
      ORDER BY created_at`,
    useLocal,
  );
  const shareEnd = new Date(
    (Number.isFinite(Date.parse(windowEnd)) ? Date.parse(windowEnd) : Date.now()) + 5_000,
  ).toISOString();
  evidence.shares = readRows(
    `SELECT id, tenant_id, user_id, channel_id, object_type, object_id, message_id, created_at
       FROM fb_discord_shares
      WHERE tenant_id = ${sqlString(tenantId)}
        AND user_id = ${sqlString(userId)}
        AND channel_id = ${sqlString(interaction.channel_id)}
        AND created_at >= ${sqlString(windowStart)}
        AND created_at <= ${sqlString(shareEnd)}
      ORDER BY created_at`,
    useLocal,
  );
  evidence.drawCandidates = readRows(
    `SELECT id, tenant_id, user_id, pool_id, price, variant_id, instance_id,
            created_at, idempotency_key, receipt_json
       FROM fb_draws
      WHERE tenant_id = ${sqlString(tenantId)}
        AND user_id = ${sqlString(userId)}
        AND (idempotency_key = ${sqlString(`discord:${interaction.interaction_id}:open`)}
             OR id = ${sqlString(drawId ?? "")})`,
    useLocal,
  );
  evidence.wallet =
    readRows(
      `SELECT w.balance, e.currency_symbol
         FROM fb_wallets w
         JOIN fb_economy_settings e ON e.tenant_id = w.tenant_id
        WHERE w.tenant_id = ${sqlString(tenantId)}
          AND w.user_id = ${sqlString(userId)} LIMIT 1`,
      useLocal,
    )[0] ?? null;
  return evidence;
}

function listSessionInteractions(session) {
  const useLocal = session.environment === "local";
  const end = toTime(session.window.end) < Date.now() ? session.window.end : isoNow();
  return readRows(
    `SELECT ${INTERACTION_COLUMNS}
       FROM fb_discord_interactions
      WHERE guild_id = ${sqlString(session.guild_id)}
        AND channel_id = ${sqlString(session.channel_id)}
        AND discord_user_id = ${sqlString(session.initiating_account_id)}
        AND created_at >= ${sqlString(session.window.start)}
        AND created_at <= ${sqlString(end)}
      ORDER BY created_at, interaction_id`,
    useLocal,
  );
}

function evaluateWithEvidence(session, evidence, extra = {}) {
  return evaluateInteraction({
    session,
    ...evidence,
    ...extra,
  });
}

function sessionFileInstruction(file) {
  return path.relative(ROOT, file);
}

function expectedInstructions(session, file) {
  const lines = [
    `In the authorised channel, as the genuine signed-in Discord account ${session.initiating_account_id}:`,
  ];
  let index = 0;
  for (const item of session.expected_cases) {
    index += 1;
    lines.push(
      `${index}. ${item.label} — record the interaction id, then run:`,
      `   node scripts/discord/assisted-acceptance.mjs --verify <interaction-id> --session ${sessionFileInstruction(file)} --case ${item.case_id}`,
    );
  }
  lines.push(
    "",
    "Read-only slash commands store only the top-level foilbury command in D1; --case binds the prepared read-only subcommand as an operator attestation.",
    'After the real commands, have an independent authorised observer write a spectator JSON file with session_id, guild_id, channel_id, message_id, actor_id, observed_at, observed_intended_share: true and private_content_absent (true, false or "unverified").',
    "That spectator file is an attestation, not proof. Do not claim a screenshot or API read-back proves absence.",
    "Never paste an interaction token, cookie, password or private message content into evidence.",
  );
  return lines;
}

async function readStatus(origin) {
  const url = new URL("/api/v1/status", origin).toString();
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  const bodyText = await response.text();
  let body = null;
  try {
    body = JSON.parse(bodyText);
  } catch {
    body = null;
  }
  return {
    http_status: response.status,
    ok: response.ok,
    build: response.headers.get(BUILD_HEADER),
    body,
  };
}

function discoverWorkerVersion() {
  if (isNonEmptyString(process.env.FOILBURY_WORKER_VERSION)) {
    return { value: process.env.FOILBURY_WORKER_VERSION.trim(), source: "environment" };
  }
  if (!process.env.CLOUDFLARE_API_TOKEN) {
    return { value: null, source: "not_discoverable" };
  }
  try {
    const output = execFileSync(
      path.join(ROOT, "node_modules/.bin/wrangler"),
      ["deployments", "list", "--config", "wrangler.production.jsonc", "--json"],
      {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const parsed = JSON.parse(output.slice(output.indexOf("[")));
    const first = Array.isArray(parsed) ? parsed[0] : null;
    const value = first?.id ?? first?.version ?? first?.version_id ?? null;
    return isNonEmptyString(value)
      ? { value: String(value), source: "wrangler_deployments_list" }
      : { value: null, source: "not_discoverable" };
  } catch {
    return { value: null, source: "not_discoverable" };
  }
}

function parseArgs(argv) {
  const option = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    args: argv,
    option,
    has: (name) => argv.includes(name),
  };
}

async function prepareCommand(cli) {
  const explicitEnvironment = cli.option("--environment");
  const environment = cli.has("--local")
    ? "local"
    : explicitEnvironment === "local"
      ? "local"
      : explicitEnvironment === "production"
        ? "production"
        : "production";
  if (explicitEnvironment && !["local", "production"].includes(explicitEnvironment)) {
    throw new Error("--environment must be local or production.");
  }
  const origin =
    cli.option("--origin") ??
    process.env.FOILBURY_ORIGIN ??
    (environment === "local" ? "http://localhost:5173" : "https://foilbury.loftwah.com");
  const guildId = requireSessionField(
    "--guild",
    cli.option("--guild"),
    process.env.FOILBURY_DISCORD_GUILD_ID,
  );
  const channelId = requireSessionField(
    "--channel",
    cli.option("--channel"),
    process.env.FOILBURY_DISCORD_CHANNEL_ID,
  );
  const actorId = requireSessionField(
    "--actor",
    cli.option("--actor"),
    process.env.FOILBURY_DISCORD_ACTOR_ID,
  );
  if (!isSnowflake(guildId) || !isSnowflake(channelId) || !isSnowflake(actorId)) {
    throw new Error("--guild, --channel and --actor must be Discord snowflakes.");
  }
  const minutes = Number(cli.option("--minutes") ?? 60);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 24 * 60) {
    throw new Error("--minutes for --prepare must be between 1 and 1440.");
  }
  const requestedCases = cli
    .option("--cases")
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const expectedCases = requestedCases?.length
    ? requestedCases.map((caseId) => {
        const found = DEFAULT_EXPECTED_CASES.find((item) => item.case_id === caseId);
        if (!found) throw new Error(`--cases contains unknown case ${caseId}.`);
        return found;
      })
    : DEFAULT_EXPECTED_CASES;
  const status = await readStatus(origin);
  if (!status.ok) {
    throw new Error(`${origin}/api/v1/status returned HTTP ${status.http_status}.`);
  }
  const expectedBuild = cli.option("--expect-build");
  if (expectedBuild && status.build !== expectedBuild) {
    throw new Error(
      `Build mismatch: ${origin} reports ${status.build ?? "(no ${BUILD_HEADER})"} but --expect-build is ${expectedBuild}.`,
    );
  }
  const worker = discoverWorkerVersion();
  const explicitWorkerVersion = cli.option("--worker-version");
  const session = buildSession({
    environment,
    origin,
    status: {
      http_status: status.http_status,
      header: BUILD_HEADER,
      value: status.build,
      checked_at: isoNow(),
    },
    workerVersion: explicitWorkerVersion ?? worker.value,
    workerVersionSource: explicitWorkerVersion ? "operator" : worker.source,
    guildId,
    channelId,
    actorId,
    startedAt: isoNow(),
    durationMinutes: minutes,
    expectedCases,
  });
  const validation = validateSession(session);
  if (!validation.valid) {
    throw new Error(`Session was not prepared: ${validation.errors.join(" ")}`);
  }
  const file = writeSession(session);
  console.log(`Assisted Discord acceptance · ${environment}`);
  console.log(`Session: ${sessionFileInstruction(file)}`);
  console.log(`Origin: ${session.origin}`);
  console.log(`Build: ${session.build.value ?? "(unavailable)"}`);
  console.log(`Worker version: ${session.worker_version ?? "(not discoverable)"}`);
  console.log(`Guild: ${session.guild_id}`);
  console.log(`Channel: ${session.channel_id}`);
  console.log(`Actor: ${session.initiating_account_id}`);
  console.log(`Window: ${session.window.start} to ${session.window.end}`);
  console.log("");
  expectedInstructions(session, file).forEach((line) => console.log(line));
  return 0;
}

function sessionContext(cli) {
  const file = resolveSessionFile(cli.option("--session"));
  const loaded = readSessionFile(file);
  if (cli.has("--local") && loaded.session.environment !== "local") {
    throw new Error("--local does not match a production acceptance session.");
  }
  if (cli.has("--production") && loaded.session.environment !== "production") {
    throw new Error("--production does not match a local acceptance session.");
  }
  return { file, session: loaded.session };
}

async function verifyCommand(cli) {
  const interactionId = cli.option("--verify");
  if (!isNonEmptyString(interactionId)) throw new Error("--verify needs an interaction id.");
  const { file, session } = sessionContext(cli);
  const caseId = cli.option("--case");
  const attestation = isNonEmptyString(caseId)
    ? { case_id: caseId.trim(), layer: "operator_attestation" }
    : undefined;
  const evidence = collectEvidence(interactionId.trim(), session);
  const report = evaluateWithEvidence(session, evidence, {
    commandAttestation: attestation,
    expectedBuild: cli.option("--expect-build"),
    environment: cli.has("--local")
      ? "local"
      : cli.has("--production")
        ? "production"
        : session.environment,
  });
  report.session_file = sessionFileInstruction(file);
  const reportFile = writeReport(session, "verify", report);
  console.log(JSON.stringify(report, null, 2));
  console.log(`Evidence written to ${path.relative(ROOT, reportFile)}`);
  return report.result === "pass" ? 0 : 2;
}

async function watchCommand(cli) {
  const { file, session } = sessionContext(cli);
  const minutes = Number(cli.option("--minutes") ?? DEFAULT_WATCH_MINUTES);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > MAX_WATCH_MINUTES) {
    throw new Error(`--minutes for --watch must be between 1 and ${MAX_WATCH_MINUTES}.`);
  }
  const deadline = Date.now() + minutes * 60_000;
  const terminal = new Map();
  const latestPending = new Map();
  const printed = new Map();
  const print = (report) => {
    const signature = `${report.result}:${report.status}:${report.error_code ?? ""}`;
    if (printed.get(report.interaction_id) === signature) return;
    printed.set(report.interaction_id, signature);
    console.log(
      `${report.result.toUpperCase()} ${report.case_id ?? report.command ?? "unknown"} · ${report.status ?? "unknown"} · ${report.delivery_visibility ?? report.expectation?.delivery ?? "unknown"}`,
    );
  };

  while (Date.now() <= deadline) {
    const interactions = listSessionInteractions(session);
    const prior = priorVerifyReports(session);
    for (const interaction of interactions) {
      const id = interaction.interaction_id;
      if (terminal.has(id)) continue;
      const priorReport = prior.get(id);
      if (priorReport && ["completed", "failed"].includes(interaction.status)) {
        terminal.set(id, priorReport);
        latestPending.delete(id);
        print(priorReport);
        continue;
      }
      if (interaction.status === "processing") {
        const evidence = collectEvidence(id, session, { minimal: true });
        const report = evaluateWithEvidence(session, evidence);
        latestPending.set(id, report);
        print(report);
        continue;
      }
      const evidence = collectEvidence(id, session);
      const report = evaluateWithEvidence(session, evidence);
      if (
        report.result === "fail" &&
        report.failures.some((failure) =>
          ["command_ambiguous_read_only", "command_not_expected"].includes(failure.code),
        )
      ) {
        // A later --verify --case can bind this interaction. Do not terminalise
        // the ambiguity; keep re-evaluating until the bounded watch ends.
        latestPending.set(id, report);
        print(report);
        continue;
      }
      terminal.set(id, report);
      latestPending.delete(id);
      print(report);
    }
    const currentReports = [...terminal.values(), ...latestPending.values()];
    const summary = evaluateSession({
      session,
      reports: currentReports,
      expectedBuild: cli.option("--expect-build"),
    });
    const stillProcessing = interactions.some(
      (interaction) =>
        interaction.status === "processing" && !terminal.has(interaction.interaction_id),
    );
    if (!stillProcessing && summary.result === "pass") break;
    if (Date.now() + 3_000 > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }

  const finalRows = listSessionInteractions(session);
  const finalPrior = priorVerifyReports(session);
  for (const interaction of finalRows) {
    const id = interaction.interaction_id;
    if (terminal.has(id)) continue;
    const priorReport = finalPrior.get(id);
    if (priorReport && ["completed", "failed"].includes(interaction.status)) {
      terminal.set(id, priorReport);
      latestPending.delete(id);
    }
    if (terminal.has(id)) continue;
    const evidence =
      interaction.status === "processing"
        ? collectEvidence(id, session, { minimal: true })
        : collectEvidence(id, session);
    const report = evaluateWithEvidence(session, evidence);
    if (interaction.status === "processing") {
      report.result = "timeout_pending";
      report.failures.push({
        code: "timeout_pending",
        message: `Interaction stayed processing for the bounded ${minutes}-minute watch window.`,
        layer: "database",
      });
      report.limitations.push(
        "timeout_pending is not a pass. Inspect the Worker logs and retry the acceptance step with a new interaction.",
      );
    }
    latestPending.set(id, report);
  }
  const reports = [...terminal.values(), ...latestPending.values()];
  const summary = evaluateSession({
    session,
    reports,
    expectedBuild: cli.option("--expect-build"),
  });
  const payload = {
    phase: "watch",
    session_file: sessionFileInstruction(file),
    minutes,
    started_at: session.window.start,
    ended_at: isoNow(),
    boundary: session.window.end,
    reports,
    summary,
  };
  const reportFile = writeReport(session, "watch", payload);
  console.log(JSON.stringify(payload, null, 2));
  console.log(`Evidence written to ${path.relative(ROOT, reportFile)}`);
  return summary.result === "pass" ? 0 : 2;
}

async function spectatorCommand(cli) {
  const file = cli.option("--spectator");
  if (!isNonEmptyString(file)) throw new Error("--spectator needs an evidence file.");
  const resolved = path.isAbsolute(file) ? file : path.resolve(ROOT, file);
  const evidence = JSON.parse(fs.readFileSync(resolved, "utf8"));
  const { file: sessionFile, session } = sessionContext(cli);
  const report = evaluateSpectator({ session, evidence });
  report.session_file = sessionFileInstruction(sessionFile);
  const reportFile = writeReport(session, "spectator", report);
  console.log(JSON.stringify(report, null, 2));
  console.log(`Evidence written to ${path.relative(ROOT, reportFile)}`);
  return report.result === "pass" ? 0 : 2;
}

function usage() {
  console.error(
    [
      "Use --prepare, --verify <id>, --watch or --spectator <file>.",
      "",
      "  --prepare --guild <id> --channel <id> --actor <id> [--local] [--minutes 60]",
      "             [--cases help,tour,packs,profile,collection,achievements,daily,mission,open,share]",
      "  --verify <interaction-id> [--session <file>] [--case <case-id>] [--expect-build <sha>]",
      "  --watch [--session <file>] [--minutes 10] [--expect-build <sha>]",
      "  --spectator <evidence.json> [--session <file>]",
      "",
      "Guild, channel and actor may come from FOILBURY_DISCORD_GUILD_ID,",
      "FOILBURY_DISCORD_CHANNEL_ID and FOILBURY_DISCORD_ACTOR_ID.",
    ].join("\n"),
  );
}

async function main(argv = process.argv.slice(2)) {
  const cli = parseArgs(argv);
  if (cli.has("--help")) {
    usage();
    return 0;
  }
  if (cli.has("--prepare")) return prepareCommand(cli);
  if (cli.option("--verify")) return verifyCommand(cli);
  if (cli.has("--watch")) return watchCommand(cli);
  if (cli.option("--spectator")) return spectatorCommand(cli);
  usage();
  return 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath && invokedPath === import.meta.url) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      if (process.env.DEBUG) console.error(error?.stack ?? String(error));
      else console.error(error?.message ?? String(error));
      process.exitCode = 1;
    });
}
