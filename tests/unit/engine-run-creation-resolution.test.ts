import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ENGINE_RUN_CREATION_RETENTION_MS,
  engineRunCreationRetainUntil,
  hashEngineRunCreationRequest,
  parseEngineRunCreationId,
} from "../../src/domain/runners/engine-run-creation-resolution";

const baseRequest = {
  assignedRunnerId: `rnr_${"a".repeat(32)}`,
  engine: "claude_code_cli" as const,
  promptBytes: new TextEncoder().encode("exact prompt"),
  promptSha256: createHash("sha256")
    .update("exact prompt")
    .digest("hex"),
};

test("creation ids are exact canonical Idempotency-Key values", () => {
  const canonical = `ecr_${"a".repeat(32)}` as const;
  assert.equal(parseEngineRunCreationId(canonical), canonical);
  for (const invalid of [
    undefined,
    null,
    "",
    `ecr_${"a".repeat(31)}`,
    `ecr_${"A".repeat(32)}`,
    `rec_${"a".repeat(32)}`,
    ` ${canonical}`,
    `${canonical} `,
    `${canonical},${canonical}`,
  ]) {
    assert.equal(parseEngineRunCreationId(invalid), undefined);
  }
});

test("request hash is domain-separated and excludes prompt plaintext", async () => {
  const expected = createHash("sha256")
    .update(
      [
        "nexus:engine-creation:v1",
        baseRequest.assignedRunnerId,
        baseRequest.engine,
        baseRequest.promptSha256,
      ].join("|"),
    )
    .digest("hex");
  const actual = await hashEngineRunCreationRequest(baseRequest);
  assert.equal(actual, expected);
  assert.equal(actual.includes("exact prompt"), false);

  for (const changed of [
    {
      ...baseRequest,
      assignedRunnerId: `rnr_${"b".repeat(32)}`,
    },
    { ...baseRequest, engine: "codex_cli" as const },
    { ...baseRequest, promptSha256: "c".repeat(64) },
  ]) {
    assert.notEqual(
      await hashEngineRunCreationRequest(changed),
      actual,
    );
  }
});

test("not-created proofs retain an exact thirty-day floor", () => {
  const createdAt = "2026-07-28T12:00:00.000Z";
  const retainUntil = engineRunCreationRetainUntil(createdAt);
  assert.equal(
    Date.parse(retainUntil) - Date.parse(createdAt),
    ENGINE_RUN_CREATION_RETENTION_MS,
  );
});

test("preexisting replay exits before fresh-only validation and mutation", () => {
  const source = readFileSync(
    new URL(
      "../../src/adapters/d1/run-repository.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const start = source.indexOf(
    "export async function createEngineRun(",
  );
  const end = source.indexOf(
    "export async function reconcileEngineRunCreation(",
    start,
  );
  const creation = source.slice(start, end);
  const preRead = creation.indexOf("const existing = await");
  const preexistingExit = creation.indexOf("if (existing)");
  const runnerValidation = creation.indexOf(
    "await requireAssignableRunner(",
  );
  const cipherPreparation = creation.indexOf(
    "const cipher = await prepareCipher()",
  );
  const batch = creation.indexOf("await d1.batch([");
  assert.ok(preRead > 0);
  assert.ok(preexistingExit > preRead);
  assert.ok(cipherPreparation > preexistingExit);
  assert.ok(runnerValidation > preexistingExit);
  assert.ok(batch > cipherPreparation);
  assert.ok(batch > runnerValidation);
  const firstFreshOnlyAction = Math.min(
    runnerValidation,
    cipherPreparation,
  );
  const replayBlock = creation.slice(
    preexistingExit,
    firstFreshOnlyAction,
  );
  for (const forbidden of [
    "prepareCipher",
    "requireAssignableRunner",
    "run_events",
    "ledger_entries",
    "d1.batch",
  ]) {
    assert.equal(replayBlock.includes(forbidden), false);
  }
});

test("creation unique races and ledger sequence races are classified apart", () => {
  const source = readFileSync(
    new URL(
      "../../src/adapters/d1/run-repository.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const catchStart = source.indexOf(
    "} catch (error) {",
    source.indexOf("export async function createEngineRun("),
  );
  const catchEnd = source.indexOf(
    "if (isBareInvalidRun(error))",
    catchStart,
  );
  const catchBody = source.slice(catchStart, catchEnd);
  assert.ok(
    catchBody.indexOf("isEngineRunCreationUniqueConflict(error)") <
      catchBody.indexOf("isLedgerSequenceConflict(error)"),
  );
  assert.match(
    source,
    /UNIQUE constraint failed:\[\^\\n\]\*engine_run_creations\\\./u,
  );
  assert.match(
    source,
    /UNIQUE constraint failed:\\s\*ledger_entries\\\.organization_id/u,
  );
});
