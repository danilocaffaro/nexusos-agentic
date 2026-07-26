import assert from "node:assert/strict";
import test from "node:test";
import {
  approveIntent,
  appendLedgerEntry,
  cancelIntent,
  canonicalJson,
  claimIntentForExecution,
  completeIntent,
  createIntent,
  failApprovedIntent,
  IntentTransitionError,
  proposeIntent,
  verifyLedgerChain,
} from "../../src/domain/governance/index";

const NOW = "2026-07-25T12:00:00.000Z";
const LATER = "2026-07-25T12:05:00.000Z";

async function proposedIntent(requiredApprovals = 1) {
  const draft = await createIntent({
    id: "intent-1",
    organizationId: "org-1",
    projectId: "project-1",
    proposerId: "agent-1",
    proposerKind: "agent",
    actionType: "github.pr.create",
    targetRef: "github:repo:main",
    parameters: { title: "Ship governed work", draft: true },
    preconditions: [{ ref: "github:repo:head", observedVersion: "abc123" }],
    riskTier: "medium",
    policyDecision: {
      effect: "require_approval",
      policyVersion: "policy-v1",
      reasons: ["External repository write"],
      evaluatedAt: NOW,
    },
    requiredApprovals,
    separationOfDuties: true,
    expiresAt: "2026-07-25T13:00:00.000Z",
    idempotencyKey: "project-1:work-1:pr",
    now: NOW,
  });
  return proposeIntent(draft, NOW);
}

test("canonical JSON is stable across object insertion order", () => {
  assert.equal(
    canonicalJson({ z: 1, a: { y: true, x: "ok" } }),
    canonicalJson({ a: { x: "ok", y: true }, z: 1 }),
  );
});

test("canonical JSON rejects values that cannot be audited", () => {
  assert.throws(() => canonicalJson({ unsafe: undefined }), TypeError);
  assert.throws(() => canonicalJson({ unsafe: Number.NaN }), TypeError);
  assert.throws(() => canonicalJson({ unsafe: new Date(NOW) }), TypeError);
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.throws(() => canonicalJson(circular), TypeError);
});

test("an agent cannot approve an ActionIntent", async () => {
  const intent = await proposedIntent();
  assert.throws(
    () =>
      approveIntent(intent, {
        actorId: "agent-2",
        actorKind: "agent",
        parametersHash: intent.parametersHash,
        approvedAt: LATER,
      }),
    (error: unknown) =>
      error instanceof IntentTransitionError && error.code === "invalid_actor",
  );
});

test("approval is bound to the immutable parameter hash", async () => {
  const intent = await proposedIntent();
  assert.throws(
    () =>
      approveIntent(intent, {
        actorId: "human-1",
        actorKind: "human",
        parametersHash: "tampered",
        approvedAt: LATER,
      }),
    (error: unknown) =>
      error instanceof IntentTransitionError &&
      error.code === "payload_mismatch",
  );
});

test("the proposer cannot self-approve", async () => {
  const intent = await proposedIntent();
  assert.throws(
    () =>
      approveIntent(intent, {
        actorId: "agent-1",
        actorKind: "human",
        parametersHash: intent.parametersHash,
        approvedAt: LATER,
      }),
    (error: unknown) =>
      error instanceof IntentTransitionError &&
      error.code === "separation_of_duties",
  );
});

test("a solo owner must explicitly acknowledge self-approval", async () => {
  const separated = await proposedIntent();
  const soloOwnerIntent = {
    ...separated,
    proposerId: "human-1",
    proposerKind: "human" as const,
    separationOfDuties: false,
    selfApprovalPolicy: "solo_owner" as const,
  };
  assert.throws(
    () =>
      approveIntent(soloOwnerIntent, {
        actorId: "human-1",
        actorKind: "human",
        parametersHash: soloOwnerIntent.parametersHash,
        approvedAt: LATER,
      }),
    (error: unknown) =>
      error instanceof IntentTransitionError &&
      error.code === "self_approval_ack_required",
  );
  const approved = approveIntent(soloOwnerIntent, {
    actorId: "human-1",
    actorKind: "human",
    parametersHash: soloOwnerIntent.parametersHash,
    soloOwnerAcknowledged: true,
    approvedAt: LATER,
  });
  assert.equal(approved.status, "approved");
  assert.equal(approved.approvals[0].soloOwnerAcknowledged, true);
});

test("only the proposer can cancel an open intent", async () => {
  const intent = await proposedIntent();
  assert.throws(
    () => cancelIntent(intent, "human-1", LATER),
    (error: unknown) =>
      error instanceof IntentTransitionError && error.code === "invalid_actor",
  );
  assert.equal(cancelIntent(intent, "agent-1", LATER).status, "cancelled");
});

test("required distinct approvals are enforced", async () => {
  const intent = await proposedIntent(2);
  const once = approveIntent(intent, {
    actorId: "human-1",
    actorKind: "human",
    parametersHash: intent.parametersHash,
    approvedAt: LATER,
  });
  assert.equal(once.status, "proposed");

  const twice = approveIntent(once, {
    actorId: "human-2",
    actorKind: "human",
    parametersHash: intent.parametersHash,
    approvedAt: "2026-07-25T12:06:00.000Z",
  });
  assert.equal(twice.status, "approved");
  assert.throws(
    () =>
      approveIntent(twice, {
        actorId: "human-2",
        actorKind: "human",
        parametersHash: intent.parametersHash,
        approvedAt: "2026-07-25T12:07:00.000Z",
      }),
    (error: unknown) =>
      error instanceof IntentTransitionError &&
      error.code === "duplicate_approval",
  );
});

test("invalid and expired timestamps fail closed", async () => {
  const proposed = await proposedIntent();
  const malformed = { ...proposed, expiresAt: "not-a-date" };
  assert.throws(
    () =>
      approveIntent(malformed, {
        actorId: "human-1",
        actorKind: "human",
        parametersHash: malformed.parametersHash,
        approvedAt: LATER,
      }),
    (error: unknown) =>
      error instanceof IntentTransitionError &&
      error.code === "invalid_timestamp",
  );

  assert.throws(
    () =>
      approveIntent(proposed, {
        actorId: "human-1",
        actorKind: "human",
        parametersHash: proposed.parametersHash,
        approvedAt: "2026-07-25T13:00:00.000Z",
      }),
    (error: unknown) =>
      error instanceof IntentTransitionError && error.code === "expired",
  );
});

test("execution rejects stale world state and stale fencing tokens", async () => {
  const proposed = await proposedIntent();
  const approved = approveIntent(proposed, {
    actorId: "human-1",
    actorKind: "human",
    parametersHash: proposed.parametersHash,
    approvedAt: LATER,
  });

  assert.throws(
    () =>
      claimIntentForExecution(
        approved,
        { "github:repo:head": "changed" },
        1,
        "2026-07-25T12:10:00.000Z",
      ),
    (error: unknown) =>
      error instanceof IntentTransitionError &&
      error.code === "stale_precondition",
  );

  const executing = claimIntentForExecution(
    approved,
    { "github:repo:head": "abc123" },
    7,
    "2026-07-25T12:10:00.000Z",
  );
  assert.throws(
    () =>
      completeIntent(
        executing,
        6,
        "succeeded",
        "2026-07-25T12:11:00.000Z",
      ),
    (error: unknown) =>
      error instanceof IntentTransitionError &&
      error.code === "invalid_fencing_token",
  );
  assert.equal(
    completeIntent(
      executing,
      7,
      "succeeded",
      "2026-07-25T12:11:00.000Z",
    ).status,
    "succeeded",
  );
});

test("an approved intent can fail closed before an effect starts", async () => {
  const proposed = await proposedIntent();
  const approved = approveIntent(proposed, {
    actorId: "human-1",
    actorKind: "human",
    parametersHash: proposed.parametersHash,
    approvedAt: LATER,
  });
  assert.equal(
    failApprovedIntent(
      approved,
      "2026-07-25T12:10:00.000Z",
    ).status,
    "failed",
  );
  assert.throws(
    () => failApprovedIntent(proposed, "2026-07-25T12:10:00.000Z"),
    (error: unknown) =>
      error instanceof IntentTransitionError && error.code === "invalid_state",
  );
});

test("ledger is hash chained and detects tampering", async () => {
  const first = await appendLedgerEntry(undefined, {
    id: "ledger-1",
    organizationId: "org-1",
    kind: "intent.proposed",
    actorId: "agent-1",
    occurredAt: NOW,
    payloadHash: "a".repeat(64),
    payloadRef: "r2://evidence/intent-1",
    intentId: "intent-1",
  });
  const second = await appendLedgerEntry(first, {
    id: "ledger-2",
    organizationId: "org-1",
    kind: "intent.approved",
    actorId: "human-1",
    occurredAt: LATER,
    payloadHash: "b".repeat(64),
    intentId: "intent-1",
  });

  assert.deepEqual(await verifyLedgerChain([first, second]), {
    valid: true,
    headHash: second.hash,
    entries: 2,
  });

  const tampered = { ...second, actorId: "attacker" };
  assert.deepEqual(await verifyLedgerChain([first, tampered]), {
    valid: false,
    entryId: "ledger-2",
    sequence: 2,
    reason: "content_hash",
  });
});

test("ledger append and verify share one field projection", async () => {
  const entry = await appendLedgerEntry(undefined, {
    id: "ledger-empty-ref",
    organizationId: "org-1",
    kind: "decision.recorded",
    actorId: "human-1",
    occurredAt: NOW,
    payloadHash: "c".repeat(64),
    payloadRef: "",
  });
  assert.equal((await verifyLedgerChain([entry])).valid, true);

  await assert.rejects(
    appendLedgerEntry(entry, {
      id: "ledger-cross-org",
      organizationId: "org-2",
      kind: "decision.recorded",
      actorId: "human-1",
      occurredAt: LATER,
      payloadHash: "d".repeat(64),
    }),
    TypeError,
  );
});
