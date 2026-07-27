import type {
  DiagnosticRun,
} from "@/src/contracts/runs";
import type {
  RunnerCapabilityName,
} from "@/src/contracts/runners";

export type DiagnosticCreationMode = "pool" | "assigned";

export function buildAssignedRunBody(
  assignedRunnerId: string,
  requiredCapability: RunnerCapabilityName | "",
) {
  return JSON.stringify({
    assignedRunnerId,
    ...(requiredCapability ? { requiredCapability } : {}),
  });
}

export function diagnosticCreationErrorMessage(
  code: string,
  mode: DiagnosticCreationMode,
) {
  const messages: Record<string, string> = {
    authentication_required: "Sua sessão precisa ser renovada.",
    forbidden: "Somente owner/admin pode criar diagnósticos.",
    workspace_owner_required:
      "Somente owner/admin pode criar diagnósticos.",
    invalid_diagnostic_request:
      "O servidor rejeitou a requisição pool na validação.",
    invalid_assigned_run_request:
      "O servidor rejeitou a atribuição na validação.",
    runner_not_found:
      "O runner atribuído não pertence a este workspace.",
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

export function runAssignmentLabel(run: DiagnosticRun) {
  return run.assignedRunnerId
    ? `Atribuído · ${compactOpaqueId(run.assignedRunnerId)}`
    : "Pool · qualquer runner ativo";
}

export function isDerivedExpired(run: DiagnosticRun) {
  return run.expired === true;
}

function compactOpaqueId(value: string) {
  return value.length > 20
    ? `${value.slice(0, 12)}…${value.slice(-6)}`
    : value;
}
