#!/usr/bin/env node
/**
 * Foilbury Discord setup — approval-gated apply and read-only verify.
 *
 * This script refuses to write unless ALL of the following are supplied:
 *   --apply
 *   --plan <the exact plan id or digest printed by setup-plan.mjs>
 *   --guild <the exact bound guild id>
 *
 * It also recomputes the plan digest from the plan contents, re-reads the live
 * guild, aborts on drift, saves a reversible pre-apply snapshot, preserves
 * unrelated channel overwrites and never deletes or renames a channel.
 *
 * Usage:
 *   node scripts/discord/setup-apply.mjs --guild <id> --plan <id> --apply
 *   node scripts/discord/setup-apply.mjs --guild <id> --plan <id> --verify
 *   node scripts/discord/setup-apply.mjs --guild <id> --plan <id> --verify --json
 *
 * `--verify` is read-only. There is no default apply.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  BOUND_GUILD_ENV,
  DEFAULT_OUT_DIR,
  DiscordApiError,
  PERMISSIONS,
  PLAN_SCHEMA,
  REQUIRED_BOT_PERMISSIONS,
  buildFindings,
  collectSnapshot,
  computePlanDigest,
  createDiscordClient,
  findChannel,
  findChannelByName,
  loadDiscordConfig,
  normalizeOverwrites,
  permissionMask,
} from "./setup-plan.mjs";

const APPLY_SCHEMA = "foilbury.discord.setup-apply-receipt.v1";
const VERIFY_SCHEMA = "foilbury.discord.setup-verify.v1";

class RefusalError extends Error {
  constructor(message) {
    super(message);
    this.name = "RefusalError";
  }
}

function parseArgs(argv) {
  const options = {
    apply: false,
    verify: false,
    json: false,
    help: false,
    plan: null,
    guild: null,
    planFile: path.join(DEFAULT_OUT_DIR, "plan.json"),
    out: DEFAULT_OUT_DIR,
    receipt: null,
  };
  const valueArguments = new Set(["--plan", "--guild", "--plan-file", "--out", "--receipt"]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (valueArguments.has(argument)) {
      const value = argv[(index += 1)];
      if (!value || value.startsWith("--")) throw new RefusalError(`${argument} requires a value.`);
      if (argument === "--plan") options.plan = value.trim();
      if (argument === "--guild") options.guild = value.trim();
      if (argument === "--plan-file") options.planFile = path.resolve(value);
      if (argument === "--out") options.out = path.resolve(value);
      if (argument === "--receipt") options.receipt = path.resolve(value);
      continue;
    }
    if (argument === "--apply") {
      options.apply = true;
      continue;
    }
    if (argument === "--verify") {
      options.verify = true;
      continue;
    }
    if (argument === "--json") {
      options.json = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    throw new RefusalError(`Unknown argument: ${argument}`);
  }
  if (!options.receipt) options.receipt = path.join(options.out, "apply", "receipt.json");
  return options;
}

function readJson(file) {
  if (!fs.existsSync(file)) throw new RefusalError(`Plan file not found: ${file}`);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new RefusalError(`Plan file is not valid JSON: ${error?.message ?? error}`);
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
}

function writeText(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, value, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function now() {
  return new Date().toISOString();
}

function validatePlan(plan, options, config) {
  if (!plan || plan.schema !== PLAN_SCHEMA) {
    throw new RefusalError(`Plan schema must be ${PLAN_SCHEMA}.`);
  }
  if (!options.plan) {
    throw new RefusalError(
      "--plan <plan id or digest> is required. Copy it from the dry-run output; a boolean is not an approval.",
    );
  }
  if (!options.guild) {
    throw new RefusalError(
      "--guild <id> is required. Apply refuses to infer the target from the plan alone.",
    );
  }
  if (!config.guildId) {
    throw new RefusalError(
      `${BOUND_GUILD_ENV} is missing from .env; the guild binding is unknown.`,
    );
  }
  if (options.guild !== config.guildId) {
    throw new RefusalError(
      `Guild ${options.guild} is not the bound guild ${config.guildId}. Refusing any other guild.`,
    );
  }
  if (plan.target?.guild_id !== options.guild) {
    throw new RefusalError(
      `Plan target ${plan.target?.guild_id ?? "unknown"} does not match --guild ${options.guild}.`,
    );
  }
  if (plan.target?.guild_id !== config.guildId || plan.snapshot?.guild?.id !== config.guildId) {
    throw new RefusalError("The plan snapshot and target do not both name the bound guild.");
  }
  if (plan.target?.application_id !== config.applicationId) {
    throw new RefusalError(
      `Plan application ${plan.target?.application_id ?? "unknown"} does not match ${config.applicationId}.`,
    );
  }
  if (plan.target?.reused_channel_id !== config.channelId) {
    throw new RefusalError(
      `Plan reuses channel ${plan.target?.reused_channel_id ?? "unknown"}, not configured ${config.channelId}.`,
    );
  }

  const recomputed = computePlanDigest(plan);
  if (recomputed !== plan.digest) {
    throw new RefusalError(
      "Plan digest does not match its contents. The plan was edited after generation; regenerate it.",
    );
  }
  const expectedPlanId = plan.digest.slice(0, 16);
  if (plan.plan_id !== expectedPlanId) {
    throw new RefusalError(
      `Plan id ${plan.plan_id} is not derived from digest ${plan.digest}. Refusing a tampered plan.`,
    );
  }
  if (options.plan !== plan.digest && options.plan !== expectedPlanId) {
    throw new RefusalError(
      `--plan ${options.plan} does not match this plan (${expectedPlanId} / ${plan.digest}).`,
    );
  }

  const actions = plan.proposal?.actions;
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new RefusalError("The plan contains no actions.");
  }
  const snapshotChannelIds = new Set((plan.snapshot?.channels ?? []).map((channel) => channel.id));
  for (const action of actions) {
    if (!["create_channel", "edit_channel"].includes(action.op)) {
      throw new RefusalError(
        `Action ${action.id} uses unsupported op ${action.op}. Only channel/category creation and edits are allowed.`,
      );
    }
    if (![0, 4].includes(action.payload?.type) && action.op === "create_channel") {
      throw new RefusalError(`Action ${action.id} uses unsupported channel type.`);
    }
    if (action.op === "edit_channel" && action.payload?.name !== undefined) {
      throw new RefusalError(`Action ${action.id} attempts a channel rename. Refusing.`);
    }
    if (action.payload?.parent_id && action.payload?.parent_ref) {
      throw new RefusalError(`Action ${action.id} has both parent_id and parent_ref.`);
    }
    if (action.resource_id && !snapshotChannelIds.has(action.resource_id)) {
      throw new RefusalError(
        `Action ${action.id} targets ${action.resource_id}, which is not a channel in the approved snapshot.`,
      );
    }
    if (action.payload?.parent_id && !snapshotChannelIds.has(action.payload.parent_id)) {
      throw new RefusalError(`Action ${action.id} targets a parent outside the approved snapshot.`);
    }
    const overwriteTargets = new Set();
    for (const spec of action.payload?.permission_overwrites ?? []) {
      if (!Array.isArray(spec.allow) || !Array.isArray(spec.deny)) {
        throw new RefusalError(`Action ${action.id} has a malformed overwrite. Refusing.`);
      }
      if (overwriteTargets.has(spec.target_id)) {
        throw new RefusalError(`Action ${action.id} repeats overwrite target ${spec.target_id}.`);
      }
      overwriteTargets.add(spec.target_id);
      for (const permission of [...(spec.allow ?? []), ...(spec.deny ?? [])]) {
        if (!PERMISSIONS[permission]) {
          throw new RefusalError(
            `Action ${action.id} uses unknown permission ${permission}. Refusing.`,
          );
        }
      }
      if (spec.target === "@everyone") {
        if (spec.target_id !== plan.target.guild_id) {
          throw new RefusalError(
            `Action ${action.id} has an @everyone overwrite for another guild.`,
          );
        }
      } else if (spec.target === "bot_member") {
        if (spec.target_id !== plan.snapshot.bot_user.id) {
          throw new RefusalError(`Action ${action.id} has a bot overwrite for another user.`);
        }
      } else {
        throw new RefusalError(
          `Action ${action.id} uses an unsupported overwrite target ${spec.target}.`,
        );
      }
    }
  }
  if (plan.snapshot?.bot_user?.id !== plan.snapshot?.application?.id) {
    throw new RefusalError("The plan snapshot's bot user and application IDs are inconsistent.");
  }
}

function preflight(plan, snapshot, config, { requireWritePermissions = false } = {}) {
  const problems = [];
  if (snapshot.guild.id !== config.guildId) {
    problems.push(`live guild ${snapshot.guild.id} is not the bound ${config.guildId}`);
  }
  if (snapshot.application.id !== config.applicationId) {
    problems.push(`live application ${snapshot.application.id} is not ${config.applicationId}`);
  }
  if (snapshot.bot_user.id !== plan.snapshot.bot_user.id) {
    problems.push(
      `live bot user ${snapshot.bot_user.id} is not the planned ${plan.snapshot.bot_user.id}`,
    );
  }
  if (requireWritePermissions) {
    const missing = REQUIRED_BOT_PERMISSIONS.filter(
      (name) =>
        (BigInt(snapshot.bot_member.guild_permissions.bits) & permissionMask([name])) === 0n &&
        !snapshot.bot_member.administrator,
    );
    if (missing.length) {
      problems.push(`bot is missing guild permissions: ${missing.join(", ")}`);
    }
  }
  const testChannel = findChannel(snapshot, config.channelId);
  if (!testChannel) {
    problems.push(`reused channel ${config.channelId} is missing`);
  } else if (testChannel.name !== "card-collector-test") {
    problems.push(`reused channel is now #${testChannel.name}, not #card-collector-test`);
  } else if (requireWritePermissions) {
    const runtimePermissions = [
      "VIEW_CHANNEL",
      "SEND_MESSAGES",
      "EMBED_LINKS",
      "ATTACH_FILES",
      "READ_MESSAGE_HISTORY",
    ];
    const missingChannel = runtimePermissions.filter(
      (name) => (BigInt(testChannel.bot_permissions.bits) & permissionMask([name])) === 0n,
    );
    if (missingChannel.length) {
      problems.push(
        `bot lacks effective channel permissions in #${testChannel.name}: ${missingChannel.join(", ")}`,
      );
    }
  }
  if (problems.length) {
    throw new RefusalError(`Preflight refused before any write: ${problems.join("; ")}.`);
  }
}

export function materializeOverwrites(specs = []) {
  return specs.map((spec) => {
    if (!spec.target_id || !spec.target) {
      throw new RefusalError(
        `Overwrite spec is missing target information: ${JSON.stringify(spec)}`,
      );
    }
    const type = spec.target === "@everyone" ? 0 : 1;
    return {
      id: spec.target_id,
      type,
      allow: permissionMask(spec.allow).toString(),
      deny: permissionMask(spec.deny).toString(),
    };
  });
}

function desiredOverwrite(spec) {
  return {
    allow: permissionMask(spec.allow).toString(),
    deny: permissionMask(spec.deny).toString(),
  };
}

function currentChannelState(channel, guildId) {
  return {
    exists: true,
    name: channel.name,
    type: channel.type,
    topic: channel.topic ?? null,
    parent_id: channel.parent_id ?? null,
    permission_overwrites: normalizeOverwrites(channel.permission_overwrites, guildId).map(
      ({ id, type, allow, deny }) => ({ id, type, allow, deny }),
    ),
  };
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(",")}}`;
}

function resolveParentId(action, refs, snapshot) {
  if (!action.payload?.parent_ref) return action.payload?.parent_id ?? null;
  const existing = findChannelByName(snapshot, "Foilbury", 4);
  const id = refs.get(action.payload.parent_ref) ?? existing?.id;
  if (!id) throw new RefusalError(`Cannot resolve parent_ref ${action.payload.parent_ref}.`);
  return id;
}

function findExistingCreateTarget(action, snapshot, refs) {
  if (action.kind === "category") {
    return findChannelByName(snapshot, action.payload.name, 4);
  }
  const parentId = resolveParentId(action, refs, snapshot);
  const exact = findChannelByName(snapshot, action.payload.name, action.payload.type, parentId);
  if (exact) return exact;
  // A same-named channel elsewhere in the guild is a duplicate, not a safe
  // target. Return it so the caller reports drift instead of creating twice.
  return (
    snapshot.channels.find(
      (channel) => channel.name === action.payload.name && channel.type === action.payload.type,
    ) ?? null
  );
}

function managedOverwritesMatch(channel, specs) {
  for (const spec of specs) {
    const existing = (channel.permission_overwrites ?? []).find(
      (overwrite) => overwrite.id === spec.target_id,
    );
    const desired = desiredOverwrite(spec);
    if (!existing) return false;
    if (String(BigInt(existing.allow)) !== desired.allow) return false;
    if (String(BigInt(existing.deny)) !== desired.deny) return false;
  }
  return true;
}

function fullOverwritesMatch(channel, specs) {
  const desired = materializeOverwrites(specs).sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  const live = [...(channel.permission_overwrites ?? [])]
    .map((overwrite) => ({
      id: overwrite.id,
      type: overwrite.type,
      allow: String(BigInt(overwrite.allow)),
      deny: String(BigInt(overwrite.deny)),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return canonical(desired) === canonical(live);
}

export function createTargetMatches(action, channel, snapshot, refs) {
  if (!channel) return false;
  if (channel.name !== action.payload.name || channel.type !== action.payload.type) return false;
  if (action.kind === "category") {
    return fullOverwritesMatch(channel, action.payload.permission_overwrites ?? []);
  }
  const parentId = resolveParentId(action, refs, snapshot);
  if ((channel.parent_id ?? null) !== parentId) return false;
  if ((channel.topic ?? null) !== (action.payload.topic ?? null)) return false;
  if (Boolean(channel.nsfw) !== Boolean(action.payload.nsfw)) return false;
  return fullOverwritesMatch(channel, action.payload.permission_overwrites ?? []);
}

export function editDesiredMatches(action, channel, snapshot, refs) {
  if (!channel) return false;
  if (channel.name !== action.before?.name) return false;
  const parentId = resolveParentId(action, refs, snapshot);
  if ((channel.parent_id ?? null) !== parentId) return false;
  if ((channel.topic ?? null) !== (action.payload.topic ?? null)) return false;
  return managedOverwritesMatch(channel, action.payload.permission_overwrites ?? []);
}

function editBeforeMatches(action, channel, snapshot) {
  if (!channel) return false;
  return canonical(currentChannelState(channel, snapshot.guild.id)) === canonical(action.before);
}

export function classifyAction(action, snapshot, refs) {
  if (action.op === "create_channel") {
    const existing = findExistingCreateTarget(action, snapshot, refs);
    if (!existing) return { state: "create" };
    if (createTargetMatches(action, existing, snapshot, refs)) {
      return { state: "unchanged", channel: existing };
    }
    return { state: "drift", channel: existing };
  }
  const current = findChannel(snapshot, action.resource_id);
  if (!current) return { state: "drift", channel: null };
  if (editDesiredMatches(action, current, snapshot, refs)) {
    return { state: "unchanged", channel: current };
  }
  if (editBeforeMatches(action, current, snapshot)) {
    return { state: "apply", channel: current };
  }
  return { state: "drift", channel: current };
}

export function mergedOverwrites(current, specs) {
  const managed = new Set(specs.map((spec) => spec.target_id));
  const preserved = (current.permission_overwrites ?? [])
    .filter((overwrite) => !managed.has(overwrite.id))
    .map((overwrite) => ({
      id: overwrite.id,
      type: overwrite.type,
      allow: String(BigInt(overwrite.allow)),
      deny: String(BigInt(overwrite.deny)),
    }));
  return [...preserved, ...materializeOverwrites(specs)];
}

export function requestBodyFor(action, channel, snapshot, refs) {
  const specs = action.payload.permission_overwrites ?? [];
  if (action.op === "create_channel") {
    const body = {
      name: action.payload.name,
      type: action.payload.type,
      permission_overwrites: materializeOverwrites(specs),
    };
    const parentId = resolveParentId(action, refs, snapshot);
    if (parentId) body.parent_id = parentId;
    if (action.payload.topic !== undefined) body.topic = action.payload.topic;
    if (action.payload.nsfw !== undefined) body.nsfw = action.payload.nsfw;
    return body;
  }
  const body = {};
  if (action.payload.parent_ref) body.parent_id = resolveParentId(action, refs, snapshot);
  if (action.payload.topic !== undefined) body.topic = action.payload.topic;
  body.permission_overwrites = mergedOverwrites(channel, specs);
  return body;
}

function sanitizeError(error) {
  if (error instanceof DiscordApiError) {
    return {
      status: error.status,
      path: error.pathname,
      detail: error.detail,
    };
  }
  return { status: null, path: null, detail: String(error?.message ?? error) };
}

function writeReverseChecklist(applyDir, refs) {
  writeText(
    path.join(applyDir, "reverse-checklist.md"),
    [
      "# Manual reverse checklist",
      "",
      "This workflow did not delete or rename any pre-existing channel and did not create a role.",
      "Discord has no atomic rollback for channel creation. The resources created by this run are",
      "listed below; remove only those if the owner wants to undo the apply. Never delete a",
      "pre-existing channel.",
      "",
      ...[...refs.entries()].map(([actionId, id]) => `- ${actionId} → ${id}`),
      "",
      "The reused channel's previous topic and permission overwrites are recorded in the",
      "pre-apply snapshot next to the receipt.",
      "",
    ].join("\n"),
  );
}

function printHelp() {
  console.log(
    [
      "Usage: node scripts/discord/setup-apply.mjs --guild <id> --plan <id> [--apply|--verify]",
      "",
      "Required for every mode:",
      "  --guild <id>       Exact bound guild id. Any other guild is refused.",
      "  --plan <id>        Exact plan id or digest printed by setup-plan.mjs.",
      "",
      "Modes:",
      "  --apply            Write the approved channel/category changes. Refuses without",
      "                     --apply, --plan and --guild, and on any live drift.",
      "  --verify           Read-only read-back of the plan against live Discord.",
      "",
      "Options:",
      "  --plan-file <p>    Plan JSON (default .foilbury/discord-setup/plan.json).",
      "  --out <dir>        Evidence directory (default .foilbury/discord-setup).",
      "  --receipt <p>      Apply receipt used by --verify.",
      "  --json             Machine-readable output.",
      "  --help             Show this help.",
      "",
      "This script never deletes or renames a channel, creates a role, changes a",
      "guild-wide permission, posts a message, registers a command or uploads an image.",
    ].join("\n"),
  );
}

async function runVerify(plan, options, config) {
  const discord = createDiscordClient(config.token);
  const snapshot = await collectSnapshot(discord, config);
  preflight(plan, snapshot, config, { requireWritePermissions: false });

  let receipt = fs.existsSync(options.receipt) ? readJson(options.receipt) : null;
  let receiptStatus = receipt ? "used" : "not found";
  if (receipt && (receipt.plan_id !== plan.plan_id || receipt.digest !== plan.digest)) {
    receipt = null;
    receiptStatus = "ignored: receipt belongs to a different plan";
  }
  const refs = new Map(
    Object.entries(receipt?.created_refs ?? {}).filter(([, value]) => Boolean(value)),
  );
  const category = findChannelByName(snapshot, "Foilbury", 4);
  if (category) refs.set("category.foilbury", category.id);

  const results = [];
  for (const action of plan.proposal.actions) {
    if (action.payload?.parent_ref) {
      const parentId =
        refs.get(action.payload.parent_ref) ?? findChannelByName(snapshot, "Foilbury", 4)?.id;
      if (!parentId) {
        results.push({
          action_id: action.id,
          status: "FAIL",
          detail: `Parent ${action.payload.parent_ref} is missing; this action cannot be verified yet.`,
          fields: [{ field: "parent_ref", live: null, expected: action.payload.parent_ref }],
        });
        continue;
      }
      refs.set(action.payload.parent_ref, parentId);
    }
    if (action.op === "create_channel") {
      const existing = findExistingCreateTarget(action, snapshot, refs);
      if (!existing) {
        results.push({
          action_id: action.id,
          status: "FAIL",
          detail: "Expected channel/category is missing.",
          fields: [],
        });
        continue;
      }
      const matches = createTargetMatches(action, existing, snapshot, refs);
      const fields = [];
      if (!matches) {
        if (existing.name !== action.payload.name) {
          fields.push({ field: "name", live: existing.name, expected: action.payload.name });
        }
        const parentId = resolveParentId(action, refs, snapshot);
        if ((existing.parent_id ?? null) !== parentId) {
          fields.push({
            field: "parent_id",
            live: existing.parent_id ?? null,
            expected: parentId,
          });
        }
        if ((existing.topic ?? null) !== (action.payload.topic ?? null)) {
          fields.push({
            field: "topic",
            live: existing.topic ?? null,
            expected: action.payload.topic ?? null,
          });
        }
        if (!fullOverwritesMatch(existing, action.payload.permission_overwrites ?? [])) {
          fields.push({
            field: "permission_overwrites",
            live: (existing.permission_overwrites ?? []).map((item) => item.target_name),
            expected: (action.payload.permission_overwrites ?? []).map((item) => item.target),
          });
        }
      }
      results.push({
        action_id: action.id,
        status: matches ? "PASS" : "FAIL",
        detail: matches
          ? `#${existing.name} (${existing.id}) matches the approved shape.`
          : `#${existing.name} (${existing.id}) exists but does not match the approved shape.`,
        fields,
      });
      continue;
    }

    const current = findChannel(snapshot, action.resource_id);
    if (!current) {
      results.push({
        action_id: action.id,
        status: "FAIL",
        detail: `Channel ${action.resource_id} is missing.`,
        fields: [],
      });
      continue;
    }
    const matches = editDesiredMatches(action, current, snapshot, refs);
    const fields = [];
    if (!matches) {
      const parentId = resolveParentId(action, refs, snapshot);
      if ((current.parent_id ?? null) !== parentId) {
        fields.push({
          field: "parent_id",
          live: current.parent_id ?? null,
          expected: parentId,
        });
      }
      if ((current.topic ?? null) !== (action.payload.topic ?? null)) {
        fields.push({
          field: "topic",
          live: current.topic ?? null,
          expected: action.payload.topic ?? null,
        });
      }
      for (const spec of action.payload.permission_overwrites ?? []) {
        const existing = (current.permission_overwrites ?? []).find(
          (overwrite) => overwrite.id === spec.target_id,
        );
        const desired = desiredOverwrite(spec);
        if (
          !existing ||
          String(BigInt(existing.allow)) !== desired.allow ||
          String(BigInt(existing.deny)) !== desired.deny
        ) {
          fields.push({
            field: `overwrite:${spec.target}`,
            live: existing ? { allow: existing.allow_names, deny: existing.deny_names } : "not set",
            expected: { allow: spec.allow, deny: spec.deny },
          });
        }
      }
    }
    results.push({
      action_id: action.id,
      status: matches ? "PASS" : "FAIL",
      detail: matches
        ? `#${current.name} (${current.id}) matches the approved shape.`
        : `#${current.name} (${current.id}) does not match the approved shape.`,
      fields,
    });
  }

  const liveFindings = buildFindings(snapshot, config);
  const commandFinding = liveFindings.find((finding) => finding.id === "command_registration");
  const commandCheck = {
    id: "command_registration",
    status: commandFinding?.status ?? "BLOCKED",
    detail: commandFinding?.detail ?? "No command finding was produced.",
  };
  const knownBlockers = liveFindings
    .filter((finding) => finding.status === "BLOCKED" && finding.id !== "command_registration")
    .map((finding) => ({ id: finding.id, status: "BLOCKED", detail: finding.detail }));
  const failures = results.filter((result) => result.status === "FAIL");
  const commandFailed = commandCheck.status === "FAIL";
  const report = {
    schema: VERIFY_SCHEMA,
    generated_at: now(),
    mode: "verify",
    read_only: true,
    target: plan.target,
    plan_id: plan.plan_id,
    digest: plan.digest,
    results,
    receipt: { path: options.receipt, status: receiptStatus },
    findings: liveFindings,
    command_registration: commandCheck,
    known_blockers: knownBlockers,
    summary: {
      pass: results.filter((result) => result.status === "PASS").length,
      fail: failures.length + (commandFailed ? 1 : 0),
      blocked: knownBlockers.length,
    },
    note: "Read-only read-back. No Discord write, message, command registration or upload was performed.",
  };
  writeJson(path.join(options.out, "verify.json"), report);
  writeJson(path.join(options.out, "latest-verify.json"), report);

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log("Foilbury Discord setup verification · READ-ONLY");
    console.log(
      `Target: ${plan.target.guild_name} (${plan.target.guild_id}) · plan ${plan.plan_id}`,
    );
    for (const result of results) {
      console.log(`${result.status.padEnd(4)} ${result.action_id.padEnd(32)} ${result.detail}`);
      for (const field of result.fields) {
        console.log(
          `     ${field.field}: live ${JSON.stringify(field.live)} · expected ${JSON.stringify(field.expected)}`,
        );
      }
    }
    console.log(
      `${commandCheck.status.padEnd(4)} command_registration            ${commandCheck.detail}`,
    );
    for (const blocker of knownBlockers) {
      console.log(`BLOCKED ${blocker.id.padEnd(24)} ${blocker.detail}`);
    }
    console.log(
      `\n${report.summary.pass} PASS · ${report.summary.fail} FAIL · ${report.summary.blocked} BLOCKED`,
    );
    console.log(`Evidence: ${path.join(options.out, "verify.json")}`);
  }
  if (failures.length || commandFailed) process.exitCode = 1;
}

async function runApply(plan, options, config) {
  const discord = createDiscordClient(config.token);
  const snapshot = await collectSnapshot(discord, config);
  preflight(plan, snapshot, config, { requireWritePermissions: true });

  const refs = new Map();
  const category = findChannelByName(snapshot, "Foilbury", 4);
  if (category) refs.set("category.foilbury", category.id);

  const decisions = [];
  for (const action of plan.proposal.actions) {
    const classification = classifyAction(action, snapshot, refs);
    if (classification.state === "drift") {
      const target = classification.channel
        ? `#${classification.channel.name} (${classification.channel.id})`
        : `resource ${action.resource_id ?? "unknown"}`;
      throw new RefusalError(
        `Live drift detected for ${action.id} on ${target}. The live state is neither the approved before state nor the approved result. Regenerate and re-approve the plan; nothing was written.`,
      );
    }
    if (action.kind === "category") {
      if (classification.state === "unchanged") {
        refs.set(action.id, classification.channel.id);
      } else if (classification.state === "create") {
        // A symbolic ref lets child actions be drift-checked before any write.
        // It is replaced with the real channel ID after creation.
        refs.set(action.id, `__planned__:${action.id}`);
      }
    }
    decisions.push({ action, classification });
  }

  const runId = now().replace(/[:.]/g, "-");
  const applyDir = path.join(options.out, "apply");
  const snapshotPath = path.join(applyDir, "pre-apply-snapshot.json");
  const receiptPath = options.receipt;
  if (path.resolve(receiptPath) === path.resolve(snapshotPath)) {
    throw new RefusalError("The receipt path must not overwrite the pre-apply snapshot.");
  }
  const receipt = {
    schema: APPLY_SCHEMA,
    run_id: runId,
    plan_id: plan.plan_id,
    digest: plan.digest,
    target: plan.target,
    status: "in_progress",
    started_at: now(),
    completed_at: null,
    pre_apply_snapshot: snapshotPath,
    created_refs: {},
    actions: [],
  };

  writeJson(snapshotPath, {
    schema: "foilbury.discord.pre-apply-snapshot.v1",
    generated_at: now(),
    run_id: runId,
    plan_id: plan.plan_id,
    digest: plan.digest,
    target: plan.target,
    actions: plan.proposal.actions,
    snapshot,
  });
  writeJson(receiptPath, receipt);

  let failed = null;
  for (const { action, classification } of decisions) {
    if (classification.state === "unchanged") {
      if (action.kind === "category") refs.set(action.id, classification.channel.id);
      const entry = {
        action_id: action.id,
        op: action.op,
        status: "unchanged",
        at: now(),
        detail: "Live state already matches the approved result; no request sent.",
      };
      receipt.actions.push(entry);
      writeJson(receiptPath, receipt);
      continue;
    }

    try {
      const body = requestBodyFor(action, classification.channel, snapshot, refs);
      const response =
        action.op === "create_channel"
          ? await discord(`/guilds/${plan.target.guild_id}/channels`, {
              method: "POST",
              body,
            })
          : await discord(`/channels/${action.resource_id}`, {
              method: "PATCH",
              body,
            });
      receipt.actions.push({
        action_id: action.id,
        op: action.op,
        status: "applied",
        at: now(),
        request: {
          method: action.op === "create_channel" ? "POST" : "PATCH",
          path:
            action.op === "create_channel"
              ? `/guilds/${plan.target.guild_id}/channels`
              : `/channels/${action.resource_id}`,
          body,
        },
        response: {
          id: response?.id ?? null,
          name: response?.name ?? null,
          parent_id: response?.parent_id ?? null,
        },
      });
      if (action.op === "create_channel") {
        refs.set(action.id, response.id);
        receipt.created_refs[action.id] = response.id;
      }
      writeJson(receiptPath, receipt);
    } catch (error) {
      failed = { action: action.id, error: sanitizeError(error) };
      receipt.status = "partial";
      receipt.completed_at = now();
      receipt.actions.push({
        action_id: action.id,
        op: action.op,
        status: "failed",
        at: now(),
        error: failed.error,
      });
      writeJson(receiptPath, receipt);
      break;
    }
  }

  if (failed) {
    writeReverseChecklist(applyDir, refs);
    const message = [
      `Apply stopped at ${failed.action}: HTTP ${failed.error.status ?? "n/a"} ${failed.error.detail}`,
      `Receipt: ${receiptPath}`,
      `Pre-apply snapshot: ${snapshotPath}`,
      `Reverse checklist: ${path.join(applyDir, "reverse-checklist.md")}`,
      "No delete or rename was attempted. Review the receipt before retrying; re-run the plan if live state drifted.",
    ].join("\n");
    if (options.json) {
      console.log(JSON.stringify({ ok: false, receipt, error: failed.error }, null, 2));
    } else {
      console.error(message);
    }
    process.exitCode = 1;
    return;
  }

  receipt.status = "applied";
  receipt.completed_at = now();
  writeJson(receiptPath, receipt);
  writeReverseChecklist(applyDir, refs);

  if (options.json) {
    console.log(JSON.stringify({ ok: true, receipt }, null, 2));
  } else {
    console.log("Foilbury Discord setup apply · APPROVED WRITE");
    console.log(
      `Target: ${plan.target.guild_name} (${plan.target.guild_id}) · plan ${plan.plan_id}`,
    );
    for (const entry of receipt.actions) {
      console.log(
        `${entry.status.padEnd(9)} ${entry.action_id}${entry.response?.id ? ` → ${entry.response.id}` : ""}`,
      );
    }
    console.log("");
    console.log(`Receipt: ${receiptPath}`);
    console.log(`Pre-apply snapshot: ${snapshotPath}`);
    console.log("No channel was deleted or renamed. Run verification with:");
    console.log(
      `pnpm discord:setup:verify --guild ${plan.target.guild_id} --plan ${plan.plan_id} --plan-file ${options.planFile}`,
    );
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return;
  }

  if (options.apply && options.verify) {
    throw new RefusalError("Choose one mode: --apply or --verify, not both.");
  }
  if (!options.apply && !options.verify) {
    throw new RefusalError(
      "No mode selected. Nothing was written. Apply requires --apply, --plan <id> and --guild <id>; use --verify for a read-only read-back.",
    );
  }
  if (!options.plan) {
    throw new RefusalError(
      "--plan <plan id or digest> is required. Approval of the exact plan is not optional.",
    );
  }
  if (!options.guild) {
    throw new RefusalError("--guild <id> is required; the target guild is never inferred.");
  }

  const plan = readJson(options.planFile);
  const config = loadDiscordConfig();
  if (config.missing.length) {
    throw new RefusalError(
      `Missing required .env key(s): ${config.missing.join(", ")}. Values are never printed.`,
    );
  }
  validatePlan(plan, options, config);

  if (options.verify) {
    await runVerify(plan, options, config);
    return;
  }
  await runApply(plan, options, config);
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  try {
    await main();
  } catch (error) {
    if (error instanceof RefusalError) {
      console.error(`Refused: ${error.message}`);
      console.error("No Discord write was made.");
      process.exitCode = 2;
    } else {
      console.error(`Foilbury Discord setup apply failed: ${error?.message ?? error}`);
      process.exitCode = 1;
    }
  }
}
