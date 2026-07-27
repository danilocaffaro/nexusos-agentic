"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  AttentionItem,
  AttentionPage,
} from "@/src/contracts/attention";
import { useRealtime } from "./realtime-client";
import { pollingDelayMs } from "./realtime-policy";

export function PersistentAttentionView({
  onGovernance,
  notify,
  onCountChange,
}: {
  onGovernance: (intentId: string) => void;
  notify: (message: string) => void;
  onCountChange?: (count: number) => void;
}) {
  const {
    status: realtimeStatus,
    subscribe: subscribeRealtime,
  } = useRealtime();
  const [items, setItems] = useState<AttentionItem[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [markingIds, setMarkingIds] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [openTotal, setOpenTotal] = useState(0);
  const [seenTotal, setSeenTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const detailRef = useRef<HTMLElement>(null);
  const loadedAdditionalPagesRef = useRef(false);
  const itemsRef = useRef<AttentionItem[]>([]);
  const selectedIdRef = useRef("");
  const realtimeStatusRef = useRef(realtimeStatus);

  useEffect(() => {
    realtimeStatusRef.current = realtimeStatus;
  }, [realtimeStatus]);

  const loadItems = useCallback(
    async (signal?: AbortSignal, cursor?: string) => {
      const query = cursor
        ? `?${new URLSearchParams({ cursor }).toString()}`
        : "";
      const response = await fetch(`/api/attention${query}`, {
        cache: "no-store",
        signal,
      });
      const state = await readJson<AttentionPage>(response);
      const resetDeeperPages =
        !cursor && state.total < itemsRef.current.length;
      const nextItems = cursor
        ? mergeAttentionItems(itemsRef.current, state.items)
        : mergeAttentionRefresh(
          itemsRef.current,
          state.items,
          Boolean(state.nextCursor),
          state.total,
        );
      itemsRef.current = nextItems;
      setItems(nextItems);
      if (
        selectedIdRef.current &&
        !nextItems.some((item) => item.id === selectedIdRef.current)
      ) {
        selectedIdRef.current = "";
        setSelectedId("");
        setAnnouncement("O item selecionado saiu da fila de atenção.");
      }
      setTotal(state.total);
      setOpenTotal(state.openTotal);
      setSeenTotal(state.seenTotal);
      if (cursor) {
        loadedAdditionalPagesRef.current = true;
        setNextCursor(state.nextCursor);
      } else if (
        resetDeeperPages ||
        !loadedAdditionalPagesRef.current ||
        state.total <= state.items.length
      ) {
        loadedAdditionalPagesRef.current = false;
        setNextCursor(state.nextCursor);
      }
      setLastUpdatedAt(new Date());
      setError("");
      setLoading(false);
      onCountChange?.(state.total);
      return state.items;
    },
    [onCountChange],
  );

  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    let failures = 0;
    let active = true;
    let polling = false;
    let pendingDirty = false;

    const schedule = (delay: number) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(poll, delay);
    };
    const poll = async () => {
      if (!active) return;
      if (polling) {
        pendingDirty = true;
        return;
      }
      if (document.visibilityState === "hidden") {
        pendingDirty = true;
        return;
      }
      polling = true;
      pendingDirty = false;
      try {
        await loadItems(controller.signal);
        failures = 0;
      } catch (pollError) {
        if (!active || isAbortError(pollError)) return;
        failures += 1;
        setLoading(false);
        setError("Não foi possível atualizar sua fila governada.");
      } finally {
        polling = false;
        if (active) {
          if (pendingDirty && document.visibilityState === "visible") {
            pendingDirty = false;
            void poll();
          } else if (document.visibilityState === "visible") {
            schedule(
              pollingDelayMs({
                status: realtimeStatusRef.current,
                baseDelayMs: failures ? 4_000 : 8_000,
                failureCount: failures,
                maximumDelayMs: 30_000,
              }),
            );
          }
        }
      }
    };
    const refresh = () => {
      pendingDirty = true;
      if (polling || document.visibilityState === "hidden") return;
      window.clearTimeout(timer);
      void poll();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        refresh();
      }
    };

    const unsubscribe = subscribeRealtime((event) => {
      if (event.kind === "attention" || event.kind === "resync") refresh();
    });
    document.addEventListener("visibilitychange", onVisibilityChange);
    void poll();
    return () => {
      active = false;
      controller.abort();
      window.clearTimeout(timer);
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [loadItems, subscribeRealtime]);

  const selected = useMemo(
    () => items.find((item) => item.id === selectedId),
    [items, selectedId],
  );
  const detailMode = loading
    ? "loading"
    : error && items.length === 0
      ? "error"
      : items.length
        ? "select"
        : "empty";
  const selectItem = async (item: AttentionItem) => {
    selectedIdRef.current = item.id;
    setSelectedId(item.id);
    setAnnouncement(
      `Item aberto: ${actionLabel(item.intent.actionType)} · ${riskLabel(item.intent.riskTier)}`,
    );
    window.requestAnimationFrame(() => {
      const detail = detailRef.current;
      if (!detail) return;
      const isNarrow = window.matchMedia("(max-width: 900px)").matches;
      const reduceMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      detail.focus({ preventScroll: true });
      if (isNarrow) {
        detail.scrollIntoView({
          behavior: reduceMotion ? "auto" : "smooth",
          block: "start",
        });
      }
    });
    if (item.status !== "open" || markingIds.includes(item.id)) return;
    setMarkingIds((current) => [...current, item.id]);
    try {
      const response = await fetch(`/api/attention/${item.id}/seen`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion: item.version }),
      });
      const updated = await readJson<AttentionItem>(response);
      const nextItems = itemsRef.current.map((candidate) =>
        candidate.id === updated.id ? updated : candidate,
      );
      itemsRef.current = nextItems;
      setItems(nextItems);
      setOpenTotal((current) => Math.max(0, current - 1));
      setSeenTotal((current) => current + 1);
      window.dispatchEvent(new Event("nexus-attention-changed"));
    } catch (markError) {
      if (
        apiErrorCode(markError) === "attention_already_seen" ||
        apiErrorCode(markError) === "attention_not_found"
      ) {
        await loadItems().catch(() => undefined);
      } else if (apiErrorCode(markError) === "version_conflict") {
        await loadItems().catch(() => undefined);
        notify("A fila mudou; os dados mais recentes foram carregados.");
      } else {
        setError("Não foi possível registrar que você viu este item.");
      }
    } finally {
      setMarkingIds((current) =>
        current.filter((attentionId) => attentionId !== item.id),
      );
    }
  };

  return (
    <div className="view-page inbox-page" data-testid="inbox-view">
      <div className="page-heading">
        <div>
          <span className="eyebrow">ATTENTION SYSTEM · REAL</span>
          <h1>Inbox</h1>
          <p>
            Sinais pessoais que pedem atenção. Decisões continuam exclusivas do
            fluxo governado.
          </p>
        </div>
        <div
          className="inbox-stats"
          role="group"
          aria-label="Resumo da fila"
        >
          <span>
            <b>{openTotal}</b> novos
          </span>
          <span>
            <b>{seenTotal}</b> vistos
          </span>
        </div>
      </div>

      <p className="sr-only" role="status">
        {announcement}
      </p>
      {error && (
        <div className="inbox-sync-warning" role="alert">
          <span>{error}</span>
          {lastUpdatedAt && (
            <small>Última atualização confirmada: {formatClock(lastUpdatedAt)}</small>
          )}
          <button
            className="text-button"
            type="button"
            onClick={() => void loadItems()}
          >
            Atualizar agora
          </button>
        </div>
      )}

      <div className="inbox-layout">
        <aside className="inbox-list" aria-label="Minha fila de atenção">
          <div className="inbox-filters">
            <span className="is-active" aria-current="true">
              Minha fila <b>{total}</b>
            </span>
          </div>

          {loading && items.length === 0 && (
            <div className="inbox-state">Carregando fila governada…</div>
          )}
          {!loading && error && items.length === 0 && (
            <div className="inbox-state is-error">
              <p>{error}</p>
              <button
                className="outline-button"
                type="button"
                onClick={() => {
                  setLoading(true);
                  void loadItems().catch(() => {
                    setLoading(false);
                    setError("Não foi possível atualizar sua fila governada.");
                  });
                }}
              >
                Tentar novamente
              </button>
            </div>
          )}
          {!loading && !error && items.length === 0 && (
            <div className="inbox-state">
              <b>Sua fila está em dia.</b>
              <p>Novos intents aparecerão aqui quando exigirem sua atenção.</p>
            </div>
          )}

          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={selected?.id === item.id}
              className={`${selected?.id === item.id ? "is-selected" : ""} ${
                item.status === "seen" ? "is-seen" : ""
              }`}
              onClick={() => void selectItem(item)}
            >
              <span className="inbox-type">APPROVAL REQUIRED</span>
              <h3>{actionLabel(item.intent.actionType)}</h3>
              <p>
                {item.intent.proposerName} · {item.intent.projectName}
              </p>
              <footer>
                <span>{riskLabel(item.intent.riskTier)}</span>
                <em>
                  {markingIds.includes(item.id)
                    ? "Registrando…"
                    : item.status === "seen"
                      ? "Visto"
                      : relativeCreatedAt(item.createdAt)}
                </em>
              </footer>
            </button>
          ))}
          {nextCursor && (
            <button
              className="inbox-load-more"
              type="button"
              onClick={() => void loadItems(undefined, nextCursor)}
            >
              Carregar mais itens
            </button>
          )}
        </aside>

        <section
          className="decision-detail"
          ref={detailRef}
          tabIndex={-1}
          aria-labelledby="attention-detail-title"
        >
          {!selected ? (
            <div className="inbox-empty-detail">
              <span className="decision-icon">
                {detailMode === "loading"
                  ? "…"
                  : detailMode === "error" || detailMode === "select"
                    ? "!"
                    : "✓"}
              </span>
              <div>
                <span className="eyebrow">
                  {detailMode === "loading"
                    ? "LOADING ATTENTION"
                    : detailMode === "error"
                      ? "ATTENTION UNAVAILABLE"
                      : detailMode === "select"
                        ? "SELECT ATTENTION ITEM"
                        : "NO ACTION REQUIRED"}
                </span>
                <h2 id="attention-detail-title">
                  {detailMode === "loading"
                    ? "Atualizando sua fila"
                    : detailMode === "error"
                      ? "Não foi possível confirmar sua fila"
                      : detailMode === "select"
                        ? "Selecione uma pendência"
                        : "Nenhuma pendência governada"}
                </h2>
                <p>
                  {detailMode === "loading"
                    ? "Buscando sinais persistentes destinados à sua identidade."
                    : detailMode === "error"
                      ? "Tente novamente pela lista. Não assumiremos que não há pendências."
                      : detailMode === "select"
                        ? "Ao abrir um item, registraremos apenas que você o viu. A decisão continuará no fluxo governado."
                        : "O histórico de decisões permanece disponível no Decision Ledger."}
                </p>
                {detailMode === "empty" && (
                  <button
                    className="outline-button"
                    type="button"
                    onClick={() => onGovernance("")}
                  >
                    Abrir Decision Ledger →
                  </button>
                )}
              </div>
            </div>
          ) : (
            <>
              <div className="decision-breadcrumb">
                {selected.intent.projectName.toUpperCase()} /{" "}
                {shortId(selected.intent.id)}
              </div>
              <div className="decision-title">
                <span className="decision-icon">!</span>
                <div>
                  <span className="eyebrow">
                    HUMAN DECISION REQUIRED · {selected.status.toUpperCase()}
                  </span>
                  <h2 id="attention-detail-title">
                    {actionLabel(selected.intent.actionType)}
                  </h2>
                  <p>
                    Proposto por {selected.intent.proposerName} · expira{" "}
                    {formatTimestamp(selected.intent.expiresAt)}
                  </p>
                </div>
              </div>

              <div className="intent-card">
                <span>INTENÇÃO EXATA</span>
                <code>
                  {selected.intent.actionType} → {selected.intent.targetRef}
                </code>
                <dl>
                  <div>
                    <dt>Risk</dt>
                    <dd>{riskLabel(selected.intent.riskTier)}</dd>
                  </div>
                  <div>
                    <dt>Status</dt>
                    <dd>{selected.intent.status}</dd>
                  </div>
                  <div>
                    <dt>Project</dt>
                    <dd>{selected.intent.projectName}</dd>
                  </div>
                  <div>
                    <dt>Expires</dt>
                    <dd>{formatTimestamp(selected.intent.expiresAt)}</dd>
                  </div>
                </dl>
              </div>

              <div className="evidence-preview">
                <div className="detail-section-heading">
                  <span>IMMUTABLE REFERENCE</span>
                  <b>payload bound</b>
                </div>
                <div>
                  <span>✓</span>
                  <b>Parâmetros imutáveis</b>
                  <em>{shortHash(selected.intent.parametersHash)}</em>
                </div>
              </div>
              <div className="attention-guardrail">
                <b>Como este sinal funciona</b>
                <p>
                  Abrir ou marcar este item como visto não aprova nada. O botão
                  abaixo apenas abre o ActionIntent vinculado; a decisão humana
                  é registrada separadamente no ledger.
                </p>
              </div>

              <div className="decision-actions">
                <button
                  className="primary-button"
                  type="button"
                  data-testid="open-governance"
                  onClick={() => onGovernance(selected.intent.id)}
                >
                  Abrir fluxo governado →
                </button>
              </div>
              <p className="intent-hash">
                Intent hash · sha256:{selected.intent.parametersHash}
              </p>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

export function actionLabel(actionType: string): string {
  if (actionType === "nexus.simulator.publish_summary") {
    return "Publicar próximo batch governado";
  }
  return actionType
    .split(".")
    .filter(Boolean)
    .slice(-2)
    .join(" ")
    .replaceAll("_", " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}

function riskLabel(risk: AttentionItem["intent"]["riskTier"]): string {
  return `${risk === "critical" ? "R4" : risk === "high" ? "R3" : risk === "medium" ? "R2" : "R1"} · ${risk}`;
}

function relativeCreatedAt(value: string): string {
  const elapsedMinutes = Math.max(
    0,
    Math.floor((Date.now() - new Date(value).getTime()) / 60_000),
  );
  if (elapsedMinutes < 1) return "agora";
  if (elapsedMinutes < 60) return `${elapsedMinutes} min`;
  return `${Math.floor(elapsedMinutes / 60)} h`;
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatClock(value: Date): string {
  return new Intl.DateTimeFormat("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(value);
}

function mergeAttentionItems(
  current: AttentionItem[],
  incoming: AttentionItem[],
): AttentionItem[] {
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) byId.set(item.id, item);
  return [...byId.values()].sort(
    (left, right) =>
      right.createdAt.localeCompare(left.createdAt) ||
      right.id.localeCompare(left.id),
  );
}

export function mergeAttentionRefresh(
  current: AttentionItem[],
  firstPage: AttentionItem[],
  hasNextPage: boolean,
  total = Number.POSITIVE_INFINITY,
): AttentionItem[] {
  if (total < current.length) return firstPage;
  const boundary = firstPage.at(-1);
  const deeper =
    boundary && hasNextPage
      ? current.filter((item) => isDeeperThan(item, boundary))
      : [];
  return mergeAttentionItems(deeper, firstPage);
}

function isDeeperThan(
  item: AttentionItem,
  boundary: AttentionItem,
): boolean {
  return (
    item.createdAt < boundary.createdAt ||
    (item.createdAt === boundary.createdAt && item.id < boundary.id)
  );
}

function shortHash(value: string): string {
  return `${value.slice(0, 10)}…${value.slice(-6)}`;
}

function shortId(value: string): string {
  return value.length > 16 ? `${value.slice(0, 13)}…` : value;
}

async function readJson<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => ({}))) as T & {
    error?: string;
  };
  if (!response.ok) {
    throw new AttentionRequestError(
      payload.error ?? "attention_operation_failed",
    );
  }
  return payload;
}

class AttentionRequestError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AttentionRequestError";
  }
}

function apiErrorCode(error: unknown): string {
  return error instanceof AttentionRequestError ? error.code : "";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
