import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DiagnosticRunAssignmentFacts,
  DiagnosticRunBadges,
} from "../../app/diagnostic-runs-panel";
import {
  apiErrorCode,
  buildAssignedRunBody,
  buildDiagnosticCreationRequest,
  diagnosticCancellationErrorMessage,
  diagnosticCreationGate,
  diagnosticCreationErrorMessage,
  isDerivedExpired,
  runAssignmentLabel,
  shouldApplyDiagnosticDetail,
  shouldPollDiagnosticDetail,
  toAssignableDiagnosticRunners,
} from "../../app/diagnostic-run-view";
import {
  RUNNER_CAPABILITY_OPTIONS,
  runnerCapabilityLabel,
} from "../../app/runner-capability-labels";
import type { DiagnosticRun } from "../../src/contracts/runs";
import type { Runner } from "../../src/contracts/runners";

const run = (overrides: Partial<DiagnosticRun> = {}): DiagnosticRun => ({
  id: `run_${"1".repeat(32)}`,
  organizationId: "org-local-aurora",
  requestedBy: "principal-owner",
  kind: "diagnostic",
  status: "queued",
  version: 1,
  leaseGeneration: 0,
  claimCount: 0,
  maxClaims: 3,
  deadlineAt: "2026-07-26T13:00:00.000Z",
  replayCount: 0,
  createdAt: "2026-07-26T12:00:00.000Z",
  updatedAt: "2026-07-26T12:00:00.000Z",
  ...overrides,
});

test("builds the exact assigned request with no null or extra keys", () => {
  const runnerId = `rnr_${"a".repeat(32)}`;
  assert.equal(
    buildAssignedRunBody(runnerId, ""),
    `{"assignedRunnerId":"${runnerId}"}`,
  );
  assert.equal(
    buildAssignedRunBody(runnerId, "bubblewrap"),
    `{"assignedRunnerId":"${runnerId}","requiredCapability":"bubblewrap"}`,
  );
  assert.doesNotMatch(buildAssignedRunBody(runnerId, ""), /null|undefined/u);
});

test("selects one creation route and preserves the literal pool body", () => {
  assert.deepEqual(
    buildDiagnosticCreationRequest("pool", "ignored", "docker"),
    {
      endpoint: "/api/runs/diagnostic",
      body: "{}",
    },
  );
  assert.deepEqual(
    buildDiagnosticCreationRequest(
      "assigned",
      `rnr_${"a".repeat(32)}`,
      "docker",
    ),
    {
      endpoint: "/api/runs/diagnostic/assigned",
      body: `{"assignedRunnerId":"rnr_${"a".repeat(32)}","requiredCapability":"docker"}`,
    },
  );
});

test("offers every active identity without treating liveness as authority", () => {
  const base = {
    organizationId: "org-local-aurora",
    principalId: "principal-runner",
    publicKey: "key",
    publicKeyFingerprint: "fingerprint",
    trustProfile: "operator_trust",
    trustDisclosure: "operator controlled",
    enrolledAt: "2026-07-26T12:00:00.000Z",
    declaredCapabilities: null,
    declarationAdmission: {
      evaluatedAt: "2026-07-26T12:00:00.000Z",
      policySource: "default",
      policyVersion: 0,
      freshnessSeconds: 3600,
      freshnessState: "absent",
      reportId: null,
      reportReceivedAt: null,
      freshUntil: null,
      capabilities: [],
    },
  } satisfies Partial<Runner>;
  const online = {
    ...base,
    id: "rnr-online",
    displayName: "Online host",
    status: "active",
    liveness: "online",
  } as Runner;
  const offline = {
    ...base,
    id: "rnr-offline",
    displayName: "Offline host",
    status: "active",
    liveness: "offline",
  } as Runner;
  const revoked = {
    ...base,
    id: "rnr-revoked",
    displayName: "Revoked host",
    status: "revoked",
    liveness: "revoked",
  } as Runner;
  assert.deepEqual(toAssignableDiagnosticRunners([online, offline, revoked]), [
    {
      id: "rnr-online",
      displayName: "Online host",
      liveness: "online",
    },
    {
      id: "rnr-offline",
      displayName: "Offline host",
      liveness: "offline",
    },
  ]);
});

test("gates assigned creation on identity and current admission policy", () => {
  const runner = {
    id: "rnr-active",
    displayName: "Active host",
    liveness: "offline",
  } as const;
  const base = {
    mode: "assigned",
    assignableRunners: [runner],
    assignedRunnerId: runner.id,
    requiredCapability: "",
    allowedCapabilities: [...RUNNER_CAPABILITY_OPTIONS],
  } as const;
  assert.deepEqual(diagnosticCreationGate(base), {
    canSubmit: true,
    blockedReason: "",
  });
  assert.match(
    diagnosticCreationGate({
      ...base,
      allowedCapabilities: null,
    }).blockedReason,
    /ainda não está disponível/u,
  );
  assert.equal(
    diagnosticCreationGate({
      ...base,
      assignableRunners: [],
    }).canSubmit,
    false,
  );
  assert.match(
    diagnosticCreationGate({
      ...base,
      assignedRunnerId: "",
    }).blockedReason,
    /Escolha um runner/u,
  );
  assert.match(
    diagnosticCreationGate({
      ...base,
      assignedRunnerId: "rnr-removed",
    }).blockedReason,
    /deixou o registro ativo/u,
  );
  assert.match(
    diagnosticCreationGate({
      ...base,
      requiredCapability: "docker",
      allowedCapabilities: ["bubblewrap"],
    }).blockedReason,
    /bloqueada pela política/u,
  );
  assert.equal(
    diagnosticCreationGate({
      ...base,
      mode: "pool",
      assignableRunners: [],
      assignedRunnerId: "",
      requiredCapability: "docker",
      allowedCapabilities: [],
    }).canSubmit,
    true,
  );
});

test("maps deterministic creation failures without promising a retry", () => {
  assert.match(
    diagnosticCreationErrorMessage("workspace_owner_required", "assigned"),
    /owner\/admin/u,
  );
  assert.match(
    diagnosticCreationErrorMessage("runner_not_active", "assigned"),
    /não está mais ativo/u,
  );
  assert.match(
    diagnosticCreationErrorMessage("runner_not_found", "assigned"),
    /não pertence/u,
  );
  assert.match(
    diagnosticCreationErrorMessage("conflict_retry", "assigned"),
    /se desejar/u,
  );
  assert.match(
    diagnosticCreationErrorMessage("unknown", "pool"),
    /diagnóstico pool/u,
  );
  assert.match(
    diagnosticCreationErrorMessage("unknown", "assigned"),
    /diagnóstico atribuído/u,
  );
});

test("preserves server error codes for truthful creation and cancellation copy", () => {
  assert.equal(
    apiErrorCode({ error: "workspace_owner_required" }, "fallback"),
    "workspace_owner_required",
  );
  assert.equal(apiErrorCode({}, "fallback"), "fallback");
  assert.equal(apiErrorCode({ error: "" }, "fallback"), "fallback");
  assert.match(
    diagnosticCancellationErrorMessage("workspace_owner_required"),
    /owner\/admin/u,
  );
  assert.match(
    diagnosticCancellationErrorMessage("run_not_found"),
    /não existe mais/u,
  );
  assert.match(
    diagnosticCancellationErrorMessage("conflict_retry"),
    /se desejar/u,
  );
  assert.match(
    diagnosticCancellationErrorMessage("unknown"),
    /Não foi possível confirmar/u,
  );
});

test("applies detail only to the latest request for the intended run", () => {
  assert.equal(
    shouldApplyDiagnosticDetail({
      requestId: 4,
      latestRequestId: 4,
      runId: "run-b",
      selectedRunId: "run-b",
    }),
    true,
  );
  assert.equal(
    shouldApplyDiagnosticDetail({
      requestId: 3,
      latestRequestId: 4,
      runId: "run-a",
      selectedRunId: "run-b",
    }),
    false,
  );
  assert.equal(
    shouldApplyDiagnosticDetail({
      requestId: 4,
      latestRequestId: 4,
      runId: "run-a",
      selectedRunId: "run-b",
    }),
    false,
  );
});

test("polls only the displayed run that is still the intended selection", () => {
  const queued = run({ id: "run-a", status: "queued" });
  const leased = run({ id: "run-a", status: "leased" });
  assert.equal(shouldPollDiagnosticDetail(queued, "run-a"), true);
  assert.equal(shouldPollDiagnosticDetail(leased, "run-a"), true);
  assert.equal(shouldPollDiagnosticDetail(queued, "run-b"), false);
  assert.equal(
    shouldPollDiagnosticDetail(
      run({ id: "run-a", status: "completed" }),
      "run-a",
    ),
    false,
  );
});

test("labels assignment and reads expiry only from the server field", () => {
  const pool = run();
  const assigned = run({
    assignedRunnerId: `rnr_${"b".repeat(32)}`,
    requiredCapability: "bubblewrap",
    expired: true,
  });
  assert.equal(runAssignmentLabel(pool), "Pool · qualquer runner ativo");
  assert.equal(runAssignmentLabel(assigned), "Atribuído · rnr_bbbbbbbb…bbbbbb");
  assert.equal(isDerivedExpired(pool), false);
  assert.equal(isDerivedExpired(assigned), true);
  assert.equal(
    isDerivedExpired(run({ deadlineAt: "2000-01-01T00:00:00.000Z" })),
    false,
  );
});

test("keeps the seven capability options closed and human-readable", () => {
  assert.deepEqual(RUNNER_CAPABILITY_OPTIONS, [
    "node_permission_model",
    "bubblewrap",
    "landlock",
    "seccomp",
    "user_namespace",
    "docker",
    "podman",
  ]);
  assert.equal(
    runnerCapabilityLabel("node_permission_model"),
    "Node Permission Model",
  );
  assert.equal(runnerCapabilityLabel("podman"), "Podman");
});

test("renders stored status beside derived expiry and assigned claim facts", () => {
  const assigned = run({
    assignedRunnerId: `rnr_${"b".repeat(32)}`,
    requiredCapability: "bubblewrap",
    expired: true,
  });
  const html = renderToStaticMarkup(
    createElement(
      "div",
      null,
      createElement(DiagnosticRunBadges, { run: assigned }),
      createElement(DiagnosticRunAssignmentFacts, { run: assigned }),
    ),
  );
  assert.match(html, /Aguardando runner/u);
  assert.match(html, /PRAZO EXPIRADO · DERIVADO/u);
  assert.match(html, /Atribuído · rnr_bbbbbbbb…bbbbbb/u);
  assert.match(html, /Bubblewrap/u);
  assert.match(html, /não elegibilidade/iu);
  assert.match(html, /nunca volta ao pool/iu);
  assert.doesNotMatch(html, /status-expired/u);
});

test("renders pool work without fabricating assignment or expiry", () => {
  const html = renderToStaticMarkup(
    createElement(
      "div",
      null,
      createElement(DiagnosticRunBadges, { run: run() }),
      createElement(DiagnosticRunAssignmentFacts, { run: run() }),
    ),
  );
  assert.match(html, /Pool · qualquer runner ativo/u);
  assert.match(html, /Capacidade exigida/u);
  assert.match(html, />nenhuma</u);
  assert.doesNotMatch(html, /PRAZO EXPIRADO/u);
  assert.doesNotMatch(html, /Atribuído/u);
});
