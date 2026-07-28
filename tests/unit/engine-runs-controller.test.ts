import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  clearPendingCreation,
  ENGINE_RUN_PENDING_CREATION_STORAGE_KEY,
  EngineRunRequestCoordinator,
  engineRunCreateFailureMessage,
  engineRunsHavePollableWork,
  readPendingCreation,
  storePendingCreation,
} from "../../app/engine-runs-controller";
import type { EngineRunListItemView } from "../../app/engine-run-view";

test("request lanes abort only their predecessor and reject stale epochs", () => {
  const coordinator = new EngineRunRequestCoordinator();
  const options = coordinator.begin("options");
  const firstList = coordinator.begin("list");
  const detail = coordinator.begin("detail");
  const excerpt = coordinator.begin("excerpt");
  const secondList = coordinator.begin("list");

  assert.equal(options.signal.aborted, false);
  assert.equal(detail.signal.aborted, false);
  assert.equal(excerpt.signal.aborted, false);
  assert.equal(firstList.signal.aborted, true);
  assert.equal(coordinator.isCurrent("list", firstList.epoch), false);
  assert.equal(coordinator.isCurrent("list", secondList.epoch), true);
  assert.equal(coordinator.finish("list", firstList.epoch), false);
  assert.equal(coordinator.finish("list", secondList.epoch), true);
  assert.equal(coordinator.hasActive("list"), false);
});

test("StrictMode-style repeated cleanup stays abort-safe and permits setup again", () => {
  const coordinator = new EngineRunRequestCoordinator();
  const first = coordinator.begin("create");
  coordinator.abortAll();
  coordinator.abortAll();
  assert.equal(first.signal.aborted, true);

  const remounted = coordinator.begin("create");
  assert.equal(remounted.signal.aborted, false);
  assert.equal(coordinator.isCurrent("create", remounted.epoch), true);
  assert.ok(remounted.epoch > first.epoch);
});

test("polling eligibility is closed to queued and leased stored states", () => {
  assert.equal(engineRunsHavePollableWork([run("queued")]), true);
  assert.equal(engineRunsHavePollableWork([run("leased")]), true);
  assert.equal(engineRunsHavePollableWork([run("completed")]), false);
  assert.equal(engineRunsHavePollableWork([run("canceled")]), false);
  assert.equal(engineRunsHavePollableWork([run("expired")]), false);
});

test("session storage retains only one canonical creation id and no prompt", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
  };
  const creationId = `ecr_${"a".repeat(32)}`;
  assert.equal(storePendingCreation(creationId, storage), true);
  assert.equal(values.size, 1);
  assert.equal(
    values.get(ENGINE_RUN_PENDING_CREATION_STORAGE_KEY),
    creationId,
  );
  assert.equal(readPendingCreation(storage), creationId);
  assert.equal(storePendingCreation("not-canonical", storage), false);
  assert.equal(storePendingCreation(creationId, null), false);
  clearPendingCreation(storage);
  assert.equal(readPendingCreation(storage), null);
});

test("controller source has one create POST, one idempotency header and no retry", () => {
  const source = readFileSync(
    new URL("../../app/engine-runs-controller.tsx", import.meta.url),
    "utf8",
  );
  assert.equal(
    source.match(/fetch\("\/api\/runs\/engine", \{/gu)?.length,
    1,
  );
  assert.equal(source.match(/"Idempotency-Key": creationId/gu)?.length, 1);
  assert.doesNotMatch(source, /retry\s*\(|while\s*\([^)]*create/iu);
  assert.match(source, /document\.visibilityState === "visible"/u);
  assert.match(source, /ENGINE_RUN_CLIENT_INTERVALS\.registryRefreshMs/u);
  assert.match(
    source,
    /void loadRunsPage\(null, "refresh", true\)/u,
  );
  assert.match(source, /reconcileEngineRunFirstPage\(\{/u);
  assert.match(source, /previousFirstPageKey: firstPageKeyRef\.current/u);
  assert.match(source, /previousFirstPageNextCursor:\s*firstPageNextCursorRef\.current/u);
  assert.match(source, /detail\?\.run\.id === selectedRunId/u);
  assert.match(source, /mergeEngineRunDetailIfPresent/u);
  assert.match(source, /Lista reprojetada pela autoridade/u);
  assert.match(
    source,
    /else\s*\{\s*setRegistryStatus\(""\);\s*\}/u,
    "a successful preserved refresh must clear transient registry feedback",
  );
  assert.match(source, /Carregar mais continua disponível/u);
  assert.match(
    source,
    /engineRunReconcileUrl\(pending\.creationId\)/u,
  );
  assert.match(source, /onLoadExcerpt=\{\(runId\) => void loadExcerpt\(runId\)\}/u);
  assert.equal(source.match(/engineRunExcerptUrl\(runId\)/gu)?.length, 1);
  assert.doesNotMatch(
    source,
    /sessionStorage\.(?:setItem|getItem)\([^)]*excerpt/iu,
  );
});

test("release integration gate executes options and protected excerpt routes", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { scripts?: Record<string, string> };
  const integration = packageJson.scripts?.["test:integration"] ?? "";
  for (const suite of [
    "tests/engine-run-options-api.integration.mjs",
    "tests/engine-run-excerpt-api.integration.mjs",
  ]) {
    assert.match(integration, new RegExp(suite.replaceAll(".", "\\."), "u"));
  }
});

test("one-shot regions expose stable accessible names", () => {
  const source = readFileSync(
    new URL("../../app/engine-runs-panel.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /<section\s+className="diagnostic-list"\s+aria-label="Análises one-shot"/u,
  );
  assert.match(
    source,
    /role="region"\s*aria-label="Detalhe da análise one-shot"\s*aria-busy=\{detailLoading\}/u,
  );
});

test("confirmed client failures have actionable copy without suggesting retry", () => {
  for (const code of [
    "invalid_engine_run_request",
    "invalid_engine_run_creation_id",
    "authentication_required",
    "runner_not_active",
    "engine_run_creation_key_reused",
  ]) {
    assert.doesNotMatch(
      engineRunCreateFailureMessage(code),
      /tente novamente|retry/iu,
    );
  }
});

function run(
  storedStatus: EngineRunListItemView["storedStatus"],
): EngineRunListItemView {
  return {
    id: `run_${"b".repeat(32)}`,
    assignedRunnerId: `rnr_${"c".repeat(32)}`,
    runnerDisplayName: null,
    engine: "codex_cli",
    storedStatus,
    deadlineAt: "2026-07-28T12:05:00.000Z",
    overdue: false,
    deadlineState:
      storedStatus === "queued" || storedStatus === "leased"
        ? "pending"
        : "settled",
    createdAt: "2026-07-28T12:00:00.000Z",
    updatedAt: "2026-07-28T12:00:00.000Z",
  };
}
