"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  buildEngineRunCreateRequestedEvent,
  buildEngineRunsPanelViewModel,
  compactEngineRunId,
  ENGINE_RUN_PRODUCT_BOUNDARY,
  ENGINE_RUN_TRUST_DISCLOSURE,
  engineRunCreationConfirmedEvent,
  engineRunCreationGate,
  type EngineRunCreationState,
  type EngineRunDetailView,
  engineRunEngineLabel,
  engineRunLiveMessage,
  type EngineRunListItemView,
  type EngineRunOptionView,
  engineRunOptionLabel,
  engineRunOutcomeLabel,
  engineRunPanelIds,
  type EngineRunPanelEvent,
  engineRunStatusLabel,
  formatEngineRunTime,
  isEngineRunOverdue,
} from "./engine-run-view";

export function EngineRunsPanel({
  options,
  runs,
  selectedRunId,
  detail,
  creationState,
  onCreate,
  onRefreshRuns,
  onSelectRun,
  onUiEvent,
}: {
  options: readonly EngineRunOptionView[];
  runs: readonly EngineRunListItemView[];
  selectedRunId: string;
  detail: EngineRunDetailView | null;
  creationState: EngineRunCreationState;
  onCreate: (
    event: Extract<
      EngineRunPanelEvent,
      { type: "engine_run.create_requested" }
    >,
  ) => void;
  onRefreshRuns?: () => void;
  onSelectRun: (runId: string) => void;
  onUiEvent?: (
    event: Extract<
      EngineRunPanelEvent,
      { type: "engine_run.prompt_erase_requested" }
    >,
  ) => void;
}) {
  const reactId = useId().replaceAll(":", "");
  const ids = useMemo(() => engineRunPanelIds(`engine-runs-${reactId}`), [reactId]);
  const [selectedOptionId, setSelectedOptionId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [submissionLocked, setSubmissionLocked] = useState(false);
  const lastConfirmationRef = useRef("");
  const sectionRef = useRef<HTMLElement>(null);
  const view = buildEngineRunsPanelViewModel({
    options,
    runs,
    selectedRunId,
    detail,
  });
  const submitting =
    submissionLocked ||
    creationState.phase === "submitting" ||
    creationState.phase === "outcome_unknown";
  const gate = engineRunCreationGate({
    options: view.options,
    selectedOptionId,
    prompt,
    submitting,
  });
  const liveMessage = engineRunLiveMessage(creationState);

  useEffect(() => {
    if (creationState.phase === "failed") {
      const unlockTimer = window.setTimeout(
        () => setSubmissionLocked(false),
        0,
      );
      return () => window.clearTimeout(unlockTimer);
    }
    if (
      creationState.phase !== "confirmed" ||
      creationState.confirmationId === lastConfirmationRef.current
    ) {
      return;
    }
    lastConfirmationRef.current = creationState.confirmationId;
    const event = engineRunCreationConfirmedEvent({
      runId: creationState.runId,
      focusTargetId: ids.detailHeading,
    });
    onUiEvent?.(event);
    const focusTimer = window.setTimeout(() => {
      setSubmissionLocked(false);
      setPrompt("");
      const focusTarget =
        document.getElementById(event.focusTargetId) ?? sectionRef.current;
      focusTarget?.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(focusTimer);
  }, [creationState, ids.detailHeading, onUiEvent]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!gate.canSubmit || submissionLocked) return;
    const requested = buildEngineRunCreateRequestedEvent({
      options: view.options,
      selectedOptionId,
      prompt,
    });
    if (!requested.ok) return;
    setSubmissionLocked(true);
    onCreate(requested.event);
  }

  return (
    <section
      ref={sectionRef}
      className="diagnostic-runs engine-runs"
      data-testid="engine-runs-panel"
      tabIndex={-1}
    >
      <header>
        <div>
          <span className="section-number">04</span>
          <div>
            <span className="eyebrow">
              ONE-SHOT PROVIDER CLI · PRODUCT SHELL · B4.5
            </span>
            <h2>Crie e inspecione uma análise atribuída.</h2>
            <p>
              Um runner ativo usa exatamente a engine escolhida para uma única
              análise. Não há fallback, retry automático, tools, mutação do
              workspace, sandbox atestado, isolamento garantido ou streaming.
            </p>
          </div>
        </div>
      </header>

      <ProductBoundary id={ids.boundary} />

      <form
        className="diagnostic-create-form"
        aria-label="Criar análise one-shot via provider CLI"
        onSubmit={submit}
      >
        <header>
          <div>
            <strong>Nova análise atribuída</strong>
            <small>
              A opção e o disabled reason vêm de uma projeção governada pelo
              servidor. O claim ainda revalida os mesmos fatos.
            </small>
          </div>
        </header>

        <div className="diagnostic-assigned-fields entity-editor">
          <label>
            Runner e engine
            <select
              value={selectedOptionId}
              onChange={(event) => setSelectedOptionId(event.target.value)}
              disabled={submitting || view.options.length === 0}
              aria-describedby={ids.boundary}
              data-testid="engine-run-option"
              required
            >
              <option value="">Selecione uma combinação…</option>
              {view.options.map((option) => (
                <option key={option.optionId} value={option.optionId}>
                  {engineRunOptionLabel(option)}
                  {option.eligible ? "" : ` · indisponível: ${option.disabledReason}`}
                </option>
              ))}
            </select>
          </label>

          <label htmlFor={ids.promptInput}>
            Prompt efêmero
            <textarea
              id={ids.promptInput}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              disabled={submitting}
              aria-describedby={`${ids.promptHelp} ${
                !gate.canSubmit ? ids.blockedReason : ""
              }`.trim()}
              data-testid="engine-run-prompt"
              rows={4}
            />
            <small id={ids.promptHelp}>
              {gate.promptBytes}/8192 bytes UTF-8. O conteúdo sai somente no
              evento de criação e é apagado da UI após confirmação.
            </small>
          </label>

          {!gate.canSubmit && (
            <p id={ids.blockedReason} role="status">
              {gate.blockedReason}
            </p>
          )}
          {view.optionsTruncated && (
            <p role="status">
              A UI limitou a projeção às primeiras 32 opções. Refine a origem
              antes de escolher.
            </p>
          )}
          {gate.selectedOption && (
            <SelectedEngineOptionFacts option={gate.selectedOption} />
          )}
        </div>

        <footer>
          <p id={`${ids.boundary}-create`}>
            A criação é one-shot. Falha não inicia retry e a UI não escolhe
            outra engine. Readiness hostReported é observação, não garantia ou
            reserva. O prompt permanece somente em memória até a confirmação.
          </p>
          <button
            className="primary-button compact"
            type="submit"
            disabled={!gate.canSubmit}
            aria-describedby={`${ids.boundary}-create ${
              !gate.canSubmit ? ids.blockedReason : ""
            }`.trim()}
            data-testid="create-engine-run"
          >
            {submitting ? "Confirmando one-shot…" : "Criar análise one-shot"}
          </button>
        </footer>
      </form>

      <p
        id={ids.liveRegion}
        className="runner-history-status"
        role={
          creationState.phase === "failed" ||
          creationState.phase === "outcome_unknown"
            ? "alert"
            : "status"
        }
        aria-live="polite"
        aria-atomic="true"
      >
        {liveMessage}
      </p>
      {creationState.phase === "outcome_unknown" && (
        <div className="diagnostic-claim-authority" role="alert">
          <b>RESULTADO DA CRIAÇÃO DESCONHECIDO</b>
          <p>
            Timeout ou falha 5xx sem resposta pode ter acontecido depois da
            persistência. Não reenvie. Consulte a lista antes de liberar outra
            criação.
          </p>
          {onRefreshRuns && (
            <button
              type="button"
              className="text-button"
              onClick={onRefreshRuns}
              data-testid="refresh-engine-runs-after-unknown"
            >
              Atualizar e reconciliar lista
            </button>
          )}
        </div>
      )}

      <div className="diagnostic-layout">
        <div className="diagnostic-list" aria-label="Análises one-shot">
          {view.runs.length === 0 && <p>Nenhuma análise criada.</p>}
          {view.runs.map((run) => (
            <button
              key={run.id}
              type="button"
              className={selectedRunId === run.id ? "is-selected" : ""}
              aria-current={selectedRunId === run.id ? "true" : undefined}
              onClick={() => onSelectRun(run.id)}
            >
              <EngineRunBadges run={run} />
              <time dateTime={run.updatedAt}>
                {formatEngineRunTime(run.updatedAt)}
              </time>
              <b>{compactEngineRunId(run.id)}</b>
              <small className="diagnostic-assignment">
                {run.runnerDisplayName} · {engineRunEngineLabel(run.engine)}
              </small>
              <small className="diagnostic-requirement">
                Atribuído · {compactEngineRunId(run.assignedRunnerId)}
              </small>
            </button>
          ))}
          {view.runsTruncated && (
            <p>Mostrando os 50 runs mais recentes desta projeção.</p>
          )}
        </div>

        <div className="diagnostic-detail">
          {!view.detail ? (
            <div className="diagnostic-placeholder">
              <span>⌁</span>
              <h3>Selecione uma análise.</h3>
              <p>
                O detalhe separa status persistido, expiry derivado e receipt
                imutável. O prompt não reaparece aqui.
              </p>
            </div>
          ) : (
            <EngineRunDetail
              detail={view.detail}
              headingId={ids.detailHeading}
            />
          )}
        </div>
      </div>
    </section>
  );
}

export function ProductBoundary({ id }: { id: string }) {
  return (
    <div id={id} className="runner-policy-panel">
      <p className="runner-trust-disclosure">
        <span>HOST-REPORTED READINESS</span>
        <small>{ENGINE_RUN_TRUST_DISCLOSURE}</small>
      </p>
      <p className="diagnostic-claim-authority">
        A credencial OAuth/CLI, a cota do provider e eventuais políticas
        enterprise pertencem ao operador do host. O prompt fica somente em
        memória durante a criação e não é projetado no detalhe ou no receipt.
      </p>
      <ul className="runner-policy-capabilities" aria-label="Limite do produto">
        {ENGINE_RUN_PRODUCT_BOUNDARY.map((item) => (
          <li
            key={item.capability}
            className={item.state === "real" ? "is-allowed" : "is-denied"}
          >
            <span>{item.capability}</span>
            <b>{item.state === "real" ? "REAL" : "ROADMAP"}</b>
            <small>{item.detail}</small>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function EngineRunBadges({ run }: { run: EngineRunListItemView }) {
  return (
    <span className="diagnostic-badges">
      <span className={`diagnostic-status status-${run.storedStatus}`}>
        {engineRunStatusLabel(run.storedStatus)}
      </span>
      {isEngineRunOverdue(run) && (
        <span className="diagnostic-expired">
          PRAZO EXCEDIDO · AGUARDANDO RECONCILIAÇÃO
        </span>
      )}
    </span>
  );
}

export function SelectedEngineOptionFacts({
  option,
}: {
  option: EngineRunOptionView;
}) {
  return (
    <dl
      className="diagnostic-assignment-proof"
      aria-label="Fatos observados da opção"
    >
      <div>
        <dt>Trust</dt>
        <dd>{option.trust}</dd>
      </div>
      <div>
        <dt>Readiness observada</dt>
        <dd>
          {option.status} · {option.readiness}
        </dd>
      </div>
      <div>
        <dt>Reason</dt>
        <dd>{option.reason}</dd>
      </div>
      <div>
        <dt>Freshness</dt>
        <dd>{option.freshness}</dd>
      </div>
      <div>
        <dt>Report</dt>
        <dd className="intent-hash">{option.reportId ?? "ausente"}</dd>
      </div>
      <div>
        <dt>Fresh until</dt>
        <dd>
          {option.freshUntil
            ? formatEngineRunTime(option.freshUntil)
            : "não calculado"}
        </dd>
      </div>
    </dl>
  );
}

export function EngineRunDetail({
  detail,
  headingId,
}: {
  detail: EngineRunDetailView;
  headingId: string;
}) {
  const { run, receipt } = detail;
  return (
    <>
      <header>
        <div>
          <EngineRunBadges run={run} />
          <h3 id={headingId} tabIndex={-1} className="intent-hash">
            {run.id}
          </h3>
        </div>
      </header>

      <dl className="diagnostic-proof">
        <div>
          <dt>Status persistido</dt>
          <dd>{run.storedStatus}</dd>
        </div>
        <div>
          <dt>Expiry derivado</dt>
          <dd>
            {isEngineRunOverdue(run)
              ? "prazo excedido — aguardando reconciliação"
              : "dentro do prazo"}
          </dd>
        </div>
        <div>
          <dt>Engine</dt>
          <dd>{engineRunEngineLabel(run.engine)}</dd>
        </div>
        <div>
          <dt>Runner atribuído</dt>
          <dd title={run.assignedRunnerId}>
            {compactEngineRunId(run.assignedRunnerId)}
          </dd>
        </div>
      </dl>

      <dl className="diagnostic-assignment-proof">
        <div>
          <dt>Deadline</dt>
          <dd>{formatEngineRunTime(run.derivedExpiry.deadlineAt)}</dd>
        </div>
        <div>
          <dt>Expiry avaliado pelo servidor</dt>
          <dd>{formatEngineRunTime(run.derivedExpiry.evaluatedAt)}</dd>
        </div>
        <div>
          <dt>Lease</dt>
          <dd className="intent-hash">
            {run.currentLeaseId ?? "aguardando claim"}
          </dd>
        </div>
        <div>
          <dt>Holder atual</dt>
          <dd className="intent-hash">
            {run.currentRunnerId ?? "nenhum"}
          </dd>
        </div>
      </dl>

      <p className="diagnostic-claim-authority">
        Status persistido e expiry derivado são fatos distintos. A prontidão
        hostReported foi observada na criação, mas não garante elegibilidade,
        não reserva capacidade e não prova sandbox, isolamento ou sucesso do
        provider.
      </p>

      {receipt ? (
        <EngineRunReceiptMetadata receipt={receipt} />
      ) : (
        <div className="diagnostic-placeholder" role="status">
          <span>⋯</span>
          <h3>Receipt ainda não registrado.</h3>
          <p>
            queued e leased continuam elegíveis para polling pelo controller.
            Este componente não busca nem repete a execução.
          </p>
        </div>
      )}
    </>
  );
}

export function EngineRunReceiptMetadata({
  receipt,
}: {
  receipt: NonNullable<EngineRunDetailView["receipt"]>;
}) {
  return (
    <section aria-label="Receipt imutável da execução">
      <div className="diagnostic-outcome">
        <b>{engineRunOutcomeLabel(receipt.status).toUpperCase()}</b>
        <p>
          {receipt.reason} · engine {receipt.engineVersion} · exit{" "}
          {receipt.exitCode ?? "n/a"} · timed out{" "}
          {receipt.timedOut ? "sim" : "não"} · cancel requested{" "}
          {receipt.cancelRequested ? "sim" : "não"}
        </p>
      </div>

      <dl className="diagnostic-assignment-proof">
        <div>
          <dt>Receipt SHA-256</dt>
          <dd className="intent-hash">{receipt.receiptSha256}</dd>
        </div>
        <div>
          <dt>Excerpt SHA-256</dt>
          <dd className="intent-hash">{receipt.excerptSha256}</dd>
        </div>
        <div>
          <dt>Excerpt ref</dt>
          <dd className="intent-hash">{receipt.excerptRef}</dd>
        </div>
        <div>
          <dt>Registrado</dt>
          <dd>{formatEngineRunTime(receipt.recordedAt)}</dd>
        </div>
        <div>
          <dt>Iniciado</dt>
          <dd>{formatEngineRunTime(receipt.startedAt)}</dd>
        </div>
        <div>
          <dt>Finalizado</dt>
          <dd>{formatEngineRunTime(receipt.finishedAt)}</dd>
        </div>
      </dl>

      <dl className="diagnostic-assignment-proof">
        <ReceiptStreamFacts name="stdout" stream={receipt.stdout} />
        <ReceiptStreamFacts name="stderr" stream={receipt.stderr} />
      </dl>

      <p className="diagnostic-claim-authority">
        Esta etapa mostra somente metadados do excerpt: bytes, digest e
        truncation. O conteúdo criptografado não é decodificado nem
        interpretado como ANSI ou HTML neste shell.
      </p>
    </section>
  );
}

function ReceiptStreamFacts({
  name,
  stream,
}: {
  name: "stdout" | "stderr";
  stream: NonNullable<EngineRunDetailView["receipt"]>["stdout"];
}) {
  return (
    <>
      <div>
        <dt>{name} bytes / excerpt</dt>
        <dd>
          {stream.bytes} / {stream.excerptBytes}
        </dd>
      </div>
      <div>
        <dt>{name} truncation</dt>
        <dd>{stream.truncated ? "truncado" : "completo"}</dd>
      </div>
      <div>
        <dt>{name} SHA-256</dt>
        <dd className="intent-hash" title={stream.sha256}>
          {stream.sha256}
        </dd>
      </div>
    </>
  );
}
