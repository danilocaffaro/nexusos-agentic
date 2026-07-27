import type { DiagnosticRun } from "@/src/contracts/runs";
import type {
  Runner,
  RunnerCapabilityName,
  RunnerLiveness,
} from "@/src/contracts/runners";

export type DiagnosticCreationMode = "pool" | "assigned";

export type AssignableDiagnosticRunner = {
  id: string;
  displayName: string;
  liveness: RunnerLiveness;
};

export function buildAssignedRunBody(
  assignedRunnerId: string,
  requiredCapability: RunnerCapabilityName | "",
) {
  return JSON.stringify({
    assignedRunnerId,
    ...(requiredCapability ? { requiredCapability } : {}),
  });
}

export function buildDiagnosticCreationRequest(
  mode: DiagnosticCreationMode,
  assignedRunnerId: string,
  requiredCapability: RunnerCapabilityName | "",
) {
  return mode === "assigned"
    ? {
        endpoint: "/api/runs/diagnostic/assigned",
        body: buildAssignedRunBody(assignedRunnerId, requiredCapability),
      }
    : {
        endpoint: "/api/runs/diagnostic",
        body: "{}",
      };
}

export function toAssignableDiagnosticRunners(
  runners: Runner[],
): AssignableDiagnosticRunner[] {
  return runners
    .filter((runner) => runner.status === "active")
    .map(({ id, displayName, liveness }) => ({
      id,
      displayName,
      liveness,
    }));
}

export function diagnosticCreationGate(input: {
  mode: DiagnosticCreationMode;
  assignableRunners: readonly AssignableDiagnosticRunner[];
  assignedRunnerId: string;
  requiredCapability: RunnerCapabilityName | "";
  allowedCapabilities: readonly RunnerCapabilityName[] | null;
}) {
  if (input.mode === "pool") {
    return { canSubmit: true, blockedReason: "" };
  }
  if (input.allowedCapabilities === null) {
    return {
      canSubmit: false,
      blockedReason:
        "A política de admissão ainda não está disponível. Aguarde a atualização do registro.",
    };
  }
  if (input.assignableRunners.length === 0) {
    return {
      canSubmit: false,
      blockedReason:
        "Nenhum runner ativo. Matricule ou reative uma identidade antes de usar Assigned.",
    };
  }
  if (!input.assignedRunnerId) {
    return {
      canSubmit: false,
      blockedReason:
        "Escolha um runner ativo para criar o diagnóstico atribuído.",
    };
  }
  if (
    !input.assignableRunners.some(
      (runner) => runner.id === input.assignedRunnerId,
    )
  ) {
    return {
      canSubmit: false,
      blockedReason:
        "O runner escolhido deixou o registro ativo. Escolha outro.",
    };
  }
  if (
    input.requiredCapability &&
    !input.allowedCapabilities.includes(input.requiredCapability)
  ) {
    return {
      canSubmit: false,
      blockedReason:
        "A capacidade escolhida está bloqueada pela política de admissão atual.",
    };
  }
  return { canSubmit: true, blockedReason: "" };
}

export function diagnosticCreationErrorMessage(
  code: string,
  mode: DiagnosticCreationMode,
) {
  const messages: Record<string, string> = {
    authentication_required: "Sua sessão precisa ser renovada.",
    forbidden: "Somente owner/admin pode criar diagnósticos.",
    workspace_owner_required: "Somente owner/admin pode criar diagnósticos.",
    invalid_diagnostic_request:
      "O servidor rejeitou a requisição pool na validação.",
    invalid_assigned_run_request:
      "O servidor rejeitou a atribuição na validação.",
    runner_not_found: "O runner atribuído não pertence a este workspace.",
    runner_not_active:
      "O runner atribuído não está mais ativo. Escolha outro e envie novamente.",
    conflict_retry:
      "Houve contenção no Decision Ledger. Envie novamente se desejar.",
  };
  return (
    messages[code] ??
    (mode === "assigned"
      ? "Não foi possível criar o diagnóstico atribuído com segurança."
      : "Não foi possível criar o diagnóstico pool com segurança.")
  );
}

export function diagnosticCancellationErrorMessage(code: string) {
  const messages: Record<string, string> = {
    authentication_required: "Sua sessão precisa ser renovada.",
    forbidden: "Somente owner/admin pode cancelar diagnósticos.",
    workspace_owner_required: "Somente owner/admin pode cancelar diagnósticos.",
    invalid_cancel_request:
      "O servidor rejeitou o pedido de cancelamento na validação.",
    run_not_found: "O diagnóstico não existe mais neste workspace.",
    conflict_retry:
      "Houve contenção no Decision Ledger. Solicite novamente se desejar.",
  };
  return (
    messages[code] ?? "Não foi possível confirmar o pedido de cancelamento."
  );
}

export function apiErrorCode(payload: unknown, fallback: string) {
  if (
    payload &&
    typeof payload === "object" &&
    "error" in payload &&
    typeof payload.error === "string" &&
    payload.error.length > 0
  ) {
    return payload.error;
  }
  return fallback;
}

export function shouldApplyDiagnosticDetail(input: {
  requestId: number;
  latestRequestId: number;
  runId: string;
  selectedRunId: string;
}) {
  return (
    input.requestId === input.latestRequestId &&
    input.runId === input.selectedRunId
  );
}

export function shouldPollDiagnosticDetail(
  run: DiagnosticRun,
  selectedRunId: string,
) {
  return (
    (run.status === "queued" || run.status === "leased") &&
    run.id === selectedRunId
  );
}

export function runAssignmentLabel(run: DiagnosticRun) {
  return run.assignedRunnerId
    ? `Atribuído · ${compactOpaqueId(run.assignedRunnerId)}`
    : "Pool · qualquer runner ativo";
}

export function isDerivedExpired(run: DiagnosticRun) {
  return run.expired === true;
}

function compactOpaqueId(value: string) {
  return value.length > 20 ? `${value.slice(0, 12)}…${value.slice(-6)}` : value;
}
