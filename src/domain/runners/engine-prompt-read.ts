export type EnginePromptReadSnapshot = {
  runnerActive: boolean;
  runnerId: string;
  runnerOrganizationId: string;
  now: string;
  leaseId: string;
  fence: number;
  promptRef: string;
  run: {
    organizationId: string;
    kind: string;
    engine: string | null;
    status: string;
    cancelRequestedAt: string | null;
    assignedRunnerId: string | null;
    currentLeaseId: string | null;
    leaseGeneration: number;
    leaseRunnerId: string | null;
    leaseStatus: string | null;
    leaseExpiresAt: string | null;
    storedPromptRef: string;
    promptErasedAt: string | null;
  } | null;
};

export type EnginePromptReadAdmission =
  | { kind: "admitted" }
  | {
      kind: "denied";
      code:
        | "runner_rejected"
        | "run_unavailable"
        | "lease_superseded"
        | "lease_expired"
        | "prompt_unavailable"
        | "prompt_erased";
      status: 403 | 404 | 409 | 410;
    };

export function evaluateEnginePromptRead(
  snapshot: EnginePromptReadSnapshot,
): EnginePromptReadAdmission {
  if (!snapshot.runnerActive) {
    return denied("runner_rejected", 403);
  }
  const run = snapshot.run;
  if (
    !run ||
    run.organizationId !== snapshot.runnerOrganizationId ||
    run.kind !== "engine_prompt" ||
    !run.engine ||
    run.status !== "leased" ||
    run.cancelRequestedAt !== null ||
    run.assignedRunnerId !== snapshot.runnerId
  ) {
    return denied("run_unavailable", 409);
  }
  if (
    run.currentLeaseId !== snapshot.leaseId ||
    run.leaseGeneration !== snapshot.fence ||
    run.leaseRunnerId !== snapshot.runnerId ||
    run.leaseStatus !== "active"
  ) {
    return denied("lease_superseded", 409);
  }
  if (!run.leaseExpiresAt || run.leaseExpiresAt <= snapshot.now) {
    return denied("lease_expired", 410);
  }
  if (run.storedPromptRef !== snapshot.promptRef) {
    return denied("prompt_unavailable", 404);
  }
  if (run.promptErasedAt !== null) {
    return denied("prompt_erased", 410);
  }
  return { kind: "admitted" };
}

function denied(
  code: Extract<EnginePromptReadAdmission, { kind: "denied" }>["code"],
  status: Extract<EnginePromptReadAdmission, { kind: "denied" }>["status"],
): EnginePromptReadAdmission {
  return { kind: "denied", code, status };
}
