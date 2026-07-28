export const ENGINE_RUN_UI_LIMITS = Object.freeze({
  options: 200,
  promptMaxBytes: 8_192,
  promptMinBytes: 1,
  runs: 200,
});

export type EngineRunEngine = "claude_code_cli" | "codex_cli";
export type EngineRunStoredStatus =
  | "queued"
  | "leased"
  | "completed"
  | "canceled"
  | "expired";
export type EngineRunOutcomeStatus = "succeeded" | "failed" | "canceled";
export type EngineRunProbeStatus = "available" | "unavailable" | "unknown";
export type EngineRunReadiness =
  | "ready"
  | "attention_required"
  | "unknown";
export type EngineRunFreshness =
  | "fresh"
  | "stale"
  | "future"
  | "absent"
  | "not_evaluated";
export type EngineRunDeadlineState =
  | "pending"
  | "overdue_awaiting_reconciliation"
  | "settled";

export type EngineRunOptionView = {
  optionId: string;
  assignedRunnerId: string;
  runnerDisplayName: string;
  engine: EngineRunEngine;
  engineVersion: string | null;
  status: EngineRunProbeStatus | null;
  readiness: EngineRunReadiness | null;
  reason: string | null;
  freshness: EngineRunFreshness;
  reportId: string | null;
  reportReceivedAt: string | null;
  freshUntil: string | null;
  evaluatedAt: string;
  trust: "hostReported";
  eligible: boolean;
  disabledReasonCode: string | null;
  disabledReason: string;
};

export type EngineRunListItemView = {
  id: string;
  assignedRunnerId: string;
  runnerDisplayName: string | null;
  engine: EngineRunEngine;
  storedStatus: EngineRunStoredStatus;
  deadlineAt: string;
  overdue: boolean;
  deadlineState: EngineRunDeadlineState;
  createdAt: string;
  updatedAt: string;
};

export type EngineRunReceiptStreamView = {
  bytes: number;
  excerptBytes: number;
  sha256: string;
  truncated: boolean;
};

type EngineRunReceiptExcerptStorageView =
  | {
      excerptStorageState: "stored_encrypted";
      erasedAt?: never;
    }
  | {
      excerptStorageState: "erased";
      erasedAt: string;
    };

export type EngineRunReceiptView = {
  receiptSha256: string;
  engineVersion: string;
  status: EngineRunOutcomeStatus;
  reason: string;
  exitCode: number | null;
  timedOut: boolean;
  cancelRequested: boolean;
  startedAt: string;
  finishedAt: string;
  recordedAt: string;
  stdout: EngineRunReceiptStreamView;
  stderr: EngineRunReceiptStreamView;
} & EngineRunReceiptExcerptStorageView;

export type EngineRunDetailView = {
  run: EngineRunListItemView & {
    leaseGeneration: number;
    currentLeaseId: string | null;
    currentRunnerId: string | null;
  };
  eventsCount: number;
  eventsTruncated: boolean;
  receipt: EngineRunReceiptView | null;
};

type EngineRunOpaqueExcerptReceipt = {
  excerptRef: string;
  excerptSha256: string;
  receiptSha256: string;
  recordedAt: string;
  stdout: EngineRunReceiptStreamView;
  stderr: EngineRunReceiptStreamView;
};

type EngineRunOpaqueExcerptView =
  | { schemaVersion: 1; runId: string; state: "absent" }
  | {
      schemaVersion: 1;
      runId: string;
      state: "erased";
      erasedAt: string;
      receipt: EngineRunOpaqueExcerptReceipt;
    }
  | {
      schemaVersion: 1;
      runId: string;
      state: "stored";
      encoding: "base64url";
      interpretation: "opaque_bytes";
      stdoutBase64Url: string;
      stderrBase64Url: string;
      receipt: EngineRunOpaqueExcerptReceipt;
    };

export type EngineRunExcerptClientState =
  | { phase: "idle" }
  | { phase: "loading"; runId: string }
  | { phase: "loaded"; runId: string; excerpt: EngineRunOpaqueExcerptView }
  | {
      phase: "error";
      runId: string;
      reason:
        | "forbidden"
        | "temporarily_unavailable"
        | "not_found"
        | "invalid_response"
        | "transport_failure";
      message: string;
    };

export type EngineRunCreationState =
  | { phase: "idle" }
  | { phase: "submitting" }
  | {
      phase: "confirmed";
      creationId: string;
      runId: string;
      message: string;
    }
  | { phase: "failure_confirmed"; failureId: string; message: string }
  | {
      phase: "outcome_unknown";
      incidentId: string;
      message: string;
      requiredAction: "authoritative_reconciliation_required";
    }
  | {
      phase: "reconciled";
      incidentId: string;
      notCreatedProofId: string;
      resolution: "confirmed_not_created";
      message: string;
    };

export type EngineRunCreateRequestedEvent = {
  type: "engine_run.create_requested";
  executionMode: "one_shot_cli";
  retryPolicy: "none";
  request: {
    assignedRunnerId: string;
    engine: EngineRunEngine;
    prompt: string;
  };
};

export type EngineRunPromptEraseEvent = {
  type: "engine_run.prompt_erase_requested";
  reason: "creation_confirmed";
  runId: string;
  focusTargetId: string;
};

export type EngineRunReconciliationRequestedEvent = {
  type: "engine_run.creation_reconciliation_requested";
  incidentId: string;
  requiredEvidence: "authoritative_creation_result";
  listAbsenceIsConclusive: false;
};

export type EngineRunPanelEvent =
  | EngineRunCreateRequestedEvent
  | EngineRunPromptEraseEvent
  | EngineRunReconciliationRequestedEvent;

export type EngineRunSubmissionLatch = {
  current: boolean;
};

export type EngineRunCreationTransition = {
  erasePrompt: boolean;
  focusTargetId: string | null;
  promptEraseEvent: EngineRunPromptEraseEvent | null;
  releaseLatch: boolean;
  transitionKey: string | null;
};

export type EngineRunCreationGate = {
  canSubmit: boolean;
  blockedReason: string;
  promptBytes: number;
  selectedOption: EngineRunOptionView | null;
};

export type EngineRunsPanelViewModel = {
  detail: EngineRunDetailView | null;
  options: EngineRunOptionView[];
  optionsTruncated: boolean;
  runs: EngineRunListItemView[];
  runsTruncated: boolean;
};

export const ENGINE_RUN_TRUST_DISCLOSURE =
  "hostReported é uma observação enviada pelo host controlado pelo operador, não uma garantia ou reserva. Ready confirma somente checks limitados de binário, compatibilidade e autenticação local; não atesta sandbox, isolamento nem uma execução concluída.";

export const ENGINE_RUN_PRODUCT_BOUNDARY = Object.freeze([
  {
    capability: "One-shot CLI",
    state: "real",
    detail: "Uma análise por run atribuído, sem retry ou fallback automático.",
  },
  {
    capability: "Tools",
    state: "roadmap",
    detail: "Ferramentas gerais ainda não são executadas por este fluxo.",
  },
  {
    capability: "Sandbox",
    state: "roadmap",
    detail: "Readiness do host não prova isolamento do workload.",
  },
  {
    capability: "Workspace mutation",
    state: "roadmap",
    detail: "O fluxo não altera arquivos do workspace.",
  },
  {
    capability: "Streaming",
    state: "roadmap",
    detail: "A UI acompanha estados persistidos, não tokens em tempo real.",
  },
] as const);

export function engineRunPanelIds(prefix: string) {
  return {
    boundary: `${prefix}-boundary`,
    blockedReason: `${prefix}-blocked-reason`,
    detailRegion: `${prefix}-detail-region`,
    detailHeading: `${prefix}-detail-heading`,
    liveRegion: `${prefix}-live-region`,
    promptHelp: `${prefix}-prompt-help`,
    promptInput: `${prefix}-prompt`,
  };
}

export function engineRunCreationGate(input: {
  options: readonly EngineRunOptionView[];
  selectedOptionId: string;
  prompt: string;
  submitting: boolean;
}): EngineRunCreationGate {
  const promptBytes = utf8ByteLength(input.prompt);
  const selectedOption =
    input.options.find((option) => option.optionId === input.selectedOptionId) ??
    null;

  if (input.submitting) {
    return blocked(
      "Uma criação one-shot já está em confirmação. Não há retry ou fallback automático.",
      promptBytes,
      selectedOption,
    );
  }
  if (input.options.length === 0) {
    return blocked(
      "Nenhum runner com engine foi projetado pela autoridade do servidor.",
      promptBytes,
      null,
    );
  }
  if (!input.selectedOptionId) {
    return blocked(
      "Escolha uma combinação de runner atribuído e engine.",
      promptBytes,
      null,
    );
  }
  if (!selectedOption) {
    return blocked(
      "A opção escolhida não está mais na projeção atual. Escolha outra.",
      promptBytes,
      null,
    );
  }
  if (!selectedOption.eligible) {
    return blocked(
      selectedOption.disabledReason ||
        "A autoridade do servidor não considera esta opção elegível agora.",
      promptBytes,
      selectedOption,
    );
  }
  if (!isWellFormedUnicode(input.prompt)) {
    return blocked(
      "O prompt contém um surrogate Unicode isolado e não forma UTF-8 válido.",
      promptBytes,
      selectedOption,
    );
  }
  if (promptBytes < ENGINE_RUN_UI_LIMITS.promptMinBytes) {
    return blocked(
      "Digite um prompt de pelo menos 1 byte UTF-8.",
      promptBytes,
      selectedOption,
    );
  }
  if (promptBytes > ENGINE_RUN_UI_LIMITS.promptMaxBytes) {
    return blocked(
      `O prompt tem ${promptBytes} bytes UTF-8; o limite é 8192.`,
      promptBytes,
      selectedOption,
    );
  }
  return {
    canSubmit: true,
    blockedReason: "",
    promptBytes,
    selectedOption,
  };
}

export function buildEngineRunCreateRequestedEvent(input: {
  options: readonly EngineRunOptionView[];
  selectedOptionId: string;
  prompt: string;
}):
  | { ok: true; event: EngineRunCreateRequestedEvent }
  | { ok: false; blockedReason: string } {
  const gate = engineRunCreationGate({
    ...input,
    submitting: false,
  });
  if (!gate.canSubmit || !gate.selectedOption) {
    return { ok: false, blockedReason: gate.blockedReason };
  }
  return {
    ok: true,
    event: {
      type: "engine_run.create_requested",
      executionMode: "one_shot_cli",
      retryPolicy: "none",
      request: {
        assignedRunnerId: gate.selectedOption.assignedRunnerId,
        engine: gate.selectedOption.engine,
        prompt: input.prompt,
      },
    },
  };
}

export function engineRunCreationConfirmedEvent(input: {
  runId: string;
  focusTargetId: string;
}): EngineRunPromptEraseEvent {
  return {
    type: "engine_run.prompt_erase_requested",
    reason: "creation_confirmed",
    runId: input.runId,
    focusTargetId: input.focusTargetId,
  };
}

export function engineRunReconciliationRequestedEvent(
  incidentId: string,
): EngineRunReconciliationRequestedEvent {
  return {
    type: "engine_run.creation_reconciliation_requested",
    incidentId,
    requiredEvidence: "authoritative_creation_result",
    listAbsenceIsConclusive: false,
  };
}

export function acquireEngineRunSubmissionLatch(
  latch: EngineRunSubmissionLatch,
) {
  if (latch.current) return false;
  latch.current = true;
  return true;
}

export function releaseEngineRunSubmissionLatch(
  latch: EngineRunSubmissionLatch,
  transition: EngineRunCreationTransition,
) {
  if (!transition.releaseLatch) return false;
  latch.current = false;
  return true;
}

export function engineRunCreationTransition(input: {
  state: EngineRunCreationState;
  detailFocusTargetId: string;
}): EngineRunCreationTransition {
  const { state } = input;
  if (state.phase === "confirmed") {
    return {
      erasePrompt: true,
      focusTargetId: input.detailFocusTargetId,
      promptEraseEvent: engineRunCreationConfirmedEvent({
        runId: state.runId,
        focusTargetId: input.detailFocusTargetId,
      }),
      releaseLatch: true,
      transitionKey: `confirmed:${state.creationId}`,
    };
  }
  if (state.phase === "failure_confirmed") {
    return {
      erasePrompt: false,
      focusTargetId: null,
      promptEraseEvent: null,
      releaseLatch: true,
      transitionKey: `failed:${state.failureId}`,
    };
  }
  if (state.phase === "reconciled") {
    return {
      erasePrompt: false,
      focusTargetId: null,
      promptEraseEvent: null,
      releaseLatch: true,
      transitionKey:
        `reconciled:${state.incidentId}:${state.notCreatedProofId}`,
    };
  }
  return {
    erasePrompt: false,
    focusTargetId: null,
    promptEraseEvent: null,
    releaseLatch: false,
    transitionKey: null,
  };
}

export function buildEngineRunsPanelViewModel(input: {
  options: readonly EngineRunOptionView[];
  runs: readonly EngineRunListItemView[];
  selectedRunId: string;
  detail: EngineRunDetailView | null;
}): EngineRunsPanelViewModel {
  const options = input.options.slice(0, ENGINE_RUN_UI_LIMITS.options);
  const runs = input.runs.slice(0, ENGINE_RUN_UI_LIMITS.runs);
  return {
    options,
    optionsTruncated: input.options.length > options.length,
    runs,
    runsTruncated: input.runs.length > runs.length,
    detail:
      input.detail?.run.id === input.selectedRunId ? input.detail : null,
  };
}

export function shouldPollEngineRun(run: EngineRunListItemView) {
  return run.storedStatus === "queued" || run.storedStatus === "leased";
}

export function engineRunStatusLabel(status: EngineRunStoredStatus) {
  return {
    queued: "Aguardando runner",
    leased: "Lease ativa",
    completed: "Concluído",
    canceled: "Cancelado",
    expired: "Expirado persistido",
  }[status];
}

export function isEngineRunOverdue(run: EngineRunListItemView) {
  return (
    (run.storedStatus === "queued" || run.storedStatus === "leased") &&
    run.overdue &&
    run.deadlineState === "overdue_awaiting_reconciliation"
  );
}

export function engineRunOutcomeLabel(status: EngineRunOutcomeStatus) {
  return {
    succeeded: "Succeeded",
    failed: "Failed",
    canceled: "Canceled",
  }[status];
}

export function engineRunEngineLabel(engine: EngineRunEngine) {
  return {
    claude_code_cli: "Claude Code CLI",
    codex_cli: "Codex CLI",
  }[engine];
}

export function engineRunOptionLabel(option: EngineRunOptionView) {
  const version = option.engineVersion ? ` · ${option.engineVersion}` : "";
  return `${option.runnerDisplayName} · ${engineRunEngineLabel(option.engine)}${version}`;
}

export function engineRunLiveMessage(state: EngineRunCreationState) {
  if (state.phase === "submitting") {
    return "Confirmando uma criação one-shot. Nenhum retry será iniciado.";
  }
  if (state.phase === "confirmed") return state.message;
  if (state.phase === "failure_confirmed") return state.message;
  if (state.phase === "outcome_unknown") {
    return `${state.message} O run pode ter sido criado. A ausência em uma página da lista não encerra esta incerteza; obtenha um resultado autoritativo antes de qualquer novo envio.`;
  }
  if (state.phase === "reconciled") return state.message;
  return "";
}

export function utf8ByteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

export function isWellFormedUnicode(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function formatEngineRunTime(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "data inválida";
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "America/Sao_Paulo",
  }).format(date);
}

export function compactEngineRunId(value: string) {
  return value.length > 20 ? `${value.slice(0, 12)}…${value.slice(-6)}` : value;
}

function blocked(
  blockedReason: string,
  promptBytes: number,
  selectedOption: EngineRunOptionView | null,
): EngineRunCreationGate {
  return {
    canSubmit: false,
    blockedReason,
    promptBytes,
    selectedOption,
  };
}
