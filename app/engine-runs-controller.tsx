"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  classifyEngineRunCreateResponse,
  classifyEngineRunReconcileResponse,
  ENGINE_RUN_CLIENT_LIMITS,
  engineRunDetailUrl,
  engineRunExcerptUrl,
  engineRunListUrl,
  engineRunReconcileUrl,
  generateEngineRunCreationId,
  isEngineRunCreationId,
  mapEngineRunDetail,
  mapEngineRunOptions,
  mapEngineRunPage,
  mergeEngineRunAppend,
  pendingEngineRunCreationState,
  readEngineRunDetail,
  readEngineRunExcerpt,
  readEngineRunOptions,
  readEngineRunRegistry,
  resetEngineRunPageChain,
} from "./engine-run-adapter";
import { EngineRunsPanel } from "./engine-runs-panel";
import {
  shouldPollEngineRun,
  type EngineRunCreationState,
  type EngineRunDetailView,
  type EngineRunExcerptClientState,
  type EngineRunListItemView,
  type EngineRunOptionView,
  type EngineRunPanelEvent,
} from "./engine-run-view";

export const ENGINE_RUN_PENDING_CREATION_STORAGE_KEY =
  "nexusos.engine-run.pending-creation.v1";

export const ENGINE_RUN_CLIENT_INTERVALS = Object.freeze({
  createTimeoutMs: 30_000,
  inventoryRefreshMs: 15_000,
  registryRefreshMs: 15_000,
  runPollMs: 4_000,
});

export type EngineRunRequestLane =
  | "options"
  | "list"
  | "detail"
  | "create"
  | "reconcile"
  | "excerpt";

type ActiveRequest = {
  controller: AbortController;
  epoch: number;
};

export type EngineRunRequestTicket = {
  epoch: number;
  signal: AbortSignal;
};

/**
 * Every transport has its own abort and epoch lane. This prevents an options
 * refresh from invalidating detail, and makes stale response checks explicit.
 * abortAll intentionally does not dispose the coordinator: React StrictMode
 * may clean up and set up the same component instance again in development.
 */
export class EngineRunRequestCoordinator {
  readonly #epochs = new Map<EngineRunRequestLane, number>();
  readonly #active = new Map<EngineRunRequestLane, ActiveRequest>();

  begin(lane: EngineRunRequestLane): EngineRunRequestTicket {
    this.#active.get(lane)?.controller.abort();
    const epoch = (this.#epochs.get(lane) ?? 0) + 1;
    const controller = new AbortController();
    this.#epochs.set(lane, epoch);
    this.#active.set(lane, { controller, epoch });
    return { epoch, signal: controller.signal };
  }

  isCurrent(lane: EngineRunRequestLane, epoch: number): boolean {
    const current = this.#active.get(lane);
    return current?.epoch === epoch && !current.controller.signal.aborted;
  }

  hasActive(lane: EngineRunRequestLane): boolean {
    const current = this.#active.get(lane);
    return Boolean(current && !current.controller.signal.aborted);
  }

  finish(lane: EngineRunRequestLane, epoch: number): boolean {
    if (!this.isCurrent(lane, epoch)) return false;
    this.#active.delete(lane);
    return true;
  }

  abort(lane: EngineRunRequestLane): void {
    this.#active.get(lane)?.controller.abort();
    this.#active.delete(lane);
  }

  abortAll(): void {
    for (const request of this.#active.values()) {
      request.controller.abort();
    }
    this.#active.clear();
  }
}

type PendingCreation = {
  creationId: string;
  incidentId: string;
};

type ListLoadResult = {
  runs: EngineRunListItemView[];
  nextCursor: string | null;
};

export function EngineRunsController({
  notify,
}: {
  notify: (message: string) => void;
}) {
  const [coordinator] = useState(() => new EngineRunRequestCoordinator());
  const activeRef = useRef(false);
  const runnerNamesRef = useRef<ReadonlyMap<string, string>>(new Map());
  const runsRef = useRef<EngineRunListItemView[]>([]);
  const selectedRunIdRef = useRef("");
  const nextCursorRef = useRef<string | null>(null);
  const pendingCreationRef = useRef<PendingCreation | null>(null);
  const createLatchRef = useRef(false);
  const reconcileLatchRef = useRef(false);

  const [options, setOptions] = useState<EngineRunOptionView[]>([]);
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [optionsError, setOptionsError] = useState("");
  const [optionsSourceTruncated, setOptionsSourceTruncated] = useState(false);
  const [runs, setRuns] = useState<EngineRunListItemView[]>([]);
  const [runsLoading, setRunsLoading] = useState(true);
  const [runsError, setRunsError] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [detail, setDetail] = useState<EngineRunDetailView | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [excerptState, setExcerptState] =
    useState<EngineRunExcerptClientState>({ phase: "idle" });
  const [creationState, setCreationState] =
    useState<EngineRunCreationState>({ phase: "idle" });
  const [reconcilingUnknown, setReconcilingUnknown] = useState(false);

  const replaceRuns = useCallback((next: EngineRunListItemView[]) => {
    runsRef.current = next;
    setRuns(next);
  }, []);

  const loadOptions = useCallback(
    async (quiet = false) => {
      const ticket = coordinator.begin("options");
      if (!quiet) setOptionsLoading(true);
      try {
        const response = await fetch("/api/runs/engine/options", {
          cache: "no-store",
          signal: ticket.signal,
        });
        const value = await response.json().catch(() => null);
        const payload = response.ok ? readEngineRunOptions(value) : null;
        if (!payload) throw new Error("invalid_engine_run_options");
        if (!activeRef.current || !coordinator.isCurrent("options", ticket.epoch)) {
          return;
        }
        const mapped = mapEngineRunOptions(payload);
        runnerNamesRef.current = new Map(
          mapped.map((option) => [
            option.assignedRunnerId,
            option.runnerDisplayName,
          ]),
        );
        setOptions(mapped);
        setOptionsSourceTruncated(payload.truncated);
        setOptionsError("");
      } catch (error) {
        if (
          activeRef.current &&
          coordinator.isCurrent("options", ticket.epoch) &&
          !isAbortError(error) &&
          !quiet
        ) {
          setOptionsError(
            "Não foi possível validar a projeção de runners e engines.",
          );
        }
      } finally {
        if (coordinator.finish("options", ticket.epoch) && !quiet) {
          setOptionsLoading(false);
        }
      }
    },
    [coordinator],
  );

  const loadRunsPage = useCallback(
    async (
      cursor: string | null,
      mode: "refresh" | "append",
      quiet = false,
    ): Promise<ListLoadResult | null> => {
      if (mode === "append" && coordinator.hasActive("list")) return null;
      const ticket = coordinator.begin("list");
      if (mode === "append") setLoadingMore(true);
      if (!quiet && mode === "refresh") setRunsLoading(true);
      try {
        const response = await fetch(engineRunListUrl(cursor), {
          cache: "no-store",
          signal: ticket.signal,
        });
        const value = await response.json().catch(() => null);
        const payload = response.ok ? readEngineRunRegistry(value) : null;
        if (!payload) throw new Error("invalid_engine_run_list");
        if (
          mode === "append" &&
          cursor !== null &&
          payload.nextCursor === cursor
        ) {
          throw new Error("stalled_engine_run_cursor");
        }
        if (!activeRef.current || !coordinator.isCurrent("list", ticket.epoch)) {
          return null;
        }
        const page = mapEngineRunPage(payload, runnerNamesRef.current);
        const nextRuns =
          mode === "append"
            ? mergeEngineRunAppend(runsRef.current, page.runs)
            : resetEngineRunPageChain(page.runs);
        if (mode === "append") {
          nextCursorRef.current =
            nextRuns.length >= ENGINE_RUN_CLIENT_LIMITS.loadedRuns
              ? null
              : page.nextCursor;
        } else {
          // A first-page refresh invalidates the complete cursor chain.
          // Keeping older pages with a cursor derived from a different
          // boundary can permanently skip runs when new work is inserted.
          nextCursorRef.current = page.nextCursor;
        }
        replaceRuns(nextRuns);
        setNextCursor(nextCursorRef.current);
        setRunsError("");
        return { runs: nextRuns, nextCursor: nextCursorRef.current };
      } catch (error) {
        if (
          activeRef.current &&
          coordinator.isCurrent("list", ticket.epoch) &&
          !isAbortError(error) &&
          !quiet
        ) {
          setRunsError("Não foi possível validar a lista de análises one-shot.");
        }
        return null;
      } finally {
        if (coordinator.finish("list", ticket.epoch)) {
          if (mode === "append") setLoadingMore(false);
          if (!quiet && mode === "refresh") setRunsLoading(false);
        }
      }
    },
    [coordinator, replaceRuns],
  );

  const loadDetail = useCallback(
    async (runId: string, quiet = false) => {
      const ticket = coordinator.begin("detail");
      if (!quiet) setDetailLoading(true);
      try {
        const response = await fetch(engineRunDetailUrl(runId), {
          cache: "no-store",
          signal: ticket.signal,
        });
        const value = await response.json().catch(() => null);
        const payload = response.ok
          ? readEngineRunDetail(value, runId)
          : null;
        if (!payload) throw new Error("invalid_engine_run_detail");
        if (
          !activeRef.current ||
          selectedRunIdRef.current !== runId ||
          !coordinator.isCurrent("detail", ticket.epoch)
        ) {
          return;
        }
        const mapped = mapEngineRunDetail(payload, runnerNamesRef.current);
        setDetail(mapped);
        setDetailError("");
        const nextRuns = mergeEngineRunAppend(runsRef.current, [mapped.run]);
        replaceRuns(nextRuns);
      } catch (error) {
        if (
          activeRef.current &&
          selectedRunIdRef.current === runId &&
          coordinator.isCurrent("detail", ticket.epoch) &&
          !isAbortError(error) &&
          !quiet
        ) {
          setDetailError("Não foi possível validar o detalhe desta análise.");
        }
      } finally {
        if (coordinator.finish("detail", ticket.epoch) && !quiet) {
          setDetailLoading(false);
        }
      }
    },
    [coordinator, replaceRuns],
  );

  const selectRun = useCallback(
    (runId: string) => {
      coordinator.abort("excerpt");
      selectedRunIdRef.current = runId;
      setSelectedRunId(runId);
      setDetail(null);
      setDetailError("");
      setExcerptState({ phase: "idle" });
      void loadDetail(runId);
    },
    [coordinator, loadDetail],
  );

  const loadExcerpt = useCallback(
    async (runId: string) => {
      if (selectedRunIdRef.current !== runId) return;
      const ticket = coordinator.begin("excerpt");
      setExcerptState({ phase: "loading", runId });
      try {
        const response = await fetch(engineRunExcerptUrl(runId), {
          cache: "no-store",
          signal: ticket.signal,
        });
        if (
          !activeRef.current ||
          selectedRunIdRef.current !== runId ||
          !coordinator.isCurrent("excerpt", ticket.epoch)
        ) {
          return;
        }
        if (!response.ok) {
          setExcerptState(excerptHttpFailure(runId, response.status));
          return;
        }
        const value = await response.json().catch(() => null);
        const excerpt = readEngineRunExcerpt(value, runId);
        if (
          !activeRef.current ||
          selectedRunIdRef.current !== runId ||
          !coordinator.isCurrent("excerpt", ticket.epoch)
        ) {
          return;
        }
        if (!excerpt) {
          setExcerptState({
            phase: "error",
            runId,
            reason: "invalid_response",
            message:
              "A resposta de bytes opacos não respeita o contrato fechado.",
          });
          return;
        }
        setExcerptState({ phase: "loaded", runId, excerpt });
      } catch (error) {
        if (
          activeRef.current &&
          selectedRunIdRef.current === runId &&
          coordinator.isCurrent("excerpt", ticket.epoch) &&
          !isAbortError(error)
        ) {
          setExcerptState({
            phase: "error",
            runId,
            reason: "transport_failure",
            message:
              "A leitura explícita de bytes opacos terminou sem resposta.",
          });
        }
      } finally {
        coordinator.finish("excerpt", ticket.epoch);
      }
    },
    [coordinator],
  );

  const confirmCreated = useCallback(
    (input: {
      creationId: string;
      runId: string;
      message: string;
    }) => {
      clearPendingCreation();
      pendingCreationRef.current = null;
      createLatchRef.current = false;
      setCreationState({
        phase: "confirmed",
        creationId: input.creationId,
        runId: input.runId,
        message: input.message,
      });
      selectedRunIdRef.current = input.runId;
      setSelectedRunId(input.runId);
      setDetail(null);
      coordinator.abort("excerpt");
      setExcerptState({ phase: "idle" });
      void loadRunsPage(null, "refresh", true);
      void loadDetail(input.runId);
    },
    [coordinator, loadDetail, loadRunsPage],
  );

  const markCreationUnknown = useCallback((creationId: string, message: string) => {
    const incidentId = `incident:${creationId}`;
    pendingCreationRef.current = { creationId, incidentId };
    setCreationState(
      pendingEngineRunCreationState({ creationId, incidentId, message }),
    );
  }, []);

  const createRun = useCallback(
    async (
      event: Extract<
        EngineRunPanelEvent,
        { type: "engine_run.create_requested" }
      >,
    ) => {
      if (createLatchRef.current || pendingCreationRef.current) return;
      createLatchRef.current = true;
      const creationId = generateEngineRunCreationId();
      const incidentId = `incident:${creationId}`;
      pendingCreationRef.current = { creationId, incidentId };
      if (!storePendingCreation(creationId)) {
        pendingCreationRef.current = null;
        createLatchRef.current = false;
        setCreationState({
          phase: "failure_confirmed",
          failureId: `failure:${creationId}:correlation_storage_unavailable`,
          message:
            "A sessão não pôde guardar a correlação da criação; nenhum pedido foi enviado.",
        });
        return;
      }
      setCreationState({ phase: "submitting" });
      const ticket = coordinator.begin("create");
      let timedOut = false;
      const timeout = window.setTimeout(() => {
        timedOut = true;
        coordinator.abort("create");
      }, ENGINE_RUN_CLIENT_INTERVALS.createTimeoutMs);
      try {
        const response = await fetch("/api/runs/engine", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "Idempotency-Key": creationId,
          },
          body: JSON.stringify(event.request),
          signal: ticket.signal,
        });
        const value = await response.json().catch(() => null);
        if (
          !activeRef.current ||
          !coordinator.isCurrent("create", ticket.epoch)
        ) {
          return;
        }
        const result = classifyEngineRunCreateResponse({
          status: response.status,
          value,
          creationId,
        });
        if (result.kind === "confirmed") {
          confirmCreated({
            creationId,
            runId: result.resolution.runId,
            message: "Criação confirmada pela autoridade do servidor.",
          });
          notify("Análise one-shot criada e confirmada.");
          return;
        }
        if (result.kind === "failure_confirmed") {
          clearPendingCreation();
          pendingCreationRef.current = null;
          createLatchRef.current = false;
          setCreationState({
            phase: "failure_confirmed",
            failureId: `failure:${creationId}:${result.code}`,
            message: engineRunCreateFailureMessage(result.code),
          });
          return;
        }
        markCreationUnknown(
          creationId,
          "A resposta não prova se a criação foi persistida.",
        );
      } catch (error) {
        if (!activeRef.current) return;
        if (isAbortError(error) && !timedOut) return;
        markCreationUnknown(
          creationId,
          timedOut
            ? "O prazo local de confirmação terminou sem resultado autoritativo."
            : "A conexão terminou sem resultado autoritativo da criação.",
        );
      } finally {
        window.clearTimeout(timeout);
        coordinator.finish("create", ticket.epoch);
      }
    },
    [confirmCreated, coordinator, markCreationUnknown, notify],
  );

  const reconcileUnknown = useCallback(
    async (
      event: Extract<
        EngineRunPanelEvent,
        { type: "engine_run.creation_reconciliation_requested" }
      >,
    ) => {
      const pending = pendingCreationRef.current;
      if (
        !pending ||
        pending.incidentId !== event.incidentId ||
        reconcileLatchRef.current
      ) {
        return;
      }
      reconcileLatchRef.current = true;
      setReconcilingUnknown(true);
      const ticket = coordinator.begin("reconcile");
      try {
        const response = await fetch(
          engineRunReconcileUrl(pending.creationId),
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
            signal: ticket.signal,
          },
        );
        const value = await response.json().catch(() => null);
        if (
          !activeRef.current ||
          !coordinator.isCurrent("reconcile", ticket.epoch)
        ) {
          return;
        }
        const result = classifyEngineRunReconcileResponse({
          status: response.status,
          value,
          creationId: pending.creationId,
        });
        if (result.kind !== "authoritative") {
          markCreationUnknown(
            pending.creationId,
            "A verificação ainda não retornou prova autoritativa.",
          );
          return;
        }
        if (result.resolution.state === "created") {
          confirmCreated({
            creationId: pending.creationId,
            runId: result.resolution.runId,
            message:
              "A reconciliação autoritativa confirmou que o run foi criado.",
          });
          return;
        }
        clearPendingCreation();
        pendingCreationRef.current = null;
        createLatchRef.current = false;
        setCreationState({
          phase: "reconciled",
          incidentId: pending.incidentId,
          notCreatedProofId: result.resolution.notCreatedProofId,
          resolution: "confirmed_not_created",
          message:
            "A autoridade confirmou que a criação não ocorreu. Um novo envio está liberado.",
        });
      } catch (error) {
        if (activeRef.current && !isAbortError(error)) {
          markCreationUnknown(
            pending.creationId,
            "A verificação terminou sem prova autoritativa.",
          );
        }
      } finally {
        if (coordinator.finish("reconcile", ticket.epoch)) {
          setReconcilingUnknown(false);
        }
        reconcileLatchRef.current = false;
      }
    },
    [confirmCreated, coordinator, markCreationUnknown],
  );

  useEffect(() => {
    activeRef.current = true;
    const pendingCreationId = readPendingCreation();
    if (pendingCreationId) {
      const incidentId = `incident:${pendingCreationId}`;
      pendingCreationRef.current = {
        creationId: pendingCreationId,
        incidentId,
      };
      createLatchRef.current = true;
    }
    const initial = window.setTimeout(() => {
      if (pendingCreationId) {
        setCreationState(
          pendingEngineRunCreationState({
            creationId: pendingCreationId,
            incidentId: `incident:${pendingCreationId}`,
            message:
              "Há uma criação anterior sem resultado autoritativo nesta sessão.",
          }),
        );
      }
      void loadOptions();
      void (async () => {
        const loaded = await loadRunsPage(null, "refresh");
        const first = loaded?.runs[0];
        if (first && !selectedRunIdRef.current) {
          selectedRunIdRef.current = first.id;
          setSelectedRunId(first.id);
          void loadDetail(first.id);
        }
      })();
    }, 0);
    return () => {
      activeRef.current = false;
      window.clearTimeout(initial);
      coordinator.abortAll();
    };
  }, [coordinator, loadDetail, loadOptions, loadRunsPage]);

  useEffect(() => {
    let timer: number | null = null;
    let stopped = false;
    const schedule = () => {
      if (stopped) return;
      timer = window.setTimeout(async () => {
        if (
          !stopped &&
          document.visibilityState === "visible" &&
          !coordinator.hasActive("options")
        ) {
          await loadOptions(true);
        }
        schedule();
      }, ENGINE_RUN_CLIENT_INTERVALS.inventoryRefreshMs);
    };
    const onVisibility = () => {
      if (
        document.visibilityState === "visible" &&
        !coordinator.hasActive("options")
      ) {
        void loadOptions(true);
      }
    };
    schedule();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [coordinator, loadOptions]);

  const selectedPollableKey = useMemo(
    () => {
      const selected = runs.find((run) => run.id === selectedRunId);
      return selected && shouldPollEngineRun(selected)
        ? `${selected.id}:${selected.storedStatus}:${selected.updatedAt}`
        : "";
    },
    [runs, selectedRunId],
  );

  useEffect(() => {
    let timer: number | null = null;
    let stopped = false;
    const schedule = () => {
      if (stopped) return;
      timer = window.setTimeout(async () => {
        if (
          stopped ||
          document.visibilityState !== "visible" ||
          coordinator.hasActive("list")
        ) {
          schedule();
          return;
        }
        await loadRunsPage(null, "refresh", true);
        schedule();
      }, ENGINE_RUN_CLIENT_INTERVALS.registryRefreshMs);
    };
    const onVisibility = () => {
      if (
        document.visibilityState === "visible" &&
        !coordinator.hasActive("list")
      ) {
        if (timer !== null) window.clearTimeout(timer);
        void loadRunsPage(null, "refresh", true);
        schedule();
      }
    };
    schedule();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [coordinator, loadRunsPage]);

  useEffect(() => {
    if (!selectedPollableKey) return;
    let timer: number | null = null;
    let stopped = false;
    const schedule = () => {
      if (stopped) return;
      timer = window.setTimeout(async () => {
        const selectedId = selectedRunIdRef.current;
        const selected = runsRef.current.find((run) => run.id === selectedId);
        if (
          !stopped &&
          document.visibilityState === "visible" &&
          selected &&
          shouldPollEngineRun(selected) &&
          !coordinator.hasActive("detail")
        ) {
          await loadDetail(selectedId, true);
        }
        schedule();
      }, ENGINE_RUN_CLIENT_INTERVALS.runPollMs);
    };
    schedule();
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [coordinator, loadDetail, selectedPollableKey]);

  return (
    <EngineRunsPanel
      options={options}
      optionsLoading={optionsLoading}
      optionsError={optionsError}
      optionsSourceTruncated={optionsSourceTruncated}
      runs={runs}
      runsLoading={runsLoading}
      runsError={runsError}
      hasMore={
        nextCursor !== null &&
        runs.length < ENGINE_RUN_CLIENT_LIMITS.loadedRuns
      }
      loadingMore={loadingMore}
      onLoadMore={() => {
        if (nextCursorRef.current) {
          void loadRunsPage(nextCursorRef.current, "append");
        }
      }}
      selectedRunId={selectedRunId}
      detail={detail}
      detailLoading={detailLoading}
      detailError={detailError}
      excerptState={excerptState}
      onLoadExcerpt={(runId) => void loadExcerpt(runId)}
      creationState={creationState}
      reconcilingUnknown={reconcilingUnknown}
      onCreate={(event) => void createRun(event)}
      onReconcileUnknown={(event) => void reconcileUnknown(event)}
      onSelectRun={selectRun}
    />
  );
}

export function engineRunsHavePollableWork(
  runs: readonly EngineRunListItemView[],
): boolean {
  return runs.some(shouldPollEngineRun);
}

export function readPendingCreation(
  storage: Pick<Storage, "getItem"> | null =
    typeof window === "undefined" ? null : window.sessionStorage,
): string | null {
  try {
    const value = storage?.getItem(ENGINE_RUN_PENDING_CREATION_STORAGE_KEY);
    return isEngineRunCreationId(value) ? value : null;
  } catch {
    return null;
  }
}

export function storePendingCreation(
  creationId: string,
  storage: Pick<Storage, "setItem"> | null =
    typeof window === "undefined" ? null : window.sessionStorage,
): boolean {
  if (!isEngineRunCreationId(creationId)) return false;
  try {
    storage?.setItem(ENGINE_RUN_PENDING_CREATION_STORAGE_KEY, creationId);
    return storage !== null;
  } catch {
    return false;
  }
}

export function clearPendingCreation(
  storage: Pick<Storage, "removeItem"> | null =
    typeof window === "undefined" ? null : window.sessionStorage,
): void {
  try {
    storage?.removeItem(ENGINE_RUN_PENDING_CREATION_STORAGE_KEY);
  } catch {
    // Storage denial must not convert an authoritative server result.
  }
}

export function engineRunCreateFailureMessage(code: string): string {
  return {
    confirmed_not_created:
      "A autoridade confirmou que esta criação não foi persistida.",
    invalid_engine_run_request:
      "A autoridade rejeitou os campos da criação.",
    invalid_engine_run_creation_id:
      "A autoridade rejeitou o identificador da criação.",
    authentication_required:
      "A sessão não está autenticada para criar a análise.",
    forbidden: "A sessão não tem autoridade para criar esta análise.",
    workspace_owner_required:
      "Somente um owner do workspace pode criar esta análise.",
    runner_not_found: "O runner atribuído não existe.",
    conflict_retry:
      "A autoridade confirmou um conflito antes de persistir a criação.",
    runner_not_active: "O runner atribuído deixou de estar ativo.",
    engine_run_creation_key_reused:
      "A chave de criação já está vinculada a outro pedido.",
  }[code] ?? "A autoridade rejeitou a criação antes da persistência.";
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function excerptHttpFailure(
  runId: string,
  status: number,
): Extract<EngineRunExcerptClientState, { phase: "error" }> {
  if (status === 403) {
    return {
      phase: "error",
      runId,
      reason: "forbidden",
      message:
        "A leitura dos bytes opacos é restrita a owner do workspace.",
    };
  }
  if (status === 503) {
    return {
      phase: "error",
      runId,
      reason: "temporarily_unavailable",
      message:
        "Os bytes protegidos estão temporariamente indisponíveis; isso não significa absent ou erased.",
    };
  }
  if (status === 404) {
    return {
      phase: "error",
      runId,
      reason: "not_found",
      message: "A autoridade não encontrou este run para leitura protegida.",
    };
  }
  return {
    phase: "error",
    runId,
    reason: "transport_failure",
    message: "A leitura explícita dos bytes opacos não foi concluída.",
  };
}
