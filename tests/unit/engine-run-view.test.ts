import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  EngineRunBadges,
  EngineRunDetail,
  EngineRunsPanel,
  ProductBoundary,
  SelectedEngineOptionFacts,
} from "../../app/engine-runs-panel";
import {
  buildEngineRunCreateRequestedEvent,
  buildEngineRunsPanelViewModel,
  ENGINE_RUN_UI_LIMITS,
  engineRunCreationConfirmedEvent,
  engineRunCreationGate,
  engineRunLiveMessage,
  engineRunStatusLabel,
  isEngineRunOverdue,
  isWellFormedUnicode,
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

test("emits one one-shot create request and a prompt-free erase-on-confirm event", () => {
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

  const confirmed = engineRunCreationConfirmedEvent({
    runId: engineRunUiRuns[2].id,
    focusTargetId: "engine-detail",
  });
  assert.deepEqual(confirmed, {
    type: "engine_run.prompt_erase_requested",
    reason: "creation_confirmed",
    runId: engineRunUiRuns[2].id,
    focusTargetId: "engine-detail",
  });
  assert.equal("prompt" in confirmed, false);
  assert.doesNotMatch(JSON.stringify(confirmed), /Analisar a mudança/u);
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
  assert.equal(engineRunUiRuns[0].derivedExpiry.overdue, true);
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
  assert.equal((html.match(/ROADMAP/gu) ?? []).length, 4);
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
  assert.match(html, /Excerpt SHA-256/u);
  assert.match(html, /Iniciado/u);
  assert.match(html, /Finalizado/u);
  assert.match(html, /stdout bytes \/ excerpt/u);
  assert.match(html, /truncado/u);
  assert.match(html, /class="intent-hash"/u);
  assert.match(html, /não é decodificado nem interpretado como ANSI ou HTML/u);
  assert.doesNotMatch(html, /promptRef|promptSha256|excerptBase64|<pre/u);
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
        message: "A conexão terminou sem resposta.",
        requiredAction: "refresh_runs_before_new_submit",
      },
      onCreate: () => undefined,
      onRefreshRuns: () => undefined,
      onSelectRun: () => undefined,
    }),
  );
  assert.match(html, /aria-describedby=/u);
  assert.match(html, /aria-live="polite"/u);
  assert.match(html, /aria-atomic="true"/u);
  assert.match(html, /RESULTADO DA CRIAÇÃO DESCONHECIDO/u);
  assert.match(html, /O run pode ter sido criado/u);
  assert.match(html, /Não reenvie/u);
  assert.match(html, /Atualizar e reconciliar lista/u);
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
    message: "Timeout sem corpo.",
    requiredAction: "refresh_runs_before_new_submit",
  });
  assert.match(message, /pode ter sido criado/u);
  assert.match(message, /Atualize a lista/u);
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
  assert.match(panelSource, /setSubmissionLocked\(true\)/u);
  assert.doesNotMatch(
    panelSource,
    /catch\s*\{[\s\S]{0,120}setSubmissionLocked\(false\)/u,
  );
  assert.match(panelSource, /setPrompt\(""\)/u);
  assert.match(panelSource, /prompt_erase_requested/u);
});
