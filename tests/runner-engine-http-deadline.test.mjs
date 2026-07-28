import assert from "node:assert/strict";
import test from "node:test";
import {
  ENGINE_HTTP_IO_TIMEOUT_MS,
  ENGINE_HTTP_TIMEOUT,
  EngineHttpDeadlineError,
  createEngineHttpDeadline,
} from "../runner/engine-http-deadline.mjs";

test("one monotonic deadline governs checkpoints, abort and every race", async () => {
  let now = 1_000;
  const deadline = createEngineHttpDeadline({
    now: () => now,
    timeoutMs: 10,
  });
  assert.equal(deadline.checkpoint(), true);
  assert.equal(deadline.signal.aborted, false);
  now = 1_009.999;
  assert.equal(deadline.checkpoint(), true);
  now = 1_010;
  assert.equal(deadline.checkpoint(), false);
  assert.equal(deadline.signal.aborted, true);
  assert.equal(
    await deadline.race(() => Promise.resolve("late")),
    ENGINE_HTTP_TIMEOUT,
  );
  deadline.close();
  deadline.close();
});

test("a timed-out transport is consumed and its late response is cleaned", async () => {
  let resolveTransport;
  let cleaned = 0;
  const deadline = createEngineHttpDeadline({ timeoutMs: 5 });
  const outcome = deadline.race(
    () =>
      new Promise((resolve) => {
        resolveTransport = resolve;
      }),
    () => {
      cleaned += 1;
    },
  );
  assert.equal(await outcome, ENGINE_HTTP_TIMEOUT);
  resolveTransport({ private: "response" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cleaned, 1);
  deadline.close();
});

test("deadline configuration is exact, bounded and clock-safe", () => {
  assert.equal(ENGINE_HTTP_IO_TIMEOUT_MS, 10_000);
  for (const input of [
    { timeoutMs: 0 },
    { timeoutMs: 10_001 },
    { timeoutMs: 1.5 },
    { timeoutMs: "10" },
    { extra: true },
    { now: 1 },
    { now: () => Number.NaN },
    { now: () => -1 },
  ]) {
    assert.throws(
      () => createEngineHttpDeadline(input),
      EngineHttpDeadlineError,
    );
  }
  const boundary = createEngineHttpDeadline({ timeoutMs: 10_000 });
  boundary.close();
});
