import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_EXPECTED_CASES,
  buildSession,
  evaluateInteraction,
  evaluateSession,
  evaluateSpectator,
  filterDrawLedger,
  selectTerminalExpectation,
} from "../../scripts/discord/assisted-acceptance.mjs";

const START = "2026-11-04T00:00:00.000Z";
const END = "2026-11-04T01:00:00.000Z";
const GUILD_ID = "997734945206313041";
const CHANNEL_ID = "1566700752385081355";
const ACTOR_ID = "707281352818425929";
const OBSERVER_ID = "707281352818425999";
const TENANT_ID = "ten_test";
const USER_ID = "usr_test";
const BUILD = "a".repeat(40);

function makeSession(overrides = {}) {
  return buildSession({
    sessionId: "dacc-test-session",
    environment: "production",
    origin: "https://foilbury.loftwah.com",
    status: {
      http_status: 200,
      header: "x-foilbury-build",
      value: BUILD,
      checked_at: START,
    },
    workerVersion: "worker-version-1",
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    actorId: ACTOR_ID,
    startedAt: START,
    durationMinutes: 60,
    expectedCases: DEFAULT_EXPECTED_CASES,
    ...overrides,
  });
}

function identity(overrides = {}) {
  return { tenant_id: TENANT_ID, user_id: USER_ID, discord_user_id: ACTOR_ID, ...overrides };
}

function installation(overrides = {}) {
  return {
    id: "inst_1",
    tenant_id: TENANT_ID,
    guild_id: GUILD_ID,
    application_id: "app_1",
    active: 1,
    revoked_at: null,
    ...overrides,
  };
}

function receipt(overrides = {}) {
  return {
    kind: "draw",
    draw_id: "drw_1",
    instance_id: "ins_1",
    card_id: "card_1",
    variant_id: "var_1",
    card_name: "Nora",
    edition_name: null,
    variant_name: "Plain",
    serial: "FB-1-DE-ABC123",
    pool_name: "Cabinet",
    price: 80,
    currency_symbol: "✦",
    balance_after: 330,
    balance_after_debit: 270,
    credits_total: 60,
    drawn_at: "2026-11-04T00:10:01.000Z",
    replayed: false,
    ...overrides,
  };
}

function interaction(overrides = {}) {
  return {
    interaction_id: "int_open_1",
    application_id: "app_1",
    guild_id: GUILD_ID,
    channel_id: CHANNEL_ID,
    discord_user_id: ACTOR_ID,
    command_name: "open",
    status: "completed",
    error_code: null,
    receipt_kind: "draw",
    receipt_json: JSON.stringify(receipt()),
    delivery_visibility: "private",
    created_at: "2026-11-04T00:10:00.000Z",
    completed_at: "2026-11-04T00:10:02.000Z",
    ...overrides,
  };
}

function draw(overrides = {}) {
  return {
    id: "drw_1",
    tenant_id: TENANT_ID,
    user_id: USER_ID,
    pool_id: "pool_1",
    pool_revision: 1,
    price: 80,
    variant_id: "var_1",
    instance_id: "ins_1",
    created_at: "2026-11-04T00:10:01.000Z",
    idempotency_key: "discord:int_open_1:open",
    receipt_json: JSON.stringify(receipt()),
    ...overrides,
  };
}

function instance(overrides = {}) {
  return {
    id: "ins_1",
    tenant_id: TENANT_ID,
    user_id: USER_ID,
    card_id: "card_1",
    variant_id: "var_1",
    serial: "FB-1-DE-ABC123",
    status: "owned",
    acquired_via: "draw",
    acquired_at: "2026-11-04T00:10:01.000Z",
    ...overrides,
  };
}

function priorLedger(overrides = {}) {
  return {
    id: "led_welcome",
    tenant_id: TENANT_ID,
    user_id: USER_ID,
    kind: "issue",
    amount: 350,
    balance_after: 350,
    reference_type: null,
    reference_id: null,
    description: "Welcome grant",
    idempotency_key: "welcome:usr_test",
    created_at: "2026-11-03T23:00:00.000Z",
    ...overrides,
  };
}

function debit(overrides = {}) {
  return {
    id: "led_draw",
    tenant_id: TENANT_ID,
    user_id: USER_ID,
    kind: "spend",
    amount: -80,
    balance_after: 270,
    reference_type: "draw",
    reference_id: "drw_1",
    description: "Cabinet draw",
    idempotency_key: "discord:int_open_1:open",
    created_at: "2026-11-04T00:10:01.000Z",
    ...overrides,
  };
}

function achievementCredit(overrides = {}) {
  return {
    id: "led_ach",
    tenant_id: TENANT_ID,
    user_id: USER_ID,
    kind: "issue",
    amount: 60,
    balance_after: 330,
    reference_type: "achievement",
    reference_id: "unl_1",
    description: "Achievement: First pull",
    idempotency_key: "achievement:ach_1:1:usr_test",
    created_at: "2026-11-04T00:10:01.500Z",
    ...overrides,
  };
}

function unlock(overrides = {}) {
  return {
    id: "unl_1",
    tenant_id: TENANT_ID,
    user_id: USER_ID,
    achievement_id: "ach_1",
    achievement_version: 1,
    reward_state: "granted",
    reward_amount: 60,
    reward_ledger_id: "led_ach",
    earned_at: "2026-11-04T00:10:01.500Z",
    ...overrides,
  };
}

function happyEconomics(overrides = {}) {
  return {
    identity: identity(),
    installation: installation(),
    draw: draw(),
    instance: instance(),
    drawInstances: [instance()],
    priorLedger: priorLedger(),
    ledger: [priorLedger(), debit(), achievementCredit()],
    achievementUnlocks: [unlock()],
    rewardClaims: [],
    shares: [],
    drawCandidates: [draw()],
    wallet: { balance: 330, currency_symbol: "✦" },
    ...overrides,
  };
}

function evaluateOpen(overrides = {}) {
  return evaluateInteraction({
    session: makeSession(),
    interaction: interaction(),
    ...happyEconomics(),
    ...overrides,
  });
}

test("happy path: one draw, one debit, one instance and settled achievement reward passes", () => {
  const report = evaluateOpen();
  assert.equal(report.result, "pass", JSON.stringify(report.failures, null, 2));
  assert.equal(report.case_id, "open");
  assert.equal(report.evidence_layers.database.status, "used");
  assert.equal(report.evidence_layers.api.status, "used");
  assert.equal(report.evidence_layers.actual_client.status, "unverified");
  assert.equal(report.economics.debit_count, 1);
  assert.equal(report.economics.instance_count, 1);
  assert.equal(report.economics.balance_reconciliation, "reconciled");
});

test("negative control: a draw receipt with zero ledger rows fails", () => {
  const report = evaluateOpen({
    ledger: [priorLedger()],
  });
  assert.equal(report.result, "fail");
  assert.ok(
    report.failures.some((failure) => failure.code === "draw_debit_missing"),
    JSON.stringify(report.failures),
  );
  assert.equal(report.economics.debit_count, 0);
});

test("negative control: a failed interaction with receipt_json={} never passes", () => {
  const report = evaluateOpen({
    interaction: interaction({
      status: "failed",
      error_code: "insufficient_funds",
      receipt_json: "{}",
    }),
  });
  assert.equal(report.result, "fail");
  assert.ok(report.failures.some((failure) => failure.code === "interaction_failed"));
  assert.notEqual(report.result, "pass");
});

test("negative control: a failed slash interaction is still failed when its subcommand is unbound", () => {
  const report = evaluateInteraction({
    session: makeSession(),
    interaction: interaction({
      command_name: "foilbury",
      status: "failed",
      error_code: "insufficient_funds",
      receipt_kind: null,
      receipt_json: "{}",
    }),
    identity: identity(),
    installation: installation(),
    drawCandidates: [],
    rewardClaims: [],
    shares: [],
    ledger: [],
  });
  assert.equal(report.result, "fail");
  assert.ok(report.failures.some((failure) => failure.code === "interaction_failed"));
  assert.ok(report.failures.some((failure) => failure.code === "command_ambiguous_read_only"));
});

test("negative control: a failed interaction without a real ApiError code fails", () => {
  const report = evaluateOpen({
    interaction: interaction({
      status: "failed",
      error_code: null,
      receipt_json: "{}",
    }),
  });
  assert.equal(report.result, "fail");
  assert.ok(report.failures.some((failure) => failure.code === "missing_api_error_code"));
});

test("negative control: an unrelated ledger row without a reference_id is not counted", () => {
  const unrelated = debit({
    id: "led_unrelated",
    reference_type: null,
    reference_id: null,
    description: "draw adjustment",
    amount: -80,
    balance_after: 270,
  });
  assert.deepEqual(filterDrawLedger([priorLedger(), unrelated], "drw_1"), []);
  const report = evaluateOpen({
    ledger: [priorLedger(), unrelated],
  });
  assert.equal(report.result, "fail");
  assert.equal(report.economics.debit_count, 0);
  assert.ok(report.failures.some((failure) => failure.code === "draw_debit_missing"));
});

test("negative control: processing is pending first and only passes after completion", () => {
  const pending = evaluateOpen({
    interaction: interaction({ status: "processing", completed_at: null }),
  });
  assert.equal(pending.result, "pending");
  assert.notEqual(pending.result, "pass");

  const completed = evaluateOpen();
  assert.equal(completed.result, "pass");
});

test("negative control: spectator evidence from the initiating account fails", () => {
  const report = evaluateSpectator({
    session: makeSession(),
    evidence: {
      schema_version: 1,
      session_id: "dacc-test-session",
      guild_id: GUILD_ID,
      channel_id: CHANNEL_ID,
      message_id: "123456789012345678",
      actor_id: ACTOR_ID,
      observed_at: "2026-11-04T00:20:00.000Z",
      observed_intended_share: true,
      private_content_absent: true,
    },
  });
  assert.equal(report.result, "fail");
  assert.ok(report.failures.some((failure) => failure.code === "observer_is_initiator"));
});

test("negative control: stale spectator evidence fails", () => {
  const report = evaluateSpectator({
    session: makeSession(),
    evidence: {
      schema_version: 1,
      session_id: "dacc-test-session",
      guild_id: GUILD_ID,
      channel_id: CHANNEL_ID,
      message_id: "123456789012345678",
      actor_id: OBSERVER_ID,
      observed_at: "2026-11-03T23:59:59.000Z",
      observed_intended_share: true,
      private_content_absent: true,
    },
  });
  assert.equal(report.result, "fail");
  assert.ok(report.failures.some((failure) => failure.code === "observation_outside_window"));
});

test("negative control: spectator evidence missing private_content_absent fails", () => {
  const report = evaluateSpectator({
    session: makeSession(),
    evidence: {
      schema_version: 1,
      session_id: "dacc-test-session",
      guild_id: GUILD_ID,
      channel_id: CHANNEL_ID,
      message_id: "123456789012345678",
      actor_id: OBSERVER_ID,
      observed_at: "2026-11-04T00:20:00.000Z",
      observed_intended_share: true,
    },
  });
  assert.equal(report.result, "fail");
  assert.ok(report.failures.some((failure) => failure.code === "private_content_absent_missing"));
});

test("negative control: spectator evidence for another session or channel fails", () => {
  const base = {
    schema_version: 1,
    session_id: "dacc-test-session",
    guild_id: GUILD_ID,
    channel_id: CHANNEL_ID,
    message_id: "123456789012345678",
    actor_id: OBSERVER_ID,
    observed_at: "2026-11-04T00:20:00.000Z",
    observed_intended_share: true,
    private_content_absent: true,
  };
  const forgedSession = evaluateSpectator({
    session: makeSession(),
    evidence: { ...base, session_id: "dacc-forged-session" },
  });
  assert.equal(forgedSession.result, "fail");
  assert.ok(
    forgedSession.failures.some((failure) => failure.code === "spectator_session_mismatch"),
  );

  const wrongChannel = evaluateSpectator({
    session: makeSession(),
    evidence: { ...base, channel_id: "123456789012345678" },
  });
  assert.equal(wrongChannel.result, "fail");
  assert.ok(wrongChannel.failures.some((failure) => failure.code === "channel_mismatch"));
});

test("spectator happy path passes only as an explicit attestation", () => {
  const report = evaluateSpectator({
    session: makeSession(),
    evidence: {
      schema_version: 1,
      session_id: "dacc-test-session",
      guild_id: GUILD_ID,
      channel_id: CHANNEL_ID,
      message_id: "123456789012345678",
      actor_id: OBSERVER_ID,
      observed_at: "2026-11-04T00:20:00.000Z",
      observed_intended_share: true,
      private_content_absent: true,
      method: "manual_discord_client",
      notes: "Observed the public share; the ephemeral responses were not visible.",
    },
  });
  assert.equal(report.result, "pass", JSON.stringify(report.failures, null, 2));
  assert.equal(report.attestation_only, true);
  assert.equal(report.evidence_layers.observer_attestation.status, "attested");
  assert.equal(report.evidence_layers.observer_attestation.proof, false);
});

test("spectator evidence marked unverified is not a pass", () => {
  const report = evaluateSpectator({
    session: makeSession(),
    evidence: {
      schema_version: 1,
      session_id: "dacc-test-session",
      guild_id: GUILD_ID,
      channel_id: CHANNEL_ID,
      message_id: "123456789012345678",
      actor_id: OBSERVER_ID,
      observed_at: "2026-11-04T00:20:00.000Z",
      observed_intended_share: true,
      private_content_absent: "unverified",
    },
  });
  assert.equal(report.result, "partial");
  assert.ok(report.failures.some((failure) => failure.code === "private_content_unverified"));
});

test("negative control: an extra credit in the interaction window fails", () => {
  const report = evaluateOpen({
    ledger: [
      priorLedger(),
      debit(),
      achievementCredit(),
      debit({
        id: "led_extra",
        kind: "issue",
        amount: 500,
        balance_after: 830,
        reference_type: null,
        reference_id: null,
        description: "unattributed credit",
        idempotency_key: "extra:1",
      }),
    ],
  });
  assert.equal(report.result, "fail");
  assert.ok(report.failures.some((failure) => failure.code === "extra_credit"));
});

test("negative control: a duplicate draw instance fails", () => {
  const report = evaluateOpen({
    drawInstances: [instance(), instance({ id: "ins_2", serial: "FB-1-DE-ABC124" })],
  });
  assert.equal(report.result, "fail");
  assert.ok(report.failures.some((failure) => failure.code === "draw_instance_duplicate"));
});

test("negative control: a completed interaction with delivery_failed fails", () => {
  const report = evaluateOpen({
    interaction: interaction({ error_code: "delivery_failed" }),
  });
  assert.equal(report.result, "fail");
  assert.ok(report.failures.some((failure) => failure.code === "interaction_error_code_present"));
});

test("negative control: wrong build, guild, channel, actor or window fails binding", () => {
  const wrongBuild = evaluateOpen({ expectedBuild: "b".repeat(40) });
  assert.equal(wrongBuild.result, "fail");
  assert.ok(wrongBuild.failures.some((failure) => failure.code === "build_mismatch"));

  for (const [field, code] of [
    ["guild_id", "guild_mismatch"],
    ["channel_id", "channel_mismatch"],
    ["discord_user_id", "actor_mismatch"],
  ]) {
    const report = evaluateOpen({ interaction: interaction({ [field]: "123456789012345678" }) });
    assert.equal(report.result, "fail", field);
    assert.ok(
      report.failures.some((failure) => failure.code === code),
      field,
    );
  }

  const outside = evaluateOpen({
    interaction: interaction({ created_at: "2026-11-03T23:59:59.000Z" }),
  });
  assert.equal(outside.result, "fail");
  assert.ok(outside.failures.some((failure) => failure.code === "outside_session_window"));
});

test("read-only commands pass without draw or ledger requirements", () => {
  const report = evaluateInteraction({
    session: makeSession(),
    interaction: interaction({
      interaction_id: "int_help_1",
      command_name: "help",
      receipt_kind: null,
      receipt_json: null,
      created_at: "2026-11-04T00:05:00.000Z",
      completed_at: "2026-11-04T00:05:01.000Z",
    }),
    identity: identity(),
    installation: installation(),
    drawCandidates: [],
    rewardClaims: [],
    shares: [],
    ledger: [],
  });
  assert.equal(report.result, "pass", JSON.stringify(report.failures, null, 2));
  assert.equal(report.case_id, "help");
  assert.equal(report.expectation.kind, "read_only");
});

test("mission claim binds the component and credits exactly once", () => {
  const claim = {
    id: "rwd_mission",
    tenant_id: TENANT_ID,
    user_id: USER_ID,
    rule_key: "mission:2026-11-04:open",
    amount: 60,
    created_at: "2026-11-04T00:35:01.000Z",
    idempotency_key: "mission:mission:2026-11-04:open",
  };
  const report = evaluateInteraction({
    session: makeSession(),
    interaction: interaction({
      interaction_id: "int_mission_1",
      command_name: "foilbury:mission:claim:open",
      receipt_kind: null,
      receipt_json: null,
      created_at: "2026-11-04T00:35:00.000Z",
      completed_at: "2026-11-04T00:35:02.000Z",
    }),
    identity: identity(),
    installation: installation(),
    priorLedger: priorLedger(),
    ledger: [
      priorLedger(),
      debit({
        id: "led_mission",
        kind: "issue",
        amount: 60,
        balance_after: 410,
        reference_type: "reward",
        reference_id: "rwd_mission",
        idempotency_key: "mission:mission:2026-11-04:open",
        description: "Daily mission reward",
      }),
    ],
    rewardClaims: [claim],
    drawCandidates: [],
    shares: [],
    wallet: { balance: 410, currency_symbol: "✦" },
  });
  assert.equal(report.result, "pass", JSON.stringify(report.failures, null, 2));
  assert.equal(report.case_id, "mission");
  assert.equal(report.expectation.mission_key, "open");
});

test("a read-only slash interaction requires --case attestation and then passes only that case", () => {
  const slash = interaction({
    interaction_id: "int_help_1",
    command_name: "foilbury",
    receipt_kind: null,
    receipt_json: null,
    created_at: "2026-11-04T00:05:00.000Z",
    completed_at: "2026-11-04T00:05:01.000Z",
  });
  const evidence = {
    identity: identity(),
    installation: installation(),
    drawCandidates: [],
    rewardClaims: [],
    shares: [],
    ledger: [],
  };
  const unbound = evaluateInteraction({ session: makeSession(), interaction: slash, ...evidence });
  assert.equal(unbound.result, "fail");
  assert.ok(unbound.failures.some((failure) => failure.code === "command_ambiguous_read_only"));

  const attested = evaluateInteraction({
    session: makeSession(),
    interaction: slash,
    commandAttestation: { case_id: "help", layer: "operator_attestation" },
    ...evidence,
  });
  assert.equal(attested.result, "pass", JSON.stringify(attested.failures, null, 2));
  assert.equal(attested.case_id, "help");
  assert.equal(attested.expectation.command_binding.layer, "operator_attestation");
});

test("daily claim expects exactly one claim and one matching reward credit", () => {
  const claim = {
    id: "rwd_daily",
    tenant_id: TENANT_ID,
    user_id: USER_ID,
    rule_key: "daily-allowance",
    amount: 120,
    created_at: "2026-11-04T00:15:01.000Z",
    idempotency_key: "discord:int_daily_1:daily",
  };
  const report = evaluateInteraction({
    session: makeSession(),
    interaction: interaction({
      interaction_id: "int_daily_1",
      command_name: "daily",
      receipt_kind: null,
      receipt_json: null,
      created_at: "2026-11-04T00:15:00.000Z",
      completed_at: "2026-11-04T00:15:02.000Z",
    }),
    identity: identity(),
    installation: installation(),
    priorLedger: priorLedger(),
    ledger: [
      priorLedger(),
      debit({
        id: "led_daily",
        kind: "issue",
        amount: 120,
        balance_after: 470,
        reference_type: "reward",
        reference_id: "rwd_daily",
        idempotency_key: "discord:int_daily_1:daily",
        description: "Daily cabinet allowance",
      }),
    ],
    rewardClaims: [claim],
    drawCandidates: [],
    shares: [],
    wallet: { balance: 470, currency_symbol: "✦" },
  });
  assert.equal(report.result, "pass", JSON.stringify(report.failures, null, 2));
  assert.equal(report.case_id, "daily");
  assert.equal(report.expectation.kind, "claim");
});

test("share commands require an explicit delivered share, not a receipt", () => {
  const share = {
    id: "shr_1",
    tenant_id: TENANT_ID,
    user_id: USER_ID,
    channel_id: CHANNEL_ID,
    object_type: "card",
    object_id: "card_1",
    message_id: null,
    created_at: "2026-11-04T00:25:01.000Z",
  };
  const report = evaluateInteraction({
    session: makeSession(),
    interaction: interaction({
      interaction_id: "int_share_1",
      command_name: "foilbury:tourshare:card:card_1",
      receipt_kind: null,
      receipt_json: null,
      delivery_visibility: "public",
      created_at: "2026-11-04T00:25:00.000Z",
      completed_at: "2026-11-04T00:25:02.000Z",
    }),
    identity: identity(),
    installation: installation(),
    shares: [share],
    rewardClaims: [],
    drawCandidates: [],
    ledger: [],
  });
  assert.equal(report.result, "pass", JSON.stringify(report.failures, null, 2));
  assert.equal(report.case_id, "share");
  assert.equal(report.expectation.kind, "share");
  assert.ok(report.limitations.some((line) => line.includes("message_id")));
});

test("negative control: a share with a missing durable share row fails", () => {
  const report = evaluateInteraction({
    session: makeSession(),
    interaction: interaction({
      interaction_id: "int_share_1",
      command_name: "foilbury:tourshare:card:card_1",
      receipt_kind: null,
      receipt_json: null,
      delivery_visibility: "public",
      created_at: "2026-11-04T00:25:00.000Z",
      completed_at: "2026-11-04T00:25:02.000Z",
    }),
    identity: identity(),
    installation: installation(),
    shares: [],
    rewardClaims: [],
    drawCandidates: [],
    ledger: [],
  });
  assert.equal(report.result, "fail");
  assert.ok(report.failures.some((failure) => failure.code === "share_missing"));
});

test("a session happy path passes when every expected case has a passing interaction", () => {
  const session = makeSession({
    expectedCases: [
      { case_id: "open", command: "open", kind: "open" },
      { case_id: "help", command: "help", kind: "read_only" },
    ],
  });
  const openReport = evaluateOpen({ session });
  const helpReport = evaluateInteraction({
    session,
    interaction: interaction({
      interaction_id: "int_help_1",
      command_name: "help",
      receipt_kind: null,
      receipt_json: null,
      created_at: "2026-11-04T00:05:00.000Z",
      completed_at: "2026-11-04T00:05:01.000Z",
    }),
    identity: identity(),
    installation: installation(),
    drawCandidates: [],
    rewardClaims: [],
    shares: [],
    ledger: [],
  });
  const result = evaluateSession({ session, reports: [openReport, helpReport] });
  assert.equal(result.result, "pass", JSON.stringify(result.failures, null, 2));
  assert.equal(result.cases.length, 2);
});

test("negative control: a failed interaction is not masked by a later pass for the same case", () => {
  const session = makeSession({
    expectedCases: [{ case_id: "open", command: "open", kind: "open" }],
  });
  const failed = evaluateOpen({
    session,
    interaction: interaction({
      status: "failed",
      error_code: "delivery_failed",
      receipt_json: "{}",
    }),
  });
  const passed = evaluateOpen({ session });
  const result = evaluateSession({ session, reports: [failed, passed] });
  assert.equal(result.result, "fail");
  assert.ok(result.failures.some((failure) => failure.code === "interaction_not_passed"));
});

test("negative control: a missing expected case makes the session incomplete", () => {
  const session = makeSession({
    expectedCases: [
      { case_id: "open", command: "open", kind: "open" },
      { case_id: "daily", command: "daily", kind: "claim", claim_type: "daily" },
    ],
  });
  const openReport = evaluateOpen({ session });
  const result = evaluateSession({ session, reports: [openReport] });
  assert.equal(result.result, "fail");
  const daily = result.cases.find((item) => item.case_id === "daily");
  assert.equal(daily.result, "not_performed");
});

test("selectTerminalExpectation distinguishes read-only, claim, open and share cases", () => {
  const session = makeSession();
  const readOnly = selectTerminalExpectation({
    session,
    interaction: interaction({ command_name: "packs", receipt_kind: null, receipt_json: null }),
  });
  assert.equal(readOnly.kind, "read_only");
  assert.equal(readOnly.requires_receipt, false);

  const claim = selectTerminalExpectation({
    session,
    interaction: interaction({ command_name: "daily", receipt_kind: null, receipt_json: null }),
  });
  assert.equal(claim.kind, "claim");
  assert.equal(claim.claim_type, "daily");

  const open = selectTerminalExpectation({ session, interaction: interaction() });
  assert.equal(open.kind, "open");
  assert.equal(open.requires_receipt, true);

  const share = selectTerminalExpectation({
    session,
    interaction: interaction({
      command_name: "foilbury:tourshare:card:card_1",
      receipt_kind: null,
      receipt_json: null,
    }),
  });
  assert.equal(share.kind, "share");
  assert.equal(share.delivery, "public");
});

test("production sessions require an observed build header", () => {
  const session = makeSession({
    environment: "production",
    status: { http_status: 200, header: "x-foilbury-build", value: null, checked_at: START },
  });
  assert.equal(session.build.verified, false);
  const report = evaluateOpen({ session });
  assert.equal(report.result, "fail");
  assert.ok(report.failures.some((failure) => failure.code === "session_invalid"));
});
