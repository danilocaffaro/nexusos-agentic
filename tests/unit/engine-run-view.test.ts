import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  EngineRunBadges,
  EngineRunDetail,
  EngineRunExcerptPanel,
  EngineRunsPanel,
  ProductBoundary,
  SelectedEngineOptionFacts,
  engineRunExecutionCommand,
} from "../../app/engine-runs-panel";
import {
  acquireEngineRunSubmissionLatch,
  buildEngineRunCreateRequestedEvent,
  buildEngineRunsPanelViewModel,
  ENGINE_RUN_UI_LIMITS,
  engineRunCreationGate,
  engineRunCreationTransition,
  engineRunLiveMessage,
  engineRunReconciliationRequestedEvent,
  engineRunStatusLabel,
  isEngineRunOverdue,
  isWellFormedUnicode,
  releaseEngineRunSubmissionLatch,
  shouldPollEngineRun,
  utf8ByteLength,
} from "../../app/engine-run-view";
import {
  engineRunUiCompletedDetail,
  engineRunUiOptions,
  engineRunUiRuns,
  engineRunUiTerminalRuns,
} from "../fixtures/s6-b4/engine-run-ui-fixtures";

test("counts exact UTF-8 bytes and enforces the closed prompt bounds", () => {
  assert.equal(utf8ByteLength("a"), 1);
  assert.equal(utf8ByteLength("🙂"), 4);
  assert.equal(
    engineRunCreationGate({
      options: engineRunUiOptions,
      selectedOptionId: engineRunUiOptions[0].optionId,
      prompt: "",
      submitting: false,
    }).canSubmit,
    false,
  );
  assert.equal(
    engineRunCreationGate({
      options: engineRunUiOptions,
      selectedOptionId: engineRunUiOptions[0].optionId,
      prompt: "a".repeat(ENGINE_RUN_UI_LIMITS.promptMaxBytes),
      submitting: false,
    }).canSubmit,
    true,
  );
  const over = engineRunCreationGate({
    options: engineRunUiOptions,
    selectedOptionId: engineRunUiOptions[0].optionId,
    prompt: "🙂".repeat(2_049),
    submitting: false,
  });
  assert.equal(over.promptBytes, 8_196);
  assert.equal(over.canSubmit, false);
  assert.match(over.blockedReason, /8192/u);
  assert.equal(isWellFormedUnicode("valid 🙂"), true);
  assert.equal(isWellFormedUnicode("\ud800"), false);
  assert.match(
    engineRunCreationGate({
      options: engineRunUiOptions,
      selectedOptionId: engineRunUiOptions[0].optionId,
      prompt: "\ud800",
      submitting: false,
    }).blockedReason,
    /surrogate Unicode isolado/u,
  );
});

test("uses server-projected eligibility and exposes deterministic disabled reasons", () => {
  assert.match(
    engineRunCreationGate({
      options: [],
      selectedOptionId: "",
      prompt: "work",
      submitting: false,
    }).blockedReason,
    /Nenhum runner/u,
  );
  assert.match(
    engineRunCreationGate({
      options: engineRunUiOptions,
      selectedOptionId: "",
      prompt: "work",
      submitting: false,
    }).blockedReason,
    /Escolha uma combinação/u,
  );
  const denied = engineRunCreationGate({
    options: engineRunUiOptions,
    selectedOptionId: engineRunUiOptions[1].optionId,
    prompt: "work",
    submitting: false,
  });
  assert.equal(denied.canSubmit, false);
  assert.equal(
    denied.blockedReason,
    engineRunUiOptions[1].disabledReason,
  );
  assert.match(
    engineRunCreationGate({
      options: engineRunUiOptions,
      selectedOptionId: engineRunUiOptions[0].optionId,
      prompt: "work",
      submitting: true,
    }).blockedReason,
    /Não há retry ou fallback automático/u,
  );
});

test("emits one one-shot create request and a prompt-free erase-on-confirm transition", () => {
  const result = buildEngineRunCreateRequestedEvent({
    options: engineRunUiOptions,
    selectedOptionId: engineRunUiOptions[0].optionId,
    prompt: "Analisar a mudança",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.event, {
    type: "engine_run.create_requested",
    executionMode: "one_shot_cli",
    retryPolicy: "none",
    request: {
      assignedRunnerId: engineRunUiOptions[0].assignedRunnerId,
      engine: "claude_code_cli",
      prompt: "Analisar a mudança",
    },
  });

  const confirmed = engineRunCreationTransition({
    state: {
      phase: "confirmed",
      creationId: `ecr_${"1".repeat(32)}`,
      runId: engineRunUiRuns[2].id,
      message: "Criação confirmada.",
    },
    detailFocusTargetId: "engine-detail",
  });
  assert.deepEqual(confirmed.promptEraseEvent, {
    type: "engine_run.prompt_erase_requested",
    reason: "creation_confirmed",
    runId: engineRunUiRuns[2].id,
    focusTargetId: "engine-detail",
  });
  assert.equal(confirmed.erasePrompt, true);
  assert.equal(confirmed.releaseLatch, true);
  assert.equal(
    "prompt" in (confirmed.promptEraseEvent ?? {}),
    false,
  );
  assert.doesNotMatch(JSON.stringify(confirmed), /Analisar a mudança/u);
});

test("serializes submit synchronously and releases only on conclusive transitions", () => {
  const latch = { current: false };
  const emitted: string[] = [];
  const submit = () => {
    if (!acquireEngineRunSubmissionLatch(latch)) return;
    emitted.push("create");
  };

  submit();
  submit();
  assert.deepEqual(emitted, ["create"]);
  assert.equal(latch.current, true);

  const unknown = engineRunCreationTransition({
    state: {
      phase: "outcome_unknown",
      incidentId: "incident-1",
      message: "Timeout sem corpo.",
      requiredAction: "authoritative_reconciliation_required",
    },
    detailFocusTargetId: "engine-detail",
  });
  assert.equal(unknown.releaseLatch, false);
  assert.equal(releaseEngineRunSubmissionLatch(latch, unknown), false);
  assert.equal(latch.current, true);

  const confirmed = engineRunCreationTransition({
    state: {
      phase: "confirmed",
      creationId: `ecr_${"1".repeat(32)}`,
      runId: engineRunUiRuns[2].id,
      message: "Criado.",
    },
    detailFocusTargetId: "engine-detail",
  });
  let prompt = "segredo efêmero";
  let focused = "";
  assert.equal(releaseEngineRunSubmissionLatch(latch, confirmed), true);
  if (confirmed.erasePrompt) prompt = "";
  if (confirmed.focusTargetId) focused = confirmed.focusTargetId;
  assert.equal(latch.current, false);
  assert.equal(prompt, "");
  assert.equal(focused, "engine-detail");

  assert.equal(acquireEngineRunSubmissionLatch(latch), true);
  const failed = engineRunCreationTransition({
    state: {
      phase: "failure_confirmed",
      failureId: "failure-1",
      message: "Falha confirmada antes da persistência.",
    },
    detailFocusTargetId: "engine-detail",
  });
  assert.equal(releaseEngineRunSubmissionLatch(latch, failed), true);
  assert.equal(failed.erasePrompt, false);
  assert.equal(latch.current, false);

  assert.equal(acquireEngineRunSubmissionLatch(latch), true);
  const reconciled = engineRunCreationTransition({
    state: {
      phase: "reconciled",
      incidentId: "incident-1",
      notCreatedProofId: `ncp_${"2".repeat(32)}`,
      resolution: "confirmed_not_created",
      message: "A autoridade confirmou que nada foi criado.",
    },
    detailFocusTargetId: "engine-detail",
  });
  assert.equal(releaseEngineRunSubmissionLatch(latch, reconciled), true);
  assert.equal(reconciled.erasePrompt, false);
  assert.equal(latch.current, false);
});

test("requests authoritative reconciliation without treating list absence as proof", () => {
  assert.deepEqual(
    engineRunReconciliationRequestedEvent("incident-1"),
    {
      type: "engine_run.creation_reconciliation_requested",
      incidentId: "incident-1",
      requiredEvidence: "authoritative_creation_result",
      listAbsenceIsConclusive: false,
    },
  );
});

test("bounds local projections and never falls back to an unrelated detail", () => {
  const options = Array.from(
    { length: ENGINE_RUN_UI_LIMITS.options + 4 },
    (_, index) => ({
      ...engineRunUiOptions[0],
      optionId: `option-${index}`,
    }),
  );
  const runs = Array.from(
    { length: ENGINE_RUN_UI_LIMITS.runs + 5 },
    (_, index) => ({
      ...engineRunUiRuns[0],
      id: `run-${index}`,
    }),
  );
  const view = buildEngineRunsPanelViewModel({
    options,
    runs,
    selectedRunId: "another-run",
    detail: engineRunUiCompletedDetail,
  });
  assert.equal(view.options.length, ENGINE_RUN_UI_LIMITS.options);
  assert.equal(view.runs.length, ENGINE_RUN_UI_LIMITS.runs);
  assert.equal(view.optionsTruncated, true);
  assert.equal(view.runsTruncated, true);
  assert.equal(view.detail, null);
});

test("keeps persisted lifecycle separate from server-derived overdue state", () => {
  assert.equal(engineRunUiRuns[0].storedStatus, "queued");
  assert.equal(engineRunUiRuns[0].overdue, true);
  assert.equal(
    engineRunUiRuns[0].deadlineState,
    "overdue_awaiting_reconciliation",
  );
  assert.equal(shouldPollEngineRun(engineRunUiRuns[0]), true);
  assert.equal(shouldPollEngineRun(engineRunUiRuns[1]), true);
  assert.equal(shouldPollEngineRun(engineRunUiRuns[2]), false);
  assert.equal(isEngineRunOverdue(engineRunUiRuns[0]), true);
  assert.equal(isEngineRunOverdue(engineRunUiTerminalRuns[0]), false);
  assert.equal(isEngineRunOverdue(engineRunUiTerminalRuns[1]), false);
  assert.deepEqual(
    (
      ["queued", "leased", "completed", "canceled", "expired"] as const
    ).map(engineRunStatusLabel),
    [
      "Aguardando runner",
      "Lease ativa",
      "Concluído",
      "Cancelado",
      "Expirado persistido",
    ],
  );
  const html = renderToStaticMarkup(
    createElement(EngineRunBadges, { run: engineRunUiRuns[0] }),
  );
  assert.match(html, /Aguardando runner/u);
  assert.match(html, /PRAZO EXCEDIDO · AGUARDANDO RECONCILIAÇÃO/u);
  assert.doesNotMatch(html, /status-expired|PRAZO EXPIRADO/u);
  const expiredHtml = renderToStaticMarkup(
    createElement(EngineRunBadges, { run: engineRunUiTerminalRuns[1] }),
  );
  assert.match(expiredHtml, /Expirado persistido/u);
  assert.doesNotMatch(expiredHtml, /PRAZO EXCEDIDO/u);
});

test("renders truthful product, host and operator boundaries", () => {
  const html = renderToStaticMarkup(
    createElement(ProductBoundary, { id: "product-boundary" }),
  );
  assert.match(html, /One-shot CLI/u);
  assert.match(html, />REAL</u);
  assert.match(html, /Tools/u);
  assert.match(html, /Sandbox/u);
  assert.match(html, /Workspace mutation/u);
  assert.match(html, /Streaming/u);
  assert.equal((html.match(/NÃO DISPONÍVEL/gu) ?? []).length, 4);
  assert.doesNotMatch(html, /ROADMAP|B4\.5/u);
  assert.match(html, /hostReported é uma observação/u);
  assert.match(html, /não uma garantia ou reserva/u);
  assert.match(html, /credencial OAuth\/CLI/u);
  assert.match(html, /cota do provider/u);
  assert.match(html, /somente em memória/u);
});

test("renders server-observed option facts without claiming a reservation", () => {
  const html = renderToStaticMarkup(
    createElement(SelectedEngineOptionFacts, {
      option: engineRunUiOptions[0],
    }),
  );
  assert.match(html, /hostReported/u);
  assert.match(html, /available · ready/u);
  assert.match(html, /Fresh until/u);
  assert.match(html, /class="intent-hash"/u);
  assert.doesNotMatch(html, /reservado|garantido/iu);
  const notEvaluatedHtml = renderToStaticMarkup(
    createElement(SelectedEngineOptionFacts, {
      option: engineRunUiOptions[2],
    }),
  );
  assert.match(notEvaluatedHtml, /not_evaluated/u);
  assert.match(notEvaluatedHtml, /não calculado/u);
  assert.doesNotMatch(notEvaluatedHtml, />absent</u);
});

test("renders receipt metadata without prompt or excerpt content", () => {
  const html = renderToStaticMarkup(
    createElement(EngineRunDetail, {
      detail: engineRunUiCompletedDetail,
      headingId: "engine-detail-heading",
    }),
  );
  assert.match(html, /Status persistido/u);
  assert.match(html, />completed</u);
  assert.match(html, /Receipt SHA-256/u);
  assert.match(html, /Excerpt storage state/u);
  assert.match(html, /stored_encrypted/u);
  assert.match(html, /Iniciado/u);
  assert.match(html, /Finalizado/u);
  assert.match(html, /stdout bytes \/ excerpt/u);
  assert.match(html, /truncado/u);
  assert.match(html, /class="intent-hash"/u);
  assert.match(html, /não é decodificado nem interpretado como ANSI ou HTML/u);
  assert.match(html, /Comando explícito deste run/u);
  assert.match(
    html,
    new RegExp(
      `npm run local:engine -- --engine claude_code_cli --path &lt;caminho-absoluto&gt; --run ${engineRunUiCompletedDetail.run.id}`,
      "u",
    ),
  );
  assert.match(html, /esta UI não o executa nem busca trabalho/u);
  assert.doesNotMatch(
    html,
    /promptRef|promptSha256|excerptBase64|Excerpt SHA-256|Excerpt ref|<pre/u,
  );
});

test("builds one explicit local engine command for pending and completed runs", () => {
  assert.equal(
    engineRunExecutionCommand(engineRunUiRuns[0]),
    `npm run local:engine -- --engine ${engineRunUiRuns[0].engine} --path <caminho-absoluto> --run ${engineRunUiRuns[0].id}`,
  );
  assert.equal(
    engineRunExecutionCommand(engineRunUiCompletedDetail.run),
    `npm run local:engine -- --engine ${engineRunUiCompletedDetail.run.engine} --path <caminho-absoluto> --run ${engineRunUiCompletedDetail.run.id}`,
  );

  const pendingHtml = renderToStaticMarkup(
    createElement(EngineRunDetail, {
      detail: {
        run: {
          ...engineRunUiRuns[0],
          leaseGeneration: 0,
          currentLeaseId: null,
          currentRunnerId: null,
        },
        receipt: null,
        eventsCount: 1,
        eventsTruncated: false,
      },
      headingId: "pending-engine-run",
    }),
  );
  assert.match(pendingHtml, /Execute este run explicitamente/u);
  assert.match(pendingHtml, /--run run_/u);
  assert.doesNotMatch(pendingHtml, /polling pelo controller/u);
});

test("renders protected excerpts only as explicit opaque Base64URL text", () => {
  const html = renderToStaticMarkup(
    createElement(EngineRunExcerptPanel, {
      runId: engineRunUiCompletedDetail.run.id,
      state: {
        phase: "loaded",
        runId: engineRunUiCompletedDetail.run.id,
        excerpt: {
          schemaVersion: 1,
          runId: engineRunUiCompletedDetail.run.id,
          state: "stored",
          encoding: "base64url",
          interpretation: "opaque_bytes",
          stdoutBase64Url: "PGI-bm90LWh0bWw8L2I-",
          stderrBase64Url: "G1szMW0",
          receipt: {
            excerptRef: `exc_${"1".repeat(32)}`,
            excerptSha256: "2".repeat(64),
            receiptSha256: "3".repeat(64),
            recordedAt: "2026-07-28T12:00:00.000Z",
            stdout: {
              bytes: 15,
              excerptBytes: 15,
              sha256: "4".repeat(64),
              truncated: false,
            },
            stderr: {
              bytes: 5,
              excerptBytes: 5,
              sha256: "5".repeat(64),
              truncated: false,
            },
          },
        },
      },
      onLoad: () => undefined,
    }),
  );
  assert.match(html, /bytes opacos/iu);
  assert.match(html, /data-encoding="base64url"/u);
  assert.match(html, /data-interpretation="opaque_bytes"/u);
  assert.match(html, /role="status" aria-live="polite" aria-atomic="true"/u);
  assert.match(html, /Estado autoritativo: stored\. Os campos stdout e stderr/u);
  assert.match(html, /aria-labelledby="engine-run-excerpt-[^"]+-stdout-label"/u);
  assert.match(html, /aria-labelledby="engine-run-excerpt-[^"]+-stderr-label"/u);
  assert.match(html, /<pre tabindex="0">PGI-bm90LWh0bWw8L2I-<\/pre>/u);
  assert.match(html, /<pre tabindex="0">G1szMW0<\/pre>/u);
  assert.doesNotMatch(html, /<b>not-html<\/b>/u);
  assert.equal(html.includes(`${String.fromCharCode(27)}[31m`), false);

  const forbidden = renderToStaticMarkup(
    createElement(EngineRunExcerptPanel, {
      runId: engineRunUiCompletedDetail.run.id,
      state: {
        phase: "error",
        runId: engineRunUiCompletedDetail.run.id,
        reason: "forbidden",
        message: "Owner required.",
      },
    }),
  );
  assert.match(forbidden, /data-error-reason="forbidden"/u);
  assert.doesNotMatch(forbidden, /absent|erased/iu);
});

test("renders accessible blocked, live and unknown-outcome states without retry", () => {
  const html = renderToStaticMarkup(
    createElement(EngineRunsPanel, {
      options: engineRunUiOptions,
      runs: engineRunUiRuns,
      selectedRunId: engineRunUiRuns[2].id,
      detail: engineRunUiCompletedDetail,
      creationState: {
        phase: "outcome_unknown",
        incidentId: "incident-1",
        message: "A conexão terminou sem resposta.",
        requiredAction: "authoritative_reconciliation_required",
      },
      onCreate: () => undefined,
      onReconcileUnknown: () => undefined,
      onSelectRun: () => undefined,
    }),
  );
  assert.match(html, /aria-describedby=/u);
  assert.match(html, /aria-live="polite"/u);
  assert.match(html, /aria-live="assertive"/u);
  assert.match(html, /aria-atomic="true"/u);
  assert.match(html, /RESULTADO DA CRIAÇÃO DESCONHECIDO/u);
  assert.match(html, /O run pode ter sido criado/u);
  assert.match(html, /Não reenvie/u);
  assert.match(html, /ausência em uma página/u);
  assert.match(html, /não comprova/u);
  assert.match(html, /Verificar resultado com autoridade/u);
  const createButton = html.match(
    /<button[^>]*data-testid="create-engine-run"[^>]*>/u,
  )?.[0];
  assert.ok(createButton);
  assert.match(createButton, /disabled/u);
  assert.match(html, /tabindex="-1"/u);
});

test("models ambiguous failure as refresh-required instead of a retry offer", () => {
  const message = engineRunLiveMessage({
    phase: "outcome_unknown",
    incidentId: "incident-1",
    message: "Timeout sem corpo.",
    requiredAction: "authoritative_reconciliation_required",
  });
  assert.match(message, /pode ter sido criado/u);
  assert.match(message, /resultado autoritativo/u);
  assert.match(message, /ausência em uma página/u);
  assert.doesNotMatch(message, /tente novamente|retry disponível/iu);
});

test("keeps the preparatory shell adapter-neutral and free of network effects", async () => {
  const [panelSource, viewSource] = await Promise.all([
    readFile(
      new URL("../../app/engine-runs-panel.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../../app/engine-run-view.ts", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(panelSource, /\bfetch\s*\(/u);
  assert.doesNotMatch(viewSource, /\bfetch\s*\(/u);
  assert.doesNotMatch(
    `${panelSource}\n${viewSource}`,
    /src\/contracts|src\/adapters|\/api\/runs/u,
  );
  assert.doesNotMatch(panelSource, /dangerouslySetInnerHTML/u);
  assert.match(panelSource, /prompt_erase_requested/u);
});
