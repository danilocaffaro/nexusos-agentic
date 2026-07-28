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
  const secondList = coordinator.begin("list");

  assert.equal(options.signal.aborted, false);
  assert.equal(detail.signal.aborted, false);
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
  assert.match(
    source,
    /engineRunReconcileUrl\(pending\.creationId\)/u,
  );
});

test("confirmed client failures have actionable copy without suggesting retry", () => {
  for (const code of [
    "invalid_engine_run_request",
    "authentication_required",
    "runner_not_active",
    "idempotency_key_reused",
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
