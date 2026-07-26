import type {
  ActionIntent,
  IntentApproval,
  PrincipalKind,
} from "../../contracts/governance";
import { hashCanonical } from "./crypto";

export class IntentTransitionError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_state"
      | "expired"
      | "invalid_actor"
      | "separation_of_duties"
      | "payload_mismatch"
      | "duplicate_approval"
      | "missing_approvals"
      | "stale_precondition"
      | "invalid_fencing_token"
      | "invalid_timestamp",
  ) {
    super(message);
    this.name = "IntentTransitionError";
  }
}

export type CreateIntentInput = Omit<
  ActionIntent,
  "parametersHash" | "approvals" | "status" | "createdAt" | "updatedAt"
> & {
  now: string;
};

export async function createIntent(
  input: CreateIntentInput,
): Promise<ActionIntent> {
  if (input.requiredApprovals < 1) {
    throw new TypeError("requiredApprovals must be at least 1");
  }

  const { now, ...definition } = input;
  const nowInstant = parseInstant(now, "now");
  const expiryInstant = parseInstant(input.expiresAt, "expiresAt");
  if (expiryInstant <= nowInstant) {
    throw new IntentTransitionError(
      "expiresAt must be later than now",
      "invalid_timestamp",
    );
  }
  parseInstant(input.policyDecision.evaluatedAt, "policyDecision.evaluatedAt");
  return {
    ...definition,
    parametersHash: await hashCanonical(input.parameters),
    approvals: [],
    status: "draft",
    createdAt: now,
    updatedAt: now,
  };
}

export function proposeIntent(intent: ActionIntent, now: string): ActionIntent {
  requireStatus(intent, ["draft"]);
  requireNotExpired(intent, now);
  return { ...intent, status: "proposed", updatedAt: now };
}

export function approveIntent(
  intent: ActionIntent,
  approval: Omit<IntentApproval, "approvedAt"> & { approvedAt: string },
): ActionIntent {
  requireStatus(intent, ["proposed", "approved"]);
  requireNotExpired(intent, approval.approvedAt);

  if (approval.actorKind !== "human") {
    throw new IntentTransitionError(
      "Only a human principal can approve an intent",
      "invalid_actor",
    );
  }
  if (approval.actorId === intent.proposerId) {
    throw new IntentTransitionError(
      "The proposer cannot approve this intent",
      "separation_of_duties",
    );
  }
  if (approval.parametersHash !== intent.parametersHash) {
    throw new IntentTransitionError(
      "Approval does not match the proposed parameters",
      "payload_mismatch",
    );
  }
  if (intent.approvals.some((item) => item.actorId === approval.actorId)) {
    throw new IntentTransitionError(
      "The same principal cannot approve twice",
      "duplicate_approval",
    );
  }

  const approvals = [...intent.approvals, approval];
  return {
    ...intent,
    approvals,
    status:
      approvals.length >= intent.requiredApprovals ? "approved" : "proposed",
    updatedAt: approval.approvedAt,
  };
}

export function rejectIntent(
  intent: ActionIntent,
  actor: { id: string; kind: PrincipalKind },
  now: string,
): ActionIntent {
  requireStatus(intent, ["proposed", "approved"]);
  if (actor.kind !== "human") {
    throw new IntentTransitionError(
      "Only a human principal can reject an intent",
      "invalid_actor",
    );
  }
  parseInstant(now, "now");
  return { ...intent, status: "rejected", updatedAt: now };
}

export function cancelIntent(
  intent: ActionIntent,
  actorId: string,
  now: string,
): ActionIntent {
  requireStatus(intent, ["draft", "proposed", "approved"]);
  if (actorId !== intent.proposerId) {
    throw new IntentTransitionError(
      "Only the proposer can cancel this intent directly",
      "invalid_actor",
    );
  }
  parseInstant(now, "now");
  return { ...intent, status: "cancelled", updatedAt: now };
}

export function expireIntent(intent: ActionIntent, now: string): ActionIntent {
  requireStatus(intent, ["proposed", "approved"]);
  if (
    parseInstant(now, "now") <
    parseInstant(intent.expiresAt, "expiresAt")
  ) {
    throw new IntentTransitionError(
      "Intent has not reached its expiry time",
      "invalid_state",
    );
  }
  return { ...intent, status: "expired", updatedAt: now };
}

export function claimIntentForExecution(
  intent: ActionIntent,
  currentVersions: Record<string, string>,
  fencingToken: number,
  now: string,
): ActionIntent {
  requireStatus(intent, ["approved"]);
  requireNotExpired(intent, now);
  if (intent.approvals.length < intent.requiredApprovals) {
    throw new IntentTransitionError(
      "Intent does not have enough approvals",
      "missing_approvals",
    );
  }
  for (const precondition of intent.preconditions) {
    if (currentVersions[precondition.ref] !== precondition.observedVersion) {
      throw new IntentTransitionError(
        `Precondition changed for ${precondition.ref}`,
        "stale_precondition",
      );
    }
  }
  if (!Number.isSafeInteger(fencingToken) || fencingToken < 1) {
    throw new IntentTransitionError(
      "Fencing token must be a positive safe integer",
      "invalid_fencing_token",
    );
  }
  return { ...intent, status: "executing", fencingToken, updatedAt: now };
}

export function completeIntent(
  intent: ActionIntent,
  fencingToken: number,
  outcome: "succeeded" | "failed" | "interrupted",
  now: string,
): ActionIntent {
  requireStatus(intent, ["executing"]);
  if (intent.fencingToken !== fencingToken) {
    throw new IntentTransitionError(
      "A stale execution lease cannot complete this intent",
      "invalid_fencing_token",
    );
  }
  parseInstant(now, "now");
  return { ...intent, status: outcome, updatedAt: now };
}

function requireStatus(
  intent: ActionIntent,
  allowed: ActionIntent["status"][],
): void {
  if (!allowed.includes(intent.status)) {
    throw new IntentTransitionError(
      `Cannot transition intent from ${intent.status}`,
      "invalid_state",
    );
  }
}

function requireNotExpired(intent: ActionIntent, now: string): void {
  if (
    parseInstant(now, "now") >=
    parseInstant(intent.expiresAt, "expiresAt")
  ) {
    throw new IntentTransitionError("Intent has expired", "expired");
  }
}

const INSTANT_WITH_TIMEZONE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

function parseInstant(value: string, field: string): number {
  if (!INSTANT_WITH_TIMEZONE.test(value)) {
    throw new IntentTransitionError(
      `${field} must be an ISO-8601 timestamp with timezone`,
      "invalid_timestamp",
    );
  }
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) {
    throw new IntentTransitionError(
      `${field} is not a valid timestamp`,
      "invalid_timestamp",
    );
  }
  return instant;
}
