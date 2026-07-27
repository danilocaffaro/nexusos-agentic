"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import type {
  RunnerCapabilityReportPage,
  RunnerCapabilityReportView,
  RunnerDeclaredCapability,
} from "@/src/contracts/runners";

export function RunnerCapabilityHistory({
  runnerId,
  runnerName,
}: {
  runnerId: string;
  runnerName: string;
}) {
  const [reports, setReports] = useState<RunnerCapabilityReportView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [failedCursor, setFailedCursor] = useState<string | null>(null);
  const [retryFromStart, setRetryFromStart] = useState(false);
  const [started, setStarted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const requestIdRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const focusTimerRef = useRef<number | null>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(
    () => () => {
      requestIdRef.current += 1;
      controllerRef.current?.abort();
      if (focusTimerRef.current !== null) {
        window.clearTimeout(focusTimerRef.current);
      }
    },
    [],
  );

  const load = useCallback(
    async (cursor: string | null) => {
      controllerRef.current?.abort();
      if (focusTimerRef.current !== null) {
        window.clearTimeout(focusTimerRef.current);
        focusTimerRef.current = null;
      }
      const controller = new AbortController();
      controllerRef.current = controller;
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      const append = cursor !== null;
      const previousCount = reports.length;
      actionRef.current?.focus();
      setStarted(true);
      setLoading(true);
      setError("");
      setFailedCursor(null);
      setRetryFromStart(false);
      try {
        const response = await fetch(
          capabilityHistoryUrl(runnerId, cursor),
          { cache: "no-store", signal: controller.signal },
        );
        const value: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          const responseError = capabilityHistoryErrorCode(value);
          throw new Error(
            response.status === 404
              ? "runner_not_found"
              : response.status >= 400 && response.status < 500
                ? responseError ?? "history_cursor_invalid"
                : "history_unavailable",
          );
        }
        const page = readCapabilityReportPage(value, runnerId);
        if (!page) throw new Error("history_invalid");
        if (cursor !== null && page.nextCursor === cursor) {
          throw new Error("history_cursor_stalled");
        }
        if (requestId !== requestIdRef.current) return;

        setReports((current) =>
          append
            ? mergeCapabilityReportPages(current, page.reports)
            : mergeCapabilityReportPages([], page.reports),
        );
        setNextCursor(page.nextCursor);
        focusTimerRef.current = window.setTimeout(() => {
          focusTimerRef.current = null;
          if (requestId !== requestIdRef.current) return;
          if (actionRef.current !== document.activeElement) return;
          if (page.reports.length > 0) {
            const firstNewReport =
              listRef.current?.querySelector<HTMLElement>(
                `[data-report-position="${append ? previousCount : 0}"]`,
              );
            if (firstNewReport) {
              firstNewReport.focus();
              return;
            }
          }
        }, 0);
      } catch (caught) {
        if (
          controller.signal.aborted ||
          requestId !== requestIdRef.current
        ) {
          return;
        }
        const code = caught instanceof Error ? caught.message : "";
        const restart =
          code === "invalid_cursor" ||
          code === "unexpected_query_parameter" ||
          code === "history_cursor_invalid" ||
          code === "history_cursor_stalled" ||
          code === "history_invalid";
        setRetryFromStart(restart);
        setFailedCursor(restart ? null : cursor);
        setError(historyErrorMessage(code, reports.length > 0));
        focusTimerRef.current = window.setTimeout(() => {
          focusTimerRef.current = null;
          if (
            requestId === requestIdRef.current &&
            actionRef.current === document.activeElement
          ) {
            actionRef.current?.focus();
          }
        }, 0);
      } finally {
        if (requestId === requestIdRef.current) setLoading(false);
      }
    },
    [reports.length, runnerId],
  );

  const actionLabel = loading
    ? reports.length > 0
      ? "Carregando mais…"
      : "Carregando histórico…"
    : error
      ? retryFromStart
        ? "Recarregar do início"
        : "Tentar novamente"
      : !started
        ? "Carregar histórico"
        : nextCursor
          ? "Carregar mais"
          : reports.length > 0
            ? "Sem páginas anteriores"
            : "Nenhuma declaração";
  const actionCursor = error
    ? failedCursor
    : started
      ? nextCursor
      : null;
  const actionDisabled =
    loading ||
    (started && !error && nextCursor === null);
  const statusMessage = loading
    ? reports.length > 0
      ? "Carregando mais declarações."
      : "Carregando declarações."
    : error
      ? ""
      : started && reports.length === 0
        ? `Nenhuma declaração foi recebida para ${runnerName}.`
        : started && nextCursor === null
          ? "O servidor não retornou páginas anteriores a esta."
          : started
            ? `${reports.length} declarações carregadas. Há mais páginas anteriores.`
            : "";

  return (
    <section
      className="runner-history"
      aria-labelledby={`runner-history-${runnerId}`}
    >
      <header>
        <div>
          <span>REGISTRO IMUTÁVEL · LEITURA SOB DEMANDA</span>
          <h4 id={`runner-history-${runnerId}`}>
            Histórico de declarações
          </h4>
        </div>
        {reports.length > 0 && (
          <strong>{reports.length} carregadas</strong>
        )}
      </header>
      <p>
        Ordem autoritativa de recebimento no servidor. O horário de coleta
        continua sendo uma afirmação do host.
      </p>

      <button
        className="runner-history-action"
        ref={actionRef}
        type="button"
        aria-disabled={actionDisabled}
        aria-busy={loading}
        onClick={() => {
          if (!actionDisabled) void load(actionCursor);
        }}
      >
        {actionLabel}
      </button>
      <p
        className="runner-history-status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {statusMessage}
      </p>

      {started && (
        <div
          className="runner-history-result"
          ref={resultRef}
          tabIndex={-1}
        >
          {reports.length > 0 && (
            <CapabilityReportList reports={reports} listRef={listRef} />
          )}
          {error && (
            <div className="runner-history-error" role="alert">
              <p>{error}</p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function CapabilityReportList({
  reports,
  listRef,
}: {
  reports: RunnerCapabilityReportView[];
  listRef: RefObject<HTMLOListElement | null>;
}) {
  return (
    <ol className="runner-history-list" ref={listRef}>
      {reports.map((report, index) => (
        <li
          key={report.reportId}
          data-report-position={index}
          tabIndex={-1}
        >
          <header>
            <div>
              <strong>{formatHistoryTimestamp(report.receivedAt)}</strong>
              <span>
                recebido pelo servidor · idade no carregamento{" "}
                {formatHistoryAge(report.ageSeconds)}
              </span>
            </div>
            <code>{compactReportId(report.reportId)}</code>
          </header>
          <dl>
            <div>
              <dt>Coleta informada pelo host</dt>
              <dd>{formatHistoryTimestamp(report.collectedAt)}</dd>
            </div>
            <div>
              <dt>Plataforma informada</dt>
              <dd>
                {report.platform.os} · {report.platform.arch} ·{" "}
                {report.platform.nodeVersion}
              </dd>
            </div>
            <div>
              <dt>Integridade da declaração</dt>
              <dd>
                {report.truncated
                  ? "incompleta · host informou truncamento"
                  : "sem truncamento declarado"}
              </dd>
            </div>
          </dl>
          <details>
            <summary>
              {report.capabilities.length}{" "}
              {report.capabilities.length === 1
                ? "capacidade declarada"
                : "capacidades declaradas"}
            </summary>
            {report.capabilities.length === 0 ? (
              <p>Nenhuma capacidade incluída neste relatório.</p>
            ) : (
              <ul>
                {report.capabilities.map((capability) => (
                  <li key={capability.capability}>
                    <b>{historyCapabilityLabel(capability.capability)}</b>
                    <span className={`history-status-${capability.status}`}>
                      {historyStatusLabel(capability.status)}
                    </span>
                    <code>
                      {historyDetectionLabel(capability.detection)}
                      {capability.version ? ` · ${capability.version}` : ""}
                      {capability.reasonCode !== "none"
                        ? ` · ${historyReasonLabel(capability.reasonCode)}`
                        : ""}
                    </code>
                  </li>
                ))}
              </ul>
            )}
          </details>
        </li>
      ))}
    </ol>
  );
}

export function mergeCapabilityReportPages(
  current: readonly RunnerCapabilityReportView[],
  incoming: readonly RunnerCapabilityReportView[],
) {
  const seen = new Set<string>();
  return [...current, ...incoming].filter((report) => {
    if (seen.has(report.reportId)) return false;
    seen.add(report.reportId);
    return true;
  });
}

export function capabilityHistoryUrl(
  runnerId: string,
  cursor: string | null,
) {
  const query = cursor !== null
    ? `?cursor=${encodeURIComponent(cursor)}`
    : "";
  return `/api/runners/${encodeURIComponent(runnerId)}/capability-reports${query}`;
}

function capabilityHistoryErrorCode(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const error = (value as { error?: unknown }).error;
  return typeof error === "string" ? error : null;
}

function historyErrorMessage(code: string, hasReports: boolean) {
  if (code === "runner_not_found") {
    return "Este runner não está mais disponível neste workspace.";
  }
  if (
    code === "invalid_cursor" ||
    code === "unexpected_query_parameter" ||
    code === "history_cursor_invalid" ||
    code === "history_cursor_stalled" ||
    code === "history_invalid"
  ) {
    return "A paginação deixou de ser válida. Recarregue o histórico desde o início.";
  }
  return hasReports
    ? "Não foi possível carregar mais declarações. Os dados já exibidos foram preservados."
    : "Não foi possível carregar o histórico.";
}

export function readCapabilityReportPage(
  value: unknown,
  expectedRunnerId: string,
): RunnerCapabilityReportPage | null {
  if (!value || typeof value !== "object") return null;
  const page = value as Partial<RunnerCapabilityReportPage>;
  if (
    page.runnerId !== expectedRunnerId ||
    typeof page.trustDisclosure !== "string" ||
    !Array.isArray(page.reports) ||
    !page.reports.every(isCapabilityReportView) ||
    (page.nextCursor !== null &&
      (typeof page.nextCursor !== "string" ||
        page.nextCursor.length === 0))
  ) {
    return null;
  }
  return page as RunnerCapabilityReportPage;
}

function isCapabilityReportView(
  value: unknown,
): value is RunnerCapabilityReportView {
  if (!value || typeof value !== "object") return false;
  const report = value as Partial<RunnerCapabilityReportView>;
  return (
    typeof report.reportId === "string" &&
    report.schemaVersion === 1 &&
    report.trust === "hostReported" &&
    typeof report.collectedAt === "string" &&
    typeof report.receivedAt === "string" &&
    typeof report.ageSeconds === "number" &&
    Number.isFinite(report.ageSeconds) &&
    report.ageSeconds >= 0 &&
    typeof report.truncated === "boolean" &&
    !!report.platform &&
    typeof report.platform.os === "string" &&
    typeof report.platform.arch === "string" &&
    typeof report.platform.nodeVersion === "string" &&
    Array.isArray(report.capabilities) &&
    report.capabilities.every(isDeclaredCapability)
  );
}

function isDeclaredCapability(
  value: unknown,
): value is RunnerDeclaredCapability {
  if (!value || typeof value !== "object") return false;
  const capability = value as Partial<RunnerDeclaredCapability>;
  return (
    CAPABILITIES.has(capability.capability ?? "") &&
    CAPABILITY_STATUSES.has(capability.status ?? "") &&
    CAPABILITY_DETECTIONS.has(capability.detection ?? "") &&
    CAPABILITY_REASONS.has(capability.reasonCode ?? "") &&
    (capability.version === undefined ||
      typeof capability.version === "string")
  );
}

const CAPABILITIES = new Set<string>([
  "node_permission_model",
  "bubblewrap",
  "landlock",
  "seccomp",
  "user_namespace",
  "docker",
  "podman",
]);
const CAPABILITY_STATUSES = new Set<string>([
  "available",
  "unavailable",
  "unknown",
]);
const CAPABILITY_DETECTIONS = new Set<string>([
  "node_flag",
  "binary_version",
  "proc_read",
  "syscall",
  "none",
]);
const CAPABILITY_REASONS = new Set<string>([
  "none",
  "not_found",
  "not_supported",
  "permission_denied",
  "probe_disabled",
  "unknown",
]);

function formatHistoryTimestamp(value: string) {
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

function formatHistoryAge(seconds: number) {
  if (seconds < 60) return "menos de 1min";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return [
    days ? `${days}d` : "",
    hours ? `${hours}h` : "",
    minutes ? `${minutes}min` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function compactReportId(value: string) {
  return value.length > 24
    ? `${value.slice(0, 12)}…${value.slice(-8)}`
    : value;
}

function historyCapabilityLabel(
  value: RunnerDeclaredCapability["capability"],
) {
  return {
    node_permission_model: "Node Permission Model",
    bubblewrap: "Bubblewrap",
    landlock: "Landlock",
    seccomp: "Seccomp",
    user_namespace: "User namespace",
    docker: "Docker",
    podman: "Podman",
  }[value];
}

function historyStatusLabel(value: RunnerDeclaredCapability["status"]) {
  return {
    available: "disponível",
    unavailable: "indisponível",
    unknown: "desconhecida",
  }[value];
}

function historyDetectionLabel(
  value: RunnerDeclaredCapability["detection"],
) {
  return {
    node_flag: "flag local do Node",
    binary_version: "versão em probe fixa",
    proc_read: "leitura local de procfs",
    syscall: "probe local de syscall",
    none: "sem detecção conclusiva",
  }[value];
}

function historyReasonLabel(
  value: RunnerDeclaredCapability["reasonCode"],
) {
  return {
    none: "sem ressalva declarada",
    not_found: "não encontrado nas probes fixas",
    not_supported: "não suportado neste host",
    permission_denied: "probe sem permissão",
    probe_disabled: "probe desabilitada",
    unknown: "motivo desconhecido",
  }[value];
}
