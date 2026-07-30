"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import {
  PROVIDER_DETAIL_COPY,
  PROVIDER_STATUS_COPY,
  ProviderRequestCoordinator,
  readProviderCatalogView,
  type ProviderCatalogViewModel,
  type ProviderMethodView,
} from "./providers-view-model";

export const PROVIDER_VIEW_COPY = Object.freeze({
  eyebrow: "MODEL ACCESS FABRIC · DECLARAÇÃO BUNDLED",
  title: "Catálogo de provedores",
  subtitle:
    "Leitura do catálogo declarado no código; nenhuma operação externa é iniciada.",
  lineage: "LINHAGEM DA DECLARAÇÃO",
  source: "Fonte declarada",
  digest: "SHA-256 da declaração",
  methods: "Métodos declarados",
  models: "Modelos declarados",
  noModels: "Nenhum modelo declarado.",
  retry: "Tentar consultar novamente",
  loaded:
    "Catálogo declarado carregado. Nenhuma conectividade foi verificada.",
} as const);

export type ProviderCatalogState =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "authenticationRequired" }>
  | Readonly<{ status: "membershipRequired" }>
  | Readonly<{ status: "unavailable" }>
  | Readonly<{
      status: "declared";
      catalog: ProviderCatalogViewModel;
    }>;

export async function providerCatalogStateForResponse(
  response: Response,
): Promise<ProviderCatalogState> {
  if (response.status === 401) return { status: "authenticationRequired" };
  if (response.status === 403) return { status: "membershipRequired" };
  if (!response.ok) return { status: "unavailable" };
  const catalog = readProviderCatalogView(await response.json());
  return catalog ? { status: "declared", catalog } : { status: "unavailable" };
}

export async function loadProviderCatalog(
  coordinator: ProviderRequestCoordinator,
  request: (input: string, init: RequestInit) => Promise<Response>,
  update: (state: ProviderCatalogState) => void,
): Promise<void> {
  const ticket = coordinator.begin("catalog");
  update({ status: "loading" });
  try {
    const response = await request("/api/providers/catalog", {
      cache: "no-store",
      signal: ticket.signal,
    });
    const next = await providerCatalogStateForResponse(response);
    if (coordinator.finish("catalog", ticket.epoch)) update(next);
  } catch (error) {
    if (ticket.signal.aborted || isAbortError(error)) return;
    if (coordinator.finish("catalog", ticket.epoch)) {
      update({ status: "unavailable" });
    }
  }
}

export function ProvidersView() {
  const coordinatorRef = useRef<ProviderRequestCoordinator | null>(null);
  if (coordinatorRef.current === null) {
    coordinatorRef.current = new ProviderRequestCoordinator();
  }
  const [state, setState] = useState<ProviderCatalogState>({
    status: "loading",
  });
  const restoreRetryFocusRef = useRef(false);
  const retryButtonRef = useRef<HTMLButtonElement | null>(null);

  const loadCatalog = useCallback(() => {
    const coordinator = coordinatorRef.current;
    if (!coordinator) return;
    return loadProviderCatalog(coordinator, fetch, setState);
  }, []);

  useEffect(() => {
    void loadCatalog();
    return () => coordinatorRef.current?.abortAll();
  }, [loadCatalog]);

  useEffect(() => {
    if (!restoreRetryFocusRef.current || state.status === "loading") return;
    restoreRetryFocusRef.current = false;
    if (state.status === "unavailable") retryButtonRef.current?.focus();
  }, [state.status]);

  const retryCatalog = useCallback(() => {
    restoreRetryFocusRef.current = true;
    void loadCatalog();
  }, [loadCatalog]);

  return (
    <div
      aria-busy={state.status === "loading"}
      className="view-page providers-page"
      data-state={state.status}
      data-testid="providers-view"
    >
      <div className="page-heading">
        <div>
          <span className="eyebrow">{PROVIDER_VIEW_COPY.eyebrow}</span>
          <h1>{PROVIDER_VIEW_COPY.title}</h1>
          <p>{PROVIDER_VIEW_COPY.subtitle}</p>
        </div>
      </div>
      {state.status === "declared" ? (
        <DeclaredCatalog catalog={state.catalog} />
      ) : (
        <CatalogState
          retryButtonRef={retryButtonRef}
          state={state.status}
          onRetry={retryCatalog}
        />
      )}
    </div>
  );
}

function DeclaredCatalog({
  catalog,
}: {
  catalog: ProviderCatalogViewModel;
}) {
  return (
    <>
      <p className="sr-only" role="status">{PROVIDER_VIEW_COPY.loaded}</p>
      <section className="provider-principle" aria-label={PROVIDER_VIEW_COPY.lineage}>
        <div className="principle-copy">
          <span className="section-number">01</span>
          <div>
            <span className="eyebrow">{PROVIDER_VIEW_COPY.lineage}</span>
            <h2>{PROVIDER_STATUS_COPY.declared}</h2>
            <p>{PROVIDER_DETAIL_COPY.declared}</p>
          </div>
        </div>
        <dl>
          <div>
            <dt>{PROVIDER_VIEW_COPY.source}</dt>
            <dd><code>{catalog.sourceRef.source}</code></dd>
          </div>
          <div>
            <dt>{PROVIDER_VIEW_COPY.digest}</dt>
            <dd><code>{catalog.sourceRef.declarationSha256}</code></dd>
          </div>
        </dl>
      </section>
      <div className="provider-directory">
        {catalog.providers.map((provider) => (
          <article className="provider-card" key={provider.providerId}>
            <div
              aria-hidden="true"
              className={`provider-logo ${providerTone(provider.providerId)}`}
            >
              {provider.displayName.slice(0, 2).toUpperCase()}
            </div>
            <span className="provider-status">
              {PROVIDER_STATUS_COPY.declared}
            </span>
            <span className="method-label">{provider.providerId}</span>
            <h3>{provider.displayName}</h3>
            <dl>
              <div>
                <dt>{PROVIDER_VIEW_COPY.methods}</dt>
                <dd>{provider.methods.map(methodLabel).join(" · ")}</dd>
              </div>
              <div>
                <dt>{PROVIDER_VIEW_COPY.models}</dt>
                <dd>
                  {provider.models.length === 0
                    ? PROVIDER_VIEW_COPY.noModels
                    : provider.models
                        .map(
                          (model) =>
                            `${model.displayName} · ciclo declarado: ${model.lifecycle}`,
                        )
                        .join(", ")}
                </dd>
              </div>
            </dl>
          </article>
        ))}
      </div>
    </>
  );
}

function CatalogState({
  state,
  onRetry,
  retryButtonRef,
}: {
  state: Exclude<ProviderCatalogState["status"], "declared">;
  onRetry: () => void;
  retryButtonRef: RefObject<HTMLButtonElement | null>;
}) {
  const status = PROVIDER_STATUS_COPY[state];
  const detail = PROVIDER_DETAIL_COPY[state];
  return (
    <div className="provider-directory">
      <section
        aria-atomic="true"
        className="provider-card"
        key={state}
        role={state === "loading" ? "status" : "alert"}
      >
        <span aria-hidden="true" className="eyebrow">{status}</span>
        <h2>{status}</h2>
        <p>{detail}</p>
        {state === "unavailable" && (
          <button ref={retryButtonRef} type="button" onClick={onRetry}>
            {PROVIDER_VIEW_COPY.retry} →
          </button>
        )}
      </section>
    </div>
  );
}

function methodLabel(method: ProviderMethodView): string {
  return method.method === "oauth"
    ? "OAuth · declarado"
    : `CLI · ${method.cliEngine} · declarado`;
}

function providerTone(providerId: string): "mint" | "violet" {
  return providerId === "openai" ? "mint" : "violet";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
