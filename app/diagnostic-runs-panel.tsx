"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DiagnosticRun,
  DiagnosticRunDetail,
  DiagnosticRunRegistry,
} from "@/src/contracts/runs";
import {
  apiErrorCode,
  diagnosticCancellationErrorMessage,
  diagnosticCreationErrorMessage,
  isDerivedExpired,
  runAssignmentLabel,
  shouldApplyDiagnosticDetail,
} from "./diagnostic-run-view";
import { runnerCapabilityLabel } from "./runner-capability-labels";

export function DiagnosticRunsPanel({
  notify,
}: {
  notify: (message: string) => void;
}) {
  const [registry, setRegistry] = useState<DiagnosticRunRegistry>({
    runs: [],
  });
  const [selected, setSelected] = useState<DiagnosticRunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState("");
  const selectedRunIdRef = useRef("");
  const selectionEpochRef = useRef(0);
  const detailRequestIdRef = useRef(0);
  const detailControllerRef = useRef<AbortController | null>(null);

  const loadRuns = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const response = await fetch("/api/runs", { cache: "no-store" });
      const payload = (await response.json().catch(() => ({}))) as
        DiagnosticRunRegistry | { error?: string };
      if (!response.ok || !("runs" in payload)) {
        throw new Error("run_list_unavailable");
      }
      setRegistry(payload);
      setError("");
      return payload;
    } catch {
      if (!quiet) setError("Não foi possível consultar os diagnósticos.");
      return null;
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (runId: string, quiet = false) => {
    const requestId = detailRequestIdRef.current + 1;
    detailRequestIdRef.current = requestId;
    detailControllerRef.current?.abort();
    const controller = new AbortController();
    detailControllerRef.current = controller;
    const isCurrent = () =>
      shouldApplyDiagnosticDetail({
        requestId,
        latestRequestId: detailRequestIdRef.current,
        runId,
        selectedRunId: selectedRunIdRef.current,
      });
    try {
      const response = await fetch(`/api/runs/${runId}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const payload = (await response.json().catch(() => ({}))) as
        DiagnosticRunDetail | { error?: string };
      if (!response.ok || !("run" in payload)) {
        throw new Error("run_detail_unavailable");
      }
      if (!isCurrent()) return null;
      setSelected(payload);
      if (!quiet) setError("");
      return payload;
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") {
        return null;
      }
      if (isCurrent() && !quiet) {
        setError("Não foi possível abrir a timeline do run.");
      }
      return null;
    } finally {
      if (detailControllerRef.current === controller) {
        detailControllerRef.current = null;
      }
    }
  }, []);

  const selectRun = useCallback(
    (runId: string) => {
      selectionEpochRef.current += 1;
      selectedRunIdRef.current = runId;
      void loadDetail(runId);
    },
    [loadDetail],
  );

  useEffect(() => {
    const initial = window.setTimeout(() => {
      void loadRuns();
    }, 0);
    const timer = window.setInterval(() => {
      void loadRuns(true);
      if (
        selected?.run.status === "queued" ||
        selected?.run.status === "leased"
      ) {
        void loadDetail(selected.run.id, true);
      }
    }, 5_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
      detailRequestIdRef.current += 1;
      detailControllerRef.current?.abort();
    };
  }, [loadDetail, loadRuns, selected?.run.id, selected?.run.status]);

  const command = useMemo(
    () =>
      selected ? `npm run runner -- diagnose --run ${selected.run.id}` : "",
    [selected],
  );

  const createRun = async () => {
    const selectionEpoch = selectionEpochRef.current;
    setMutating(true);
    setError("");
    try {
      const response = await fetch("/api/runs/diagnostic", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const payload = (await response.json().catch(() => ({}))) as
        DiagnosticRunDetail | { error?: string };
      if (!response.ok || !("run" in payload)) {
        throw new Error(apiErrorCode(payload, "run_create_failed"));
      }
      if (selectionEpoch === selectionEpochRef.current) {
        detailRequestIdRef.current += 1;
        detailControllerRef.current?.abort();
        selectedRunIdRef.current = payload.run.id;
        setSelected(payload);
      }
      await loadRuns(true);
      notify("Diagnóstico criado e registrado no Decision Ledger");
    } catch (cause) {
      setError(
        diagnosticCreationErrorMessage(
          cause instanceof Error ? cause.message : "run_create_failed",
          "pool",
        ),
      );
    } finally {
      setMutating(false);
    }
  };

  const cancelRun = async () => {
    if (!selected) return;
    const targetRunId = selected.run.id;
    const selectionEpoch = selectionEpochRef.current;
    setMutating(true);
    setError("");
    try {
      const response = await fetch(`/api/runs/${targetRunId}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const payload = (await response.json().catch(() => ({}))) as
        DiagnosticRunDetail | { error?: string };
      if (!response.ok || !("run" in payload)) {
        throw new Error(apiErrorCode(payload, "run_cancel_failed"));
      }
      if (
        selectionEpoch === selectionEpochRef.current &&
        selectedRunIdRef.current === targetRunId
      ) {
        detailRequestIdRef.current += 1;
        detailControllerRef.current?.abort();
        setSelected(payload);
      }
      await loadRuns(true);
      notify(
        payload.run.status === "canceled"
          ? "Diagnóstico cancelado e lease encerrada"
          : "Cancelamento solicitado ao holder da lease",
      );
    } catch (cause) {
      setError(
        diagnosticCancellationErrorMessage(
          cause instanceof Error ? cause.message : "run_cancel_failed",
        ),
      );
    } finally {
      setMutating(false);
    }
  };

  return (
    <section
      className="diagnostic-runs"
      data-testid="diagnostic-runs"
      aria-busy={loading}
    >
      <header>
        <div>
          <span className="section-number">03</span>
          <div>
            <span className="eyebrow">FENCED DIAGNOSTIC · S6.B2</span>
            <h2>Prove lease e replay antes de executar trabalho real.</h2>
            <p>
              O teste fechado dura 45 segundos, renova a lease duas vezes e
              persiste a conclusão antes da rede. Não abre shell nem provider
              CLI.
            </p>
          </div>
        </div>
        <button
          className="primary-button compact"
          onClick={() => void createRun()}
          disabled={mutating}
          data-testid="create-diagnostic-run"
        >
          {mutating ? "Preparando…" : "＋ Novo diagnóstico"}
        </button>
      </header>

      {error && (
        <p className="workspace-form-error runner-error" role="alert">
          {error}
        </p>
      )}

      <div className="diagnostic-layout">
        <div className="diagnostic-list" aria-label="Runs diagnósticos">
          {loading && registry.runs.length === 0 && (
            <p>Consultando a autoridade de leases…</p>
          )}
          {!loading && registry.runs.length === 0 && (
            <p>Nenhum diagnóstico criado.</p>
          )}
          {registry.runs.map((run) => (
            <button
              key={run.id}
              className={selected?.run.id === run.id ? "is-selected" : ""}
              onClick={() => selectRun(run.id)}
            >
              <DiagnosticRunBadges run={run} />
              <time dateTime={run.updatedAt}>
                {formatRunTime(run.updatedAt)}
              </time>
              <b>{compactId(run.id)}</b>
              <small className="diagnostic-assignment">
                {runAssignmentLabel(run)}
              </small>
              <small>
                fence {run.leaseGeneration || "—"} · claims {run.claimCount}/
                {run.maxClaims}
              </small>
              {run.requiredCapability && (
                <small className="diagnostic-requirement">
                  Exige {runnerCapabilityLabel(run.requiredCapability)}
                </small>
              )}
            </button>
          ))}
        </div>

        <div className="diagnostic-detail">
          {!selected ? (
            <div className="diagnostic-placeholder">
              <span>⌁</span>
              <h3>Crie ou selecione um diagnóstico.</h3>
              <p>
                A timeline mostrará cada claim, renew, fence, cancelamento e
                conclusão absorvida pelo outbox.
              </p>
            </div>
          ) : (
            <>
              <header>
                <div>
                  <DiagnosticRunBadges run={selected.run} />
                  <h3>{selected.run.id}</h3>
                </div>
                {(selected.run.status === "queued" ||
                  selected.run.status === "leased") && (
                  <button
                    className="text-button danger-text"
                    onClick={() => void cancelRun()}
                    disabled={mutating}
                  >
                    Solicitar cancelamento
                  </button>
                )}
              </header>

              {(selected.run.status === "queued" ||
                selected.run.status === "leased") && (
                <div className="diagnostic-command">
                  <small>
                    COMANDO SEM SEGREDO · EXECUTE NO HOST MATRICULADO
                  </small>
                  <code data-testid="diagnostic-command">{command}</code>
                  <button onClick={() => void copyRunCommand(command, notify)}>
                    Copiar
                  </button>
                </div>
              )}

              <dl className="diagnostic-proof">
                <div>
                  <dt>Fence atual</dt>
                  <dd>{selected.run.leaseGeneration || "não emitido"}</dd>
                </div>
                <div>
                  <dt>Lease</dt>
                  <dd>
                    {selected.run.currentLeaseId
                      ? compactId(selected.run.currentLeaseId)
                      : "aguardando claim"}
                  </dd>
                </div>
                <div>
                  <dt>Runner holder</dt>
                  <dd>
                    {selected.run.currentRunnerId
                      ? compactId(selected.run.currentRunnerId)
                      : "nenhum"}
                  </dd>
                </div>
                <div>
                  <dt>Duplicates absorvidos</dt>
                  <dd>{selected.run.replayCount}</dd>
                </div>
              </dl>

              <DiagnosticRunAssignmentFacts run={selected.run} />

              {selected.run.outcomeSummary && (
                <div className="diagnostic-outcome">
                  <b>{selected.run.outcomeStatus?.toUpperCase()}</b>
                  <p>{selected.run.outcomeSummary}</p>
                </div>
              )}

              <ol className="diagnostic-timeline">
                {selected.events.map((event) => (
                  <li key={event.sequence}>
                    <span>{String(event.sequence).padStart(2, "0")}</span>
                    <div>
                      <b>{eventLabel(event.kind)}</b>
                      <small>
                        {formatRunTime(event.occurredAt)}
                        {event.fence ? ` · fence ${event.fence}` : ""}
                      </small>
                    </div>
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

export function DiagnosticRunBadges({ run }: { run: DiagnosticRun }) {
  return (
    <span className="diagnostic-badges">
      <span className={`diagnostic-status status-${run.status}`}>
        {runStatus(run.status)}
      </span>
      {isDerivedExpired(run) && (
        <span className="diagnostic-expired">PRAZO EXPIRADO · DERIVADO</span>
      )}
    </span>
  );
}

export function DiagnosticRunAssignmentFacts({ run }: { run: DiagnosticRun }) {
  return (
    <>
      <dl className="diagnostic-assignment-proof">
        <div>
          <dt>Modo de roteamento</dt>
          <dd>{runAssignmentLabel(run)}</dd>
        </div>
        <div>
          <dt>Capacidade exigida</dt>
          <dd>
            {run.requiredCapability
              ? runnerCapabilityLabel(run.requiredCapability)
              : "nenhuma"}
          </dd>
        </div>
      </dl>
      <p className="diagnostic-claim-authority">
        A criação registra intenção e atribuição, não elegibilidade. O servidor
        reavalia runner, prazo, política e declaração no claim; trabalho
        atribuído nunca volta ao pool.
      </p>
    </>
  );
}

function runStatus(status: DiagnosticRun["status"]) {
  return {
    queued: "Aguardando runner",
    leased: "Lease ativa",
    completed: "Concluído",
    canceled: "Cancelado",
  }[status];
}

function eventLabel(kind: DiagnosticRunDetail["events"][number]["kind"]) {
  return {
    "run.created": "Run solicitado",
    "lease.claimed": "Lease adquirida",
    "lease.renewed": "Lease renovada",
    "lease.superseded": "Lease superseded por novo fence",
    "lease.released": "Lease liberada",
    "lease.revoked": "Lease revogada",
    "run.cancel_requested": "Cancelamento solicitado",
    "run.completed": "Outcome registrado uma vez",
    "run.canceled": "Run cancelado",
  }[kind];
}

function compactId(value: string) {
  return value.length > 20 ? `${value.slice(0, 12)}…${value.slice(-6)}` : value;
}

function formatRunTime(value: string) {
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

async function copyRunCommand(
  command: string,
  notify: (message: string) => void,
) {
  try {
    await navigator.clipboard.writeText(command);
    notify("Comando diagnóstico copiado sem segredo");
  } catch {
    notify("Não foi possível copiar; selecione o comando manualmente");
  }
}
