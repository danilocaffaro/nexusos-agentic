import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  isPromptRetentionEligible,
  MUTATION_PROMPT_RETENTION_LIMIT,
  PROMPT_RETENTION_HEALTH_GRACE_MS,
  PROMPT_RETENTION_MS,
  PROMPT_RETENTION_TERMINAL_STATUSES,
  promptRetentionCutoff,
  promptRetentionHealthCutoff,
  SCHEDULED_PROMPT_RETENTION_LIMIT,
} from "@/src/domain/runners/prompt-retention";

const terminalAt = "2026-07-27T12:20:00.001Z";
const exactRetentionAt = "2026-08-26T12:20:00.001Z";

test("prompt retention freezes terminal states, bounds and cutoffs", () => {
  assert.equal(PROMPT_RETENTION_MS, 2_592_000_000);
  assert.equal(PROMPT_RETENTION_HEALTH_GRACE_MS, 600_000);
  assert.equal(MUTATION_PROMPT_RETENTION_LIMIT, 25);
  assert.equal(SCHEDULED_PROMPT_RETENTION_LIMIT, 100);
  assert.deepEqual(PROMPT_RETENTION_TERMINAL_STATUSES, [
    "completed",
    "canceled",
    "expired",
  ]);
  assert.equal(promptRetentionCutoff(exactRetentionAt), terminalAt);
  assert.equal(
    promptRetentionHealthCutoff("2026-08-26T12:30:00.001Z"),
    terminalAt,
  );
});

test("prompt retention uses the exact inclusive thirty-day boundary", () => {
  assert.equal(
    isPromptRetentionEligible({
      observedAt: "2026-08-26T12:20:00.000Z",
      recordedAt: terminalAt,
      status: "expired",
    }),
    false,
  );
  assert.equal(
    isPromptRetentionEligible({
      observedAt: exactRetentionAt,
      recordedAt: terminalAt,
      status: "expired",
    }),
    true,
  );
  assert.equal(
    isPromptRetentionEligible({
      observedAt: "2026-08-26T12:20:00.002Z",
      recordedAt: terminalAt,
      status: "canceled",
    }),
    true,
  );
  assert.equal(
    isPromptRetentionEligible({
      observedAt: exactRetentionAt,
      recordedAt: terminalAt,
      status: "queued",
    }),
    false,
  );
  assert.throws(
    () =>
      isPromptRetentionEligible({
        observedAt: exactRetentionAt,
        recordedAt: "2026-07-27T12:20:00Z",
        status: "expired",
      }),
    /Invalid canonical timestamp/u,
  );
});

test("prompt retention is bounded, keyring-independent and one-way", () => {
  const repository = readFileSync(
    new URL(
      "../../src/adapters/d1/prompt-retention-repository.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const scheduler = readFileSync(
    new URL(
      "../../src/adapters/d1/schedule-deadline-reconciliation.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const worker = readFileSync(
    new URL("../../worker/index.ts", import.meta.url),
    "utf8",
  );
  const localRoute = readFileSync(
    new URL(
      "../../app/api/system/retention/reconcile/route.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const localCli = readFileSync(
    new URL("../../scripts/retention-reconcile.mjs", import.meta.url),
    "utf8",
  );

  assert.match(
    repository,
    /input\.mode === "mutation"[\s\S]*?MUTATION_PROMPT_RETENTION_LIMIT[\s\S]*?: SCHEDULED_PROMPT_RETENTION_LIMIT/u,
  );
  assert.match(
    repository,
    /ORDER BY run\.recorded_at, run\.id[\s\S]*?LIMIT \?/u,
  );
  assert.match(repository, /listDuePrompts\(cutoff, limit \+ 1\)/u);
  assert.match(repository, /selected\.length > limit/u);
  assert.doesNotMatch(
    repository,
    /SELECT[\s\S]*?prompt\.ciphertext[\s\S]*?FROM runs run/u,
  );
  assert.match(
    repository,
    /SET key_id = NULL, iv = NULL, ciphertext = NULL, tag = NULL,[\s\S]*?erased_at = \?/u,
  );
  assert.match(repository, /Number\(result\.meta\.changes\)/u);
  assert.doesNotMatch(
    repository,
    /PromptCipher|resolvePromptCipherKeyring|WebCryptoPromptCipher/u,
  );
  assert.match(scheduler, /reconcileDuePromptRetention/u);
  assert.match(worker, /reconcileDuePromptRetention/u);
  assert.match(localRoute, /"retention-reconcile-v1"/u);
  assert.match(localCli, /\["127\.0\.0\.1", "\[::1\]"\]/u);
  assert.match(localCli, /redirect: "error"/u);
  assert.doesNotMatch(localCli, /child_process|spawn|execFile|exec\(/u);
});
